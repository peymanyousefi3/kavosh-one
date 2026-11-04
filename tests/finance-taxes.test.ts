import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { operationsFixture } from './operations-fixture.ts';

async function fixture(){
 const f=await operationsFixture();
 for(const role of [f.managerRole,f.staffRole])await f.pg.query("INSERT INTO public.role_permissions VALUES($1,$2,'tax-codes.view','allow')",[f.a,role]);
 await f.pg.query("INSERT INTO public.role_permissions VALUES($1,$2,'tax-codes.edit','allow')",[f.a,f.managerRole]);
 await f.pg.query("INSERT INTO public.role_permissions VALUES($1,$2,'currencies.view','allow')",[f.a,f.policyRole]);
 const currencyRole=randomUUID(),assignment=randomUUID();await f.pg.query("INSERT INTO public.roles(academy_id,id,name) VALUES($1,$2,'Synthetic currency viewer')",[f.a,currencyRole]);
 await f.pg.query("INSERT INTO public.role_permissions VALUES($1,$2,'currencies.view','allow')",[f.a,currencyRole]);
 await f.pg.query('INSERT INTO public.role_assignments VALUES($1,$2,$3,$4,true)',[f.a,assignment,f.actors.staff.person,currencyRole]);
 const tax=(patch:Record<string,unknown>={},as='master',key?:string)=>f.request('finance/tax-codes',{code:'HST-ON',name:'Synthetic taxable item',hubId:f.hub,countryCode:'CA',regionCode:'ON',classification:'taxable',ratePercent:'13',startsOn:'2026-01-01',legalBasis:'Synthetic reviewed classification; no production eligibility assumption',reason:'Synthetic tax setup',...patch},as,{key});
 const currency=async(patch:Record<string,unknown>={})=>{const r=await f.request('finance/currencies',{code:'CAD',name:'Canadian dollar',symbol:'C$',unitScale:2,reason:'Synthetic units',...patch});assert.equal(r.response.status,201,JSON.stringify(r.body));return r.body.data.id as string;};
 const preview=(id:string,currencyId:string,patch:Record<string,unknown>={},as='master')=>f.request('finance/tax-codes/'+id+'/preview',{expectedVersion:1,currencyId,currencyVersion:1,on:'2026-06-01',amount:'100.00',pricing:'tax_exclusive',...patch},as);
 return {...f,tax,currency,preview};
}
type Fixture=Awaited<ReturnType<typeof fixture>>;
function check(name:string,run:(f:Fixture)=>Promise<void>){test(name,async()=>{const f=await fixture();try{await run(f);}finally{await f.pg.close();}});}

