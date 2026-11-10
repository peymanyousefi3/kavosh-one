import { randomUUID } from 'node:crypto';
import { Temporal } from '@js-temporal/polyfill';
import { z } from 'zod';
import { assertRuntimeRole,assertSchemaReady,type Database } from '../core/database.ts';
import { loadGrants,record,type ApiContext } from '../core/api.ts';
import { ApiError,scopeContains,type Capability,type Credential,type Scope } from '../core/policy.ts';
import { permissionScope } from '../core/approvals.ts';
import { reportTiming,nextReportOccurrence } from '../core/report-timing.ts';
import { executionReportPreset } from '../modules/report-presets.ts';
import { reportJobAccess } from '../modules/report-job-access.ts';
import { enqueueReport } from '../modules/report-jobs.ts';
import { lockAcademyTopology } from '../modules/academy.ts';

const academies=z.array(z.string().uuid().transform(v=>v.toLowerCase())).min(1).max(1000).refine(v=>new Set(v).size===v.length);
type Lease={id:string;academy_id:string;lease_token:string};
// One DB-only occurrence;the existing independent report worker generates
// bytes. No provider,delivery,surrogate master or unbounded historical backfill.
export async function processOneReportSchedule(database:Database,allowedAcademies:string[],signal?:AbortSignal){
 const ids=academies.parse(allowedAcademies);if(signal?.aborted)return {claimed:false,recorded:false};const db=await database.connect();let transaction=false,broken=false;
 try{
  await assertRuntimeRole(db,'automation_worker');await assertSchemaReady(db);const lease=(await db.query<Lease>('SELECT * FROM public.claim_report_schedule($1)',[ids])).rows[0];if(!lease)return {claimed:false,recorded:false};
  let failure:'paused'|'retry'='retry',problem='PROCESSING_UNAVAILABLE';
  try{
   const c=(await db.query<Credential&{user_id:string|null}>('SELECT * FROM public.report_schedule_actor($1,$2,$3)',[lease.id,lease.lease_token,lease.academy_id])).rows[0];if(!c)throw new ApiError(401,'SCHEDULE_AUTHORIZATION_EXPIRED');if(!c.allowed)throw new ApiError(429,'RATE_LIMITED');
   await db.query('BEGIN');transaction=true;await db.query("SELECT set_config('app.academy_id',$1,true),set_config('statement_timeout','5000',true),set_config('lock_timeout','2000',true),pg_advisory_xact_lock_shared(hashtextextended($1,310))",[lease.academy_id]);
   const valid=c.kind==='human'?await db.query<{valid:boolean}>('SELECT public.lock_human($1,$2) valid',[c.token_id,c.user_id]):await db.query<{valid:boolean}>('SELECT public.lock_bot($1) valid',[c.token_id]);if(!valid.rows[0]?.valid)throw new ApiError(401,'SCHEDULE_AUTHORIZATION_EXPIRED');
   if((await db.query<{status:string}>('SELECT public.effective_academy_status(status,subscription_terms) AS status FROM public.academies WHERE id=$1',[lease.academy_id])).rows[0]?.status!=='active')throw new ApiError(403,'ACADEMY_UNAVAILABLE');
   const s=(await db.query<{preset_id:string;owner_scope:Scope;version:number;control_version:number;due_at:string;definition:{presetVersion:number;timing:z.infer<typeof reportTiming>}}>(`SELECT s.preset_id,s.owner_scope,s.version,s.control_version,to_char(s.next_due_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') due_at,r.definition FROM public.report_schedules s JOIN public.report_schedule_revisions r ON r.academy_id=s.academy_id AND r.schedule_id=s.id AND r.version=s.version WHERE s.id=$1`,[lease.id])).rows[0];if(!s)throw new ApiError(404,'SCHEDULE_UNAVAILABLE');
   const path='reports/presets/'+s.preset_id+'/queue',request=new Request('https://internal.invalid/api/v1/'+path,{method:'POST',headers:{'idempotency-key':randomUUID()}}),ctx:ApiContext={db,credential:c,grants:await loadGrants(db,c),request,path,requestId:randomUUID()};await lockAcademyTopology(ctx);
   const p=await executionReportPreset(ctx,s.preset_id,s.definition.presetVersion);for(const cap of ['report-schedules.view','report-schedules.edit'] as Capability[])if(!scopeContains(permissionScope(ctx,cap),s.owner_scope))throw new ApiError(403,'SCHEDULE_ACCESS_CHANGED');reportJobAccess(ctx,p.definition.reportId);
   const now=(await db.query<{instant:string}>(`SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') instant`)).rows[0].instant,timing=reportTiming.parse(s.definition.timing),due=Temporal.Instant.from(s.due_at),at=Temporal.Instant.from(now),late=Temporal.Instant.compare(at,due.add({minutes:timing.maxDelayMinutes}))>0;
   const next=nextReportOccurrence(timing,at.add({nanoseconds:1}).toString()),nextDue=next?Temporal.Instant.from(next.dueAt).toString({fractionalSecondDigits:6}):null;let jobId:string|null=null;
   if(!late){const reply=await enqueueReport(ctx,p.definition,{}, {id:p.id,version:p.version},s.due_at);if(reply.status!==202)throw new Error('SCHEDULE_QUEUE_FAILED');jobId=(reply.body as {data:{id:string}}).data.id;}
   const outcome=late?'missed':'queued';await record(db,c,ctx.requestId,'report.schedule.'+outcome,lease.id,null,{version:s.version,controlVersion:s.control_version,dueAt:s.due_at,nextDueAt:nextDue,jobId,backfillPolicy:'none',externalRequestMade:false});
   if(signal?.aborted)throw new ApiError(503,'WORKER_STOPPED');const recorded=(await db.query<{ok:boolean}>('SELECT public.finish_report_schedule($1,$2,$3,NULL,$4,$5) ok',[lease.id,lease.lease_token,outcome,nextDue,jobId])).rows[0]?.ok===true;if(!recorded)throw new ApiError(409,'SCHEDULE_LEASE_LOST');
   await db.query('COMMIT');transaction=false;return {claimed:true,recorded:true,outcome};
  }catch(error){if(transaction){await db.query('ROLLBACK');transaction=false;}if(error instanceof ApiError){problem=error.code;failure=[400,401,403,404,409,422].includes(error.status)?'paused':'retry';}}
  await db.query('BEGIN');transaction=true;await db.query("SELECT set_config('app.academy_id',$1,true)",[lease.academy_id]);const recorded=(await db.query<{ok:boolean}>('SELECT public.finish_report_schedule($1,$2,$3,$4,NULL,NULL) ok',[lease.id,lease.lease_token,failure,problem])).rows[0]?.ok===true;await db.query('COMMIT');transaction=false;return {claimed:true,recorded,outcome:failure};
 }catch(error){if(transaction)try{await db.query('ROLLBACK');}catch{broken=true;}throw error;}finally{db.release(broken);}
}
