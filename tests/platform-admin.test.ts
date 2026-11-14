import assert from 'node:assert/strict';
import { randomUUID,createHmac } from 'node:crypto';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { operationsFixture } from './operations-fixture.ts';
import { createPlatformApi } from '../src/platform/api.ts';
import { assertRuntimeRole,type Database } from '../src/core/database.ts';
import { assertFileWorkerRole } from '../src/files/inspection-worker.ts';
import { assertSignatureIngestRole } from '../src/integrations/boldsign-inbox.ts';
import { assertSignatureResultRole } from '../src/integrations/signature-result-worker.ts';
import { upgradeToCurrent } from './migration-upgrade.ts';

async function revocationFixture(options:{throughSchema?:number}={}){const f=await operationsFixture(options);try{
 const owner=f.actors.master,secret='synthetic-platform-revocation-secret-not-production-00000';await f.pg.query('SELECT platform_private.register_owner($1,$2)',[owner.user,'Verified owner enrollment']);
 const database:Database={async connect(){if(f.pg.runtime){const c=await f.pg.runtime.connect();await c.query('SET ROLE kavosh_platform_service');return c;}await f.pg.exec('SET ROLE kavosh_platform_service');return {query:<Row>(sql:string,args?:unknown[])=>f.pg.query<Row>(sql,args),release(){}};}};
 const api=createPlatformApi(database,async r=>{const a=f.actors[r.headers.get('x-test-actor')??''];return a?{userId:a.user,sessionId:a.session}:null;},true,{invitationSecret:secret});
 async function request(path:string,input:unknown,actor='master',key:string=randomUUID()){try{const response=await api(new Request('https://academy.example/api/platform/v1/'+path,{method:'POST',headers:{'x-test-actor':actor,'content-type':'application/json','idempotency-key':key},body:JSON.stringify(input)}),path);return {response,body:await response.json()};}finally{if(!f.pg.runtime)await f.pg.exec('RESET ROLE');}}
 const s=(await f.pg.query<any>('SELECT platform_private.request($1,$2,$3,$4,$5::jsonb) r',[owner.user,owner.session,'academies.provision',randomUUID(),JSON.stringify({name:'Synthetic cancellable school',masterName:'Pending master',masterEmail:'foreignMaster@example.test',reason:'Synthetic provision'})])).rows[0].r.body.data,school=s.id,issuePath='academies/'+school+'/master-invitation',issueInput={expectedVersion:1,reason:'Synthetic master invitation'};
 const issue=(key?:string)=>request(issuePath,issueInput,'master',key),revoke=(invitationRequestKey:string,key?:string,patch:Record<string,unknown>={},actor='master')=>request(issuePath+'/revoke',{expectedVersion:1,invitationRequestKey,reason:'Synthetic exact unused invitation cancellation',...patch},actor,key);
 return {...f,owner,secret,school,request,issue,revoke,issuePath,issueInput,hash:(token:string)=>createHmac('sha256',secret).update(token).digest('hex')};
 }catch(e){await f.pg.close();throw e;}}
