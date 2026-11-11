import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {counterpartyReportAuthorization,requireCounterpartyReportResultAccess} from './counterparty-statement-access.ts';
import {counterpartyCaptureAuthorization,requireCounterpartyCaptureAccess} from '../reports/counterparty-capture.ts';
import { payrollCostAuthorization,requirePayrollCostResultAccess } from './payroll-cost-report.ts';
import { jsonBody,mutation,record,type ApiContext,type Reply } from '../core/api.ts';
import { lockApprovalWrites,permissionScope } from '../core/approvals.ts';
import { ApiError } from '../core/policy.ts';
import { requireFinancialReportResultAccess } from './financial-reports.ts';
import { profitabilityAuthorization,requireProfitabilityResultAccess } from './profitability-report-access.ts';
import { catalogueReport,reportConfiguration,reportParameters,reportPathParameters,resolveConfiguredReportContext,type ReportConfiguration } from './report-catalogue.ts';
import { financialExportParameters } from './financial-report-export.ts';
import { executionReportPreset } from './report-presets.ts';
import { reportDateWindow,frozenReportWindow } from '../core/report-window.ts';
import { achievementReportAuthorization,requireAchievementReportResultAccess } from './achievement-report-access.ts';
import { payrollReportAuthorization,requirePayrollReportResultAccess } from './payroll-report-access.ts';
import { payrollSettlementAuthorization,requirePayrollSettlementResultAccess } from './payroll-settlement-report.ts';
import { payrollRemittanceAuthorization,requirePayrollRemittanceResultAccess } from './payroll-remittance-report.ts';
import { paidTaxYearAuthorization,paidTaxYearConfigurationAccess,requirePaidTaxYearResultAccess } from './paid-tax-report-access.ts';
import { reportJobAccess,permittedJobReportIds } from './report-job-access.ts';
import { lockAcademyTopology } from './academy.ts';
import { performanceAuthorization,requirePerformanceResultAccess } from './student-performance-access.ts';
import { attributionAuthorization,requireAttributionResultAccess } from './financial-attribution-access.ts';
import { forecastAuthorization,requireForecastResultAccess } from './payroll-forecast-access.ts';
import { recordedWorkAuthorization,requireRecordedWorkResultAccess } from './recorded-work-access.ts';
import { pollReportForm,pollReportAuthorization,requirePollReportResultAccess } from './poll-report-access.ts';
import { cashFlowAuthorization,requireCashFlowResultAccess } from './cash-flow-report-access.ts';

