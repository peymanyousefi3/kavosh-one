import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { operationsFixture } from './operations-fixture.ts';

test('actual229to230 adds no historical notifications and isolates native evidence publishing from web and service roles',async()=>{
 const f=await operationsFixture({throughSchema:229});try{
  const snapshot="SELECT jsonb_build_object('people',(SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM public.people p),'permissions',(SELECT jsonb_agg(to_jsonb(p) ORDER BY role_id,capability) FROM public.role_permissions p),'sources',(SELECT jsonb_agg(to_jsonb(p)-'work_signature_evidence_id' ORDER BY event_id) FROM public.automation_event_sources p),'notices',(SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM public.portal_notifications p),'evidence',(SELECT jsonb_agg(to_jsonb(p)-'origin_transaction' ORDER BY id) FROM public.work_signature_completion_evidence p),'reviews',(SELECT jsonb_agg(to_jsonb(p)-'origin_transaction' ORDER BY evidence_id,version) FROM public.work_signature_completion_review_revisions p)) snapshot";
  const functions="SELECT oid,proowner,proacl FROM pg_proc WHERE oid IN('public.work_signature_notice_guard()'::regprocedure,'public.capture_audited_automation_event()'::regprocedure,'public.publish_work_signature_alert()'::regprocedure,'public.mandatory_alert_guard()'::regprocedure) ORDER BY oid",before=(await f.pg.query(snapshot)).rows,identities=(await f.pg.query(functions)).rows;
  await f.pg.exec(await readFile(new URL('../db/migrations/230_work_signature_evidence_notifications.sql',import.meta.url),'utf8'));assert.equal((await f.pg.query('SELECT public.schema_revision() n')).rows[0].n,230);assert.deepEqual((await f.pg.query(snapshot)).rows,before);assert.deepEqual((await f.pg.query(functions)).rows,identities);
  for(const role of ['kavosh_runtime','kavosh_file_worker','kavosh_signature_result_worker','kavosh_signature_completion_worker','kavosh_signature_evidence_worker','kavosh_identity','kavosh_delivery']){await f.pg.exec('SET ROLE '+role);try{
   await assert.rejects(f.pg.query('SELECT public.work_signature_evidence_notice_basis($1,NULL,NULL,pg_current_xact_id())',[randomUUID()]),/permission denied/i);
   await assert.rejects(f.pg.query('SELECT public.work_signature_inspection_notice_basis($1,pg_current_xact_id())',[randomUUID()]),/permission denied/i);
   await assert.rejects(f.pg.query('SELECT public.work_signature_evidence_notice_projection($1,$2,pg_current_xact_id())',[randomUUID(),'evidence:'+randomUUID()]),/permission denied/i);
  }finally{await f.pg.exec('RESET ROLE');}}
  await f.pg.exec('SET ROLE kavosh_event_policy');try{await assert.rejects(f.pg.exec('SELECT manifest FROM public.work_signature_completion_evidence'),/permission denied/i);await assert.rejects(f.pg.exec('SELECT result FROM public.work_signature_evidence_inspections'),/permission denied/i);}finally{await f.pg.exec('RESET ROLE');}
  await f.pg.exec('SET ROLE kavosh_runtime');try{await f.pg.query("SELECT set_config('app.academy_id',$1,false)",[f.a]);assert.equal((await f.pg.query('SELECT * FROM public.work_signature_evidence_notice_state($1)',[randomUUID()])).rows.length,0);await assert.rejects(f.pg.exec('SELECT origin_transaction FROM public.work_signature_completion_evidence'),/permission denied/i);}finally{await f.pg.exec('RESET ROLE');}
 }finally{await f.pg.close();}
});

