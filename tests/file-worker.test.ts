import assert from 'node:assert/strict';
import { createHash,randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { operationsFixture } from './operations-fixture.ts';
import { processOneInspection,assertFileWorkerRole,type InspectionResult,type InspectionTask } from '../src/files/inspection-worker.ts';
import type { Database } from '../src/core/database.ts';
import { inspectStoredFile } from '../src/files/inspection-worker.ts';
import { clamdPeer } from './fixtures/clamd-peer.ts';
import { Readable } from 'node:stream';
import { IdentityStore } from '../src/auth/store.ts';
import { spawnSync } from 'node:child_process';

const bytes=Buffer.from('Synthetic file-worker content.'),sha256=createHash('sha256').update(bytes).digest('hex');
const success:InspectionResult={outcome:'no_detection',bytes:bytes.length,sha256,etag:'"synthetic-etag"',providerContentType:'application/octet-stream'};
const connection={accountId:'a'.repeat(32),jurisdiction:'default' as const,bucket:'synthetic-private-quarantine',accessKeyId:'synthetic-access-id',secretAccessKey:'synthetic-r2-secret-not-a-real-key',maximumUploadBytes:1000};
async function fixture() {
  const f=await operationsFixture({connections:()=>({accountId:'a'.repeat(32),jurisdiction:'default',bucket:'synthetic-private-quarantine',accessKeyId:'synthetic-access-id',secretAccessKey:'synthetic-r2-secret-not-a-real-key',maximumUploadBytes:1000})});
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
  async function finish(job:Record<string,unknown>,outcome='no_detection') {const c=await database.connect();try{return (await c.query<{recorded:boolean}>('SELECT public.finish_file_inspection($1,$2,$3,$4,$5,$6,$7,$8,$9) AS recorded',[job.academy_id,job.inspection_id,job.lease_token,outcome,outcome==='detected'?'MEASURED_DETECTION':'MEASURED_NO_DETECTION',bytes.length,sha256,'"synthetic-etag"','application/octet-stream'])).rows[0].recorded;}finally{c.release();await f.pg.exec('RESET ROLE');}}
  return {...f,prepare,run,claim,finish,database,worker,held:()=>held};
}
type Fixture=Awaited<ReturnType<typeof fixture>>;
function check(name:string,run:(f:Fixture)=>Promise<void>){test(name,async()=>{const f=await fixture();try{await run(f);}finally{await f.pg.close();}});}

check('a separate non-owner worker leases minimal claims, releases DB during IO and records immutable measured evidence without publishing',async f=>{
  const item=await f.prepare();let calls=0;
  const r=await f.run(async(task)=>{calls++;assert.equal(task.academyId,f.a);assert.equal(task.fileId,item.fileId);assert.equal(task.expectedBytes,bytes.length);assert.equal(task.expectedSha256,sha256);assert.equal('name' in task,false);assert.equal('requestedBy' in task,false);return success;});
  assert.deepEqual(r,{claimed:true,recorded:true});assert.equal(calls,1);
  const view=await f.request('files/'+item.fileId+'/inspection');assert.equal(view.body.data.processing.state,'evidence_recorded');assert.equal(view.body.data.processing.lastOutcome,'no_detection');assert.equal(view.body.data.attempts.length,1);assert.equal(view.body.data.attempts[0].sha256,sha256);assert.equal(view.body.data.safeToServe,false);assert.equal(view.body.data.uploadVerified,false);assert.equal(view.body.data.physicalStorageVerified,false);assert.ok(!JSON.stringify(view.body).includes('leaseToken'));
  assert.deepEqual(await f.run(async()=>{assert.fail('finished evidence cannot be claimed again');}),{claimed:false,recorded:false});
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
      if(mode!=='error')assert.equal(view.attempts[0].sha256,sha256);
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
      await assert.rejects(c.query('SELECT public.finish_file_inspection($1,$2,$3,$4,$5,$6,$7,$8,$9)',[job.academy_id,job.inspection_id,job.lease_token,outcome,reason,size,hash,etag,'application/octet-stream']),/INVALID_INSPECTION_RESULT/);
  }finally{c.release();await f.pg.exec('RESET ROLE');}
  assert.equal((await f.pg.query('SELECT * FROM public.file_inspection_attempts')).rows.length,0);assert.equal(await f.finish(job),true);
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
if(process.env.TEST_DATABASE_URL)check('a locked pending job is skipped so another job can be leased without waiting for its owner',async f=>{
  const a=await f.prepare(),b=await f.prepare();await f.pg.exec('BEGIN');let open=true;
  try {await f.pg.query('SELECT inspection_id FROM public.file_inspection_jobs WHERE inspection_id=$1 FOR UPDATE',[a.inspectionId]);const job=await f.claim();assert.equal(job.inspection_id,b.inspectionId);await f.pg.exec('COMMIT');open=false;assert.equal(await f.finish(job),true);const next=await f.claim();assert.equal(next.inspection_id,a.inspectionId);}
  finally{if(open)await f.pg.exec('ROLLBACK');}
});
