import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { jsonBody,mutation,record,type ApiContext,type Reply } from '../core/api.ts';
import { ApiError } from '../core/policy.ts';
import { lockAcademyTopology } from './academy.ts';
import { permittedSignatureSend } from './signature-sends.ts';
import { boldSignSendDraftSchema } from '../integrations/boldsign-send-request.ts';
import { boldSignStoredOriginalSchema } from '../integrations/boldsign-stored-request.ts';

const uuid=z.string().uuid().transform(v=>v.toLowerCase()),hash=z.string().regex(/^[a-f0-9]{64}$/);
const sourceQuery=z.object({copyId:uuid.optional()}).strict();
const manifest=z.object({requestSha256:hash,requestBytes:z.number().int().min(1).max(16_777_216),documentSha256:hash,
 original:z.object({copyId:uuid,sourceFingerprint:hash}).strict().optional()}).strict();
const observation=z.discriminatedUnion('state',[
 z.object({state:z.literal('not_attempted')}).strict(),z.object({state:z.literal('outcome_unknown')}).strict(),
 z.object({state:z.literal('accepted_for_processing'),documentId:uuid}).strict()
]);
const markers={automaticRetryAllowed:false,deliveryVerified:false,admissionCleared:false,providerVerified:false,readyToSend:false} as const;
type Attempt={id:string;request_id:string;request_sha256:string;request_bytes:number;document_sha256:string};
type Start={id:string;actor_id:string};
async function selected(ctx:ApiContext,requestId:string,attemptId:string,write:boolean) {
 const permitted=await permittedSignatureSend(ctx,requestId,write?'signature-dispatch.execute':'signature-sends.view');
 const attempt=(await ctx.db.query<Attempt>('SELECT id,request_id,request_sha256,request_bytes,document_sha256 FROM public.signature_send_attempts WHERE id=$1 AND request_id=$2',[attemptId,requestId])).rows[0];
 if(!attempt)throw new ApiError(404,'NOT_FOUND');return {...permitted,attempt};
}
// Coordination only, NOT provider IO, original-file clearance or admission.
// The eventual sender must hydrate/rebuild/validate BEFORE consuming the start.
export async function signatureDispatch(ctx:ApiContext):Promise<Reply|null> {
 const sourcePath=/^signature-send-requests\/([^/]+)\/dispatch-source$/.exec(ctx.path);
 if(sourcePath){
  if(ctx.request.method!=='GET')throw new ApiError(405,'METHOD_NOT_ALLOWED');
  const query=sourceQuery.parse(Object.fromEntries(new URL(ctx.request.url).searchParams));
  const requestId=uuid.parse(sourcePath[1]);await lockAcademyTopology(ctx);
  const {r,p}=await permittedSignatureSend(ctx,requestId,'signature-dispatch.execute');
  if(!(await ctx.db.query<{valid:boolean}>('SELECT public.signature_send_current($1) valid',[requestId])).rows[0].valid)throw new ApiError(409,'SIGNATURE_SEND_NOT_CURRENT');
  const contact=(await ctx.db.query<{person_id:string;legal_name:string;email:string;phone_e164:string;contact_fingerprint:string}>('SELECT * FROM public.signature_dispatch_contact($1)',[requestId])).rows[0];
  if(!contact)throw new ApiError(409,'SIGNATURE_CONTACT_NOT_CURRENT');
  const binding=(await ctx.db.query<{id:string;file_id:string;file_version:number;inspection_id:string;attempt_no:number;source:{sha256:string;sizeBytes:number};routing:unknown}>(`SELECT b.id,b.file_id,b.file_version,b.inspection_id,b.attempt_no,b.source,b.routing FROM public.agreement_package_contents l JOIN public.agreement_content_bindings b ON b.academy_id=l.academy_id AND b.id=l.binding_id WHERE l.id=$1 AND l.package_id=$2`,[r.attachment_id,r.package_id])).rows[0];
  if(!binding)throw new ApiError(409,'SIGNATURE_SEND_NOT_CURRENT');
  const prepared=boldSignSendDraftSchema.safeParse({...(r.options as object),packageId:r.package_id,attachmentId:r.attachment_id,bindingId:binding.id,locale:p.locale,
   document:{sha256:binding.source.sha256,sizeBytes:binding.source.sizeBytes},routing:binding.routing,
   signer:{personId:contact.person_id,legalName:contact.legal_name,email:contact.email,phoneE164:contact.phone_e164,emailVerified:true,phoneVerified:true,contactFingerprint:contact.contact_fingerprint}});
  if(!prepared.success)throw new ApiError(503,'SIGNATURE_DISPATCH_SOURCE_INVALID');
  let original:null|z.infer<typeof boldSignStoredOriginalSchema>=null;
  if(query.copyId){
   const copy=(await ctx.db.query('SELECT route_id FROM public.file_copy_requests WHERE id=$1 AND file_id=$2',[query.copyId,binding.file_id])).rows[0];if(!copy)throw new ApiError(404,'NOT_FOUND');
   await ctx.db.query('SELECT id FROM public.file_records WHERE id=$1 FOR SHARE',[binding.file_id]);
   await ctx.db.query('SELECT id FROM public.file_storage_routes WHERE id=$1 FOR SHARE',[copy.route_id]);
   const evidence=(await ctx.db.query<{source:Record<string,unknown>|null;fingerprint:string|null}>('WITH selected AS MATERIALIZED(SELECT public.file_download_source($1,$2,$3) source) SELECT source,encode(sha256(convert_to(source::text,\'UTF8\')),\'hex\') fingerprint FROM selected',[binding.file_id,binding.file_version,query.copyId])).rows[0],artifact=evidence.source;
   if(!artifact||artifact.mime!=='application/pdf'||artifact.sha256!==prepared.data.document.sha256||artifact.bytes!==prepared.data.document.sizeBytes)throw new ApiError(409,'BOLDSIGN_ORIGINAL_NOT_READY');
   const verified=boldSignStoredOriginalSchema.safeParse({academyId:ctx.credential.academy_id,fileId:artifact.fileId,fileVersion:artifact.fileVersion,copyId:artifact.copyId,sourceFingerprint:evidence.fingerprint,storageTargetId:artifact.destinationTargetId,etag:artifact.destinationEtag,bytes:artifact.bytes,sha256:artifact.sha256});
   if(!verified.success)throw new ApiError(503,'SIGNATURE_DISPATCH_SOURCE_INVALID');original=verified.data;
  }
  // The final source comparison catches a concurrent contact/profile change.
  // Actual sending must reauthorize AGAIN after original-byte retrieval.
  if(!(await ctx.db.query<{valid:boolean}>('SELECT public.signature_send_current($1) valid',[requestId])).rows[0].valid)throw new ApiError(409,'SIGNATURE_SEND_NOT_CURRENT');
  await record(ctx.db,ctx.credential,ctx.requestId,'signature.dispatch.source.read',requestId,p.hub_id,{privateContactRead:true,externalRequestMade:false});
  return {status:200,body:{data:{draft:prepared.data,file:{id:binding.file_id,version:binding.file_version,inspectionId:binding.inspection_id,attemptNo:binding.attempt_no},original,originalEvidenceAvailable:Boolean(original),...markers,originalBytesRetrieved:false,fileSafetyCleared:false,externalRequestMade:false}}};
 }
 const path=/^signature-send-requests\/([^/]+)\/attempts\/([^/]+)\/dispatch(?:\/(outcome))?$/.exec(ctx.path);if(!path)return null;
 z.object({}).strict().parse(Object.fromEntries(new URL(ctx.request.url).searchParams));
 const requestId=uuid.parse(path[1]),attemptId=uuid.parse(path[2]),outcome=Boolean(path[3]);
 if(ctx.request.method==='GET'&&!outcome){
  await selected(ctx,requestId,attemptId,false);
  const start=(await ctx.db.query(`SELECT id,attempt_id,actor_id,created_at,original_copy_id,original_source_fingerprint,original_copy_id IS NOT NULL AS "originalCopyBound",CASE WHEN original_copy_id IS NULL THEN NULL ELSE coalesce(original_source IS NOT DISTINCT FROM public.signature_dispatch_original_source(attempt_id,original_copy_id),false) END AS "originalCopyCurrent" FROM public.signature_dispatch_starts WHERE attempt_id=$1`,[attemptId])).rows[0];
  const observed=start?(await ctx.db.query('SELECT id,state,document_id,source_current,created_at FROM public.signature_dispatch_outcomes WHERE start_id=$1',[start.id])).rows[0]??null:null;
  return {status:200,body:{data:{start:start??null,observation:observed,state:observed?.state??(start?'started_outcome_unrecorded':'not_started'),reconciliationRequired:Boolean(start)&&observed?.state!=='not_attempted',...markers}}};
 }
 if(ctx.request.method!=='POST')throw new ApiError(405,'METHOD_NOT_ALLOWED');
 const input=outcome?observation.parse(await jsonBody(ctx.request)):manifest.parse(await jsonBody(ctx.request));
 await lockAcademyTopology(ctx);await selected(ctx,requestId,attemptId,true);
 await ctx.db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,25))',[ctx.credential.academy_id+':'+requestId]);
 const {p,attempt}=await selected(ctx,requestId,attemptId,true);
 const start=(await ctx.db.query<Start>('SELECT id,actor_id FROM public.signature_dispatch_starts WHERE attempt_id=$1',[attemptId])).rows[0];
 if(outcome&&(!start||start.actor_id!==ctx.credential.person_id))throw new ApiError(404,'NOT_FOUND');
 return mutation(ctx,input,async()=>{
  if(!outcome){
   if(start)throw new ApiError(409,'SIGNATURE_DISPATCH_ALREADY_STARTED');
   const i=manifest.parse(input);
   if(i.requestSha256!==attempt.request_sha256||i.requestBytes!==attempt.request_bytes||i.documentSha256!==attempt.document_sha256)throw new ApiError(409,'SIGNATURE_DISPATCH_MANIFEST_MISMATCH');
   if(!(await ctx.db.query<{valid:boolean}>('SELECT public.signature_send_current($1) valid',[requestId])).rows[0].valid)throw new ApiError(409,'SIGNATURE_SEND_NOT_CURRENT');
  }else if((await ctx.db.query('SELECT 1 FROM public.signature_dispatch_outcomes WHERE start_id=$1',[start.id])).rows.length)throw new ApiError(409,'SIGNATURE_DISPATCH_OUTCOME_ALREADY_RECORDED');
  const id=randomUUID(),action=outcome?'signature.dispatch.observed':'signature.dispatch.started';
  const original=outcome?undefined:manifest.parse(input).original;
  await record(ctx.db,ctx.credential,ctx.requestId,action,id,p.hub_id,{requestId,attemptId,severity:'critical',...(outcome?{state:observation.parse(input).state}:{}),...original?{originalCopyId:original.copyId,originalSourceFingerprint:original.sourceFingerprint}:{},providerVerified:false});
  const audit=(await ctx.db.query<{id:string}>('SELECT id FROM public.audit_events WHERE request_id=$1 AND entity_id=$2 AND action=$3 AND actor_id=$4 AND created_at=transaction_timestamp()',[ctx.requestId,id,action,ctx.credential.person_id])).rows[0];
  let result:Record<string,unknown>;
  try{
   if(outcome){const i=observation.parse(input);result=(await ctx.db.query(`INSERT INTO public.signature_dispatch_outcomes(academy_id,id,start_id,actor_id,audit_id,state,document_id) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id,start_id,state,document_id,source_current,created_at`,[ctx.credential.academy_id,id,start.id,ctx.credential.person_id,audit.id,i.state,i.state==='accepted_for_processing'?i.documentId:null])).rows[0];}
   else result=(await ctx.db.query(`INSERT INTO public.signature_dispatch_starts(academy_id,id,attempt_id,actor_id,audit_id,original_copy_id,original_source_fingerprint) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id,attempt_id,created_at,original_copy_id,original_source_fingerprint,original_copy_id IS NOT NULL AS "originalCopyBound"`,[ctx.credential.academy_id,id,attemptId,ctx.credential.person_id,audit.id,original?.copyId??null,original?.sourceFingerprint??null])).rows[0];
  }catch(error){if(error&&typeof error==='object'&&'code' in error&&error.code==='23514'){if('message' in error&&error.message==='SIGNATURE_DISPATCH_ORIGINAL_CHANGED')throw new ApiError(409,'SIGNATURE_DISPATCH_ORIGINAL_CHANGED');throw new ApiError(409,'SIGNATURE_DISPATCH_SOURCE_CHANGED');}throw error;}
  return {status:201,body:{data:{...result,...markers,reconciliationRequired:!outcome||observation.parse(input).state!=='not_attempted',...outcome?{}:{state:'started',externalRequestMade:false}}}};
 },async()=>{
  // Cached start responses never grant permission for another external POST.
  if(!outcome)throw new ApiError(409,'SIGNATURE_DISPATCH_ALREADY_STARTED');
 });
}
export const signatureDispatchContract=[
 {path:'/api/v1/signature-send-requests/{id}/dispatch-source',method:'get',summary:'Audited private signing draft and optional exact verified-copy descriptor under current reviewed serving policy; no bytes, safety clearance or provider call',querySchema:sourceQuery},
 {path:'/api/v1/signature-send-requests/{id}/attempts/{attemptId}/dispatch',method:'post',summary:'Consume one durable reservation once; optional original binds current verified-copy/policy fingerprint natively. Unbound coordination is not provider authority; no provider call or file clearance',schema:manifest},
 {path:'/api/v1/signature-send-requests/{id}/attempts/{attemptId}/dispatch',method:'get',summary:'Read private send-once start and bounded unverified transport observation'},
 {path:'/api/v1/signature-send-requests/{id}/attempts/{attemptId}/dispatch/outcome',method:'post',summary:'Record one immutable transport observation by starter, including after source expiry; never signature/admission proof',schema:observation}
] as const;