test('native worker review input binds two independent real signing attestations and rejects enrollment or actor overrides',async()=>{
 const f=await operationsFixture();try{
  const base={expectedVersion:0,decision:'rejected',documentGrantId:null,auditGrantId:null,workerSignedAt:null,academySignedAt:null,identityAndAuthenticationReviewed:false,contentAndConsentReviewed:false,reason:'Explicit worker evidence decision',requestId:randomUUID(),evidenceId:randomUUID(),requestedBy:f.actors.manager.person},accepted={...base,decision:'accepted',documentGrantId:randomUUID(),auditGrantId:randomUUID(),workerSignedAt:'2026-11-08T01:00:00.000Z',academySignedAt:'2026-11-08T02:00:00.000Z',identityAndAuthenticationReviewed:true,contentAndConsentReviewed:true};
  const valid=async(value:unknown)=>(await f.pg.query<{valid:boolean}>('SELECT public.work_signature_completion_review_input_valid($1::jsonb) valid',[JSON.stringify(value)])).rows[0].valid;
  assert.equal(await valid(base),true);assert.equal(await valid(accepted),true);
  for(const value of [null,{}, {...base,signedAt:null},{...accepted,signedAt:accepted.workerSignedAt},{...base,academySignedAt:accepted.academySignedAt},{...base,workerSignedAt:accepted.workerSignedAt},{...accepted,academySignedAt:null},{...accepted,workerSignedAt:null},{...accepted,academySignedAt:'not-a-time'},{...accepted,documentGrantId:null},{...accepted,identityAndAuthenticationReviewed:false},{...base,paymentCleared:true},{...base,expectedVersion:2147483647}])assert.equal(await valid(value),false,JSON.stringify(value));
 }finally{await f.pg.close();}
});
test('actual228to229 preserves historical people permissions and original evidence/review function identities without backfilling worker decisions',async()=>{
 const f=await operationsFixture({throughSchema:228});try{
  const snapshot="SELECT jsonb_build_object('people',(SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM public.people p),'permissions',(SELECT jsonb_agg(to_jsonb(p) ORDER BY role_id,capability) FROM public.role_permissions p),'evidence',(SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM public.work_signature_completion_evidence p),'grants',(SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM public.work_signature_evidence_download_grants p),'reviews',(SELECT jsonb_agg(to_jsonb(p) ORDER BY evidence_id) FROM public.signature_completion_reviews p)) snapshot";
  const funcs="SELECT oid,proowner,proacl,pg_get_functiondef(oid) definition FROM pg_proc WHERE oid IN('public.signature_completion_review_source(uuid,uuid,jsonb)'::regprocedure,'public.work_signature_evidence_download_source(uuid,text,uuid)'::regprocedure,'public.work_signature_completion_source(uuid,uuid)'::regprocedure,'public.record_work_signature_evidence_inspection(uuid,uuid,uuid,text,text,jsonb)'::regprocedure) ORDER BY oid",before=(await f.pg.query(snapshot)).rows,identities=(await f.pg.query(funcs)).rows;
  await f.pg.exec(await readFile(new URL('../db/migrations/229_work_signature_completion_reviews.sql',import.meta.url),'utf8'));
  assert.equal((await f.pg.query('SELECT public.schema_revision() n')).rows[0].n,229);assert.deepEqual((await f.pg.query(snapshot)).rows,before);assert.deepEqual((await f.pg.query(funcs)).rows,identities);
  assert.equal((await f.pg.query('SELECT * FROM public.work_signature_completion_reviews')).rows.length,0);assert.equal((await f.pg.query("SELECT * FROM public.role_permissions WHERE capability='work-signature-completions.review'")).rows.length,0);
  assert.equal((await f.pg.query("SELECT has_table_privilege('kavosh_runtime','public.outbox_events','SELECT') allowed")).rows[0].allowed,false);
  assert.equal((await f.pg.query("SELECT has_function_privilege('kavosh_runtime','public.require_work_signature_completion_review()','EXECUTE') allowed")).rows[0].allowed,false);
  for(const role of ['kavosh_file_worker','kavosh_signature_result_worker','kavosh_signature_completion_worker','kavosh_signature_evidence_worker','kavosh_identity','kavosh_delivery']){await f.pg.exec('SET ROLE '+role);try{
   await assert.rejects(f.pg.exec('SELECT * FROM public.work_signature_completion_reviews'),/permission denied/i);await assert.rejects(f.pg.query('SELECT public.work_signature_completion_review_source($1,$2,$3::jsonb)',[randomUUID(),f.actors.manager.person,'{}']),/permission denied/i);
  }finally{await f.pg.exec('RESET ROLE');}}
 }finally{await f.pg.close();}
});

