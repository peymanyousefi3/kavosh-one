import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { operationsFixture } from './operations-fixture.ts';
import { createPlatformApi } from '../src/platform/api.ts';
import { assertRuntimeRole,type Database } from '../src/core/database.ts';
import { assertFileWorkerRole } from '../src/files/inspection-worker.ts';
import { assertSignatureIngestRole } from '../src/integrations/boldsign-inbox.ts';
import { assertSignatureResultRole } from '../src/integrations/signature-result-worker.ts';

test('file and signature service boundaries reject accidental platform authority',async()=>{
 const f=await operationsFixture(),db={query:<Row>(sql:string,params?:unknown[])=>f.pg.query<Row>(sql,params),release(){}};
 try{
  for(const [role,check] of [['kavosh_file_worker',assertFileWorkerRole],['kavosh_signature_ingest',assertSignatureIngestRole],['kavosh_signature_result_worker',assertSignatureResultRole]] as const){
   await f.pg.exec('SET ROLE '+role);await check(db);await f.pg.exec('RESET ROLE');
   await f.pg.exec('GRANT kavosh_platform_service TO '+role);
   try{await f.pg.exec('SET ROLE '+role);await assert.rejects(check(db),/UNSAFE_/);}
   finally{await f.pg.exec('RESET ROLE');await f.pg.exec('REVOKE kavosh_platform_service FROM '+role);}
   await f.pg.exec('SET ROLE '+role);await check(db);await f.pg.exec('RESET ROLE');
  }
 }finally{await f.pg.exec('RESET ROLE');await f.pg.close();}
});

test('disabled platform API does not resolve credentials or connect to a database',async()=>{
 const api=createPlatformApi({async connect(){throw Error('MUST_NOT_CONNECT');}},async()=>{throw Error('MUST_NOT_AUTHENTICATE');});
 const response=await api(new Request('https://academy.example/api/platform/v1/academies'),'academies');
 assert.equal(response.status,404);assert.equal(response.headers.get('cache-control'),'no-store');
});

test('platform migration preserves existing school and identity data and owner enrollment requires verification',async()=>{
 const f=await operationsFixture({throughSchema:157});
 try{
  const before=(await f.pg.query('SELECT id,name,status,master_person_id,created_at FROM public.academies ORDER BY id')).rows;
  const people=(await f.pg.query('SELECT * FROM public.people ORDER BY academy_id,id')).rows;
  await f.pg.exec(await readFile(new URL('../db/migrations/158_platform_administration.sql',import.meta.url),'utf8'));
  assert.deepEqual((await f.pg.query('SELECT id,name,status,master_person_id,created_at FROM public.academies ORDER BY id')).rows,before);
  assert.deepEqual((await f.pg.query('SELECT * FROM public.people ORDER BY academy_id,id')).rows,people);
  assert.equal((await f.pg.query<{n:number}>('SELECT count(*)::integer AS n FROM platform_private.owner_registration')).rows[0].n,0);
  assert.ok((await f.pg.query<{platform_version:number}>('SELECT platform_version FROM public.academies')).rows.every(v=>v.platform_version===1));
  await assert.rejects(f.pg.query('SELECT platform_private.register_owner($1,$2)',[f.actors.staff.user,'Unverified owner enrollment']),/VERIFIED_MFA_OWNER_REQUIRED/);
  await f.pg.query('SELECT platform_private.register_owner($1,$2)',[f.actors.master.user,'Verified operator enrollment']);
  await f.pg.query('SELECT platform_private.register_owner($1,$2)',[f.actors.master.user,'Same owner retry']);
  assert.equal((await f.pg.query("SELECT * FROM platform_private.audit_events WHERE action='platform.owner.registered'")).rows.length,1);
  await assert.rejects(f.pg.query('UPDATE public.academies SET platform_version=500 WHERE id=$1',[f.a]),/PLATFORM_VERSION_SERVER_OWNED/);
  await assert.rejects(f.pg.query('UPDATE public.academies SET master_person_id=$1 WHERE id=$2',[f.actors.manager.person,f.a]));
 }finally{await f.pg.exec('RESET ROLE');await f.pg.close();}
});

