import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { operationsFixture } from './operations-fixture.ts';
import { assertSignatureCompletionRole } from '../src/integrations/signature-completion-source.ts';

export async function checkCompletionRetries(f:Pick<Awaited<ReturnType<typeof operationsFixture>>,'request'|'approve'|'a'|'pg'|'managerRole'|'metrics'>,requestId:string,purpose:'worker_services'|'unified_enrollment'){
 const path=(purpose==='worker_services'?'payroll/work-signature-send-requests/':'signature-send-requests/')+requestId+'/completion-check/retries',work=purpose==='worker_services',capability=work?'work-signature-completions.retry':'signature-completions.retry',event=work?'work.signature.completion.retry':'signature.completion.retry';
 assert.equal((await f.request(path)).body.data.length,0);
 const input={expectedVersion:0,checkWindowDays:2,reason:'Explicit operational recheck, not another envelope or legal waiver'};
 for(const patch of [{checkWindowDays:31},{expectedVersion:-1},{documentId:randomUUID()},{admissionCleared:true}])assert.equal((await f.request(path,{...input,...patch})).response.status,400);
 const keys=[randomUUID(),randomUUID()],race=f.pg.runtime?await Promise.all(keys.map(key=>f.request(path,input,'master',{key}))):[await f.request(path,input,'master',{key:keys[0]}),await f.request(path,input,'master',{key:keys[1]})];
 assert.deepEqual(race.map(r=>r.response.status).sort(),[200,409],JSON.stringify({bodies:race.map(r=>r.body),errors:f.metrics.queryFailures.slice(-2)}));
 const winner=race.findIndex(r=>r.response.status===200),key=keys[winner],own=race[winner];assert.equal(own.body.data.version,1);assert.equal(own.body.approval.selfApproved,true);assert.equal(own.body.data.agreementResent,false);assert.equal(own.body.data.admissionCleared,false);assert.equal(own.body.data.paymentCleared,false);
 const oldIncident=await f.request(path.replace(/retries$/,'incidents'));assert.equal(oldIncident.body.data.length,1);assert.equal(oldIncident.body.data[0].attentionStillCurrent,false,'approved retry preserves the old observation without claiming it is still blocked');
 assert.deepEqual((await f.request(path,input,'master',{key})).body,own.body);
 assert.equal((await f.request(path,input)).response.status,409,'another request with an old version cannot reset retry history');
 const added:string[]=[];for(const cap of [capability,work?'work-signature-completions.view':'signature-completions.view'])if((await f.pg.query('INSERT INTO public.role_permissions VALUES($1,$2,$3,\'allow\') ON CONFLICT DO NOTHING RETURNING capability',[f.a,f.managerRole,cap])).rows.length)added.push(cap);
 const proposed=await f.request(path,{...input,expectedVersion:1},'manager');assert.equal(proposed.response.status,202,JSON.stringify({body:proposed.body,errors:f.metrics.queryFailures.slice(-2)}));
 assert.equal((await f.request(path)).body.data.length,1,'a proposal alone does not reset the job');
 assert.equal((await f.approve(proposed.body.approval.id,'manager')).response.status,403);
 const approved=await f.approve(proposed.body.approval.id);assert.equal(approved.response.status,200,JSON.stringify({body:approved.body,errors:f.metrics.queryFailures.slice(-2)}));
 const history=await f.request(path+'?limit=1');assert.equal(history.body.data[0].version,1);assert.equal(history.body.nextVersion,1);const next=await f.request(path+'?limit=1&afterVersion=1');assert.equal(next.body.data[0].version,2);assert.equal(next.body.nextVersion,null);
 await f.pg.exec(`CREATE FUNCTION public.suppress_retry_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='${event}' THEN RETURN NULL;END IF;RETURN NEW;END $$;CREATE TRIGGER zz_suppress_retry_audit BEFORE INSERT ON public.audit_events FOR EACH ROW EXECUTE FUNCTION public.suppress_retry_audit()`);
 try{assert.equal((await f.request(path,{...input,expectedVersion:2})).response.status,503);assert.equal((await f.request(path)).body.data.length,2,'missing audit rolls back both the job reset and its retry row');}
 finally{await f.pg.exec('DROP TRIGGER zz_suppress_retry_audit ON public.audit_events');}
 const stale=await f.request(path,{...input,expectedVersion:2},'manager');assert.equal(stale.response.status,202);
 await f.pg.query("UPDATE public.signature_completion_jobs SET available_at=available_at+interval '1 second' WHERE academy_id=$1 AND purpose=$2 AND start_id=(SELECT target_id FROM public.approval_requests WHERE id=$3)",[f.a,purpose,stale.body.approval.id]);
 assert.equal((await f.approve(stale.body.approval.id)).response.status,409,'background/source changes invalidate an already pending recheck approval');
 assert.equal((await f.request(path)).body.data.length,2);
 for(const cap of added)await f.pg.query('DELETE FROM public.role_permissions WHERE academy_id=$1 AND role_id=$2 AND capability=$3',[f.a,f.managerRole,cap]);
 for(const sql of ['UPDATE public.signature_completion_retries SET changed_by=changed_by','DELETE FROM public.signature_completion_retries'])await assert.rejects(f.pg.exec(sql),/SIGNATURE_COMPLETION_RETRY_IMMUTABLE/);
}

