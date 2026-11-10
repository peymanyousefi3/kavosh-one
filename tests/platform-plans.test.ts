import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { operationsFixture } from './operations-fixture.ts';
import { createPlatformApi,assertPlatformRole } from '../src/platform/api.ts';
import type { Database } from '../src/core/database.ts';
import { upgradeToCurrent } from './migration-upgrade.ts';

const definition={name:'Synthetic free academy',description:'Reference terms only',currencyCode:'CAD',unitScale:2,amountMinor:'0',periodMonths:1,graceDays:30,active:true};
const instant=(days:number)=>new Date(Date.now()+days*86400000).toISOString();
async function fixture(options:{throughSchema?:number}={}){
 const f=await operationsFixture(options);try{
  const owner=f.actors.master;await f.pg.query('SELECT platform_private.register_owner($1,$2)',[owner.user,'Synthetic verified platform owner']);
  const database:Database={async connect(){if(f.pg.runtime){const c=await f.pg.runtime.connect();await c.query('SET ROLE kavosh_platform_service');return c;}await f.pg.exec('SET ROLE kavosh_platform_service');return{query:<Row>(sql:string,args?:unknown[])=>f.pg.query<Row>(sql,args),release(){}};}};
  const api=createPlatformApi(database,async r=>{const a=f.actors[r.headers.get('x-test-actor')??''];return a?{userId:a.user,sessionId:a.session}:null;},true);
  async function request(path:string,body?:unknown,actor='master',key:string=randomUUID()){
   try{const response=await api(new Request('https://academy.example/api/platform/v1/'+path,{method:body===undefined?'GET':'POST',headers:{'x-test-actor':actor,'content-type':'application/json','idempotency-key':key},...(body===undefined?{}:{body:JSON.stringify(body)})}),path.split('?')[0]);return{response,body:await response.json()};}
   finally{if(!f.pg.runtime)await f.pg.exec('RESET ROLE');}
  }
  return{...f,schoolRequest:f.request,owner,request,create:(key?:string)=>request('plans',{definition,reason:'Synthetic free school plan'},'master',key)};
 }catch(e){await f.pg.close();throw e;}
}
test('platform plans persist exact zero and large prices, editable terms, archive, copies and bounded immutable history without tuition effects',async()=>{
 const f=await fixture();try{
  const schools=(await f.pg.query('SELECT * FROM public.academies ORDER BY id')).rows,key=randomUUID(),first=await f.create(key);assert.equal(first.response.status,201,JSON.stringify(first.body));assert.equal(first.response.headers.get('cache-control'),'no-store');assert.equal(first.body.chargesPerformed,false);assert.equal(first.body.schoolAccessChanged,false);
  assert.deepEqual((await f.create(key)).body,first.body);const id=first.body.data.id;
  const changedDefinition={...definition,amountMinor:'99999999999999999999999999999999999999',active:false};
  const changed=await f.request('plans/'+id+'/change',{expectedVersion:1,definition:changedDefinition,reason:'Synthetic archive and exact large reference price'});assert.equal(changed.response.status,200,JSON.stringify(changed.body));assert.equal(changed.body.data.version,2);
  assert.equal((await f.request('plans/'+id)).body.data.definition.amountMinor,changedDefinition.amountMinor);
  const copy=await f.request('plans/'+id+'/duplicate',{expectedVersion:2,name:'Synthetic copied plan',reason:'Synthetic exact edition copy'});assert.equal(copy.response.status,201,JSON.stringify(copy.body));assert.equal(copy.body.data.sourcePlanId,id);assert.equal(copy.body.data.sourceVersion,2);assert.deepEqual(copy.body.data.definition,{...changedDefinition,name:'Synthetic copied plan'});
  const history=(await f.request('plans/'+id+'/history?limit=1')).body;assert.equal(history.data.length,1);assert.equal(history.nextBeforeVersion,2);
  assert.deepEqual((await f.request('plans/'+id+'/history?limit=1&beforeVersion='+history.nextBeforeVersion)).body.data.map((e:any)=>e.version),[1]);
  const page=(await f.request('plans?limit=1')).body;assert.equal(page.data.length,1);assert.ok(page.nextCursor);assert.equal((await f.request('plans?limit=1&after='+page.nextCursor)).body.data.length,1);
  assert.equal((await f.request('plans?limit=1&limit=2')).response.status,400);assert.equal((await f.request('plans/'+id+'/history?beforeVersion=0')).response.status,400);
  const editions=await f.request('plans/'+id+'/history');assert.deepEqual(editions.body.data.map((e:any)=>e.version),[2,1]);assert.deepEqual(editions.body.data[1].definition,definition);
  assert.deepEqual((await f.pg.query('SELECT * FROM public.academies ORDER BY id')).rows,schools);
  assert.equal((await f.pg.query('SELECT * FROM platform_private.subscription_plan_editions')).rows.length,3);
  await assert.rejects(f.pg.exec('UPDATE platform_private.subscription_plan_editions SET definition=definition'),/PLATFORM_HISTORY_IMMUTABLE/);
  await assert.rejects(f.pg.exec('DELETE FROM platform_private.subscription_plans'),/PLATFORM_HISTORY_IMMUTABLE/);
 }finally{await f.pg.close();}
});
test('platform plans reject stale versions, changed retries, malformed money and native SQL bypass, and require current owner MFA',async()=>{
 const f=await fixture();try{
  const key=randomUUID(),first=await f.create(key),id=first.body.data.id;assert.equal(first.response.status,201);
  assert.equal((await f.request('plans',{definition:{...definition,name:'Changed retry'},reason:'Synthetic free school plan'},'master',key)).response.status,409);
  for(const patch of [{amountMinor:'-1'},{amountMinor:'1.1'},{amountMinor:'01'},{amountMinor:5},{currencyCode:'cad'},{unitScale:19},{periodMonths:0},{graceDays:366},{extra:true}])assert.equal((await f.request('plans',{definition:{...definition,...patch},reason:'Synthetic bad terms'})).response.status,400);
  assert.equal((await f.request('plans/'+id+'/change',{expectedVersion:2,definition:{...definition,active:false},reason:'Synthetic stale version'})).response.status,409);
  assert.equal((await f.request('plans/'+id+'/duplicate',{expectedVersion:2,name:'Synthetic stale copy',reason:'Synthetic stale source'})).response.status,409);
  assert.equal((await f.request('plans/'+randomUUID())).response.status,404);
  assert.equal((await f.create()).response.status,201);
  assert.equal((await f.request('plans',undefined,'foreignMaster')).response.status,403);
  await f.pg.exec('SET ROLE kavosh_platform_service');try{
   await assertPlatformRole({query:<Row>(sql:string,args?:unknown[])=>f.pg.query<Row>(sql,args),release(){}});
   await assert.rejects(f.pg.query('SELECT * FROM platform_private.subscription_plans'),/permission denied/);
   await assert.rejects(f.pg.query('SELECT platform_private.plan_request($1,$2,$3,$4,$5::jsonb)',[f.owner.user,f.owner.session,'plans.create',randomUUID(),JSON.stringify({definition,reason:'Synthetic bypass'})]),/permission denied/);
   await assert.rejects(f.pg.query('SELECT platform_private.request($1,$2,$3,$4,$5::jsonb)',[f.owner.user,f.owner.session,'plans.create',randomUUID(),JSON.stringify({definition:{...definition,amountMinor:'-9'},reason:'Synthetic native invalid price'})]),/INVALID_PLATFORM_INPUT/);
  }finally{await f.pg.exec('RESET ROLE');}
  await f.pg.query('UPDATE identity.session SET "mfaVerified"=false WHERE id=$1',[f.owner.session]);
  assert.equal((await f.create(key)).response.status,403);assert.equal((await f.request('plans')).response.status,403);
 }finally{await f.pg.close();}
});
test('platform plan missing audit or immutable edition rolls the entire transaction back, preserving its retry',async()=>{
 const f=await fixture();try{
  for(const [table,condition] of [['audit_events',"NEW.action='platform.plans.created'"],['subscription_plan_editions','true']] as const){
   const key=randomUUID();await f.pg.exec(`CREATE FUNCTION platform_private.synthetic_skip_plan_effect() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF ${condition} THEN RETURN NULL;END IF;RETURN NEW;END $$;CREATE TRIGGER synthetic_skip BEFORE INSERT ON platform_private.${table} FOR EACH ROW EXECUTE FUNCTION platform_private.synthetic_skip_plan_effect()`);
   const before=(await f.pg.query('SELECT * FROM platform_private.subscription_plans ORDER BY id')).rows;const result=await f.create(key);assert.equal(result.response.status,503,JSON.stringify(result.body));assert.deepEqual((await f.pg.query('SELECT * FROM platform_private.subscription_plans ORDER BY id')).rows,before);assert.equal((await f.pg.query('SELECT * FROM platform_private.request_receipts WHERE request_key=$1',[key])).rows.length,0);
   await f.pg.exec(`DROP TRIGGER synthetic_skip ON platform_private.${table};DROP FUNCTION platform_private.synthetic_skip_plan_effect()`);assert.equal((await f.create(key)).response.status,201);
  }
 }finally{await f.pg.close();}
});
test('platform plans brief native concurrent retry and edit checks create one edition per winning request',{skip:!process.env.TEST_DATABASE_URL},async()=>{
 const f=await fixture();try{const start=performance.now(),key=randomUUID(),[a,b]=await Promise.all([f.create(key),f.create(key)]);assert.equal(a.response.status,201);assert.deepEqual(a.body,b.body);const id=a.body.data.id;
  const [x,y]=await Promise.all([f.request('plans/'+id+'/change',{expectedVersion:1,definition:{...definition,name:'Synthetic winner A'},reason:'Synthetic concurrent change A'}),f.request('plans/'+id+'/change',{expectedVersion:1,definition:{...definition,name:'Synthetic winner B'},reason:'Synthetic concurrent change B'})]);assert.deepEqual([x.response.status,y.response.status].sort(),[200,409]);assert.equal((await f.pg.query('SELECT * FROM platform_private.subscription_plan_editions WHERE plan_id=$1',[id])).rows.length,2);console.info('Platform catalogue concurrent retry/edit check ms:',Math.round(performance.now()-start));
 }finally{await f.pg.close();}
});
test('actual 308 platform upgrade preserves every original school field, identities and gateway identity and permissions',async()=>{
 const f=await fixture({throughSchema:308});try{
  const schools=(await f.pg.query('SELECT * FROM public.academies ORDER BY id')).rows,users=(await f.pg.query('SELECT * FROM identity."user" ORDER BY id')).rows,gateway=(await f.pg.query("SELECT oid,proowner,proacl FROM pg_proc WHERE oid='platform_private.request(uuid,uuid,text,uuid,jsonb)'::regprocedure")).rows;
  await upgradeToCurrent(f.pg);const after=(await f.pg.query('SELECT * FROM public.academies ORDER BY id')).rows;assert.ok(after.every(r=>r.subscription_version===0&&r.subscription_terms===null));assert.deepEqual(after.map(({subscription_version,subscription_terms,...r})=>r),schools);assert.deepEqual((await f.pg.query('SELECT * FROM identity."user" ORDER BY id')).rows,users);assert.deepEqual((await f.pg.query("SELECT oid,proowner,proacl FROM pg_proc WHERE oid='platform_private.request(uuid,uuid,text,uuid,jsonb)'::regprocedure")).rows,gateway);assert.equal((await f.create()).response.status,201);
 }finally{await f.pg.close();}
});

