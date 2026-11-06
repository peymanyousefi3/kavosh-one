import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { operationsFixture } from './operations-fixture.ts';
import { assertRuntimeRole,expectedSchemaRevision,type Database } from '../src/core/database.ts';
import { assertSignatureResultRole,probeSignatureResultSink,recordSignatureTransportReceipt } from '../src/integrations/signature-result-worker.ts';

const outcome={state:'outcome_unknown',automaticRetryAllowed:false,reconciliationRequired:true,deliveryVerified:false};
test('result sink preflight checks native policy grants and refuses an unrelated committed start',async()=>{
 const f=await operationsFixture();
 const database:Database={async connect(){const c=f.pg.runtime?await f.pg.runtime.connect():{query:f.pg.query.bind(f.pg),release(){}};await c.query('SET ROLE kavosh_signature_result_worker');return c;}};
 try{
  await probeSignatureResultSink(database);if(!f.pg.runtime)await f.pg.exec('RESET ROLE');
  await assert.rejects(probeSignatureResultSink(database,{academyId:f.a,startId:randomUUID(),sourceFingerprint:'a'.repeat(64)}),{code:'SIGNATURE_TRANSPORT_RECEIPT_UNAVAILABLE'});if(!f.pg.runtime)await f.pg.exec('RESET ROLE');
  await f.pg.exec('REVOKE INSERT ON public.signature_transport_receipts FROM kavosh_signature_result_policy');
  await assert.rejects(probeSignatureResultSink(database),{code:'SIGNATURE_TRANSPORT_RECEIPT_UNAVAILABLE'});
 }finally{await f.pg.exec('RESET ROLE');await f.pg.exec('GRANT INSERT ON public.signature_transport_receipts TO kavosh_signature_result_policy');await f.pg.close();}
});
test('receipt connection failures never expose operator credentials or private diagnostics',async()=>{
 const database:Database={async connect(){throw new Error('PRIVATE synthetic operator credential');}};await assert.rejects(recordSignatureTransportReceipt(database,{academyId:randomUUID(),startId:randomUUID(),workerId:randomUUID(),outcome}),e=>{assert.equal((e as {code:string}).code,'SIGNATURE_TRANSPORT_RECEIPT_UNAVAILABLE');assert.doesNotMatch(String(e),/PRIVATE|credential/);return true;});
});
test('result recorder strictly rejects invented signing proof,private payloads and malformed identities before connecting',async()=>{
 let calls=0;const database:Database={async connect(){calls++;throw new Error('MUST_NOT_CONNECT');}},valid={academyId:randomUUID(),startId:randomUUID(),workerId:randomUUID(),outcome};
 for(const raw of [{...valid,academyId:'other'},{...valid,privateBody:'PRIVATE'},{...valid,outcome:{...outcome,providerVerified:true}},{...valid,outcome:{...outcome,deliveryVerified:true}},{...valid,outcome:{...outcome,state:'completed'}},{...valid,outcome:{...outcome,reconciliationRequired:false}},{...valid,outcome:{...outcome,documentId:randomUUID()}},{...valid,outcome:{...outcome,state:'accepted_for_processing'}}])await assert.rejects(recordSignatureTransportReceipt(database,raw),{code:'INVALID_SIGNATURE_TRANSPORT_RECEIPT',status:400});assert.equal(calls,0);
});
test('receipt status mapping never hides a conflict behind a not-attempted outcome (isolated logic,not role evidence)',async()=>{
 for(const status of ['recorded_conflict','duplicate_conflict','conflict']){
  let calls=0,released=false;const database:Database={async connect(){return {async query<Row>(){calls++;return {rows:[calls===1?{safe:true}:calls===2?{revision:expectedSchemaRevision}:{status}] as Row[]};},release(){released=true;}};}};
  const result=await recordSignatureTransportReceipt(database,{academyId:randomUUID(),startId:randomUUID(),workerId:randomUUID(),outcome:{state:'not_attempted',automaticRetryAllowed:false,reconciliationRequired:false,deliveryVerified:false}});assert.equal(result.recorded,true);assert.equal(result.conflict,true);assert.equal(result.reconciliationRequired,true);assert.equal(result.providerVerified,false);assert.equal(released,true);
 }
});
test('result role has one narrow entry point,no table or identity access,and cannot record unknown authority',async()=>{
 const f=await operationsFixture();try{
  await f.pg.exec('SET ROLE kavosh_signature_result_worker');try{
   await assertSignatureResultRole({query:f.pg.query.bind(f.pg),release(){}});
   for(const table of ['people','signature_dispatch_starts','signature_transport_receipts','signature_transport_conflicts','outbox_events'])await assert.rejects(f.pg.exec('SELECT * FROM public.'+table),/permission denied/i);
   await assert.rejects(f.pg.exec('SELECT email FROM identity."user"'),/permission denied/i);
   await assert.rejects(f.pg.query('SELECT * FROM public.signer_verification_status($1)',[f.actors.staff.person]),/permission denied/i);
  }finally{await f.pg.exec('RESET ROLE');}
  const database:Database={async connect(){const c=f.pg.runtime?await f.pg.runtime.connect():{query:f.pg.query.bind(f.pg),release(){}};await c.query('SET ROLE kavosh_signature_result_worker');return c;}};
  try{const result=await recordSignatureTransportReceipt(database,{academyId:f.a,startId:randomUUID(),workerId:randomUUID(),outcome});assert.equal(result.status,'unavailable');assert.equal(result.recorded,false);assert.equal(result.reconciliationRequired,true);}finally{if(!f.pg.runtime)await f.pg.exec('RESET ROLE');}
  for(const role of ['kavosh_runtime','kavosh_file_worker','kavosh_signature_ingest']){await f.pg.exec('SET ROLE '+role);try{await assert.rejects(f.pg.query('SELECT public.record_signature_transport_receipt($1,$2,$3,$4,$5)',[f.a,randomUUID(),randomUUID(),'outcome_unknown',null]),/permission denied/i);}finally{await f.pg.exec('RESET ROLE');}}
  assert.equal((await f.pg.query('SELECT * FROM public.signature_transport_receipts')).rows.length,0);
 }finally{await f.pg.close();}
});
test('role guards reject accidental raw-table grants or mixing the web and result-recorder roles',async()=>{
 const f=await operationsFixture();try{
  await f.pg.exec('GRANT SELECT(id) ON public.people TO kavosh_signature_result_worker');try{await f.pg.exec('SET ROLE kavosh_signature_result_worker');await assert.rejects(assertSignatureResultRole({query:f.pg.query.bind(f.pg),release(){}}),/UNSAFE_SIGNATURE_RESULT_ROLE/);}finally{await f.pg.exec('RESET ROLE');await f.pg.exec('REVOKE SELECT(id) ON public.people FROM kavosh_signature_result_worker');}
  await f.pg.exec('GRANT kavosh_signature_result_worker TO kavosh_runtime');try{await f.pg.exec('SET ROLE kavosh_runtime');await assert.rejects(assertRuntimeRole({query:f.pg.query.bind(f.pg),release(){}}),/UNSAFE_DATABASE_ROLE/);}finally{await f.pg.exec('RESET ROLE');await f.pg.exec('REVOKE kavosh_signature_result_worker FROM kavosh_runtime');}
  await f.pg.exec('SET ROLE kavosh_signature_result_worker');try{await assertSignatureResultRole({query:f.pg.query.bind(f.pg),release(){}});}finally{await f.pg.exec('RESET ROLE');}
 }finally{await f.pg.close();}
});
test('a restricted prefixed service role passes validation,but database-creation authority is refused',async()=>{
 const f=await operationsFixture(),role='kavosh_result_test_'+randomUUID().replaceAll('-','');let created=false;try{
  await f.pg.exec('CREATE ROLE '+role+' NOLOGIN NOSUPERUSER NOCREATEROLE NOCREATEDB NOREPLICATION NOBYPASSRLS');created=true;await f.pg.exec('GRANT kavosh_signature_result_worker TO '+role);await f.pg.exec('SET ROLE '+role);await assertSignatureResultRole({query:f.pg.query.bind(f.pg),release(){}});await f.pg.exec('RESET ROLE');
  await f.pg.exec('ALTER ROLE '+role+' CREATEDB');await f.pg.exec('SET ROLE '+role);await assert.rejects(assertSignatureResultRole({query:f.pg.query.bind(f.pg),release(){}}),/UNSAFE_SIGNATURE_RESULT_ROLE/);
 }finally{await f.pg.exec('RESET ROLE');if(created)await f.pg.exec('DROP ROLE '+role);await f.pg.close();}
});
