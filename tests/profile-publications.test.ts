import assert from 'node:assert/strict';
import { randomBytes,randomUUID,createHmac } from 'node:crypto';
import pg from 'pg';
import test from 'node:test';
import { operationsFixture } from './operations-fixture.ts';
import { createPublicProfileApi,assertPublicProfileRole } from '../src/profiles/public-api.ts';
import { assertRuntimeRole,type Database } from '../src/core/database.ts';
import { upgradeToCurrent } from './migration-upgrade.ts';
import { profileShareAlias } from '../src/profiles/share-id.ts';

const definition={content:{en:{displayName:'Synthetic public hub',headline:'Robotics courses',bio:'Approved organization overview'},fr:{displayName:'Centre robotique'},'zh-CN':{displayName:'机器人学院'}},links:{github:'https://github.com/kavosh-ai'},archived:false};
test('actual345to346 preserves student and organization dependencies,publication authority and credential ceilings without granting worker roles',async()=>{
 const f=await fixture(345);try{
  const organization=await f.create(),student=f.actors.peer.person;assert.equal((await f.request('students',{personId:student,legalName:'PRIVATE canonical student',dateOfBirth:'2000-03-20',recruiter:{kind:'academy'}})).response.status,201);const personal=await f.create({kind:'person',id:student});assert.equal(personal.response.status,201);await f.pg.query("SELECT set_config('app.academy_id',$1,false)",[f.a]);
  const sources=()=>f.pg.query("SELECT public.profile_publication_basis($1,'public') organization,public.profile_publication_basis($2,'members') student",[organization.body.data.id,personal.body.data.id]),functions="SELECT oid,proowner,proacl,proconfig,prosecdef,provolatile FROM pg_proc WHERE oid IN('public.profile_publication_basis(uuid,text)'::regprocedure,'public.guard_profile_publication()'::regprocedure,'public.complete_profile_publication()'::regprocedure,'public.profile_publication_effect_required()'::regprocedure,'public.published_profile_projection(uuid,text)'::regprocedure) ORDER BY oid",before=(await sources()).rows,security=(await f.pg.query(functions)).rows,credentials=(await f.pg.query('SELECT id,capabilities FROM auth_private.credentials ORDER BY id')).rows,roles=(await f.pg.query('SELECT * FROM public.role_permissions ORDER BY role_id,capability')).rows;
  await upgradeToCurrent(f.pg);assert.deepEqual((await sources()).rows,before);assert.deepEqual((await f.pg.query(functions)).rows,security);assert.deepEqual((await f.pg.query('SELECT id,capabilities FROM auth_private.credentials ORDER BY id')).rows,credentials);assert.deepEqual((await f.pg.query('SELECT * FROM public.role_permissions ORDER BY role_id,capability')).rows,roles);assert.equal((await f.pg.query('SELECT * FROM public.profile_publication_changes')).rows.length,0);assert.equal((await f.pg.query("SELECT * FROM public.role_permissions WHERE capability IN('worker-profiles.view','worker-profiles.publish')")).rows.length,0);
  assert.equal((await f.publish(organization.body.data.id)).response.status,200);assert.equal((await f.publish(personal.body.data.id)).body.error.code,'STUDENT_PROFILE_CONSENT_REQUIRED');
 }finally{await f.pg.close();}
});
test('short sharing IDs reuse the exact public/member gates and one persistent anonymous read budget',async()=>{
 const f=await fixture();try{
  const draft=await f.create(),sharing=await f.publish(draft.body.data.id),id=sharing.body.data.publicId,short=profileShareAlias(id);assert.equal(sharing.body.data.shortSharePath,'/api/public/v1/profiles/'+short);const plain=await f.publicRead(id),compressed=await f.publicRead(short);assert.equal(compressed.response.status,200,JSON.stringify(compressed.body));assert.deepEqual(compressed.body,plain.body);assert.equal(compressed.body.data.id,id);assert.equal((await f.publicRead(profileShareAlias(draft.body.data.id))).response.status,404);assert.equal((await f.publicRead(short.slice(0,-1)+'B')).response.status,400);
  await f.pg.query("INSERT INTO public.role_permissions VALUES($1,$2,'published-profiles.view','allow')",[f.a,f.staffRole]);const member=await f.request('community/published-profiles/'+short,undefined,'staff');assert.equal(member.response.status,200,JSON.stringify(member.body));assert.equal(member.body.data.id,id);assert.equal((await f.request('community/published-profiles/'+short,undefined,'foreignMaster',{academy:f.b})).response.status,404);assert.equal((await f.request('community/published-profiles/'+short,undefined,'bot')).response.status,403);const list=await f.request('community/published-profiles',undefined,'staff');assert.equal(list.body.data[0].shortRecordPath,'/api/v1/community/published-profiles/'+short);
  const budget=createHmac('sha256',f.budgetSecret).update('public-profile-ip:v1:127.0.0.1').digest('hex');await f.pg.query("UPDATE public.profile_public_rate_windows SET used=120,started_at=date_trunc('minute',clock_timestamp())+interval '1 minute' WHERE key=$1",[budget]);assert.equal((await f.publicRead(short)).response.status,429);assert.equal((await f.publicRead(id)).response.status,429);await f.publish(draft.body.data.id,1,1,'unpublished');assert.equal((await f.request('community/published-profiles/'+short,undefined,'staff')).response.status,404);
 }finally{await f.pg.close();}
});
async function fixture(throughSchema?:number){const f=await operationsFixture({throughSchema});try{
 for(const role of [f.managerRole,f.staffRole])for(const cap of ['profiles.view','profiles.edit','profiles.publish'])if(throughSchema===undefined||cap!=='profiles.publish')await f.pg.query("INSERT INTO public.role_permissions VALUES($1,$2,$3,'allow')",[f.a,role,cap]);
 const budgetSecret=randomBytes(32).toString('hex'),database:Database={async connect(){if(f.pg.runtime){const c=await f.pg.runtime.connect();await c.query('SET ROLE kavosh_public_profile_service');return c;}await f.pg.exec('SET ROLE kavosh_public_profile_service');return{query:<Row>(sql:string,args?:unknown[])=>f.pg.query<Row>(sql,args),release(){}};}},api=createPublicProfileApi(database,{enabled:true,production:false,budgetSecret});
 async function publicRead(id:string,query=''){try{const response=await api(new Request('https://academy.example/api/public/v1/profiles/'+id+query),id);return{response,body:await response.json()};}finally{if(!f.pg.runtime)await f.pg.exec('RESET ROLE');}}
 const create=(anchor:unknown={kind:'hub',id:f.hub},as='master')=>f.request('community/profiles',{anchor,definition,reason:'PRIVATE authoring reason'},as),publish=(id:string,expectedVersion=0,expectedProfileVersion=1,audience='public',as='master',key?:string)=>f.request('community/profiles/'+id+'/publication',{expectedVersion,expectedProfileVersion,audience,reason:'PRIVATE exact publication review'},as,{key});
 return{...f,publicRead,create,publish,budgetSecret,database};
 }catch(e){await f.pg.close();throw e;}}
