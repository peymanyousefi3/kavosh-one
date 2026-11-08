import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { operationsFixture } from './operations-fixture.ts';
import { assertRuntimeRole,type Database } from '../src/core/database.ts';
import { assertSignatureCompletionRole,loadSignatureCompletionSource,matchSignatureCompletionSigner } from '../src/integrations/signature-completion-source.ts';

test('completion source refuses arbitrary overrides before connecting and redacts unavailable connection details',async()=>{
 let connections=0;const db:Database={async connect(){connections++;throw Error('PRIVATE credentials and contact');}},target={academyId:randomUUID(),startId:randomUUID()};
 for(const value of [{...target,documentId:randomUUID()},{...target,sourceFingerprint:'a'.repeat(64)},{...target,signerId:randomUUID()},{...target,academyId:'other'}])await assert.rejects(loadSignatureCompletionSource(db,value),{code:'INVALID_SIGNATURE_COMPLETION_TARGET'});
 await assert.rejects(matchSignatureCompletionSigner(db,{},{}),{code:'INVALID_SIGNATURE_COMPLETION_COMPARISON'});assert.equal(connections,0);
 await assert.rejects(loadSignatureCompletionSource(db,target),e=>{assert.equal((e as {code:string}).code,'SIGNATURE_COMPLETION_SOURCE_UNAVAILABLE');assert.doesNotMatch(String(e),/PRIVATE|credentials|contact/);return true;});assert.equal(connections,1);
});
test('isolated completion role has only two bounded functions,no raw tables private identity or mutation rights',async()=>{
 const f=await operationsFixture();try{
  await f.pg.exec('SET ROLE kavosh_signature_completion_worker');try{
   await assertSignatureCompletionRole({query:f.pg.query.bind(f.pg),release(){}});
   for(const table of ['people','signature_dispatch_starts','signature_send_requests','signature_transport_receipts','agreement_packages','agreement_content_bindings','outbox_events'])await assert.rejects(f.pg.exec('SELECT * FROM public.'+table),/permission denied/i);
   await assert.rejects(f.pg.exec('SELECT * FROM identity.signature_signer_history'),/permission denied/i);
   await assert.rejects(f.pg.query('SELECT * FROM public.signature_dispatch_contact($1)',[randomUUID()]),/permission denied/i);
   assert.deepEqual((await f.pg.query('SELECT public.signature_completion_source($1,$2) source',[f.a,randomUUID()])).rows,[{source:null}]);
   assert.deepEqual((await f.pg.query('SELECT * FROM public.signature_completion_signer_matches($1,$2,$3,$4,$5,$6)',[f.a,randomUUID(),'a'.repeat(64),'PRIVATE','x@example.test','+16475550101'])).rows,[]);
  }finally{await f.pg.exec('RESET ROLE');}
  for(const role of ['kavosh_runtime','kavosh_identity','kavosh_delivery','kavosh_file_worker','kavosh_signature_result_worker','kavosh_automation_worker']){await f.pg.exec('SET ROLE '+role);try{await assert.rejects(f.pg.query('SELECT public.signature_completion_source($1,$2)',[f.a,randomUUID()]),/permission denied/i);await assert.rejects(f.pg.query('SELECT * FROM public.signature_completion_signer_matches($1,$2,$3,$4,$5,$6)',[f.a,randomUUID(),'a'.repeat(64),'PRIVATE','x@example.test','+16475550101']),/permission denied/i);}finally{await f.pg.exec('RESET ROLE');}}
 }finally{await f.pg.close();}
});
test('completion and web guards reject mixed roles and accidental raw-column authority',async()=>{
 const f=await operationsFixture();try{
  await f.pg.exec('GRANT SELECT(id) ON public.people TO kavosh_signature_completion_worker');try{await f.pg.exec('SET ROLE kavosh_signature_completion_worker');await assert.rejects(assertSignatureCompletionRole({query:f.pg.query.bind(f.pg),release(){}}),/UNSAFE_SIGNATURE_COMPLETION_ROLE/);}finally{await f.pg.exec('RESET ROLE');await f.pg.exec('REVOKE SELECT(id) ON public.people FROM kavosh_signature_completion_worker');}
  await f.pg.exec('GRANT kavosh_signature_completion_worker TO kavosh_runtime');try{await f.pg.exec('SET ROLE kavosh_runtime');await assert.rejects(assertRuntimeRole({query:f.pg.query.bind(f.pg),release(){}}),/UNSAFE_DATABASE_ROLE/);}finally{await f.pg.exec('RESET ROLE');await f.pg.exec('REVOKE kavosh_signature_completion_worker FROM kavosh_runtime');}
  await f.pg.exec('SET ROLE kavosh_signature_completion_worker');try{await assertSignatureCompletionRole({query:f.pg.query.bind(f.pg),release(){}});}finally{await f.pg.exec('RESET ROLE');}
 }finally{await f.pg.close();}
});
test('actual204to205 adds isolated historical source access without rewriting people approvals or signer history',async()=>{
 const f=await operationsFixture({throughSchema:204});try{
  const sql="SELECT jsonb_build_object('people',(SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM public.people p),'approvals',(SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM public.approval_requests p),'permissions',(SELECT jsonb_agg(to_jsonb(p) ORDER BY role_id,capability) FROM public.role_permissions p),'history',(SELECT jsonb_agg(to_jsonb(p) ORDER BY start_id) FROM identity.signature_signer_history p)) snapshot",before=(await f.pg.query(sql)).rows;
  const acl="SELECT oid,proowner,proacl FROM pg_proc WHERE oid='public.signature_dispatch_contact(uuid)'::regprocedure",original=(await f.pg.query(acl)).rows;
  await f.pg.exec(await readFile(new URL('../db/migrations/205_signature_completion_source.sql',import.meta.url),'utf8'));
  assert.equal((await f.pg.query('SELECT public.schema_revision() n')).rows[0].n,205);assert.deepEqual((await f.pg.query(sql)).rows,before);assert.deepEqual((await f.pg.query(acl)).rows,original);
  await f.pg.exec('SET ROLE kavosh_signature_completion_worker');try{await assertSignatureCompletionRole({query:f.pg.query.bind(f.pg),release(){}});assert.deepEqual((await f.pg.query('SELECT public.signature_completion_source($1,$2) source',[f.a,randomUUID()])).rows,[{source:null}]);}finally{await f.pg.exec('RESET ROLE');}
 }finally{await f.pg.close();}
});
