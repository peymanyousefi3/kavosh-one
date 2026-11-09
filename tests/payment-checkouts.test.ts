import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { receiptFixture } from './receipt-fixture.ts';
import { paymentConnection } from './stripe-fixture.ts';

async function fixture(){
 const f=await receiptFixture(),connection=paymentConnection(f.a),foreign=paymentConnection(f.b);
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
type Fixture=Awaited<ReturnType<typeof fixture>>;
function check(name:string,run:(f:Fixture)=>Promise<void>){test(name,async()=>{const f=await fixture();try{await run(f);}finally{await f.pg.close();}});}
check('reviewed checkout preparation pins exact invoice/amount/account without creating a provider request,receipt or second tax posting',async f=>{
 const before=(await f.pg.query('SELECT count(*)::integer n FROM public.finance_journals')).rows[0].n,r=await f.prepare();assert.equal(r.response.status,201,JSON.stringify({body:r.body,failures:f.metrics.queryFailures}));
 assert.equal(r.body.data.amount,'50.00');assert.equal(r.body.data.currencyCode,'CAD');assert.equal(r.body.data.state,'approved_unexecuted');for(const key of ['providerRequestMade','paymentReceived','ledgerAdjusted'])assert.equal(r.body.data[key],false);assert.equal(r.body.data.checkoutUrl,null);
 const saved=(await f.pg.query<{invoice_id:string;amount_minor:string;context:{source:{connection:{accountId:string};terms:{outstandingMinor:string}}}}>('SELECT * FROM public.payment_checkout_requests')).rows[0];assert.equal(saved.invoice_id,f.invoice.id);assert.equal(saved.amount_minor,'5000');assert.equal(saved.context.source.connection.accountId,f.connection.accountId);assert.equal(saved.context.source.terms.outstandingMinor,'11300');
 assert.equal((await f.status()).balance,'113.00');assert.equal((await f.pg.query('SELECT count(*)::integer n FROM public.tuition_receipts')).rows[0].n,0);assert.equal((await f.pg.query('SELECT count(*)::integer n FROM public.finance_journals')).rows[0].n,before);
 const ordinary=await f.request('finance/checkout-requests/'+r.body.data.id);assert.equal(ordinary.response.status,200);assert.doesNotMatch(JSON.stringify(ordinary.body),/PRIVATE|sourceSnapshot|acct_/);const review=await f.request('finance/checkout-requests/'+r.body.data.id+'/review');assert.equal(review.body.data.sourceSnapshot.source.invoice.id,f.invoice.id);
 assert.equal((await f.request(f.path+'?limit=1')).body.data.length,1);const list=await f.request('finance/invoices/'+f.invoice.id+'/checkout-connections');assert.deepEqual(list.body.data.map((r:any)=>r.id),[f.connection.connectionId]);assert.doesNotMatch(JSON.stringify(list.body),/acct_|whsec_/);
});
check('strict positive amounts,original invoice balance,current connection and bounded timing reject forged financial authority',async f=>{
 for(const patch of [{amount:'0'},{amount:'-1'},{amount:'0.001'},{amount:50},{paid:true},{invoiceId:randomUUID()},{amountMinor:'1'},{sessionLifetimeMinutes:29},{sessionLifetimeMinutes:1441},{dispatchWithinMinutes:0}])assert.equal((await f.prepare(patch)).response.status,400,JSON.stringify(patch));
 assert.equal((await f.prepare({amount:'113.01'})).body.error.code,'CHECKOUT_EXCEEDS_OUTSTANDING');assert.equal((await f.prepare({connectionId:f.foreign.connectionId})).response.status,404);
 await f.pg.query('UPDATE public.payment_connections SET enabled=false WHERE id=$1',[f.connection.connectionId]);assert.equal((await f.prepare()).body.error.code,'CHECKOUT_CONNECTION_DISABLED');await f.pg.query('UPDATE public.payment_connections SET enabled=true WHERE id=$1',[f.connection.connectionId]);
 assert.equal((await f.pay({amount:'80'})).response.status,201);assert.equal((await f.prepare()).body.error.code,'CHECKOUT_EXCEEDS_OUTSTANDING');assert.equal((await f.credit(f.invoice.id)).response.status,201);assert.equal((await f.prepare({amount:'1'})).body.error.code,'CHECKOUT_POSTED_INVOICE_REQUIRED');assert.equal((await f.pg.query('SELECT count(*)::integer n FROM public.payment_checkout_requests')).rows[0].n,0);
});
check('exact key retries preserve the original result; duplicate and replacement requests cannot create parallel active checkout chains',async f=>{
 const key=randomUUID(),r=await f.prepare({},'master',key);assert.equal(r.response.status,201,JSON.stringify(r.body));assert.deepEqual((await f.prepare({},'master',key)).body,r.body);assert.equal((await f.prepare()).response.status,409);assert.equal((await f.prepare({priorId:r.body.data.id})).body.error.code,'CHECKOUT_PRIOR_NOT_REPLACEABLE');
 const cancelKey=randomUUID(),c=await f.cancel(r.body.data.id,'master',cancelKey);assert.equal(c.response.status,201,JSON.stringify(c.body));assert.equal(c.body.data.state,'cancelled');assert.deepEqual((await f.cancel(r.body.data.id,'master',cancelKey)).body,c.body);
 const next=await f.prepare({priorId:r.body.data.id,amount:'25.00'});assert.equal(next.response.status,201,JSON.stringify(next.body));assert.equal(next.body.data.priorId,r.body.data.id);assert.equal((await f.request('finance/checkout-requests/'+r.body.data.id)).body.data.state,'superseded');assert.equal((await f.cancel(r.body.data.id)).response.status,409);
 assert.deepEqual((await f.prepare({},'master',key)).body,r.body);assert.equal((await f.pg.query('SELECT count(*)::integer n FROM public.payment_checkout_requests')).rows[0].n,2);assert.equal((await f.status()).received,'0.00');
});
check('staff and bot intentions require upper human approval; changed receipts or connection configuration invalidate pending amounts',async f=>{
 await f.access('staff');await f.access('manager');const p=await f.prepare({},'staff');assert.equal(p.response.status,202,JSON.stringify(p.body));assert.equal((await f.approve(p.body.approval.id,'staff')).response.status,403);assert.equal((await f.pg.query('SELECT count(*)::integer n FROM public.payment_checkout_requests')).rows[0].n,0);
 assert.equal((await f.pay({amount:'1'})).response.status,201);assert.equal((await f.approve(p.body.approval.id,'manager')).response.status,409);
 const q=await f.prepare({},'staff');assert.equal(q.response.status,202);await f.pg.query('UPDATE public.payment_connections SET enabled=false WHERE id=$1',[f.connection.connectionId]);assert.equal((await f.approve(q.body.approval.id)).response.status,409);await f.pg.query('UPDATE public.payment_connections SET enabled=true WHERE id=$1',[f.connection.connectionId]);
 await f.access('bot');const bot=await f.prepare({},'bot');assert.equal(bot.response.status,202,JSON.stringify(bot.body));assert.equal((await f.approve(bot.body.approval.id,'bot')).response.status,403);const approved=await f.approve(bot.body.approval.id);assert.equal(approved.response.status,200,JSON.stringify(approved.body));assert.equal(approved.body.data.providerRequestMade,false);
});
check('student-only scopes work without ledger rights; other students,foreign schools and revoked source rights stay private',async f=>{
 await f.access('staff',{all:false,studentId:f.student.id});const pending=await f.prepare({},'staff');assert.equal(pending.response.status,202,JSON.stringify(pending.body));const done=await f.approve(pending.body.approval.id);assert.equal(done.response.status,200,JSON.stringify(done.body));const id=done.body.data.id;
 assert.equal((await f.request('finance/checkout-requests/'+id,undefined,'staff')).response.status,200);assert.equal((await f.request('finance/journals',undefined,'staff')).response.status,403);assert.equal((await f.request('finance/checkout-requests/'+id,undefined,'foreignMaster',{academy:f.b})).response.status,404);
 const denied=await f.made('roles',{name:'Deny checkout class',permissions:[{capability:'checkouts.view',effect:'deny'}]}),path='people/'+f.actors.staff.person+'/access',role=await f.access('peer',{all:false,studentId:f.student.id});
 const actual=await f.request(path);assert.equal((await f.request(path,{expectedVersion:actual.body.data.version,assignments:[{roleId:role.id,allHubs:false,personIds:[f.student.id]},{roleId:denied.id,allHubs:false,classIds:[f.c.id]}]})).response.status,200);assert.equal((await f.request('finance/checkout-requests/'+id,undefined,'staff')).response.status,404);
 // Source invoice permission protects pending private review payload as well.
 const role2=await f.access('staff');const p=await f.cancel(id,'staff');assert.equal(p.response.status,202);await f.pg.query("DELETE FROM public.role_permissions WHERE role_id=$1 AND capability='invoices.view'",[role2.id]);assert.equal((await f.request('approvals/'+p.body.approval.id,undefined,'staff')).response.status,404);assert.equal((await f.approve(p.body.approval.id)).response.status,409);
});
check('critical audit/outbox failures roll back checkout and review together; immutable rows and school RLS cannot be bypassed',async f=>{
 await f.pg.exec('REVOKE INSERT ON public.outbox_events FROM kavosh_runtime');try{assert.equal((await f.prepare()).response.status,503);}finally{await f.pg.exec('GRANT INSERT ON public.outbox_events TO kavosh_runtime');}
 assert.equal((await f.pg.query('SELECT count(*)::integer n FROM public.payment_checkout_requests')).rows[0].n,0);const r=await f.prepare();assert.equal(r.response.status,201,JSON.stringify(r.body));
 await f.pg.exec('SET ROLE kavosh_runtime');try{await f.pg.query("SELECT set_config('app.academy_id',$1,false)",[f.b]);assert.equal((await f.pg.query('SELECT * FROM public.payment_checkout_requests')).rows.length,0);assert.equal((await f.pg.query('SELECT * FROM public.payment_connections')).rows.length,1);await f.pg.query("SELECT set_config('app.academy_id',$1,false)",[f.a]);for(const sql of ["UPDATE public.payment_checkout_requests SET amount_minor=1",'DELETE FROM public.payment_checkout_requests','DELETE FROM public.payment_checkout_cancellations'])await assert.rejects(f.pg.exec(sql),/permission denied/);}finally{await f.pg.exec('RESET ROLE');}
 await f.pg.query("UPDATE public.academies SET status='read_only' WHERE id=$1",[f.a]);assert.equal((await f.cancel(r.body.data.id)).response.status,403);
});
check('native checkout guard rejects forged money or source and requires both complete approval effect and critical audit',async f=>{
 await f.access('staff');const proposed=await f.prepare({},'staff');assert.equal(proposed.response.status,202);
 const p=(await f.pg.query<{id:string;target_id:string;payload:typeof f.input&{invoiceId:string};review_context:unknown}>('SELECT * FROM public.approval_requests WHERE id=$1',[proposed.body.approval.id])).rows[0];
 await f.pg.query("SELECT set_config('app.academy_id',$1,false)",[f.a]);
 const sql=`INSERT INTO public.payment_checkout_requests(academy_id,id,invoice_id,student_id,class_id,hub_id,connection_id,prior_id,amount_text,amount_minor,currency_id,unit_scale,currency_code,session_lifetime_minutes,dispatch_within_minutes,context,approval_id,created_by,reason)
 VALUES($1,$2,$3,$4,$5,$6,$7,NULL,$8,$9,$10,2,'CAD',60,10,$11::jsonb,$12,$13,$14)`,args:unknown[]=[f.a,p.target_id,f.invoice.id,f.student.id,f.c.id,f.hub,f.connection.connectionId,f.input.amount,'5000',f.currency.id,JSON.stringify(p.review_context),p.id,f.actors.master.person,f.input.reason];
 for(const [index,value] of [[8,'5001'],[10,JSON.stringify({source:{}})]] as const){const wrong=[...args];wrong[index]=value;await assert.rejects(f.pg.query(sql,wrong),/CHECKOUT_CURRENT_SOURCE_REQUIRED/);}
 await f.pg.exec('BEGIN');try{
  await f.pg.query(sql,args);await f.pg.query("UPDATE public.approval_requests SET status='applied',reviewer_id=$2,version=2,decided_at=transaction_timestamp() WHERE id=$1",[p.id,f.actors.master.person]);await assert.rejects(f.pg.exec('COMMIT'),/CHECKOUT_AUDIT_REQUIRED/);
 }finally{await f.pg.exec('ROLLBACK');}
 assert.equal((await f.pg.query('SELECT count(*)::integer n FROM public.payment_checkout_requests')).rows[0].n,0);
 await f.pg.exec('BEGIN');try{await f.pg.query("UPDATE public.approval_requests SET status='applied',reviewer_id=$2,version=2,decided_at=transaction_timestamp() WHERE id=$1",[p.id,f.actors.master.person]);await assert.rejects(f.pg.exec('COMMIT'),/CHECKOUT_EFFECT_REQUIRED/);}finally{await f.pg.exec('ROLLBACK');}
 assert.equal((await f.pg.query('SELECT status FROM public.approval_requests WHERE id=$1',[p.id])).rows[0].status,'pending');
});
check('runtime can hold only its school connection lock and cannot alter the operator registry or borrow ingest authority',async f=>{
 await f.pg.exec('SET ROLE kavosh_runtime');try{
  await f.pg.query("SELECT set_config('app.academy_id',$1,false)",[f.a]);assert.equal((await f.pg.query('SELECT public.lock_payment_checkout_connection($1) locked',[f.connection.connectionId])).rows[0].locked,true);assert.equal((await f.pg.query('SELECT public.lock_payment_checkout_connection($1) locked',[f.foreign.connectionId])).rows[0].locked,false);
  await assert.rejects(f.pg.query('UPDATE public.payment_connections SET enabled=false WHERE id=$1',[f.connection.connectionId]),/permission denied/);
 }finally{await f.pg.exec('RESET ROLE');}
 await f.pg.exec('SET ROLE kavosh_payment_ingest');try{await assert.rejects(f.pg.query('SELECT public.lock_payment_checkout_connection($1)',[f.connection.connectionId]),/permission denied/);}finally{await f.pg.exec('RESET ROLE');}
});
if(process.env.TEST_DATABASE_URL)check('four real concurrent invoice preparations serialize to one active intent with no financial effect',async f=>{
 const start=performance.now(),results=await Promise.all(Array.from({length:4},()=>f.prepare()));assert.equal(results.filter(r=>r.response.status===201).length,1,JSON.stringify(results.map(r=>r.body)));assert.equal(results.filter(r=>r.response.status===409).length,3);assert.equal((await f.pg.query('SELECT count(*)::integer n FROM public.payment_checkout_requests')).rows[0].n,1);assert.equal((await f.status()).balance,'113.00');console.log(JSON.stringify({measurement:'invoice-checkout-preparation-race',requests:4,elapsedMs:Math.ceil(performance.now()-start),intents:1,liveProviderCalls:0}));
});
