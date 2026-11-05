import assert from 'node:assert/strict';
import { randomUUID,createHash } from 'node:crypto';
import { readFile,mkdtemp,rmdir } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import sharp from 'sharp';
import { operationsFixture } from './operations-fixture.ts';
import { processOneInspection,inspectStoredFile,type InspectionResult,type InspectionTask } from '../src/files/inspection-worker.ts';
import { validateImage } from '../src/files/image-validation.ts';
import { detectContentSignature } from '../src/files/content-signature.ts';
import type { Database } from '../src/core/database.ts';
import { createImageValidationServer } from '../src/files/image-service.ts';
import { clamdPeer } from './fixtures/clamd-peer.ts';

const connection={accountId:'a'.repeat(32),jurisdiction:'default' as const,bucket:'synthetic-image-evidence',accessKeyId:'synthetic-id',secretAccessKey:'synthetic-not-real-secret',maximumUploadBytes:100000};
const sha=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
async function fixture(throughSchema?:number) {
 const f=await operationsFixture({connections:()=>connection,throughSchema});
 const bytes=await sharp({create:{width:8,height:4,channels:3,background:'red'}}).png().toBuffer();
 const configured=await f.request('storage-policy',{expectedVersion:0,uploadsEnabled:true,maximumFileBytes:100000,maximumReservedBytes:1000000,maximumFiles:100,allowedMimeTypes:['image/png','image/jpeg','text/plain'],reason:'Synthetic image evidence policy'});assert.equal(configured.response.status,200,JSON.stringify(configured.body));
 const database:Database={async connect(){const c=f.pg.runtime?await f.pg.runtime.connect():{async query<Row>(sql:string,params?:unknown[]){return f.pg.query<Row>(sql,params);},release(){}};await c.query('SET ROLE kavosh_file_worker');return c;}};
 async function workerQuery<Row=Record<string,unknown>>(sql:string,params?:unknown[]){const c=await database.connect();try{return await c.query<Row>(sql,params);}finally{c.release();if(!f.pg.runtime)await f.pg.exec('RESET ROLE');}}
 async function prepare(content=bytes,claim='image/png',hub=f.hub) {
  const file=await f.request('files',{anchor:{kind:'hub',id:hub},name:'Untrusted image.png',claimedMimeType:claim,expectedBytes:content.length,expectedSha256:sha(content)});assert.equal(file.response.status,201,JSON.stringify(file.body));
  const id=file.body.data.id,grant=await f.request('files/'+id+'/upload-link',{expectedMetadataVersion:1});assert.equal(grant.response.status,201);
  const inspection=await f.request('files/'+id+'/inspection',{expectedMetadataVersion:1,grantId:grant.body.data.id});assert.equal(inspection.response.status,202);
  return {id,grantId:grant.body.data.id,inspectionId:inspection.body.data.id};
 }
 async function evidence(content=bytes):Promise<InspectionResult> {
  return {outcome:'no_detection',bytes:content.length,sha256:sha(content),etag:'"synthetic-image"',providerContentType:'application/octet-stream',
   signature:await detectContentSignature(content),imageValidation:await validateImage(content,'image/png')};
 }
 async function run(result:InspectionResult|((task:InspectionTask,signal:AbortSignal)=>Promise<InspectionResult>)){try{return await processOneInspection(database,[f.a],randomUUID(),typeof result==='function'?result:async()=>result);}finally{if(!f.pg.runtime)await f.pg.exec('RESET ROLE');}}
 const claim=async()=>(await workerQuery('SELECT * FROM public.claim_file_inspection($1,$2,30)',[[f.a],randomUUID()])).rows[0];
 async function finish(job:Record<string,unknown>,result:InspectionResult,image?:unknown){assert.equal(result.outcome,'no_detection');if(result.outcome!=='no_detection')throw new Error('TEST_RESULT_REQUIRED');return (await workerQuery<{recorded:boolean}>('SELECT public.finish_file_inspection($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb) AS recorded',
  [job.academy_id,job.inspection_id,job.lease_token,result.outcome,'MEASURED_NO_DETECTION',result.bytes,result.sha256,result.etag,result.providerContentType,JSON.stringify(result.signature),image===undefined?JSON.stringify(result.imageValidation):JSON.stringify(image)])).rows[0].recorded;}
 async function assertEmpty(){for(const table of ['file_inspection_attempts','file_content_signatures','file_format_assessments','file_image_evidence'])assert.equal((await f.pg.query('SELECT * FROM public.'+table)).rows.length,0,table);}
 return {...f,bytes,prepare,evidence,run,claim,finish,workerQuery,assertEmpty};
}
type Fixture=Awaited<ReturnType<typeof fixture>>;
function check(name:string,run:(f:Fixture)=>Promise<void>){test(name,async()=>{const f=await fixture();try{await run(f);}finally{await f.pg.close();}});}