test('native review inputs require exact human attestation fields and civil signing dates preserve guardian protection at birthdays and leap-day boundaries',async()=>{
 const f=await operationsFixture();try{
  const base={expectedVersion:0,decision:'rejected',documentGrantId:null,auditGrantId:null,signedAt:null,identityAndAuthenticationReviewed:false,contentAndConsentReviewed:false,reason:'Explicit synthetic evidence decision',requestId:randomUUID(),evidenceId:randomUUID(),requestedBy:f.actors.manager.person},accepted={...base,decision:'accepted',documentGrantId:randomUUID(),auditGrantId:randomUUID(),signedAt:'2026-11-08T00:00:00.000Z',identityAndAuthenticationReviewed:true,contentAndConsentReviewed:true};
  const valid=async(value:unknown)=>(await f.pg.query<{valid:boolean}>('SELECT public.signature_completion_review_input_valid($1::jsonb) valid',[JSON.stringify(value)])).rows[0].valid;assert.equal(await valid(base),true);assert.equal(await valid(accepted),true);
  for(const value of [null,{}, {...base,decision:null},{...base,requestedBy:null},{...base,requestId:null},{...base,expectedVersion:-1},{...base,expectedVersion:2147483647},{...base,admissionCleared:true},{...base,signedAt:accepted.signedAt},{...accepted,identityAndAuthenticationReviewed:false},{...accepted,contentAndConsentReviewed:false},{...accepted,documentGrantId:null},{...accepted,auditGrantId:null},{...accepted,signedAt:'not-a-time'}])assert.equal(await valid(value),false,JSON.stringify(value));
  for(const [birth,signed,zone,expected] of [
   ['2008-11-08','2026-11-08T00:30:00Z','UTC',false],['2008-11-08','2026-11-08T00:30:00Z','America/Toronto',true],
   ['2008-11-08','2026-11-08T04:59:59Z','America/Toronto',true],['2008-11-08','2026-11-08T05:00:00Z','America/Toronto',false],
   ['2008-11-08','2026-11-07T15:00:00Z','Asia/Tokyo',false],['2008-02-29','2026-02-28T23:59:59Z','UTC',true],['2008-02-29','2026-03-01T00:00:00Z','UTC',false],
   ['2026-01-01','2025-12-31T23:59:59Z','UTC',null],[null,'2026-01-01T00:00:00Z','UTC',null]
  ] as const)assert.equal((await f.pg.query<{minor:boolean|null}>('SELECT public.signature_signing_requires_guardian($1::date,$2::timestamptz,$3) minor',[birth,signed,zone])).rows[0].minor,expected);
 }finally{await f.pg.close();}
});
test('actual209to210 preserves historical evidence and access policies,creates no reviews and keeps queue/private review checks isolated from ordinary services',async()=>{
 const f=await operationsFixture({throughSchema:209});try{
  const snapshot="SELECT jsonb_build_object('people',(SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM public.people p),'permissions',(SELECT jsonb_agg(to_jsonb(p) ORDER BY role_id,capability) FROM public.role_permissions p),'evidence',(SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM public.signature_completion_evidence p),'grants',(SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM public.signature_evidence_download_grants p)) snapshot",before=(await f.pg.query(snapshot)).rows,func="SELECT oid,proowner,proacl,pg_get_functiondef(oid) definition FROM pg_proc WHERE oid='public.signature_evidence_download_source(uuid,text,uuid)'::regprocedure",original=(await f.pg.query(func)).rows;
  await f.pg.exec(await readFile(new URL('../db/migrations/210_signature_completion_reviews.sql',import.meta.url),'utf8'));assert.equal((await f.pg.query('SELECT public.schema_revision() n')).rows[0].n,210);assert.deepEqual((await f.pg.query(snapshot)).rows,before);assert.deepEqual((await f.pg.query(func)).rows,original);assert.equal((await f.pg.query('SELECT * FROM public.signature_completion_reviews')).rows.length,0);
  assert.equal((await f.pg.query("SELECT has_table_privilege('kavosh_runtime','public.outbox_events','SELECT') allowed")).rows[0].allowed,false);assert.equal((await f.pg.query("SELECT has_function_privilege('kavosh_runtime','public.require_signature_completion_review()','EXECUTE') allowed")).rows[0].allowed,false);
  for(const role of ['kavosh_file_worker','kavosh_signature_result_worker','kavosh_signature_completion_worker','kavosh_signature_evidence_worker','kavosh_identity','kavosh_delivery']){await f.pg.exec('SET ROLE '+role);try{await assert.rejects(f.pg.query('SELECT * FROM public.signature_completion_reviews'),/permission denied/i);await assert.rejects(f.pg.query('SELECT public.signature_completion_review_source($1,$2,$3::jsonb)',[randomUUID(),f.actors.manager.person,'{}']),/permission denied/i);}finally{await f.pg.exec('RESET ROLE');}}
 }finally{await f.pg.close();}
});
