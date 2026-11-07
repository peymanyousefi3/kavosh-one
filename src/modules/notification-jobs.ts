import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { jsonBody,mutation,record,type ApiContext,type Reply } from '../core/api.ts';
import { master,permissionScope,approvalReadParameters } from '../core/approvals.ts';
import { ApiError,requireScope } from '../core/policy.ts';
import { automationRuleHeader } from './automation-rules.ts';
import { boundAutomationEvent,automationEventReadSelectionSQL,requireCurrentSessionEvent } from './automation-events.ts';
import { lockAcademyTopology } from './academy.ts';
import { automationDefinition,ruleSample,simulateRule } from '../core/automation-rules.ts';

const uuid=z.string().uuid().transform(v=>v.toLowerCase()),empty=z.object({}).strict();
export const notificationJobInput=z.object({eventId:uuid,expectedVersion:z.number().int().positive().max(2147483647),locale:z.enum(['en','fr','zh-CN']).default('en')}).strict();
const paging=z.object({limit:z.coerce.number().int().min(1).max(100).default(50),after:uuid.optional(),status:z.enum(['queued','running','succeeded','cancelled','failed']).optional()}).strict();
const fanoutInput=z.object({limit:z.number().int().min(1).max(25).default(10),after:uuid.optional(),locale:z.enum(['en','fr','zh-CN']).default('en')}).strict();
type Job={id:string;rule_id:string;rule_version:number;event_id:string;requester_id:string;status:string;attempts:number;generation:number;retry_of:string|null;locale:string;created_at:string;expires_at:string;finished_at:string|null;run_id:string|null;last_error:string|null};
const columns='j.id,j.rule_id,j.rule_version,j.event_id,j.requester_id,j.status,j.attempts,j.generation,j.retry_of,j.locale,j.created_at,j.expires_at,j.finished_at,j.run_id,j.last_error';
const from=`FROM public.notification_jobs j JOIN public.automation_event_sources e ON e.academy_id=j.academy_id AND e.event_id=j.event_id LEFT JOIN public.approval_requests p ON p.academy_id=e.academy_id AND p.id=e.approval_id WHERE ${automationEventReadSelectionSQL}`;
async function visible(ctx:ApiContext,id:string){const j=(await ctx.db.query<Job>('SELECT '+columns+' '+from+' AND j.id=$6',[...await approvalReadParameters(ctx),id])).rows[0];if(!j)throw new ApiError(404,'NOT_FOUND');await automationRuleHeader(ctx,j.rule_id);return j;}
export async function notificationJobs(ctx:ApiContext):Promise<Reply|null>{
 const fanout=/^automations\/events\/([^/]+)\/queue$/.exec(ctx.path);
 if(fanout){
  if(ctx.request.method!=='POST')throw new ApiError(405,'METHOD_NOT_ALLOWED');empty.parse(Object.fromEntries(new URL(ctx.request.url).searchParams));const eventId=uuid.parse(fanout[1]),input=fanoutInput.parse(await jsonBody(ctx.request));await lockAcademyTopology(ctx);
  const event=await boundAutomationEvent(ctx,eventId);requireCurrentSessionEvent(event);const scopes=['automations.view','automations.execute'].map(cap=>permissionScope(ctx,cap as 'automations.view'|'automations.execute'));
  if(scopes.some(s=>!s.all&&!s.hubs.length))throw new ApiError(403,'FORBIDDEN');
  // Filter both current scopes BEFORE paging. A cursor never identifies a rule
  // outside the caller's view/execute ceiling. Source rights are independent.
  const predicate=(n:number)=>`((r.hub_id IS NULL AND $${n}::boolean AND cardinality($${n+2}::uuid[])=0 AND $${n+3}::boolean) OR(r.hub_id IS NOT NULL AND(($${n}::boolean AND NOT r.hub_id=ANY($${n+2}::uuid[])) OR r.hub_id=ANY($${n+1}::uuid[]))))`;
  // Bind cached page metadata to the current permission ceiling as well; a
  // retry after losing a hub must not disclose its old rule IDs/cursor.
  return mutation(ctx,{eventId,...input,permissionScopes:scopes},async()=>{
   const rows=(await ctx.db.query<{id:string;hub_id:string|null;version:number;definition:unknown}>(`SELECT r.id,r.hub_id,r.version,v.definition FROM public.automation_rules r JOIN public.automation_rule_revisions v ON v.academy_id=r.academy_id AND v.rule_id=r.id AND v.version=r.version WHERE ${predicate(1)} AND ${predicate(5)} AND($9::uuid IS NULL OR r.id>$9) ORDER BY r.id LIMIT $10`,[...scopes.flatMap(s=>[s.all,s.hubs,s.excludedHubs??[],!s.excludedAreas?.length]),input.after??null,input.limit+1])).rows;
   const queued:{ruleId:string;ruleVersion:number;jobId:string;jobStatus:string;duplicate:boolean}[]=[];
   for(const row of rows.slice(0,input.limit)){
    const definition=automationDefinition.parse(row.definition);if(definition.execution.mode!=='automatic'||!simulateRule(definition,row.hub_id,ruleSample.parse(event.projection),input.locale).eligibleByConfiguration)continue;
    // Reuse the same audited,requester-bound durable queue. No elevated actor,
    // fanout-specific retry semantics or direct delivery implementation.
    const path='automations/rules/'+row.id+'/queue',request=new Request('https://internal.invalid/api/v1/'+path,{method:'POST',headers:{'content-type':'application/json','idempotency-key':randomUUID()},body:JSON.stringify({eventId,expectedVersion:row.version,locale:input.locale})});
    const reply=await notificationJobs({...ctx,path,request,requestId:randomUUID()});if(!reply||![200,202].includes(reply.status))throw new ApiError(503,'NOTIFICATION_QUEUE_UNAVAILABLE');
    const saved=z.object({data:z.object({id:uuid,status:z.enum(['queued','running','succeeded','cancelled','failed'])}),duplicate:z.boolean()}).parse(reply.body);queued.push({ruleId:row.id,ruleVersion:row.version,jobId:saved.data.id,jobStatus:saved.data.status,duplicate:saved.duplicate});
   }
   await record(ctx.db,ctx.credential,ctx.requestId,'notification.batch_queued',eventId,event.projection.hubId,{rulesScanned:Math.min(rows.length,input.limit),jobs:queued.length,severity:'critical',externalRequestMade:false});
   const pending=queued.some(j=>j.jobStatus==='queued'||j.jobStatus==='running');
   return {status:pending?202:200,body:{data:queued,nextCursor:rows.length>input.limit?rows[input.limit-1].id:null,rulesScanned:Math.min(rows.length,input.limit),supportedSources:['approval','audit','session','report_schedule','report_job'],backgroundWorkerRequired:pending,queued:pending,delivered:false,externalRequestMade:false}};
  });
 }
 const queue=/^automations\/rules\/([^/]+)\/queue$/.exec(ctx.path),list=/^automations\/rules\/([^/]+)\/jobs$/.exec(ctx.path),detail=/^automations\/jobs\/([^/]+)(?:\/(cancel))?$/.exec(ctx.path);
 if(!queue&&!list&&!detail)return null;
 if(queue){
  if(ctx.request.method!=='POST')throw new ApiError(405,'METHOD_NOT_ALLOWED');empty.parse(Object.fromEntries(new URL(ctx.request.url).searchParams));const id=uuid.parse(queue[1]),i=notificationJobInput.parse(await jsonBody(ctx.request));await lockAcademyTopology(ctx);const r=await automationRuleHeader(ctx,id);requireScope(permissionScope(ctx,'automations.execute'),r.hub_id??undefined);requireCurrentSessionEvent(await boundAutomationEvent(ctx,i.eventId));
  const locked=(await ctx.db.query<{version:number}>('SELECT version FROM public.automation_rules WHERE id=$1 FOR SHARE',[id])).rows[0];if(locked?.version!==r.version)throw new ApiError(409,'AUTOMATION_RULE_CHANGED');
  await ctx.db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,17))',[ctx.credential.academy_id+':'+ctx.credential.person_id]);
  return mutation(ctx,{ruleId:id,...i},async()=>{
   const prior=(await ctx.db.query<Job>('SELECT '+columns+' FROM public.notification_jobs j WHERE j.rule_id=$1 AND j.event_id=$2 AND j.requester_id=$3 ORDER BY j.generation DESC LIMIT 1',[id,i.eventId,ctx.credential.person_id])).rows[0];if(prior&&['queued','running','succeeded'].includes(prior.status))return {status:200,body:{data:await visible(ctx,prior.id),duplicate:true,externalRequestMade:false}};
   if(i.expectedVersion!==r.version)throw new ApiError(409,'AUTOMATION_RULE_CHANGED');if(prior&&prior.generation>=1000)throw new ApiError(422,'NOTIFICATION_REQUEUE_LIMIT');
   if((await ctx.db.query<{n:number}>("SELECT count(*)::integer AS n FROM public.notification_jobs WHERE requester_id=$1 AND status IN('queued','running')",[ctx.credential.person_id])).rows[0].n>=200)throw new ApiError(429,'NOTIFICATION_QUEUE_FULL');
   const job=randomUUID();await record(ctx.db,ctx.credential,ctx.requestId,'notification.queued',job,r.hub_id,{ruleId:id,eventId:i.eventId,ruleVersion:r.version,severity:'critical',externalRequestMade:false});
   const user=ctx.credential.kind==='human'?(await ctx.db.query<{auth_user_id:string}>('SELECT auth_user_id FROM public.people WHERE id=$1',[ctx.credential.person_id])).rows[0].auth_user_id:null;
   await ctx.db.query(`INSERT INTO public.notification_jobs(academy_id,id,rule_id,rule_version,event_id,requester_id,requester_kind,credential_id,user_id,locale,enqueue_request_id,audit_id,generation,retry_of) SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,a.id,$12,$13 FROM public.audit_events a WHERE a.academy_id=$1 AND a.request_id=$11 AND a.action='notification.queued' AND a.entity_id=$2 AND a.created_at=transaction_timestamp()`,[ctx.credential.academy_id,job,id,r.version,i.eventId,ctx.credential.person_id,ctx.credential.kind==='human'?'human':'bot',ctx.credential.token_id,user,i.locale,ctx.requestId,(prior?.generation??0)+1,prior?.id??null]);
   return {status:202,body:{data:await visible(ctx,job),duplicate:false,backgroundWorkerRequired:true,queued:true,delivered:false,externalRequestMade:false}};
  });
 }
 if(list){if(ctx.request.method!=='GET')throw new ApiError(405,'METHOD_NOT_ALLOWED');const id=uuid.parse(list[1]);await automationRuleHeader(ctx,id);const q=paging.parse(Object.fromEntries(new URL(ctx.request.url).searchParams)),rows=(await ctx.db.query<Job>('SELECT '+columns+' '+from+' AND j.rule_id=$6 AND($7::uuid IS NULL OR j.id>$7) AND($8::text IS NULL OR j.status=$8) ORDER BY j.id LIMIT $9',[...await approvalReadParameters(ctx),id,q.after??null,q.status??null,q.limit+1])).rows;return {status:200,body:{data:rows.slice(0,q.limit),nextCursor:rows.length>q.limit?rows[q.limit-1].id:null}};}
 const id=uuid.parse(detail![1]);if(detail![2]){
  if(ctx.request.method!=='POST')throw new ApiError(405,'METHOD_NOT_ALLOWED');empty.parse(Object.fromEntries(new URL(ctx.request.url).searchParams));empty.parse(await jsonBody(ctx.request));await lockAcademyTopology(ctx);const j=await visible(ctx,id),r=await automationRuleHeader(ctx,j.rule_id);requireScope(permissionScope(ctx,'automations.execute'),r.hub_id??undefined);
  if(j.requester_id!==ctx.credential.person_id&&!(await master(ctx))&&!(ctx.credential.kind==='human'&&(await ctx.db.query<{ok:boolean}>('SELECT public.is_supervisor($1,$2) AS ok',[ctx.credential.person_id,j.requester_id])).rows[0].ok))throw new ApiError(403,'UPPER_OR_OWNER_REQUIRED');
  return mutation(ctx,{},async()=>{if(j.status==='cancelled')return {status:200,body:{data:j}};if(!['queued','running'].includes(j.status))throw new ApiError(409,'NOTIFICATION_JOB_FINAL');await record(ctx.db,ctx.credential,ctx.requestId,'notification.cancelled',id,r.hub_id,{severity:'critical',doesNotUndoDeliveredMessages:true});const updated=await ctx.db.query("UPDATE public.notification_jobs SET status='cancelled' WHERE id=$1 AND status IN('queued','running') RETURNING id",[id]);if(!updated.rows.length)throw new ApiError(409,'NOTIFICATION_JOB_CHANGED');return {status:200,body:{data:await visible(ctx,id)}};});
 }
 if(ctx.request.method!=='GET')throw new ApiError(405,'METHOD_NOT_ALLOWED');empty.parse(Object.fromEntries(new URL(ctx.request.url).searchParams));return {status:200,body:{data:await visible(ctx,id)}};
}
export const notificationJobsContract=[
 {path:'/api/v1/automations/events/{id}/queue',method:'post',summary:'Queue matching enabled automatic rules for one currently authorized bound event,in bounded permission-filtered pages; session and report-issue sources must still be current; retains requester identity,current rule versions and existing durable deduplication. Does not deliver messages or activate a daemon',schema:fanoutInput,acceptedDescription:'Matching automatic-rule jobs queued; a separately enabled worker rechecks current source,actor,rule and recipient rights.'},
 {path:'/api/v1/automations/rules/{id}/queue',method:'post',summary:'Persist an immediate notification job bound to the authenticated requester; current actor/source/rule rights are rechecked by the worker. An explicitly resubmitted failed/cancelled job creates a fresh linked generation; history is never rewritten',schema:notificationJobInput,acceptedDescription:'Durable notification job queued, not delivered and not a pending upper-approval case. A separately enabled worker is required.'},
 {path:'/api/v1/automations/rules/{id}/jobs',method:'get',summary:'Current-rule and source-authorized job metadata, filtered before pagination; never credential IDs, user IDs, lease tokens or raw errors',querySchema:paging},
 {path:'/api/v1/automations/jobs/{id}',method:'get',summary:'Current-authorized job state and redacted outcome without private execution credentials'},
 {path:'/api/v1/automations/jobs/{id}/cancel',method:'post',summary:'Owner or authorized upper human cancels pending work; does not undo already committed messages',schema:empty}
] as const;
