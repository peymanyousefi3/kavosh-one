import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { fixture,hash,config } from './file-copy-fixture.ts';
import { workFixture } from './work-fixture.ts';
import { processOneCopy,copyStoredFile,type CopyTask,type CopyResult } from '../src/files/copy-worker.ts';
import type { Database } from '../src/core/database.ts';

type Fixture=Awaited<ReturnType<typeof fixture>>;
function check(name:string,run:(f:Fixture)=>Promise<void>){test(name,async()=>{const f=await fixture();try{await run(f);}finally{await f.pg.close();}});}
function worker(f:Fixture){let active=0;const database:Database={async connect(){const c=f.pg.runtime?await f.pg.runtime.connect():{async query<Row>(sql:string,params?:unknown[]){return f.pg.query<Row>(sql,params);},release(){}};await c.query('SET ROLE kavosh_file_worker');active++;return {query:c.query.bind(c),release(){active--;c.release();}};}};
 // Embedded tests share one SQL session;simulate the separate administrative
 // connection used by native concurrent business changes during storage IO.
 return {get active(){return active;},async run(copy:(task:CopyTask,signal:AbortSignal)=>Promise<CopyResult>,options:Parameters<typeof processOneCopy>[4]={}){try{return await processOneCopy(database,[f.a],randomUUID(),async(t,s)=>{if(!f.pg.runtime)await f.pg.exec('RESET ROLE');return copy(t,s);},options);}finally{if(!f.pg.runtime)await f.pg.exec('RESET ROLE');}}};}
