import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { operationsFixture } from './operations-fixture.ts';
import { assertSignatureEvidenceRole,loadSignatureEvidenceInspectionTask,recordSignatureEvidenceInspection } from '../src/integrations/signature-evidence-worker.ts';
import { assertRuntimeRole,type Database } from '../src/core/database.ts';
import { assertFileWorkerRole } from '../src/files/inspection-worker.ts';

test('inspection task and result wrappers reject caller overrides before connecting and redact unavailable credentials',async()=>{
 let connections=0;const database:Database={async connect(){connections++;throw Error('PRIVATE credentials');}},target={academyId:randomUUID(),evidenceId:randomUUID(),kind:'document'};
 for(const raw of [{...target,artifactId:randomUUID()},{...target,sha256:'a'.repeat(64)},{...target,kind:'properties'},{...target,admissionCleared:true}])await assert.rejects(loadSignatureEvidenceInspectionTask(database,raw),{code:'INVALID_SIGNATURE_EVIDENCE_TARGET'});
 await assert.rejects(recordSignatureEvidenceInspection(database,{...target,operationId:randomUUID(),sourceFingerprint:'a'.repeat(64),result:{outcome:'screened',safeToServe:true}}),{code:'INVALID_SIGNATURE_EVIDENCE_RESULT'});assert.equal(connections,0);
 await assert.rejects(loadSignatureEvidenceInspectionTask(database,target),e=>{assert.equal((e as {code:string}).code,'SIGNATURE_EVIDENCE_DATABASE_UNAVAILABLE');assert.doesNotMatch(String(e),/PRIVATE|credentials/);return true;});
});
test('isolated archive inspector has only task receipt and replay functions,no raw tables identities provider authority or web membership',async()=>{
 const f=await operationsFixture();try{
  await f.pg.exec('SET ROLE kavosh_signature_evidence_worker');try{await assertSignatureEvidenceRole({query:f.pg.query.bind(f.pg),release(){}});for(const table of ['people','signature_completion_evidence','signature_evidence_inspections','outbox_events'])await assert.rejects(f.pg.exec('SELECT * FROM public.'+table),/permission denied/i);await assert.rejects(f.pg.exec('SELECT * FROM identity."user"'),/permission denied/i);assert.deepEqual((await f.pg.query('SELECT public.signature_evidence_inspection_source($1,$2,$3) source',[f.a,randomUUID(),'document'])).rows,[{source:null}]);assert.deepEqual((await f.pg.query('SELECT public.signature_evidence_inspection_recorded($1,$2,$3,$4) recorded',[f.a,randomUUID(),randomUUID(),'document'])).rows,[{recorded:false}]);await assert.rejects(f.pg.query('SELECT public.signature_completion_source($1,$2)',[f.a,randomUUID()]),/permission denied/i);}finally{await f.pg.exec('RESET ROLE');}
  for(const role of ['kavosh_runtime','kavosh_identity','kavosh_delivery','kavosh_file_worker','kavosh_signature_completion_worker']){await f.pg.exec('SET ROLE '+role);try{await assert.rejects(f.pg.query('SELECT public.signature_evidence_inspection_source($1,$2,$3)',[f.a,randomUUID(),'document']),/permission denied/i);await assert.rejects(f.pg.query('SELECT public.record_signature_evidence_inspection($1,$2,$3,$4,$5,$6::jsonb)',[f.a,randomUUID(),randomUUID(),'document','a'.repeat(64),'{}']),/permission denied/i);}finally{await f.pg.exec('RESET ROLE');}}
 }finally{await f.pg.close();}
});
test('native signed receipt validator reuses original geometry without allowing policy2 to become unsigned upload clearance (synthetic contract logic)',async()=>{
 const f=await operationsFixture();try{
  const p={validator:'pikepdf@10.17.0',qpdf:'12.4.2',policyVersion:2,profile:'signed-evidence',cryptographicValidityVerified:false,inputBytes:100,inputSha256:'a'.repeat(64),maximumPages:1000,maximumObjects:50000,maximumDepth:64,resources:{peakRssKiB:1,userCpuMicros:0,systemCpuMicros:0},outcome:'screened',pageCount:1,objectCount:5,pages:[{mediaBox:[0,0,612,792],cropBox:[0,0,612,792],rotation:0,userUnit:1}],interactiveForms:true,coordinateSpace:'pdf-default-user-space',signatureCount:1,signatures:[{byteRange:[0,10,20,80],contentsBytes:4,coversWholeFile:true}]};
  const valid=async(value:unknown)=>(await f.pg.query<{valid:boolean}>('SELECT public.valid_signature_evidence_pdf($1::jsonb) valid',[JSON.stringify(value)])).rows[0].valid;assert.equal(await valid(p),true);assert.equal((await f.pg.query<{valid:boolean}>('SELECT public.valid_file_pdf_evidence($1::jsonb) valid',[JSON.stringify(p)])).rows[0].valid,false);
  for(const value of [null,{}, {...p,policyVersion:1},{...p,cryptographicValidityVerified:true},{...p,safeToServe:true},{...p,signatureCount:2},{...p,signatureCount:101},{...p,signatures:[{...p.signatures[0],byteRange:[0,20,10,80]}]},{...p,signatures:[{...p.signatures[0],coversWholeFile:false}]},{...p,signatures:[{...p.signatures[0],contentsBytes:5}]},{...p,pages:[{...p.pages[0],rotation:45}]},{...p,inputSha256:'wrong'},{...p,resources:{...p.resources,peakRssKiB:0}}])assert.equal(await valid(value),false,JSON.stringify(value));
  assert.equal(await valid({...p,signatureCount:0,signatures:[]}),true,'unsigned audit files remain a distinct structural observation,not a signature');
 }finally{await f.pg.close();}
});
test('archive inspector guards reject raw-column access and mixing ordinary web or file-worker authority',async()=>{
 const f=await operationsFixture();try{
  await f.pg.exec('GRANT SELECT(id) ON public.people TO kavosh_signature_evidence_worker');try{await f.pg.exec('SET ROLE kavosh_signature_evidence_worker');await assert.rejects(assertSignatureEvidenceRole({query:f.pg.query.bind(f.pg),release(){}}),/UNSAFE_SIGNATURE_EVIDENCE_ROLE/);}finally{await f.pg.exec('RESET ROLE');await f.pg.exec('REVOKE SELECT(id) ON public.people FROM kavosh_signature_evidence_worker');}
  for(const [role,guard,error] of [['kavosh_runtime',assertRuntimeRole,'UNSAFE_DATABASE_ROLE'],['kavosh_file_worker',assertFileWorkerRole,'UNSAFE_FILE_WORKER_ROLE']] as const){await f.pg.exec('GRANT kavosh_signature_evidence_worker TO '+role);try{await f.pg.exec('SET ROLE '+role);await assert.rejects(guard({query:f.pg.query.bind(f.pg),release(){}}),new RegExp(error));}finally{await f.pg.exec('RESET ROLE');await f.pg.exec('REVOKE kavosh_signature_evidence_worker FROM '+role);}}
 }finally{await f.pg.close();}
});
test('actual207to208 preserves completion metadata permissions and original unsigned validator definition without manufacturing inspections',async()=>{
 const f=await operationsFixture({throughSchema:207});try{const sql="SELECT jsonb_build_object('people',(SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM public.people p),'evidence',(SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM public.signature_completion_evidence p),'permissions',(SELECT jsonb_agg(to_jsonb(p) ORDER BY role_id,capability) FROM public.role_permissions p)) snapshot",before=(await f.pg.query(sql)).rows,definition="SELECT oid,proowner,pg_get_functiondef(oid) definition FROM pg_proc WHERE oid='public.valid_file_pdf_evidence(jsonb)'::regprocedure",original=(await f.pg.query(definition)).rows;await f.pg.exec(await readFile(new URL('../db/migrations/208_signature_evidence_inspections.sql',import.meta.url),'utf8'));assert.equal((await f.pg.query('SELECT public.schema_revision() n')).rows[0].n,208);assert.deepEqual((await f.pg.query(sql)).rows,before);assert.deepEqual((await f.pg.query(definition)).rows,original);assert.equal((await f.pg.query('SELECT * FROM public.signature_evidence_inspections')).rows.length,0);}finally{await f.pg.close();}
});
