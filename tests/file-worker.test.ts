import assert from 'node:assert/strict';
import { createHash,randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { operationsFixture } from './operations-fixture.ts';
import { processOneInspection,assertFileWorkerRole,type InspectionResult,type InspectionTask } from '../src/files/inspection-worker.ts';
import type { Database } from '../src/core/database.ts';
import { inspectStoredFile } from '../src/files/inspection-worker.ts';
import { clamdPeer,clamdVersionString } from './fixtures/clamd-peer.ts';
import { Readable } from 'node:stream';
import { IdentityStore } from '../src/auth/store.ts';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';

const bytes=Buffer.from('Synthetic file-worker content.'),sha256=createHash('sha256').update(bytes).digest('hex');
const success:InspectionResult={outcome:'no_detection',bytes:bytes.length,sha256,etag:'"synthetic-etag"',providerContentType:'application/octet-stream'};
const connection={accountId:'a'.repeat(32),jurisdiction:'default' as const,bucket:'synthetic-private-quarantine',accessKeyId:'synthetic-access-id',secretAccessKey:'synthetic-r2-secret-not-a-real-key',maximumUploadBytes:1000};
async function fixture(throughSchema?:number) {
  const f=await operationsFixture({throughSchema,connections:()=>({accountId:'a'.repeat(32),jurisdiction:'default',bucket:'synthetic-private-quarantine',accessKeyId:'synthetic-access-id',secretAccessKey:'synthetic-r2-secret-not-a-real-key',maximumUploadBytes:1000})});
  let held=0;const worker=randomUUID();
  const database:Database={async connect(){
    const connection=f.pg.runtime?await f.pg.runtime.connect():{async query<Row>(sql:string,params?:unknown[]){const r=await f.pg.query<Row>(sql,params);return {rows:r.rows,rowCount:r.affectedRows};},release(){}};
    await connection.query('SET ROLE kavosh_file_worker');held++;
    return {query:connection.query.bind(connection),release(destroy?:boolean){held--;connection.release(destroy);}};
  }};
  async function prepare(academy=f.a) {
    const actor=academy===f.a?'master':'foreignMaster',hub=academy===f.a?f.hub:f.foreignHub;
    const policy=await f.request('storage-policy');if(academy!==f.a||(policy.body.configured===false))assert.equal((await f.request('storage-policy',{expectedVersion:0,uploadsEnabled:true,maximumFileBytes:100,maximumReservedBytes:1000,maximumFiles:20,reason:'Synthetic worker budget'},actor,{academy})).response.status,200);
    const item=await f.request('files',{anchor:{kind:'hub',id:hub},name:'Synthetic worker.txt',claimedMimeType:'text/plain',expectedBytes:bytes.length,expectedSha256:sha256},actor,{academy});assert.equal(item.response.status,201);
    const grant=await f.request('files/'+item.body.data.id+'/upload-link',{expectedMetadataVersion:1},actor,{academy});assert.equal(grant.response.status,201);
    const request=await f.request('files/'+item.body.data.id+'/inspection',{expectedMetadataVersion:1,grantId:grant.body.data.id},actor,{academy});assert.equal(request.response.status,202,JSON.stringify(request.body));
    return {fileId:item.body.data.id,inspectionId:request.body.data.id,academy};
  }
  async function run(inspect:(task:InspectionTask,signal:AbortSignal)=>Promise<InspectionResult>=async()=>success,academies=[f.a],options:Parameters<typeof processOneInspection>[4]={}) {
    try{return await processOneInspection(database,academies,worker,async(task,signal)=>{assert.equal(held,0,'database connections must be released before object IO');return inspect(task,signal);},options);}
    finally{await f.pg.exec('RESET ROLE');assert.equal(held,0);}
  }
  async function claim(academies=[f.a]) {const c=await database.connect();try{await assertFileWorkerRole(c);return (await c.query('SELECT * FROM public.claim_file_inspection($1,$2,30)',[academies,worker])).rows[0];}finally{c.release();await f.pg.exec('RESET ROLE');}}
  async function finish(job:Record<string,unknown>,outcome='no_detection') {const c=await database.connect();try{return (await c.query<{recorded:boolean}>('SELECT public.finish_file_inspection($1,$2,$3,$4,$5,$6,$7,$8,$9,NULL) AS recorded',[job.academy_id,job.inspection_id,job.lease_token,outcome,outcome==='detected'?'MEASURED_DETECTION':'MEASURED_NO_DETECTION',bytes.length,sha256,'"synthetic-etag"','application/octet-stream'])).rows[0].recorded;}finally{c.release();await f.pg.exec('RESET ROLE');}}
  async function finishObservation(job:Record<string,unknown>,observation:unknown,outcome='no_detection') {const c=await database.connect();try{return(await c.query<{recorded:boolean}>('SELECT public.finish_file_inspection($1,$2,$3,$4,$5,$6,$7,$8,$9,NULL,NULL,$10::jsonb) AS recorded',[job.academy_id,job.inspection_id,job.lease_token,outcome,outcome==='detected'?'MEASURED_DETECTION':'MEASURED_NO_DETECTION',bytes.length,sha256,'"synthetic-etag"','application/octet-stream',JSON.stringify(observation)])).rows[0].recorded;}finally{c.release();if(!f.pg.runtime)await f.pg.exec('RESET ROLE');}}
  return {...f,prepare,run,claim,finish,finishObservation,database,worker,held:()=>held};
}
function observation(now=Date.now()) {return {formatVersion:1,engineVersion:'1.5.4',databaseVersion:30001,databaseCreatedAt:new Date(Math.floor((now-60000)/1000)*1000).toISOString().replace('.000Z','Z'),observedAt:new Date(now).toISOString(),observedBeforeAt:new Date(now).toISOString(),timeZone:'UTC',maximumAgeSeconds:172800};}
type Fixture=Awaited<ReturnType<typeof fixture>>;
function check(name:string,run:(f:Fixture)=>Promise<void>){test(name,async()=>{const f=await fixture();try{await run(f);}finally{await f.pg.close();}});}

check('a separate non-owner worker leases minimal claims, releases DB during IO and records immutable measured evidence without publishing',async f=>{
  const item=await f.prepare();let calls=0;
  const r=await f.run(async(task)=>{calls++;assert.equal(task.academyId,f.a);assert.equal(task.fileId,item.fileId);assert.equal(task.expectedBytes,bytes.length);assert.equal(task.expectedSha256,sha256);assert.equal('name' in task,false);assert.equal('requestedBy' in task,false);return success;});
  assert.deepEqual(r,{claimed:true,recorded:true});assert.equal(calls,1);
  const view=await f.request('files/'+item.fileId+'/inspection');assert.equal(view.body.data.processing.state,'evidence_recorded');assert.equal(view.body.data.processing.lastOutcome,'no_detection');assert.equal(view.body.data.attempts.length,1);assert.equal(view.body.data.attempts[0].sha256,sha256);assert.equal(view.body.data.safeToServe,false);assert.equal(view.body.data.uploadVerified,false);assert.equal(view.body.data.physicalStorageVerified,false);assert.ok(!JSON.stringify(view.body).includes('leaseToken'));
  assert.deepEqual(await f.run(async()=>{assert.fail('finished evidence cannot be claimed again');}),{claimed:false,recorded:false});
});
check('strict loaded-database failures persist as blocked retryable inspections,not successful scan or download evidence',async f=>{
  const fresh=Buffer.from(clamdVersionString()+'\0'),stale=Buffer.from(clamdVersionString(Date.now()-173000000)+'\0');
  for(const mode of ['success','stale','detected']){
    const valid=mode!=='stale',detected=mode==='detected',item=await f.prepare(),peer=await clamdPeer(detected?'detected':'success',valid?[fresh,detected?null:fresh]:[stale]);let reads=0;
    try{
      assert.deepEqual(await f.run((task,signal)=>inspectStoredFile(task,()=>connection,peer.config,signal,5000,{async handle(){reads++;return {response:{statusCode:200,headers:{'content-length':String(bytes.length),'content-type':'application/octet-stream',etag:'"synthetic-freshness"'},body:Readable.from([bytes])}};}},undefined,{timeZone:'UTC',maximumAgeSeconds:172800})),{claimed:true,recorded:true});
      const view=(await f.request('files/'+item.fileId+'/inspection')).body.data;assert.equal(reads,1);assert.equal(view.safeToServe,false);assert.equal(view.uploadVerified,false);assert.equal(view.attempts.length,1);
      if(mode==='success'){const s=view.attempts[0].scannerObservation;assert.equal(s.result.databaseVersion,30001);assert.ok(s.recordedAt);for(const key of ['currentFreshnessVerified','configurationVerified','officialSignaturesVerified','scanEnginePinned'])assert.equal(s[key],false);}
      else assert.equal(view.attempts[0].scannerObservation,null);
      assert.equal(view.processing.lastOutcome,detected?'detected':valid?'no_detection':'unavailable');assert.equal(view.processing.state,valid?'evidence_recorded':'queued');
      if(!valid){assert.equal(view.processing.lastReason,'SCANNER_UNAVAILABLE');assert.equal(view.attempts[0].sha256,null);assert.equal(peer.received.length,0);}
      if(detected){assert.equal(view.attempts[0].contentSignature,null);assert.equal(view.attempts[0].formatAssessment.reason,'MALWARE_DETECTED');assert.equal((await f.pg.query("SELECT * FROM public.outbox_events WHERE event_type='file.format.rejected.critical' AND entity_id=$1",[item.fileId])).rows.length,1);}
      assert.deepEqual(peer.commands,detected?['VERSION','INSTREAM']:valid?['VERSION','INSTREAM','VERSION']:['VERSION']);
    }finally{await peer.close();}
  }
});
check('scanner observation native shape,time-window and outcome checks roll back nested measurement and events',async f=>{
  await f.prepare();const job=await f.claim(),value=observation();
  for(const invalid of [null,{},[],{...value,formatVersion:2},{...value,engineVersion:'PRIVATE invalid'},{...value,databaseVersion:'30001'},{...value,databaseVersion:0},{...value,databaseVersion:4294967296},
    {...value,timeZone:'Not/AZone'},{...value,timeZone:'+00:00'},{...value,maximumAgeSeconds:0},{...value,maximumAgeSeconds:604801},{...value,maximumAgeSeconds:1},
    {...value,databaseCreatedAt:'2026-02-30T00:00:00Z'},{...value,databaseCreatedAt:new Date(Date.now()+60000).toISOString().replace(/\.[0-9]{3}Z$/,'Z')},
    {...value,observedAt:'bad'},{...value,observedBeforeAt:new Date(Date.now()+60000).toISOString()},{...value,observedAt:new Date(Date.now()+60000).toISOString()},
    {...value,observedBeforeAt:new Date(Date.now()-60000).toISOString()},{...value,observedAt:new Date(Date.now()-360000).toISOString(),observedBeforeAt:new Date(Date.now()-360000).toISOString()},
    {...value,currentFreshnessVerified:true},{...value,apiKey:'PRIVATE-not-a-key'}]){
    await assert.rejects(f.finishObservation(job,invalid),/INVALID_FILE_SCANNER_OBSERVATION/);
    for(const table of ['file_inspection_attempts','file_content_signatures','file_format_assessments','file_scanner_observations'])assert.equal((await f.pg.query('SELECT * FROM public.'+table)).rows.length,0);
    assert.equal((await f.pg.query('SELECT state FROM public.file_inspection_jobs')).rows[0].state,'running');
  }
  await assert.rejects(f.finishObservation(job,value,'detected'),/INVALID_FILE_SCANNER_OBSERVATION/);
  assert.equal(await f.finishObservation(job,value),true);assert.equal(await f.finishObservation(job,value),false);
  assert.equal((await f.pg.query('SELECT * FROM public.file_scanner_observations')).rows.length,1);
});
check('scanner observation evidence is tenant-bound,source-private,immutable and unavailable through bypass finishers',async f=>{
  const item=await f.prepare(),job=await f.claim(),value=observation();assert.equal(await f.finishObservation({...job,academy_id:f.b},value),false);assert.equal(await f.finishObservation({...job,lease_token:randomUUID()},value),false);
  assert.equal(await f.finishObservation(job,value),true);
  await f.pg.query("INSERT INTO public.role_permissions VALUES($1,$2,'files.view','allow')",[f.a,f.managerRole]);
  assert.equal((await f.request('files/'+item.fileId+'/inspection',undefined,'manager')).response.status,200);
  for(const [actor,status] of [['staff',403],['peer',404]] as const){const denied=await f.request('files/'+item.fileId+'/inspection',undefined,actor);assert.equal(denied.response.status,status);assert.equal(denied.body.data,undefined);}
  assert.equal((await f.request('files/'+item.fileId+'/inspection',undefined,'foreignMaster',{academy:f.b})).response.status,404);
  try{
    await f.pg.exec('SET ROLE kavosh_runtime');await f.pg.query("SELECT set_config('app.academy_id',$1,false)",[f.a]);assert.equal((await f.pg.query('SELECT * FROM public.file_scanner_observations')).rows.length,1);
    await f.pg.query("SELECT set_config('app.academy_id',$1,false)",[f.b]);assert.equal((await f.pg.query('SELECT * FROM public.file_scanner_observations')).rows.length,0);
    for(const sql of ['DELETE FROM public.file_scanner_observations',"UPDATE public.file_scanner_observations SET input_sha256=repeat('0',64)",'INSERT INTO public.file_scanner_observations SELECT * FROM public.file_scanner_observations'])await assert.rejects(f.pg.exec(sql),/permission denied/i);
    await f.pg.exec('RESET ROLE');await f.pg.exec('SET ROLE kavosh_file_worker');
    await assert.rejects(f.pg.exec('SELECT * FROM public.file_scanner_observations'),/permission denied/i);
    await assert.rejects(f.pg.query('SELECT public.finish_file_inspection_image_evidence($1,$2,$3,$4,$5,$6,$7,$8,$9,NULL,NULL)',[f.a,item.inspectionId,randomUUID(),'no_detection','MEASURED_NO_DETECTION',bytes.length,sha256,'"etag"','text/plain']),/permission denied/i);
  }finally{await f.pg.exec('RESET ROLE');}
});
check('scanner observation composite identity and transactional outbox prevent misbinding or partial successful receipts',async f=>{
  await f.prepare();const job=await f.claim(),value=observation();
  await f.pg.exec(`CREATE FUNCTION public.test_scanner_event_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.event_type='file.scanner.database.observed' THEN RAISE EXCEPTION 'SYNTHETIC_SCANNER_EVENT_FAILURE';END IF;RETURN NEW;END $$;
    CREATE TRIGGER test_scanner_event_failure BEFORE INSERT ON public.outbox_events FOR EACH ROW EXECUTE FUNCTION public.test_scanner_event_failure()`);
  try{await assert.rejects(f.finishObservation(job,value),/SYNTHETIC_SCANNER_EVENT_FAILURE/);}finally{await f.pg.exec('DROP TRIGGER test_scanner_event_failure ON public.outbox_events;DROP FUNCTION public.test_scanner_event_failure()');}
  for(const table of ['file_inspection_attempts','file_format_assessments','file_scanner_observations'])assert.equal((await f.pg.query('SELECT * FROM public.'+table)).rows.length,0);
  assert.equal(await f.finish(job),true);
  await assert.rejects(f.pg.query('INSERT INTO public.file_scanner_observations(academy_id,inspection_id,attempt_no,input_bytes,input_sha256,result) VALUES($1,$2,1,$3,$4,$5::jsonb)',[f.a,job.inspection_id,bytes.length,'0'.repeat(64),JSON.stringify(value)]),/foreign key/i);
  assert.equal((await f.pg.query('SELECT * FROM public.file_scanner_observations')).rows.length,0);
});
test('schema112 preserves real schema111 attempts without inventing old scanner observations',async()=>{
  const f=await fixture(111);try{
    const item=await f.prepare();await assert.rejects(f.run(),/SCHEMA_NOT_CURRENT/);const job=await f.claim();assert.equal(await f.finish(job),true);
    const tables=['file_inspection_requests','file_inspection_jobs','file_inspection_attempts','file_content_signatures','file_format_assessments','file_image_evidence','outbox_events'];
    const snapshot=async()=>{const rows:unknown[]=[];for(const table of tables)rows.push((await f.pg.query('SELECT * FROM public.'+table)).rows);return rows;};const before=await snapshot();
    await f.pg.exec(await readFile(new URL('../db/migrations/112_file_scanner_observations.sql',import.meta.url),'utf8'));
    assert.deepEqual(await snapshot(),before);assert.equal((await f.pg.query('SELECT public.schema_revision() n')).rows[0].n,112);assert.equal((await f.pg.query('SELECT * FROM public.file_scanner_observations')).rows.length,0);
    await f.pg.exec(await readFile(new URL('../db/migrations/113_file_pdf_evidence.sql',import.meta.url),'utf8'));
    await f.pg.exec(await readFile(new URL('../db/migrations/114_file_storage_routes.sql',import.meta.url),'utf8'));await f.pg.exec(await readFile(new URL('../db/migrations/115_file_copy_requests.sql',import.meta.url),'utf8'));await f.pg.exec(await readFile(new URL('../db/migrations/116_file_copy_jobs.sql',import.meta.url),'utf8'));await f.pg.exec(await readFile(new URL('../db/migrations/117_file_copy_reconciliation.sql',import.meta.url),'utf8'));await f.pg.exec(await readFile(new URL('../db/migrations/118_private_file_downloads.sql',import.meta.url),'utf8'));await f.pg.exec(await readFile(new URL('../db/migrations/119_signature_dispatch.sql',import.meta.url),'utf8'));await f.pg.exec(await readFile(new URL('../db/migrations/120_signature_dispatch_contacts.sql',import.meta.url),'utf8'));await f.pg.exec(await readFile(new URL('../db/migrations/121_signature_original_binding.sql',import.meta.url),'utf8'));
    const view=(await f.request('files/'+item.fileId+'/inspection')).body.data;assert.equal(view.attempts[0].scannerObservation,null);assert.equal(view.safeToServe,false);
  }finally{await f.pg.close();}
});
if(process.env.TEST_DATABASE_URL)check('scanner observation concurrent finishes retain one exact attempt,observation and event',async f=>{
  await f.prepare();const job=await f.claim(),value=observation();assert.deepEqual((await Promise.all([f.finishObservation(job,value),f.finishObservation(job,value)])).sort(),[false,true]);
  for(const table of ['file_inspection_attempts','file_scanner_observations'])assert.equal((await f.pg.query('SELECT * FROM public.'+table)).rows.length,1);
  assert.equal((await f.pg.query("SELECT * FROM public.outbox_events WHERE event_type='file.scanner.database.observed'")).rows.length,1);
});
check('worker detection and content mismatch are recorded distinctly and neither grants clean access or releases capacity',async f=>{
  const a=await f.prepare();assert.deepEqual(await f.run(async()=>({...success,outcome:'detected'})),{claimed:true,recorded:true});
  assert.equal((await f.request('files/'+a.fileId+'/inspection')).body.data.processing.lastOutcome,'detected');
  const b=await f.prepare();assert.deepEqual(await f.run(async()=>({...success,sha256:'0'.repeat(64)})),{claimed:true,recorded:true});
  const v=(await f.request('files/'+b.fileId+'/inspection')).body.data;assert.equal(v.processing.state,'rejected');assert.equal(v.processing.lastOutcome,'content_mismatch');assert.equal(v.attempts[0].measuredBytes,null);assert.equal(v.safeToServe,false);assert.equal((await f.request('storage-policy')).body.data.reservedBytes,bytes.length*2);
});
check('unavailable worker attempts retry with bounded backoff and stop after five rather than retrying indefinitely',async f=>{
  const item=await f.prepare();for(let attempt=1;attempt<=5;attempt++) {
    assert.deepEqual(await f.run(async()=>({outcome:'unavailable',reason:'STORAGE_UNAVAILABLE'})),{claimed:true,recorded:true});
    const v=(await f.request('files/'+item.fileId+'/inspection')).body.data;assert.equal(v.processing.attemptCount,attempt);assert.equal(v.processing.state,attempt===5?'failed':'queued');assert.equal(v.attempts.length,attempt);
    assert.deepEqual(await f.run(async()=>{assert.fail('backoff/terminal state must prevent immediate reexecution');}),{claimed:false,recorded:false});
    if(attempt<5)await f.pg.query("UPDATE public.file_inspection_jobs SET available_at=clock_timestamp()-interval '1 second' WHERE inspection_id=$1",[item.inspectionId]);
  }
  assert.equal((await f.pg.query("SELECT * FROM public.outbox_events WHERE event_type='file.inspection.retry.scheduled'")).rows.length,4);assert.equal((await f.pg.query("SELECT * FROM public.outbox_events WHERE event_type='file.inspection.failed'")).rows.length,1);
});
check('expired leases fence late workers, preserve the abandoned attempt and allow a new worker to finish',async f=>{
  const item=await f.prepare(),old=await f.claim();assert.ok(old);assert.equal(await f.claim(),undefined);
  await f.pg.query("UPDATE public.file_inspection_jobs SET started_at=started_at-interval '1 hour',lease_until=clock_timestamp()-interval '1 second' WHERE inspection_id=$1",[item.inspectionId]);
  assert.equal(await f.finish(old),false);assert.deepEqual(await f.run(async()=>({...success,outcome:'detected'})),{claimed:true,recorded:true});assert.equal(await f.finish(old),false);
  const v=(await f.request('files/'+item.fileId+'/inspection')).body.data;assert.deepEqual(v.attempts.map((r:{outcome:string})=>r.outcome),['lease_expired','detected']);assert.equal(v.processing.attemptCount,2);assert.equal(v.processing.lastOutcome,'detected');
});
check('five abandoned leases end in one durable failure without a sixth claim or duplicate terminal event',async f=>{
  const item=await f.prepare();let last:Record<string,unknown>|undefined;
  for(let attempt=1;attempt<=5;attempt++) {
    last=await f.claim();assert.ok(last);assert.equal(last.attempt_no,attempt);
    await f.pg.query("UPDATE public.file_inspection_jobs SET started_at=started_at-interval '1 hour',lease_until=clock_timestamp()-interval '1 second' WHERE inspection_id=$1",[item.inspectionId]);
  }
  assert.equal(await f.claim(),undefined);assert.equal(await f.finish(last!),false);assert.equal(await f.claim(),undefined);
  const view=(await f.request('files/'+item.fileId+'/inspection')).body.data;
  assert.equal(view.processing.state,'failed');assert.equal(view.processing.attemptCount,5);assert.equal(view.attempts.length,5);assert.ok(view.attempts.every((a:{outcome:string})=>a.outcome==='lease_expired'));
  assert.equal((await f.pg.query("SELECT * FROM public.outbox_events WHERE event_type='file.inspection.failed' AND request_id=$1",[item.inspectionId])).rows.length,1);
});
check('missing or changed storage targets and scanner limits fail before object or socket IO',async f=>{
  await f.prepare();const taskPromise:InspectionTask[]=[];await f.run(async task=>{taskPromise.push(task);return success;});const task=taskPromise[0];
  const peer=await clamdPeer('success');let requests=0;
  const handler={async handle(){requests++;throw new Error('Storage must not be contacted');}};
  try {
    for(const [connections,scanner] of [[()=>null,peer.config],[()=>({...connection,bucket:'different-private-target'}),peer.config],[()=>connection,{...peer.config,maximumBytes:1}]] as const) {
      assert.deepEqual(await inspectStoredFile(task,connections,scanner,new AbortController().signal,5000,handler),{outcome:'unavailable',reason:'TARGET_UNAVAILABLE'});
    }
    assert.equal(requests,0);assert.equal(peer.connections(),0);
  }finally{await peer.close();}
});
check('an actual worker cycle composes native persistence, simulated S3 transport and local scanner-protocol IO without publishing',async f=>{
  for(const mode of ['success','detected','error']) {
    const item=await f.prepare(),peer=await clamdPeer(mode);let requests=0;const body=Readable.from([bytes]);
    try {
      const result=await f.run((task,signal)=>inspectStoredFile(task,()=>connection,peer.config,signal,5000,{async handle(request:{method:string;path:string}){
        requests++;assert.equal(request.method,'GET');assert.equal(request.path,'/'+connection.bucket+'/academies/'+f.a+'/quarantine/'+item.fileId);
        return {response:{statusCode:200,headers:{'content-length':String(bytes.length),'content-type':'application/octet-stream',etag:'"synthetic-etag"'},body}};
      }}));
      assert.deepEqual(result,{claimed:true,recorded:true});assert.equal(requests,1);assert.equal(peer.connections(),1);assert.deepEqual(Buffer.concat(peer.received),bytes);assert.equal(body.destroyed,true);
      const view=(await f.request('files/'+item.fileId+'/inspection')).body.data;assert.equal(view.processing.state,mode==='error'?'queued':'evidence_recorded');assert.equal(view.processing.lastOutcome,mode==='error'?'unavailable':mode==='detected'?'detected':'no_detection');assert.equal(view.safeToServe,false);
      if(mode!=='error'){assert.equal(view.attempts[0].sha256,sha256);assert.deepEqual(view.attempts[0].contentSignature,mode==='detected'?null:{detector:'file-type@22.3.0',sampleBytes:bytes.length,sampleSha256:sha256,mime:null,extension:null});}
    }finally{await peer.close();body.destroy();}
  }
});
check('worker deadlines, shutdown and malformed inspector results fail closed without persisting raw diagnostics',async f=>{
  const timed=await f.prepare();let cancelled:AbortSignal|undefined;
  await f.run(async(_task,signal)=>{cancelled=signal;return new Promise<never>(()=>{});},[f.a],{timeoutMs:20});assert.equal(cancelled?.aborted,true);
  assert.equal((await f.request('files/'+timed.fileId+'/inspection')).body.data.processing.lastReason,'INSPECTION_TIMEOUT');
  const stopped=await f.prepare(),controller=new AbortController();await f.run(async()=>{controller.abort();return new Promise<never>(()=>{});},[f.a],{signal:controller.signal});
  assert.equal((await f.request('files/'+stopped.fileId+'/inspection')).body.data.processing.lastReason,'WORKER_STOPPED');
  const invalid=await f.prepare();await f.run(async()=>({...success,clean:true} as InspectionResult));const v=(await f.request('files/'+invalid.fileId+'/inspection')).body.data;assert.equal(v.processing.lastReason,'INSPECTOR_INVALID_RESULT');assert.equal(v.attempts[0].sha256,null);
  const broken=await f.prepare();await f.run(async()=>{throw new Error('Private synthetic provider credential diagnostic');});assert.ok(!JSON.stringify((await f.request('files/'+broken.fileId+'/inspection')).body).includes('Private synthetic'));
  const untouched=await f.prepare(),pre=new AbortController();pre.abort();assert.deepEqual(await f.run(async()=>{assert.fail('pre-cancelled worker cannot run IO');},[f.a],{signal:pre.signal}),{claimed:false,recorded:false});assert.equal((await f.request('files/'+untouched.fileId+'/inspection')).body.data.processing.attemptCount,0);
});
check('worker scope skips other schools, suspended academies and archived files while retaining the pinned immutable claims',async f=>{
  const local=await f.prepare(),foreign=await f.prepare(f.b);await f.run(async task=>{assert.equal(task.academyId,f.a);return success;});assert.equal((await f.pg.query<{attempt_no:number}>('SELECT attempt_no FROM public.file_inspection_jobs WHERE academy_id=$1',[f.b])).rows[0].attempt_no,0);
  await f.run(async task=>{assert.equal(task.academyId,f.b);return success;},[f.b]);assert.equal((await f.pg.query<{state:string}>('SELECT state FROM public.file_inspection_jobs WHERE inspection_id=$1',[foreign.inspectionId])).rows[0].state,'evidence_recorded');
  const pending=await f.prepare();await f.pg.query("UPDATE public.academies SET status='suspended' WHERE id=$1",[f.a]);assert.deepEqual(await f.run(async()=>{assert.fail('suspended academy');}),{claimed:false,recorded:false});await f.pg.query("UPDATE public.academies SET status='active' WHERE id=$1",[f.a]);
  assert.equal((await f.request('files/'+pending.fileId+'/change',{expectedVersion:1,archived:true})).response.status,200);assert.deepEqual(await f.run(async()=>{assert.fail('archived file');}),{claimed:false,recorded:false});assert.equal((await f.request('files/'+pending.fileId+'/change',{expectedVersion:2,archived:false,name:'Renamed after inspection request.txt'})).response.status,200);
  await f.run(async task=>{assert.equal(task.fileId,pending.fileId);assert.equal(task.expectedSha256,sha256);assert.equal('name' in task,false);return success;});assert.notEqual(local.fileId,pending.fileId);
});
check('failed evidence event persistence rolls back the attempt and state together, then lease recovery can safely retry',async f=>{
  const item=await f.prepare();await f.pg.exec('REVOKE INSERT ON public.outbox_events FROM kavosh_file_policy');
  try{await assert.rejects(f.run(),/permission denied/i);}finally{await f.pg.exec('GRANT INSERT ON public.outbox_events TO kavosh_file_policy');}
  assert.equal((await f.pg.query('SELECT * FROM public.file_inspection_attempts')).rows.length,0);assert.equal((await f.pg.query<{state:string}>('SELECT state FROM public.file_inspection_jobs')).rows[0].state,'running');
  await f.pg.query("UPDATE public.file_inspection_jobs SET started_at=started_at-interval '1 hour',lease_until=clock_timestamp()-interval '1 second' WHERE inspection_id=$1",[item.inspectionId]);assert.deepEqual(await f.run(),{claimed:true,recorded:true});
  assert.deepEqual((await f.pg.query<{outcome:string}>('SELECT outcome FROM public.file_inspection_attempts ORDER BY attempt_no')).rows.map(r=>r.outcome),['lease_expired','no_detection']);
});
check('worker SQL cannot read private profiles or modify business/queue rows, and web SQL cannot steal a lease or submit evidence',async f=>{
  await f.prepare();await f.pg.exec('SET ROLE kavosh_file_worker');try {
    for(const table of ['file_records','file_inspection_jobs','file_inspection_attempts','student_profiles','people'])await assert.rejects(f.pg.query('SELECT * FROM public.'+table),/permission denied/i);
    await assert.rejects(f.pg.query('SELECT * FROM identity."user"'),/permission denied/i);await assert.rejects(f.pg.query("UPDATE public.file_inspection_jobs SET state='queued'"),/permission denied/i);
  }finally{await f.pg.exec('RESET ROLE');}
  await f.pg.exec('SET ROLE kavosh_runtime');try {
    await f.pg.query("SELECT set_config('app.academy_id',$1,false)",[f.a]);assert.equal((await f.pg.query('SELECT state FROM public.file_inspection_jobs')).rows.length,1);
    await assert.rejects(f.pg.query('SELECT lease_token FROM public.file_inspection_jobs'),/permission denied/i);await assert.rejects(f.pg.query('SELECT * FROM public.claim_file_inspection($1,$2,30)',[[f.a],f.worker]),/permission denied/i);
    await assert.rejects(f.pg.query('UPDATE public.file_inspection_attempts SET sha256=NULL'),/permission denied/i);
  }finally{await f.pg.exec('RESET ROLE');}
});
check('combined service memberships are rejected by both worker and existing web/identity guards',async f=>{
  await f.prepare();for(const role of ['kavosh_file_worker','kavosh_file_policy']) {
    await f.pg.exec('GRANT '+role+' TO kavosh_runtime');try{assert.equal((await f.request('hubs')).response.status,503);}finally{await f.pg.exec('REVOKE '+role+' FROM kavosh_runtime');}
  }
  for(const role of ['kavosh_runtime','kavosh_file_policy']) {
    await f.pg.exec('GRANT '+role+' TO kavosh_file_worker');try{await assert.rejects(f.run(async()=>{assert.fail('unsafe worker must not perform IO');}),/UNSAFE_FILE_WORKER_ROLE/);}finally{await f.pg.exec('REVOKE '+role+' FROM kavosh_file_worker');}
  }
  await f.pg.exec('GRANT kavosh_file_worker TO kavosh_identity');const identity=f.pg.identityDb();
  try{await f.pg.exec('SET ROLE kavosh_identity');await assert.rejects(new IdentityStore(identity,'s'.repeat(32)).safe(),/UNSAFE_IDENTITY_ROLE/);}
  finally{await f.pg.exec('RESET ROLE');await f.pg.exec('REVOKE kavosh_file_worker FROM kavosh_identity');if(f.pg.runtime)await identity.destroy();}
});
check('native evidence completion rejects forged sizes, hashes, classification and missing proof without partially recording',async f=>{
  await f.prepare();const job=await f.claim(),c=await f.database.connect();try {
    for(const [outcome,reason,size,hash,etag] of [['no_detection','MEASURED_NO_DETECTION',bytes.length+1,sha256,'"e"'],['no_detection','MEASURED_NO_DETECTION',bytes.length,'0'.repeat(64),'"e"'],['clean','MEASURED_NO_DETECTION',bytes.length,sha256,'"e"'],['no_detection','MEASURED_NO_DETECTION',bytes.length,sha256,null]])
      await assert.rejects(c.query('SELECT public.finish_file_inspection($1,$2,$3,$4,$5,$6,$7,$8,$9,NULL)',[job.academy_id,job.inspection_id,job.lease_token,outcome,reason,size,hash,etag,'application/octet-stream']),/INVALID_INSPECTION_RESULT/);
  }finally{c.release();await f.pg.exec('RESET ROLE');}
  assert.equal((await f.pg.query('SELECT * FROM public.file_inspection_attempts')).rows.length,0);assert.equal(await f.finish(job),true);
});
check('invalid content signature evidence rolls back measurement, job status and event together; native rows are immutable',async f=>{
  const item=await f.prepare(),job=await f.claim(),signature={detector:'file-type@22.3.0',sampleBytes:bytes.length,sampleSha256:sha256,mime:null,extension:null};
  const c=await f.database.connect();try {
    for(const value of [{...signature,sampleBytes:0},{...signature,sampleBytes:bytes.length+1},{...signature,sampleBytes:'1'},{...signature,sampleSha256:'0'.repeat(64)},{...signature,mime:'image/png'},{...signature,extension:'../png'},{...signature,safe:true},{...signature,detector:'unverified'}]) {
      await assert.rejects(c.query('SELECT public.finish_file_inspection($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)',[f.a,item.inspectionId,job.lease_token,'no_detection','MEASURED_NO_DETECTION',bytes.length,sha256,'"etag"','text/plain',JSON.stringify(value)]),/INVALID_CONTENT_SIGNATURE/);
    }
    await assert.rejects(c.query('SELECT public.finish_file_inspection_measurements($1,$2,$3,$4,$5,$6,$7,$8,$9)',[f.a,item.inspectionId,job.lease_token,'no_detection','MEASURED_NO_DETECTION',bytes.length,sha256,'"etag"','text/plain']),/permission denied/i);
  }finally{c.release();await f.pg.exec('RESET ROLE');}
  assert.equal((await f.pg.query('SELECT * FROM public.file_inspection_attempts')).rows.length,0);assert.equal((await f.pg.query('SELECT * FROM public.file_content_signatures')).rows.length,0);
  assert.equal((await f.pg.query("SELECT * FROM public.outbox_events WHERE event_type='file.inspection.evidence.recorded'")).rows.length,0);assert.equal((await f.pg.query<{state:string}>('SELECT state FROM public.file_inspection_jobs')).rows[0].state,'running');
  assert.equal(await f.finish(job),true);
  await f.pg.exec('SET ROLE kavosh_file_worker');try{await assert.rejects(f.pg.query('SELECT * FROM public.file_content_signatures'),/permission denied/i);}finally{await f.pg.exec('RESET ROLE');}
  await f.pg.exec('SET ROLE kavosh_runtime');try{await assert.rejects(f.pg.query('UPDATE public.file_content_signatures SET mime=NULL'),/permission denied/i);}finally{await f.pg.exec('RESET ROLE');}
});
check('signature persistence failure cannot leave a completed measurement or successful outbox event',async f=>{
  await f.prepare();await f.pg.exec('REVOKE INSERT ON public.file_content_signatures FROM kavosh_file_policy');
  try{await assert.rejects(f.run(async()=>({...success,signature:{detector:'file-type@22.3.0',sampleBytes:bytes.length,sampleSha256:sha256,mime:null,extension:null}})),/permission denied/i);}
  finally{await f.pg.exec('GRANT INSERT ON public.file_content_signatures TO kavosh_file_policy');}
  assert.equal((await f.pg.query('SELECT * FROM public.file_inspection_attempts')).rows.length,0);assert.equal((await f.pg.query('SELECT * FROM public.file_content_signatures')).rows.length,0);assert.equal((await f.pg.query<{state:string}>('SELECT state FROM public.file_inspection_jobs')).rows[0].state,'running');
  assert.equal((await f.pg.query("SELECT * FROM public.outbox_events WHERE event_type='file.inspection.evidence.recorded'")).rows.length,0);
});
test('streamed content signature samples only a bounded prefix and stays distinct from claimed/provider types and whole-object hash',async()=>{
  const data=Buffer.concat([Buffer.from('%PDF-1.7\nSignature hint only, not document validation.\n'),Buffer.alloc(50000,65)]),academyId=randomUUID(),fileId=randomUUID(),peer=await clamdPeer('success');
  const task:InspectionTask={academyId,fileId,inspectionId:randomUUID(),leaseToken:randomUUID(),attemptNo:1,storageTargetId:createHash('sha256').update(JSON.stringify([connection.accountId,connection.jurisdiction,connection.bucket])).digest('hex'),expectedBytes:data.length,expectedSha256:createHash('sha256').update(data).digest('hex'),claimedMimeType:'image/jpeg'};
  try {
    const result=await inspectStoredFile(task,()=>({...connection,maximumUploadBytes:100000}),peer.config,new AbortController().signal,5000,{async handle(){return {response:{statusCode:200,headers:{'content-length':String(data.length),'content-type':'text/plain',etag:'"synthetic-etag"'},body:Readable.from([data.subarray(0,100),data.subarray(100)])}};}});
    assert.equal(result.outcome,'no_detection');assert.ok('signature' in result);assert.equal(result.signature?.sampleBytes,16384);assert.equal(result.signature?.sampleSha256,createHash('sha256').update(data.subarray(0,16384)).digest('hex'));assert.equal(result.signature?.mime,'application/pdf');assert.equal(result.providerContentType,'text/plain');assert.equal(result.sha256,task.expectedSha256);assert.equal('safeToServe' in result,false);
  }finally{await peer.close();}
});
test('file worker command refuses disabled or shared-credential environments without exposing configuration',()=>{
  for(const extra of [{FILE_INSPECTION_WORKER_ENABLED:'false'},{FILE_INSPECTION_WORKER_ENABLED:'true',AUTH_SECRET:'synthetic-private-auth-secret'}]) {
    const r=spawnSync(process.execPath,['--import','tsx','scripts/inspect-files.ts'],{cwd:new URL('../',import.meta.url),env:{NODE_ENV:'production',PATH:process.env.PATH,...extra},encoding:'utf8',timeout:5000});assert.equal(r.status,1);assert.match(r.stderr,/File inspection worker stopped/);assert.ok(!r.stderr.includes('synthetic-private-auth-secret'));assert.equal(r.stdout,'');
  }
});
if(process.env.TEST_DATABASE_URL)check('parallel worker claims take different jobs and cannot complete the same lease twice',async f=>{
  await f.prepare();await f.prepare();const claims=await Promise.all([f.claim(),f.claim()]);assert.ok(claims[0]);assert.ok(claims[1]);assert.notEqual(claims[0].inspection_id,claims[1].inspection_id);assert.notEqual(claims[0].lease_token,claims[1].lease_token);
  const twice=await Promise.all([f.finish(claims[0]),f.finish(claims[0])]);assert.deepEqual(twice.sort(),[false,true]);assert.equal(await f.finish(claims[1]),true);assert.equal((await f.pg.query('SELECT * FROM public.file_inspection_attempts')).rows.length,2);
});
if(process.env.TEST_DATABASE_URL)check('concurrent measured signature completion is fenced to one attempt and one bound signature row',async f=>{
  await f.prepare();const job=await f.claim(),signature={detector:'file-type@22.3.0',sampleBytes:bytes.length,sampleSha256:sha256,mime:null,extension:null};
  const finish=async(academy=f.a)=>{const c=await f.database.connect();try{return (await c.query<{recorded:boolean}>('SELECT public.finish_file_inspection($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb) AS recorded',[academy,job.inspection_id,job.lease_token,'no_detection','MEASURED_NO_DETECTION',bytes.length,sha256,'"etag"','text/plain',JSON.stringify(signature)])).rows[0].recorded;}finally{c.release();}};
  assert.equal(await finish(f.b),false);assert.deepEqual((await Promise.all([finish(),finish()])).sort(),[false,true]);assert.equal(f.held(),0);
  assert.equal((await f.pg.query('SELECT * FROM public.file_inspection_attempts')).rows.length,1);assert.equal((await f.pg.query('SELECT * FROM public.file_content_signatures')).rows.length,1);
});
if(process.env.TEST_DATABASE_URL)check('a locked pending job is skipped so another job can be leased without waiting for its owner',async f=>{
  const a=await f.prepare(),b=await f.prepare();await f.pg.exec('BEGIN');let open=true;
  try {await f.pg.query('SELECT inspection_id FROM public.file_inspection_jobs WHERE inspection_id=$1 FOR UPDATE',[a.inspectionId]);const job=await f.claim();assert.equal(job.inspection_id,b.inspectionId);await f.pg.exec('COMMIT');open=false;assert.equal(await f.finish(job),true);const next=await f.claim();assert.equal(next.inspection_id,a.inspectionId);}
  finally{if(open)await f.pg.exec('ROLLBACK');}
});
if(process.env.TEST_DATABASE_URL)check('one hundred concurrent native worker cycles keep one immutable attempt per job through a four-connection pool',async f=>{
  const first=await f.prepare();assert.equal((await f.request('storage-policy',{expectedVersion:1,uploadsEnabled:true,maximumFileBytes:100,maximumReservedBytes:10000,maximumFiles:200,reason:'Synthetic concurrent worker budget'})).response.status,200);
  // This is worker/database orchestration load, not an API provisioning test.
  // Seed synthetic setup directly; never disable user/API anti-abuse limits.
  await f.pg.exec('BEGIN');try {
    await f.pg.exec('CREATE TEMP TABLE synthetic_worker_seed AS SELECT gen_random_uuid() AS file_id,gen_random_uuid() AS grant_id,gen_random_uuid() AS inspection_id FROM generate_series(1,99)');
    await f.pg.query(`INSERT INTO public.file_records(academy_id,id,anchor_kind,hub_id,domain,name,claimed_mime_type,expected_bytes,expected_sha256,search_text,created_by)
      SELECT $1,s.file_id,'hub',$2,'general','Synthetic worker.txt','text/plain',$3,$4,'Synthetic worker',$5 FROM synthetic_worker_seed s`,[f.a,f.hub,bytes.length,sha256,f.actors.master.person]);
    await f.pg.query(`INSERT INTO public.file_record_revisions(academy_id,file_id,version,definition,changed_by,reason)
      SELECT r.academy_id,s.file_id,1,r.definition||jsonb_build_object('id',s.file_id),r.changed_by,'Synthetic load setup' FROM public.file_record_revisions r CROSS JOIN synthetic_worker_seed s WHERE r.academy_id=$1 AND r.file_id=$2`,[f.a,first.fileId]);
    await f.pg.query(`INSERT INTO public.file_upload_reservations(academy_id,file_id,reserved_bytes,policy_version,created_by,storage_target_id)
      SELECT r.academy_id,s.file_id,r.reserved_bytes,p.version,r.created_by,r.storage_target_id FROM public.file_upload_reservations r JOIN public.file_storage_policies p ON p.academy_id=r.academy_id CROSS JOIN synthetic_worker_seed s WHERE r.academy_id=$1 AND r.file_id=$2`,[f.a,first.fileId]);
    await f.pg.query(`INSERT INTO public.file_upload_grants(academy_id,id,file_id,metadata_version,storage_target_id,created_by,issued_at,expires_at)
      SELECT g.academy_id,s.grant_id,s.file_id,1,g.storage_target_id,g.created_by,g.issued_at,g.expires_at FROM public.file_upload_grants g CROSS JOIN synthetic_worker_seed s WHERE g.academy_id=$1 AND g.file_id=$2`,[f.a,first.fileId]);
    await f.pg.query(`INSERT INTO public.file_inspection_requests(academy_id,id,file_id,grant_id,metadata_version,storage_target_id,requested_by)
      SELECT r.academy_id,s.inspection_id,s.file_id,s.grant_id,1,r.storage_target_id,r.requested_by FROM public.file_inspection_requests r CROSS JOIN synthetic_worker_seed s WHERE r.academy_id=$1 AND r.file_id=$2`,[f.a,first.fileId]);
    await f.pg.query('UPDATE public.file_storage_policies SET reserved_files=100,reserved_bytes=$2 WHERE academy_id=$1',[f.a,100*bytes.length]);await f.pg.exec('COMMIT');
  }catch(error){await f.pg.exec('ROLLBACK');throw error;}
  const files=new Set([first.fileId,...(await f.pg.query<{file_id:string}>('SELECT file_id FROM synthetic_worker_seed')).rows.map(r=>r.file_id)]);assert.equal(files.size,100);
  const seen=new Set<string>(),durations:number[]=[];let queries=0;
  const measured:Database={async connect(){const c=await f.database.connect();return {async query<Row>(sql:string,params?:unknown[]){queries++;return c.query<Row>(sql,params);},release(destroy?:boolean){c.release(destroy);}};}};
  const results=await Promise.all(Array.from({length:100},async()=>{
    const start=performance.now();const result=await processOneInspection(measured,[f.a],randomUUID(),async task=>{
      assert.ok(files.has(task.fileId));assert.equal(seen.has(task.inspectionId),false);seen.add(task.inspectionId);return success;
    });durations.push(performance.now()-start);return result;
  }));
  assert.ok(results.every(r=>r.claimed&&r.recorded));assert.equal(seen.size,100);assert.equal(f.held(),0);assert.equal(queries,600);
  const attempts=(await f.pg.query<{total:number;distinct_jobs:number}>('SELECT count(*)::integer AS total,count(DISTINCT inspection_id)::integer AS distinct_jobs FROM public.file_inspection_attempts')).rows[0];assert.deepEqual(attempts,{total:100,distinct_jobs:100});
  const screens=(await f.pg.query<{total:number;unassessed:number}>("SELECT count(*)::int AS total,count(*) FILTER(WHERE state='unassessed' AND reason_code='SIGNATURE_MISSING')::int AS unassessed FROM public.file_format_assessments")).rows[0];assert.deepEqual(screens,{total:100,unassessed:100});
  assert.equal((await f.pg.query("SELECT inspection_id FROM public.file_inspection_jobs WHERE state<>'evidence_recorded'")).rows.length,0);
  console.log(JSON.stringify({measurement:'native-file-worker-cycles',jobs:100,concurrentCalls:100,poolMaximum:4,queries,p99Ms:Math.ceil(durations.sort((a,b)=>a-b)[98]),physicalObjectReads:0,actualEngineScans:0}));
});
