import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { processOneSubscription } from '../src/automations/subscription-worker.ts';
import { processOneNotification } from '../src/automations/notification-worker.ts';
import { processOneMessage,type MessageTransport } from '../src/automations/message-worker.ts';
import type { Database } from '../src/core/database.ts';

export async function completionWatcherCheck(f:Pick<Awaited<ReturnType<typeof operationsFixture>>,'request'|'pg'|'a'|'hub'|'actors'|'managerRole'>){
 // The original signing test deliberately expired its starter's login. Use a
 // separate synthetic verified login,never resurrect the expired credential.
 const session=randomUUID();await f.pg.query(`INSERT INTO identity.session(id,token,"userId","expiresAt","updatedAt","mfaVerified") VALUES($1,$2,$3,clock_timestamp()+interval '1 day',clock_timestamp(),true)`,[session,'synthetic-watch-login-'+randomUUID(),f.actors.master.user]);
 const request:typeof f.request=async(...args)=>{const prior=f.actors.master.session;f.actors.master.session=session;try{return await f.request(...args);}finally{f.actors.master.session=prior;}};
 const definition={name:'Disposable broad watcher',enabled:true,trigger:{kind:'domain_event',eventTypes:['*']},condition:{op:'exists',field:'entityId'},actions:[{kind:'notify',channels:['portal'],audience:{kind:'school_master'},title:{en:'Review event'},body:{en:'Review linked case'}}],execution:{mode:'automatic',maxRecipientsPerEvent:10,maxDailyDeliveries:100,maxDailySms:0,cooldownSeconds:0,maxChainDepth:1}};
 const create=async(code:string,d:unknown=definition)=>{const r=await request('automations/rules',{hubId:f.hub,code,definition:d,reason:'Synthetic queue regression'});assert.equal(r.response.status,201,JSON.stringify(r.body));return r.body.data;};
 const rule=await create('SIGNING_QUEUE_WATCH'),watch=await request('automations/rules/'+rule.id+'/subscriptions',{expectedVersion:1,reason:'Synthetic broad watcher'});assert.equal(watch.response.status,201,JSON.stringify(watch.body));
 const database:Database={async connect(){const c=f.pg.runtime?await f.pg.runtime.connect():{query:f.pg.query.bind(f.pg),release(){}};await c.query('SET ROLE kavosh_automation_worker');return c;}};
 const step=async()=>{try{return await processOneSubscription(database,[f.a]);}finally{if(!f.pg.runtime)await f.pg.exec('RESET ROLE');}};
 return async()=>{
  const incident=(await f.pg.query<{id:string}>('SELECT id FROM public.signature_completion_incidents WHERE academy_id=$1',[f.a])).rows[0];assert.ok(incident);
  if(f.pg.runtime){
   const reader=await f.pg.runtime.connect();try{
    await reader.query('BEGIN');await reader.query('SET LOCAL ROLE kavosh_runtime');await reader.query("SELECT set_config('app.academy_id',$1,true)",[f.a]);assert.equal((await reader.query<{ok:boolean}>('SELECT public.lock_signature_check_source($1) ok',[incident.id])).rows[0].ok,true);
    await f.pg.exec('BEGIN');try{await f.pg.exec("SET LOCAL lock_timeout='150ms'");await assert.rejects(f.pg.query('UPDATE public.signature_completion_jobs SET available_at=available_at WHERE academy_id=$1',[f.a]),(error:unknown)=>(error as {code?:string}).code==='55P03','a separate native writer must wait behind the exact source lock');}finally{await f.pg.exec('ROLLBACK');}
   }finally{await reader.query('ROLLBACK');reader.release();}
  }
  assert.equal((await step()).outcome,'queued','current signing case must enter the existing reviewed queue');
  assert.equal((await f.pg.query('SELECT outcome FROM public.automation_subscription_events WHERE subscription_id=$1 AND event_id=$2',[watch.body.data.id,incident.id])).rows[0]?.outcome,'queued');
  assert.equal((await f.pg.query('SELECT status,failure_count FROM public.automation_subscriptions WHERE id=$1',[watch.body.data.id])).rows[0]?.failure_count,0);
  try{assert.equal((await processOneNotification(database,[f.a])).outcome,'succeeded');}finally{if(!f.pg.runtime)await f.pg.exec('RESET ROLE');}
  assert.equal((await f.pg.query('SELECT id FROM public.portal_notifications WHERE rule_id=$1 AND event_id=$2',[rule.id,incident.id])).rows.length,1);
  await create('SIGNING_QUEUE_NEXT');assert.equal((await step()).outcome,'queued','the same watcher must continue with an ordinary later event');
  assert.equal((await f.pg.query('SELECT id FROM public.notification_jobs WHERE rule_id=$1',[rule.id])).rows.length,2);
  try{assert.equal((await processOneNotification(database,[f.a])).outcome,'succeeded','consume this synthetic portal-only job before later queue assertions');}finally{if(!f.pg.runtime)await f.pg.exec('RESET ROLE');}
  const stopped=await request('automations/subscriptions/'+watch.body.data.id+'/stop',{});assert.equal(stopped.response.status,200,JSON.stringify(stopped.body));
  const preferences=await request('me/notification-preferences'),opted=await request('me/notification-preferences',{expectedVersion:preferences.body.data.version,emailEnabled:true,smsEnabled:true,locale:'en',acknowledgedNoticeVersion:1});assert.ok([200,201].includes(opted.response.status),JSON.stringify(opted.body));
  const policy=await request('automations/delivery-policy'),enabled=await request('automations/delivery-policy',{expectedVersion:policy.body.data.version,definition:{...policy.body.data.definition,enabled:true,maxDailyEmailRequests:1000,maxDailySmsRequests:1000,maxHourlyRequestsPerRecipient:100},reason:'Synthetic isolated outbound acceptance'});assert.equal(enabled.response.status,200,JSON.stringify(enabled.body));
  const outbound={...definition,trigger:{kind:'domain_event',eventTypes:['work.signature.completion.check.blocked.critical']},actions:[{...definition.actions[0],channels:['email','sms']}],execution:{...definition.execution,maxDailySms:100}};
  const queueOutbound=async(code:string,d:unknown=outbound)=>{const r=await create(code,d),result=await request('automations/rules/'+r.id+'/dispatch',{eventId:incident.id,expectedVersion:1});assert.equal(result.response.status,201,JSON.stringify(result.body));assert.equal(result.body.data.summary.outboundQueued,2,JSON.stringify(result.body));return r;};
  let calls=0;const receipt={providerMessageId:'synthetic-receipt',providerStatus:'accepted',providerAccepted:true as const,deliveryConfirmed:false as const};
  const transport:MessageTransport={channels:['email','sms'],async email(){calls++;return {...receipt,provider:'smtp'};},async sms(){calls++;return {...receipt,provider:'twilio'};}};
  const sender:Database={async connect(){const c=f.pg.runtime?await f.pg.runtime.connect():{query:f.pg.query.bind(f.pg),release(){}};await c.query('SET ROLE kavosh_message_worker');return c;}};
  const send=async()=>{try{return await processOneMessage(sender,[f.a],()=>transport);}finally{if(!f.pg.runtime)await f.pg.exec('RESET ROLE');}};
  await queueOutbound('SIGNING_EXTERNAL_CURRENT');for(let n=0;n<2;n++)assert.equal((await send()).outcome,'accepted');assert.equal(calls,2);
  const added=(await f.pg.query("INSERT INTO public.role_permissions VALUES($1,$2,'work-signature-completions.view','allow') ON CONFLICT DO NOTHING RETURNING capability",[f.a,f.managerRole])).rows;
  const managerPrefs=await request('me/notification-preferences',undefined,'manager'),managerOpt=await request('me/notification-preferences',{expectedVersion:managerPrefs.body.data.version,emailEnabled:true,smsEnabled:true,locale:'en',acknowledgedNoticeVersion:1},'manager');assert.ok([200,201].includes(managerOpt.response.status),JSON.stringify(managerOpt.body));
  await queueOutbound('SIGNING_EXTERNAL_REVOKED',{...outbound,actions:[{...outbound.actions[0],audience:{kind:'people',personIds:[f.actors.manager.person]}}]});
  const removed=(await f.pg.query<{effect:string}>("DELETE FROM public.role_permissions WHERE academy_id=$1 AND role_id=$2 AND capability='work-signature-completions.view' RETURNING effect",[f.a,f.managerRole])).rows;
  try{for(let n=0;n<2;n++)assert.equal((await send()).outcome,'cancelled','removing recipient completion-view rights must stop both queued channels');assert.equal(calls,2);}finally{if(!added.length)for(const row of removed)await f.pg.query("INSERT INTO public.role_permissions VALUES($1,$2,'work-signature-completions.view',$3)",[f.a,f.managerRole,row.effect]);}
  const stale=await queueOutbound('SIGNING_EXTERNAL_STALE');
  return async()=>{
   const rejected=await request('automations/rules/'+stale.id+'/dispatch',{eventId:incident.id,expectedVersion:1});assert.equal(rejected.response.status,409,'an old dispatch receipt must not bypass the changed source');
   for(let n=0;n<2;n++)assert.equal((await send()).outcome,'cancelled','queued email/SMS must stop after an approved case recheck');assert.equal(calls,2,'stale cases make no further simulated provider calls');
   assert.deepEqual((await f.pg.query('SELECT DISTINCT last_error FROM public.notification_deliveries WHERE rule_id=$1',[stale.id])).rows,[{last_error:'SOURCE_OR_AUTHORITY_CHANGED'}]);
  };
 };
}
import type { operationsFixture } from './operations-fixture.ts';
import { assertSignatureCompletionRole } from '../src/integrations/signature-completion-source.ts';

