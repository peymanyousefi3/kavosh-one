import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { jsonBody,mutation,record,type ApiContext,type Reply } from '../core/api.ts';
import { lockApprovalWrites } from '../core/approvals.ts';
import { ApiError } from '../core/policy.ts';
import { financialReportAccess } from './financial-reports.ts';
import { catalogueReport,reportConfiguration,reportParameters,resolveConfiguredReportContext,type ReportConfiguration } from './report-catalogue.ts';
import { financialExportParameters } from './financial-report-export.ts';
import { executionReportPreset } from './report-presets.ts';
import { reportDateWindow } from '../core/report-window.ts';

const uuid=z.string().uuid().transform(v=>v.toLowerCase()),empty=z.object({}).strict();
export const financialJobInput=z.object({reportId:z.enum(['finance.trial-balance','finance.profit-loss','finance.balance-sheet']),parameters:reportParameters,dateWindow:reportDateWindow.optional()}).strict();
const presetQueueInput=z.object({expectedVersion:z.number().int().positive().max(2147483647),overrides:reportParameters.default({})}).strict();
const paging=z.object({limit:z.coerce.number().int().min(1).max(100).default(50),after:uuid.optional()}).strict();
export const reportAuthorizationContext=z.object({hubIds:z.array(uuid).max(10000).refine(a=>new Set(a).size===a.length),includesGlobal:z.boolean()}).strict();
type Job={id:string;configuration:ReturnType<typeof reportConfiguration>;status:string;attempts:number;created_at:string;finished_at:string|null;expires_at:string;last_error:string|null};
const fields='id,configuration,status,attempts,created_at,finished_at,expires_at,last_error,CASE WHEN preset_id IS NULL THEN NULL ELSE jsonb_build_object(\'id\',preset_id,\'version\',preset_version) END preset,window_resolution "resolvedDateWindow"';
async function owned(ctx:ApiContext,id:string){const j=(await ctx.db.query<Job>('SELECT '+fields+' FROM public.report_jobs WHERE id=$1 AND(requester_id=$2 OR($3::boolean AND EXISTS(SELECT 1 FROM public.academies WHERE master_person_id=$2)))',[id,ctx.credential.person_id,ctx.credential.kind==='human'])).rows[0];if(!j)throw new ApiError(404,'NOT_FOUND');return j;}
export function requireReportResultAccess(ctx:ApiContext,raw:unknown){
 const proof=reportAuthorizationContext.parse(raw),access=financialReportAccess(ctx);
 if((proof.includesGlobal&&!access.global)||proof.hubIds.some(h=>!(access.all||access.hubs.includes(h))||access.excluded.includes(h)))throw new ApiError(403,'REPORT_SOURCE_ACCESS_CHANGED');
}
export async function enqueueReport(ctx:ApiContext,configuration:ReportConfiguration,overrides:Record<string,string>={},preset?:{id:string;version:number},scheduledAt?:string){
 if(!catalogueReport(configuration.reportId).csv)throw new ApiError(409,'REPORT_FORMAT_NOT_AVAILABLE');
 if(preset)financialExportParameters(new Request('https://internal.invalid/?'+new URLSearchParams(overrides)));
 await ctx.db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,130))',[ctx.credential.academy_id+':'+ctx.credential.person_id]);
 // Preserve the original static-direct fingerprint. Relative/preset retries
 // fingerprint the reusable request,not dates freshly resolved after midnight.
 return mutation(ctx,preset?{preset,overrides,...(scheduledAt?{scheduledAt}:{})}:configuration,async()=>{
  if((await ctx.db.query<{n:number}>("SELECT count(*)::integer n FROM public.report_jobs WHERE requester_id=$1 AND status IN('queued','running')",[ctx.credential.person_id])).rows[0].n>=20)throw new ApiError(429,'REPORT_QUEUE_FULL');
  const {context,resolvedDateWindow}=await resolveConfiguredReportContext(ctx,configuration,overrides,scheduledAt),sourceUrl=new URL(context.request.url),check=new URL(sourceUrl);check.searchParams.delete('limit');financialExportParameters(new Request(check));
  const frozen=reportConfiguration(configuration.reportId,Object.fromEntries(sourceUrl.searchParams),configuration.pathParameters),job=randomUUID();
  await record(ctx.db,ctx.credential,ctx.requestId,'report.queued',job,null,{configuration:frozen,preset:preset??null,windowResolution:resolvedDateWindow??null,externalRequestMade:false});
  const user=ctx.credential.kind==='human'?(await ctx.db.query<{auth_user_id:string}>('SELECT auth_user_id FROM public.people WHERE id=$1',[ctx.credential.person_id])).rows[0].auth_user_id:null;
  await ctx.db.query(`INSERT INTO public.report_jobs(academy_id,id,configuration,requester_id,requester_kind,credential_id,user_id,enqueue_request_id,audit_id,preset_id,preset_version,window_resolution) SELECT $1,$2,$3::jsonb,$4,$5,$6,$7,$8,a.id,$9,$10,$11::jsonb FROM public.audit_events a WHERE a.academy_id=$1 AND a.request_id=$8 AND a.action='report.queued' AND a.entity_id=$2 AND a.created_at=transaction_timestamp()`,[ctx.credential.academy_id,job,JSON.stringify(frozen),ctx.credential.person_id,ctx.credential.kind==='human'?'human':'bot',ctx.credential.token_id,user,ctx.requestId,preset?.id??null,preset?.version??null,resolvedDateWindow?JSON.stringify(resolvedDateWindow):null]);
  return {status:202,body:{data:await owned(ctx,job),backgroundWorkerRequired:true,resultAvailable:false,externalRequestMade:false}};
 });
}
export async function reportJobs(ctx:ApiContext):Promise<Reply|null>{
 const presetPath=/^reports\/presets\/([^/]+)\/queue$/.exec(ctx.path),m=/^reports\/jobs(?:\/([^/]+)(?:\/(cancel|download))?)?$/.exec(ctx.path);if(!m&&!presetPath)return null;await lockApprovalWrites(ctx);financialReportAccess(ctx);
 if(presetPath){if(ctx.request.method!=='POST')throw new ApiError(405,'METHOD_NOT_ALLOWED');empty.parse(Object.fromEntries(new URL(ctx.request.url).searchParams));const input=presetQueueInput.parse(await jsonBody(ctx.request)),preset=await executionReportPreset(ctx,uuid.parse(presetPath[1]),input.expectedVersion);return enqueueReport(ctx,preset.definition,input.overrides,{id:preset.id,version:preset.version});}
 const params=new URL(ctx.request.url).searchParams;if([...params].length!==new Set(params.keys()).size)throw new ApiError(400,'DUPLICATE_QUERY');const q=Object.fromEntries(params),id=m![1]?uuid.parse(m![1]):null,section=m![2];
 if(ctx.request.method==='POST'){
  empty.parse(q);
  if(!id){const input=financialJobInput.parse(await jsonBody(ctx.request,131072));return enqueueReport(ctx,reportConfiguration(input.reportId,input.parameters,{},input.dateWindow));}
  if(section!=='cancel')throw new ApiError(405,'METHOD_NOT_ALLOWED');empty.parse(await jsonBody(ctx.request));await owned(ctx,id);
  return mutation(ctx,{},async()=>{const j=await owned(ctx,id);if(j.status==='cancelled')return {status:200,body:{data:j}};if(!['queued','running'].includes(j.status))throw new ApiError(409,'REPORT_JOB_FINAL');
   // No identity or policy write locks here: a running report may hold their
   // shared locks. The final lease fence serializes cancellation versus saving.
   await record(ctx.db,ctx.credential,ctx.requestId,'report.cancelled',id,null,{externalRequestMade:false});const changed=await ctx.db.query("UPDATE public.report_jobs SET status='cancelled' WHERE id=$1 AND status IN('queued','running') RETURNING id",[id]);if(!changed.rows.length)throw new ApiError(409,'REPORT_JOB_CHANGED');return {status:200,body:{data:await owned(ctx,id)}};});
 }
 if(ctx.request.method!=='GET'||section==='cancel')throw new ApiError(405,'METHOD_NOT_ALLOWED');
 if(!id){const p=paging.parse(q),rows=(await ctx.db.query<Job>('SELECT '+fields+' FROM public.report_jobs WHERE(requester_id=$1 OR($4::boolean AND EXISTS(SELECT 1 FROM public.academies WHERE master_person_id=$1))) AND($2::uuid IS NULL OR id>$2) ORDER BY id LIMIT $3',[ctx.credential.person_id,p.after??null,p.limit+1,ctx.credential.kind==='human'])).rows;return {status:200,body:{data:rows.slice(0,p.limit),nextCursor:rows.length>p.limit?rows[p.limit-1].id:null}};}
 empty.parse(q);const j=await owned(ctx,id),stored=(await ctx.db.query<{sha256:string;bytes:number;created_at:string;authorization_context:unknown}>('SELECT sha256,octet_length(body) bytes,created_at,authorization_context FROM public.report_job_results WHERE job_id=$1',[id])).rows[0];
 if(stored)requireReportResultAccess(ctx,stored.authorization_context);
 if(section==='download'){
  if(j.status!=='succeeded'||!stored)throw new ApiError(409,'REPORT_RESULT_NOT_READY');
  // Authorize the small immutable manifest before fetching potentially4MiB.
  // Fetch UTF8 bytes explicitly. Some PostgreSQL-compatible text decoders strip
  // an initial BOM; a bytea result preserves the exact retained attachment/hash.
  const r=(await ctx.db.query<{body:Uint8Array;filename:string}>("SELECT convert_to(body,'UTF8') body,filename FROM public.report_job_results WHERE job_id=$1",[id])).rows[0];if(!r)throw new ApiError(409,'REPORT_RESULT_NOT_READY');return {status:200,body:Buffer.from(r.body).toString('utf8'),csv:{filename:r.filename}};
 }
 const result=stored?{sha256:stored.sha256,bytes:stored.bytes,created_at:stored.created_at}:null,failureIssue=(await ctx.db.query('SELECT id,kind,created_at "observedAt" FROM public.report_job_issues WHERE job_id=$1',[id])).rows[0]??null;return {status:200,body:{data:j,result,failureIssue}};
}
export const reportJobsContract=[
 {path:'/api/v1/reports/presets/{id}/queue',method:'post',summary:'Queue an exact reviewed active financial CSV preset using current caller rights; freeze relative dates once at enqueue,retain provenance,ignore label-only revisions but cancel on any intervening material change; valid one-off non-page overrides do not edit saved settings',schema:presetQueueInput,acceptedDescription:'Requester-bound report queued with frozen date filters,not generated or sent.'},
 {path:'/api/v1/reports/jobs',method:'post',summary:'Queue a complete financial CSV using requester-bound current authority;20pending jobs per person,one-day execution deadline,10000entry/4MiB result ceiling and separate opt-in worker; larger outputs fail without truncation; no message or payment',schema:financialJobInput,acceptedDescription:'Report queued,not generated. Current source access is rechecked at execution and download.'},
 {path:'/api/v1/reports/jobs',method:'get',summary:'Own report-job configurations and states,or school master oversight; tenant/owner filtering precedes bounded paging',querySchema:paging},
 {path:'/api/v1/reports/jobs/{id}',method:'get',summary:'Own or school-master report-job state,current-source-authorized hash/byte metadata and native failure-observation link without credentials,leases,SQL errors or report content; reading is not retry or repair'},
 {path:'/api/v1/reports/jobs/{id}/cancel',method:'post',summary:'Owner or school master cancels queued/running report; final native lease fence prevents a result from a cancelled generation',schema:empty},
 {path:'/api/v1/reports/jobs/{id}/download',method:'get',summary:'Download retained complete CSV only while every captured source-hub/global context remains within current intersected account,ledger and report authority; never lends requester permissions',responseContentType:'text/csv' as const}
] as const;