check('actual worker pipeline composes streamed storage, scanner protocol, native Unix decoding and exact persisted receipts without re-reading objects',async f=>{
 const directory=await mkdtemp('/tmp/kavosh-image-pipeline-'),socketPath=directory+'/service.sock',server=createImageValidationServer();let imageRequests=0;
 server.on('request',req=>{imageRequests++;assert.equal(req.headers.cookie,undefined);assert.equal(req.headers.authorization,undefined);assert.equal(req.headers['x-academy-id'],undefined);});
 await new Promise<void>(resolve=>server.listen(socketPath,resolve));
 try {
  for(const mode of ['success','detected','error']) {
   const item=await f.prepare(),peer=await clamdPeer(mode);let reads=0;const body=Readable.from([f.bytes.subarray(0,40),f.bytes.subarray(40)]);
   try {
    assert.deepEqual(await f.run((task,signal)=>inspectStoredFile(task,()=>connection,peer.config,signal,5000,{async handle(){reads++;return {response:{statusCode:200,headers:{'content-length':String(f.bytes.length),'content-type':'application/octet-stream',etag:'"synthetic-image"'},body}};}},{socketPath})),{claimed:true,recorded:true});
    assert.equal(reads,1);assert.equal(peer.connections(),1);assert.deepEqual(Buffer.concat(peer.received),f.bytes);assert.equal(body.destroyed,true);
    const v=(await f.request('files/'+item.id+'/inspection')).body.data;assert.equal(v.safeToServe,false);
    if(mode==='success'){assert.equal(v.attempts[0].imageValidation.result.outcome,'decoded');assert.equal(v.attempts[0].imageValidation.result.inputSha256,sha(f.bytes));}
    else{assert.equal(v.attempts[0].imageValidation,null);assert.equal(v.processing.lastOutcome,mode==='detected'?'detected':'unavailable');}
   }finally{body.destroy();await peer.close();}
  }
  assert.equal(imageRequests,1,'detected malware and failed scans must never reach native decoding');
 }finally{await new Promise<void>(resolve=>{server.close(()=>resolve());server.closeAllConnections();});await rmdir(directory);}
});
check('an unavailable image service remains a retryable target failure without persisting a fabricated rejection or full-pixel proof',async f=>{
 const item=await f.prepare(),peer=await clamdPeer('success');try {
  await f.run((task,signal)=>inspectStoredFile(task,()=>connection,peer.config,signal,5000,{async handle(){return {response:{statusCode:200,headers:{'content-length':String(f.bytes.length),'content-type':'application/octet-stream',etag:'"synthetic-image"'},body:Readable.from([f.bytes])}};}},{socketPath:'/private/tmp/'+randomUUID()+'.sock'}));
  const v=(await f.request('files/'+item.id+'/inspection')).body.data;assert.equal(v.processing.state,'queued');assert.equal(v.processing.lastReason,'TARGET_UNAVAILABLE');assert.equal(v.attempts[0].imageValidation,null);
  assert.equal((await f.pg.query('SELECT * FROM public.file_image_evidence')).rows.length,0);
 }finally{await peer.close();}
});
check('invalid image destinations and oversized native-image work fail before any object read or scanner connection',async f=>{
 await f.prepare();const value=await f.evidence();let task!:InspectionTask;await f.run(async t=>{task=t;return value;});
 const peer=await clamdPeer('success');let reads=0,lookups=0;try {
  const connections=()=>{lookups++;return connection;},handler={async handle(){reads++;throw new Error('MUST_NOT_READ');}};
  assert.deepEqual(await inspectStoredFile(task,connections,peer.config,new AbortController().signal,5000,handler,{socketPath:'https://localhost'}),{outcome:'unavailable',reason:'TARGET_UNAVAILABLE'});
  assert.deepEqual(await inspectStoredFile({...task,expectedBytes:33_554_433},connections,peer.config,new AbortController().signal,5000,handler,{socketPath:'/private/tmp/not-contacted.sock'}),{outcome:'unavailable',reason:'TARGET_UNAVAILABLE'});
  assert.equal(reads,0);assert.equal(lookups,0);assert.equal(peer.connections(),0);
 }finally{await peer.close();}
});