test('platform audit failure rolls back provision and receipt; successful rate budget is bounded',async()=>{
 const f=await operationsFixture();
 try{
  const owner=f.actors.master,key=randomUUID(),input={name:'Must roll back',masterName:'Pending',masterEmail:'rollback@example.test',reason:'Atomicity test'};
  await f.pg.query('SELECT platform_private.register_owner($1,$2)',[owner.user,'Verified owner enrollment']);
  await f.pg.exec("CREATE FUNCTION platform_private.synthetic_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'SYNTHETIC_AUDIT_FAILURE';END $$; CREATE TRIGGER synthetic_audit_failure BEFORE INSERT ON platform_private.audit_events FOR EACH ROW EXECUTE FUNCTION platform_private.synthetic_audit_failure()");
  await f.pg.exec('SET ROLE kavosh_platform_service');
  await assert.rejects(f.pg.query('SELECT platform_private.request($1,$2,$3,$4,$5::jsonb)',[owner.user,owner.session,'academies.provision',key,JSON.stringify(input)]),/SYNTHETIC_AUDIT_FAILURE/);
  await f.pg.exec('RESET ROLE');
  assert.equal((await f.pg.query("SELECT * FROM public.academies WHERE name='Must roll back'")).rows.length,0);
  assert.equal((await f.pg.query('SELECT * FROM platform_private.request_receipts WHERE request_key=$1',[key])).rows.length,0);
  await f.pg.exec('DROP TRIGGER synthetic_audit_failure ON platform_private.audit_events; DROP FUNCTION platform_private.synthetic_audit_failure()');
  await f.pg.query("INSERT INTO platform_private.rate_windows VALUES($1,date_trunc('minute',clock_timestamp()),60)",[owner.user]);
  await f.pg.exec('SET ROLE kavosh_platform_service');
  assert.equal((await f.pg.query<{allowed:boolean}>('SELECT platform_private.consume_request_budget($1,$2) AS allowed',[owner.user,owner.session])).rows[0].allowed,false);
 }finally{await f.pg.exec('RESET ROLE');await f.pg.close();}
});

test('native simultaneous platform retries create one school and one immutable receipt',{skip:!process.env.TEST_DATABASE_URL},async()=>{
 const f=await operationsFixture();
 try{
  const owner=f.actors.master,key=randomUUID(),input={name:'Concurrent school',masterName:'Pending',masterEmail:'parallel@example.test',reason:'Concurrent retry'};
  await f.pg.query('SELECT platform_private.register_owner($1,$2)',[owner.user,'Verified owner enrollment']);
  async function invoke(){const db=await f.pg.runtime!.connect();try{await db.query('SET ROLE kavosh_platform_service');return(await db.query<{result:unknown}>('SELECT platform_private.request($1,$2,$3,$4,$5::jsonb) AS result',[owner.user,owner.session,'academies.provision',key,JSON.stringify(input)])).rows[0].result;}finally{db.release();}}
  const [a,b]=await Promise.all([invoke(),invoke()]);assert.deepEqual(a,b);
  assert.equal((await f.pg.query("SELECT * FROM public.academies WHERE name='Concurrent school'")).rows.length,1);
  assert.equal((await f.pg.query('SELECT * FROM platform_private.request_receipts WHERE request_key=$1',[key])).rows.length,1);
  assert.equal((await f.pg.query('SELECT * FROM platform_private.audit_events WHERE request_key=$1',[key])).rows.length,1);
 }finally{await f.pg.close();}
});