export async function expireCompletionBeforeEvidence(pg:Pick<Awaited<ReturnType<typeof operationsFixture>>['pg'],'query'|'exec'>,academy:string,start:string,purpose:'worker_services'|'unified_enrollment'){
 // A real poll-window transition, not an invented incident. Only the test
 // owner's clock metadata is changed; the actual worker creates the case.
 await pg.query("UPDATE public.signature_completion_jobs SET available_at=clock_timestamp()-interval '1 second',poll_until=clock_timestamp()-interval '1 second' WHERE academy_id=$1 AND purpose=$2 AND start_id=$3",[academy,purpose,start]);
 await pg.exec('SET ROLE kavosh_signature_completion_worker');try{assert.deepEqual((await pg.query('SELECT * FROM public.claim_signature_completion_job($1,$2,60)',[[academy],randomUUID()])).rows,[]);}finally{await pg.exec('RESET ROLE');}
 const before=(await pg.query('SELECT * FROM public.signature_completion_jobs WHERE academy_id=$1 AND purpose=$2 AND start_id=$3',[academy,purpose,start])).rows;assert.equal(before[0].state,'blocked');
 await pg.query('SELECT public.settle_signature_completion_evidence($1,$2,$3)',[academy,purpose,start]);
 assert.deepEqual((await pg.query('SELECT * FROM public.signature_completion_jobs WHERE academy_id=$1 AND purpose=$2 AND start_id=$3',[academy,purpose,start])).rows,before,'missing evidence never resolves a blocked case');
}

