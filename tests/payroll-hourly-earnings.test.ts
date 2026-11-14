import assert from 'node:assert/strict';
import { test } from 'node:test';
import { performance } from 'node:perf_hooks';
import { Temporal } from '@js-temporal/polyfill';
import { payrollHourlyEarnings,payrollHourlyCurrencyConflicts,type PayrollHourlySource } from '../src/core/payroll-hourly-earnings.ts';

const hour=3600000,window={start:0,end:24*hour};
const source=(key:string,start:number,end:number,rateMinor=3000n,rounding:'none'|'nearest_5'='none'):PayrollHourlySource=>({key,start,end,rateMinor,rounding});
const calculate=(sources:PayrollHourlySource[],prior:{start:number;end:number}[]=[],range=window)=>payrollHourlyEarnings(sources,range,prior,2);
test('gross hourly earnings use one highest-rate timeline and source allocations conserve its exact rounded total',()=>{
 const inputs=[source('low',0,2*hour,2000n),source('high',hour,3*hour)],r=calculate(inputs);
 assert.equal(r.actual.gross.amount,'80.00');assert.equal(r.actual.milliseconds,String(3*hour));assert.deepEqual(r.actual.sources.map(s=>[s.key,s.gross.amount]),[['high','60.00'],['low','20.00']]);assert.deepEqual(r.actual.timeClaims,[{start:0,end:3*hour}]);assert.deepEqual(calculate([...inputs].reverse()),r);
 for(const key of ['sourcesVerified','claimsPersisted','wagesAccrued','statutoryDeductionsCalculated','paymentExecuted'] as const)assert.equal(r[key],false);
});
test('retained worker-time claims exclude every overlapping source, not merely its previously winning class',()=>{
 const r=calculate([source('original',0,2*hour),source('other-class',hour,3*hour,2000n)],[{start:0,end:2*hour}]);
 assert.equal(r.actual.gross.amount,'20.00');assert.deepEqual(r.actual.timeClaims,[{start:2*hour,end:3*hour}]);assert.equal(r.actual.sources[0].key,'other-class');
 const retry=calculate([source('original',0,2*hour),source('other-class',hour,3*hour,2000n)],[{start:0,end:2*hour},...r.actual.timeClaims]);assert.equal(retry.actual.gross.minor,'0');assert.deepEqual(retry.actual.timeClaims,[]);
});
test('cross-currency coverage includes rounded-down actual work intersecting a different rounded-up currency',()=>{
 const a={...source('cad',300000,420000,100n,'nearest_5'),personId:'worker',currencyId:'CAD'},b={...source('usd',120000,270000,100n,'nearest_5'),personId:'worker',currencyId:'USD'};
 const result=payrollHourlyCurrencyConflicts([a,b]);assert.deepEqual([...result].sort(),['cad','usd']);
 assert.deepEqual([...payrollHourlyCurrencyConflicts([b,a])].sort(),['cad','usd']);
 assert.equal(payrollHourlyCurrencyConflicts([a,{...b,personId:'other-worker'}]).size,0);assert.equal(payrollHourlyCurrencyConflicts([a,{...b,currencyId:'CAD'}]).size,0);
 assert.equal(payrollHourlyCurrencyConflicts([a,b],{start:0,end:300000}).size,0);assert.equal(payrollHourlyCurrencyConflicts([a,b],{start:420000,end:600000}).size,0);
 const adjacent={...b,start:420000,end:570000};assert.equal(payrollHourlyCurrencyConflicts([a,adjacent]).size,0);
 for(const patch of [{rounding:'guess'},{personId:''},{currencyId:''},{end:a.start},{start:NaN},{rateMinor:-1n}])assert.throws(()=>payrollHourlyCurrencyConflicts([{...a,...patch}] as typeof a[]));
});
test('currency conflict union matches a small independent time oracle and never depends on source order',()=>{
 for(let seed=0;seed<20;seed++){
  const rows=Array.from({length:8},(_,i)=>({...source(`key-${i}`,((i*7+seed*3)%25)*60000,((i*7+seed*3)%25)*60000+(i%4+1)*30000,0n,'nearest_5'),personId:`worker-${i%2}`,currencyId:i%3?'CAD':'USD'}));
  const expected=new Set<string>(),range={start:120000,end:1500000};
  const end=(s:typeof rows[number])=>Math.max(s.end,s.start+Math.floor((s.end-s.start+150000)/300000)*300000);
  for(let minuteHalf=range.start;minuteHalf<range.end;minuteHalf+=30000)for(const a of rows)for(const b of rows)if(a.personId===b.personId&&a.currencyId!==b.currencyId&&a.start<=minuteHalf&&minuteHalf<end(a)&&b.start<=minuteHalf&&minuteHalf<end(b)){expected.add(a.key);expected.add(b.key);}
  assert.deepEqual([...payrollHourlyCurrencyConflicts(rows,range)].sort(),[...expected].sort());assert.deepEqual([...payrollHourlyCurrencyConflicts([...rows].reverse(),range)].sort(),[...expected].sort());
 }
});
test('bounded background currency checks retain rounded coverage across 2000 sources without relaxing posted payroll limits',()=>{
 const rows=Array.from({length:2000},(_,i)=>({...source(String(i),i*hour,i*hour+120000,1n,'nearest_5'),personId:'worker',currencyId:'CAD'}));
 rows[1999]={...rows[1999],currencyId:'USD',start:1998*hour+60000,end:1998*hour+210000};
 const started=performance.now(),expected=['1998','1999'];assert.throws(()=>payrollHourlyCurrencyConflicts(rows),/INVALID_HOURLY_INTERVALS/);
 assert.deepEqual([...payrollHourlyCurrencyConflicts(rows,undefined,2000)].sort(),expected);assert.deepEqual([...payrollHourlyCurrencyConflicts([...rows].reverse(),undefined,2000)].sort(),expected);
 assert.equal(payrollHourlyCurrencyConflicts(rows,{start:0,end:1998*hour},2000).size,0);
 assert.throws(()=>payrollHourlyCurrencyConflicts([...rows,{...rows[0],key:'overflow'}],undefined,2000),/INVALID_HOURLY_INTERVALS/);
 assert.throws(()=>payrollHourlyEarnings(rows,{start:0,end:2001*hour},[],2),/INVALID_HOURLY_INTERVALS/);
 console.log(JSON.stringify({case:'bounded-2000-currency-conflict-sources',elapsedMs:Math.ceil(performance.now()-started),productionCapacityTest:false}));
});
test('half-open payroll boundaries clip crossing entries and keep adjacent periods from claiming the same time',()=>{
 const inputs=[source('crossing',hour/2,2*hour)],first=calculate(inputs,[],{start:0,end:hour}),second=calculate(inputs,first.actual.timeClaims,{start:hour,end:3*hour});
 assert.equal(first.actual.gross.amount,'15.00');assert.equal(second.actual.gross.amount,'30.00');assert.deepEqual(first.actual.timeClaims,[{start:hour/2,end:hour}]);assert.deepEqual(second.actual.timeClaims,[{start:hour,end:2*hour}]);
});
test('five-minute rounding happens before clipping and both actual and rounded coverage are retained',()=>{
 const inputs=[source('crossing',-60000,90000,3600n,'nearest_5')],r=calculate(inputs,[],{start:0,end:180000});
 assert.equal(r.actual.gross.amount,'0.90');assert.equal(r.configured.gross.amount,'1.80');assert.deepEqual(r.configured.timeClaims,[{start:0,end:180000}]);assert.deepEqual(r.actual.timeClaims,[{start:0,end:90000}]);
 const nextActual=calculate(inputs,r.actual.timeClaims,{start:90000,end:180000});assert.deepEqual(nextActual.actual.timeClaims,[]);assert.equal(nextActual.actual.gross.minor,'0');
 const adjacent=calculate([source('next-real-class',90000,180000)],r.actual.timeClaims,{start:90000,end:180000});assert.equal(adjacent.actual.gross.amount,'0.75');
 const reduced=calculate([source('short',0,120000,3000n,'nearest_5')]);assert.equal(reduced.configured.gross.minor,'0');assert.equal(reduced.configuredReductionRequiresReview,true);assert.deepEqual(reduced.configured.timeClaims,[{start:0,end:120000}]);
 const zero=calculate([source('threshold',0,hour,0n)]);assert.equal(zero.actual.gross.minor,'0');assert.deepEqual(zero.actual.timeClaims,[{start:0,end:hour}]);
 const mixed=calculate([source('down',0,120000,3000n,'nearest_5'),source('up',hour,hour+180000,3000n,'nearest_5')]);assert.equal(mixed.configuredReductionRequiresReview,false);assert.equal(mixed.sourceDurationReductionRequiresReview,true);assert.deepEqual(mixed.sourceRounding.map(s=>[s.key,s.deltaMilliseconds]),[['down','-120000'],['up','120000']]);
});
test('overlapping and touching prior claims are unioned logically without double subtraction or fabricated gaps',()=>{
 const r=calculate([source('work',0,4*hour)],[{start:-hour,end:hour},{start:hour/2,end:2*hour},{start:2*hour,end:3*hour},{start:5*hour,end:6*hour}]);
 assert.equal(r.actual.gross.amount,'30.00');assert.deepEqual(r.actual.timeClaims,[{start:3*hour,end:4*hour}]);
});
test('fractional-cent source attribution uses stable exact remainders rather than rounding each source',()=>{
 const inputs=[source('b',0,hour/2,1n),source('a',hour/2,hour,1n)],r=calculate(inputs);
 assert.equal(r.actual.gross.minor,'1');assert.deepEqual(r.actual.sources.map(s=>[s.key,s.gross.minor]),[['a','1'],['b','0']]);assert.deepEqual(calculate([...inputs].reverse()),r);
 const huge=calculate([source('large',0,hour,90071992547409930001n)]);assert.equal(huge.actual.gross.minor,'90071992547409930001');assert.equal(huge.actual.sources[0].gross.minor,huge.actual.gross.minor);
});
test('invalid source, clipping, precision and retained-claim inputs fail closed',()=>{
 const good=source('valid',0,hour);
 for(const inputs of [[good,good],[{...good,rateMinor:-1n}],[{...good,end:0}],[{...good,end:86400001}],[{...good,start:NaN}],[{...good,rounding:'guess'}]])assert.throws(()=>calculate(inputs as PayrollHourlySource[]));
 for(const range of [{start:0,end:0},{start:0,end:Infinity},{start:0,end:369*86400000}])assert.throws(()=>calculate([good],[],range));
 for(const prior of [[{start:hour,end:0}],[{start:0,end:NaN}],Array.from({length:201},()=>({start:0,end:hour}))])assert.throws(()=>calculate([good],prior));
 assert.throws(()=>payrollHourlyEarnings([good],window,[],19));
 assert.throws(()=>payrollHourlyEarnings([good],undefined as never,[],2));assert.throws(()=>payrollHourlyEarnings([good],window,undefined as never,2));
});
test('a supported 366-civil-day payroll window remains valid when its elapsed duration includes an extra DST hour',()=>{
 const start=Temporal.PlainDate.from('2026-03-09').toZonedDateTime('America/Toronto').epochMilliseconds,end=Temporal.PlainDate.from('2027-03-10').toZonedDateTime('America/Toronto').epochMilliseconds;
 assert.equal(end-start,366*86400000+hour);assert.equal(calculate([source('dst-window',start,start+hour)],[],{start,end}).actual.gross.amount,'30.00');
});
test('small independent millisecond oracle proves overlap, clipping, prior claims and exact attribution together',()=>{
 for(let seed=0;seed<24;seed++){
  const inputs=Array.from({length:12},(_,i)=>source(`source-${i}`,((i*7+seed*3)%35)-5,((i*7+seed*3)%35)+5,BigInt((i*seed+13)%23)*360000n));
  const prior=[{start:seed%10,end:seed%10+3},{start:19,end:23}],range={start:0,end:35};let numerator=0n,milliseconds=0;
  for(let ms=range.start;ms<range.end;ms++){
   if(prior.some(p=>p.start<=ms&&ms<p.end))continue;
   const active=inputs.filter(s=>s.start<=ms&&ms<s.end);if(!active.length)continue;
   numerator+=active.reduce((highest,s)=>s.rateMinor>highest?s.rateMinor:highest,0n);milliseconds++;
  }
  const r=calculate(inputs,prior,range);assert.equal(r.actual.milliseconds,String(milliseconds));assert.equal(r.actual.gross.minor,((numerator+1800000n)/3600000n).toString());assert.equal(r.actual.sources.reduce((n,s)=>n+BigInt(s.gross.minor),0n).toString(),r.actual.gross.minor);
 }
});
test('bounded fragmented sources conserve gross and remain independent of source and prior-claim order',t=>{
 const inputs=Array.from({length:200},(_,i)=>source(String(i).padStart(3,'0'),i*60000,(i+20)*60000,BigInt(i+1),'nearest_5'));
 const prior=Array.from({length:200},(_,i)=>({start:i*60000+10000,end:i*60000+20000}));
 const started=performance.now(),r=calculate(inputs,prior);t.diagnostic(`One bounded 200-source/200-claim calculation: ${(performance.now()-started).toFixed(1)} ms (not a load test or SLO).`);
 assert.deepEqual(calculate([...inputs].reverse(),[...prior].reverse()),r);
 for(const calculation of [r.actual,r.configured])assert.equal(calculation.sources.reduce((n,s)=>n+BigInt(s.gross.minor),0n).toString(),calculation.gross.minor);
 for(const c of r.actual.timeClaims)for(const p of prior)assert.ok(c.end<=p.start||c.start>=p.end);
});