test('platform invitation cancellation invalidates only the exact unused token and replay never cancels a replacement',async()=>{
 const f=await revocationFixture();try{const issueKey=randomUUID(),issued=await f.issue(issueKey);assert.equal(issued.response.status,201,JSON.stringify(issued.body));assert.equal(issued.body.data.invitationRequestKey,issueKey);assert.equal(issued.body.data.issuedAcademyVersion,1);const before=(await f.pg.query('SELECT * FROM public.people WHERE academy_id=$1',[f.school])).rows,key=randomUUID(),revoked=await f.revoke(issueKey,key);assert.equal(revoked.response.status,200,JSON.stringify(revoked.body));assert.equal(revoked.body.data.revoked,true);assert.equal(revoked.body.data.accountsChanged,false);assert.equal(revoked.response.headers.get('cache-control'),'no-store');assert.doesNotMatch(JSON.stringify(revoked.body),/privateInvitation|tokenHash|token_hash/);assert.deepEqual((await f.pg.query('SELECT * FROM public.people WHERE academy_id=$1',[f.school])).rows,before);
 assert.equal((await f.pg.query<any>('SELECT * FROM identity.accept_invite($1,$2,$3)',[f.hash(issued.body.data.privateInvitation),f.actors.foreignMaster.user,f.actors.foreignMaster.session])).rows[0].code,'INVALID_INVITATION');assert.equal((await f.request(f.issuePath,f.issueInput,'master',issueKey)).response.status,409);
 const renewed=await f.issue();assert.equal(renewed.response.status,201);assert.deepEqual((await f.revoke(issueKey,key)).body,revoked.body);assert.equal((await f.pg.query('SELECT * FROM identity.invites WHERE academy_id=$1 AND consumed_at IS NULL AND expires_at>clock_timestamp()',[f.school])).rows.length,1);assert.equal((await f.revoke(issueKey,key,{reason:'Changed retry'})).response.status,409);assert.equal((await f.pg.query("SELECT * FROM platform_private.audit_events WHERE action='platform.master.invitation.revoked'")).rows.length,1);
 }finally{await f.pg.close();}
});
test('platform invitation cancellation checks owner current verification exact source and version without exposing or mutating other invitations',async()=>{
 const f=await revocationFixture();try{const firstKey=randomUUID(),first=await f.issue(firstKey),secondKey=randomUUID(),second=await f.issue(secondKey);assert.equal(second.response.status,201);assert.equal((await f.revoke(firstKey)).response.status,409);assert.equal((await f.revoke(secondKey,undefined,{},'foreignMaster')).response.status,403);assert.equal((await f.revoke(secondKey,undefined,{expectedVersion:2})).response.status,409);assert.equal((await f.revoke(randomUUID())).response.status,409);assert.equal((await f.revoke(secondKey,undefined,{tokenHash:f.hash(second.body.data.privateInvitation)})).response.status,400);
 await f.pg.exec('SET ROLE kavosh_platform_service');try{await assert.rejects(f.pg.query('SELECT platform_private.revoke_master_invitation($1,$2,$3,$4,1,$5,$6,$7)',[f.owner.user,f.owner.session,randomUUID(),f.school,firstKey,f.hash(second.body.data.privateInvitation),'Synthetic attempt pairing an old receipt with replacement token']),/PLATFORM_INVITATION_NO_LONGER_CURRENT/);}finally{await f.pg.exec('RESET ROLE');}
 const original=(await f.pg.query('SELECT * FROM identity.invites ORDER BY token_hash')).rows;await f.pg.query('UPDATE identity.session SET "mfaVerified"=false WHERE id=$1',[f.owner.session]);assert.equal((await f.revoke(secondKey)).response.status,403);assert.deepEqual((await f.pg.query('SELECT * FROM identity.invites ORDER BY token_hash')).rows,original);assert.notEqual(first.body.data.privateInvitation,second.body.data.privateInvitation);
 }finally{await f.pg.exec('RESET ROLE');await f.pg.close();}
});
test('platform invitation cancellation audit failure rolls back expiry and receipt together',async()=>{
 const f=await revocationFixture();try{const issueKey=randomUUID(),issued=await f.issue(issueKey),before=(await f.pg.query('SELECT * FROM identity.invites')).rows,key=randomUUID();assert.equal(issued.response.status,201);await f.pg.exec("CREATE FUNCTION platform_private.fail_revoke_audit() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN IF NEW.action='platform.master.invitation.revoked' THEN RAISE EXCEPTION 'synthetic cancellation audit failure';END IF;RETURN NEW;END$$;CREATE TRIGGER fail_revoke_audit BEFORE INSERT ON platform_private.audit_events FOR EACH ROW EXECUTE FUNCTION platform_private.fail_revoke_audit()");assert.equal((await f.revoke(issueKey,key)).response.status,503);assert.deepEqual((await f.pg.query('SELECT * FROM identity.invites')).rows,before);assert.equal((await f.pg.query('SELECT * FROM platform_private.request_receipts WHERE request_key=$1',[key])).rows.length,0);await f.pg.exec('DROP TRIGGER fail_revoke_audit ON platform_private.audit_events');assert.equal((await f.revoke(issueKey,key)).response.status,200);
 }finally{await f.pg.close();}
});
test('platform invitation cancellation refuses expired consumed and other-school sources without account changes',async()=>{
 const f=await revocationFixture();try{const expired=await f.issue();assert.equal(expired.response.status,201);await f.pg.query('UPDATE identity.invites SET expires_at=clock_timestamp()-interval \'1 second\' WHERE token_hash=$1',[f.hash(expired.body.data.privateInvitation)]);assert.equal((await f.revoke(expired.body.data.invitationRequestKey)).response.status,409);const issued=await f.issue();assert.equal(issued.response.status,201);const wrong=await f.request('academies/'+f.a+'/master-invitation/revoke',{expectedVersion:1,invitationRequestKey:issued.body.data.invitationRequestKey,reason:'Synthetic different school'});assert.equal(wrong.response.status,409);const accepted=await f.pg.query<any>('SELECT * FROM identity.accept_invite($1,$2,$3)',[f.hash(issued.body.data.privateInvitation),f.actors.foreignMaster.user,f.actors.foreignMaster.session]);assert.equal(accepted.rows[0].code,'ACCEPTED');const people=(await f.pg.query('SELECT * FROM public.people WHERE academy_id=$1',[f.school])).rows;assert.equal((await f.revoke(issued.body.data.invitationRequestKey,undefined,{expectedVersion:2})).response.status,409);assert.deepEqual((await f.pg.query('SELECT * FROM public.people WHERE academy_id=$1',[f.school])).rows,people);assert.equal((await f.pg.query("SELECT * FROM platform_private.audit_events WHERE action='platform.master.invitation.revoked'")).rows.length,0);
 }finally{await f.pg.close();}
});
test('platform invitation cancellation tiny native concurrent retries and acceptance never partially cancel activation',{skip:!process.env.TEST_DATABASE_URL},async()=>{
 const f=await revocationFixture();try{async function call<Row>(role:string,sql:string,args:unknown[]){const c=await f.pg.runtime!.connect();try{await c.query('SET ROLE '+role);return(await c.query<Row>(sql,args)).rows;}finally{c.release();}}
 const issue=await f.issue(),key=randomUUID(),args=[f.owner.user,f.owner.session,key,f.school,1,issue.body.data.invitationRequestKey,f.hash(issue.body.data.privateInvitation),'Synthetic concurrent cancellation'];const cancel=()=>call<{r:unknown}>('kavosh_platform_service','SELECT platform_private.revoke_master_invitation($1,$2,$3,$4,$5,$6,$7,$8) r',args);const [a,b]=await Promise.all([cancel(),cancel()]);assert.deepEqual(a,b);assert.equal((await f.pg.query('SELECT * FROM platform_private.audit_events WHERE request_key=$1',[key])).rows.length,1);
 const renewed=await f.issue(),hash=f.hash(renewed.body.data.privateInvitation),[accept,revoke]=await Promise.all([call<{code:string}>('kavosh_identity','SELECT * FROM identity.accept_invite($1,$2,$3)',[hash,f.actors.foreignMaster.user,f.actors.foreignMaster.session]),call<{r:{status:number}}>('kavosh_platform_service','SELECT platform_private.revoke_master_invitation($1,$2,$3,$4,1,$5,$6,$7) r',[f.owner.user,f.owner.session,randomUUID(),f.school,renewed.body.data.invitationRequestKey,hash,'Synthetic cancellation racing actual acceptance']).then(r=>({status:r[0].r.status,error:null})).catch((e:Error)=>{assert.ok(['PLATFORM_ACADEMY_VERSION_CHANGED','PLATFORM_MASTER_INVITATION_UNAVAILABLE'].includes(e.message),e.message);return {status:null,error:e.message};})]);const person=(await f.pg.query<any>('SELECT * FROM public.people WHERE academy_id=$1',[f.school])).rows[0];if(accept[0].code==='ACCEPTED'){assert.equal(person.status,'active');assert.equal(person.auth_user_id,f.actors.foreignMaster.user);assert.notEqual(revoke.error,null);}else{assert.equal(accept[0].code,'INVALID_INVITATION');assert.equal(revoke.status,200);assert.equal(person.status,'pending');assert.equal(person.auth_user_id,null);}
 }finally{await f.pg.close();}
});
test('platform invitation cancellation actual166to167 upgrade preserves previous receipts tokens and helper identity without inventing source versions',async()=>{
 const f=await revocationFixture({throughSchema:166});try{const key=randomUUID(),hash='a'.repeat(64);await f.pg.query('SELECT platform_private.issue_master_invitation($1,$2,$3,$4,1,$5,$6)',[f.owner.user,f.owner.session,key,f.school,'Synthetic old issue',hash]);const before=(await f.pg.query('SELECT * FROM identity.invites ORDER BY token_hash')).rows,receipts=(await f.pg.query('SELECT * FROM platform_private.request_receipts ORDER BY request_key')).rows,helper=(await f.pg.query("SELECT oid,proowner,proacl FROM pg_proc WHERE oid='platform_private.issue_master_invitation(uuid,uuid,uuid,uuid,integer,text,text)'::regprocedure")).rows;await upgradeToCurrent(f.pg);assert.deepEqual((await f.pg.query('SELECT * FROM identity.invites ORDER BY token_hash')).rows,before);assert.deepEqual((await f.pg.query('SELECT * FROM platform_private.request_receipts ORDER BY request_key')).rows,receipts);assert.deepEqual((await f.pg.query("SELECT oid,proowner,proacl FROM pg_proc WHERE oid='platform_private.issue_master_invitation(uuid,uuid,uuid,uuid,integer,text,text)'::regprocedure")).rows,helper);await assert.rejects(f.pg.query('SELECT platform_private.revoke_master_invitation($1,$2,$3,$4,1,$5,$6,$7)',[f.owner.user,f.owner.session,randomUUID(),f.school,key,hash,'Synthetic old source refusal']),/PLATFORM_INVITATION_REISSUE_REQUIRED/);const issued=await f.issue();assert.equal(issued.response.status,201,JSON.stringify(issued.body));assert.equal((await f.revoke(issued.body.data.invitationRequestKey)).response.status,200);
 }finally{await f.pg.close();}
});

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
 for(const path of ['academies','academies/'+randomUUID()+'/master-invitation/revoke']){const response=await api(new Request('https://academy.example/api/platform/v1/'+path),path);assert.equal(response.status,404);assert.equal(response.headers.get('cache-control'),'no-store');}
});
test('platform invitation issuance without a configured signing secret fails before persistence',async()=>{
 const api=createPlatformApi({async connect(){throw Error('MUST_NOT_CONNECT');}},async()=>({userId:randomUUID(),sessionId:randomUUID()}),true);
 for(const suffix of ['','/revoke']){const path='academies/'+randomUUID()+'/master-invitation'+suffix,response=await api(new Request('https://academy.example/api/platform/v1/'+path,{method:'POST',headers:{'content-type':'application/json','idempotency-key':randomUUID()},body:JSON.stringify({expectedVersion:1,reason:'Test missing secret',...(suffix?{invitationRequestKey:randomUUID()}:{})})}),path);assert.equal(response.status,503);assert.deepEqual(await response.json(),{error:{code:'PLATFORM_UNAVAILABLE'}});}
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
  await f.pg.query("INSERT INTO identity.invites(token_hash,academy_id,person_id,email,master,expires_at) VALUES($1,$2,$3,'master@example.test',true,now()+interval '1 day')",['0'.repeat(64),f.a,f.actors.master.person]);
  const inviteRows=(await f.pg.query('SELECT * FROM identity.invites ORDER BY token_hash')).rows;
  const helper=(await f.pg.query("SELECT oid,proowner,proacl FROM pg_proc WHERE oid='identity.accept_invite(text,uuid,uuid)'::regprocedure")).rows;
  await f.pg.exec(await readFile(new URL('../db/migrations/159_platform_master_invitations.sql',import.meta.url),'utf8'));
  assert.deepEqual((await f.pg.query('SELECT * FROM identity.invites ORDER BY token_hash')).rows,inviteRows);
  assert.deepEqual((await f.pg.query("SELECT oid,proowner,proacl FROM pg_proc WHERE oid='identity.accept_invite(text,uuid,uuid)'::regprocedure")).rows,helper);
  assert.deepEqual((await f.pg.query('SELECT id,name,status,master_person_id,created_at FROM public.academies ORDER BY id')).rows,before);
 }finally{await f.pg.exec('RESET ROLE');await f.pg.close();}
});

