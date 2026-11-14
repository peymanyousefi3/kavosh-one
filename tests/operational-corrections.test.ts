import assert from 'node:assert/strict';
import { test } from 'node:test';
import { receiptFixture } from './receipt-fixture.ts';

for(const kind of ['invoice','receipt','remittance'] as const)test('database requires linked '+kind+' correction metadata even for a valid exact inverse and real pending approval',async()=>{
 const f=await receiptFixture();try{
 const caps=(await f.pg.query<{name:string}>('SELECT name FROM public.capability_catalog')).rows.map(r=>r.name),role=await f.made('roles',{name:'Synthetic full-feature staff, not a master',permissions:caps.map(capability=>({capability,effect:'allow'}))}),path='people/'+f.actors.staff.person+'/access',before=await f.request(path);assert.equal((await f.request(path,{expectedVersion:before.body.data.version,assignments:[{roleId:role.id,allHubs:true}]})).response.status,200);
 let original=f.invoice.id,pending;
 if(kind==='invoice')pending=await f.credit(original,{},'staff');
 else if(kind==='receipt'){const paid=await f.pay();assert.equal(paid.response.status,201);original=paid.body.data.id;pending=await f.reverse(original,{},'staff');}
 else{
 const due=await f.made('finance/accounts',{code:'DUE',name:'Synthetic external holding',kind:'asset',operationalRole:'collector_receivable',hubId:f.hub,currencyId:f.currency.id,currencyVersion:1,reason:'Synthetic custody'}),third=await f.made('finance/collectors',{hubId:f.hub,code:'THIRD',kind:'hub',custody:'third_party',name:'Synthetic external collector',accounts:[{id:due.id,version:1}],reason:'Synthetic collector'});
 assert.equal((await f.pay({collector:{id:third.id,version:1},holdingAccount:{id:due.id,version:1}})).response.status,201);
 const remit=await f.request('finance/collectors/'+third.id+'/remittances',{collectorVersion:1,holdingAccount:{id:due.id,version:1},academyAccount:{id:f.cash.id,version:1},method:{id:f.method.id,version:1},period:{id:f.period.id,version:1},direction:'to_academy',amount:'50',postedOn:'2026-11-07',transferredAt:'2026-11-07T12:00:00Z',taxTreatment:'settle_collector',missingEvidenceReason:'Synthetic missing evidence',reason:'Synthetic remittance'});assert.equal(remit.response.status,201,JSON.stringify(remit.body));original=remit.body.data.id;
 pending=await f.request('finance/remittances/'+original+'/reverse',{period:{id:f.period.id,version:1},postedOn:'2026-11-08',reason:'Synthetic correction'},'staff');
 }
 assert.equal(pending.response.status,202,JSON.stringify(pending.body));const approval=(await f.pg.query<{target_id:string}>('SELECT target_id FROM public.approval_requests WHERE id=$1',[pending.body.approval.id])).rows[0],count=(await f.pg.query('SELECT count(*)::integer AS n FROM public.finance_journals')).rows[0].n;
 await f.pg.exec('SET ROLE kavosh_runtime');try{await f.pg.query("SELECT set_config('app.academy_id',$1,false)",[f.a]);await f.pg.exec('BEGIN');try{
 await f.pg.query("INSERT INTO public.finance_journals(academy_id,id,period_id,period_version,posted_on,description,line_count,reverses_id,posted_by,approval_id,purpose) SELECT academy_id,$2,period_id,period_version,'2026-11-08','Direct inverse without operational record',line_count,id,$3,$4,purpose FROM public.finance_journals WHERE id=$1",[original,approval.target_id,f.actors.master.person,pending.body.approval.id]);
 await f.pg.query("INSERT INTO public.finance_journal_lines(academy_id,journal_id,line_number,account_id,account_version,side,amount_minor,note) SELECT academy_id,$2,line_number,account_id,account_version,CASE WHEN side='debit' THEN 'credit' ELSE 'debit' END,amount_minor,note FROM public.finance_journal_lines WHERE journal_id=$1",[original,approval.target_id]);
 await assert.rejects(f.pg.exec('COMMIT'),new RegExp(kind==='invoice'?'INVOICE_CREDIT_INCOMPLETE':kind==='receipt'?'RECEIPT_CORRECTION_INCOMPLETE':'REMITTANCE_CORRECTION_INCOMPLETE'));
 }finally{await f.pg.exec('ROLLBACK');}}finally{await f.pg.exec('RESET ROLE');}
 assert.equal((await f.pg.query('SELECT count(*)::integer AS n FROM public.finance_journals')).rows[0].n,count);assert.equal((await f.approve(pending.body.approval.id)).response.status,200);
 }finally{await f.pg.close();}
});