test('platform HTTP boundary checks current owner, version, strict input and school-role separation',async()=>{
 const f=await operationsFixture();
 try{
  const owner=f.actors.master;
  await f.pg.query('SELECT platform_private.register_owner($1,$2)',[owner.user,'Owner enrollment']);
  const database:Database={async connect(){
   if(f.pg.runtime){const db=await f.pg.runtime.connect();await db.query('SET ROLE kavosh_platform_service');return db;}
   await f.pg.exec('SET ROLE kavosh_platform_service');return{query:async<Row>(sql:string,params?:unknown[])=>f.pg.query<Row>(sql,params),release(){}};
  }};
  const api=createPlatformApi(database,async r=>{const actor=f.actors[r.headers.get('x-test-actor')??''];return actor?{userId:actor.user,sessionId:actor.session}:null;},true);
  async function request(path:string,body?:unknown,actor='master',key=randomUUID(),extra:Record<string,string>={}){
   try{const response=await api(new Request('https://academy.example/api/platform/v1/'+path,{method:body===undefined?'GET':'POST',headers:{'x-test-actor':actor,'idempotency-key':key,'content-type':'application/json',...extra},...(body===undefined?{}:{body:JSON.stringify(body)})}),path.split('?')[0]);return{response,body:await response.json()};}
   finally{if(!f.pg.runtime)await f.pg.exec('RESET ROLE');}
  }
  assert.equal((await request('academies',undefined,'')).response.status,401);
  assert.equal((await request('academies',undefined,'master',randomUUID(),{authorization:'Bearer fake'})).response.status,401);
  assert.equal((await request('academies',undefined,'foreignMaster')).response.status,403);
  assert.equal((await request('academies?limit=1&limit=2')).response.status,400);
  const listing=await request('academies?limit=1');assert.equal(listing.response.status,200,JSON.stringify(listing.body));assert.equal(listing.body.data.length,1);assert.ok(listing.body.nextCursor);
  const input={name:'API-created school',masterName:'New master',masterEmail:'api-master@example.test',reason:'Approved school'};
  const key=randomUUID(),created=await request('academies',input,'master',key);assert.equal(created.response.status,201,JSON.stringify(created.body));
  assert.deepEqual((await request('academies',input,'master',key)).body,created.body);
  assert.equal((await request('academies',{...input,masterPersonId:owner.person})).response.status,400);
  const school=created.body.data.id;
  const updated=await request('academies/'+school+'/change',{expectedVersion:1,name:'Renamed school',reason:'Correct name'});assert.equal(updated.response.status,200,JSON.stringify(updated.body));assert.equal(updated.body.data.version,2);
  const audit=await request('audit?limit=100');assert.equal(audit.response.status,200);const event=audit.body.data.find((r:{action:string;academy_id:string})=>r.action==='platform.academies.changed'&&r.academy_id===school);assert.equal(event.actor_user_id,owner.user);assert.equal(event.before_data.name,input.name);assert.equal(event.after_data.name,'Renamed school');assert.ok(event.request_key);assert.equal(Object.hasOwn(event,'session_id'),false);
  assert.equal((await request('academies/'+school+'/change',{expectedVersion:1,status:'suspended',reason:'Stale version'})).response.status,409);
  assert.equal((await request('academies/'+school+'/change',{expectedVersion:2,status:'active',reason:'Skip onboarding'})).response.status,409);
  const limited=await request('academies/'+f.a+'/change',{expectedVersion:1,status:'read_only',reason:'Pause school edits'});assert.equal(limited.response.status,200,JSON.stringify(limited.body));
  assert.equal((await f.request('hubs')).response.status,200);
  assert.equal((await f.request('hubs',{name:'Blocked write',city:'Toronto',countryCode:'CA'})).response.status,403);
  const resumed=await request('academies/'+f.a+'/change',{expectedVersion:2,status:'active',reason:'Resume school edits'});assert.equal(resumed.response.status,200,JSON.stringify(resumed.body));assert.equal(resumed.body.data.version,3);
  await f.pg.query('UPDATE identity.session SET "expiresAt"=now()-interval \'1 second\' WHERE id=$1',[owner.session]);
  assert.equal((await request('academies')).response.status,403);
  // A mistakenly combined deployment role must fail closed before school data.
  await f.pg.exec('GRANT kavosh_platform_service TO kavosh_runtime');
  try{const db=await (f.pg.runtime??{connect:async()=>{await f.pg.exec('SET ROLE kavosh_runtime');return{query:async<Row>(sql:string,params?:unknown[])=>f.pg.query<Row>(sql,params),release(){}};}}).connect();try{await assert.rejects(assertRuntimeRole(db),/UNSAFE_DATABASE_ROLE/);}finally{db.release();if(!f.pg.runtime)await f.pg.exec('RESET ROLE');}}
  finally{await f.pg.exec('REVOKE kavosh_platform_service FROM kavosh_runtime');}
 }finally{await f.pg.exec('RESET ROLE');await f.pg.close();}
});