check('master tax codes persist reviewed classifications, exact rates, effective dates and translations without inventing tax postings',async f=>{
 const r=await f.tax({translations:{en:'Sales tax',fr:'Taxe de vente','zh-CN':'销售税'}});assert.equal(r.response.status,201,JSON.stringify(r.body));assert.equal(r.body.approval.selfApproved,true);assert.equal(r.body.data.ratePercent,'13.0000');assert.equal(r.body.data.version,1);
 const id=r.body.data.id;assert.equal((await f.request('finance/tax-codes/'+id)).body.data.countryCode,'CA');assert.equal((await f.request('finance/tax-codes?on=2026-06-01&active=true')).body.data.length,1);
 const history=(await f.request('finance/tax-codes/'+id+'/history')).body.data;assert.equal(history[0].approvalId,r.body.approval.id);assert.equal(history[0].legalBasis,r.body.data.legalBasis);
 assert.equal((await f.pg.query('SELECT * FROM public.finance_journals')).rows.length,0);
});
check('non-master tax changes require upper human review and do not leak private proposed corrections into audit or viewers',async f=>{
 const pending=await f.tax({},'manager');assert.equal(pending.response.status,202,JSON.stringify(pending.body));assert.equal((await f.request('finance/tax-codes')).body.data.length,0);assert.equal((await f.approve(pending.body.approval.id,'manager')).response.status,403);
 const approved=await f.approve(pending.body.approval.id);assert.equal(approved.response.status,200,JSON.stringify(approved.body));const id=approved.body.data.id;
 const secret='Private legal correction '+randomUUID(),change=await f.request('finance/tax-codes/'+id+'/change',{expectedVersion:1,ratePercent:'9.975',name:secret,reason:secret},'manager');assert.equal(change.response.status,202);assert.equal((await f.approve(change.body.approval.id)).response.status,200);
 assert.ok(!JSON.stringify((await f.request('audit-events')).body).includes(secret));assert.equal((await f.request('finance/tax-codes/'+id+'/history')).body.data[1].reason,secret);
 assert.equal((await f.request('finance/tax-codes/'+id+'/history',undefined,'staff')).response.status,403);
});
check('partial revisions retain prior settings and explicit label deletion, while code and hub ownership cannot silently move',async f=>{
 const created=await f.tax({endsOn:'2026-12-31',translations:{en:'Tax',fr:'Taxe'}}),id=created.body.data.id;
 const r=await f.request('finance/tax-codes/'+id+'/change',{expectedVersion:1,name:'New tax label',translations:{fr:null,'zh-CN':'税'},reason:'Synthetic revision'});assert.equal(r.response.status,200,JSON.stringify(r.body));assert.equal(r.body.data.ratePercent,'13.0000');assert.equal(r.body.data.endsOn,'2026-12-31');assert.deepEqual(r.body.data.translations,{en:'Tax','zh-CN':'税'});
 const history=await f.request('finance/tax-codes/'+id+'/history?limit=1');assert.equal(history.body.nextVersion,1);assert.equal(history.body.data[0].name,'Synthetic taxable item');assert.equal((await f.request('finance/tax-codes/'+id+'/history?afterVersion=1')).body.data[0].version,2);
 for(const patch of [{code:'NEW'},{hubId:f.otherHub},{balance:'1'},{paymentMethod:'cash'}])assert.equal((await f.request('finance/tax-codes/'+id+'/change',{expectedVersion:2,reason:'Must not move',...patch})).response.status,400);
});
check('tax readers filter hub/global records before pagination and require separate currency rights for previews',async f=>{
 const currency=await f.currency(),own=await f.tax(),other=await f.tax({hubId:f.otherHub}),global=await f.tax({hubId:null});assert.equal(global.response.status,201);
 const list=await f.request('finance/tax-codes?limit=1',undefined,'staff');assert.deepEqual(list.body.data.map((v:{id:string})=>v.id),[own.body.data.id]);assert.equal(list.body.nextCursor,null);
 for(const id of [other.body.data.id,global.body.data.id])assert.equal((await f.request('finance/tax-codes/'+id,undefined,'staff')).response.status,404);
 assert.equal((await f.request('finance/tax-codes/'+own.body.data.id,undefined,'foreignMaster',{academy:f.b})).response.status,404);
 assert.equal((await f.preview(own.body.data.id,currency,{},'staff')).response.status,200);
 await f.pg.query("DELETE FROM public.role_permissions WHERE capability='currencies.view' AND role_id IN(SELECT role_id FROM public.role_assignments WHERE person_id=$1)",[f.actors.staff.person]);
 assert.equal((await f.preview(own.body.data.id,currency,{},'staff')).response.status,403);
});
check('included/excluded tax previews preserve exact cents, signed credits, tax-first half-cent rounding and no business writes',async f=>{
 const currency=await f.currency(),r=await f.tax(),id=r.body.data.id;
 const count=async()=>(await f.pg.query('SELECT (SELECT count(*) FROM public.finance_journals)::int AS journals,(SELECT count(*) FROM public.approval_requests)::int AS approvals,(SELECT count(*) FROM public.outbox_events)::int AS events')).rows;
 const before=await count();
 for(const [amount,pricing,net,tax,gross] of [['100','tax_exclusive','100.00','13.00','113.00'],['113','tax_inclusive','100.00','13.00','113.00'],['-113','tax_inclusive','-100.00','-13.00','-113.00'],['0.05','tax_exclusive','0.05','0.01','0.06'],['0','tax_inclusive','0.00','0.00','0.00']]) {
  const v=await f.preview(id,currency,{amount,pricing});assert.equal(v.response.status,200,JSON.stringify(v.body));assert.equal(v.body.data.net,net);assert.equal(v.body.data.tax,tax);assert.equal(v.body.data.gross,gross);assert.equal(v.body.data.posted,false);assert.equal(v.body.data.taxEligibilityDetermined,false);
 }
 const hundred=await f.tax({code:'HALF-CENT',ratePercent:'100'});for(const sign of ['','-']){const v=await f.preview(hundred.body.data.id,currency,{amount:sign+'0.05',pricing:'tax_inclusive'});assert.equal(v.body.data.tax,sign+'0.03');assert.equal(v.body.data.net,sign+'0.02');}
 // Only creation of the separate synthetic code is a write; previews are not.
 assert.deepEqual((await count())[0],{journals:0,approvals:Number(before[0].approvals)+1,events:Number(before[0].events)+2});
});
check('zero-rated, exempt and out-of-scope records remain distinct and cannot be selected by a cash-payment bypass',async f=>{
 const currency=await f.currency();
 for(const [kind,pricing] of [['zero_rated','tax_exclusive'],['exempt','not_applicable'],['out_of_scope','not_applicable']]) {
  const r=await f.tax({code:kind.toUpperCase(),classification:kind,ratePercent:'0'});assert.equal(r.response.status,201,JSON.stringify(r.body));const v=await f.preview(r.body.data.id,currency,{pricing});assert.equal(v.response.status,200);assert.equal(v.body.data.classification,kind);assert.equal(v.body.data.tax,'0.00');assert.equal(v.body.data.gross,'100.00');
  assert.equal((await f.preview(r.body.data.id,currency,{pricing:pricing==='not_applicable'?'tax_exclusive':'not_applicable'})).response.status,400);
 }
 const taxable=await f.tax();assert.equal((await f.preview(taxable.body.data.id,currency,{pricing:'not_applicable'})).response.status,400);
 for(const paymentMethod of ['cash','ET','card'])assert.equal((await f.preview(taxable.body.data.id,currency,{paymentMethod})).response.status,400);
});
check('tax amount previews reject stale/retired sources, out-of-range dates, excess precision and oversized posting amounts',async f=>{
 const currency=await f.currency(),r=await f.tax({endsOn:'2026-06-30'}),id=r.body.data.id;
 for(const on of ['2025-12-31','2026-07-01'])assert.equal((await f.preview(id,currency,{on})).response.status,409);
 for(const on of ['2026-01-01','2026-06-30'])assert.equal((await f.preview(id,currency,{on})).response.status,200);
 assert.equal((await f.preview(id,currency,{expectedVersion:2})).response.status,409);assert.equal((await f.preview(id,currency,{currencyVersion:2})).response.status,409);
 for(const amount of ['1.001','1e3','NaN','9'.repeat(39)])assert.equal((await f.preview(id,currency,{amount})).response.status,400);
 assert.equal((await f.preview(id,currency,{amount:'9'.repeat(36)+'.99'})).response.status,400,'gross may not overflow the posting bound');
 await f.request('finance/currencies/'+currency+'/change',{expectedVersion:1,active:false,reason:'Synthetic retirement'});assert.equal((await f.preview(id,currency,{currencyVersion:2})).response.status,409);
});
check('invalid classifications, rates, dates, translations and unknown fields fail without creating proposals',async f=>{
 const before=(await f.pg.query('SELECT * FROM public.approval_requests')).rows.length;
 for(const patch of [{ratePercent:13},{ratePercent:'100.0001'},{ratePercent:'-1'},{ratePercent:'13.00001'},{classification:'taxable',ratePercent:'0'},
  {classification:'exempt',ratePercent:'13'},{classification:'cash_no_report'},{legalBasis:''},{startsOn:'2026-02-30'},{endsOn:'2025-01-01'},
  {translations:{fr:null}},{countryCode:'ca'},{regionCode:'on!'},{skipReporting:true}])assert.equal((await f.tax(patch)).response.status,400,JSON.stringify(patch));
 assert.equal((await f.pg.query('SELECT * FROM public.approval_requests')).rows.length,before);
});
check('tax setup and revisions retry exactly, retain current authority and roll back all writes after event failure',async f=>{
 const key=randomUUID(),created=await f.tax({},'master',key);assert.equal(created.response.status,201);assert.deepEqual((await f.tax({},'master',key)).body,created.body);
 assert.equal((await f.tax()).body.error.code,'TAX_CODE_EXISTS');assert.equal((await f.tax({hubId:f.otherHub})).response.status,201);
 const id=created.body.data.id;await f.pg.exec('REVOKE INSERT ON public.outbox_events FROM kavosh_runtime');try{assert.equal((await f.request('finance/tax-codes/'+id+'/change',{expectedVersion:1,name:'Must roll back',reason:'Synthetic event failure'})).response.status,503);}finally{await f.pg.exec('GRANT INSERT ON public.outbox_events TO kavosh_runtime');}
 assert.equal((await f.request('finance/tax-codes/'+id)).body.data.version,1);assert.equal((await f.request('finance/tax-codes/'+id+'/history')).body.data.length,1);
 await f.pg.query("DELETE FROM public.role_permissions WHERE role_id=$1 AND capability='tax-codes.edit'",[f.managerRole]);assert.equal((await f.tax({code:'OTHER'},'manager')).response.status,403);
});
check('tax proposals go stale when hub/source/code ownership changes and bots cannot apply their own configuration',async f=>{
 const pending=await f.tax({},'manager');assert.equal(pending.response.status,202);assert.equal((await f.tax()).response.status,201);
 const stale=await f.approve(pending.body.approval.id);assert.equal(stale.response.status,409);assert.equal(stale.body.approval.decisionCode,'DEPENDENCIES_CHANGED');
 const bot=await f.tax({code:'BOT'},'bot');assert.equal(bot.response.status,202);assert.equal((await f.approve(bot.body.approval.id,'bot')).response.status,403);assert.equal((await f.approve(bot.body.approval.id)).response.status,200);
 const changed=await f.tax({code:'HUB-CHANGE'},'manager');await f.pg.query('UPDATE public.hubs SET version=version+1 WHERE id=$1',[f.hub]);assert.equal((await f.approve(changed.body.approval.id)).body.approval.decisionCode,'DEPENDENCIES_CHANGED');
});
check('read-only academies retain exact tax previews but cannot create or revise tax definitions',async f=>{
 const currency=await f.currency(),r=await f.tax();await f.pg.query("UPDATE public.academies SET status='read_only' WHERE id=$1",[f.a]);
 assert.equal((await f.preview(r.body.data.id,currency)).response.status,200);assert.equal((await f.tax({code:'BLOCKED'})).response.status,403);
 assert.equal((await f.request('finance/tax-codes/'+r.body.data.id+'/change',{expectedVersion:1,active:false,reason:'Blocked mutation'})).response.status,403);
});
check('native tax history is tenant-bound, append-only and contiguous with immutable code/hub and exact approval targeting',async f=>{
 const created=await f.tax(),id=created.body.data.id;
 await f.pg.exec('SET ROLE kavosh_runtime');try {
  await f.pg.query("SELECT set_config('app.academy_id',$1,false)",[f.b]);assert.equal((await f.pg.query('SELECT * FROM public.finance_tax_catalogue')).rows.length,0);
  await f.pg.query("SELECT set_config('app.academy_id',$1,false)",[f.a]);
  for(const sql of ['DELETE FROM public.finance_tax_code_revisions',"UPDATE public.finance_tax_code_revisions SET rate_millionths=0",'UPDATE public.finance_tax_codes SET hub_id=NULL',"UPDATE public.finance_tax_codes SET code='OTHER'"])await assert.rejects(f.pg.exec(sql),/permission denied/i);
  await assert.rejects(f.pg.exec('UPDATE public.finance_tax_codes SET version=version+2'),/FINANCE_VERSION_SEQUENCE/);
  await assert.rejects(f.pg.exec('UPDATE public.finance_tax_codes SET version=version+1'),/foreign key|finance_tax_current_revision/i);
 }finally{await f.pg.exec('RESET ROLE');}
 const pending=await f.request('finance/tax-codes/'+id+'/change',{expectedVersion:1,name:'Pending tax revision',reason:'Native source checks'},'manager');assert.equal(pending.response.status,202);
 for(const [rate,kind,approval] of [[-1,'taxable',pending.body.approval.id],[0,'taxable',pending.body.approval.id],[130000,'exempt',pending.body.approval.id],[130000,'taxable',created.body.approval.id]]) {
  await f.pg.exec('BEGIN');try {
   await f.pg.query('UPDATE public.finance_tax_codes SET version=2 WHERE id=$1',[id]);
   await assert.rejects(f.pg.query(`INSERT INTO public.finance_tax_code_revisions(academy_id,tax_code_id,version,name,country_code,region_code,classification,rate_millionths,starts_on,ends_on,legal_basis,active,translations,changed_by,approval_id,reason)
    SELECT academy_id,tax_code_id,2,name,country_code,region_code,$2,$3,starts_on,ends_on,legal_basis,active,translations,changed_by,$4,'Invalid native revision' FROM public.finance_tax_code_revisions WHERE tax_code_id=$1 AND version=1`,[id,kind,rate,approval]),/check|FINANCE_TAX_APPROVAL_MISMATCH/i);
  }finally{await f.pg.exec('ROLLBACK');}
 }
 assert.equal((await f.request('finance/tax-codes/'+id)).body.data.version,1);
});
check('explicit hub denials remove tax records and previews even from broad grants without exposing global definitions',async f=>{
 const currency=await f.currency(),own=await f.tax(),other=await f.tax({hubId:f.otherHub}),global=await f.tax({hubId:null});
 const permissions=(effect:string)=>['tax-codes.view','tax-codes.edit'].map(capability=>({capability,effect}));
 const allow=await f.request('roles',{name:'Broad tax rights',permissions:permissions('allow')}),deny=await f.request('roles',{name:'Denied tax hub',permissions:permissions('deny')});assert.equal(allow.response.status,201);assert.equal(deny.response.status,201);
 const access=(await f.request('people/'+f.actors.staff.person+'/access')).body.data;
 const changed=await f.request('people/'+f.actors.staff.person+'/access',{expectedVersion:access.version,assignments:[{roleId:allow.body.data.id,allHubs:true},{roleId:deny.body.data.id,allHubs:false,hubIds:[f.hub]}]});assert.equal(changed.response.status,200);
 assert.deepEqual((await f.request('finance/tax-codes',undefined,'staff')).body.data.map((r:{id:string})=>r.id),[other.body.data.id]);
 for(const id of [own.body.data.id,global.body.data.id])assert.equal((await f.request('finance/tax-codes/'+id,undefined,'staff')).response.status,404);
 const locks=f.metrics.sharedPolicyLocks;assert.equal((await f.request('finance/tax-codes/'+own.body.data.id+'/change',{expectedVersion:1,name:'Denied',reason:'Must not wait for writes'},'staff')).response.status,404);assert.equal(f.metrics.sharedPolicyLocks,locks);
 assert.equal((await f.preview(own.body.data.id,currency,{},'staff')).response.status,404);
});
check('revoked private editing rights hide pending tax payloads and invalidate application rather than leaking them through approvals',async f=>{
 const pending=await f.tax({},'manager');assert.equal(pending.response.status,202);const id=pending.body.approval.id;
 assert.equal((await f.request('approvals/'+id,undefined,'manager')).response.status,200);
 await f.pg.query("DELETE FROM public.role_permissions WHERE role_id=$1 AND capability='tax-codes.edit'",[f.managerRole]);
 assert.equal((await f.request('approvals/'+id,undefined,'manager')).response.status,404);assert.ok(!(await f.request('approvals',undefined,'manager')).body.data.some((p:{id:string})=>p.id===id));
 const result=await f.approve(id);assert.equal(result.response.status,409);assert.equal(result.body.approval.decisionCode,'AUTHORITY_CHANGED');assert.equal((await f.request('finance/tax-codes')).body.data.length,0);
});
if(process.env.TEST_DATABASE_URL)check('simultaneous native tax creations and versioned corrections retain one winner without losing proposal/revision debris',async f=>{
 const results=await Promise.all([f.tax(),f.tax()]);assert.deepEqual(results.map(r=>r.response.status).sort(),[201,409]);
 const id=results.find(r=>r.response.status===201)!.body.data.id;
 const corrections=await Promise.all(['14','15'].map(ratePercent=>f.request('finance/tax-codes/'+id+'/change',{expectedVersion:1,ratePercent,reason:'Synthetic parallel correction'})));assert.deepEqual(corrections.map(r=>r.response.status).sort(),[200,409]);
 assert.equal((await f.pg.query('SELECT * FROM public.finance_tax_codes')).rows.length,1);assert.equal((await f.pg.query('SELECT * FROM public.finance_tax_code_revisions')).rows.length,2);assert.equal((await f.pg.query('SELECT * FROM public.approval_requests')).rows.length,2);
 assert.equal((await f.pg.query("SELECT * FROM public.outbox_events WHERE event_type LIKE 'finance.tax-code.%'")).rows.length,2);
});
if(process.env.TEST_DATABASE_URL)check('five thousand tax definitions support one hundred scoped searches and exact previews with bounded query counts',async f=>{
 const currency=await f.currency(),first=await f.tax({name:'Tax % literal'});assert.equal(first.response.status,201);const id=first.body.data.id;
 await f.pg.exec('BEGIN');try {
  await f.pg.exec('CREATE TEMP TABLE synthetic_tax_seed AS SELECT gen_random_uuid() AS id,gen_random_uuid() AS approval_id,n FROM generate_series(1,4999) n');
  await f.pg.query(`INSERT INTO public.approval_requests(academy_id,id,requester_id,requester_kind,credential_snapshot,grants_hash,action,target_id,target_version,payload,scope,dependency_hash,review_context,privacy_capability,status,version,reviewer_id,reason,decided_at)
   SELECT a.academy_id,s.approval_id,a.requester_id,a.requester_kind,a.credential_snapshot,a.grants_hash,a.action,s.id,0,
    a.payload||jsonb_build_object('code','T'||s.n,'hubId',CASE WHEN s.n%2=1 THEN $3::uuid ELSE $4::uuid END),
    jsonb_build_object('all',false,'hubs',jsonb_build_array(CASE WHEN s.n%2=1 THEN $3::uuid ELSE $4::uuid END)),a.dependency_hash,a.review_context,a.privacy_capability,a.status,a.version,a.reviewer_id,a.reason,a.decided_at
   FROM public.approval_requests a CROSS JOIN synthetic_tax_seed s WHERE a.academy_id=$1 AND a.id=$2`,[f.a,first.body.approval.id,f.hub,f.otherHub]);
  await f.pg.query(`INSERT INTO public.finance_tax_codes(academy_id,id,hub_id,code,created_by)
   SELECT $1,s.id,CASE WHEN s.n%2=1 THEN $2::uuid ELSE $3::uuid END,'T'||s.n,$4 FROM synthetic_tax_seed s`,[f.a,f.hub,f.otherHub,f.actors.master.person]);
  await f.pg.query(`INSERT INTO public.finance_tax_code_revisions(academy_id,tax_code_id,version,name,country_code,region_code,classification,rate_millionths,starts_on,ends_on,legal_basis,active,translations,changed_by,approval_id,reason)
   SELECT r.academy_id,s.id,1,'Synthetic tax '||lpad(s.n::text,5,'0'),r.country_code,r.region_code,r.classification,r.rate_millionths,r.starts_on,r.ends_on,r.legal_basis,r.active,r.translations,r.changed_by,s.approval_id,'Synthetic load seed'
   FROM public.finance_tax_code_revisions r CROSS JOIN synthetic_tax_seed s WHERE r.academy_id=$1 AND r.tax_code_id=$2 AND r.version=1`,[f.a,id]);
  await f.pg.exec('COMMIT');
 }catch(error){await f.pg.exec('ROLLBACK');throw error;}
 assert.equal((await f.request('finance/tax-codes?q=%25',undefined,'staff')).body.data.length,1,'search is literal, not a SQL wildcard');
 const run=async(previews:boolean)=>{
  const before=f.metrics.businessQueries,times:number[]=[];
  await Promise.all(Array.from({length:100},async()=>{const started=performance.now(),r=previews?await f.preview(id,currency,{amount:'0.05'}):await f.request('finance/tax-codes?q=Synthetic%20tax%2004999',undefined,'staff');times.push(performance.now()-started);assert.equal(r.response.status,200,JSON.stringify(r.body));
   if(previews){assert.equal(r.body.data.tax,'0.01');assert.equal(r.body.data.gross,'0.06');assert.equal(r.body.data.posted,false);}else{assert.equal(r.body.data.length,1);assert.equal(r.body.data[0].hubId,f.hub);assert.equal(r.body.data[0].name,'Synthetic tax 04999');}
  }));const queries=f.metrics.businessQueries-before;assert.equal(queries,previews?1300:1200);
  return {p99Ms:Math.ceil(times.sort((a,b)=>a-b)[98]),queries};
 };
 const search=await run(false),preview=await run(true);assert.equal((await f.pg.query('SELECT * FROM public.finance_journals')).rows.length,0);
 console.log(JSON.stringify({measurement:'synthetic-tax-code-catalogue-preview',definitions:5000,requestsPerPhase:100,poolMaximum:4,search,preview,ledgerPostings:0,bankRequests:0}));
});