export async function checkCompletionStatus(f:Pick<Awaited<ReturnType<typeof operationsFixture>>,'request'|'a'|'b'|'pg'|'managerRole'>,requestId:string,purpose:'worker_services'|'unified_enrollment'){
 const path=(purpose==='worker_services'?'payroll/work-signature-send-requests/':'signature-send-requests/')+requestId+'/completion-check';
 const first=await f.request(path+'?limit=1');assert.equal(first.response.status,200,JSON.stringify(first.body));
 assert.equal(first.body.data.state,'blocked');assert.equal(first.body.data.attemptCount,2);assert.equal(first.body.attempts.length,1);assert.equal(first.body.attempts[0].attemptNo,1);assert.equal(first.body.nextAfterAttempt,1);
 const second=await f.request(path+'?limit=1&afterAttempt=1');assert.equal(second.response.status,200);assert.equal(second.body.attempts[0].attemptNo,2);assert.equal(second.body.nextAfterAttempt,null);
 assert.equal(first.body.workerLiveness,'not_observed');assert.equal(first.body.admissionCleared,false);assert.equal(first.body.paymentCleared,false);
 assert.doesNotMatch(JSON.stringify(first.body),/lease_token|worker_id|source_fingerprint|connection_id|document_id|PRIVATE|synthetic-private/);
 assert.equal((await f.request(path+'?afterAttempt=99')).response.status,404);
 assert.equal((await f.request(path,undefined,'foreignMaster',{academy:f.b})).response.status,404);
 const incidents=await f.request(path+'/incidents');assert.equal(incidents.response.status,200,JSON.stringify(incidents.body));assert.equal(incidents.body.data.length,1);assert.equal(incidents.body.data[0].reasonCode,'poll_window_elapsed');assert.equal(incidents.body.data[0].attentionStillCurrent,true);assert.equal(incidents.body.caseResolvedByReading,false);
 assert.equal((await f.request(path+'/incidents?after='+randomUUID())).response.status,404);
 assert.equal((await f.request(path+'/incidents',undefined,'foreignMaster',{academy:f.b})).response.status,404);
 const capability=purpose==='worker_services'?'work-signature-completions.view':'signature-completions.view';
 const saved=(await f.pg.query<{effect:string}>('DELETE FROM public.role_permissions WHERE academy_id=$1 AND role_id=$2 AND capability=$3 RETURNING effect',[f.a,f.managerRole,capability])).rows;
 try{for(const target of [path,path+'/incidents'])assert.equal((await f.request(target,undefined,'manager')).response.status,purpose==='worker_services'?403:404,'removing the current feature permission immediately removes status/history access');}
 finally{for(const grant of saved)await f.pg.query('INSERT INTO public.role_permissions VALUES($1,$2,$3,$4)',[f.a,f.managerRole,capability,grant.effect]);}
}