test('native invitation replacement and acceptance serialize without partial activation',{skip:!process.env.TEST_DATABASE_URL},async()=>{
 const f=await operationsFixture();
 try{
  const owner=f.actors.master,invitee=f.actors.foreignMaster;
  await f.pg.query('SELECT platform_private.register_owner($1,$2)',[owner.user,'Verified owner enrollment']);
  async function scoped<Row>(role:string,sql:string,args:unknown[]){const db=await f.pg.runtime!.connect();try{await db.query('SET ROLE '+role);return(await db.query<Row>(sql,args)).rows;}finally{db.release();}}
  async function school(name:string){const row=await scoped<{result:{body:{data:{id:string}}}}>('kavosh_platform_service','SELECT platform_private.request($1,$2,$3,$4,$5::jsonb) AS result',[owner.user,owner.session,'academies.provision',randomUUID(),JSON.stringify({name,masterName:'Pending',masterEmail:'foreignMaster@example.test',reason:'Race fixture'})]);return row[0].result.body.data.id;}
  async function issue(academy:string,hash:string){return scoped<{result:{status:number}}>('kavosh_platform_service','SELECT platform_private.issue_master_invitation($1,$2,$3,$4,1,$5,$6) AS result',[owner.user,owner.session,randomUUID(),academy,'Private invitation',hash]);}
  const academy=await school('Concurrent onboarding'),hash=randomUUID().replaceAll('-','').repeat(2),replacement=randomUUID().replaceAll('-','').repeat(2);
  await issue(academy,hash);
  const [accept,renew]=await Promise.all([
   scoped<{code:string}>('kavosh_identity','SELECT * FROM identity.accept_invite($1,$2,$3)',[hash,invitee.user,invitee.session]),
   issue(academy,replacement).then(v=>({status:v[0].result.status,error:null})).catch((error:Error)=>{if(error.message!=='PLATFORM_MASTER_INVITATION_UNAVAILABLE')throw error;return{status:null,error:error.message};})
  ]);
  const state=(await f.pg.query<{status:string}>('SELECT status FROM public.academies WHERE id=$1',[academy])).rows[0].status;
  if(accept[0].code==='ACCEPTED'){assert.equal(state,'active');assert.equal(renew.error,'PLATFORM_MASTER_INVITATION_UNAVAILABLE');}
  else{assert.equal(accept[0].code,'INVALID_INVITATION');assert.equal(state,'provisioning');assert.equal(renew.status,201);}
  const pinned=await school('Activation lock proof'),pinnedHash=randomUUID().replaceAll('-','').repeat(2);await issue(pinned,pinnedHash);
  const db=await f.pg.runtime!.connect();try{
   await db.query('SET ROLE kavosh_identity');await db.query('BEGIN');
   assert.equal((await db.query<{code:string}>('SELECT * FROM identity.accept_invite($1,$2,$3)',[pinnedHash,invitee.user,invitee.session])).rows[0].code,'ACCEPTED');
   for(const seed of [8,9])assert.equal((await f.pg.query<{locked:boolean}>('SELECT pg_try_advisory_xact_lock(hashtextextended($1,$2)) AS locked',[pinned,seed])).rows[0].locked,false);
   await db.query('COMMIT');
   for(const seed of [8,9])assert.equal((await f.pg.query<{locked:boolean}>('SELECT pg_try_advisory_xact_lock(hashtextextended($1,$2)) AS locked',[pinned,seed])).rows[0].locked,true);
  }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
 }finally{await f.pg.close();}
});

