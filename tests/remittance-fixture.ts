import assert from 'node:assert/strict';
import { receiptFixture } from './receipt-fixture.ts';

export async function remittanceFixture(options:Parameters<typeof receiptFixture>[0]={}){
 const f=await receiptFixture(options),due=await f.made('finance/accounts',{code:'HUB-DUE',name:'Synthetic funds due from collector',kind:'asset',operationalRole:'collector_receivable',hubId:f.hub,currencyId:f.currency.id,currencyVersion:1,reason:'Synthetic external custody account'}),third=await f.made('finance/collectors',{hubId:f.hub,code:'EXTERNAL',kind:'hub',custody:'third_party',name:'Synthetic external hub',accounts:[{id:due.id,version:1}],reason:'Synthetic collector'});
 const received=await f.pay({amount:'113',collector:{id:third.id,version:1},holdingAccount:{id:due.id,version:1}});assert.equal(received.response.status,201,JSON.stringify({body:received.body,failures:f.metrics.queryFailures}));
 const input={collectorVersion:1,holdingAccount:{id:due.id,version:1},academyAccount:{id:f.cash.id,version:1},method:{id:f.method.id,version:1},period:{id:f.period.id,version:1},direction:'to_academy',amount:'50',postedOn:'2026-11-07',transferredAt:'2026-11-07T12:00:00Z',taxTreatment:'settle_collector',missingEvidenceReason:'Synthetic missing bank evidence exception',reason:'Private remittance approval evidence'};
 const remit=(patch:Record<string,unknown>={},as='master',key?:string)=>f.request('finance/collectors/'+third.id+'/remittances',{...input,...patch},as,{key});
 const balances=(through='2026-11-08',as='master')=>f.request('finance/collectors/'+third.id+'/remittance-balances?through='+through,undefined,as);
 const correction=(id:string,patch:Record<string,unknown>={},as='master',key?:string)=>f.request('finance/remittances/'+id+'/reverse',{period:input.period,postedOn:'2026-11-09',reason:'Private remittance correction',...patch},as,{key});
 return {...f,due,third,receivedId:received.body.data.id,remittanceInput:input,remit,balances,correction};
}

