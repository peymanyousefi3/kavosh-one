import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { jsonBody,mutation,record,type ApiContext,type Reply } from '../core/api.ts';
import { propose,permissionScope,approvalReadParameters,lockApprovalWrites,type ApprovalRegistry,type Proposal } from '../core/approvals.ts';
import { ApiError,scopeContains,type Capability } from '../core/policy.ts';
import { lockAcademyTopology } from './academy.ts';
import { currentAgreementPackage,permittedAgreementPackage,authorizeAgreementPackageReviewer } from './agreement-packages.ts';
import { permittedAgreementContent } from './agreement-content.ts';
import { boldSignRequestOptions } from '../integrations/boldsign-send-request.ts';

const uuid=z.string().uuid().transform(v=>v.toLowerCase()),hash=z.string().regex(/^[a-f0-9]{64}$/),reason=z.string().trim().min(1).max(2000).refine(v=>v.isWellFormed()&&!v.includes('\0'));
const input=z.object({attachmentId:uuid,priorId:uuid.nullable().default(null),options:boldSignRequestOptions,dispatchWithinMinutes:z.number().int().min(1).max(1440),reason}).strict();
const requestPayload=input.extend({packageId:uuid}),cancelInput=z.object({reason}).strict(),cancelPayload=cancelInput.extend({requestId:uuid});
const attemptInput=z.object({requestSha256:hash,requestBytes:z.number().int().min(1).max(16_777_216),documentSha256:hash}).strict();
const paging=z.object({limit:z.coerce.number().int().min(1).max(100).default(50),after:uuid.optional()}).strict(),empty=z.object({}).strict();
type SendRow={id:string;package_id:string;attachment_id:string;prior_id:string|null;options:unknown;context:unknown;approval_id:string;cancellation_id:string|null;attempt_id:string|null;successor_id:string|null;expired:boolean}&Record<string,unknown>;
const fields=`r.*,c.id AS cancellation_id,a.id AS attempt_id,s.id AS successor_id,d.id AS dispatch_id,o.state AS dispatch_observation,r.authorization_until<=clock_timestamp() AS expired`;
const from=`public.signature_send_requests r LEFT JOIN public.signature_send_cancellations c ON c.academy_id=r.academy_id AND c.request_id=r.id LEFT JOIN public.signature_send_attempts a ON a.academy_id=r.academy_id AND a.request_id=r.id LEFT JOIN public.signature_send_requests s ON s.academy_id=r.academy_id AND s.prior_id=r.id LEFT JOIN public.signature_dispatch_starts d ON d.academy_id=a.academy_id AND d.attempt_id=a.id LEFT JOIN public.signature_dispatch_outcomes o ON o.academy_id=d.academy_id AND o.start_id=d.id`;
function view(r:SendRow){return {...r,state:r.successor_id?'superseded':r.cancellation_id?'cancelled':r.dispatch_id?r.dispatch_observation??'started_outcome_unrecorded':r.attempt_id?'attempt_reserved':r.expired?'expired':'approved',readyToSend:false,deliveryVerified:false,admissionCleared:false};}
async function authority(ctx:ApiContext,id:string,cap:Capability='signature-sends.view') {
 const p=await permittedAgreementPackage(ctx,id,cap!=='signature-sends.view');
 const people=(await ctx.db.query<{id:string;hub_id:string|null}>('SELECT id,hub_id FROM public.people WHERE id=ANY($1::uuid[]) ORDER BY id',[[p.student_id,p.signer_id]])).rows;
 const scope={all:false,hubs:[],classes:[{id:p.class_id,hubId:p.hub_id}],people:people.map(p=>({id:p.id,hubId:p.hub_id}))};
 for(const selected of ['signature-sends.view',cap] as Capability[])if(!scopeContains(permissionScope(ctx,selected),scope))throw new ApiError(404,'NOT_FOUND');
 return {p,scope};
}
export async function permittedSignatureSend(ctx:ApiContext,id:string,cap:Capability='signature-sends.view') {
 const r=(await ctx.db.query<SendRow>('SELECT '+fields+' FROM '+from+' WHERE r.id=$1',[id])).rows[0];if(!r)throw new ApiError(404,'NOT_FOUND');
 const allowed=await authority(ctx,r.package_id,cap);return {r,...allowed};
}
const row=permittedSignatureSend;
async function requestBasis(ctx:ApiContext,i:z.infer<typeof requestPayload>) {
 await authority(ctx,i.packageId,'signature-sends.edit');const {row:p}=await currentAgreementPackage(ctx,i.packageId);
 const l=(await ctx.db.query<{binding_id:string}>('SELECT binding_id FROM public.agreement_package_contents WHERE id=$1 AND package_id=$2',[i.attachmentId,p.id])).rows[0];if(!l)throw new ApiError(404,'NOT_FOUND');
 await permittedAgreementContent(ctx,l.binding_id);
 const source=(await ctx.db.query<{source:unknown}>('SELECT public.signature_send_request_source($1,$2,$3) AS source',[i.packageId,i.attachmentId,i.priorId])).rows[0].source;
 if(!source)throw new ApiError(409,'SIGNATURE_SEND_NOT_READY');return {source};
}
async function cancelBasis(ctx:ApiContext,id:string) {
 await row(ctx,id,'signature-sends.edit');const result=(await ctx.db.query<{source:Record<string,unknown>|null}>('SELECT public.signature_send_cancel_source($1) AS source',[id])).rows[0].source;
 if(!result)throw new ApiError(409,'SIGNATURE_SEND_CANNOT_CANCEL');return result;
}
async function apply(ctx:ApiContext,p:Proposal) {
 if(ctx.credential.kind!=='human')throw new ApiError(403,'HUMAN_REVIEW_REQUIRED');
 const cancelling=p.action==='signature.send.cancel';let result:{id:string;hub_id:string}&Record<string,unknown>;
 try{
  if(cancelling){const i=cancelPayload.parse(p.payload);result=(await ctx.db.query<{id:string;hub_id:string}&Record<string,unknown>>(`INSERT INTO public.signature_send_cancellations(academy_id,id,request_id,created_by,approval_id,reason) VALUES($1,$2,$3,$4,$5,$6)
   RETURNING id,request_id,(SELECT p.hub_id FROM public.signature_send_requests r JOIN public.agreement_packages p ON p.academy_id=r.academy_id AND p.id=r.package_id WHERE r.id=signature_send_cancellations.request_id) hub_id`,[ctx.credential.academy_id,p.target_id,i.requestId,ctx.credential.person_id,p.id,i.reason])).rows[0];}
  else{const i=requestPayload.parse(p.payload);result=(await ctx.db.query<{id:string;hub_id:string}&Record<string,unknown>>(`INSERT INTO public.signature_send_requests(academy_id,id,package_id,attachment_id,prior_id,options,dispatch_within_minutes,context,created_by,approval_id,reason)
   VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8::jsonb,$9,$10,$11) RETURNING id,package_id,attachment_id,authorization_until,(SELECT hub_id FROM public.agreement_packages WHERE id=signature_send_requests.package_id) hub_id`,[ctx.credential.academy_id,p.target_id,i.packageId,i.attachmentId,i.priorId,JSON.stringify(i.options),i.dispatchWithinMinutes,JSON.stringify(p.review_context),ctx.credential.person_id,p.id,i.reason])).rows[0];}
 }catch(error){if(error&&typeof error==='object'&&'code' in error&&error.code==='23514'&&'message' in error&&error.message==='SIGNATURE_SEND_EXACT_APPROVAL_REQUIRED')throw new ApiError(409,'SIGNATURE_SEND_SOURCE_CHANGED');throw error;}
 await record(ctx.db,ctx.credential,ctx.requestId,p.action,p.target_id,result.hub_id,{severity:'critical',hasReason:true,externalRequestMade:false});
 return {...result,state:cancelling?'cancelled':'approved',externalRequestMade:false,readyToSend:false,admissionCleared:false};
}
export const signatureSendActions:ApprovalRegistry=Object.fromEntries(['signature.send.request','signature.send.cancel'].map(action=>[action,{
 requestCapability:'signature-sends.edit',privacyCapability:'signature-sends.view',policyChange:true,createdStatus:201,
 async validate(ctx:ApiContext,_id:string,raw:unknown){await lockAcademyTopology(ctx);if(action==='signature.send.request')return(await authority(ctx,requestPayload.parse(raw).packageId,'signature-sends.edit')).scope;return(await row(ctx,cancelPayload.parse(raw).requestId,'signature-sends.edit')).scope;},
 async dependencies(ctx:ApiContext,_id:string,raw:unknown,purpose:'request'|'review'){try{return action==='signature.send.request'?await requestBasis(ctx,requestPayload.parse(raw)):await cancelBasis(ctx,cancelPayload.parse(raw).requestId);}catch(error){if(purpose==='review'&&error instanceof ApiError&&[403,404,409].includes(error.status))return {unavailable:error.code};throw error;}},
 async authorizeReviewer(ctx:ApiContext,p:Proposal){const packageId=action==='signature.send.request'?requestPayload.parse(p.payload).packageId:(await row(ctx,cancelPayload.parse(p.payload).requestId)).r.package_id;const pkg=await permittedAgreementPackage(ctx,packageId);await authorizeAgreementPackageReviewer(ctx,{enrollmentId:pkg.enrollment_id,templateId:pkg.template_id,signerId:pkg.signer_id});},apply
}])) as ApprovalRegistry;
export async function signatureSends(ctx:ApiContext,registry:ApprovalRegistry=signatureSendActions):Promise<Reply|null> {
 const collection=/^agreement-packages\/([^/]+)\/send-requests$/.exec(ctx.path),item=/^signature-send-requests\/([^/]+)(?:\/(cancel|attempts))?$/.exec(ctx.path);if(!collection&&!item)return null;
 const params=Object.fromEntries(new URL(ctx.request.url).searchParams);
 if(collection){const packageId=uuid.parse(collection[1]);
  if(ctx.request.method==='POST'){empty.parse(params);return propose(ctx,registry,'signature.send.request',null,0,{...input.parse(await jsonBody(ctx.request,32768)),packageId});}
  if(ctx.request.method!=='GET')throw new ApiError(405,'METHOD_NOT_ALLOWED');const q=paging.parse(params);await authority(ctx,packageId);const scopes=(await approvalReadParameters(ctx))[4];
  const rows=(await ctx.db.query<SendRow>('SELECT '+fields+' FROM '+from+' JOIN public.approval_requests p ON p.academy_id=r.academy_id AND p.id=r.approval_id WHERE r.package_id=$1 AND public.approval_bindings_allow(p.privacy_bindings,$2::jsonb) AND($3::uuid IS NULL OR r.id>$3) ORDER BY r.id LIMIT $4',[packageId,scopes,q.after??null,q.limit+1])).rows;
  return {status:200,body:{data:rows.slice(0,q.limit).map(({context,options,reason,...r})=>view(r as SendRow)),nextCursor:rows.length>q.limit?rows[q.limit-1].id:null}};
 }
 empty.parse(params);const id=uuid.parse(item![1]),section=item![2];
 if(section==='cancel'){if(ctx.request.method!=='POST')throw new ApiError(405,'METHOD_NOT_ALLOWED');return propose(ctx,registry,'signature.send.cancel',null,0,{...cancelInput.parse(await jsonBody(ctx.request)),requestId:id});}
 if(section==='attempts'&&ctx.request.method==='POST'){
  const i=attemptInput.parse(await jsonBody(ctx.request));await lockApprovalWrites(ctx,true);await lockAcademyTopology(ctx);await row(ctx,id,'signature-sends.execute');
  await ctx.db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,25))',[ctx.credential.academy_id+':'+id]);
  return mutation(ctx,i,async()=>{
   if((await ctx.db.query('SELECT 1 FROM public.signature_send_attempts WHERE request_id=$1',[id])).rows.length)throw new ApiError(409,'SIGNATURE_ATTEMPT_ALREADY_RESERVED');
   if(!(await ctx.db.query<{valid:boolean}>('SELECT public.signature_send_current($1) valid',[id])).rows[0].valid)throw new ApiError(409,'SIGNATURE_SEND_NOT_CURRENT');
   const attemptId=randomUUID(),{p}=await row(ctx,id,'signature-sends.execute');await record(ctx.db,ctx.credential,ctx.requestId,'signature.send.attempt_reserved',attemptId,p.hub_id,{requestId:id,severity:'critical',externalRequestMade:false});
   let result:Record<string,unknown>;try{result=(await ctx.db.query(`INSERT INTO public.signature_send_attempts(academy_id,id,request_id,actor_id,audit_id,request_sha256,request_bytes,document_sha256)
    SELECT $1,$2,$3,$4,a.id,$5,$6,$7 FROM public.audit_events a WHERE a.academy_id=$1 AND a.request_id=$8 AND a.entity_id=$2 AND a.action='signature.send.attempt_reserved' AND a.created_at=transaction_timestamp()
    RETURNING id,request_id,created_at`,[ctx.credential.academy_id,attemptId,id,ctx.credential.person_id,i.requestSha256,i.requestBytes,i.documentSha256,ctx.requestId])).rows[0];}
   catch(error){if(error&&typeof error==='object'&&'code' in error&&error.code==='23514'&&'message' in error&&error.message==='SIGNATURE_SEND_ATTEMPT_INVALID')throw new ApiError(409,'SIGNATURE_ATTEMPT_SOURCE_CHANGED');throw error;}
   return {status:201,body:{data:{...result,state:'attempt_reserved',manifestAttested:true,externalRequestMade:false,deliveryVerified:false,admissionCleared:false,readyToSend:false}}};
  });
 }
 if(ctx.request.method!=='GET')throw new ApiError(405,'METHOD_NOT_ALLOWED');const {r}=await row(ctx,id);
 if(section==='attempts'){const rows=(await ctx.db.query('SELECT id,request_id,actor_id,request_sha256,request_bytes,document_sha256,created_at FROM public.signature_send_attempts WHERE request_id=$1',[id])).rows;return {status:200,body:{data:rows,externalRequestMade:r.dispatch_id&&r.dispatch_observation!=='not_attempted'?null:false,deliveryVerified:false}};}
 return {status:200,body:{data:{...view(r),recordedSourcesCurrent:(await ctx.db.query<{valid:boolean}>('SELECT public.signature_send_current($1) valid',[id])).rows[0].valid}}};
}
export const signatureSendsContract=[
 {path:'/api/v1/agreement-packages/{id}/send-requests',method:'post',summary:'Request upper-reviewed bounded signing intention for exact attached content; no provider call',schema:input},
 {path:'/api/v1/agreement-packages/{id}/send-requests',method:'get',summary:'Current-source-private request chain directory, filtered before paging',querySchema:paging},
 {path:'/api/v1/signature-send-requests/{id}',method:'get',summary:'Private approved intention/current source markers; not delivery, signature or admission proof'},
 {path:'/api/v1/signature-send-requests/{id}/cancel',method:'post',summary:'Upper-reviewed cancellation before any reserved attempt; expired/retired sources may still be stopped',schema:cancelInput},
 {path:'/api/v1/signature-send-requests/{id}/attempts',method:'post',summary:'Reserve one attested manifest under current execution/source rights; no network, retry or delivery proof',schema:attemptInput},
 {path:'/api/v1/signature-send-requests/{id}/attempts',method:'get',summary:'Private single-use manifest reservation evidence, not transport outcome'}
] as const;