export async function checkAlreadyRecordedCompletion(pg:Pick<Awaited<ReturnType<typeof operationsFixture>>['pg'],'query'|'exec'|'runtime'>,academy:string,start:string,purpose:'worker_services'|'unified_enrollment'){
 const table=purpose==='worker_services'?'work_signature_completion_evidence':'signature_completion_evidence';
 const original=(await pg.query<{evidence_id:string}>(`SELECT e.id evidence_id FROM public.${table} e JOIN public.signature_completion_jobs j ON j.academy_id=e.academy_id AND j.start_id=e.start_id AND j.source_fingerprint=e.source_fingerprint WHERE j.academy_id=$1 AND j.start_id=$2 AND j.purpose=$3 ORDER BY e.recorded_at DESC,e.id DESC LIMIT 1`,[academy,start,purpose])).rows[0];assert.ok(original,'fixture must contain actual original-bound persisted evidence,not a fake UUID');
 assert.deepEqual((await pg.query(`SELECT j.state,j.last_outcome,EXISTS(SELECT 1 FROM public.${table} e WHERE e.academy_id=j.academy_id AND e.start_id=j.start_id AND e.source_fingerprint=j.source_fingerprint AND e.id=j.evidence_id) retained FROM public.signature_completion_jobs j WHERE j.academy_id=$1 AND j.purpose=$2 AND j.start_id=$3`,[academy,purpose,start])).rows,[{state:'complete',last_outcome:'recorded',retained:true}],'inserting real evidence settles the queued check immediately;later observations do not replace its valid original evidence');
 // Owner-only reconstruction of pre-396 control metadata. Actual original
 // evidence, immutable attempts and failure incidents are never fabricated.
 for(const state of ['queued','blocked']){
  await pg.exec('BEGIN');try{
   await pg.query('UPDATE public.signature_completion_jobs SET state=$4,evidence_id=NULL WHERE academy_id=$1 AND purpose=$2 AND start_id=$3',[academy,purpose,start,state]);
   for(const role of ['kavosh_runtime','kavosh_signature_completion_worker']){
    await pg.exec('SAVEPOINT private_settlement');await pg.exec('SET LOCAL ROLE '+role);
    await assert.rejects(pg.query('SELECT public.settle_signature_completion_evidence($1,$2,$3)',[academy,purpose,start]),/permission denied/i);
    await pg.exec('ROLLBACK TO SAVEPOINT private_settlement');
   }
   if(state==='blocked'){
    await pg.exec('DROP TRIGGER zz_signature_completion_settlement ON public.signature_completion_evidence;DROP TRIGGER zz_work_signature_completion_settlement ON public.work_signature_completion_evidence;DROP FUNCTION public.settle_signature_completion_on_evidence();DROP FUNCTION public.settle_signature_completion_evidence(uuid,text,uuid);CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 395 $$');
    const incidents=(await pg.query('SELECT * FROM public.signature_completion_incidents ORDER BY academy_id,id')).rows;
    await pg.exec(await readFile(new URL('../db/migrations/396_signature_completion_evidence_settlement.sql',import.meta.url),'utf8'));
    assert.equal((await pg.query('SELECT public.schema_revision() revision')).rows[0].revision,396);
    assert.deepEqual((await pg.query('SELECT * FROM public.signature_completion_incidents ORDER BY academy_id,id')).rows,incidents,'the actual populated upgrade preserves original incidents without backfilling');
   }else await pg.query('SELECT public.settle_signature_completion_evidence($1,$2,$3)',[academy,purpose,start]);
   assert.equal((await pg.query('SELECT state FROM public.signature_completion_jobs WHERE academy_id=$1 AND purpose=$2 AND start_id=$3',[academy,purpose,start])).rows[0].state,'complete','upgrade settlement also repairs '+state+' records');
  }finally{await pg.exec('ROLLBACK');}
 }
 // Do not steal an active worker lease or accept a different original source.
 for(const fault of ['running','source_changed']){
  await pg.exec('BEGIN');try{
   if(fault==='running')await pg.query("UPDATE public.signature_completion_jobs SET state='running',evidence_id=NULL,worker_id=$4,lease_token=$5,started_at=clock_timestamp(),lease_until=clock_timestamp()+interval '60 seconds' WHERE academy_id=$1 AND purpose=$2 AND start_id=$3",[academy,purpose,start,randomUUID(),randomUUID()]);
   else await pg.query("UPDATE public.signature_completion_jobs SET state='blocked',evidence_id=NULL,source_fingerprint=$4 WHERE academy_id=$1 AND purpose=$2 AND start_id=$3",[academy,purpose,start,'0'.repeat(64)]);
   const before=(await pg.query('SELECT * FROM public.signature_completion_jobs WHERE academy_id=$1 AND purpose=$2 AND start_id=$3',[academy,purpose,start])).rows;
   await pg.query('SELECT public.settle_signature_completion_evidence($1,$2,$3)',[academy,purpose,start]);
   assert.deepEqual((await pg.query('SELECT * FROM public.signature_completion_jobs WHERE academy_id=$1 AND purpose=$2 AND start_id=$3',[academy,purpose,start])).rows,before,fault+' must not be silently settled');
  }finally{await pg.exec('ROLLBACK');}
 }
 // Legacy queued rows still reconcile through claim without provider IO.
 await pg.query("UPDATE public.signature_completion_jobs SET state='queued',evidence_id=NULL WHERE academy_id=$1 AND purpose=$2 AND start_id=$3",[academy,purpose,start]);
 await pg.query("UPDATE public.signature_completion_jobs SET available_at=clock_timestamp()-interval '1 second' WHERE academy_id=$1 AND purpose=$2 AND start_id=$3 AND state='queued'",[academy,purpose,start]);
 const before=await pg.query('SELECT * FROM public.signature_completion_job_attempts WHERE academy_id=$1 AND start_id=$2 ORDER BY attempt_no',[academy,start]),budgets=await pg.query('SELECT * FROM public.signature_completion_request_budgets ORDER BY group_id,window_started'),incidents=await pg.query('SELECT id FROM public.signature_completion_incidents WHERE academy_id=$1 AND start_id=$2 ORDER BY id',[academy,start]);
 const claim=async()=>{const c=pg.runtime?await pg.runtime.connect():{query:pg.query.bind(pg),release(){}};try{await c.query('SET ROLE kavosh_signature_completion_worker');return(await c.query('SELECT * FROM public.claim_signature_completion_job($1,$2,60)',[[academy],randomUUID()])).rows;}finally{if(!pg.runtime)await pg.exec('RESET ROLE');c.release();}};
 for(const result of pg.runtime?await Promise.all([claim(),claim()]):[await claim(),await claim()])assert.deepEqual(result,[],'existing measured evidence must avoid a new provider job');
 assert.deepEqual((await pg.query('SELECT state,last_outcome,evidence_id FROM public.signature_completion_jobs WHERE academy_id=$1 AND purpose=$2 AND start_id=$3',[academy,purpose,start])).rows,[{state:'complete',last_outcome:'recorded',evidence_id:original.evidence_id}]);
 assert.deepEqual((await pg.query('SELECT * FROM public.signature_completion_job_attempts WHERE academy_id=$1 AND start_id=$2 ORDER BY attempt_no',[academy,start])).rows,before.rows);
 assert.deepEqual((await pg.query('SELECT * FROM public.signature_completion_request_budgets ORDER BY group_id,window_started')).rows,budgets.rows,'no new provider-call reservation');
 assert.deepEqual((await pg.query('SELECT id FROM public.signature_completion_incidents WHERE academy_id=$1 AND start_id=$2 ORDER BY id',[academy,start])).rows,incidents.rows,'completion must not republish old failure cases');
}