check('actual full-pixel receipts persist with exact measured-attempt identity and remain evidence rather than download permission',async f=>{
 const item=await f.prepare(),value=await f.evidence(),job=await f.claim();assert.equal(await f.finish(job,value),true);assert.equal(await f.finish(job,value),false);
 const response=await f.request('files/'+item.id+'/inspection');assert.equal(response.response.status,200);const v=response.body.data;
 assert.equal(v.safeToServe,false);assert.equal(v.uploadVerified,false);assert.equal(v.physicalStorageVerified,false);assert.equal(v.attempts[0].formatAssessment.structurallyValidated,false);
 assert.deepEqual(v.attempts[0].imageValidation.result,value.outcome==='no_detection'?value.imageValidation:null);assert.ok(v.attempts[0].imageValidation.recordedAt);
 const stored=(await f.pg.query('SELECT input_bytes::float8 AS bytes,input_sha256 AS hash,result FROM public.file_image_evidence')).rows[0];assert.equal(stored.bytes,f.bytes.length);assert.equal(stored.hash,sha(f.bytes));assert.equal((stored.result as {outcome:string}).outcome,'decoded');
 assert.equal((await f.pg.query("SELECT * FROM public.outbox_events WHERE event_type='file.image.decoded'")).rows.length,1);
});
check('corrupt pixels retain a bound rejected decoder receipt and critical event even when signature sniffing matches',async f=>{
 const corrupt=Buffer.from(f.bytes);corrupt[corrupt.indexOf('IDAT')+8]^=255;
 const item=await f.prepare(corrupt),value=await f.evidence(corrupt);assert.equal(value.outcome==='no_detection'?value.imageValidation?.outcome:null,'rejected');
 assert.deepEqual(await f.run(value),{claimed:true,recorded:true});const v=(await f.request('files/'+item.id+'/inspection')).body.data;
 assert.equal(v.attempts[0].formatAssessment.state,'matched');assert.equal(v.attempts[0].imageValidation.result.reason,'DECODER_REJECTED');assert.equal(v.safeToServe,false);
 assert.equal((await f.pg.query("SELECT * FROM public.outbox_events WHERE event_type='file.image.rejected.critical'")).rows.length,1);
});
check('native image boundary rejects altered hashes, byte counts, types, versions, resource metrics and contradictory raster dimensions atomically',async f=>{
 await f.prepare();const value=await f.evidence(),job=await f.claim();assert.equal(value.outcome,'no_detection');if(value.outcome!=='no_detection'||value.imageValidation?.outcome!=='decoded')throw new Error('ACTUAL_DECODE_REQUIRED');
 const r=value.imageValidation;
 for(const invalid of [{...r,inputSha256:'0'.repeat(64)},{...r,inputBytes:r.inputBytes+1},{...r,inputBytes:String(r.inputBytes)},{...r,validator:'unreviewed'},
  {...r,libvips:'other'},{...r,width:r.width+1},{...r,maximumPixels:1},{...r,maximumFrames:0},{...r,decodedBytes:0},{...r,decodedSha256:null},
  {...r,mime:'image/jpeg'},{...r,mime:null},{...r,resources:null},{...r,resources:{...r.resources,peakRssKiB:0}},{...r,resources:{...r.resources,secret:'PRIVATE'}},
  {...r,safeToServe:true},{...r,outcome:null},{...r,outcome:'rejected',reason:'DECODER_REJECTED'},[],{}]) {
  await assert.rejects(f.finish(job,value,invalid),/INVALID_FILE_IMAGE_EVIDENCE/);await f.assertEmpty();
 }
 await assert.rejects(f.finish(job,{...value,signature:undefined}),/INVALID_FILE_IMAGE_EVIDENCE/);await f.assertEmpty();
 assert.equal((await f.pg.query('SELECT state FROM public.file_inspection_jobs')).rows[0].state,'running');assert.equal(await f.finish(job,value),true);
});
check('worker rejects malformed or differently bound image evidence without fabricating a decoder decision',async f=>{
 const value=await f.evidence();if(value.outcome!=='no_detection'||!value.imageValidation)throw new Error('ACTUAL_DECODE_REQUIRED');
 for(const imageValidation of [{...value.imageValidation,inputSha256:'0'.repeat(64)},{...value.imageValidation,inputBytes:f.bytes.length+1},{...value.imageValidation,unknown:true}]) {
  const item=await f.prepare();assert.deepEqual(await f.run({...value,imageValidation} as InspectionResult),{claimed:true,recorded:true});
  const v=(await f.request('files/'+item.id+'/inspection')).body.data;assert.equal(v.processing.lastReason,'INSPECTOR_INVALID_RESULT');assert.equal(v.attempts[0].imageValidation,null);
 }
 assert.equal((await f.pg.query('SELECT * FROM public.file_image_evidence')).rows.length,0);
});
check('an image decoder receipt cannot be attached to a non-image claim even when its input hash matches',async f=>{
 const corrupt=Buffer.from(f.bytes);corrupt[corrupt.indexOf('IDAT')+8]^=255;
 const item=await f.prepare(corrupt,'text/plain'),value=await f.evidence(corrupt),job=await f.claim();
 await assert.rejects(f.finish(job,value),/INVALID_FILE_IMAGE_EVIDENCE/);await f.assertEmpty();
 await f.pg.query("UPDATE public.file_inspection_jobs SET started_at=started_at-interval '1 hour',lease_until=clock_timestamp()-interval '1 second' WHERE inspection_id=$1",[item.inspectionId]);
 assert.deepEqual(await f.run(value),{claimed:true,recorded:true});const v=(await f.request('files/'+item.id+'/inspection')).body.data;
 assert.equal(v.processing.lastReason,'INSPECTOR_INVALID_RESULT');assert.equal(v.attempts[1].imageValidation,null);
});
check('image evidence is tenant/feature scoped, runtime-immutable, unavailable to worker SQL and not client-settable',async f=>{
 const value=await f.evidence(),own=await f.prepare();await f.run(value);const other=await f.prepare(f.bytes,'image/png',f.otherHub);await f.run(value);
 await f.pg.query("INSERT INTO public.role_permissions VALUES($1,$2,'files.view','allow')",[f.a,f.staffRole]);
 assert.equal((await f.request('files/'+own.id+'/inspection',undefined,'staff')).response.status,200);assert.equal((await f.request('files/'+other.id+'/inspection',undefined,'staff')).response.status,404);
 assert.equal((await f.request('files/'+own.id+'/inspection',undefined,'foreignMaster',{academy:f.b})).response.status,404);
 await f.pg.exec('SET ROLE kavosh_runtime');try {
  await f.pg.query("SELECT set_config('app.academy_id',$1,false)",[f.b]);assert.equal((await f.pg.query('SELECT * FROM public.file_image_evidence')).rows.length,0);
  await f.pg.query("SELECT set_config('app.academy_id',$1,false)",[f.a]);
  for(const sql of ['DELETE FROM public.file_image_evidence',"UPDATE public.file_image_evidence SET input_sha256=repeat('0',64)",'INSERT INTO public.file_image_evidence SELECT * FROM public.file_image_evidence'])await assert.rejects(f.pg.exec(sql),/permission denied/i);
 }finally{await f.pg.exec('RESET ROLE');}
 await f.pg.exec('SET ROLE kavosh_file_worker');try {
  await assert.rejects(f.pg.exec('SELECT * FROM public.file_image_evidence'),/permission denied/i);
  await assert.rejects(f.pg.query('SELECT public.finish_file_inspection_format_evidence($1,$2,$3,$4,$5,$6,$7,$8,$9,NULL)',[f.a,own.inspectionId,randomUUID(),'no_detection','MEASURED_NO_DETECTION',f.bytes.length,sha(f.bytes),'"etag"','image/png']),/permission denied/i);
 }finally{await f.pg.exec('RESET ROLE');}
 assert.equal((await f.request('files/'+own.id+'/inspection',{expectedMetadataVersion:1,grantId:own.grantId,imageValidation:value.outcome==='no_detection'?value.imageValidation:null})).response.status,400);
});
check('native composite identity prevents even direct privileged inserts binding a receipt to different measured bytes',async f=>{
 const value=await f.evidence(),item=await f.prepare();if(value.outcome!=='no_detection'||!value.imageValidation)throw new Error('ACTUAL_DECODE_REQUIRED');
 await f.run({...value,imageValidation:undefined});
 const forged={...value.imageValidation,inputSha256:'0'.repeat(64)};
 await assert.rejects(f.pg.query('INSERT INTO public.file_image_evidence(academy_id,inspection_id,attempt_no,input_bytes,input_sha256,result) VALUES($1,$2,1,$3,$4,$5::jsonb)',[f.a,item.inspectionId,f.bytes.length,forged.inputSha256,JSON.stringify(forged)]),/foreign key/i);
 assert.equal((await f.pg.query('SELECT * FROM public.file_image_evidence')).rows.length,0);
});
check('failure of image event persistence rolls back actual nested measurement, signature, format and image writes',async f=>{
 await f.prepare();const value=await f.evidence();
 await f.pg.exec(`CREATE FUNCTION public.test_image_event_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF NEW.event_type LIKE 'file.image.%' THEN RAISE EXCEPTION 'SYNTHETIC_IMAGE_EVENT_FAILURE';END IF;RETURN NEW;END $$;
  CREATE TRIGGER test_image_event_failure BEFORE INSERT ON public.outbox_events FOR EACH ROW EXECUTE FUNCTION public.test_image_event_failure()`);
 try{await assert.rejects(f.run(value),/SYNTHETIC_IMAGE_EVENT_FAILURE/);}finally{await f.pg.exec('DROP TRIGGER test_image_event_failure ON public.outbox_events;DROP FUNCTION public.test_image_event_failure()');}
 await f.assertEmpty();assert.equal((await f.pg.query('SELECT state FROM public.file_inspection_jobs')).rows[0].state,'running');
 assert.equal((await f.pg.query("SELECT * FROM public.outbox_events WHERE event_type LIKE 'file.image.%' OR event_type LIKE 'file.format.%' OR event_type='file.inspection.evidence.recorded'")).rows.length,0);
});
check('missing positive format receipt rolls back actual nested writes before storing image evidence',async f=>{
 await f.prepare();const value=await f.evidence();
 await f.pg.exec(`ALTER FUNCTION public.finish_file_inspection_format_evidence(uuid,uuid,uuid,text,text,bigint,text,text,text,jsonb) RENAME TO test_actual_format_finish;
  CREATE FUNCTION public.finish_file_inspection_format_evidence(uuid,uuid,uuid,text,text,bigint,text,text,text,jsonb) RETURNS boolean LANGUAGE plpgsql AS $$ BEGIN
   PERFORM public.test_actual_format_finish($1,$2,$3,$4,$5,$6,$7,$8,$9,$10);RETURN NULL;END $$;
  REVOKE ALL ON FUNCTION public.finish_file_inspection_format_evidence(uuid,uuid,uuid,text,text,bigint,text,text,text,jsonb) FROM PUBLIC;
  GRANT EXECUTE ON FUNCTION public.finish_file_inspection_format_evidence(uuid,uuid,uuid,text,text,bigint,text,text,text,jsonb) TO kavosh_file_policy`);
 try{await assert.rejects(f.run(value),/MISSING_FILE_INSPECTION_RECEIPT/);}finally{await f.pg.exec(`DROP FUNCTION public.finish_file_inspection_format_evidence(uuid,uuid,uuid,text,text,bigint,text,text,text,jsonb);
  ALTER FUNCTION public.test_actual_format_finish(uuid,uuid,uuid,text,text,bigint,text,text,text,jsonb) RENAME TO finish_file_inspection_format_evidence`);}
 await f.assertEmpty();
});
test('schema39 preserves actual prior attempts without fabricating historical full-pixel evidence',async()=>{
 const f=await fixture(38);try {
  const item=await f.prepare(),value=await f.evidence(),job=await f.claim();if(value.outcome!=='no_detection')throw new Error('TEST_RESULT_REQUIRED');
  assert.equal((await f.workerQuery<{recorded:boolean}>('SELECT public.finish_file_inspection($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb) AS recorded',[f.a,item.inspectionId,job.lease_token,'no_detection','MEASURED_NO_DETECTION',f.bytes.length,sha(f.bytes),value.etag,value.providerContentType,JSON.stringify(value.signature)])).rows[0].recorded,true);
  const before=(await f.pg.query('SELECT * FROM public.file_inspection_attempts')).rows;
  await f.pg.exec(await readFile(new URL('../db/migrations/039_file_image_evidence.sql',import.meta.url),'utf8'));
  assert.deepEqual((await f.pg.query('SELECT * FROM public.file_inspection_attempts')).rows,before);assert.equal((await f.pg.query('SELECT * FROM public.file_image_evidence')).rows.length,0);
  await f.pg.exec(await readFile(new URL('../db/migrations/040_finance_tax_codes.sql',import.meta.url),'utf8'));
  await f.pg.exec(await readFile(new URL('../db/migrations/041_payment_methods.sql',import.meta.url),'utf8'));
  await f.pg.exec(await readFile(new URL('../db/migrations/042_tuition_plans.sql',import.meta.url),'utf8'));
  await f.pg.exec(await readFile(new URL('../db/migrations/043_tuition_invoices.sql',import.meta.url),'utf8'));
  await f.pg.exec(await readFile(new URL('../db/migrations/044_payment_collectors.sql',import.meta.url),'utf8'));
  await f.pg.exec(await readFile(new URL('../db/migrations/045_tuition_receipts.sql',import.meta.url),'utf8'));
  await f.pg.exec(await readFile(new URL('../db/migrations/046_installment_allocations.sql',import.meta.url),'utf8'));
  await f.pg.exec(await readFile(new URL('../db/migrations/047_collector_remittances.sql',import.meta.url),'utf8'));
  await f.pg.exec(await readFile(new URL('../db/migrations/048_revenue_sharing.sql',import.meta.url),'utf8'));
  await f.pg.exec(await readFile(new URL('../db/migrations/049_account_transfers.sql',import.meta.url),'utf8'));
  await f.pg.exec(await readFile(new URL('../db/migrations/050_expense_bills.sql',import.meta.url),'utf8'));
  await f.pg.exec(await readFile(new URL('../db/migrations/051_expense_payments.sql',import.meta.url),'utf8'));
  await f.pg.exec(await readFile(new URL('../db/migrations/052_exact_record_scopes.sql',import.meta.url),'utf8'));
  await f.pg.exec(await readFile(new URL('../db/migrations/053_approval_privacy.sql',import.meta.url),'utf8'));
  await f.pg.exec(await readFile(new URL('../db/migrations/054_session_time.sql',import.meta.url),'utf8'));
  await f.pg.exec(await readFile(new URL('../db/migrations/055_inventory.sql',import.meta.url),'utf8'));
  await f.pg.exec(await readFile(new URL('../db/migrations/056_inventory_reports.sql',import.meta.url),'utf8'));
  await f.pg.exec(await readFile(new URL('../db/migrations/057_work_engagements.sql',import.meta.url),'utf8'));
  await f.pg.exec(await readFile(new URL('../db/migrations/058_salary_forecast_allocation.sql',import.meta.url),'utf8'));
  await f.pg.exec(await readFile(new URL('../db/migrations/059_automation_rules.sql',import.meta.url),'utf8'));
  await f.pg.exec(await readFile(new URL('../db/migrations/060_automation_event_sources.sql',import.meta.url),'utf8'));
  await f.pg.exec(await readFile(new URL('../db/migrations/061_portal_notifications.sql',import.meta.url),'utf8'));
  await f.pg.exec(await readFile(new URL('../db/migrations/062_notification_jobs.sql',import.meta.url),'utf8'));
  await f.pg.exec(await readFile(new URL('../db/migrations/063_mandatory_approval_alerts.sql',import.meta.url),'utf8'));
  await f.pg.exec(await readFile(new URL('../db/migrations/064_recorded_work_report.sql',import.meta.url),'utf8'));
  await f.pg.exec(await readFile(new URL('../db/migrations/065_balance_observations.sql',import.meta.url),'utf8'));
  await f.pg.exec(await readFile(new URL('../db/migrations/066_statement_imports.sql',import.meta.url),'utf8'));
  await f.pg.exec(await readFile(new URL('../db/migrations/067_statement_matches.sql',import.meta.url),'utf8'));
  await f.pg.exec(await readFile(new URL('../db/migrations/068_reconciliation_records.sql',import.meta.url),'utf8'));
  await f.pg.exec(await readFile(new URL('../db/migrations/069_agreement_content_bindings.sql',import.meta.url),'utf8'));
  await f.pg.exec(await readFile(new URL('../db/migrations/070_agreement_package_contents.sql',import.meta.url),'utf8'));
  await f.pg.exec(await readFile(new URL('../db/migrations/071_signature_send_requests.sql',import.meta.url),'utf8'));
  await f.pg.exec(await readFile(new URL('../db/migrations/072_session_attendance.sql',import.meta.url),'utf8'));
  await f.pg.exec(await readFile(new URL('../db/migrations/073_session_reports.sql',import.meta.url),'utf8'));
  await f.pg.exec(await readFile(new URL('../db/migrations/074_report_publications.sql',import.meta.url),'utf8'));
  await f.pg.exec(await readFile(new URL('../db/migrations/075_assessment_rubrics.sql',import.meta.url),'utf8'));
  await f.pg.exec(await readFile(new URL('../db/migrations/076_student_feedback.sql',import.meta.url),'utf8'));
  await f.pg.exec(await readFile(new URL('../db/migrations/077_homeworks.sql',import.meta.url),'utf8'));
  await f.pg.exec(await readFile(new URL('../db/migrations/078_homework_submissions.sql',import.meta.url),'utf8'));
  await f.pg.exec(await readFile(new URL('../db/migrations/079_homework_grades.sql',import.meta.url),'utf8'));
  await f.pg.exec(await readFile(new URL('../db/migrations/080_homework_solutions.sql',import.meta.url),'utf8'));
  await f.pg.exec(await readFile(new URL('../db/migrations/081_report_comments.sql',import.meta.url),'utf8'));
  await f.pg.exec(await readFile(new URL('../db/migrations/082_polls.sql',import.meta.url),'utf8'));
  await f.pg.exec(await readFile(new URL('../db/migrations/083_poll_responses.sql',import.meta.url),'utf8'));
  await f.pg.exec(await readFile(new URL('../db/migrations/084_poll_results.sql',import.meta.url),'utf8'));
  await f.pg.exec(await readFile(new URL('../db/migrations/085_poll_response_moderation.sql',import.meta.url),'utf8'));
  await f.pg.exec(await readFile(new URL('../db/migrations/086_poll_templates.sql',import.meta.url),'utf8'));
  await f.pg.exec(await readFile(new URL('../db/migrations/087_poll_template_use.sql',import.meta.url),'utf8'));
  await f.pg.exec(await readFile(new URL('../db/migrations/088_session_evidence_reviews.sql',import.meta.url),'utf8'));
  await f.pg.exec(await readFile(new URL('../db/migrations/089_session_staff_feedback.sql',import.meta.url),'utf8'));
  await f.pg.exec(await readFile(new URL('../db/migrations/090_receivables_aging.sql',import.meta.url),'utf8'));
  await f.pg.exec(await readFile(new URL('../db/migrations/091_payables_aging.sql',import.meta.url),'utf8'));
  await f.pg.exec(await readFile(new URL('../db/migrations/092_expense_commitments.sql',import.meta.url),'utf8'));
  await f.pg.exec(await readFile(new URL('../db/migrations/093_commitment_bill_links.sql',import.meta.url),'utf8'));
  assert.equal((await f.request('files/'+item.id+'/inspection')).body.data.attempts[0].imageValidation,null);
  const next=await f.prepare();await f.run(value);assert.equal((await f.request('files/'+next.id+'/inspection')).body.data.attempts[0].imageValidation.result.outcome,'decoded');
 }finally{await f.pg.close();}
});
if(process.env.TEST_DATABASE_URL)check('simultaneous native finishes retain exactly one full-pixel receipt and image event',async f=>{
 await f.prepare();const value=await f.evidence(),job=await f.claim();assert.deepEqual((await Promise.all([f.finish(job,value),f.finish(job,value)])).sort(),[false,true]);
 assert.equal((await f.pg.query('SELECT * FROM public.file_image_evidence')).rows.length,1);assert.equal((await f.pg.query("SELECT * FROM public.outbox_events WHERE event_type='file.image.decoded'")).rows.length,1);
});
if(process.env.TEST_DATABASE_URL)check('one hundred concurrent worker cycles retain all exact image receipts without additional client queries',async f=>{
 const value=await f.evidence(),first=await f.prepare();
 // Seed durable queue load like file-worker.test.ts, without weakening the
 // portal's intentionally smaller issuance/inspection anti-abuse budgets.
 await f.pg.exec('BEGIN');try {
  await f.pg.exec('CREATE TEMP TABLE synthetic_image_seed AS SELECT gen_random_uuid() AS file_id,gen_random_uuid() AS grant_id,gen_random_uuid() AS inspection_id FROM generate_series(1,99)');
  await f.pg.query(`INSERT INTO public.file_records(academy_id,id,anchor_kind,hub_id,domain,name,claimed_mime_type,expected_bytes,expected_sha256,search_text,created_by)
   SELECT $1,s.file_id,'hub',$2,'general','Synthetic image.png','image/png',$3,$4,'Synthetic image',$5 FROM synthetic_image_seed s`,[f.a,f.hub,f.bytes.length,sha(f.bytes),f.actors.master.person]);
  await f.pg.query(`INSERT INTO public.file_record_revisions(academy_id,file_id,version,definition,changed_by,reason)
   SELECT r.academy_id,s.file_id,1,r.definition||jsonb_build_object('id',s.file_id),r.changed_by,'Synthetic image load setup' FROM public.file_record_revisions r CROSS JOIN synthetic_image_seed s WHERE r.academy_id=$1 AND r.file_id=$2`,[f.a,first.id]);
  await f.pg.query(`INSERT INTO public.file_upload_reservations(academy_id,file_id,reserved_bytes,policy_version,created_by,storage_target_id)
   SELECT r.academy_id,s.file_id,r.reserved_bytes,r.policy_version,r.created_by,r.storage_target_id FROM public.file_upload_reservations r CROSS JOIN synthetic_image_seed s WHERE r.academy_id=$1 AND r.file_id=$2`,[f.a,first.id]);
  await f.pg.query(`INSERT INTO public.file_upload_grants(academy_id,id,file_id,metadata_version,storage_target_id,created_by,issued_at,expires_at)
   SELECT g.academy_id,s.grant_id,s.file_id,1,g.storage_target_id,g.created_by,g.issued_at,g.expires_at FROM public.file_upload_grants g CROSS JOIN synthetic_image_seed s WHERE g.academy_id=$1 AND g.file_id=$2`,[f.a,first.id]);
  await f.pg.query(`INSERT INTO public.file_inspection_requests(academy_id,id,file_id,grant_id,metadata_version,storage_target_id,requested_by)
   SELECT r.academy_id,s.inspection_id,s.file_id,s.grant_id,1,r.storage_target_id,r.requested_by FROM public.file_inspection_requests r CROSS JOIN synthetic_image_seed s WHERE r.academy_id=$1 AND r.file_id=$2`,[f.a,first.id]);
  await f.pg.query('UPDATE public.file_storage_policies SET reserved_files=100,reserved_bytes=$2 WHERE academy_id=$1',[f.a,100*f.bytes.length]);await f.pg.exec('COMMIT');
 }catch(error){await f.pg.exec('ROLLBACK');throw error;}
 let queries=0;const database:Database={async connect(){const c=await f.pg.runtime!.connect();await c.query('SET ROLE kavosh_file_worker');return {async query<Row>(sql:string,params?:unknown[]){queries++;return c.query<Row>(sql,params);},release(){c.release();}};}};
 const times:number[]=[],started=performance.now();
 const results=await Promise.all(Array.from({length:100},async()=>{const t=performance.now(),r=await processOneInspection(database,[f.a],randomUUID(),async()=>value);times.push(performance.now()-t);return r;}));
 assert.ok(results.every(r=>r.claimed&&r.recorded));assert.equal(queries,600);
 for(const table of ['file_inspection_attempts','file_content_signatures','file_format_assessments','file_image_evidence'])assert.equal((await f.pg.query('SELECT * FROM public.'+table)).rows.length,100,table);
 assert.equal((await f.pg.query("SELECT * FROM public.outbox_events WHERE event_type='file.image.decoded'")).rows.length,100);times.sort((a,b)=>a-b);
 console.log(JSON.stringify({measurement:'synthetic-image-receipt-worker-cycles',requests:100,poolMaximum:4,persistedReceipts:100,clientQueries:queries,p99Ms:Math.ceil(times[98]),elapsedMs:Math.ceil(performance.now()-started),physicalObjectReads:0,actualEngineScans:0,decodedFixtureReused:true}));
});
