import assert from 'node:assert/strict';
import { randomUUID,createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { operationsFixture } from './operations-fixture.ts';
import { processOneInspection,type InspectionResult } from '../src/files/inspection-worker.ts';
import { detectContentSignature } from '../src/files/content-signature.ts';
import type { Database } from '../src/core/database.ts';

const bytes=Buffer.from('%PDF-1.7\nSynthetic signature hint; not a structurally valid PDF.\n'),hash=createHash('sha256').update(bytes).digest('hex');
const signature={detector:'file-type@22.3.0' as const,sampleBytes:bytes.length,sampleSha256:hash,mime:'application/pdf',extension:'pdf'};
const result={outcome:'no_detection',bytes:bytes.length,sha256:hash,etag:'"synthetic-etag"',providerContentType:'application/octet-stream',signature} satisfies InspectionResult;
const connection={accountId:'a'.repeat(32),jurisdiction:'default' as const,bucket:'synthetic-format-screen',accessKeyId:'synthetic-id',secretAccessKey:'synthetic-not-real-secret',maximumUploadBytes:100000};
async function fixture(throughSchema?:number) {
 const f=await operationsFixture({connections:()=>connection,throughSchema});
 const configured=await f.request('storage-policy',{expectedVersion:0,uploadsEnabled:true,maximumFileBytes:100000,maximumReservedBytes:1000000,maximumFiles:200,allowedMimeTypes:['application/pdf','image/png','text/plain'],reason:'Synthetic format screening policy'});assert.equal(configured.response.status,200,JSON.stringify(configured.body));
 const database:Database={async connect(){const c=f.pg.runtime?await f.pg.runtime.connect():{async query<Row>(sql:string,params?:unknown[]){return f.pg.query<Row>(sql,params);},release(){}};await c.query('SET ROLE kavosh_file_worker');return c;}};
 async function workerQuery<Row=Record<string,unknown>>(sql:string,params?:unknown[]){const c=await database.connect();try{return await c.query<Row>(sql,params);}finally{c.release();if(!f.pg.runtime)await f.pg.exec('RESET ROLE');}}
 async function prepare(claimedMimeType='application/pdf',hub=f.hub) {
  const file=await f.request('files',{anchor:{kind:'hub',id:hub},name:'Untrusted name.any',claimedMimeType,expectedBytes:bytes.length,expectedSha256:hash});assert.equal(file.response.status,201);
  const id=file.body.data.id,grant=await f.request('files/'+id+'/upload-link',{expectedMetadataVersion:1});assert.equal(grant.response.status,201);
  const inspection=await f.request('files/'+id+'/inspection',{expectedMetadataVersion:1,grantId:grant.body.data.id});assert.equal(inspection.response.status,202);
  return {id,grantId:grant.body.data.id,inspectionId:inspection.body.data.id};
 }
 async function run(value:InspectionResult=result){try{return await processOneInspection(database,[f.a],randomUUID(),async()=>value);}finally{if(!f.pg.runtime)await f.pg.exec('RESET ROLE');}}
 const claim=async()=>(await workerQuery('SELECT * FROM public.claim_file_inspection($1,$2,30)',[[f.a],randomUUID()])).rows[0];
 const finish=async(job:Record<string,unknown>)=>(await workerQuery<{recorded:boolean}>('SELECT public.finish_file_inspection($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb) AS recorded',[job.academy_id,job.inspection_id,job.lease_token,result.outcome,'MEASURED_NO_DETECTION',bytes.length,hash,result.etag,result.providerContentType,JSON.stringify(signature)])).rows[0].recorded;
 async function view(id:string){const r=await f.request('files/'+id+'/inspection');assert.equal(r.response.status,200,JSON.stringify(r.body));assert.equal(r.body.data.safeToServe,false);assert.equal(r.body.data.physicalStorageVerified,false);return r.body.data;}
 return {...f,database,workerQuery,prepare,run,claim,finish,view};
}
type Fixture=Awaited<ReturnType<typeof fixture>>;
function check(name:string,run:(f:Fixture)=>Promise<void>){test(name,async()=>{const f=await fixture();try{await run(f);}finally{await f.pg.close();}});}

check('measured signature and original policy can match without claiming structural validity, scanner freshness or downloadable content',async f=>{
 const file=await f.prepare(),actualSignature=await detectContentSignature(bytes);assert.deepEqual(actualSignature,signature);
 assert.deepEqual(await f.run({...result,signature:actualSignature}),{claimed:true,recorded:true});
 const v=await f.view(file.id),screen=v.attempts[0].formatAssessment;assert.equal(screen.ruleVersion,1);assert.equal(screen.state,'matched');assert.equal(screen.reason,'SIGNATURE_CLAIM_MATCH');assert.equal(screen.structurallyValidated,false);assert.ok(screen.assessedAt);
 assert.equal(v.uploadVerified,false);assert.equal('downloadUrl' in v,false);assert.equal((await f.pg.query('SELECT * FROM public.file_format_assessments')).rows.length,1);
 assert.equal((await f.pg.query("SELECT * FROM public.outbox_events WHERE event_type='file.format.screened'")).rows.length,1);
 assert.deepEqual(await f.run(),{claimed:false,recorded:false});
});
check('declared MIME and provider headers cannot override a different measured format or the issued allowlist',async f=>{
 const mismatch=await f.prepare('image/png');await f.run({...result,providerContentType:'image/png'});const one=(await f.view(mismatch.id)).attempts[0].formatAssessment;
 assert.equal(one.state,'rejected');assert.equal(one.reason,'SIGNATURE_CLAIM_MISMATCH');
 const denied=await f.prepare();await f.run({...result,signature:{...signature,mime:'application/x-executable',extension:'exe'}});const two=(await f.view(denied.id)).attempts[0].formatAssessment;assert.equal(two.state,'rejected');assert.equal(two.reason,'SIGNATURE_NOT_ALLOWED');
 assert.equal((await f.pg.query("SELECT * FROM public.outbox_events WHERE event_type='file.format.rejected.critical'")).rows.length,2);
 assert.equal((await f.request('storage-policy')).body.data.reservedFiles,2,'screening cannot silently release inventory/storage capacity');
});
check('unknown, missing and insufficient signature coverage remain unassessed instead of trusting a text or image claim',async f=>{
 for(const [value,reason] of [[{...result,signature:{...signature,mime:null,extension:null}},'SIGNATURE_UNKNOWN'],
  [{...result,signature:undefined},'SIGNATURE_MISSING'],[{...result,signature:{...signature,sampleBytes:1,sampleSha256:createHash('sha256').update(bytes.subarray(0,1)).digest('hex')}},'INSUFFICIENT_SIGNATURE_SAMPLE']] as const) {
  const item=await f.prepare();await f.run(value as InspectionResult);const a=(await f.view(item.id)).attempts[0].formatAssessment;assert.equal(a.state,'unassessed');assert.equal(a.reason,reason);assert.equal(a.structurallyValidated,false);
 }
 assert.equal((await f.pg.query("SELECT * FROM public.outbox_events WHERE event_type='file.format.validation.required'")).rows.length,3);
});
check('malware detection rejects independently of MIME while unavailable and mismatching measurements cannot become format matches',async f=>{
 for(const [value,state,reason] of [[{...result,outcome:'detected'},'rejected','MALWARE_DETECTED'],[{outcome:'unavailable',reason:'SCANNER_UNAVAILABLE'},'unassessed','INSPECTION_NOT_USABLE'],[{outcome:'content_mismatch'},'unassessed','INSPECTION_NOT_USABLE']] as const) {
  const item=await f.prepare();await f.run(value as InspectionResult);const a=(await f.view(item.id)).attempts[0].formatAssessment;assert.equal(a.state,state);assert.equal(a.reason,reason);
 }
});
check('missing historical format policy and malformed native snapshots stay explicitly unassessed',async f=>{
 for(const [patch,reason] of [[{format_policy_version:null,format_policy_snapshot:null},'POLICY_UNRECORDED'],
  [{format_policy_snapshot:{snapshotVersion:1,allowedMimeTypes:[null]}},'POLICY_INVALID'],[{format_policy_snapshot:{snapshotVersion:'1',allowedMimeTypes:['application/pdf']}},'POLICY_INVALID']] as const) {
  const item=await f.prepare();const keys=Object.keys(patch);await f.pg.query('UPDATE public.file_upload_grants SET '+keys.map((k,i)=>k+'=$'+(i+2)+(k==='format_policy_snapshot'?'::jsonb':'')).join(',')+' WHERE id=$1',[item.grantId,...Object.values(patch).map(v=>v===null?null:typeof v==='object'?JSON.stringify(v):v)]);
  await f.run();const a=(await f.view(item.id)).attempts[0].formatAssessment;assert.equal(a.state,'unassessed');assert.equal(a.reason,reason);
 }
});
check('screening uses the exact issued snapshot and later policy restrictions never rewrite historical evidence',async f=>{
 const item=await f.prepare();assert.equal((await f.request('storage-policy',{expectedVersion:1,allowedMimeTypes:['image/png'],reason:'Restrict future uploads'})).response.status,200);
 await f.run();const before=(await f.view(item.id)).attempts[0].formatAssessment;assert.equal(before.state,'matched');
 assert.equal((await f.request('storage-policy',{expectedVersion:2,allowedMimeTypes:[],reason:'Stop all future formats'})).response.status,200);
 assert.deepEqual((await f.view(item.id)).attempts[0].formatAssessment,before);assert.equal((await f.request('files/'+item.id+'/upload-grants')).body.data[0].formatPolicyVersion,1);
});
check('an originally denied claim cannot match merely because its detected type matches a corrupt claim snapshot',async f=>{
 const item=await f.prepare();await f.pg.query('UPDATE public.file_upload_grants SET format_policy_snapshot=$2::jsonb WHERE id=$1',[item.grantId,JSON.stringify({snapshotVersion:1,allowedMimeTypes:['image/png']})]);
 await f.run();const a=(await f.view(item.id)).attempts[0].formatAssessment;assert.equal(a.state,'rejected');assert.equal(a.reason,'CLAIM_NOT_ALLOWED');
});
check('missing, null and malformed immutable MIME claims cannot fall through SQL null comparisons into a match',async f=>{
 for(const value of [null,'','Image/PDF']) {
  const item=await f.prepare();
  await f.pg.query("UPDATE public.file_record_revisions SET definition=jsonb_set(definition,'{claimed_mime_type}',$2::jsonb) WHERE file_id=$1",[item.id,JSON.stringify(value)]);
  // Exercise the native boundary directly: the current JS worker correctly
  // rejects a missing claim before IO, but an older service cannot bypass SQL.
  assert.equal(await f.finish(await f.claim()),true);const a=(await f.view(item.id)).attempts[0].formatAssessment;assert.equal(a.state,'unassessed');assert.equal(a.reason,'CLAIM_UNAVAILABLE');
 }
 const absent=await f.prepare();await f.pg.query("UPDATE public.file_record_revisions SET definition=definition-'claimed_mime_type' WHERE file_id=$1",[absent.id]);
 assert.equal(await f.finish(await f.claim()),true);assert.equal((await f.view(absent.id)).attempts[0].formatAssessment.reason,'CLAIM_UNAVAILABLE');
});
check('failure to persist a format decision rolls back measurement, signature, job completion and all related events',async f=>{
 const item=await f.prepare();await f.pg.exec('REVOKE INSERT ON public.file_format_assessments FROM kavosh_file_policy');
 try{await assert.rejects(f.run(),/permission denied/i);}finally{await f.pg.exec('GRANT INSERT ON public.file_format_assessments TO kavosh_file_policy');}
 for(const table of ['file_inspection_attempts','file_content_signatures','file_format_assessments'])assert.equal((await f.pg.query('SELECT * FROM public.'+table)).rows.length,0);
 assert.equal((await f.pg.query('SELECT state FROM public.file_inspection_jobs')).rows[0].state,'running');assert.equal((await f.pg.query("SELECT * FROM public.outbox_events WHERE event_type IN ('file.inspection.evidence.recorded','file.format.screened')")).rows.length,0);
 await f.pg.query("UPDATE public.file_inspection_jobs SET started_at=started_at-interval '1 hour',lease_until=clock_timestamp()-interval '1 second' WHERE inspection_id=$1",[item.inspectionId]);
 await f.run();const a=(await f.view(item.id)).attempts;assert.equal(a.length,2);assert.equal(a[0].formatAssessment.reason,'ASSESSMENT_NOT_RECORDED');assert.equal(a[1].formatAssessment.state,'matched');
});
check('format history stays tenant/feature scoped and native service/web roles cannot forge or rewrite screening decisions',async f=>{
 const own=await f.prepare(),other=await f.prepare('application/pdf',f.otherHub);await f.run();await f.run();
 await f.pg.query("INSERT INTO public.role_permissions VALUES($1,$2,'files.view','allow')",[f.a,f.staffRole]);
 assert.equal((await f.request('files/'+own.id+'/inspection',undefined,'staff')).response.status,200);assert.equal((await f.request('files/'+other.id+'/inspection',undefined,'staff')).response.status,404);
 assert.equal((await f.request('files/'+own.id+'/inspection',undefined,'foreignMaster',{academy:f.b})).response.status,404);
 await f.pg.exec('SET ROLE kavosh_runtime');try {
  await f.pg.query("SELECT set_config('app.academy_id',$1,false)",[f.b]);assert.equal((await f.pg.query('SELECT * FROM public.file_format_assessments')).rows.length,0);
  await f.pg.query("SELECT set_config('app.academy_id',$1,false)",[f.a]);
  for(const sql of ["UPDATE public.file_format_assessments SET state='matched'",'DELETE FROM public.file_format_assessments','INSERT INTO public.file_format_assessments SELECT * FROM public.file_format_assessments'])await assert.rejects(f.pg.exec(sql),/permission denied/i);
 }finally{await f.pg.exec('RESET ROLE');}
 await f.pg.exec('SET ROLE kavosh_file_worker');try {
  await assert.rejects(f.pg.exec('SELECT * FROM public.file_format_assessments'),/permission denied/i);
  await assert.rejects(f.pg.query('SELECT public.finish_file_inspection_signature_evidence($1,$2,$3,$4,$5,$6,$7,$8,$9,NULL)',[f.a,own.inspectionId,randomUUID(),'no_detection','MEASURED_NO_DETECTION',bytes.length,hash,'"etag"','application/pdf']),/permission denied/i);
 }finally{await f.pg.exec('RESET ROLE');}
 for(const patch of [{safeToServe:true},{formatAssessment:{state:'matched'}},{structurallyValidated:true}])assert.equal((await f.request('files/'+own.id+'/inspection',{expectedMetadataVersion:1,grantId:own.grantId,...patch})).response.status,400);
});
check('a format outbox failure after assessment insertion rolls back every nested measurement/signature/decision write',async f=>{
 await f.prepare();
 await f.pg.exec(`CREATE FUNCTION public.test_reject_format_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF NEW.event_type LIKE 'file.format.%' THEN RAISE EXCEPTION 'SYNTHETIC_FORMAT_OUTBOX_FAILURE'; END IF;RETURN NEW;END $$;
  CREATE TRIGGER test_format_outbox BEFORE INSERT ON public.outbox_events FOR EACH ROW EXECUTE FUNCTION public.test_reject_format_event()`);
 try{await assert.rejects(f.run(),/SYNTHETIC_FORMAT_OUTBOX_FAILURE/);}
 finally{await f.pg.exec('DROP TRIGGER test_format_outbox ON public.outbox_events; DROP FUNCTION public.test_reject_format_event()');}
 for(const table of ['file_inspection_attempts','file_content_signatures','file_format_assessments'])assert.equal((await f.pg.query('SELECT * FROM public.'+table)).rows.length,0);
 assert.equal((await f.pg.query("SELECT * FROM public.outbox_events WHERE event_type='file.inspection.evidence.recorded' OR event_type LIKE 'file.format.%'")).rows.length,0);
 assert.equal((await f.pg.query('SELECT state FROM public.file_inspection_jobs')).rows[0].state,'running');
});
check('a missing positive inner receipt rolls back real nested writes instead of inventing a successful assessment',async f=>{
 await f.prepare();
 await f.pg.exec(`ALTER FUNCTION public.finish_file_inspection_signature_evidence(uuid,uuid,uuid,text,text,bigint,text,text,text,jsonb) RENAME TO test_original_signature_finish;
  CREATE FUNCTION public.finish_file_inspection_signature_evidence(uuid,uuid,uuid,text,text,bigint,text,text,text,jsonb) RETURNS boolean LANGUAGE plpgsql AS $$ BEGIN
   PERFORM public.test_original_signature_finish($1,$2,$3,$4,$5,$6,$7,$8,$9,$10); RETURN NULL;END $$;
  REVOKE ALL ON FUNCTION public.finish_file_inspection_signature_evidence(uuid,uuid,uuid,text,text,bigint,text,text,text,jsonb) FROM PUBLIC;
  GRANT EXECUTE ON FUNCTION public.finish_file_inspection_signature_evidence(uuid,uuid,uuid,text,text,bigint,text,text,text,jsonb) TO kavosh_file_policy`);
 try{await assert.rejects(f.run(),/MISSING_FILE_INSPECTION_RECEIPT/);}
 finally{await f.pg.exec(`DROP FUNCTION public.finish_file_inspection_signature_evidence(uuid,uuid,uuid,text,text,bigint,text,text,text,jsonb);
  ALTER FUNCTION public.test_original_signature_finish(uuid,uuid,uuid,text,text,bigint,text,text,text,jsonb) RENAME TO finish_file_inspection_signature_evidence`);}
 for(const table of ['file_inspection_attempts','file_content_signatures','file_format_assessments'])assert.equal((await f.pg.query('SELECT * FROM public.'+table)).rows.length,0);
 assert.equal((await f.pg.query("SELECT * FROM public.outbox_events WHERE event_type='file.inspection.evidence.recorded' OR event_type LIKE 'file.format.%'")).rows.length,0);
 assert.equal((await f.pg.query('SELECT state FROM public.file_inspection_jobs')).rows[0].state,'running');
});
test('schema38 preserves an actual schema37 completed attempt without inventing a historical screen',async()=>{
 const f=await fixture(37);try {
  const item=await f.prepare(),job=await f.claim();assert.equal(await f.finish(job),true);
  const before=(await f.pg.query('SELECT * FROM public.file_inspection_attempts')).rows;
  await f.pg.exec(await readFile(new URL('../db/migrations/038_file_format_assessments.sql',import.meta.url),'utf8'));
  assert.deepEqual((await f.pg.query('SELECT * FROM public.file_inspection_attempts')).rows,before);assert.equal((await f.pg.query('SELECT * FROM public.file_format_assessments')).rows.length,0);
  await f.pg.exec(await readFile(new URL('../db/migrations/039_file_image_evidence.sql',import.meta.url),'utf8'));
  await f.pg.exec(await readFile(new URL('../db/migrations/040_finance_tax_codes.sql',import.meta.url),'utf8'));
  await f.pg.exec(await readFile(new URL('../db/migrations/041_payment_methods.sql',import.meta.url),'utf8'));
  await f.pg.exec(await readFile(new URL('../db/migrations/042_tuition_plans.sql',import.meta.url),'utf8'));
  assert.deepEqual((await f.view(item.id)).attempts[0].formatAssessment,{state:'unassessed',reason:'ASSESSMENT_NOT_RECORDED',structurallyValidated:false});
  const next=await f.prepare();await f.run();assert.equal((await f.view(next.id)).attempts[0].formatAssessment.state,'matched');
 }finally{await f.pg.close();}
});
if(process.env.TEST_DATABASE_URL)check('simultaneous finishes retain one measured attempt, one format assessment and one format event',async f=>{
 await f.prepare();const job=await f.claim();assert.deepEqual((await Promise.all([f.finish(job),f.finish(job)])).sort(),[false,true]);
 assert.equal((await f.pg.query('SELECT * FROM public.file_inspection_attempts')).rows.length,1);assert.equal((await f.pg.query('SELECT * FROM public.file_format_assessments')).rows.length,1);
 assert.equal((await f.pg.query("SELECT * FROM public.outbox_events WHERE event_type='file.format.screened'")).rows.length,1);
});