const uuid=z.string().uuid().transform(v=>v.toLowerCase()),empty=z.object({}).strict();
export const financialJobInput=z.object({reportId:z.enum(['finance.cash-flow','learning.polls.by-id','payroll.recorded-time','payroll.scheduled-costs','finance.cash-movements','finance.counterparty-statement','finance.profitability','finance.manual-income-costs','payroll.costs','finance.tuition-income','finance.expense-costs','learning.student-performance','finance.trial-balance','finance.profit-loss','finance.balance-sheet','payroll.gross-accruals','community.achievements','payroll.settlements','payroll.remittances','payroll.paid-tax-year-to-date','payroll.t4-working-paper']),parameters:reportParameters,pathParameters:reportPathParameters.default({}),dateWindow:reportDateWindow.optional()}).strict();
const presetQueueInput=z.object({expectedVersion:z.number().int().positive().max(2147483647),overrides:reportParameters.default({})}).strict();
const retryInput=z.object({reason:z.string().trim().min(3).max(2000)}).strict();
const paging=z.object({limit:z.coerce.number().int().min(1).max(100).default(50),after:uuid.optional()}).strict();
const partPaging=z.object({limit:z.coerce.number().int().min(1).max(100).default(50),after:z.coerce.number().int().min(0).max(1000).default(0)}).strict();
const partNumber=z.string().regex(/^[1-9][0-9]{0,3}$/).transform(Number).refine(n=>n<=1000);
export const reportAuthorizationContext=z.union([cashFlowAuthorization,pollReportAuthorization,recordedWorkAuthorization,forecastAuthorization,counterpartyCaptureAuthorization,counterpartyReportAuthorization,profitabilityAuthorization,payrollCostAuthorization,attributionAuthorization,performanceAuthorization,z.object({hubIds:z.array(uuid).max(10000).refine(a=>new Set(a).size===a.length),includesGlobal:z.boolean()}).strict(),payrollReportAuthorization,achievementReportAuthorization,payrollSettlementAuthorization,payrollRemittanceAuthorization,paidTaxYearAuthorization]);
type Job={id:string;configuration:ReturnType<typeof reportConfiguration>;status:string;attempts:number;created_at:string;finished_at:string|null;expires_at:string;last_error:string|null;preset:{id:string;version:number}|null;resolvedDateWindow:unknown};
const fields='id,configuration,status,attempts,created_at,finished_at,expires_at,last_error,retry_of_job_id "retryOfJobId",CASE WHEN preset_id IS NULL THEN NULL ELSE jsonb_build_object(\'id\',preset_id,\'version\',preset_version) END preset,window_resolution "resolvedDateWindow"';
async function owned(ctx:ApiContext,id:string){const j=(await ctx.db.query<Job>('SELECT '+fields+' FROM public.report_jobs WHERE id=$1 AND(requester_id=$2 OR($3::boolean AND EXISTS(SELECT 1 FROM public.academies WHERE master_person_id=$2)))',[id,ctx.credential.person_id,ctx.credential.kind==='human'])).rows[0];if(!j)throw new ApiError(404,'NOT_FOUND');reportJobAccess(ctx,j.configuration.reportId);await paidTaxYearConfigurationAccess(ctx,j.configuration);return j;}
export async function requireReportResultAccess(ctx:ApiContext,raw:unknown){
 await lockAcademyTopology(ctx);
 if(raw&&typeof raw==='object'&&'kind'in raw&&raw.kind==='classified_cash')return requireCashFlowResultAccess(ctx,raw);
 if(raw&&typeof raw==='object'&&'kind'in raw&&raw.kind==='poll_aggregate')return requirePollReportResultAccess(ctx,raw);
 if(raw&&typeof raw==='object'&&'kind'in raw&&raw.kind==='recorded_hourly')return requireRecordedWorkResultAccess(ctx,raw);
 if(raw&&typeof raw==='object'&&'kind'in raw&&raw.kind==='scheduled_payroll')return requireForecastResultAccess(ctx,raw);
 if(raw&&typeof raw==='object'&&'kind'in raw&&raw.kind==='counterparty_capture')return requireCounterpartyCaptureAccess(ctx,raw);
 if(raw&&typeof raw==='object'&&'kind'in raw&&raw.kind==='counterparty_statement')return requireCounterpartyReportResultAccess(ctx,raw);
 if(raw&&typeof raw==='object'&&'kind'in raw&&raw.kind==='academy_profitability')return requireProfitabilityResultAccess(ctx,raw);
 if(raw&&typeof raw==='object'&&'kind'in raw&&(raw.kind==='payroll_cost'||raw.kind==='allocated_payroll_cost'))return requirePayrollCostResultAccess(ctx,raw);
 if(raw&&typeof raw==='object'&&'kind'in raw&&(raw.kind==='manual_journal_attribution'||raw.kind==='tuition_attribution'||raw.kind==='expense_attribution'||raw.kind==='allocated_expense_attribution'))return requireAttributionResultAccess(ctx,raw);
 if(raw&&typeof raw==='object'&&'kind'in raw&&raw.kind==='student_performance')return requirePerformanceResultAccess(ctx,raw);
 const proof=reportAuthorizationContext.parse(raw);if('kind'in proof)return proof.kind==='counterparty_statement'?requireCounterpartyReportResultAccess(ctx,proof):proof.kind==='academy_profitability'?requireProfitabilityResultAccess(ctx,proof):proof.kind==='paid_tax_year'?requirePaidTaxYearResultAccess(ctx,proof):proof.kind==='achievement_summary'?requireAchievementReportResultAccess(ctx,proof):proof.kind==='payroll_remittance'?requirePayrollRemittanceResultAccess(ctx,proof):proof.kind==='payroll_settlement'?requirePayrollSettlementResultAccess(ctx,proof):requirePayrollReportResultAccess(ctx,proof);requireFinancialReportResultAccess(ctx,proof);

}
export async function enqueueReport(ctx:ApiContext,configuration:ReportConfiguration,overrides:Record<string,string>={},preset?:{id:string;version:number},scheduledAt?:string,retry?:{id:string;reason:string;window:unknown}){
 if(!catalogueReport(configuration.reportId).backgroundCsv)throw new ApiError(409,'REPORT_FORMAT_NOT_AVAILABLE');
 reportJobAccess(ctx,configuration.reportId);
 await paidTaxYearConfigurationAccess(ctx,configuration);
 if(preset)financialExportParameters(new Request('https://internal.invalid/?'+new URLSearchParams(overrides)));
 await ctx.db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,130))',[ctx.credential.academy_id+':'+ctx.credential.person_id]);
 // Preserve the original static-direct fingerprint. Relative/preset retries
 // fingerprint the reusable request,not dates freshly resolved after midnight.
 return mutation(ctx,retry?{retryOfJobId:retry.id,reason:retry.reason}:preset?{preset,overrides,...(scheduledAt?{scheduledAt}:{})}:configuration,async()=>{
  if(retry&&(await ctx.db.query('SELECT id FROM public.report_jobs WHERE retry_of_job_id=$1',[retry.id])).rows.length)throw new ApiError(409,'REPORT_JOB_ALREADY_RETRIED');
  if((await ctx.db.query<{n:number}>("SELECT count(*)::integer n FROM public.report_jobs WHERE requester_id=$1 AND status IN('queued','running')",[ctx.credential.person_id])).rows[0].n>=20)throw new ApiError(429,'REPORT_QUEUE_FULL');
  const resolved=await resolveConfiguredReportContext(ctx,configuration,overrides,scheduledAt),context=resolved.context,resolvedDateWindow=retry?(retry.window?frozenReportWindow.parse(retry.window):undefined):resolved.resolvedDateWindow,sourceUrl=new URL(context.request.url),check=new URL(sourceUrl);check.searchParams.delete('limit');financialExportParameters(new Request(check));
  const frozen=reportConfiguration(configuration.reportId,Object.fromEntries(sourceUrl.searchParams),configuration.pathParameters);if(frozen.reportId==='learning.polls.by-id'){const form=await pollReportForm(ctx,uuid.parse(frozen.pathParameters.id),frozen.parameters.formVersion?Number(frozen.parameters.formVersion):undefined);frozen.parameters.formVersion=String(form.form_version);}const job=randomUUID();
  await record(ctx.db,ctx.credential,ctx.requestId,'report.queued',job,null,{configuration:frozen,preset:preset??null,windowResolution:resolvedDateWindow??null,...(retry?{retryOfJobId:retry.id,retryReason:retry.reason}:{}),externalRequestMade:false});
  const user=ctx.credential.kind==='human'?(await ctx.db.query<{auth_user_id:string}>('SELECT auth_user_id FROM public.people WHERE id=$1',[ctx.credential.person_id])).rows[0].auth_user_id:null;
  await ctx.db.query(`INSERT INTO public.report_jobs(academy_id,id,configuration,requester_id,requester_kind,credential_id,user_id,enqueue_request_id,audit_id,preset_id,preset_version,window_resolution,retry_of_job_id) SELECT $1,$2,$3::jsonb,$4,$5,$6,$7,$8,a.id,$9,$10,$11::jsonb,$12 FROM public.audit_events a WHERE a.academy_id=$1 AND a.request_id=$8 AND a.action='report.queued' AND a.entity_id=$2 AND a.created_at=transaction_timestamp()`,[ctx.credential.academy_id,job,JSON.stringify(frozen),ctx.credential.person_id,ctx.credential.kind==='human'?'human':'bot',ctx.credential.token_id,user,ctx.requestId,preset?.id??null,preset?.version??null,resolvedDateWindow?JSON.stringify(resolvedDateWindow):null,retry?.id??null]);
  return {status:202,body:{data:await owned(ctx,job),backgroundWorkerRequired:true,resultAvailable:false,externalRequestMade:false}};
 });
}
export async function reportJobs(ctx:ApiContext):Promise<Reply|null>{
 const presetPath=/^reports\/presets\/([^/]+)\/queue$/.exec(ctx.path),partsPath=/^reports\/jobs\/([^/]+)\/parts(?:\/([^/]+)\/download)?$/.exec(ctx.path),m=/^reports\/jobs(?:\/([^/]+)(?:\/(cancel|download|retry))?)?$/.exec(ctx.path);if(!m&&!presetPath&&!partsPath)return null;await lockApprovalWrites(ctx);
 if(presetPath){if(ctx.request.method!=='POST')throw new ApiError(405,'METHOD_NOT_ALLOWED');empty.parse(Object.fromEntries(new URL(ctx.request.url).searchParams));const input=presetQueueInput.parse(await jsonBody(ctx.request)),preset=await executionReportPreset(ctx,uuid.parse(presetPath[1]),input.expectedVersion);return enqueueReport(ctx,preset.definition,input.overrides,{id:preset.id,version:preset.version});}
 const params=new URL(ctx.request.url).searchParams;if([...params].length!==new Set(params.keys()).size)throw new ApiError(400,'DUPLICATE_QUERY');const q=Object.fromEntries(params),id=partsPath?uuid.parse(partsPath[1]):m![1]?uuid.parse(m![1]):null,section=partsPath?'parts':m![2];
 if(ctx.request.method==='POST'){
  empty.parse(q);
  if(!id){const input=financialJobInput.parse(await jsonBody(ctx.request,131072));return enqueueReport(ctx,reportConfiguration(input.reportId,input.parameters,input.pathParameters,input.dateWindow));}
  if(section==='retry'){
   const input=retryInput.parse(await jsonBody(ctx.request)),old=await owned(ctx,id);if(!['failed','cancelled'].includes(old.status)||old.last_error==='CANCELLED_BY_REQUEST')throw new ApiError(409,'REPORT_JOB_NOT_RETRYABLE');
   if(old.preset)await executionReportPreset(ctx,old.preset.id,old.preset.version);
   return enqueueReport(ctx,old.configuration,{},old.preset??undefined,undefined,{id,reason:input.reason,window:old.resolvedDateWindow});
  }
  if(section!=='cancel')throw new ApiError(405,'METHOD_NOT_ALLOWED');empty.parse(await jsonBody(ctx.request));await owned(ctx,id);
  return mutation(ctx,{},async()=>{const j=await owned(ctx,id);if(j.status==='cancelled')return {status:200,body:{data:j}};if(!['queued','running'].includes(j.status))throw new ApiError(409,'REPORT_JOB_FINAL');
   // No identity or policy write locks here: a running report may hold their
   // shared locks. The final lease fence serializes cancellation versus saving.
   await record(ctx.db,ctx.credential,ctx.requestId,'report.cancelled',id,null,{externalRequestMade:false});const changed=await ctx.db.query("UPDATE public.report_jobs SET status='cancelled' WHERE id=$1 AND status IN('queued','running') RETURNING id",[id]);if(!changed.rows.length)throw new ApiError(409,'REPORT_JOB_CHANGED');return {status:200,body:{data:await owned(ctx,id)}};});
 }
 if(ctx.request.method!=='GET'||section==='cancel'||section==='retry')throw new ApiError(405,'METHOD_NOT_ALLOWED');
 if(!id){const p=paging.parse(q),allowed=permittedJobReportIds(ctx),rows=(await ctx.db.query<Job>(`SELECT ${fields} FROM public.report_jobs WHERE configuration->>'reportId'=ANY($5::text[]) AND(requester_id=$1 OR($4::boolean AND EXISTS(SELECT 1 FROM public.academies WHERE master_person_id=$1)))
 AND(configuration->>'reportId' NOT IN('payroll.paid-tax-year-to-date','payroll.t4-working-paper') OR($6::boolean AND EXISTS(SELECT 1 FROM public.payroll_tax_profiles t WHERE t.id::text=configuration#>>'{parameters,profileId}' AND public.work_scope_allows($7::jsonb,NULL,t.person_id))))
 AND($2::uuid IS NULL OR id>$2) ORDER BY id LIMIT $3`,[ctx.credential.person_id,p.after??null,p.limit+1,ctx.credential.kind==='human',allowed,ctx.credential.all_hubs,JSON.stringify(permissionScope(ctx,'payroll-tax.view'))])).rows;return {status:200,body:{data:rows.slice(0,p.limit),nextCursor:rows.length>p.limit?rows[p.limit-1].id:null}};}
 const page=partsPath&&!partsPath[2]?partPaging.parse(q):undefined;if(!page)empty.parse(q);const number=partsPath?.[2]?partNumber.parse(partsPath[2]):undefined,j=await owned(ctx,id),stored=(await ctx.db.query<{sha256:string;bytes:number;created_at:string;authorization_context:unknown;filename:string;multipart:null|{version:1;format:'ordered_csv_byte_parts';partCount:number;totalBytes:number;renderedRecords:number}}>('SELECT sha256,octet_length(body) bytes,created_at,authorization_context,filename,multipart FROM public.report_job_results WHERE job_id=$1',[id])).rows[0];
 if(stored)await requireReportResultAccess(ctx,stored.authorization_context);
 if(section==='parts'){
  if(j.status!=='succeeded'||!stored)throw new ApiError(409,'REPORT_RESULT_NOT_READY');if(!stored.multipart)throw new ApiError(409,'REPORT_RESULT_IS_SINGLE_FILE');
  if(number!==undefined){const r=(await ctx.db.query<{body:Uint8Array}>("SELECT convert_to(body,'UTF8') body FROM public.report_job_parts WHERE job_id=$1 AND part_no=$2",[id,number])).rows[0];if(!r)throw new ApiError(404,'NOT_FOUND');return {status:200,body:Buffer.from(r.body).toString('utf8'),csv:{filename:stored.filename.replace(/\.csv$/,'.part-'+String(number).padStart(5,'0')+'.csv')}};}
  const rows=(await ctx.db.query<{part:number;bytes:number;sha256:string}>('SELECT part_no part,octet_length(body) bytes,sha256 FROM public.report_job_parts WHERE job_id=$1 AND part_no>$2 ORDER BY part_no LIMIT $3',[id,page!.after,page!.limit+1])).rows;
  return {status:200,body:{data:rows.slice(0,page!.limit).map(r=>({...r,downloadPath:'/api/v1/reports/jobs/'+id+'/parts/'+r.part+'/download'})),nextCursor:rows.length>page!.limit?rows[page!.limit-1].part:null,filename:stored.filename,assembly:'concatenate_original_UTF8_bytes_in_ascending_part_order',...stored.multipart}};
 }
 if(section==='download'){
  if(j.status!=='succeeded'||!stored)throw new ApiError(409,'REPORT_RESULT_NOT_READY');
  if(stored.multipart)return {status:409,body:{error:{code:'REPORT_MULTIPART_DOWNLOAD_REQUIRED'},partsPath:'/api/v1/reports/jobs/'+id+'/parts'}};
  // Authorize the small immutable manifest before fetching potentially4MiB.
  // Fetch UTF8 bytes explicitly. Some PostgreSQL-compatible text decoders strip
  // an initial BOM; a bytea result preserves the exact retained attachment/hash.
  const r=(await ctx.db.query<{body:Uint8Array;filename:string}>("SELECT convert_to(body,'UTF8') body,filename FROM public.report_job_results WHERE job_id=$1",[id])).rows[0];if(!r)throw new ApiError(409,'REPORT_RESULT_NOT_READY');return {status:200,body:Buffer.from(r.body).toString('utf8'),csv:{filename:r.filename}};
 }
 const result=stored?(stored.multipart?{...stored.multipart,filename:stored.filename,index:{sha256:stored.sha256,bytes:stored.bytes},partsPath:'/api/v1/reports/jobs/'+id+'/parts',created_at:stored.created_at}:{sha256:stored.sha256,bytes:stored.bytes,created_at:stored.created_at}):null,failureIssue=(await ctx.db.query('SELECT id,kind,created_at "observedAt" FROM public.report_job_issues WHERE job_id=$1',[id])).rows[0]??null;return {status:200,body:{data:j,result,failureIssue}};
}
export const reportJobsContract=[
 {path:'/api/v1/reports/jobs/{id}/parts',method:'get',summary:'Current-source-authorized ordered CSV byte-part directory for completed large counterparty reports;owner or school master only. Bounded paging,per-part original-byte hashes,logical filename and total bytes. Concatenate bytes in ascending part order;only first part has BOM/header. Pending,cancelled,foreign or newly forbidden results expose no part metadata.',querySchema:partPaging},
 {path:'/api/v1/reports/jobs/{id}/parts/{part}/download',method:'get',summary:'Download one immutable UTF8 byte segment of a completed large counterparty CSV after the same owner,tenant and whole-original/current-source checks as its directory. Not a standalone full report. Existing ordinary download refuses multipart results instead of returning an index or partial data.',responseContentType:'text/csv' as const,pathSchemas:{part:z.number().int().min(1).max(1000)}},
 {path:'/api/v1/reports/presets/{id}/queue',method:'post',summary:'Queue an exact reviewed active recorded-hour,scheduled-payroll,financial,gross-payroll,net-settlement,liability-remittance,private paid-tax-year or achievement CSV preset using current caller rights; freeze relative dates once at enqueue,retain provenance,ignore label-only revisions but cancel on any intervening material change; valid one-off non-page overrides do not edit saved settings',schema:presetQueueInput,acceptedDescription:'Requester-bound report queued with frozen date filters,not generated or sent.'},
 {path:'/api/v1/reports/jobs',method:'post',summary:'Queue reviewed direct cash-flow reports(up to10000cash accounts/4MiB,retained original full classification scope,exact chart/category bridge and current access checks),poll aggregates(up to100000response heads/10000student-class-hub contexts;pathParameters.id required;exact question form pinned at enqueue,no written answers),recorded-hour reports(up to2000time entries/10000terms/2000priced intervals,200priced intervals/person across currencies,10000output rows/4MiB,366civil days),scheduled payroll forecasts(up to1000engagements/10000terms/2000assignments/2000sessions;200hourly intervals/person/currency,2000total intervals,200000salary-reference calendar days,366civil days,10000detail rows/4MiB),or a complete cash-movement bridge(up to10000cash accounts/4MiB with original full-scope proof and existing date/chart limits),counterparty-statement (up to200000 source and window events,10000 bills;larger than10000events or4MiB uses resumable250record/1MiB ordered CSV byte parts with exact original membership retained),manual-income/cost,payroll-cost/tuition-income/expense-cost attribution,performance,financial,gross-payroll,net-settlement,liability-remittance,private paid-tax-year or achievement CSV using requester-bound current authority.20pending jobs/person,one-day execution deadline and4MiB single-file ceiling;counterparty multipart results expose a protected ordered parts directory,never a partial ordinary download. Attribution keeps existing10000source-event/10000chart-group bounds;expense100000cost-line events. Other original report bounds remain. Larger outputs fail without truncation;separate opt-in worker,no message or payment.',schema:financialJobInput,acceptedDescription:'Report queued,not generated. Current source access is rechecked at execution and download.'},
 {path:'/api/v1/reports/jobs',method:'get',summary:'Own report-job configurations and states,or school master oversight; tenant/owner and private paid-tax-profile filtering precede bounded paging',querySchema:paging},
 {path:'/api/v1/reports/jobs/{id}',method:'get',summary:'Own or school-master report-job state,current-source-authorized hash/byte metadata and native failure-observation link without credentials,leases,SQL errors or report content; reading is not retry or repair'},
 {path:'/api/v1/reports/jobs/{id}/cancel',method:'post',summary:'Owner or school master cancels queued/running report; final native lease fence prevents a result from a cancelled generation',schema:empty},
 {path:'/api/v1/reports/jobs/{id}/retry',method:'post',summary:'Owner or school master creates one new requester-bound recovery job for a failed/non-intentional-cancelled job; preserve frozen dates,preset provenance and original failure;current permissions/preset checks apply,never reuse another credential or restart the schedule',schema:retryInput,acceptedDescription:'New recovery job queued;original failure and issue remain unchanged. A failed recovery may itself be retried.'},
 {path:'/api/v1/reports/jobs/{id}/download',method:'get',summary:'Download retained complete CSV only under current source rights,including the full captured cash-report source scope;new postings never recalculate retained cash balances. Counterparty files require every original event to remain in the same dated frame plus whole current source permissions;new money does not retarget retained bytes or hashes. Tuition attribution rechecks every captured invoice and recognition mapped account;expense attribution rechecks every original bill context and journal account,not only filtered lines. Reviewed files also recheck every pinned expense-allocation revision target with current class and student permissions;new revisions never retarget old files. Payroll cost files recheck every captured original work,whole-class,tuition invoice and mapped-account source. Other financial/payroll/achievement/performance manifests retain their own source boundaries. Authorize before bytes or hash metadata;never lend requester or creator permissions.',responseContentType:'text/csv' as const}
] as const;