// Called only after the original-flow fixture has produced a real native,
// original-bound service receipt. Network responses in that fixture are fake.
export async function checkCompletionQueue(pg:Pick<Awaited<ReturnType<typeof operationsFixture>>['pg'],'query'|'exec'|'runtime'>,academy:string,foreign:string,start:string,fingerprint:string,purpose:'worker_services'|'unified_enrollment'='worker_services'){
 const worker=randomUUID(),blockedEvent=purpose==='worker_services'?'work.signature.completion.check.blocked.critical':'signature.completion.check.blocked.critical';
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
  await pg.exec(`CREATE FUNCTION public.suppress_completion_queue_alert() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.event_type='${blockedEvent}' THEN RETURN NULL;END IF;RETURN NEW;END $$;CREATE TRIGGER zz_suppress_completion_queue_alert BEFORE INSERT ON public.outbox_events FOR EACH ROW EXECUTE FUNCTION public.suppress_completion_queue_alert()`);
  await pg.exec('SAVEPOINT suppressed_alert');
  await pg.exec('SET LOCAL ROLE kavosh_signature_completion_worker');
  await assert.rejects(pg.query('SELECT * FROM public.claim_signature_completion_job($1,$2,60)',[[academy],worker]),/SIGNATURE_COMPLETION_JOB_ALERT_REQUIRED/);
  // Restore both transaction health and the role before observing rollback.
  await pg.exec('ROLLBACK TO SAVEPOINT suppressed_alert');
  assert.equal((await pg.query('SELECT state FROM public.signature_completion_jobs WHERE start_id=$1',[start])).rows[0].state,'queued');
  await pg.exec('DROP TRIGGER zz_suppress_completion_queue_alert ON public.outbox_events');
  await pg.exec('CREATE FUNCTION public.suppress_completion_incident() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL;END $$;CREATE TRIGGER zz_suppress_completion_incident BEFORE INSERT ON public.signature_completion_incidents FOR EACH ROW EXECUTE FUNCTION public.suppress_completion_incident()');
  await pg.exec('SAVEPOINT suppressed_incident');await pg.exec('SET LOCAL ROLE kavosh_signature_completion_worker');
  await assert.rejects(pg.query('SELECT * FROM public.claim_signature_completion_job($1,$2,60)',[[academy],worker]),/SIGNATURE_COMPLETION_INCIDENT_PERSISTENCE_REQUIRED/);
  await pg.exec('ROLLBACK TO SAVEPOINT suppressed_incident');
  assert.equal((await pg.query('SELECT state FROM public.signature_completion_jobs WHERE start_id=$1',[start])).rows[0].state,'queued');
  assert.equal((await pg.query('SELECT * FROM public.signature_completion_incidents WHERE start_id=$1',[start])).rows.length,0);
 }finally{await pg.exec('ROLLBACK');}
 await pg.exec('BEGIN');try{
  await pg.query("UPDATE public.signature_completion_jobs SET available_at=clock_timestamp()-interval '1 second',poll_until=clock_timestamp()-interval '1 second' WHERE start_id=$1",[start]);
  await isolated(async()=>{assert.equal((await pg.query('SELECT * FROM public.claim_signature_completion_job($1,$2,60)',[[academy],worker])).rows.length,0);});
  assert.equal((await pg.query('SELECT state,last_outcome FROM public.signature_completion_jobs WHERE start_id=$1',[start])).rows[0].state,'blocked');
  assert.equal((await pg.query('SELECT count(*)::integer n FROM public.outbox_events WHERE event_type=$1 AND entity_id=$2',[blockedEvent,start])).rows[0].n,1);
  assert.equal((await pg.query('SELECT count(*)::integer n FROM public.signature_completion_incidents WHERE purpose=$1 AND start_id=$2',[purpose,start])).rows[0].n,1);
 }finally{await pg.exec('ROLLBACK');}
 // Preserve one actual native block for the same workspace's scoped readers.
 await pg.query("UPDATE public.signature_completion_jobs SET available_at=clock_timestamp()-interval '1 second',poll_until=clock_timestamp()-interval '1 second' WHERE start_id=$1",[start]);
 assert.equal((await claim()).length,0);
 const stored=(await pg.query('SELECT reason_code,attempt_no,retry_version FROM public.signature_completion_incidents WHERE purpose=$1 AND start_id=$2',[purpose,start])).rows;
 assert.deepEqual(stored,[{reason_code:'poll_window_elapsed',attempt_no:2,retry_version:0}]);
 await isolated(async()=>{await assert.rejects(pg.query('SELECT * FROM public.signature_completion_incidents'),/permission denied/i);});
 await pg.exec('SET ROLE kavosh_runtime');try{
  await pg.query("SELECT set_config('app.academy_id',$1,false)",[academy]);
  await assert.rejects(pg.query('INSERT INTO public.outbox_events(academy_id,id,event_type,entity_id,request_id) VALUES($1,$2,$3,$4,$4)',[academy,randomUUID(),blockedEvent,start]),/SIGNATURE_COMPLETION_INCIDENT_ORIGIN_REQUIRED/);
 }finally{await pg.exec('RESET ROLE');}
}