export async function checkCompletionRetries(f:Pick<Awaited<ReturnType<typeof operationsFixture>>,'request'|'approve'|'a'|'pg'|'managerRole'|'staffRole'|'actors'|'metrics'>,requestId:string,purpose:'worker_services'|'unified_enrollment'){
 const path=(purpose==='worker_services'?'payroll/work-signature-send-requests/':'signature-send-requests/')+requestId+'/completion-check/retries',work=purpose==='worker_services',capability=work?'work-signature-completions.retry':'signature-completions.retry',event=work?'work.signature.completion.retry':'signature.completion.retry';
 assert.equal((await f.request(path)).body.data.length,0);
 const input={expectedVersion:0,checkWindowDays:2,reason:'Explicit operational recheck, not another envelope or legal waiver'};
 for(const patch of [{checkWindowDays:31},{expectedVersion:-1},{documentId:randomUUID()},{admissionCleared:true}])assert.equal((await f.request(path,{...input,...patch})).response.status,400);
 const keys=[randomUUID(),randomUUID()],race=f.pg.runtime?await Promise.all(keys.map(key=>f.request(path,input,'master',{key}))):[await f.request(path,input,'master',{key:keys[0]}),await f.request(path,input,'master',{key:keys[1]})];
 assert.deepEqual(race.map(r=>r.response.status).sort(),[200,409],JSON.stringify({bodies:race.map(r=>r.body),errors:f.metrics.queryFailures.slice(-2)}));
 const winner=race.findIndex(r=>r.response.status===200),key=keys[winner],own=race[winner];assert.equal(own.body.data.version,1);assert.equal(own.body.approval.selfApproved,true);assert.equal(own.body.data.agreementResent,false);assert.equal(own.body.data.admissionCleared,false);assert.equal(own.body.data.paymentCleared,false);
 const oldIncident=await f.request(path.replace(/retries$/,'incidents'));assert.equal(oldIncident.body.data.length,1);assert.equal(oldIncident.body.data[0].attentionStillCurrent,false,'approved retry preserves the old observation without claiming it is still blocked');
 const queue='agreement-checks?purpose='+purpose;
 assert.deepEqual((await f.request(queue)).body.data,[],'a superseded case leaves the active management queue');
 const historical=await f.request(queue+'&attention=historical');assert.equal(historical.response.status,200,JSON.stringify(historical.body));assert.equal(historical.body.data.length,1);assert.equal(historical.body.data[0].id,oldIncident.body.data[0].id);assert.equal(historical.body.data[0].attentionStillCurrent,false);
 assert.deepEqual((await f.request('agreement-checks/summary?purpose='+purpose+'&attention=historical')).body.data,[{purpose,reasonCode:'poll_window_elapsed',attentionStillCurrent:false,count:'1'}]);
 assert.deepEqual((await f.request(path,input,'master',{key})).body,own.body);
 assert.equal((await f.request(path,input)).response.status,409,'another request with an old version cannot reset retry history');
 const added:string[]=[];for(const cap of [capability,work?'work-signature-completions.view':'signature-completions.view'])if((await f.pg.query('INSERT INTO public.role_permissions VALUES($1,$2,$3,\'allow\') ON CONFLICT DO NOTHING RETURNING capability',[f.a,f.managerRole,cap])).rows.length)added.push(cap);
 const proposed=await f.request(path,{...input,expectedVersion:1},'manager');assert.equal(proposed.response.status,202,JSON.stringify({body:proposed.body,errors:f.metrics.queryFailures.slice(-2)}));
 const managerNote=(await f.pg.query<{id:string}>('SELECT id FROM public.portal_notifications WHERE event_id=$1 AND person_id=$2',[oldIncident.body.data[0].id,f.actors.manager.person])).rows[0];assert.ok(managerNote);
 const viewed=await f.request('notifications/'+managerNote.id,undefined,'manager');assert.equal(viewed.response.status,200,JSON.stringify(viewed.body));assert.equal(viewed.body.data.source.attentionStillCurrent,false,'an authorized current supervisor can still inspect the original alert after recheck');
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
 if(work){
  const staffAdded:string[]=[];for(const cap of [capability,'work-signature-completions.view'])if((await f.pg.query('INSERT INTO public.role_permissions VALUES($1,$2,$3,\'allow\') ON CONFLICT DO NOTHING RETURNING capability',[f.a,f.staffRole,cap])).rows.length)staffAdded.push(cap);
  const lower=await f.request(path,{...input,expectedVersion:2},'staff');assert.equal(lower.response.status,202,JSON.stringify(lower.body));
  const upper=await f.approve(lower.body.approval.id,'manager');assert.equal(upper.response.status,200,JSON.stringify({body:upper.body,errors:f.metrics.queryFailures.slice(-2)}));assert.equal((await f.request(path)).body.data.length,3,'a genuine non-master supervisor can approve a lower request');
  for(const cap of staffAdded)await f.pg.query('DELETE FROM public.role_permissions WHERE academy_id=$1 AND role_id=$2 AND capability=$3',[f.a,f.staffRole,cap]);
 }
 for(const cap of added)await f.pg.query('DELETE FROM public.role_permissions WHERE academy_id=$1 AND role_id=$2 AND capability=$3',[f.a,f.managerRole,cap]);
 for(const sql of ['UPDATE public.signature_completion_retries SET changed_by=changed_by','DELETE FROM public.signature_completion_retries'])await assert.rejects(f.pg.exec(sql),/SIGNATURE_COMPLETION_RETRY_IMMUTABLE/);
}

