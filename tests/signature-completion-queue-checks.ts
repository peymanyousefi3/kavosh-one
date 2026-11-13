import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { operationsFixture } from './operations-fixture.ts';
import { assertSignatureCompletionRole } from '../src/integrations/signature-completion-source.ts';

// Called only after the original-flow fixture has produced a real native,
// original-bound service receipt. Network responses in that fixture are fake.
export async function checkCompletionQueue(pg:Pick<Awaited<ReturnType<typeof operationsFixture>>['pg'],'query'|'exec'>,academy:string,foreign:string,start:string,fingerprint:string){
 const worker=randomUUID();
 async function isolated<T>(run:()=>Promise<T>){await pg.exec('SET ROLE kavosh_signature_completion_worker');try{return await run();}finally{await pg.exec('RESET ROLE');}}
 const claim=(academies=[academy])=>isolated(async()=> (await pg.query<{lease_token:string;start_id:string;source_fingerprint:string;attempt_no:number}>('SELECT * FROM public.claim_signature_completion_job($1,$2,60)',[academies,worker])).rows);
 const finish=(lease:string,outcome='not_completed',evidence:string|null=null)=>isolated(async()=> (await pg.query<{done:boolean}>('SELECT public.finish_signature_completion_job($1,$2,$3,$4,$5,$6,60) done',[academy,'worker_services',start,lease,outcome,evidence])).rows[0].done);
 assert.deepEqual((await pg.query('SELECT state,attempt_no FROM public.signature_completion_jobs WHERE start_id=$1',[start])).rows,[{state:'queued',attempt_no:0}]);
 await isolated(async()=>{
  await assertSignatureCompletionRole({query:pg.query.bind(pg),release(){}});
  for(const table of ['signature_completion_jobs','signature_completion_job_attempts','signature_completion_request_budgets'])await assert.rejects(pg.query('SELECT * FROM public.'+table),/permission denied/i);
  await assert.rejects(pg.query('SELECT public.seed_signature_completion_job($1,$2,$3)',[academy,'worker_services',start]),/permission denied/i);
  await assert.rejects(pg.query('SELECT * FROM public.claim_signature_completion_job($1,$2,59)',[[academy],worker]),/INVALID_SIGNATURE_COMPLETION_JOB_CLAIM/);
 });
 assert.equal((await claim([foreign])).length,0);
 const first=(await claim())[0];assert.ok(first);assert.equal(first.start_id,start);assert.equal(first.source_fingerprint,fingerprint);assert.equal(first.attempt_no,1);
 assert.equal((await claim()).length,0,'a live lease cannot be claimed twice');
 assert.equal(await finish(randomUUID()),false);
 await assert.rejects(finish(first.lease_token,'recorded',randomUUID()),/SIGNATURE_COMPLETION_JOB_EVIDENCE_REQUIRED/);
 assert.equal(await finish(first.lease_token),true);assert.equal(await finish(first.lease_token),false,'a finished lease cannot write twice');
 assert.equal((await claim()).length,0,'pending result observes its retry delay');
 await pg.query("UPDATE public.signature_completion_jobs SET available_at=clock_timestamp()-interval '1 second' WHERE start_id=$1",[start]);
 await pg.query('UPDATE public.signature_completion_request_budgets SET reserved_calls=1600 WHERE group_id=$1',[academy]);
 assert.equal((await claim()).length,0,'account budget defers IO without consuming an attempt');
 assert.equal((await pg.query('SELECT attempt_no FROM public.signature_completion_jobs WHERE start_id=$1',[start])).rows[0].attempt_no,1);
 assert.equal((await pg.query('SELECT count(*)::integer n FROM public.signature_completion_job_attempts WHERE start_id=$1',[start])).rows[0].n,1);
 await pg.query('UPDATE public.signature_completion_request_budgets SET reserved_calls=0 WHERE group_id=$1',[academy]);
 await pg.query("UPDATE public.signature_completion_jobs SET available_at=clock_timestamp()-interval '1 second' WHERE start_id=$1",[start]);
 const second=(await claim())[0];assert.equal(second.attempt_no,2);assert.notEqual(second.lease_token,first.lease_token);assert.equal(await finish(first.lease_token),false);assert.equal(await finish(second.lease_token),true);
}
