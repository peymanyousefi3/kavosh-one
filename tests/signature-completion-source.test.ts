import assert from 'node:assert/strict';
import { randomUUID,createHash } from 'node:crypto';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { upgradeToCurrent } from './migration-upgrade.ts';
import { operationsFixture } from './operations-fixture.ts';
import { assertRuntimeRole,type Database } from '../src/core/database.ts';
import { featureScope,scopeFor,type Credential,type Grant } from '../src/core/policy.ts';
import { assertSignatureCompletionRole,loadSignatureCompletionSource,matchSignatureCompletionSigner,loadWorkSignatureCompletionSource,matchWorkSignatureCompletionSigner,recordWorkSignatureCompletionEvidence } from '../src/integrations/signature-completion-source.ts';

test('completion source refuses arbitrary overrides before connecting and redacts unavailable connection details',async()=>{
 let connections=0;const db:Database={async connect(){connections++;throw Error('PRIVATE credentials and contact');}},target={academyId:randomUUID(),startId:randomUUID()};
 for(const value of [{...target,documentId:randomUUID()},{...target,sourceFingerprint:'a'.repeat(64)},{...target,signerId:randomUUID()},{...target,academyId:'other'}])await assert.rejects(loadSignatureCompletionSource(db,value),{code:'INVALID_SIGNATURE_COMPLETION_TARGET'});
 for(const value of [{...target,documentId:randomUUID()},{...target,sourceFingerprint:'a'.repeat(64)},{...target,parties:[]},{...target,academyId:'other'}])await assert.rejects(loadWorkSignatureCompletionSource(db,value),{code:'INVALID_SIGNATURE_COMPLETION_TARGET'});
 await assert.rejects(matchWorkSignatureCompletionSigner(db,{},'worker',{}),{code:'INVALID_SIGNATURE_COMPLETION_COMPARISON'});
 await assert.rejects(recordWorkSignatureCompletionEvidence(db,{...target,providerSigners:[]}),{code:'INVALID_SIGNATURE_COMPLETION_EVIDENCE'});
 await assert.rejects(matchSignatureCompletionSigner(db,{},{}),{code:'INVALID_SIGNATURE_COMPLETION_COMPARISON'});assert.equal(connections,0);
 await assert.rejects(loadSignatureCompletionSource(db,target),e=>{assert.equal((e as {code:string}).code,'SIGNATURE_COMPLETION_SOURCE_UNAVAILABLE');assert.doesNotMatch(String(e),/PRIVATE|credentials|contact/);return true;});assert.equal(connections,1);
});
test('isolated completion role has only bounded completion functions,no raw tables private identity or generic mutation rights',async()=>{
 const f=await operationsFixture();try{
  await f.pg.exec('SET ROLE kavosh_signature_completion_worker');try{
   await assertSignatureCompletionRole({query:f.pg.query.bind(f.pg),release(){}});
   for(const table of ['people','signature_dispatch_starts','signature_send_requests','signature_transport_receipts','agreement_packages','agreement_content_bindings','signature_completion_evidence','outbox_events'])await assert.rejects(f.pg.exec('SELECT * FROM public.'+table),/permission denied/i);
   await assert.rejects(f.pg.exec('SELECT * FROM identity.signature_signer_history'),/permission denied/i);
   await assert.rejects(f.pg.query('SELECT * FROM public.signature_dispatch_contact($1)',[randomUUID()]),/permission denied/i);
   assert.deepEqual((await f.pg.query('SELECT public.signature_completion_source($1,$2) source',[f.a,randomUUID()])).rows,[{source:null}]);
   assert.deepEqual((await f.pg.query('SELECT * FROM public.signature_completion_signer_matches($1,$2,$3,$4,$5,$6)',[f.a,randomUUID(),'a'.repeat(64),'PRIVATE','x@example.test','+16475550101'])).rows,[]);
   assert.deepEqual((await f.pg.query('SELECT public.work_signature_completion_source($1,$2) source',[f.a,randomUUID()])).rows,[{source:null}]);
   assert.deepEqual((await f.pg.query('SELECT * FROM public.work_signature_completion_signer_matches($1,$2,$3,$4,$5,$6,$7)',[f.a,randomUUID(),'a'.repeat(64),'worker','PRIVATE','x@example.test','+16475550101'])).rows,[]);
   for(const table of ['work_signature_dispatch_starts','work_signature_send_requests','work_signature_transport_receipts','work_agreement_contents','work_agreement_preparations','work_signature_completion_evidence'])await assert.rejects(f.pg.exec('SELECT * FROM public.'+table),/permission denied/i);
  }finally{await f.pg.exec('RESET ROLE');}
  for(const role of ['kavosh_runtime','kavosh_identity','kavosh_delivery','kavosh_file_worker','kavosh_signature_result_worker','kavosh_automation_worker']){await f.pg.exec('SET ROLE '+role);try{await assert.rejects(f.pg.query('SELECT * FROM public.record_work_signature_completion_evidence($1,$2,$3,$4,$5::jsonb)',[f.a,randomUUID(),'a'.repeat(64),'{}','{}']),/permission denied/i);await assert.rejects(f.pg.query('SELECT public.work_signature_completion_source($1,$2)',[f.a,randomUUID()]),/permission denied/i);await assert.rejects(f.pg.query('SELECT * FROM public.work_signature_completion_signer_matches($1,$2,$3,$4,$5,$6,$7)',[f.a,randomUUID(),'a'.repeat(64),'worker','PRIVATE','x@example.test','+16475550101']),/permission denied/i);await assert.rejects(f.pg.query('SELECT public.signature_completion_source($1,$2)',[f.a,randomUUID()]),/permission denied/i);await assert.rejects(f.pg.query('SELECT * FROM public.signature_completion_signer_matches($1,$2,$3,$4,$5,$6)',[f.a,randomUUID(),'a'.repeat(64),'PRIVATE','x@example.test','+16475550101']),/permission denied/i);await assert.rejects(f.pg.query('SELECT * FROM public.record_signature_completion_evidence($1,$2,$3,$4,$5::jsonb)',[f.a,randomUUID(),'a'.repeat(64),'{}','{}']),/permission denied/i);}finally{await f.pg.exec('RESET ROLE');}}
 }finally{await f.pg.close();}
});
test('actual205to206 preserves historical data and source function identity without manufacturing completed-signature evidence',async()=>{
 const f=await operationsFixture({throughSchema:205});try{
  const sql="SELECT jsonb_build_object('people',(SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM public.people p),'permissions',(SELECT jsonb_agg(to_jsonb(p) ORDER BY role_id,capability) FROM public.role_permissions p),'history',(SELECT jsonb_agg(to_jsonb(p) ORDER BY start_id) FROM identity.signature_signer_history p)) snapshot",before=(await f.pg.query(sql)).rows;
  const acl="SELECT oid,proowner,proacl FROM pg_proc WHERE oid='public.signature_completion_source(uuid,uuid)'::regprocedure",original=(await f.pg.query(acl)).rows;
  await f.pg.exec(await readFile(new URL('../db/migrations/206_signature_completion_evidence.sql',import.meta.url),'utf8'));assert.equal((await f.pg.query('SELECT public.schema_revision() n')).rows[0].n,206);assert.deepEqual((await f.pg.query(sql)).rows,before);assert.deepEqual((await f.pg.query(acl)).rows,original);assert.equal((await f.pg.query('SELECT * FROM public.signature_completion_evidence')).rows.length,0);
  // Deliberately choose vectors where the high/low half-byte differ. This
  // catches the reproduced UUID variant-bit interop bug deterministically.
  let checked=0;for(let i=0;i<1000&&checked<8;i++){const sha=createHash('sha256').update(String(i)).digest('hex'),start='00000000-0000-4000-8000-000000000001',fp='b'.repeat(64),hex=createHash('sha256').update(JSON.stringify(['kavosh-signature-evidence-v1',f.a,start,fp,'document',sha])).digest('hex').slice(0,32).split('');if((parseInt(hex[16],16)&3)===(parseInt(hex[17],16)&3))continue;hex[12]='8';hex[16]=((parseInt(hex[16],16)&3)|8).toString(16);const h=hex.join(''),id=`${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;assert.equal((await f.pg.query<{id:string}>('SELECT public.signature_evidence_artifact_id($1,$2,$3,$4,$5) id',[f.a,start,fp,'document',sha])).rows[0].id,id);checked++;}assert.equal(checked,8);
 }finally{await f.pg.close();}
});
test('completion and web guards reject mixed roles and accidental raw-column authority',async()=>{
 const f=await operationsFixture();try{
  await f.pg.exec('GRANT SELECT(id) ON public.people TO kavosh_signature_completion_worker');try{await f.pg.exec('SET ROLE kavosh_signature_completion_worker');await assert.rejects(assertSignatureCompletionRole({query:f.pg.query.bind(f.pg),release(){}}),/UNSAFE_SIGNATURE_COMPLETION_ROLE/);}finally{await f.pg.exec('RESET ROLE');await f.pg.exec('REVOKE SELECT(id) ON public.people FROM kavosh_signature_completion_worker');}
  await f.pg.exec('GRANT kavosh_signature_completion_worker TO kavosh_runtime');try{await f.pg.exec('SET ROLE kavosh_runtime');await assert.rejects(assertRuntimeRole({query:f.pg.query.bind(f.pg),release(){}}),/UNSAFE_DATABASE_ROLE/);}finally{await f.pg.exec('RESET ROLE');await f.pg.exec('REVOKE kavosh_signature_completion_worker FROM kavosh_runtime');}
  await f.pg.exec('SET ROLE kavosh_signature_completion_worker');try{await assertSignatureCompletionRole({query:f.pg.query.bind(f.pg),release(){}});}finally{await f.pg.exec('RESET ROLE');}
 }finally{await f.pg.close();}
});
test('completion metadata grants no archive columns or automatic roles and preserves exact class/person feature scopes',async()=>{
 const f=await operationsFixture();try{
  assert.equal((await f.pg.query("SELECT * FROM public.role_permissions WHERE capability='signature-completions.view'")).rows.length,0);
  const scope={all:false,hubs:[],classes:[{id:randomUUID(),hubId:f.hub}],people:[{id:f.actors.staff.person,hubId:f.hub}],excludedClasses:[{id:randomUUID(),hubId:f.hub}],excludedPeople:[{id:randomUUID(),hubId:f.hub}]};assert.deepEqual(featureScope(scope,'signature-completions.view'),scope);
  await f.pg.exec('SET ROLE kavosh_runtime');try{
   await f.pg.query("SELECT set_config('app.academy_id',$1,false)",[f.a]);await f.pg.exec('SELECT id,start_id,state,review_reasons,recorded_at FROM public.signature_completion_evidence');
   for(const column of ['manifest','source','source_fingerprint','evidence_fingerprint','provider_signer_id','recorded_by'])await assert.rejects(f.pg.exec('SELECT '+column+' FROM public.signature_completion_evidence'),/permission denied/i);
   assert.deepEqual((await f.pg.query('SELECT public.signature_completion_source_current($1) current',[randomUUID()])).rows,[{current:null}]);
  }finally{await f.pg.exec('RESET ROLE');}
 }finally{await f.pg.close();}
});
test('work completion directory grants only metadata columns,no automatic roles or archive authority',async()=>{
 const f=await operationsFixture();try{
  assert.equal((await f.pg.query("SELECT * FROM public.role_permissions WHERE capability='work-signature-completions.view'")).rows.length,0);
  const scope={all:false,hubs:[],people:[{id:f.actors.staff.person,hubId:f.hub}],excludedPeople:[{id:f.actors.peer.person,hubId:f.otherHub}]};assert.deepEqual(featureScope(scope,'work-signature-completions.view'),scope);
  await f.pg.exec('SET ROLE kavosh_runtime');try{await f.pg.query("SELECT set_config('app.academy_id',$1,false)",[f.a]);await f.pg.exec('SELECT id,start_id,state,review_reasons,recorded_at FROM public.work_signature_completion_evidence');for(const column of ['manifest','source','source_fingerprint','provider_signers','evidence_fingerprint','recorded_by'])await assert.rejects(f.pg.exec('SELECT '+column+' FROM public.work_signature_completion_evidence'),/permission denied/i);assert.deepEqual((await f.pg.query('SELECT public.work_signature_completion_source_current($1) current',[randomUUID()])).rows,[{current:null}]);}finally{await f.pg.exec('RESET ROLE');}
 }finally{await f.pg.close();}
});
test('work completion selected-person grants retain actual work-hub ceilings and explicit denials independently of primary hub',async()=>{
 const f=await operationsFixture();try{const capability='work-signature-completions.view' as const,credential:Credential={token_id:f.credential,person_id:f.actors.manager.person,academy_id:f.a,capabilities:[capability],all_hubs:false,hub_ids:[f.hub],allowed:true},allow:Grant={capability,effect:'allow',allHubs:false,hubIds:[],personRefs:[{id:f.actors.staff.person,hubId:f.otherHub}]};
  const cases:[Grant[],string,boolean][]=[[[allow],f.hub,true],[[allow],f.otherHub,false],[[allow,{capability,effect:'deny',allHubs:false,hubIds:[f.hub]}],f.hub,false],[[allow,{capability,effect:'deny',allHubs:false,hubIds:[],personRefs:[{id:f.actors.staff.person,hubId:f.otherHub}]}],f.hub,false]];
  for(const [grants,hub,expected]of cases){const scope=scopeFor(credential,grants,capability);assert.deepEqual(scope.recordHubIds,[f.hub]);assert.equal((await f.pg.query<{ok:boolean}>('SELECT public.work_scope_allows($1::jsonb,$2,$3) ok',[JSON.stringify(scope),hub,f.actors.staff.person])).rows[0].ok,expected);}
 }finally{await f.pg.close();}
});
test('actual206to207 preserves people roles and private source-function ownership while adding only metadata access',async()=>{
 const f=await operationsFixture({throughSchema:206});try{
  const sql="SELECT jsonb_build_object('people',(SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM public.people p),'permissions',(SELECT jsonb_agg(to_jsonb(p) ORDER BY role_id,capability) FROM public.role_permissions p),'evidence',(SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM public.signature_completion_evidence p)) snapshot",before=(await f.pg.query(sql)).rows,acl="SELECT oid,proowner,proacl FROM pg_proc WHERE oid='public.signature_completion_source(uuid,uuid)'::regprocedure",original=(await f.pg.query(acl)).rows;
  await f.pg.exec(await readFile(new URL('../db/migrations/207_signature_completion_directory.sql',import.meta.url),'utf8'));assert.equal((await f.pg.query('SELECT public.schema_revision() n')).rows[0].n,207);assert.deepEqual((await f.pg.query(sql)).rows,before);assert.deepEqual((await f.pg.query(acl)).rows,original);
 }finally{await f.pg.close();}
});
test('actual204to205 adds isolated historical source access without rewriting people approvals or signer history',async()=>{
 const f=await operationsFixture({throughSchema:204});try{
  const sql="SELECT jsonb_build_object('people',(SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM public.people p),'approvals',(SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM public.approval_requests p),'permissions',(SELECT jsonb_agg(to_jsonb(p) ORDER BY role_id,capability) FROM public.role_permissions p),'history',(SELECT jsonb_agg(to_jsonb(p) ORDER BY start_id) FROM identity.signature_signer_history p)) snapshot",before=(await f.pg.query(sql)).rows;
  const acl="SELECT oid,proowner,proacl FROM pg_proc WHERE oid='public.signature_dispatch_contact(uuid)'::regprocedure",original=(await f.pg.query(acl)).rows;
  await f.pg.exec(await readFile(new URL('../db/migrations/205_signature_completion_source.sql',import.meta.url),'utf8'));
  assert.equal((await f.pg.query('SELECT public.schema_revision() n')).rows[0].n,205);assert.deepEqual((await f.pg.query(sql)).rows,before);assert.deepEqual((await f.pg.query(acl)).rows,original);
  await f.pg.exec('SET ROLE kavosh_signature_completion_worker');try{assert.deepEqual((await f.pg.query('SELECT public.signature_completion_source($1,$2) source',[f.a,randomUUID()])).rows,[{source:null}]);}finally{await f.pg.exec('RESET ROLE');}
  await upgradeToCurrent(f.pg);await f.pg.exec('SET ROLE kavosh_signature_completion_worker');try{await assertSignatureCompletionRole({query:f.pg.query.bind(f.pg),release(){}});}finally{await f.pg.exec('RESET ROLE');}
 }finally{await f.pg.close();}
});
