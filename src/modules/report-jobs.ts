import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { jsonBody,mutation,record,type ApiContext,type Reply } from '../core/api.ts';
import { lockApprovalWrites } from '../core/approvals.ts';
import { ApiError } from '../core/policy.ts';
import { financialReportAccess } from './financial-reports.ts';
import { configuredReportContext,reportConfiguration,reportParameters } from './report-catalogue.ts';
import { financialExportParameters } from './financial-report-export.ts';

const uuid=z.string().uuid().transform(v=>v.toLowerCase()),empty=z.object({}).strict();
export const financialJobInput=z.object({reportId:z.enum(['finance.trial-balance','finance.profit-loss','finance.balance-sheet']),parameters:reportParameters}).strict();
const paging=z.object({limit:z.coerce.number().int().min(1).max(100).default(50),after:uuid.optional()}).strict();
export const reportAuthorizationContext=z.object({hubIds:z.array(uuid).max(10000).refine(a=>new Set(a).size===a.length),includesGlobal:z.boolean()}).strict();
type Job={id:string;configuration:ReturnType<typeof reportConfiguration>;status:string;attempts:number;created_at:string;finished_at:string|null;expires_at:string;last_error:string|null};
const fields='id,configuration,status,attempts,created_at,finished_at,expires_at,last_error';
async function owned(ctx:ApiContext,id:string){const j=(await ctx.db.query<Job>('SELECT '+fields+' FROM public.report_jobs WHERE id=$1 AND(requester_id=$2 OR($3::boolean AND EXISTS(SELECT 1 FROM public.academies WHERE master_person_id=$2)))',[id,ctx.credential.person_id,ctx.credential.kind==='human'])).rows[0];if(!j)throw new ApiError(404,'NOT_FOUND');return j;}
export function requireReportResultAccess(ctx:ApiContext,raw:unknown){
 const proof=reportAuthorizationContext.parse(raw),access=financialReportAccess(ctx);
 if((proof.includesGlobal&&!access.global)||proof.hubIds.some(h=>!(access.all||access.hubs.includes(h))||access.excluded.includes(h)))throw new ApiError(403,'REPORT_SOURCE_ACCESS_CHANGED');
}
export async function reportJobs(ctx:ApiContext):Promise<Reply|null>{
 const m=/^reports\/jobs(?:\/([^/]+)(?:\/(cancel|download))?)?$/.exec(ctx.path);if(!m)return null;await lockApprovalWrites(ctx);financialReportAccess(ctx);
 const params=new URL(ctx.request.url).searchParams;if([...params].length!==new Set(params.keys()).size)throw new ApiError(400,'DUPLICATE_QUERY');const q=Object.fromEntries(params),id=m[1]?uuid.parse(m[1]):null,section=m[2];
 if(ctx.request.method==='POST'){
  empty.parse(q);
  if(!id){const input=financialJobInput.parse(await jsonBody(ctx.request,131072)),configuration=reportConfiguration(input.reportId,input.parameters,{}),source=configuredReportContext(ctx,configuration),url=new URL(source.request.url);url.searchParams.delete('limit');financialExportParameters(new Request(url));
   await ctx.db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,130))',[ctx.credential.academy_id+':'+ctx.credential.person_id]);
   return mutation(ctx,configuration,async()=>{
    if((await ctx.db.query<{n:number}>("SELECT count(*)::integer n FROM public.report_jobs WHERE requester_id=$1 AND status IN('queued','running')",[ctx.credential.person_id])).rows[0].n>=20)throw new ApiError(429,'REPORT_QUEUE_FULL');
    const job=randomUUID();await record(ctx.db,ctx.credential,ctx.requestId,'report.queued',job,null,{configuration,externalRequestMade:false});
    const user=ctx.credential.kind==='human'?(await ctx.db.query<{auth_user_id:string}>('SELECT auth_user_id FROM public.people WHERE id=$1',[ctx.credential.person_id])).rows[0].auth_user_id:null;
    await ctx.db.query(`INSERT INTO public.report_jobs(academy_id,id,configuration,requester_id,requester_kind,credential_id,user_id,enqueue_request_id,audit_id) SELECT $1,$2,$3::jsonb,$4,$5,$6,$7,$8,a.id FROM public.audit_events a WHERE a.academy_id=$1 AND a.request_id=$8 AND a.action='report.queued' AND a.entity_id=$2 AND a.created_at=transaction_timestamp()`,[ctx.credential.academy_id,job,JSON.stringify(configuration),ctx.credential.person_id,ctx.credential.kind==='human'?'human':'bot',ctx.credential.token_id,user,ctx.requestId]);
    return {status:202,body:{data:await owned(ctx,job),backgroundWorkerRequired:true,resultAvailable:false,externalRequestMade:false}};
   });
  }
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
 const result=stored?{sha256:stored.sha256,bytes:stored.bytes,created_at:stored.created_at}:null;return {status:200,body:{data:j,result}};
}
export const reportJobsContract=[
 {path:'/api/v1/reports/jobs',method:'post',summary:'Queue a complete financial CSV using requester-bound current authority;20pending jobs per person,one-day execution deadline,10000entry/4MiB result ceiling and separate opt-in worker; larger outputs fail without truncation; no message or payment',schema:financialJobInput,acceptedDescription:'Report queued,not generated. Current source access is rechecked at execution and download.'},
 {path:'/api/v1/reports/jobs',method:'get',summary:'Own report-job configurations and states,or school master oversight; tenant/owner filtering precedes bounded paging',querySchema:paging},
 {path:'/api/v1/reports/jobs/{id}',method:'get',summary:'Own or school-master report-job state and current-source-authorized hash/byte metadata without credentials,leases,SQL errors or report content'},
 {path:'/api/v1/reports/jobs/{id}/cancel',method:'post',summary:'Owner or school master cancels queued/running report; final native lease fence prevents a result from a cancelled generation',schema:empty},
 {path:'/api/v1/reports/jobs/{id}/download',method:'get',summary:'Download retained complete CSV only while every captured source-hub/global context remains within current intersected account,ledger and report authority; never lends requester permissions',responseContentType:'text/csv' as const}
] as const;
