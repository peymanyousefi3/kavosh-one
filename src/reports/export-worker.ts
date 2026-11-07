import { randomUUID,createHash } from 'node:crypto';
import { z } from 'zod';
import { assertRuntimeRole,assertSchemaReady,type Database } from '../core/database.ts';
import { loadGrants,record,type ApiContext,type Reply } from '../core/api.ts';
import { ApiError,type Credential } from '../core/policy.ts';
import { configuredReportContext,reportConfiguration } from '../modules/report-catalogue.ts';
import { completeFinancialReport,financialReportCsv } from '../modules/financial-report-export.ts';
import { requireReportResultAccess,reportAuthorizationContext } from '../modules/report-jobs.ts';
import { executionReportPreset } from '../modules/report-presets.ts';
import { frozenReportWindow } from '../core/report-window.ts';
import { lockAcademyTopology } from '../modules/academy.ts';
import { achievementReport } from '../modules/achievement-report.ts';
import { achievementReportCsv } from '../modules/achievement-export.ts';
import { completePayrollGrossReport,payrollGrossCsv } from '../modules/payroll-gross-export.ts';

export const backgroundFinancialEntryLimit=10000;
const academies=z.array(z.string().uuid().transform(v=>v.toLowerCase())).min(1).max(1000).refine(a=>new Set(a).size===a.length);
type Lease={id:string;academy_id:string;lease_token:string};type Actor=Credential&{user_id:string|null};
// Same lease/authentication protocol as notifications,but run in a separate
// opt-in process so a report cannot monopolize the class-reminder loop.
export async function processOneReport(database:Database,allowedAcademies:string[],signal?:AbortSignal){
 const ids=academies.parse(allowedAcademies);if(signal?.aborted)return {claimed:false,recorded:false};const db=await database.connect();let transaction=false,broken=false;
 try{
  await assertRuntimeRole(db,'automation_worker');await assertSchemaReady(db);const lease=(await db.query<Lease>('SELECT * FROM public.claim_report_job($1)',[ids])).rows[0];if(!lease)return {claimed:false,recorded:false};
  let outcome:'cancelled'|'retry'='retry',problem='PROCESSING_UNAVAILABLE';
  try{
   const c=(await db.query<Actor>(`WITH scope_context AS MATERIALIZED(SELECT set_config('app.academy_id',$3,true) academy) SELECT actor.* FROM scope_context CROSS JOIN LATERAL public.report_job_actor($1,CASE WHEN scope_context.academy=$3::text THEN $2::uuid END) actor`,[lease.id,lease.lease_token,lease.academy_id])).rows[0];
   if(!c)throw new ApiError(401,'QUEUED_AUTHORIZATION_EXPIRED');if(!c.allowed)throw new ApiError(429,'RATE_LIMITED');
   await db.query('BEGIN');transaction=true;await db.query("SELECT set_config('app.academy_id',$1,true),set_config('statement_timeout','5000',true),set_config('lock_timeout','2000',true)",[lease.academy_id]);
   const valid=c.kind==='human'?await db.query<{valid:boolean}>('SELECT public.lock_human($1,$2) valid',[c.token_id,c.user_id]):await db.query<{valid:boolean}>('SELECT public.lock_bot($1) valid',[c.token_id]);if(!valid.rows[0]?.valid)throw new ApiError(401,'QUEUED_AUTHORIZATION_EXPIRED');
   const school=(await db.query<{status:string}>('SELECT status FROM public.academies WHERE id=$1',[lease.academy_id])).rows[0];if(!school||!['active','read_only'].includes(school.status))throw new ApiError(403,'ACADEMY_UNAVAILABLE');
   const job=(await db.query<{configuration:ReturnType<typeof reportConfiguration>;preset_id:string|null;preset_version:number|null;window_resolution:unknown;retry_of_job_id:string|null}>('SELECT configuration,preset_id,preset_version,window_resolution,retry_of_job_id FROM public.report_jobs WHERE id=$1',[lease.id])).rows[0];if(!job)throw new ApiError(401,'QUEUED_AUTHORIZATION_EXPIRED');
   const request=new Request('https://internal.invalid/api/v1/reports/jobs/'+lease.id),ctx:ApiContext={db,credential:c,grants:await loadGrants(db,c),request,path:'reports/jobs/'+lease.id,requestId:randomUUID()};await lockAcademyTopology(ctx);
   if(job.preset_id)await executionReportPreset(ctx,job.preset_id,job.preset_version!);
   const window=job.window_resolution?frozenReportWindow.parse(job.window_resolution):undefined,source=configuredReportContext(ctx,job.configuration),url=new URL(source.request.url);url.searchParams.delete('limit');source.request=new Request(url);
   const scheduledOccurrence=(await db.query<{scheduleId:string;dueAt:string;recordedAt:string}>(`SELECT schedule_id "scheduleId",to_char(due_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') "dueAt",to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') "recordedAt" FROM public.report_schedule_occurrences WHERE job_id=$1`,[lease.id])).rows[0];
   if(signal?.aborted)throw new ApiError(503,'WORKER_STOPPED');const provenance={id:job.preset_id??undefined,version:job.preset_version??undefined,dateWindow:window,scheduledOccurrence,retryOfJobId:job.retry_of_job_id??undefined};let file:Reply,proof:z.infer<typeof reportAuthorizationContext>;
   if(job.configuration.reportId==='community.achievements'){const reply=await achievementReport(source,true);if(!reply?.body||typeof reply.body!=='object'||!('data'in reply.body))throw new Error('ACHIEVEMENT_REPORT_INVALID');const data=reply.body.data as {authorizationContext:unknown};proof=reportAuthorizationContext.parse(data.authorizationContext);file=achievementReportCsv(data,provenance);}
   else if(job.configuration.reportId==='payroll.gross-accruals'){const data=await completePayrollGrossReport(source,backgroundFinancialEntryLimit);proof=reportAuthorizationContext.parse(data.authorizationContext);file=payrollGrossCsv(data,provenance,backgroundFinancialEntryLimit);}
   else{const data=await completeFinancialReport(source,backgroundFinancialEntryLimit);proof=reportAuthorizationContext.parse(data.authorizationContext);file=financialReportCsv(data,provenance,backgroundFinancialEntryLimit);}
   await requireReportResultAccess(source,proof);
   if(signal?.aborted)throw new ApiError(503,'WORKER_STOPPED');
   await record(db,c,ctx.requestId,'report.generated',lease.id,null,{reportId:job.configuration.reportId,sha256:createHash('sha256').update(file.body as string).digest('hex'),bytes:Buffer.byteLength(file.body as string),externalRequestMade:false});
   // Final source-policy locks remain held;cancel/replacement/expiry must still
   // win atomically against saving bytes. No external IO or messages occur.
   const saved=(await db.query<{ok:boolean}>('SELECT public.finish_report_job($1,$2,\'succeeded\',NULL,$3,$4,$5::jsonb) ok',[lease.id,lease.lease_token,file.body,file.csv!.filename,JSON.stringify(proof)])).rows[0]?.ok;
   if(!saved)throw new ApiError(409,'REPORT_LEASE_LOST');if(signal?.aborted)throw new ApiError(503,'WORKER_STOPPED');
   await db.query('COMMIT');transaction=false;return {claimed:true,recorded:true,outcome:'succeeded' as const};
  }catch(error){if(transaction){await db.query('ROLLBACK');transaction=false;}if(error instanceof ApiError){problem=['REPORT_REQUIRES_BACKGROUND_JOB','ACHIEVEMENT_REPORT_REQUIRES_BACKGROUND_JOB'].includes(error.code)?'REPORT_OUTPUT_LIMIT_EXCEEDED':error.code;outcome=[400,401,403,404,409,422].includes(error.status)?'cancelled':'retry';}}
  await db.query('BEGIN');transaction=true;await db.query("SELECT set_config('app.academy_id',$1,true)",[lease.academy_id]);const recorded=(await db.query<{ok:boolean}>('SELECT public.finish_report_job($1,$2,$3,$4,NULL,NULL,NULL) ok',[lease.id,lease.lease_token,outcome,problem])).rows[0]?.ok===true;await db.query('COMMIT');transaction=false;return {claimed:true,recorded,outcome};
 }catch(error){if(transaction)try{await db.query('ROLLBACK');}catch{broken=true;}throw error;}finally{db.release(broken);}
}
