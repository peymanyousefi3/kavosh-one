import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { operationsFixture } from './operations-fixture.ts';

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