test('platform audit failure rolls back provision and receipt; successful rate budget is bounded',async()=>{
 const f=await operationsFixture();
 try{
  const owner=f.actors.master,key=randomUUID(),input={name:'Must roll back',masterName:'Pending',masterEmail:'rollback@example.test',reason:'Atomicity test'};
  await f.pg.query('SELECT platform_private.register_owner($1,$2)',[owner.user,'Verified owner enrollment']);
  const school=(await f.pg.query<{result:{body:{data:{id:string}}}}>('SELECT platform_private.request($1,$2,$3,$4,$5::jsonb) AS result',[owner.user,owner.session,'academies.provision',randomUUID(),JSON.stringify({...input,name:'Existing invitation target'})])).rows[0].result.body.data.id;
  await f.pg.query('SELECT platform_private.issue_master_invitation($1,$2,$3,$4,1,$5,$6)',[owner.user,owner.session,randomUUID(),school,'Original valid invitation','1'.repeat(64)]);
  const originalInvites=(await f.pg.query('SELECT * FROM identity.invites ORDER BY token_hash')).rows,failedInviteKey=randomUUID();
  await f.pg.exec("CREATE FUNCTION platform_private.synthetic_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'SYNTHETIC_AUDIT_FAILURE';END $$; CREATE TRIGGER synthetic_audit_failure BEFORE INSERT ON platform_private.audit_events FOR EACH ROW EXECUTE FUNCTION platform_private.synthetic_audit_failure()");
  await f.pg.exec('SET ROLE kavosh_platform_service');
  await assert.rejects(f.pg.query('SELECT platform_private.request($1,$2,$3,$4,$5::jsonb)',[owner.user,owner.session,'academies.provision',key,JSON.stringify(input)]),/SYNTHETIC_AUDIT_FAILURE/);
  await assert.rejects(f.pg.query('SELECT platform_private.issue_master_invitation($1,$2,$3,$4,1,$5,$6)',[owner.user,owner.session,failedInviteKey,school,'Fail replacement atomically','2'.repeat(64)]),/SYNTHETIC_AUDIT_FAILURE/);
  await f.pg.exec('RESET ROLE');
  assert.deepEqual((await f.pg.query('SELECT * FROM identity.invites ORDER BY token_hash')).rows,originalInvites);
  assert.equal((await f.pg.query('SELECT * FROM platform_private.request_receipts WHERE request_key=$1',[failedInviteKey])).rows.length,0);
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
  const api=createPlatformApi(database,async r=>{const actor=f.actors[r.headers.get('x-test-actor')??''];return actor?{userId:actor.user,sessionId:actor.session}:null;},true,{invitationSecret:'synthetic-platform-invitation-secret-not-for-production-00000'});
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
  const invitePath='academies/'+school+'/master-invitation',inviteBody={expectedVersion:2,reason:'Invite assigned master'},inviteKey=randomUUID();
  assert.equal((await request(invitePath,{...inviteBody,email:'replacement@example.test'})).response.status,400);
  assert.equal((await request(invitePath,inviteBody,'foreignMaster')).response.status,403);
  assert.equal((await request(invitePath,inviteBody,'master',key)).response.status,409,'keys cannot be reused across operations');
  const issued=await request(invitePath,inviteBody,'master',inviteKey);assert.equal(issued.response.status,201,JSON.stringify(issued.body));assert.match(issued.body.data.privateInvitation,/^kvi_[A-Za-z0-9_-]{43}$/);assert.equal(issued.body.data.email,input.masterEmail);assert.equal(issued.body.data.activationPerformed,false);assert.equal(issued.response.headers.get('cache-control'),'no-store');
  assert.deepEqual((await request(invitePath,inviteBody,'master',inviteKey)).body,issued.body);
  assert.equal((await request(invitePath,{...inviteBody,reason:'Changed retry'},'master',inviteKey)).response.status,409);
  const renewedKey=randomUUID(),renewed=await request(invitePath,inviteBody,'master',renewedKey);assert.equal(renewed.response.status,201,JSON.stringify(renewed.body));assert.notEqual(renewed.body.data.privateInvitation,issued.body.data.privateInvitation);
  assert.equal((await request(invitePath,inviteBody,'master',inviteKey)).response.status,409,'superseded invitations are not returned on replay');
  assert.equal((await f.pg.query('SELECT * FROM identity.invites WHERE academy_id=$1 AND consumed_at IS NULL AND expires_at>clock_timestamp()',[school])).rows.length,1);
  for(const table of ['platform_private.audit_events','platform_private.request_receipts','identity.invites']){const rows=(await f.pg.query('SELECT row_to_json(t)::text AS value FROM '+table+' t')).rows;for(const token of [issued.body.data.privateInvitation,renewed.body.data.privateInvitation])assert.ok(rows.every(r=>!String(r.value).includes(token)));}
  await f.pg.query("UPDATE identity.invites SET expires_at=clock_timestamp()-interval '1 second' WHERE academy_id=$1 AND expires_at>clock_timestamp()",[school]);
  assert.equal((await request(invitePath,inviteBody,'master',renewedKey)).response.status,409,'expired tokens must not be returned from cached receipts');
  const limited=await request('academies/'+f.a+'/change',{expectedVersion:1,status:'read_only',reason:'Pause school edits'});assert.equal(limited.response.status,200,JSON.stringify(limited.body));
  assert.equal((await f.request('hubs')).response.status,200);
  assert.equal((await f.request('hubs',{name:'Blocked write',city:'Toronto',countryCode:'CA'})).response.status,403);
  const resumed=await request('academies/'+f.a+'/change',{expectedVersion:2,status:'active',reason:'Resume school edits'});assert.equal(resumed.response.status,200,JSON.stringify(resumed.body));assert.equal(resumed.body.data.version,3);
  await f.pg.query('UPDATE identity.session SET "expiresAt"=now()-interval \'1 second\' WHERE id=$1',[owner.session]);
  assert.equal((await request('academies')).response.status,403);
  assert.equal((await request(invitePath,inviteBody,'master',inviteKey)).response.status,403);
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
  await assert.rejects(f.pg.query('SELECT platform_private.issue_master_invitation($1,$2,$3,$4,1,$5,$6)',[owner.user,owner.session,randomUUID(),randomUUID(),' '.repeat(9000)+'x','0'.repeat(64)]),/INVALID_PLATFORM_INPUT/);
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