const proof=(t:CopyTask):CopyResult=>({outcome:'written_verified',bytes:t.expectedBytes,sha256:t.expectedSha256,source:{storageTargetId:t.sourceTargetId,etag:'"synthetic-source"'},destination:{storageTargetId:t.destinationTargetId,etag:'"synthetic-destination"'}});
async function queued(f:Fixture){const file=await f.file(),r=await f.copy(file);assert.equal(r.response.status,202,JSON.stringify(r.body));return {...file,copyId:r.body.data.id};}
const job=async(f:Fixture,id:string)=>(await f.pg.query('SELECT * FROM public.file_copy_jobs WHERE copy_id=$1',[id])).rows[0];
check('durable copy worker leases minimal claims,releases DB during IO and records exact receipt without download authority',async f=>{
 const item=await queued(f),w=worker(f);assert.equal((await job(f,item.copyId)).state,'queued');assert.deepEqual(await w.run(async t=>{assert.equal(w.active,0);assert.equal(t.fileId,item.id);assert.equal(t.expectedSha256,hash(f.bytes));assert.deepEqual(Object.keys(t).sort(),['academyId','attemptNo','copyId','destinationTargetId','expectedBytes','expectedSha256','fileId','leaseToken','sourceFingerprint','sourceTargetId']);return proof(t);}),{claimed:true,recorded:true});
 assert.equal((await job(f,item.copyId)).state,'verified');const a=(await f.pg.query('SELECT * FROM public.file_copy_attempts')).rows[0];assert.equal(a.sources_current,true);assert.equal(a.sha256,hash(f.bytes));assert.equal(a.outcome,'written_verified');assert.equal((await f.pg.query("SELECT * FROM public.outbox_events WHERE event_type='file.copy.verified'")).rows.length,1);const view=(await f.request('files/'+item.id+'/copies')).body.data[0];assert.equal(view.downloadAuthorized,false);assert.equal(view.state,'verified');assert.equal(view.physicalCopyVerified,true);assert.deepEqual(await w.run(async()=>{throw Error('MUST_NOT_REPLAY');}),{claimed:false,recorded:false});
});
check('source changes before claim block work without invoking storage or fabricating measured evidence',async f=>{
 const item=await queued(f);assert.equal((await f.request('files/'+item.id+'/change',{expectedVersion:1,archived:true,reason:'Synthetic withdrawal'})).response.status,200);assert.deepEqual(await worker(f).run(async()=>{throw Error('MUST_NOT_COPY');}),{claimed:false,recorded:false});assert.equal((await job(f,item.copyId)).state,'blocked');assert.equal((await f.pg.query('SELECT * FROM public.file_copy_attempts')).rows.length,0);
});
check('source changes during IO preserve the physical receipt but block its use and never authorize a download',async f=>{
 const item=await queued(f);await worker(f).run(async t=>{assert.equal((await f.request('storage/routes/'+f.route.id+'/change',{expectedVersion:1,definition:{...f.route.definition,enabled:false},reason:'Synthetic route revocation during copy'})).response.status,200);return proof(t);});assert.equal((await job(f,item.copyId)).state,'blocked');const a=(await f.pg.query('SELECT * FROM public.file_copy_attempts')).rows[0];assert.equal(a.outcome,'written_verified');assert.equal(a.sources_current,false);assert.equal((await f.request('files/'+item.id+'/copies')).body.data[0].recordedSourcesCurrent,false);
});
check('unknown physical outcomes,malformed proofs and timeouts are durable uncertain states,never automatic retries',async f=>{
 for(const mode of ['unknown','wrong-hash','throws','timeout']){const item=await queued(f);await worker(f).run(async t=>{if(mode==='unknown')return {outcome:'outcome_unknown'};if(mode==='throws')throw Error('SYNTHETIC_AMBIGUOUS_STORAGE_ERROR');if(mode==='timeout')return new Promise(()=>{});return {...proof(t),sha256:'0'.repeat(64)} as CopyResult;},{timeoutMs:mode==='timeout'?10:10000});assert.equal((await job(f,item.copyId)).state,'uncertain');const a=(await f.pg.query('SELECT * FROM public.file_copy_attempts WHERE copy_id=$1',[item.copyId])).rows[0];assert.equal(a.outcome,'outcome_unknown');assert.equal(a.measured_bytes,null);}
 assert.deepEqual(await worker(f).run(async()=>{throw Error('NO_BLIND_RETRY');}),{claimed:false,recorded:false});assert.equal((await f.pg.query("SELECT * FROM public.outbox_events WHERE event_type='file.copy.uncertain.critical'")).rows.length,4);
});
check('known pre-write failures retry with bounded backoff while content mismatches are terminal',async f=>{
 const item=await queued(f),w=worker(f);for(let i=1;i<=5;i++){await w.run(async()=>({outcome:'unavailable'}));const j=await job(f,item.copyId);assert.equal(j.attempt_no,i);assert.equal(j.state,i===5?'failed':'queued');if(i<5)await f.pg.query("UPDATE public.file_copy_jobs SET available_at=clock_timestamp()-interval '1 second' WHERE copy_id=$1",[item.copyId]);}
 for(const outcome of ['source_mismatch','destination_mismatch'] as const){const next=await queued(f);await w.run(async()=>({outcome}));assert.equal((await job(f,next.copyId)).state,'failed');}
});
check('native lease fencing rejects wrong tokens,expired results and expired work becomes uncertain without replay',async f=>{
 const item=await queued(f);let captured:CopyTask|undefined;await worker(f).run(async t=>{captured=t;await f.pg.query("UPDATE public.file_copy_jobs SET started_at=clock_timestamp()-interval '2 minutes',lease_until=clock_timestamp()-interval '1 minute' WHERE copy_id=$1",[t.copyId]);return proof(t);});assert.equal((await job(f,item.copyId)).state,'running');assert.ok(captured);
 assert.deepEqual(await worker(f).run(async()=>{throw Error('NO_REPLAY_AFTER_EXPIRED_WRITE');}),{claimed:false,recorded:false});assert.equal((await job(f,item.copyId)).state,'uncertain');assert.equal((await f.pg.query('SELECT outcome FROM public.file_copy_attempts')).rows[0].outcome,'lease_expired');
 assert.equal((await f.pg.query('SELECT public.finish_file_copy($1,$2,$3,$4::jsonb) ok',[f.a,item.copyId,captured.leaseToken,JSON.stringify(proof(captured))])).rows[0].ok,false);
});
check('native copy functions deny web mutations and table access to worker,tenant reads remain isolated',async f=>{
 const item=await queued(f);await f.pg.exec('SET ROLE kavosh_runtime');try{await f.pg.query("SELECT set_config('app.academy_id',$1,false)",[f.b]);assert.equal((await f.pg.query('SELECT * FROM public.file_copy_jobs')).rows.length,0);await assert.rejects(f.pg.query('SELECT * FROM public.claim_file_copy($1,$2,30)',[[f.a],randomUUID()]),/permission denied/);await assert.rejects(f.pg.exec("UPDATE public.file_copy_jobs SET state='verified'"),/permission denied/);}finally{await f.pg.exec('RESET ROLE');}
 await f.pg.exec('SET ROLE kavosh_file_worker');try{await assert.rejects(f.pg.exec('SELECT * FROM public.file_copy_requests'),/permission denied/);await assert.rejects(f.pg.exec('SELECT * FROM public.people'),/permission denied/);}finally{await f.pg.exec('RESET ROLE');}
 assert.equal((await job(f,item.copyId)).state,'queued');
});
check('native finish rejects forged exact-byte claims,extra fields and wrong leases before writing receipts',async f=>{
 const item=await queued(f);await worker(f).run(async t=>{
  assert.equal((await f.pg.query('SELECT public.finish_file_copy($1,$2,$3,$4::jsonb) ok',[f.a,item.copyId,randomUUID(),JSON.stringify(proof(t))])).rows[0].ok,false);
  for(const patch of [{sha256:'0'.repeat(64)},{bytes:t.expectedBytes+1},{downloadAuthorized:true},{destination:{storageTargetId:'0'.repeat(64),etag:'"synthetic"'}},{source:{storageTargetId:t.sourceTargetId,etag:null}}])await assert.rejects(f.pg.query('SELECT public.finish_file_copy($1,$2,$3,$4::jsonb)',[f.a,item.copyId,t.leaseToken,JSON.stringify({...proof(t),...patch})]),/INVALID_FILE_COPY_RESULT/);
  assert.equal((await f.pg.query('SELECT * FROM public.file_copy_attempts')).rows.length,0);return proof(t);
 });assert.equal((await job(f,item.copyId)).state,'verified');
});
check('copy result and outbox persist atomically;failed completion can be retried with the same valid fence',async f=>{
 const item=await queued(f);let task:CopyTask|undefined;await f.pg.exec(`CREATE FUNCTION public.test_copy_finish_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.event_type='file.copy.verified' THEN RAISE EXCEPTION 'SYNTHETIC_COPY_FINISH_FAILURE';END IF;RETURN NEW;END $$;CREATE TRIGGER test_copy_finish_failure BEFORE INSERT ON public.outbox_events FOR EACH ROW EXECUTE FUNCTION public.test_copy_finish_failure()`);
 try{await assert.rejects(worker(f).run(async t=>{task=t;return proof(t);}),/SYNTHETIC_COPY_FINISH_FAILURE/);}finally{await f.pg.exec('DROP TRIGGER test_copy_finish_failure ON public.outbox_events;DROP FUNCTION public.test_copy_finish_failure()');}
 assert.ok(task);assert.equal((await job(f,item.copyId)).state,'running');assert.equal((await f.pg.query('SELECT * FROM public.file_copy_attempts')).rows.length,0);
 assert.equal((await f.pg.query('SELECT public.finish_file_copy($1,$2,$3,$4::jsonb) ok',[f.a,item.copyId,task.leaseToken,JSON.stringify(proof(task))])).rows[0].ok,true);assert.equal((await job(f,item.copyId)).state,'verified');
});
test('operator copy adapter fails closed before IO for missing or mismatched configurations',async()=>{
 const t:CopyTask={academyId:randomUUID(),copyId:randomUUID(),fileId:randomUUID(),leaseToken:randomUUID(),attemptNo:1,sourceFingerprint:'a'.repeat(64),expectedBytes:1,expectedSha256:'b'.repeat(64),sourceTargetId:'c'.repeat(64),destinationTargetId:'d'.repeat(64)};
 assert.deepEqual(await copyStoredFile(t,()=>null,new AbortController().signal),{outcome:'unavailable'});assert.deepEqual(await copyStoredFile(t,()=>{throw Error('SECRET_MUST_NOT_LEAK');},new AbortController().signal),{outcome:'unavailable'});
});
test('restricted worker resolves current private employment ownership without returning pay or profile data',async()=>{
 const base=await workFixture({connections:()=>config});try{const engagement=await base.create();assert.equal(engagement.response.status,201);const f=await fixture(base),item=await f.file({domain:'work_private',workEngagementId:engagement.body.data.id});assert.equal((await f.copy(item)).response.status,202);assert.deepEqual(await worker(f).run(async t=>{assert.equal('personId' in t,false);assert.equal('hubId' in t,false);assert.equal('domain' in t,false);return proof(t);}),{claimed:true,recorded:true});assert.equal((await f.pg.query('SELECT sources_current FROM public.file_copy_attempts')).rows[0].sources_current,true);}finally{await base.pg.close();}
});
if(process.env.TEST_DATABASE_URL)check('two concurrent workers perform one physical-copy callback under one durable lease',async f=>{
 const item=await queued(f);let calls=0;const run=()=>worker(f).run(async t=>{calls++;await new Promise(resolve=>setTimeout(resolve,20));return proof(t);});const results=await Promise.all([run(),run()]);assert.equal(calls,1);assert.equal(results.filter(r=>r.claimed&&r.recorded).length,1);assert.equal((await job(f,item.copyId)).state,'verified');assert.equal((await f.pg.query('SELECT * FROM public.file_copy_attempts')).rows.length,1);
});