test('organization publication requires exact review and public reads expose only approved localized text and links',async()=>{
 const f=await fixture();try{
  const created=await f.create();assert.equal(created.response.status,201,JSON.stringify(created.body));const id=created.body.data.id;assert.equal((await f.publicRead(id)).response.status,404);
  const key=randomUUID(),published=await f.publish(id,0,1,'public','master',key);assert.equal(published.response.status,200,JSON.stringify({body:published.body,failures:f.metrics.queryFailures}));assert.deepEqual((await f.publish(id,0,1,'public','master',key)).body,published.body);const publicId=published.body.data.publicId;assert.ok(publicId);assert.equal(published.body.data.sharePath,'/api/public/v1/profiles/'+publicId);
  const read=await f.publicRead(publicId);assert.equal(read.response.status,200,JSON.stringify(read.body));assert.equal(read.response.headers.get('cache-control'),'no-store');assert.equal(read.body.data.kind,'hub');assert.equal(read.body.data.content.en.displayName,definition.content.en.displayName);assert.equal(read.body.data.content.fr.displayName,definition.content.fr.displayName);assert.equal(read.body.data.content['zh-CN'].displayName,definition.content['zh-CN'].displayName);assert.equal(read.body.data.mediaIncluded,false);assert.equal(read.body.data.contentFormat,'plain_text');assert.doesNotMatch(JSON.stringify(read.body),/PRIVATE|changedBy|reason|approvalId|owner_snapshot|fileId|source_basis/);
  assert.equal((await f.publicRead(id)).response.status,404);assert.equal((await f.publish(id,1,1,'unpublished')).response.status,200);assert.equal((await f.publicRead(publicId)).response.status,404);assert.equal((await f.request('community/profiles/'+id+'/publication/history')).body.data.length,2);
 }finally{await f.pg.close();}
});
test('organization publication uses upper review,denies personal profiles and invalidates unreviewed draft changes',async()=>{
 const f=await fixture();try{
  const created=await f.create(),id=created.body.data.id,pending=await f.publish(id,0,1,'public','staff');assert.equal(pending.response.status,202);assert.equal((await f.approve(pending.body.approval.id,'staff')).response.status,403);
  const applied=await f.approve(pending.body.approval.id,'manager');assert.equal(applied.response.status,200,JSON.stringify(applied.body));const publicId=applied.body.data.publicId;assert.equal((await f.publicRead(publicId)).response.status,200);
  assert.equal((await f.request('community/profiles/'+id+'/change',{expectedVersion:1,definition:{...definition,content:{en:{displayName:'UNREVIEWED draft'}}},reason:'PRIVATE edit before publishing'})).response.status,200);assert.equal((await f.publicRead(publicId)).response.status,404);assert.equal((await f.publish(id,1,1)).response.status,409);assert.equal((await f.publish(id,1,2)).response.status,200);assert.equal((await f.publicRead(publicId)).body.data.content.en.displayName,'UNREVIEWED draft');
  const person=await f.create({kind:'person',id:f.actors.staff.person});assert.equal(person.response.status,201);const rejected=await f.publish(person.body.data.id);assert.equal(rejected.response.status,409);assert.equal(rejected.body.error.code,'WORKER_PROFILE_CONSENT_REQUIRED');assert.equal((await f.publicRead(person.body.data.id)).response.status,404);
 }finally{await f.pg.close();}
});
test('public organization reader hides restricted,inactive and other-school drafts without borrowing internal permissions',async()=>{
 const f=await fixture();try{
  const created=await f.create(),id=created.body.data.id,p=await f.publish(id),publicId=p.body.data.publicId;assert.equal(p.response.status,200,JSON.stringify(p.body));
  const foreign=await f.request('community/profiles/'+id+'/publication',undefined,'foreignMaster',{academy:f.b});assert.equal(foreign.response.status,404);
  const restriction=await f.request('community/profiles/'+id+'/moderation',{expectedVersion:0,expectedProfileVersion:1,restricted:true,reason:'PRIVATE safety restriction'});assert.equal(restriction.response.status,200);assert.equal((await f.publicRead(publicId)).response.status,404);
  assert.equal((await f.request('community/profiles/'+id+'/moderation',{expectedVersion:1,expectedProfileVersion:1,restricted:false,reason:'PRIVATE reviewed restoration'})).response.status,200);assert.equal((await f.publicRead(publicId)).response.status,200);
  await f.pg.query('UPDATE public.hubs SET active=false WHERE academy_id=$1 AND id=$2',[f.a,f.hub]);assert.equal((await f.publicRead(publicId)).response.status,404);
 }finally{await f.pg.close();}
});
test('public organization profile read budgets persist on404 and native quota exhaustion returns429',async()=>{
 const f=await fixture();try{
  assert.equal((await f.publicRead(randomUUID())).response.status,404);const budget=createHmac('sha256',f.budgetSecret).update('public-profile-ip:v1:127.0.0.1').digest('hex');await f.pg.query("UPDATE public.profile_public_rate_windows SET used=120,started_at=date_trunc('minute',clock_timestamp())+interval '1 minute' WHERE key=$1",[budget]);const limited=await f.publicRead(randomUUID());assert.equal(limited.response.status,429,'An earlier request/window must not reset a later exhausted budget');assert.equal(limited.response.headers.get('retry-after'),'60');
  await f.pg.exec('SET ROLE kavosh_public_profile_service');try{await assertPublicProfileRole({query:<Row>(sql:string,args?:unknown[])=>f.pg.query<Row>(sql,args),release(){}});await assert.rejects(f.pg.query('SELECT * FROM public.community_profiles'),/permission denied/);assert.equal((await f.pg.query<{member:boolean}>("SELECT pg_has_role(current_user,'kavosh_public_profile_policy','member') member")).rows[0].member,false);}finally{await f.pg.exec('RESET ROLE');}
  await f.pg.exec('GRANT kavosh_public_profile_policy TO kavosh_runtime');try{await f.pg.exec('SET ROLE kavosh_runtime');await assert.rejects(assertRuntimeRole({query:<Row>(sql:string,args?:unknown[])=>f.pg.query<Row>(sql,args),release(){}}),/UNSAFE_DATABASE_ROLE/);}finally{await f.pg.exec('RESET ROLE;REVOKE kavosh_public_profile_policy FROM kavosh_runtime');}
 }finally{await f.pg.close();}
});
test('actual public reader login cannot inspect drafts or assume the source policy role',{skip:!process.env.TEST_DATABASE_URL},async()=>{
 const f=await fixture(),role='kavosh_public_check_'+randomUUID().replaceAll('-',''),password=randomBytes(32).toString('hex');let client:pg.Client|undefined,created=false;
 try{
  const profile=await f.create(),published=await f.publish(profile.body.data.id),id=published.body.data.publicId;assert.equal(published.response.status,200);
  await f.pg.exec(`CREATE ROLE "${role}" LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '${password}';GRANT kavosh_public_profile_service TO "${role}"`);created=true;const url=new URL(process.env.TEST_DATABASE_URL!);url.pathname='/'+(await f.pg.query<{name:string}>('SELECT current_database() name')).rows[0].name;url.username=role;url.password=password;client=new pg.Client({connectionString:url.toString()});await client.connect();
  const connection={query:async<Row>(sql:string,args?:unknown[])=>({rows:(await client!.query(sql,args)).rows as Row[]}),release(){}},api=createPublicProfileApi({async connect(){return connection;}},{enabled:true,production:false,budgetSecret:f.budgetSecret}),read=()=>api(new Request('https://academy.example/api/public/v1/profiles/'+id),id);
  await assertPublicProfileRole(connection);assert.equal((await read()).status,200);await assert.rejects(client.query('SELECT * FROM public.community_profiles'),/permission denied/);await assert.rejects(client.query('SET ROLE kavosh_public_profile_policy'),/permission denied/);await assert.rejects(client.query('SELECT * FROM identity."user"'),/permission denied/);
  const personal=await f.create({kind:'person',id:f.actors.staff.person});assert.equal(personal.response.status,201);await f.pg.exec('BEGIN;SET LOCAL ROLE kavosh_public_profile_policy');try{await f.pg.query("SELECT set_config('app.academy_id',$1,true)",[f.a]);assert.equal((await f.pg.query('SELECT id,definition FROM public.community_profiles WHERE id=$1',[personal.body.data.id])).rows.length,0,'Restrictive source RLS must reject personal rows even with a tenant context');}finally{await f.pg.exec('ROLLBACK');}
  await f.pg.exec(`GRANT kavosh_public_profile_policy TO "${role}"`);try{assert.equal((await read()).status,503);}finally{await f.pg.exec(`REVOKE kavosh_public_profile_policy FROM "${role}"`);}assert.equal((await read()).status,200);
 }finally{await client?.end();if(created)await f.pg.exec(`DROP ROLE "${role}"`);await f.pg.close();}
});
test('public profile exposure stays disabled or rejects untrusted proxy configuration before any database connection',async()=>{
 let connects=0;const database:Database={async connect(){connects++;throw new Error('UNEXPECTED_CONNECTION');}},id=randomUUID(),request=new Request('https://academy.example/api/public/v1/profiles/'+id),budgetSecret=randomBytes(32).toString('hex'),edgeSecret=randomBytes(32).toString('hex');
 assert.equal((await createPublicProfileApi(database,{enabled:false,production:true})(request,id)).status,404);assert.equal((await createPublicProfileApi(database,{enabled:true,production:true,budgetSecret,edgeSecret})(request,id)).status,403);assert.equal((await createPublicProfileApi(database,{enabled:true,production:true,budgetSecret:edgeSecret,edgeSecret})(request,id)).status,503);assert.equal(connects,0);
});
test('public profile response boundary fails closed on an over-sharing native result',async()=>{
 const f=await fixture();try{
  await f.pg.exec("CREATE OR REPLACE FUNCTION public.read_published_organization_profile(p_profile uuid,p_budget text) RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$ SELECT jsonb_build_object('limited',false,'data',jsonb_build_object('privateNote','SYNTHETIC_PRIVATE_NOTE_MUST_NOT_ESCAPE')) $$");
  const r=await f.publicRead(randomUUID());assert.equal(r.response.status,503);assert.doesNotMatch(JSON.stringify(r.body),/SYNTHETIC_PRIVATE_NOTE|privateNote/);
 }finally{await f.pg.close();}
});
test('organization publication missing history,head,audit or event cannot commit and the exact request retries after repair',async()=>{
 for(const table of ['profile_publication_changes','profile_publication_heads','audit_events','outbox_events']){
  const f=await fixture();try{
   const profile=await f.create(),id=profile.body.data.id,key=randomUUID();assert.equal(profile.response.status,201);
   await f.pg.exec(`CREATE FUNCTION public.synthetic_skip_publication() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL;END $$;REVOKE ALL ON FUNCTION public.synthetic_skip_publication() FROM PUBLIC;CREATE TRIGGER synthetic_skip BEFORE INSERT ON public.${table} FOR EACH ROW EXECUTE FUNCTION public.synthetic_skip_publication()`);
   const failed=await f.publish(id,0,1,'public','master',key);assert.equal(failed.response.status,503,JSON.stringify(failed.body));assert.equal((await f.pg.query('SELECT * FROM public.profile_publication_heads WHERE profile_id=$1',[id])).rows.length,0);assert.equal((await f.pg.query('SELECT * FROM public.profile_publication_changes WHERE profile_id=$1',[id])).rows.length,0);
   await f.pg.exec(`DROP TRIGGER synthetic_skip ON public.${table};DROP FUNCTION public.synthetic_skip_publication()`);const repaired=await f.publish(id,0,1,'public','master',key);assert.equal(repaired.response.status,200,JSON.stringify(repaired.body));assert.equal((await f.publicRead(repaired.body.data.publicId)).response.status,200);
  }finally{await f.pg.close();}
 }
});
test('read-only school can withdraw public content but cannot publish another edition',async()=>{
 const f=await fixture();try{
  const profile=await f.create({kind:'academy'}),id=profile.body.data.id,published=await f.publish(id);assert.equal(published.response.status,200);assert.equal((await f.publicRead(published.body.data.publicId)).body.data.kind,'academy');
  await f.pg.query("UPDATE public.academies SET status='read_only' WHERE id=$1",[f.a]);assert.equal((await f.publish(id,1,1,'public')).response.status,403);const withdrawn=await f.publish(id,1,1,'unpublished');assert.equal(withdrawn.response.status,200,JSON.stringify(withdrawn.body));assert.equal((await f.publicRead(published.body.data.publicId)).response.status,404);
 }finally{await f.pg.close();}
});
test('brief native concurrent publication and draft edit never expose the unreviewed edition',{skip:!process.env.TEST_DATABASE_URL},async()=>{
 const f=await fixture();try{
  const profile=await f.create(),id=profile.body.data.id,start=performance.now(),[published,edited]=await Promise.all([f.publish(id),f.request('community/profiles/'+id+'/change',{expectedVersion:1,definition:{...definition,content:{en:{displayName:'Unreviewed concurrent edit'}}},reason:'Synthetic simultaneous draft edit'})]);assert.equal(edited.response.status,200,JSON.stringify(edited.body));assert.ok([200,409].includes(published.response.status),JSON.stringify(published.body));if(published.response.status===200)assert.equal((await f.publicRead(published.body.data.publicId)).response.status,404);assert.equal((await f.request('community/profiles/'+id)).body.data.version,2);console.info('Organization publication/edit race ms:',Math.round(performance.now()-start));
 }finally{await f.pg.close();}
});
test('actual318 organization publication upgrade preserves private drafts and existing credentials with no publication',async()=>{
 const f=await fixture(318);try{
  const created=await f.create(),id=created.body.data.id,profiles=(await f.pg.query('SELECT * FROM public.community_profiles')).rows,credentials=(await f.pg.query('SELECT id,capabilities FROM auth_private.credentials')).rows;
  await upgradeToCurrent(f.pg);assert.deepEqual((await f.pg.query('SELECT * FROM public.community_profiles')).rows,profiles);assert.deepEqual((await f.pg.query('SELECT id,capabilities FROM auth_private.credentials')).rows,credentials);assert.equal((await f.pg.query('SELECT * FROM public.profile_publication_heads')).rows.length,0);assert.equal((await f.publicRead(id)).response.status,404);assert.equal((await f.publish(id)).response.status,200);
 }finally{await f.pg.close();}
});
test('actual324 student publication upgrade preserves organization sources,function identities and credential ceilings',async()=>{
 const f=await fixture(324);try{
  const created=await f.create(),id=created.body.data.id;assert.equal(created.response.status,201,JSON.stringify(created.body));await f.pg.query("SELECT set_config('app.academy_id',$1,false)",[f.a]);
  const source=(await f.pg.query('SELECT public.profile_publication_basis($1) b',[id])).rows[0].b,functions="SELECT oid,proname,proowner,proacl FROM pg_proc WHERE oid IN('public.guard_profile_publication()'::regprocedure,'public.complete_profile_publication()'::regprocedure,'public.profile_publication_effect_required()'::regprocedure,'public.read_published_organization_profile(uuid,text)'::regprocedure) ORDER BY oid",before=(await f.pg.query(functions)).rows,credentials=(await f.pg.query('SELECT id,capabilities FROM auth_private.credentials ORDER BY id')).rows;
  await upgradeToCurrent(f.pg);assert.deepEqual((await f.pg.query(functions)).rows,before);assert.deepEqual((await f.pg.query('SELECT id,capabilities FROM auth_private.credentials ORDER BY id')).rows,credentials);assert.deepEqual((await f.pg.query('SELECT public.profile_publication_basis($1,$2) b',[id,'public'])).rows[0].b,source,'organization approval dependency bytes remain identical');assert.equal((await f.pg.query('SELECT * FROM public.profile_publication_heads')).rows.length,0);assert.equal((await f.publish(id)).response.status,200);
 }finally{await f.pg.close();}
});