test('school subscriptions pin free/current editions and expire to real read-only web and native identity access without changing operational status',async()=>{
 const f=await fixture();try{
  const created=await f.create(),plan=created.body.data.id,path='academies/'+f.a+'/subscription',start=instant(-10),input={expectedVersion:0,planId:plan,planVersion:1,startsAt:start,expiresAt:null,reason:'Synthetic free Kavosh-equivalent licence'},key=randomUUID();
  const assigned=await f.request(path+'/assign',input,'master',key);assert.equal(assigned.response.status,200,JSON.stringify(assigned.body));assert.equal(assigned.body.chargesPerformed,false);assert.equal(assigned.body.paymentVerified,false);assert.deepEqual((await f.request(path+'/assign',input,'master',key)).body,assigned.body);assert.equal((await f.request(path)).body.data.subscriptionState,'free');assert.equal((await f.schoolRequest('people')).response.status,200);
  const paid={...definition,amountMinor:'5000',graceDays:3};assert.equal((await f.request('plans/'+plan+'/change',{expectedVersion:1,definition:paid,reason:'Synthetic new price'})).response.status,200);assert.equal((await f.request(path)).body.data.terms.planVersion,1);assert.equal((await f.request(path)).body.data.terms.graceDays,30);
  assert.equal((await f.request(path+'/assign',{...input,expectedVersion:1,expiresAt:instant(10)})).response.status,409);
  assert.equal((await f.request(path+'/assign',{...input,expectedVersion:1,planVersion:2})).response.status,400);
  assert.equal((await f.request(path+'/assign',{...input,expectedVersion:1,planVersion:2,expiresAt:instant(-5)})).response.status,200);
  const view=(await f.request(path)).body.data;assert.equal(view.subscriptionState,'expired');assert.equal(view.operationalStatus,'active');assert.equal(view.effectiveStatus,'read_only');
  const directory=(await f.request('academies')).body.data.find((s:any)=>s.id===f.a);assert.equal(directory.subscriptionVersion,2);assert.equal(directory.subscriptionState,'expired');assert.equal(directory.effectiveStatus,'read_only');assert.equal(directory.status,'active');
  assert.equal((await f.schoolRequest('people')).response.status,200);assert.equal((await f.schoolRequest('roles',f.roleInput)).response.status,403);assert.equal((await f.schoolRequest('roles',f.roleInput,'bot')).response.status,403);
  assert.equal((await f.schoolRequest('me/notification-preferences/disable',{expectedVersion:0})).response.status,201);
  const memberships=(await f.pg.query<any>('SELECT * FROM identity.memberships($1)',[f.owner.user])).rows;assert.equal(memberships.find(r=>r.academy_id===f.a)?.status,'read_only');
  await f.pg.query("SELECT set_config('app.academy_id',$1,false)",[f.a]);await f.pg.exec('SET ROLE kavosh_runtime');try{assert.equal((await f.pg.query<any>('SELECT public.human_invitation_basis($1) b',[f.owner.person])).rows[0].b.schoolStatus,'read_only');assert.equal((await f.pg.query('SELECT * FROM public.academies WHERE id=$1',[f.b])).rows.length,0);await assert.rejects(f.pg.query('UPDATE public.academies SET subscription_terms=NULL WHERE id=$1',[f.a]),/permission denied/);}finally{await f.pg.exec('RESET ROLE');}
  assert.equal((await f.request(path+'/history?limit=1')).body.data[0].version,2);assert.equal((await f.request(path+'/history?limit=1&beforeVersion=2')).body.data[0].version,1);
  assert.equal((await f.request('academies/'+f.b+'/subscription')).body.data.subscriptionState,'unassigned');assert.equal((await f.request(path,undefined,'foreignMaster')).response.status,403);
 }finally{await f.pg.close();}
});
test('school subscriptions distinguish scheduled grace and expired states and never override a manual read-only or suspended school',async()=>{
 const f=await fixture();try{
  const plan=(await f.create()).body.data.id,path='academies/'+f.a+'/subscription',base={planId:plan,planVersion:1,reason:'Synthetic explicit access term'},periods=[{startsAt:instant(1),expiresAt:instant(2),state:'scheduled'},{startsAt:instant(-10),expiresAt:instant(-1),state:'grace'},{startsAt:instant(-100),expiresAt:instant(-40),state:'expired'},{startsAt:instant(-1),expiresAt:instant(1),state:'active'}];
  for(const [i,p] of periods.entries()){const r=await f.request(path+'/assign',{...base,expectedVersion:i,startsAt:p.startsAt,expiresAt:p.expiresAt});assert.equal(r.response.status,200,JSON.stringify(r.body));const view=(await f.request(path)).body.data;assert.equal(view.subscriptionState,p.state);assert.equal(view.effectiveStatus,p.state==='active'?'active':'read_only');}
  const manual=await f.request('academies/'+f.a+'/change',{expectedVersion:1,status:'suspended',reason:'Synthetic owner safety suspension'});assert.equal(manual.response.status,200);assert.equal((await f.request(path+'/assign',{...base,expectedVersion:4,startsAt:instant(-2),expiresAt:null})).response.status,200);assert.equal((await f.request(path)).body.data.effectiveStatus,'suspended');assert.equal((await f.schoolRequest('people')).response.status,403);
  await assert.rejects(f.pg.exec('UPDATE platform_private.school_subscription_editions SET terms=terms'),/PLATFORM_HISTORY_IMMUTABLE/);
 }finally{await f.pg.close();}
});
test('school subscription missing edition rolls back access terms audit and receipt together; strict native input and owner verification remain required',async()=>{
 const f=await fixture();try{
  const plan=(await f.create()).body.data.id,path='academies/'+f.a+'/subscription/assign',input={expectedVersion:0,planId:plan,planVersion:1,startsAt:instant(-1),expiresAt:null,reason:'Synthetic failure recovery'},key=randomUUID();
  await f.pg.exec('CREATE FUNCTION platform_private.skip_school_edition() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL;END $$;CREATE TRIGGER synthetic_skip BEFORE INSERT ON platform_private.school_subscription_editions FOR EACH ROW EXECUTE FUNCTION platform_private.skip_school_edition()');assert.equal((await f.request(path,input,'master',key)).response.status,503);assert.equal((await f.request('academies/'+f.a+'/subscription')).body.data.version,0);assert.equal((await f.pg.query('SELECT * FROM platform_private.request_receipts WHERE request_key=$1',[key])).rows.length,0);assert.equal((await f.pg.query('SELECT * FROM platform_private.audit_events WHERE request_key=$1',[key])).rows.length,0);
  await f.pg.exec('DROP TRIGGER synthetic_skip ON platform_private.school_subscription_editions');assert.equal((await f.request(path,input,'master',key)).response.status,200);
  for(const patch of [{amountMinor:'0'},{graceDays:1000},{expectedVersion:-1},{expiresAt:'2026-02-31T00:00:00.000Z'},{expiresAt:instant(-2)},{planVersion:0}])assert.equal((await f.request(path,{...input,expectedVersion:1,...patch})).response.status,400);
  await f.pg.query('UPDATE identity.session SET "mfaVerified"=false WHERE id=$1',[f.owner.session]);assert.equal((await f.request(path,input,'master',key)).response.status,403);
 }finally{await f.pg.close();}
});
test('native school assignment fences a queued web mutation before its status decision and concurrent replacements retain one winner',{skip:!process.env.TEST_DATABASE_URL},async()=>{
 const f=await fixture(),blocker=await f.pg.runtime!.connect();let blocked=false,assign:ReturnType<typeof f.request>|undefined,write:ReturnType<typeof f.schoolRequest>|undefined;try{
  const plan=(await f.create()).body.data.id,path='academies/'+f.a+'/subscription/assign',input={expectedVersion:0,planId:plan,planVersion:1,startsAt:instant(-100),expiresAt:instant(-40),reason:'Synthetic queued expiry'},start=performance.now();
  await blocker.query('BEGIN');blocked=true;await blocker.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1,310))',[f.a]);
  async function waiting(fragment:string){for(let i=0;i<50;i++){const r=await f.pg.query<any>("SELECT count(*)::integer n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND wait_event='advisory' AND query LIKE $1",['%'+fragment+'%']);if(r.rows[0].n>0)return;await new Promise(r=>setTimeout(r,10));}assert.fail('Expected native advisory wait was not observed: '+fragment);}
  assign=f.request(path,input);await waiting('platform_private.request($1,$2');write=f.schoolRequest('roles',f.roleInput);await waiting('hashtextextended($1,310)');await blocker.query('COMMIT');blocked=false;
  assert.equal((await assign).response.status,200);assert.equal((await write).response.status,403);assert.equal((await f.pg.query('SELECT * FROM public.roles WHERE name=$1',[f.roleInput.name])).rows.length,0);
  const [a,b]=await Promise.all([f.request(path,{...input,expectedVersion:1,startsAt:instant(-1),expiresAt:null,reason:'Synthetic free renewal A'}),f.request(path,{...input,expectedVersion:1,startsAt:instant(-2),expiresAt:null,reason:'Synthetic free renewal B'})]);assert.deepEqual([a.response.status,b.response.status].sort(),[200,409]);assert.equal((await f.pg.query('SELECT * FROM platform_private.school_subscription_editions WHERE academy_id=$1',[f.a])).rows.length,2);console.info('School subscription fencing and replacement check ms:',Math.round(performance.now()-start));
 }finally{if(blocked)await blocker.query('ROLLBACK');await Promise.allSettled([assign,write].filter(Boolean));blocker.release();await f.pg.close();}
});
test('actual 309 to310 upgrade retains paid/free catalogue history,original school fields and all rewritten broker identities and grants',async()=>{
 const f=await fixture({throughSchema:309});try{
  const plan=(await f.pg.query<any>('SELECT platform_private.request($1,$2,$3,$4,$5::jsonb) r',[f.owner.user,f.owner.session,'plans.create',randomUUID(),JSON.stringify({definition,reason:'Synthetic retained plan'})])).rows[0].r.body.data;
  const schools=(await f.pg.query('SELECT * FROM public.academies ORDER BY id')).rows,editions=(await f.pg.query('SELECT * FROM platform_private.subscription_plan_editions ORDER BY plan_id,version')).rows;
  const sql="SELECT oid,proowner,proacl,prosecdef,proconfig,provolatile FROM pg_proc WHERE oid=ANY(ARRAY['platform_private.request(uuid,uuid,text,uuid,jsonb)'::regprocedure,'identity.accept_invite(text,uuid,uuid)'::regprocedure,'identity.memberships(uuid)'::regprocedure,'public.payment_checkout_live_source(uuid)'::regprocedure,'public.notification_delivery_preference(uuid)'::regprocedure,'public.human_invitation_basis(uuid)'::regprocedure,'public.session_reminder_guard()'::regprocedure]) ORDER BY oid",identities=(await f.pg.query(sql)).rows;
  await upgradeToCurrent(f.pg);assert.deepEqual((await f.pg.query(sql)).rows,identities);assert.deepEqual((await f.pg.query('SELECT * FROM platform_private.subscription_plan_editions ORDER BY plan_id,version')).rows,editions);
  const after=(await f.pg.query('SELECT * FROM public.academies ORDER BY id')).rows;assert.ok(after.every(r=>r.subscription_version===0&&r.subscription_terms===null));assert.deepEqual(after.map(({subscription_version,subscription_terms,...r})=>r),schools);assert.deepEqual((await f.request('plans/'+plan.id)).body.data.definition,definition);assert.equal((await f.request('academies/'+f.a+'/subscription')).body.data.subscriptionState,'unassigned');assert.equal((await f.schoolRequest('people')).response.status,200);
 }finally{await f.pg.close();}
});
test('explicit primary free binding survives renaming and plan edits while blocking paid expiring or future-start assignments without charges',async()=>{
 const f=await fixture();try{
  const plan=(await f.create()).body.data.id,base='academies/'+f.a+'/subscription',input={expectedVersion:0,planId:plan,planVersion:1,startsAt:instant(-1),expiresAt:null,reason:'Synthetic permanent free source'};
  assert.equal((await f.request(base+'/free-exemption')).body.data.permanent,false);assert.equal((await f.request(base+'/assign',input)).response.status,200);
  const bind={expectedVersion:1,confirmAcademyId:f.a,permanent:true,reason:'Synthetic explicit Kavosh-equivalent identity confirmation'},key=randomUUID();assert.equal((await f.request(base+'/free-exemption',{...bind,confirmAcademyId:f.b})).response.status,400);
  const bound=await f.request(base+'/free-exemption',bind,'master',key);assert.equal(bound.response.status,200,JSON.stringify(bound.body));assert.equal(bound.body.chargesPerformed,false);assert.deepEqual((await f.request(base+'/free-exemption',bind,'master',key)).body,bound.body);assert.equal((await f.request(base)).body.data.permanentFree,true);assert.equal((await f.request('academies')).body.data.find((a:any)=>a.id===f.a).permanentFree,true);
  assert.equal((await f.request('academies/'+f.a+'/change',{expectedVersion:1,name:'Renamed synthetic school',reason:'Synthetic branding change'})).response.status,200);assert.equal((await f.request(base+'/free-exemption')).body.data.academyId,f.a);
  const paid={...definition,amountMinor:'9000'};assert.equal((await f.request('plans/'+plan+'/change',{expectedVersion:1,definition:paid,reason:'Synthetic catalogue repricing'})).response.status,200);
  const deniedKey=randomUUID(),denied=await f.request(base+'/assign',{...input,expectedVersion:1,planVersion:2,expiresAt:instant(30)},'master',deniedKey);assert.equal(denied.response.status,409,JSON.stringify(denied.body));assert.equal(denied.body.error.code,'PLATFORM_FREE_ACADEMY_PROTECTED');assert.equal((await f.pg.query('SELECT * FROM platform_private.request_receipts WHERE request_key=$1',[deniedKey])).rows.length,0);assert.equal((await f.pg.query('SELECT * FROM platform_private.audit_events WHERE request_key=$1',[deniedKey])).rows.length,0);
  assert.equal((await f.request('academies/'+f.b+'/subscription/assign',{...input,planVersion:2,expiresAt:instant(30)})).response.status,200);
  assert.equal((await f.request('plans/'+plan+'/change',{expectedVersion:2,definition:{...definition,name:'New free edition'},reason:'Synthetic free upgrade'})).response.status,200);
  for(const patch of [{expiresAt:instant(1)},{startsAt:instant(1)}]){const r=await f.request(base+'/assign',{...input,expectedVersion:1,planVersion:3,...patch});assert.equal(r.response.status,409,JSON.stringify(r.body));}
  assert.equal((await f.request(base+'/assign',{...input,expectedVersion:1,planVersion:3})).response.status,200);assert.equal((await f.request(base+'/free-exemption')).body.data.subscriptionVersion,1);assert.equal((await f.request(base)).body.data.version,2);
  assert.equal((await f.request('academies/'+f.a+'/change',{expectedVersion:2,status:'suspended',reason:'Synthetic safety suspension'})).response.status,200);assert.equal((await f.request(base)).body.data.effectiveStatus,'suspended');assert.equal((await f.request(base+'/free-exemption')).body.data.permanent,true);
 }finally{await f.pg.close();}
});
test('primary free registration requires exact current non-expiring free terms,current owner verification and a single immutable school identity',async()=>{
 const f=await fixture();try{
  const plan=(await f.create()).body.data.id,base='academies/'+f.a+'/subscription',bind={expectedVersion:1,confirmAcademyId:f.a,permanent:true,reason:'Synthetic protected free registration'};assert.equal((await f.request(base+'/free-exemption',{...bind,expectedVersion:0})).response.status,400);
  assert.equal((await f.request(base+'/assign',{expectedVersion:0,planId:plan,planVersion:1,startsAt:instant(-1),expiresAt:instant(30),reason:'Synthetic expiring free term'})).response.status,200);assert.equal((await f.request(base+'/free-exemption',bind)).response.status,409);
  assert.equal((await f.request(base+'/assign',{expectedVersion:1,planId:plan,planVersion:1,startsAt:instant(-1),expiresAt:null,reason:'Synthetic permanent term'})).response.status,200);assert.equal((await f.request(base+'/free-exemption',bind)).response.status,409);assert.equal((await f.request(base+'/free-exemption',{...bind,expectedVersion:2},'foreignMaster')).response.status,403);
  const key=randomUUID(),bound=await f.request(base+'/free-exemption',{...bind,expectedVersion:2},'master',key);assert.equal(bound.response.status,200);assert.equal((await f.request(base+'/free-exemption',{...bind,expectedVersion:2})).response.status,409);
  await assert.rejects(f.pg.exec('UPDATE platform_private.primary_free_academy SET academy_id=academy_id'),/PLATFORM_HISTORY_IMMUTABLE/);await assert.rejects(f.pg.exec('DELETE FROM platform_private.primary_free_academy'),/PLATFORM_HISTORY_IMMUTABLE/);
  await f.pg.exec('SET ROLE kavosh_platform_service');try{await assert.rejects(f.pg.query('SELECT * FROM platform_private.primary_free_academy'),/permission denied/);await assert.rejects(f.pg.query('SELECT platform_private.free_academy_request($1,$2,$3,$4,$5::jsonb)',[f.owner.user,f.owner.session,'subscriptions.free-exemption.bind',randomUUID(),JSON.stringify({...bind,academyId:f.a,expectedVersion:2})]),/permission denied/);}finally{await f.pg.exec('RESET ROLE');}
  await f.pg.query('UPDATE identity.session SET "mfaVerified"=false WHERE id=$1',[f.owner.session]);assert.equal((await f.request(base+'/free-exemption',{...bind,expectedVersion:2},'master',key)).response.status,403);
 }finally{await f.pg.close();}
});
test('missing primary-free audit receipt or binding cannot commit a false successful protection and exact retry works after repair',async()=>{
 const f=await fixture();try{
  const plan=(await f.create()).body.data.id,base='academies/'+f.a+'/subscription',input={expectedVersion:1,confirmAcademyId:f.a,permanent:true,reason:'Synthetic protected registration rollback'};assert.equal((await f.request(base+'/assign',{expectedVersion:0,planId:plan,planVersion:1,startsAt:instant(-1),expiresAt:null,reason:'Synthetic source'})).response.status,200);
  let key=randomUUID();for(const [table,condition]of[['audit_events',"NEW.action='platform.subscription.free-exemption.bound'"],['request_receipts',"NEW.result#>>'{body,data,paidAssignmentBlocked}'='true'"],['primary_free_academy','true']] as const){key=randomUUID();await f.pg.exec(`CREATE FUNCTION platform_private.skip_free_effect() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF ${condition} THEN RETURN NULL;END IF;RETURN NEW;END $$;CREATE TRIGGER synthetic_skip BEFORE INSERT ON platform_private.${table} FOR EACH ROW EXECUTE FUNCTION platform_private.skip_free_effect()`);const r=await f.request(base+'/free-exemption',input,'master',key);assert.equal(r.response.status,503,JSON.stringify(r.body));assert.equal((await f.pg.query('SELECT * FROM platform_private.primary_free_academy')).rows.length,0);assert.equal((await f.pg.query('SELECT * FROM platform_private.request_receipts WHERE request_key=$1',[key])).rows.length,0);assert.equal((await f.pg.query('SELECT * FROM platform_private.audit_events WHERE request_key=$1',[key])).rows.length,0);await f.pg.exec(`DROP TRIGGER synthetic_skip ON platform_private.${table};DROP FUNCTION platform_private.skip_free_effect()`);}
  assert.equal((await f.request(base+'/free-exemption',input,'master',key)).response.status,200);
 }finally{await f.pg.close();}
});
test('two brief native primary-school confirmations cannot bind the exemption to two schools',{skip:!process.env.TEST_DATABASE_URL},async()=>{
 const f=await fixture();try{
  const plan=(await f.create()).body.data.id;for(const academy of[f.a,f.b])assert.equal((await f.request('academies/'+academy+'/subscription/assign',{expectedVersion:0,planId:plan,planVersion:1,startsAt:instant(-1),expiresAt:null,reason:'Synthetic free candidate'})).response.status,200);
  const start=performance.now(),results=await Promise.all([f.a,f.b].map(academy=>f.request('academies/'+academy+'/subscription/free-exemption',{expectedVersion:1,confirmAcademyId:academy,permanent:true,reason:'Synthetic concurrent explicit confirmation'})));assert.deepEqual(results.map(r=>r.response.status).sort(),[200,409]);const rows=(await f.pg.query('SELECT * FROM platform_private.primary_free_academy')).rows;assert.equal(rows.length,1);assert.equal(rows[0].academy_id,results.find(r=>r.response.status===200)!.body.data.academyId);console.info('Primary free-school confirmation check ms:',Math.round(performance.now()-start));
 }finally{await f.pg.close();}
});
test('actual 310 to311 upgrade preserves licence history and broker authority without guessing the primary academy from its name',async()=>{
 const f=await fixture({throughSchema:310});try{
  const native=async(operation:string,input:unknown)=>(await f.pg.query<any>('SELECT platform_private.request($1,$2,$3,$4,$5::jsonb) r',[f.owner.user,f.owner.session,operation,randomUUID(),JSON.stringify(input)])).rows[0].r;
  const plan=await native('plans.create',{definition,reason:'Synthetic retained zero price'});await native('subscriptions.assign',{academyId:f.a,expectedVersion:0,planId:plan.body.data.id,planVersion:1,startsAt:instant(-1),expiresAt:null,reason:'Synthetic existing licence'});await f.pg.query('UPDATE public.academies SET name=$1 WHERE id=$2',['Kavosh',f.a]);
  const tables=['public.academies','platform_private.school_subscription_editions','platform_private.subscription_plan_editions','platform_private.audit_events','platform_private.request_receipts'],snapshot=async()=>{const rows=[];for(const t of tables)rows.push((await f.pg.query('SELECT to_jsonb(x) r FROM '+t+' x ORDER BY to_jsonb(x)::text')).rows);return rows;},before=await snapshot();
  const sql="SELECT oid,proowner,proacl,prosecdef,proconfig,provolatile FROM pg_proc WHERE oid=ANY(ARRAY['platform_private.request(uuid,uuid,text,uuid,jsonb)'::regprocedure,'platform_private.subscription_request(uuid,uuid,text,uuid,jsonb)'::regprocedure]) ORDER BY oid",identity=(await f.pg.query(sql)).rows;
  await upgradeToCurrent(f.pg);assert.deepEqual(await snapshot(),before);assert.deepEqual((await f.pg.query(sql)).rows,identity);assert.equal((await f.pg.query('SELECT * FROM platform_private.primary_free_academy')).rows.length,0);
  const base='academies/'+f.a+'/subscription';assert.equal((await f.request(base)).body.data.permanentFree,false);assert.equal((await f.request(base+'/free-exemption')).body.data.permanent,false);assert.equal((await f.request(base+'/free-exemption',{expectedVersion:1,confirmAcademyId:f.a,permanent:true,reason:'Synthetic explicit post-upgrade binding'})).response.status,200);
 }finally{await f.pg.close();}
});
