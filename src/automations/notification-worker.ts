import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { assertRuntimeRole,assertSchemaReady,type Database } from '../core/database.ts';
import { loadGrants,type ApiContext } from '../core/api.ts';
import { ApiError,type Credential } from '../core/policy.ts';
import { notifications } from '../modules/notifications.ts';

const uuid=z.string().uuid().transform(v=>v.toLowerCase()),academies=z.array(uuid).min(1).max(1000).refine(v=>new Set(v).size===v.length);
type Lease={id:string;academy_id:string;lease_token:string};
type Actor=Credential&{user_id:string|null};
// One worker invocation handles one queued mutation. The requester explicitly
// authorized it; this never manufactures a master, login, bearer or session.
export async function processOneNotification(database:Database,allowedAcademies:string[],signal?:AbortSignal){
 const ids=academies.parse(allowedAcademies);if(signal?.aborted)return {claimed:false,recorded:false};const db=await database.connect();let lease:Lease|undefined,transaction=false,broken=false;
 try{
  await assertRuntimeRole(db,'automation_worker');await assertSchemaReady(db);
  lease=(await db.query<Lease>('SELECT * FROM public.claim_notification_job($1)',[ids])).rows[0];if(!lease)return {claimed:false,recorded:false};
  let result:'succeeded'|'cancelled'|'retry'='retry',runId:string|null=null,problem:string|null=null;
  try{
   // Authentication/rate accounting commits before domain work,as in the web
   // API. The correlated materialized context is local to this one statement;
   // it preserves the existing tenant-bound broker without a session setting.
   const c=(await db.query<Actor>(`WITH scope_context AS MATERIALIZED(SELECT set_config('app.academy_id',$3,true) academy)
    SELECT actor.* FROM scope_context CROSS JOIN LATERAL public.notification_job_actor($1,CASE WHEN scope_context.academy=$3::text THEN $2::uuid END) actor`,[lease.id,lease.lease_token,lease.academy_id])).rows[0];if(!c)throw new ApiError(401,'QUEUED_AUTHORIZATION_EXPIRED');if(!c.allowed)throw new ApiError(429,'RATE_LIMITED');
   await db.query('BEGIN');transaction=true;await db.query("SELECT set_config('app.academy_id',$1,true),set_config('statement_timeout','5000',true),set_config('lock_timeout','2000',true),pg_advisory_xact_lock_shared(hashtextextended($1,310))",[lease.academy_id]);
   const locked=c.kind==='human'?await db.query<{valid:boolean}>('SELECT public.lock_human($1,$2) AS valid',[c.token_id,c.user_id]):await db.query<{valid:boolean}>('SELECT public.lock_bot($1) AS valid',[c.token_id]);if(!locked.rows[0]?.valid)throw new ApiError(401,'QUEUED_AUTHORIZATION_EXPIRED');
   const school=(await db.query<{status:string}>('SELECT public.effective_academy_status(status,subscription_terms) AS status FROM public.academies WHERE id=$1',[lease.academy_id])).rows[0];if(school?.status!=='active')throw new ApiError(403,'ACADEMY_UNAVAILABLE');
   if(!(await db.query('SELECT id FROM public.people WHERE id=$1 AND kind=$2 AND status=\'active\'',[c.person_id,c.kind])).rows.length)throw new ApiError(401,'QUEUED_AUTHORIZATION_EXPIRED');
   const job=(await db.query<{rule_id:string;rule_version:number;event_id:string;locale:string}>('SELECT rule_id,rule_version,event_id,locale FROM public.notification_jobs WHERE id=$1',[lease.id])).rows[0];if(!job)throw new ApiError(401,'QUEUED_AUTHORIZATION_EXPIRED');
   const request=new Request('https://internal.invalid/api/v1/automations/rules/'+job.rule_id+'/dispatch',{method:'POST',headers:{'content-type':'application/json','idempotency-key':lease.id},body:JSON.stringify({eventId:job.event_id,expectedVersion:job.rule_version,locale:job.locale})});
   const ctx:ApiContext={db,credential:c,grants:await loadGrants(db,c),request,path:'automations/rules/'+job.rule_id+'/dispatch',requestId:randomUUID(),notificationJobId:lease.id};
   if(signal?.aborted)throw new ApiError(503,'WORKER_STOPPED');const reply=await notifications(ctx);if(!reply||![200,201].includes(reply.status))throw new Error('JOB_RESULT_INVALID');runId=uuid.parse((reply.body as {data:{id:string}}).data.id);
   // Fence commit against a cancellation or replacement lease. No external IO
   // occurs, so loss of the lease can roll back every domain side effect.
   const valid=await db.query('SELECT id FROM public.notification_jobs WHERE id=$1 AND status=\'running\' AND lease_token=$2 AND lease_until>clock_timestamp() FOR UPDATE',[lease.id,lease.lease_token]);if(!valid.rows.length)throw new ApiError(409,'NOTIFICATION_LEASE_LOST');if(signal?.aborted)throw new ApiError(503,'WORKER_STOPPED');
   const finished=(await db.query<{ok:boolean}>('SELECT public.finish_notification_job($1,$2,\'succeeded\',$3,NULL) AS ok',[lease.id,lease.lease_token,runId])).rows[0]?.ok;if(!finished)throw new ApiError(409,'NOTIFICATION_LEASE_LOST');
   await db.query('COMMIT');transaction=false;return {claimed:true,recorded:true,outcome:'succeeded' as const};
  }catch(error){
   if(transaction){await db.query('ROLLBACK');transaction=false;}runId=null;
   if(error instanceof ApiError){problem=error.code;result=[400,401,403,404,409,422].includes(error.status)?'cancelled':'retry';}else problem='PROCESSING_UNAVAILABLE';
  }
  // Failure rolls back domain work before a short retry/cancellation update.
  // Success commits the job state and domain effects in the SAME transaction.
  await db.query('BEGIN');transaction=true;await db.query("SELECT set_config('app.academy_id',$1,true)",[lease.academy_id]);
  const recorded=(await db.query<{ok:boolean}>('SELECT public.finish_notification_job($1,$2,$3,$4,$5) AS ok',[lease.id,lease.lease_token,result,runId,problem])).rows[0]?.ok===true;await db.query('COMMIT');transaction=false;return {claimed:true,recorded,outcome:result};
 }catch(error){if(transaction)try{await db.query('ROLLBACK');}catch{broken=true;}throw error;}finally{db.release(broken);}
}
