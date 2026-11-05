import assert from 'node:assert/strict';
import { invoiceFixture } from './invoice-fixture.ts';

export async function receiptFixture(options:{throughSchema?:number}={}){
 const f=await invoiceFixture(options),issued=await f.issue();assert.equal(issued.response.status,201,JSON.stringify(issued.body));const invoice=issued.body.data;
 const collector=await f.made('finance/collectors',{hubId:f.hub,code:'CASH',kind:'hub',custody:'academy_funds',name:'Synthetic academy-controlled cash',accounts:[{id:f.cash.id,version:1}],reason:'Synthetic collector'});
 const base={amount:'50',collector:{id:collector.id,version:1},method:{id:f.method.id,version:1},holdingAccount:{id:f.cash.id,version:1},receivedAt:'2026-11-06T12:00:00Z',period:{id:f.period.id,version:1},reference:'',missingEvidenceReason:'Synthetic missing paper receipt approved as exception',taxTreatment:'settle_invoice',allocation:'unallocated',reason:'Private receipt review evidence'};
 const pay=(patch:Record<string,unknown>={},as='master',key?:string)=>f.request('finance/invoices/'+invoice.id+'/receipts',{...base,...patch},as,{key});
 const reverse=(id:string,patch:Record<string,unknown>={},as='master',key?:string)=>f.request('finance/receipts/'+id+'/reverse',{period:base.period,postedOn:'2026-11-07',reason:'Private correction approval',...patch},as,{key});
 const status=async()=>{const r=await f.request('finance/invoices/'+invoice.id+'/payment-status');assert.equal(r.response.status,200,JSON.stringify(r.body));return r.body.data;};
 return {...f,invoice,collector,payment:base,pay,reverse,status};
}