export async function checkCompletionStatus(f:Pick<Awaited<ReturnType<typeof operationsFixture>>,'request'|'a'|'b'|'pg'|'managerRole'|'actors'|'credential'>,requestId:string,purpose:'worker_services'|'unified_enrollment'){
 const path=(purpose==='worker_services'?'payroll/work-signature-send-requests/':'signature-send-requests/')+requestId+'/completion-check';
 const first=await f.request(path+'?limit=1');assert.equal(first.response.status,200,JSON.stringify(first.body));
 assert.equal(first.body.data.state,'blocked');assert.equal(first.body.data.attemptCount,2);assert.equal(first.body.attempts.length,1);assert.equal(first.body.attempts[0].attemptNo,1);assert.equal(first.body.nextAfterAttempt,1);
 const second=await f.request(path+'?limit=1&afterAttempt=1');assert.equal(second.response.status,200);assert.equal(second.body.attempts[0].attemptNo,2);assert.equal(second.body.nextAfterAttempt,null);
 assert.equal(first.body.workerLiveness,'not_observed');assert.equal(first.body.admissionCleared,false);assert.equal(first.body.paymentCleared,false);
 assert.doesNotMatch(JSON.stringify(first.body),/lease_token|worker_id|source_fingerprint|connection_id|document_id|PRIVATE|synthetic-private/);
 assert.equal((await f.request(path+'?afterAttempt=99')).response.status,404);
 assert.equal((await f.request(path,undefined,'foreignMaster',{academy:f.b})).response.status,404);
 const incidents=await f.request(path+'/incidents');assert.equal(incidents.response.status,200,JSON.stringify(incidents.body));assert.equal(incidents.body.data.length,1);assert.equal(incidents.body.data[0].reasonCode,'poll_window_elapsed');assert.equal(incidents.body.data[0].attentionStillCurrent,true);assert.equal(incidents.body.caseResolvedByReading,false);
 const incidentId=incidents.body.data[0].id,notes=(await f.pg.query<{id:string;person_id:string}>('SELECT id,person_id FROM public.portal_notifications WHERE academy_id=$1 AND event_id=$2 AND origin=\'mandatory\'',[f.a,incidentId])).rows;
 const masterNote=notes.find(n=>n.person_id===f.actors.master.person);assert.ok(masterNote,'actual failure must publish a mandatory master notification');
 const note=await f.request('notifications/'+masterNote.id);assert.equal(note.response.status,200,JSON.stringify(note.body));assert.equal(note.body.data.source.kind,'signature_check');assert.equal(note.body.data.source.recordPath,'/api/v1/'+path);assert.equal(note.body.data.source.attentionStillCurrent,true);assert.equal(note.body.data.source.caseResolvedByReading,false);
 assert.equal((await f.request('notifications/'+masterNote.id,undefined,'foreignMaster',{academy:f.b})).response.status,404);
 assert.equal((await f.request('notifications/'+masterNote.id+'/read',{})).response.status,200);assert.equal((await f.request(path)).body.data.state,'blocked','reading the alert never resolves the native case');
 assert.notEqual((await f.request('notifications/'+masterNote.id+'?locale=fr')).body.data.title,note.body.data.title);assert.notEqual((await f.request('notifications/'+masterNote.id+'?locale=zh-CN')).body.data.title,note.body.data.title);
 const queue='agreement-checks?purpose='+purpose,listed=await f.request(queue+'&limit=1');assert.equal(listed.response.status,200,JSON.stringify(listed.body));assert.equal(listed.body.data.length,1);assert.equal(listed.body.data[0].id,incidentId);assert.equal(listed.body.data[0].requestId,requestId);assert.equal(listed.body.data[0].recordPath,'/api/v1/'+path);assert.equal(listed.body.data[0].attentionStillCurrent,true,'reading the mandatory notice must not remove an unresolved case');
 assert.doesNotMatch(JSON.stringify(listed.body),/PRIVATE|source_fingerprint|origin_transaction|document_id|lease_token|worker_id|example[.]test/);
 const cursor=new URLSearchParams({afterRecordedAt:listed.body.data[0].recordedAt,afterId:incidentId});assert.deepEqual((await f.request(queue+'&'+cursor)).body.data,[],'stable tuple cursor must not repeat its last row');
 assert.deepEqual((await f.request('agreement-checks/summary?purpose='+purpose)).body.data,[{purpose,reasonCode:'poll_window_elapsed',attentionStillCurrent:true,count:'1'}]);
 assert.deepEqual((await f.request(queue,undefined,'foreignMaster',{academy:f.b})).body.data,[]);
 const overview=await f.request('overview?timeZone=America/Toronto&include=agreement_checks&limit=1');assert.equal(overview.response.status,200,JSON.stringify(overview.body));assert.equal(overview.body.data.sections[0].rows[0].recordPath,'/api/v1/'+path);
 assert.doesNotMatch(JSON.stringify(note.body),/PRIVATE|origin_transaction|source_fingerprint|lease_token|worker_id/);
 await f.pg.exec('SET ROLE kavosh_runtime');try{
  await f.pg.query("SELECT set_config('app.academy_id',$1,false)",[f.a]);
  await assert.rejects(f.pg.query("INSERT INTO public.portal_notifications(academy_id,id,run_id,rule_id,event_id,person_id,action_index,severity,title,body,locale) VALUES($1,$2,$3,$4,$5,$6,0,'critical','Synthetic','Synthetic','en')",[f.a,randomUUID(),randomUUID(),randomUUID(),incidentId,f.actors.master.person]));
  await assert.rejects(f.pg.query("INSERT INTO public.notification_deliveries(academy_id,id,run_id,rule_id,rule_version,event_id,person_id,action_index,channel,title,body,locale,owner_epoch,contact_epoch,preference_version) VALUES($1,$2,$3,$4,1,$5,$6,0,'email','Synthetic','Synthetic','en',$7,$7,1)",[f.a,randomUUID(),randomUUID(),randomUUID(),incidentId,f.actors.master.person,'a'.repeat(64)]));
 }finally{await f.pg.exec('RESET ROLE');}
 assert.equal((await f.request(path+'/incidents?after='+randomUUID())).response.status,404);
 assert.equal((await f.request(path+'/incidents',undefined,'foreignMaster',{academy:f.b})).response.status,404);
 const capability=purpose==='worker_services'?'work-signature-completions.view':'signature-completions.view';
 const granted=(await f.pg.query("INSERT INTO public.role_permissions VALUES($1,$2,$3,'allow') ON CONFLICT DO NOTHING RETURNING capability",[f.a,f.managerRole,capability])).rows;
 try{
  for(const actor of ['manager','bot']){const allowed=await f.request(queue,undefined,actor);assert.equal(allowed.response.status,200,JSON.stringify(allowed.body));assert.equal(allowed.body.data.length,1,'scoped supervisors and their independently scoped bots can see their original case');}
  const templateGrant=(await f.pg.query<{effect:string}>("SELECT effect FROM public.role_permissions WHERE academy_id=$1 AND role_id=$2 AND capability='agreements.view'",[f.a,f.managerRole])).rows;
  await f.pg.query("INSERT INTO public.role_permissions VALUES($1,$2,'agreements.view','deny') ON CONFLICT(academy_id,role_id,capability) DO UPDATE SET effect='deny'",[f.a,f.managerRole]);
  try{for(const actor of ['manager','bot']){const hidden=await f.request(queue+'&limit=1',undefined,actor);assert.equal(hidden.response.status,200,JSON.stringify(hidden.body));assert.deepEqual(hidden.body.data,[]);assert.equal(hidden.body.nextCursor,null);assert.deepEqual((await f.request('agreement-checks/summary?purpose='+purpose,undefined,actor)).body.data,[],'original template denial filters both pages and totals');}}finally{await f.pg.query("DELETE FROM public.role_permissions WHERE academy_id=$1 AND role_id=$2 AND capability='agreements.view'",[f.a,f.managerRole]);for(const row of templateGrant)await f.pg.query("INSERT INTO public.role_permissions VALUES($1,$2,'agreements.view',$3)",[f.a,f.managerRole,row.effect]);}
  const token=(await f.pg.query<{capabilities:string[]}>('SELECT capabilities FROM auth_private.credentials WHERE id=$1',[f.credential])).rows[0];
  await f.pg.query("UPDATE auth_private.credentials SET capabilities=array_remove(array_remove(capabilities,'signature-completions.view'),'work-signature-completions.view') WHERE id=$1",[f.credential]);
  try{assert.equal((await f.request(queue,undefined,'bot')).response.status,403,'the bot cannot borrow master or role rights beyond its real token ceiling');assert.equal((await f.request('agreement-checks/summary',undefined,'bot')).response.status,403);}finally{await f.pg.query('UPDATE auth_private.credentials SET capabilities=$2 WHERE id=$1',[f.credential,token.capabilities]);}
 }finally{if(granted.length)await f.pg.query('DELETE FROM public.role_permissions WHERE academy_id=$1 AND role_id=$2 AND capability=$3',[f.a,f.managerRole,capability]);}
 const saved=(await f.pg.query<{effect:string}>('DELETE FROM public.role_permissions WHERE academy_id=$1 AND role_id=$2 AND capability=$3 RETURNING effect',[f.a,f.managerRole,capability])).rows;
 try{for(const target of [path,path+'/incidents'])assert.equal((await f.request(target,undefined,'manager')).response.status,purpose==='worker_services'?403:404,'removing the current feature permission immediately removes status/history access');const managerNote=notes.find(n=>n.person_id===f.actors.manager.person);if(managerNote)assert.equal((await f.request('notifications/'+managerNote.id,undefined,'manager')).response.status,404,'the same removed right hides previously created mandatory alerts');}
 finally{for(const grant of saved)await f.pg.query('INSERT INTO public.role_permissions VALUES($1,$2,$3,$4)',[f.a,f.managerRole,capability,grant.effect]);}
}

