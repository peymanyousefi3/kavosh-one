import assert from 'node:assert/strict';
import { invoiceFixture } from './invoice-fixture.ts';

export async function tuitionReminderFixture(options:Parameters<typeof invoiceFixture>[0]={},futureIssue=false){
 const f=await invoiceFixture(options);try{
  const days=(await f.pg.query<{yesterday:string;today:string;tomorrow:string}>("SELECT to_char((statement_timestamp() AT TIME ZONE 'America/Toronto')::date-1,'YYYY-MM-DD') yesterday,to_char(statement_timestamp() AT TIME ZONE 'America/Toronto','YYYY-MM-DD') today,to_char((statement_timestamp() AT TIME ZONE 'America/Toronto')::date+1,'YYYY-MM-DD') tomorrow")).rows[0];
  const plan=await f.request('finance/tuition-plans/'+f.plan.id+'/change',{...f.planInput,expectedVersion:1,installments:[{...f.planInput.installments[0],dueOn:days.yesterday},{...f.planInput.installments[1],dueOn:days.tomorrow}]});assert.equal(plan.response.status,200,JSON.stringify(plan.body));
  const issued=await f.issue({planVersion:2,...futureIssue?{issuedAt:days.tomorrow+'T12:00:00Z'}:{}});assert.equal(issued.response.status,201,JSON.stringify(issued.body));const invoice=issued.body.data;
  const collector=await f.made('finance/collectors',{hubId:f.hub,code:'REMINDER-CASH',kind:'hub',custody:'academy_funds',name:'Synthetic reminder test cash',accounts:[{id:f.cash.id,version:1}],reason:'Synthetic reminder collector'});
  const pay=(patch:Record<string,unknown>={})=>f.request('finance/invoices/'+invoice.id+'/receipts',{amount:'20',collector:{id:collector.id,version:1},method:{id:f.method.id,version:1},holdingAccount:{id:f.cash.id,version:1},receivedAt:'2026-11-06T12:00:00Z',period:{id:f.period.id,version:1},reference:'',missingEvidenceReason:'Synthetic reviewed exception',taxTreatment:'settle_invoice',allocation:'oldest_due',reason:'Private reminder receipt review',...patch});
  async function source(installment=1,offset=1,academy:string=f.a){await f.pg.exec('SET ROLE kavosh_runtime');try{await f.pg.query("SELECT set_config('app.academy_id',$1,false)",[academy]);return(await f.pg.query<{source:Record<string,unknown>|null}>('SELECT public.tuition_reminder_source($1,$2,$3) source',[invoice.id,installment,offset])).rows[0].source;}finally{await f.pg.exec('RESET ROLE');}}
  return {...f,days,invoice,pay,source};
 }catch(error){await f.pg.close();throw error;}
}

