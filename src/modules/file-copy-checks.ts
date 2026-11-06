import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { jsonBody,mutation,record,type ApiContext,type Reply } from '../core/api.ts';
import { lockApprovalWrites } from '../core/approvals.ts';
import { ApiError } from '../core/policy.ts';
import { lockAcademyTopology } from './academy.ts';
import { permittedFile } from './files.ts';

const uuid=z.string().uuid().transform(v=>v.toLowerCase()),input=z.object({reason:z.string().trim().min(1).max(2000).refine(v=>v.isWellFormed()&&!v.includes('\0'))}).strict();
const paging=z.object({limit:z.coerce.number().int().min(1).max(100).default(25),after:uuid.optional()}).strict(),empty=z.object({}).strict();
const fields='id,copy_id AS "copyId",requested_by AS "requestedBy",reason,requested_at::text AS "requestedAt",state,attempt_no AS "attemptCount",last_outcome AS "lastOutcome",CASE WHEN state=\'queued\' THEN available_at::text END AS "retryNotBefore"';
function view(r:Record<string,unknown>){return {...r,readOnlyCheck:true,writeRetryScheduled:false,downloadAuthorized:false,signatureReady:false,workerLiveness:'not_observed'};}
export async function fileCopyChecks(ctx:ApiContext):Promise<Reply|null>{
 const m=/^files\/([^/]+)\/copies\/([^/]+)\/reconciliations(?:\/([^/]+))?$/.exec(ctx.path);if(!m)return null;
 if(!['GET','POST'].includes(ctx.request.method)||m[3]&&ctx.request.method!=='GET')throw new ApiError(405,'METHOD_NOT_ALLOWED');
 const fileId=uuid.parse(m[1]),copyId=uuid.parse(m[2]),checkId=m[3]?uuid.parse(m[3]):null,params=new URL(ctx.request.url).searchParams;
 if([...params].length!==new Set(params.keys()).size)throw new ApiError(400,'DUPLICATE_QUERY');
 if(ctx.request.method==='POST'){
  empty.parse(Object.fromEntries(params));const i=input.parse(await jsonBody(ctx.request));await permittedFile(ctx,fileId,true,false,'files.upload');await lockApprovalWrites(ctx);await lockAcademyTopology(ctx);const f=await permittedFile(ctx,fileId,true,true,'files.upload');
  const copy=(await ctx.db.query('SELECT id,route_id,source IS NOT DISTINCT FROM public.file_copy_source(file_id,file_version,inspection_id,inspection_attempt,route_id,route_version) AS current FROM public.file_copy_requests WHERE id=$1 AND file_id=$2',[copyId,fileId])).rows[0];if(!copy)throw new ApiError(404,'NOT_FOUND');
  await ctx.db.query('SELECT id FROM public.file_storage_routes WHERE id=$1 FOR SHARE',[copy.route_id]);
  return mutation(ctx,i,async()=>{
   const pending=(await ctx.db.query('SELECT '+fields+' FROM public.file_copy_checks WHERE copy_id=$1 AND state IN(\'queued\',\'running\')',[copyId])).rows[0];if(pending)return {status:200,body:{data:view(pending)}};
   if(!copy.current||f.archived||(await ctx.db.query('SELECT state FROM public.file_copy_jobs WHERE copy_id=$1',[copyId])).rows[0]?.state!=='uncertain')throw new ApiError(409,'FILE_COPY_CHECK_NOT_READY');
   const id=randomUUID();await record(ctx.db,ctx.credential,ctx.requestId,'file.copy.reconciliation.requested',id,f.effective_hub_id,{fileId,copyId,readOnlyCheck:true,writeRetryScheduled:false,externalRequestMade:false});
   let saved:Record<string,unknown>;try{saved=(await ctx.db.query('INSERT INTO public.file_copy_checks(academy_id,id,copy_id,requested_by,audit_id,reason) SELECT $1,$2,$3,$4,a.id,$5 FROM public.audit_events a WHERE a.academy_id=$1 AND a.entity_id=$2 AND a.request_id=$6 AND a.action=\'file.copy.reconciliation.requested\' AND a.created_at=transaction_timestamp() RETURNING '+fields,[ctx.credential.academy_id,id,copyId,ctx.credential.person_id,i.reason,ctx.requestId])).rows[0];}
   catch(error){if(error&&typeof error==='object'&&'code' in error&&error.code==='23514'&&'message' in error&&error.message==='FILE_COPY_CHECK_NOT_READY')throw new ApiError(409,'FILE_COPY_CHECK_NOT_READY');throw error;}
   if(!saved)throw new ApiError(503,'FILE_COPY_CHECK_AUDIT_MISSING');return {status:202,body:{data:view(saved)}};
  });
 }
 const q=checkId?(empty.parse(Object.fromEntries(params)),null):paging.parse(Object.fromEntries(params));await lockApprovalWrites(ctx);await lockAcademyTopology(ctx);await permittedFile(ctx,fileId);
 if(!(await ctx.db.query('SELECT 1 FROM public.file_copy_requests WHERE id=$1 AND file_id=$2',[copyId,fileId])).rows.length)throw new ApiError(404,'NOT_FOUND');
 if(checkId){const r=(await ctx.db.query('SELECT '+fields+' FROM public.file_copy_checks WHERE copy_id=$1 AND id=$2',[copyId,checkId])).rows[0];if(!r)throw new ApiError(404,'NOT_FOUND');
  const attempts=(await ctx.db.query('SELECT attempt_no AS "attemptNo",outcome,sources_current AS "sourcesCurrentAtFinish",started_at::text AS "startedAt",finished_at::text AS "finishedAt",measured_bytes::float8 AS "measuredBytes" FROM public.file_copy_check_attempts WHERE check_id=$1 ORDER BY attempt_no',[checkId])).rows;return {status:200,body:{data:{...view(r),attempts}}};
 }
 const rows=(await ctx.db.query<{id:string}>('SELECT '+fields+' FROM public.file_copy_checks WHERE copy_id=$1 AND ($2::uuid IS NULL OR id>$2) ORDER BY id LIMIT $3',[copyId,q!.after??null,q!.limit+1])).rows;
 return {status:200,body:{data:rows.slice(0,q!.limit).map(view),nextCursor:rows.length>q!.limit?rows[q!.limit-1].id:null}};
}
export const fileCopyChecksContract=[
 {path:'/api/v1/files/{id}/copies/{copyId}/reconciliations',method:'post',summary:'Audited deduplicated read-only destination recovery for an uncertain exact copy under current file upload/domain rights;never schedules another physical write',schema:input,acceptedDescription:'Read-only destination check queued;no write retry,download clearance or absence finality'},
 {path:'/api/v1/files/{id}/copies/{copyId}/reconciliations',method:'get',summary:'Current file/domain-permitted bounded reconciliation request history',querySchema:paging},
 {path:'/api/v1/files/{id}/copies/{copyId}/reconciliations/{checkId}',method:'get',summary:'Current file/domain-permitted destination-check state and at most five measured attempts;no leases,worker identity,provider diagnostics or download authority'}
] as const;