// Called only after the original-flow fixture has produced a real native,
// original-bound service receipt. Network responses in that fixture are fake.
export async function checkCompletionQueue(pg:Pick<Awaited<ReturnType<typeof operationsFixture>>['pg'],'query'|'exec'|'runtime'>,academy:string,foreign:string,start:string,fingerprint:string,purpose:'worker_services'|'unified_enrollment'='worker_services'){
 const worker=randomUUID(),blockedEvent=purpose==='worker_services'?'work.signature.completion.check.blocked.critical':'signature.completion.check.blocked.critical';
 async function isolated<T>(run:()=>Promise<T>){await pg.exec('SET ROLE kavosh_signature_completion_worker');let failed=false;try{return await run();}catch(error){failed=true;throw error;}finally{try{await pg.exec('RESET ROLE');}catch(error){if(!failed)throw error;}}}
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
 if(pg.runtime){
  await pg.query("UPDATE public.signature_completion_jobs SET available_at=clock_timestamp()-interval '1 second' WHERE start_id=$1",[start]);
  const holder=await pg.runtime.connect();try{
   // runtime.connect deliberately sets the restricted application role. This
   // disposable fixture's owner simulates a competing administrative writer;
   // do not grant the real application UPDATE rights merely for a row lock.
   await holder.query('RESET ROLE');
   await holder.query('BEGIN');await holder.query('SELECT start_id FROM public.signature_completion_jobs WHERE academy_id=$1 AND purpose=$2 AND start_id=$3 FOR UPDATE',[academy,purpose,start]);
   assert.deepEqual(await claim(),[],'a genuinely row-locked due job must be skipped by another native claimant');
  }finally{await holder.query('ROLLBACK');holder.release();}
 }
 // Clock fault injection,not real-time waiting or a load test. Keep the entire
 // crash sequence disposable;later history checks retain the original2attempts.
 await pg.exec('BEGIN');try{
  await pg.query("UPDATE public.signature_completion_jobs SET available_at=clock_timestamp()-interval '1 second' WHERE start_id=$1",[start]);
  const inside=()=>isolated(async()=> (await pg.query<{lease_token:string;attempt_no:number}>('SELECT * FROM public.claim_signature_completion_job($1,$2,60)',[[academy],worker])).rows);
  let live=(await inside())[0];assert.equal(live.attempt_no,3);
  for(let failures=1;failures<=5;failures++){
   await pg.query("UPDATE public.signature_completion_jobs SET started_at=clock_timestamp()-interval '61 seconds',lease_until=clock_timestamp()-interval '1 second' WHERE academy_id=$1 AND purpose=$2 AND start_id=$3",[academy,purpose,start]);
   const next=await inside();assert.equal(next.length,failures===5?0:1,'only the fifth expired lease becomes terminal');
   assert.equal((await pg.query('SELECT failures FROM public.signature_completion_jobs WHERE academy_id=$1 AND purpose=$2 AND start_id=$3',[academy,purpose,start])).rows[0].failures,failures);
   if(failures<5){assert.notEqual(next[0].lease_token,live.lease_token);assert.equal(next[0].attempt_no,live.attempt_no+1);assert.equal(await finish(live.lease_token),false,'expired runners remain fenced after recovery');live=next[0];}
  }
  assert.deepEqual((await pg.query('SELECT state,last_outcome,lease_token,attempt_no FROM public.signature_completion_jobs WHERE academy_id=$1 AND purpose=$2 AND start_id=$3',[academy,purpose,start])).rows,[{state:'blocked',last_outcome:'lease_expired',lease_token:null,attempt_no:7}]);
  const attempts=(await pg.query('SELECT attempt_no,outcome FROM public.signature_completion_job_attempts WHERE academy_id=$1 AND start_id=$2 AND attempt_no>=3 ORDER BY attempt_no',[academy,start])).rows;assert.deepEqual(attempts,Array.from({length:5},(_,i)=>({attempt_no:i+3,outcome:'lease_expired'})));
  const cases=(await pg.query<{id:string}>('SELECT id FROM public.signature_completion_incidents WHERE academy_id=$1 AND purpose=$2 AND start_id=$3 AND reason_code=\'lease_expired\'',[academy,purpose,start])).rows;assert.equal(cases.length,1);
  assert.ok((await pg.query('SELECT id FROM public.portal_notifications WHERE academy_id=$1 AND event_id=$2 AND origin=\'mandatory\'',[academy,cases[0].id])).rows.length>=1);
  assert.deepEqual(await inside(),[]);assert.equal((await pg.query('SELECT id FROM public.signature_completion_incidents WHERE academy_id=$1 AND purpose=$2 AND start_id=$3',[academy,purpose,start])).rows.length,1,'terminal recovery must not publish another case on each scan');
 }finally{await pg.exec('ROLLBACK');}
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
  await pg.exec('DROP TRIGGER zz_suppress_completion_incident ON public.signature_completion_incidents');
  for(const [table,condition,expected] of [['automation_event_sources',"NEW.source_kind='signature_check'",'SIGNATURE_CHECK_EVENT_PERSISTENCE_REQUIRED'],['portal_notifications',"NEW.origin='mandatory' AND NEW.title='Agreement check needs attention'",'SIGNATURE_CHECK_ALERT_PERSISTENCE_REQUIRED']]){
   await pg.exec(`CREATE OR REPLACE FUNCTION public.suppress_signature_alert_part() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF ${condition} THEN RETURN NULL;END IF;RETURN NEW;END $$;CREATE TRIGGER zz_suppress_signature_alert_part BEFORE INSERT ON public.${table} FOR EACH ROW EXECUTE FUNCTION public.suppress_signature_alert_part()`);
   await pg.exec('SAVEPOINT suppressed_part');await pg.exec('SET LOCAL ROLE kavosh_signature_completion_worker');
   await assert.rejects(pg.query('SELECT * FROM public.claim_signature_completion_job($1,$2,60)',[[academy],worker]),new RegExp(expected));
   await pg.exec('ROLLBACK TO SAVEPOINT suppressed_part');assert.equal((await pg.query('SELECT state FROM public.signature_completion_jobs WHERE start_id=$1',[start])).rows[0].state,'queued');
   await pg.exec('DROP TRIGGER zz_suppress_signature_alert_part ON public.'+table);
  }
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