test('platform owner provisions one isolated pending school with immutable audit and replay protection',async()=>{
 const f=await operationsFixture();
 try{
  const owner=f.actors.master,other=f.actors.foreignMaster,key=randomUUID();
  await f.pg.query('SELECT platform_private.register_owner($1,$2)',[owner.user,'Operator verified platform ownership']);
  await assert.rejects(f.pg.query('SELECT platform_private.register_owner($1,$2)',[other.user,'Attempt owner replacement']),/PLATFORM_OWNER_ALREADY_REGISTERED/);
  await f.pg.exec('SET ROLE kavosh_platform_service');
  await assert.rejects(f.pg.query('SELECT * FROM platform_private.owner_registration'),/permission denied/);
  await assert.rejects(f.pg.query('SELECT platform_private.register_owner($1,$2)',[owner.user,'API must not register owners']),/permission denied/);
  const input={name:'New synthetic school',masterName:'Pending master',masterEmail:'new-master@example.test',reason:'Approved new school'};
  const invoke=(user=owner.user,session=owner.session,body=input)=>f.pg.query<{result:{status:number;body:{data:{id:string;masterPersonId:string;status:string}}}}>('SELECT platform_private.request($1,$2,$3,$4,$5::jsonb) AS result',[user,session,'academies.provision',key,JSON.stringify(body)]);
  await assert.rejects(invoke(other.user,other.session),/PLATFORM_OWNER_REQUIRED/);
  const created=(await invoke()).rows[0].result;
  assert.equal(created.status,201);assert.equal(created.body.data.status,'provisioning');
  assert.deepEqual((await invoke()).rows[0].result,created);
  await assert.rejects(invoke(owner.user,owner.session,{...input,name:'Changed payload'}),/PLATFORM_IDEMPOTENCY_CONFLICT/);
  await f.pg.exec('RESET ROLE');
  const school=created.body.data.id;
  const people=(await f.pg.query<{status:string;auth_user_id:string|null;kind:string}>('SELECT status,auth_user_id,kind FROM public.people WHERE academy_id=$1',[school])).rows;
  assert.deepEqual(people,[{status:'pending',auth_user_id:null,kind:'human'}]);
  assert.equal((await f.pg.query('SELECT * FROM platform_private.audit_events WHERE academy_id=$1',[school])).rows.length,1);
  assert.equal((await f.pg.query('SELECT * FROM platform_private.request_receipts')).rows.length,1);
  await assert.rejects(f.pg.query("UPDATE platform_private.audit_events SET reason='rewritten'"),/PLATFORM_HISTORY_IMMUTABLE/);
  await f.pg.exec('SET ROLE kavosh_platform_service');
  await assert.rejects(f.pg.query('SELECT platform_private.request($1,$2,$3,$4,$5::jsonb)',[owner.user,owner.session,'academies.change',randomUUID(),JSON.stringify({academyId:school,expectedVersion:1,status:'active',reason:'Skip onboarding'})]),/PLATFORM_MASTER_VERIFICATION_REQUIRED/);
  await f.pg.exec('RESET ROLE');
  assert.equal((await f.pg.query<{status:string}>('SELECT status FROM public.academies WHERE id=$1',[school])).rows[0].status,'provisioning');
  const forbidden=await f.request('people',undefined,'master',{academy:school});assert.equal(forbidden.response.status,401);
 }finally{await f.pg.exec('RESET ROLE');await f.pg.close();}
});
