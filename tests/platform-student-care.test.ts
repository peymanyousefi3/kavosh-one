import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {test} from 'node:test';
import {operationsFixture} from './operations-fixture.ts';
import {createPayrollPrivateVault} from '../src/core/payroll-private-data.ts';
import {createPlatformApi} from '../src/platform/api.ts';
import {upgradeToCurrent} from './migration-upgrade.ts';
import type {Database} from '../src/core/database.ts';

async function fixture(options:{vault?:'missing'|'wrong'}={}){
 const vault=createPayrollPrivateVault({activeKeyId:'current',keys:{current:randomBytes(32).toString('base64url')},fingerprintKey:randomBytes(32).toString('base64url')},'student-care'),f=await operationsFixture({throughSchema:412,studentCareVault:()=>vault});
 try{
  const student=f.actors.staff.person,input={expectedVersion:0,state:'recorded',details:{allergies:'PRIVATE_OWNER_CARE synthetic allergy',considerations:'PRIVATE_OWNER_CARE synthetic support'},purpose:'student_safety',reason:'PRIVATE_OWNER_CARE original record'},path='students/'+student+'/care';
  assert.equal((await f.request('students',{personId:student,legalName:'Synthetic care learner',dateOfBirth:'2014-01-01',recruiter:{kind:'academy'}})).response.status,201);assert.equal((await f.request(path,input)).response.status,200);
  assert.equal((await f.request(path,{...input,expectedVersion:1,state:'withdrawn',details:null,reason:'PRIVATE_OWNER_CARE withdrawal'})).response.status,200);
  await f.pg.query('SELECT platform_private.register_owner($1,$2)',[f.actors.master.user,'Synthetic audited private oversight']);
  const tables=['student_profiles','student_care_heads','student_care_revisions','role_assignments','approval_requests','audit_events','outbox_events'],snapshot=async()=>{const rows=[];for(const table of tables)rows.push((await f.pg.query('SELECT to_jsonb(t) row FROM public.'+table+' t ORDER BY to_jsonb(t)::text')).rows);return rows;},before=await snapshot(),authority=(await f.pg.query("SELECT oid,proowner,proacl FROM pg_proc WHERE oid='platform_private.request(uuid,uuid,text,uuid,jsonb)'::regprocedure")).rows;
  await upgradeToCurrent(f.pg);assert.deepEqual(await snapshot(),before);assert.deepEqual((await f.pg.query("SELECT oid,proowner,proacl FROM pg_proc WHERE oid='platform_private.request(uuid,uuid,text,uuid,jsonb)'::regprocedure")).rows,authority);
  const database:Database={async connect(){if(f.pg.runtime){const c=await f.pg.runtime.connect();await c.query('SET ROLE kavosh_platform_service');return c;}await f.pg.exec('SET ROLE kavosh_platform_service');return{query:<Row>(sql:string,args?:unknown[])=>f.pg.query<Row>(sql,args),release(){}};}},root='academies/'+f.a+'/students/'+student+'/care';
  const wrong=createPayrollPrivateVault({activeKeyId:'current',keys:{current:randomBytes(32).toString('base64url')},fingerprintKey:randomBytes(32).toString('base64url')},'student-care');
  const api=createPlatformApi(database,async r=>{const a=f.actors[r.headers.get('x-test-actor')??''];return a?{userId:a.user,sessionId:a.session}:null;},true,{studentCareVault:options.vault==='missing'?undefined:()=>options.vault==='wrong'?wrong:vault});
  const call=async(path=root,options:{actor?:string;purpose?:boolean;method?:string;body?:unknown;bearer?:boolean}={})=>{const headers:Record<string,string>={'x-test-actor':options.actor??'master','content-type':'application/json'};if(options.purpose!==false)headers['x-access-purpose']='Synthetic student safety oversight';if(options.bearer)headers.authorization='Bearer synthetic';try{const response=await api(new Request('https://example.test/api/platform/v1/'+path,{method:options.method??'GET',headers,...options.body!==undefined?{body:JSON.stringify(options.body)}:{}}),path.split('?')[0]);return{response,body:await response.json()};}finally{if(!f.pg.runtime)await f.pg.exec('RESET ROLE');}};
  return {...f,student,input,vault,root,call,snapshot};
 }catch(e){await f.pg.close();throw e;}
}
test('platform owner inspects encrypted original care editions without school-user impersonation or a plaintext audit trail',async()=>{
 const f=await fixture();try{
  const before=await f.snapshot(),current=await f.call();assert.equal(current.response.status,200,JSON.stringify(current.body));assert.equal(current.body.data.version,2);assert.equal(current.body.data.state,'withdrawn');assert.equal(current.body.scope,'platform_owner_read_only');assert.doesNotMatch(JSON.stringify(current.body),/PRIVATE_OWNER_CARE|envelope|ciphertext|commitment|allergies|considerations/);
  const one=await f.call(f.root+'/history?limit=1'),two=await f.call(f.root+'/history?limit=1&afterVersion=1');assert.deepEqual(one.body.data.map((v:any)=>v.version),[1]);assert.equal(one.body.nextVersion,1);assert.deepEqual(two.body.data.map((v:any)=>v.version),[2]);assert.equal(two.body.nextVersion,null);assert.doesNotMatch(JSON.stringify([one.body,two.body]),/PRIVATE_OWNER_CARE|ciphertext|commitment/);
  for(const version of [1,2]){const r=await f.call(f.root+'/reveal',{method:'POST',body:{version}});assert.equal(r.response.status,200,JSON.stringify(r.body));assert.equal(r.response.headers.get('cache-control'),'no-store');assert.deepEqual(r.body.data.details,version===1?f.input.details:null);assert.equal(r.body.data.version,version);assert.equal(r.body.data.readAuditRecorded,true);assert.doesNotMatch(JSON.stringify(r.body),/ciphertext|commitment|envelope/);}
  assert.deepEqual(await f.snapshot(),before);const audits=(await f.pg.query("SELECT action,after_data,reason FROM platform_private.audit_events WHERE action LIKE 'platform.academy.student-care.%' ORDER BY id")).rows;assert.equal(audits.length,5);assert.doesNotMatch(JSON.stringify(audits),/PRIVATE_OWNER_CARE|allergies|considerations|ciphertext|commitment/);
 }finally{await f.pg.close();}
});
test('platform care inspection refuses nonowners bearer tokens missing purpose and cross-school binding',async()=>{
 const f=await fixture();try{
  for(const actor of ['staff','manager','peer','foreignMaster'])assert.equal((await f.call(f.root,{actor})).response.status,403);assert.equal((await f.call(f.root,{bearer:true})).response.status,401);assert.equal((await f.call(f.root,{purpose:false})).response.status,400);
  for(const path of [f.root.replace(f.a,f.b),f.root.replace(f.student,randomUUID())])assert.equal((await f.call(path)).response.status,404);
  for(const suffix of ['?version=1','/history?limit=6','/history?limit=1&limit=2','/history?afterVersion=-1'])assert.equal((await f.call(f.root+suffix)).response.status,400);
  for(const body of [{version:0},{version:1,approved:true},{version:1,purpose:'override'},{version:1,details:f.input.details}])assert.equal((await f.call(f.root+'/reveal',{method:'POST',body})).response.status,400);assert.equal((await f.call(f.root+'/reveal',{method:'POST',body:{version:3}})).response.status,404);
  assert.equal((await f.call(f.root+'/reveal')).response.status,405);assert.equal((await f.call(f.root,{method:'POST',body:{}})).response.status,405);
  const empty=f.actors.peer.person;assert.equal((await f.request('students',{personId:empty,legalName:'Synthetic unrecorded care learner',dateOfBirth:'2014-01-01',recruiter:{kind:'academy'}})).response.status,201);const emptyPath=f.root.replace(f.student,empty),unrecorded=await f.call(emptyPath);assert.equal(unrecorded.response.status,200);assert.equal(unrecorded.body.data.version,0);assert.equal(unrecorded.body.data.state,null);assert.deepEqual((await f.call(emptyPath+'/history')).body.data,[]);assert.equal((await f.call(emptyPath+'/reveal',{method:'POST',body:{version:1}})).response.status,404);
 }finally{await f.pg.close();}
});
test('platform care reveal fails closed on missing or wrong vault keys without committing access or caching plaintext',async()=>{
 for(const vault of ['missing','wrong'] as const){const f=await fixture({vault});try{
  assert.equal((await f.call()).response.status,200);const before=(await f.pg.query('SELECT * FROM platform_private.audit_events ORDER BY id')).rows,business=await f.snapshot(),r=await f.call(f.root+'/reveal',{method:'POST',body:{version:1}});assert.equal(r.response.status,503);assert.doesNotMatch(JSON.stringify(r.body),/PRIVATE_OWNER_CARE|envelope|ciphertext|commitment/);assert.deepEqual((await f.pg.query('SELECT * FROM platform_private.audit_events ORDER BY id')).rows,before);assert.deepEqual(await f.snapshot(),business);
 }finally{await f.pg.close();}}
});
test('platform care plaintext is never returned if its mandatory private access audit cannot commit',async()=>{
 const f=await fixture();try{
  const before=(await f.pg.query('SELECT * FROM platform_private.audit_events ORDER BY id')).rows,business=await f.snapshot();
  await f.pg.exec("CREATE FUNCTION platform_private.fail_care_audit_test() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN IF NEW.action='platform.academy.student-care.reveal' THEN RAISE EXCEPTION 'PRIVATE synthetic audit failure';END IF;RETURN NEW;END$$;CREATE CONSTRAINT TRIGGER fail_care_audit_test AFTER INSERT ON platform_private.audit_events DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION platform_private.fail_care_audit_test()");
  const failed=await f.call(f.root+'/reveal',{method:'POST',body:{version:1}});assert.equal(failed.response.status,503);assert.doesNotMatch(JSON.stringify(failed.body),/PRIVATE|allergies|considerations|envelope|ciphertext/);assert.deepEqual((await f.pg.query('SELECT * FROM platform_private.audit_events ORDER BY id')).rows,before);assert.deepEqual(await f.snapshot(),business);
  await f.pg.exec('DROP TRIGGER fail_care_audit_test ON platform_private.audit_events;DROP FUNCTION platform_private.fail_care_audit_test()');const retry=await f.call(f.root+'/reveal',{method:'POST',body:{version:1}});assert.equal(retry.response.status,200);assert.deepEqual(retry.body.data.details,f.input.details);assert.equal((await f.pg.query("SELECT * FROM platform_private.audit_events WHERE action='platform.academy.student-care.reveal'")).rows.length,1);
 }finally{await f.pg.close();}
});
test('platform care native gateway independently enforces input and MFA without direct table or helper grants',async()=>{
 const f=await fixture();try{
  const grants=(await f.pg.query<{raw:boolean;helper:boolean}>("SELECT has_table_privilege('kavosh_platform_service','public.student_care_revisions','SELECT') raw,has_function_privilege('kavosh_platform_service','platform_private.read_student_care(uuid,uuid,jsonb)','EXECUTE') helper")).rows[0];assert.deepEqual(grants,{raw:false,helper:false});
  const base={academyId:f.a,studentId:f.student,mode:'reveal',version:1,purpose:'Synthetic native oversight'};
  for(const input of [{...base,version:0},{...base,version:2147483648},{...base,mode:'current'},{...base,limit:1},{...base,approved:true},{...base,purpose:''},{...base,purpose:'bad\ntext'}]){await f.pg.exec('SET ROLE kavosh_platform_service');try{await assert.rejects(f.pg.query('SELECT platform_private.request($1,$2,$3,NULL,$4::jsonb)',[f.actors.master.user,f.actors.master.session,'academies.student-care',JSON.stringify(input)]),/INVALID_PLATFORM_INPUT/);}finally{await f.pg.exec('RESET ROLE');}}
  await f.pg.query('UPDATE identity.session SET "mfaVerified"=false WHERE id=$1',[f.actors.master.session]);assert.equal((await f.call()).response.status,403);assert.equal((await f.call(f.root+'/reveal',{method:'POST',body:{version:1}})).response.status,403);assert.equal((await f.pg.query("SELECT * FROM platform_private.audit_events WHERE action='platform.academy.student-care.reveal'")).rows.length,0);
 }finally{await f.pg.close();}
});
test('platform owner reads another school only through its exact encrypted care binding',async()=>{
 const f=await fixture();try{
  const student=f.actors.foreignMaster.person;assert.equal((await f.request('students',{personId:student,legalName:'Synthetic other-school adult learner',dateOfBirth:'2000-01-01',recruiter:{kind:'academy'}},'foreignMaster',{academy:f.b})).response.status,201);
  const input={...f.input,details:{allergies:null,considerations:'PRIVATE_OTHER_SCHOOL original support'}};assert.equal((await f.request('students/'+student+'/care',input,'foreignMaster',{academy:f.b})).response.status,200);
  const path='academies/'+f.b+'/students/'+student+'/care',current=await f.call(path);assert.equal(current.response.status,200);assert.equal(current.body.data.version,1);assert.doesNotMatch(JSON.stringify(current.body),/PRIVATE_OTHER_SCHOOL/);
  const reveal=await f.call(path+'/reveal',{method:'POST',body:{version:1}});assert.equal(reveal.response.status,200);assert.deepEqual(reveal.body.data.details,input.details);assert.equal((await f.call(path.replace(f.b,f.a))).response.status,404);assert.equal((await f.call(path.replace(student,f.student))).response.status,404);
 }finally{await f.pg.close();}
});
