import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sumInventoryValueRatios,roundRatio,formatMoneyTotal } from '../src/core/money.ts';
import { inventoryReports } from '../src/modules/inventory-reports.ts';
import type { ApiContext } from '../src/core/api.ts';

test('consolidated purchase-cost ratios conserve fractional cents and round only after summing',()=>{
 const t=[{numerator:5n,denominator:3n},{numerator:10n,denominator:3n}],sum=sumInventoryValueRatios(t);assert.deepEqual(sum,{numerator:5n,denominator:1n});assert.equal(roundRatio(sum.numerator,sum.denominator,'half_away'),5n);
 assert.deepEqual(sumInventoryValueRatios([...t].reverse()),sum);assert.equal(t.reduce((n,t)=>n+roundRatio(t.numerator,t.denominator,'half_away'),0n),5n);
 const halves=[{numerator:1n,denominator:3n},{numerator:1n,denominator:3n},{numerator:1n,denominator:3n}];assert.equal(halves.reduce((n,t)=>n+roundRatio(t.numerator,t.denominator,'half_away'),0n),0n);assert.deepEqual(sumInventoryValueRatios(halves),{numerator:1n,denominator:1n});
 assert.deepEqual(sumInventoryValueRatios([]),{numerator:0n,denominator:1n});
});
test('optimized reduced ratios agree with a separate full-GCD reference across mixed denominators and large aggregate values',()=>{
 const gcd=(a:bigint,b:bigint):bigint=>b?gcd(b,a%b):a;
 const terms=Array.from({length:100},(_,i)=>({numerator:BigInt(i+1)*(10n**42n+7n),denominator:BigInt(i%29+1)}));
 let n=0n,d=1n;for(const t of terms){n=n*t.denominator+t.numerator*d;d*=t.denominator;const g=gcd(n,d);n/=g;d/=g;}
 const sum=sumInventoryValueRatios(terms);assert.deepEqual(sum,{numerator:n,denominator:d});assert.deepEqual(sumInventoryValueRatios([...terms].reverse()),sum);assert.match(formatMoneyTotal(roundRatio(n,d,'half_away'),18),/^\d+[.]\d{18}$/);
});
test('inventory rational aggregation rejects invalid or unbounded synchronous work instead of returning an approximation',()=>{
 for(const t of [{numerator:-1n,denominator:1n},{numerator:1n,denominator:0n},{numerator:1n,denominator:1000000001n},{numerator:10n**100n,denominator:1n},{numerator:1,denominator:1n}])assert.throws(()=>sumInventoryValueRatios([t as never]));
 assert.throws(()=>sumInventoryValueRatios(Array.from({length:1001},()=>({numerator:1n,denominator:1n}))),/REPORT_REQUIRES_BACKGROUND_JOB/);
});
test('actual report handler rejects oversized arithmetic, currency or chart summaries before returning any partial data',async()=>{
 const capabilities=['inventory-reports.view','inventory.view'] as const;
 for(const oversized of [{termCount:1001},{currencyCount:1001},{chartRowCount:1001}]){
  const ctx:ApiContext={path:'reports/inventory/stock',request:new Request('https://academy.example/api/v1/reports/inventory/stock?on=2026-11-03&timeZone=UTC'),requestId:'synthetic-budget-check',
   credential:{token_id:'synthetic',academy_id:'synthetic',person_id:'synthetic',capabilities:[...capabilities],all_hubs:true,hub_ids:[],allowed:true,kind:'human'},grants:capabilities.map(capability=>({capability,effect:'allow',allHubs:true,hubIds:[]})),
   db:{async query<Row>(){return {rows:[{termCount:1,currencyCount:1,chartRowCount:1,...oversized}] as unknown as Row[]};},release(){}}};
  await assert.rejects(inventoryReports(ctx),/REPORT_REQUIRES_BACKGROUND_JOB/);
 }
});
