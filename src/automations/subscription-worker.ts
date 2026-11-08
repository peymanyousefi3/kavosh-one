import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { assertRuntimeRole,assertSchemaReady,type Database } from '../core/database.ts';
import { loadGrants,type ApiContext } from '../core/api.ts';
import { ApiError,requireScope,type Credential } from '../core/policy.ts';
import { permissionScope } from '../core/approvals.ts';
import { automationDefinition,ruleSample,simulateRule } from '../core/automation-rules.ts';
import { automationRuleHeader,automationRuleRevision } from '../modules/automation-rules.ts';
import { pendingSubscriptionEvent } from '../modules/automation-events.ts';
import { notificationJobs } from '../modules/notification-jobs.ts';
import { lockAcademyTopology } from '../modules/academy.ts';
import { nextSessionReminder } from './session-reminders.ts';
import { nextSessionFollowUp } from './session-follow-up.ts';

const uuid=z.string().uuid().transform(v=>v.toLowerCase()),academies=z.array(uuid).min(1).max(1000).refine(v=>new Set(v).size===v.length);
type Lease={id:string;academy_id:string;lease_token:string};
// One short DB-only step. No provider credentials,external IO,synthetic master
// or assumed worker authority. Existing queue/notification worker owns delivery.
export async function processOneSubscription(database:Database,allowedAcademies:string[],signal?:AbortSignal){
 const ids=academies.parse(allowedAcademies);if(signal?.aborted)return {claimed:false,recorded:false};const db=await database.connect();let lease:Lease|undefined,transaction=false,broken=false;
 try{
  await assertRuntimeRole(db,'automation_worker');await assertSchemaReady(db);lease=(await db.query<Lease>('SELECT * FROM public.claim_automation_subscription($1)',[ids])).rows[0];if(!lease)return {claimed:false,recorded:false};
  let failure:'retry'|'authorization_lost'='retry',problem='PROCESSING_UNAVAILABLE';
  try{
   // Commit authentication/rate accounting BEFORE domain work,as the public
   // API does. Do not hold its rate-counter lock while an owner stops a watch.
   const c=(await db.query<Credential&{user_id:string|null}>('SELECT * FROM public.automation_subscription_actor($1,$2,$3)',[lease.id,lease.lease_token,lease.academy_id])).rows[0];if(!c)throw new ApiError(401,'SUBSCRIPTION_AUTHORIZATION_EXPIRED');if(!c.allowed)throw new ApiError(429,'RATE_LIMITED');
   await db.query('BEGIN');transaction=true;await db.query("SELECT set_config('app.academy_id',$1,true),set_config('statement_timeout','5000',true),set_config('lock_timeout','2000',true)",[lease.academy_id]);
   const locked=c.kind==='human'?await db.query<{valid:boolean}>('SELECT public.lock_human($1,$2) valid',[c.token_id,c.user_id]):await db.query<{valid:boolean}>('SELECT public.lock_bot($1) valid',[c.token_id]);if(!locked.rows[0]?.valid)throw new ApiError(401,'SUBSCRIPTION_AUTHORIZATION_EXPIRED');
   if((await db.query<{status:string}>('SELECT status FROM public.academies WHERE id=$1',[lease.academy_id])).rows[0]?.status!=='active')throw new ApiError(403,'ACADEMY_UNAVAILABLE');
   const sub=(await db.query<{rule_id:string;locale:string;initial_snapshot:string;activation_transaction:string}>('SELECT rule_id,locale,initial_snapshot::text,activation_transaction::text FROM public.automation_subscriptions WHERE id=$1',[lease.id])).rows[0];if(!sub)throw new ApiError(404,'SUBSCRIPTION_UNAVAILABLE');
   const ctx:ApiContext={db,credential:c,grants:await loadGrants(db,c),request:new Request('https://internal.invalid'),path:'',requestId:randomUUID()};await lockAcademyTopology(ctx);
   const header=await automationRuleHeader(ctx,sub.rule_id);requireScope(permissionScope(ctx,'automations.execute'),header.hub_id??undefined);
   const version=(await db.query<{version:number}>('SELECT version FROM public.automation_rules WHERE id=$1 FOR SHARE',[header.id])).rows[0]?.version;if(version!==header.version)throw new ApiError(409,'AUTOMATION_RULE_CHANGED');
   const revision=await automationRuleRevision(ctx,header),definition=automationDefinition.parse(revision.definition),event=await nextSessionFollowUp(ctx,lease.id,lease.lease_token,header,definition)??await nextSessionReminder(ctx,lease.id,lease.lease_token,header,definition)??await pendingSubscriptionEvent(ctx,lease.id,sub.initial_snapshot,sub.activation_transaction);let outcome:'idle'|'ignored'|'queued'=event?'ignored':'idle',jobId:string|null=null;
   if(event&&(!['session','report_schedule','calendar_event'].includes(event.source_kind)||event.source_current)&&definition.execution.mode==='automatic'&&simulateRule(definition,header.hub_id,ruleSample.parse(event.projection),z.enum(['en','fr','zh-CN']).parse(sub.locale)).eligibleByConfiguration){
    const path='automations/rules/'+header.id+'/queue',request=new Request('https://internal.invalid/api/v1/'+path,{method:'POST',headers:{'content-type':'application/json','idempotency-key':randomUUID()},body:JSON.stringify({eventId:event.id,expectedVersion:header.version,locale:sub.locale})});
    const reply=await notificationJobs({...ctx,path,request});if(!reply||![200,202].includes(reply.status))throw new Error('SUBSCRIPTION_QUEUE_FAILED');jobId=uuid.parse((reply.body as {data:{id:string}}).data.id);outcome='queued';
   }
   if(signal?.aborted)throw new ApiError(503,'WORKER_STOPPED');
   const recorded=(await db.query<{ok:boolean}>('SELECT public.finish_automation_subscription($1,$2,$3,$4,$5,$6,NULL) ok',[lease.id,lease.lease_token,outcome,event?.id??null,jobId,header.version])).rows[0]?.ok===true;if(!recorded)throw new ApiError(409,'SUBSCRIPTION_LEASE_LOST');
   await db.query('COMMIT');transaction=false;return {claimed:true,recorded:true,outcome};
  }catch(error){if(transaction){await db.query('ROLLBACK');transaction=false;}if(error instanceof ApiError){problem=error.code;failure=[400,401,403,404,422].includes(error.status)?'authorization_lost':'retry';}}
  await db.query('BEGIN');transaction=true;await db.query("SELECT set_config('app.academy_id',$1,true)",[lease.academy_id]);const recorded=(await db.query<{ok:boolean}>('SELECT public.finish_automation_subscription($1,$2,$3,NULL,NULL,NULL,$4) ok',[lease.id,lease.lease_token,failure,problem])).rows[0]?.ok===true;await db.query('COMMIT');transaction=false;return {claimed:true,recorded,outcome:failure};
 }catch(error){if(transaction)try{await db.query('ROLLBACK');}catch{broken=true;}throw error;}finally{db.release(broken);}
}
