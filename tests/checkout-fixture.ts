import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {receiptFixture} from './receipt-fixture.ts';
import {paymentConnection} from './stripe-fixture.ts';

export async function checkoutFixture(options:Parameters<typeof receiptFixture>[0]={}){
 const f=await receiptFixture(options),connection=paymentConnection(f.a),foreign=paymentConnection(f.b);
 for(const c of [connection,foreign])await f.pg.query('INSERT INTO public.payment_connections(id,academy_id,account_id,livemode,api_version,enabled) VALUES($1,$2,$3,$4,$5,true)',[c.connectionId,c.academyId,c.accountId,c.livemode,c.apiVersion]);
 const path='finance/invoices/'+f.invoice.id+'/checkout-requests',input={connectionId:connection.connectionId,priorId:null,amount:'50.00',sessionLifetimeMinutes:60,dispatchWithinMinutes:10,reason:'PRIVATE approved checkout preparation'};
 const prepare=(patch:Record<string,unknown>={},as='master',key?:string)=>f.request(path,{...input,...patch},as,{key});
 const cancel=(id:string,as='master',key?:string)=>f.request('finance/checkout-requests/'+id+'/cancel',{reason:'PRIVATE cancellation of unused checkout'},as,{key});
 async function access(as:string,options:{all?:boolean;studentId?:string;caps?:string[]}={}){
  const role=await f.made('roles',{name:'Checkout '+as+' '+randomUUID(),permissions:(options.caps??['checkouts.view','checkouts.edit','invoices.view']).map(capability=>({capability,effect:'allow'}))}),person=as==='bot'?f.bot:f.actors[as].person,p='people/'+person+'/access',old=await f.request(p);
  assert.equal((await f.request(p,{expectedVersion:old.body.data.version,assignments:[{roleId:role.id,allHubs:options.all??true,...options.studentId?{personIds:[options.studentId]}:{}},...as==='manager'?[{roleId:f.managerRole,allHubs:false,hubIds:[f.hub]}]:[]]})).response.status,200);return role;
 }
 return {...f,connection,foreign,path,input,prepare,cancel,access};
}
