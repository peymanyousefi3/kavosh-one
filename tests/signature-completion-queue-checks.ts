import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { operationsFixture } from './operations-fixture.ts';
import { assertSignatureCompletionRole } from '../src/integrations/signature-completion-source.ts';

// Called only after the original-flow fixture has produced a real native,
// original-bound service receipt. Network responses in that fixture are fake.
export async function checkCompletionQueue(pg:Pick<Awaited<ReturnType<typeof operationsFixture>>['pg'],'query'|'exec'|'runtime'>,academy:string,foreign:string,start:string,fingerprint:string,purpose:'worker_services'|'unified_enrollment'='worker_services'){
 const worker=randomUUID();
 async function isolated<T>(run:()=>Promise<T>){await pg.exec('SET ROLE kavosh_signature_completion_worker');try{return await run();}finally{await pg.exec('RESET ROLE');}}
 const claim=async(academies=[academy])=>{
  const run=async(c:Pick<typeof pg,'query'>)=>(await c.query<{lease_token:string;start_id:string;source_fingerprint:string;attempt_no:number}>('SELECT * FROM public.claim_signature_completion_job($1,$2,60)',[academies,worker])).rows;
  if(!pg.runtime)return isolated(()=>run(pg));
  const c=await pg.runtime.connect();try{await c.query('SET ROLE kavosh_signature_completion_worker');return await run(c);}finally{c.release();}
 };
 const finish=(lease:string,outcome='not_completed',evidence:string|null=null)=>isolated(async()=> (await pg.query<{done:boolean}>('SELECT public.finish_signature_completion_job($1,$2,$3,$4,$5,$6,60) done',[academy,purpose,start,lease,outcome,evidence])).rows[0].done);
 assert.deepEqual((await pg.query('SELECT state,attempt_no FROM public.signature_completion_jobs WHERE start_id=$1',[start])).rows,[{state:'queued',attempt_no:0}]);
 await isolated(async()=>{
  await assertSignatureCompletionRole({query:pg.query.bind(pg),release(){}});
  for(const table of ['signature_completion_jobs','signature_completion_job_attempts','signature_completion_request_budgets'])await assert.rejects(pg.query('SELECT * FROM public.'+table),/permission denied/i);
  await assert.rejects(pg.query('SELECT public.seed_signature_completion_job($1,$2,$3)',[academy,purpose,start]),/permission denied/i);
  await assert.rejects(pg.query('SELECT * FROM public.claim_signature_completion_job($1,$2,59)',[[academy],worker]),/INVALID_SIGNATURE_COMPLETION_JOB_CLAIM/);
 });
 assert.equal((await claim([foreign])).length,0);
 const competing=pg.runtime?await Promise.all([claim(),claim()]):[await claim(),await claim()];
 assert.deepEqual(competing.map(r=>r.length).sort(),[0,1],'competing native connections must produce exactly one claim');
 const first=competing.flat()[0];assert.ok(first);assert.equal(first.start_id,start);assert.equal(first.source_fingerprint,fingerprint);assert.equal(first.attempt_no,1);
 assert.equal((await claim()).length,0,'a live lease cannot be claimed twice');
 assert.equal(await finish(randomUUID()),false);
 await assert.rejects(finish(first.lease_token,'recorded',randomUUID()),/SIGNATURE_COMPLETION_JOB_EVIDENCE_REQUIRED/);
 assert.equal(await finish(first.lease_token),true);assert.equal(await finish(first.lease_token),false,'a finished lease cannot write twice');
 assert.equal((await claim()).length,0,'pending result observes its retry delay');
 await pg.query("UPDATE public.signature_completion_jobs SET available_at=clock_timestamp()-interval '1 second' WHERE start_id=$1",[start]);
 const limit=(await pg.query<{limit:number}>("SELECT CASE WHEN c.environment='Test' THEN 40 ELSE 1600 END AS limit FROM public.signature_completion_jobs j JOIN public.signature_connections c ON c.academy_id=j.academy_id AND c.id=j.connection_id WHERE j.start_id=$1",[start])).rows[0].limit;
 await pg.query('UPDATE public.signature_completion_request_budgets SET reserved_calls=$2 WHERE group_id=$1',[academy,limit]);
 assert.equal((await claim()).length,0,'account budget defers IO without consuming an attempt');
 assert.equal((await pg.query('SELECT attempt_no FROM public.signature_completion_jobs WHERE start_id=$1',[start])).rows[0].attempt_no,1);
 assert.equal((await pg.query('SELECT count(*)::integer n FROM public.signature_completion_job_attempts WHERE start_id=$1',[start])).rows[0].n,1);
 await pg.query('UPDATE public.signature_completion_request_budgets SET reserved_calls=0 WHERE group_id=$1',[academy]);
 await pg.query("UPDATE public.signature_completion_jobs SET available_at=clock_timestamp()-interval '1 second' WHERE start_id=$1",[start]);
 const second=(await claim())[0];assert.equal(second.attempt_no,2);assert.notEqual(second.lease_token,first.lease_token);assert.equal(await finish(first.lease_token),false);assert.equal(await finish(second.lease_token),true);
 // Rolled-back fault injection changes only this disposable test database.
 // Same connection here is intentional: the forced expiry is uncommitted.
 await pg.exec('BEGIN');try{
  await pg.query("UPDATE public.signature_completion_jobs SET available_at=clock_timestamp()-interval '1 second',poll_until=clock_timestamp()-interval '1 second' WHERE start_id=$1",[start]);
  await pg.exec("CREATE FUNCTION public.suppress_completion_queue_alert() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.event_type='signature.completion.check.blocked.critical' THEN RETURN NULL;END IF;RETURN NEW;END $$;CREATE TRIGGER zz_suppress_completion_queue_alert BEFORE INSERT ON public.outbox_events FOR EACH ROW EXECUTE FUNCTION public.suppress_completion_queue_alert()");
  await pg.exec('SAVEPOINT suppressed_alert');
  await pg.exec('SET LOCAL ROLE kavosh_signature_completion_worker');
  await assert.rejects(pg.query('SELECT * FROM public.claim_signature_completion_job($1,$2,60)',[[academy],worker]),/SIGNATURE_COMPLETION_JOB_ALERT_REQUIRED/);
  // Restore both transaction health and the role before observing rollback.
  await pg.exec('ROLLBACK TO SAVEPOINT suppressed_alert');
  assert.equal((await pg.query('SELECT state FROM public.signature_completion_jobs WHERE start_id=$1',[start])).rows[0].state,'queued');
 }finally{await pg.exec('ROLLBACK');}
 await pg.exec('BEGIN');try{
  await pg.query("UPDATE public.signature_completion_jobs SET available_at=clock_timestamp()-interval '1 second',poll_until=clock_timestamp()-interval '1 second' WHERE start_id=$1",[start]);
  await isolated(async()=>{assert.equal((await pg.query('SELECT * FROM public.claim_signature_completion_job($1,$2,60)',[[academy],worker])).rows.length,0);});
  assert.equal((await pg.query('SELECT state,last_outcome FROM public.signature_completion_jobs WHERE start_id=$1',[start])).rows[0].state,'blocked');
  assert.equal((await pg.query("SELECT count(*)::integer n FROM public.outbox_events WHERE event_type='signature.completion.check.blocked.critical' AND entity_id=$1",[start])).rows[0].n,1);
 }finally{await pg.exec('ROLLBACK');}
}
