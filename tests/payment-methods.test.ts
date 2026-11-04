import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { operationsFixture } from './operations-fixture.ts';

async function fixture(){
 const f=await operationsFixture();
 for(const role of [f.managerRole,f.staffRole])await f.pg.query("INSERT INTO public.role_permissions VALUES($1,$2,'payment-methods.view','allow')",[f.a,role]);
 await f.pg.query("INSERT INTO public.role_permissions VALUES($1,$2,'payment-methods.edit','allow')",[f.a,f.managerRole]);
 const method=(patch:Record<string,unknown>={},as='master',key?:string)=>f.request('finance/payment-methods',{code:'ET',name:'Interac e-transfer',hubId:f.hub,category:'e_transfer',reason:'Synthetic method setup',...patch},as,{key});
 return {...f,method};
}
type Fixture=Awaited<ReturnType<typeof fixture>>;
function check(name:string,run:(f:Fixture)=>Promise<void>){test(name,async()=>{const f=await fixture();try{await run(f);}finally{await f.pg.close();}});}

check('reviewed method categories persist without creating a receipt, posting, gateway or tax exemption',async f=>{
 for(const category of ['cash','e_transfer','credit_card','debit_card','cheque','bank_transfer','other']){
  const r=await f.method({code:category.toUpperCase(),category,translations:{en:'Payment',fr:'Paiement','zh-CN':'付款'}});assert.equal(r.response.status,201,JSON.stringify(r.body));assert.equal(r.body.approval.selfApproved,true);
  const v=(await f.request('finance/payment-methods/'+r.body.data.id)).body.data;assert.equal(v.category,category);assert.equal(v.processing,'manual_record_only');assert.equal(v.onlinePaymentEnabled,false);assert.equal(v.version,1);
  const history=(await f.request('finance/payment-methods/'+v.id+'/history')).body.data;assert.equal(history[0].approvalId,r.body.approval.id);
 }
 assert.equal((await f.pg.query('SELECT * FROM public.finance_journals')).rows.length,0);
 assert.equal((await f.request('finance/payment-methods?category=credit_card&active=true')).body.data.length,1);
});
check('method edits need upper human review and retain private reasons outside broad audit access',async f=>{
 const pending=await f.method({},'manager');assert.equal(pending.response.status,202);assert.equal((await f.request('finance/payment-methods')).body.data.length,0);
 assert.equal((await f.approve(pending.body.approval.id,'manager')).response.status,403);const accepted=await f.approve(pending.body.approval.id);assert.equal(accepted.response.status,200,JSON.stringify(accepted.body));
 const secret='Private correction '+randomUUID(),id=accepted.body.data.id,r=await f.request('finance/payment-methods/'+id+'/change',{expectedVersion:1,name:secret,reason:secret},'manager');assert.equal(r.response.status,202);assert.equal((await f.approve(r.body.approval.id)).response.status,200);
 assert.ok(!JSON.stringify((await f.request('audit-events')).body).includes(secret));assert.equal((await f.request('finance/payment-methods/'+id+'/history')).body.data[1].reason,secret);
 assert.equal((await f.request('finance/payment-methods/'+id+'/history',undefined,'staff')).response.status,403);
});
check('method revisions preserve unmentioned values and labels without reclassifying historical payment identity',async f=>{
 const created=await f.method({translations:{en:'Transfer',fr:'Virement'}}),id=created.body.data.id;
 const revised=await f.request('finance/payment-methods/'+id+'/change',{expectedVersion:1,active:false,translations:{fr:null,'zh-CN':'转账'},reason:'Synthetic retirement'});assert.equal(revised.response.status,200,JSON.stringify(revised.body));assert.equal(revised.body.data.name,'Interac e-transfer');assert.deepEqual(revised.body.data.translations,{en:'Transfer','zh-CN':'转账'});
 assert.equal((await f.request('finance/payment-methods?active=true')).body.data.length,0);
 const first=await f.request('finance/payment-methods/'+id+'/history?limit=1');assert.equal(first.body.nextVersion,1);assert.equal(first.body.data[0].active,true);assert.equal((await f.request('finance/payment-methods/'+id+'/history?afterVersion=1')).body.data[0].active,false);
 for(const patch of [{code:'OTHER'},{category:'cash'},{hubId:f.otherHub},{onlinePaymentEnabled:true},{taxExempt:true},{cardNumber:'4242424242424242'}])assert.equal((await f.request('finance/payment-methods/'+id+'/change',{expectedVersion:2,reason:'Must reject',...patch})).response.status,400);
});
check('method views filter global, other-hub and foreign-school entries before pagination and lookup',async f=>{
 const own=await f.method(),other=await f.method({hubId:f.otherHub}),global=await f.method({hubId:null});
 const list=await f.request('finance/payment-methods?limit=1',undefined,'staff');assert.deepEqual(list.body.data.map((v:{id:string})=>v.id),[own.body.data.id]);assert.equal(list.body.nextCursor,null);
 for(const id of [other.body.data.id,global.body.data.id])assert.equal((await f.request('finance/payment-methods/'+id,undefined,'staff')).response.status,404);
 assert.equal((await f.request('finance/payment-methods/'+own.body.data.id,undefined,'foreignMaster',{academy:f.b})).response.status,404);
 assert.equal((await f.method({hubId:null,code:'FORBIDDEN'},'manager')).response.status,403);
});
check('method configuration validation rejects secrets, unknown fields, malformed labels and category bypasses before proposal writes',async f=>{
 const before=(await f.pg.query('SELECT * FROM public.approval_requests')).rows.length;
 for(const patch of [{code:'lowercase'},{category:'crypto_gateway'},{name:''},{name:'a\0b'},{reason:''},{translations:{fr:null}},{translations:{es:'Pago'}},
  {skipReporting:true},{accountNumber:'synthetic'},{providerSecret:'synthetic'},{gatewayUrl:'https://example.test'},{active:'true'}])assert.equal((await f.method(patch)).response.status,400,JSON.stringify(patch));
 assert.equal((await f.pg.query('SELECT * FROM public.approval_requests')).rows.length,before);
 assert.equal((await f.request('finance/payment-methods?limit=101')).response.status,400);assert.equal((await f.request('finance/payment-methods?category=unknown')).response.status,400);
});
check('method retries retain one revision and event failures roll back header, revision and approval together',async f=>{
 const key=randomUUID(),first=await f.method({},'master',key);assert.equal(first.response.status,201);assert.deepEqual((await f.method({},'master',key)).body,first.body);
 assert.equal((await f.method()).body.error.code,'PAYMENT_METHOD_CODE_EXISTS');assert.equal((await f.method({hubId:f.otherHub})).response.status,201);
 const id=first.body.data.id;await f.pg.exec('REVOKE INSERT ON public.outbox_events FROM kavosh_runtime');try{
  assert.equal((await f.request('finance/payment-methods/'+id+'/change',{expectedVersion:1,active:false,reason:'Synthetic event failure'})).response.status,503);
  assert.equal((await f.method({code:'ROLLBACK'})).response.status,503);
 }finally{await f.pg.exec('GRANT INSERT ON public.outbox_events TO kavosh_runtime');}
 assert.equal((await f.request('finance/payment-methods/'+id)).body.data.version,1);assert.equal((await f.request('finance/payment-methods/'+id+'/history')).body.data.length,1);assert.equal((await f.request('finance/payment-methods?q=ROLLBACK')).body.data.length,0);
});
check('stale method proposals cannot take newly occupied codes or changed hubs, and bots can propose but cannot approve',async f=>{
 const pending=await f.method({},'manager');await f.method();const stale=await f.approve(pending.body.approval.id);assert.equal(stale.response.status,409);assert.equal(stale.body.approval.decisionCode,'DEPENDENCIES_CHANGED');
 const bot=await f.method({code:'BOT'},'bot');assert.equal(bot.response.status,202);assert.equal((await f.approve(bot.body.approval.id,'bot')).response.status,403);assert.equal((await f.approve(bot.body.approval.id)).response.status,200);
 const changed=await f.method({code:'CHANGED'},'manager');await f.pg.query('UPDATE public.hubs SET version=version+1 WHERE id=$1',[f.hub]);assert.equal((await f.approve(changed.body.approval.id)).body.approval.decisionCode,'DEPENDENCIES_CHANGED');
});
check('revoking method editing hides private proposals and blocks application under the old authority snapshot',async f=>{
 const pending=await f.method({},'manager');assert.equal(pending.response.status,202);const id=pending.body.approval.id;
 await f.pg.query("DELETE FROM public.role_permissions WHERE role_id=$1 AND capability='payment-methods.edit'",[f.managerRole]);
 assert.equal((await f.request('approvals/'+id,undefined,'manager')).response.status,404);assert.ok(!(await f.request('approvals',undefined,'manager')).body.data.some((v:{id:string})=>v.id===id));
 const denied=await f.approve(id);assert.equal(denied.response.status,409);assert.equal(denied.body.approval.decisionCode,'AUTHORITY_CHANGED');assert.equal((await f.request('finance/payment-methods')).body.data.length,0);
});
check('read-only schools retain method lookup but cannot create or revise definitions',async f=>{
 const created=await f.method(),id=created.body.data.id;await f.pg.query("UPDATE public.academies SET status='read_only' WHERE id=$1",[f.a]);
 assert.equal((await f.request('finance/payment-methods/'+id)).response.status,200);assert.equal((await f.method({code:'BLOCKED'})).response.status,403);
 assert.equal((await f.request('finance/payment-methods/'+id+'/change',{expectedVersion:1,active:false,reason:'Blocked'})).response.status,403);
});
check('native method records enforce tenant isolation, append-only history and immutable code/category/ownership',async f=>{
 const created=await f.method(),id=created.body.data.id;await f.pg.exec('SET ROLE kavosh_runtime');try{
  await f.pg.query("SELECT set_config('app.academy_id',$1,false)",[f.b]);assert.equal((await f.pg.query('SELECT * FROM public.finance_payment_method_catalogue')).rows.length,0);
  await f.pg.query("SELECT set_config('app.academy_id',$1,false)",[f.a]);
  for(const sql of ['DELETE FROM public.finance_payment_method_revisions',"UPDATE public.finance_payment_method_revisions SET name='Overwrite'","UPDATE public.finance_payment_methods SET category='cash'",'UPDATE public.finance_payment_methods SET hub_id=NULL',"UPDATE public.finance_payment_methods SET code='NEW'"])await assert.rejects(f.pg.exec(sql),/permission denied/i);
  await assert.rejects(f.pg.exec('UPDATE public.finance_payment_methods SET version=version+2'),/FINANCE_VERSION_SEQUENCE/);await assert.rejects(f.pg.exec('UPDATE public.finance_payment_methods SET version=version+1'),/foreign key|finance_payment_method_current_revision/i);
 }finally{await f.pg.exec('RESET ROLE');}
 await f.pg.exec('BEGIN');try{
  await f.pg.query('UPDATE public.finance_payment_methods SET version=2 WHERE id=$1',[id]);
  await assert.rejects(f.pg.query(`INSERT INTO public.finance_payment_method_revisions(academy_id,method_id,version,name,active,translations,changed_by,approval_id,reason)
   SELECT academy_id,method_id,2,name,active,translations,changed_by,approval_id,reason FROM public.finance_payment_method_revisions WHERE method_id=$1 AND version=1`,[id]),/PAYMENT_METHOD_APPROVAL_MISMATCH/);
 }finally{await f.pg.exec('ROLLBACK');}
 assert.equal((await f.request('finance/payment-methods/'+id)).body.data.version,1);
});
check('explicit hub denials override broad method grants without exposing academy-wide records',async f=>{
 const own=await f.method(),other=await f.method({hubId:f.otherHub});await f.method({hubId:null});
 const permissions=(effect:string)=>['payment-methods.view','payment-methods.edit'].map(capability=>({capability,effect}));
 const allow=await f.request('roles',{name:'Broad method rights',permissions:permissions('allow')}),deny=await f.request('roles',{name:'Method hub denial',permissions:permissions('deny')});
 const access=(await f.request('people/'+f.actors.staff.person+'/access')).body.data;
 assert.equal((await f.request('people/'+f.actors.staff.person+'/access',{expectedVersion:access.version,assignments:[{roleId:allow.body.data.id,allHubs:true},{roleId:deny.body.data.id,allHubs:false,hubIds:[f.hub]}]})).response.status,200);
 assert.deepEqual((await f.request('finance/payment-methods',undefined,'staff')).body.data.map((v:{id:string})=>v.id),[other.body.data.id]);assert.equal((await f.request('finance/payment-methods/'+own.body.data.id,undefined,'staff')).response.status,404);
});
if(process.env.TEST_DATABASE_URL)check('simultaneous native method creation and correction have one winner with no lost history',async f=>{
 const creates=await Promise.all([f.method(),f.method()]);assert.deepEqual(creates.map(v=>v.response.status).sort(),[201,409]);const id=creates.find(v=>v.response.status===201)!.body.data.id;
 const revisions=await Promise.all(['A','B'].map(name=>f.request('finance/payment-methods/'+id+'/change',{expectedVersion:1,name,reason:'Synthetic competing edit'})));assert.deepEqual(revisions.map(v=>v.response.status).sort(),[200,409]);
 assert.equal((await f.pg.query('SELECT * FROM public.finance_payment_methods')).rows.length,1);assert.equal((await f.pg.query('SELECT * FROM public.finance_payment_method_revisions')).rows.length,2);assert.equal((await f.pg.query('SELECT * FROM public.approval_requests')).rows.length,2);
});
if(process.env.TEST_DATABASE_URL)check('one hundred simultaneous scoped method searches preserve results and bounded database work',async f=>{
 const own=await f.method({name:'Transfer % literal'});await f.method({hubId:f.otherHub});await f.method({hubId:null});
 const before=f.metrics.businessQueries,times:number[]=[];
 await Promise.all(Array.from({length:100},async()=>{const start=performance.now(),r=await f.request('finance/payment-methods?q=%25&category=e_transfer&active=true',undefined,'staff');times.push(performance.now()-start);
  assert.equal(r.response.status,200,JSON.stringify(r.body));assert.deepEqual(r.body.data.map((v:{id:string})=>v.id),[own.body.data.id]);assert.equal(r.body.nextCursor,null);
 }));
 const queries=f.metrics.businessQueries-before;assert.equal(queries,1200);assert.equal((await f.pg.query('SELECT * FROM public.finance_journals')).rows.length,0);
 console.log(JSON.stringify({measurement:'synthetic-payment-method-search',requests:100,poolMaximum:4,queries,p99Ms:Math.ceil(times.sort((a,b)=>a-b)[98]),ledgerPostings:0,bankRequests:0}));
});
