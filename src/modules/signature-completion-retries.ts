import { z } from 'zod';
import { jsonBody,record,type ApiContext,type Reply } from '../core/api.ts';
import { propose,permissionScope,lockApprovalWrites,type ApprovalRegistry } from '../core/approvals.ts';
import { ApiError,scopeContains,type Scope } from '../core/policy.ts';
import { lockAcademyTopology } from './academy.ts';
import { permittedSignatureSend } from './signature-sends.ts';
import { permittedWorkSignatureEvidence } from './work-signature-completions.ts';
import { workEngagementScope } from './work-engagements.ts';

const uuid=z.string().uuid().transform(v=>v.toLowerCase()),purpose=z.enum(['unified_enrollment','worker_services']);
const input=z.object({expectedVersion:z.number().int().min(0).max(2147483646),checkWindowDays:z.number().int().min(1).max(30),reason:z.string().trim().min(1).max(2000).refine(v=>v.isWellFormed()&&!v.includes('\0'))}).strict();
const payload=input.extend({requestId:uuid,purpose,startId:uuid}).strict();
const empty=z.object({}).strict(),paging=z.object({afterVersion:z.coerce.number().int().min(0).max(2147483647).default(0),limit:z.coerce.number().int().min(1).max(50).default(20)}).strict();
const markers={agreementResent:false,providerRequestMade:false,admissionCleared:false,paymentCleared:false,legalExpiryChanged:false} as const;
async function authority(ctx:ApiContext,i:{requestId:string;purpose:z.infer<typeof purpose>},edit=false){
 if(i.purpose==='unified_enrollment'){
  await permittedSignatureSend(ctx,i.requestId,'signature-completions.view');
  return (await permittedSignatureSend(ctx,i.requestId,edit?'signature-completions.retry':'signature-completions.view')).scope;
 }
 const {w}=await permittedWorkSignatureEvidence(ctx,i.requestId),scope=workEngagementScope({person_id:w.worker_id,hub_id:w.hub_id});
 if(edit&&!scopeContains(permissionScope(ctx,'work-signature-completions.retry'),scope))throw new ApiError(403,'FORBIDDEN');return scope;
}
async function source(ctx:ApiContext,i:{requestId:string;purpose:z.infer<typeof purpose>;startId:string}){
 const s=(await ctx.db.query<{source:Record<string,unknown>|null}>('SELECT public.signature_completion_retry_source($1,$2) source',[i.purpose,i.startId])).rows[0]?.source;
 if(!s||s.requestId!==i.requestId)throw new ApiError(409,'SIGNATURE_COMPLETION_RETRY_NOT_READY');return s;
}
function action(work:boolean):ApprovalRegistry[string]{return {
 requestCapability:work?'work-signature-completions.retry':'signature-completions.retry',privacyCapability:work?'work-signature-completions.view':'signature-completions.view',policyChange:true,
 async validate(ctx,id,raw){await lockAcademyTopology(ctx);const i=payload.parse(raw);if(i.startId!==id||(i.purpose==='worker_services')!==work)throw new ApiError(400,'INVALID_TARGET');return authority(ctx,i,true);},
 async dependencies(ctx,_id,raw,operation){try{const i=payload.parse(raw),s=await source(ctx,i);if(s.retryVersion!==i.expectedVersion)throw new ApiError(409,'TARGET_CHANGED');return {source:s};}catch(e){if(operation==='review'&&e instanceof ApiError&&[403,404,409].includes(e.status))return {unavailable:e.code};throw e;}},
 async apply(ctx,p){
  if(ctx.credential.kind!=='human')throw new ApiError(403,'HUMAN_APPROVAL_REQUIRED');
  const i=payload.parse(p.payload),s=(p.review_context as {source:Record<string,unknown>}).source;
  try{
   const row=(await ctx.db.query('INSERT INTO public.signature_completion_retries(academy_id,purpose,start_id,version,approval_id,input,source,requested_by,changed_by) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9) RETURNING version,created_at AS "createdAt"',[ctx.credential.academy_id,i.purpose,i.startId,i.expectedVersion+1,p.id,JSON.stringify(i),JSON.stringify(s),p.requester_id,ctx.credential.person_id])).rows[0];
   if(!row)throw new ApiError(503,'SIGNATURE_COMPLETION_RETRY_NOT_RECORDED');
   await record(ctx.db,ctx.credential,ctx.requestId,p.action,i.startId,s.hubId as string|null,{retryVersion:i.expectedVersion+1,approvalId:p.id,severity:'critical',hasReason:true,checkWindowDays:i.checkWindowDays,...markers});
   return {...row,state:'queued',...markers};
  }catch(e){if(e&&typeof e==='object'&&'code'in e&&e.code==='23514')throw new ApiError(409,'SIGNATURE_COMPLETION_RETRY_CHANGED');throw e;}
 }
};}
export const signatureCompletionRetryActions:ApprovalRegistry={'signature.completion.retry':action(false),'work.signature.completion.retry':action(true)};
export async function signatureCompletionRetries(ctx:ApiContext,registry:ApprovalRegistry=signatureCompletionRetryActions):Promise<Reply|null>{
 const m=/^(payroll\/work-signature-send-requests|signature-send-requests)\/([^/]+)\/completion-check\/retries$/.exec(ctx.path);if(!m)return null;
 if(!['GET','POST'].includes(ctx.request.method))throw new ApiError(405,'METHOD_NOT_ALLOWED');
 const target={requestId:uuid.parse(m[2]),purpose:m[1].startsWith('payroll/')?'worker_services' as const:'unified_enrollment' as const},params=new URL(ctx.request.url).searchParams;
 if([...params].length!==new Set(params.keys()).size)throw new ApiError(400,'DUPLICATE_QUERY');
 const raw=Object.fromEntries(params);
 if(ctx.request.method==='POST')empty.parse(raw);
 const q=ctx.request.method==='GET'?paging.parse(raw):null;
 await lockApprovalWrites(ctx,ctx.request.method==='POST');await lockAcademyTopology(ctx);await authority(ctx,target,ctx.request.method==='POST');
 const prefix=target.purpose==='worker_services'?'work_signature':'signature';
 const start=(await ctx.db.query<{id:string}>(`SELECT s.id FROM public.${prefix}_dispatch_starts s JOIN public.${prefix}_send_attempts a ON a.academy_id=s.academy_id AND a.id=s.attempt_id WHERE a.request_id=$1`,[target.requestId])).rows[0];
 if(ctx.request.method==='POST'){
  const i=input.parse(await jsonBody(ctx.request));if(!start)throw new ApiError(409,'SIGNATURE_COMPLETION_RETRY_NOT_READY');
  return propose(ctx,registry,target.purpose==='worker_services'?'work.signature.completion.retry':'signature.completion.retry',start.id,i.expectedVersion,{...i,...target,startId:start.id});
 }
 if(!start)return {status:200,body:{data:[],nextVersion:null,...markers}};
 const rows=(await ctx.db.query<{version:number}>('SELECT version,approval_id AS "approvalId",input->>\'reason\' AS reason,(input->>\'checkWindowDays\')::integer AS "checkWindowDays",requested_by AS "requestedBy",changed_by AS "approvedBy",created_at AS "createdAt" FROM public.signature_completion_retries WHERE purpose=$1 AND start_id=$2 AND version>$3 ORDER BY version LIMIT $4',[target.purpose,start.id,q!.afterVersion,q!.limit+1])).rows;
 return {status:200,body:{data:rows.slice(0,q!.limit),nextVersion:rows.length>q!.limit?rows[q!.limit-1].version:null,...markers}};
}
export const signatureCompletionRetriesContract=['signature-send-requests','payroll/work-signature-send-requests'].flatMap(prefix=>[
 {path:'/api/v1/'+prefix+'/{id}/completion-check/retries',method:'post' as const,summary:'Version-pinned upper-approved read-only recheck of the SAME original agreement. Explicit 1–30 day operational check window only; no resend,legal expiry change,evidence approval,admission or payment clearance.',schema:input},
 {path:'/api/v1/'+prefix+'/{id}/completion-check/retries',method:'get' as const,summary:'Current evidence/source scopes protect bounded immutable agreement recheck approval history.',querySchema:paging}
]);
