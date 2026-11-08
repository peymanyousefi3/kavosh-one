import { z } from 'zod';
import { jsonBody,record,type ApiContext,type Reply } from '../core/api.ts';
import { propose,lockApprovalWrites,type ApprovalRegistry } from '../core/approvals.ts';
import { ApiError } from '../core/policy.ts';
import { lockAcademyTopology } from './academy.ts';
import { permittedSignatureSend } from './signature-sends.ts';
import { authorizeAgreementPackageReviewer } from './agreement-packages.ts';

const uuid=z.string().uuid().transform(v=>v.toLowerCase()),empty=z.object({}).strict();
const input=z.object({expectedVersion:z.number().int().min(0).max(2147483646),decision:z.enum(['accepted','needs_changes','rejected']),documentGrantId:uuid.nullable().default(null),auditGrantId:uuid.nullable().default(null),signedAt:z.iso.datetime().max(30).nullable().default(null),
 identityAndAuthenticationReviewed:z.boolean().default(false),contentAndConsentReviewed:z.boolean().default(false),reason:z.string().trim().min(1).max(2000).refine(v=>v.isWellFormed()&&!v.includes('\0'))}).strict().refine(v=>v.decision==='accepted'?Boolean(v.documentGrantId&&v.auditGrantId&&v.signedAt&&v.identityAndAuthenticationReviewed&&v.contentAndConsentReviewed):v.documentGrantId===null&&v.auditGrantId===null&&v.signedAt===null&&!v.identityAndAuthenticationReviewed&&!v.contentAndConsentReviewed);
const payload=input.safeExtend({requestId:uuid,evidenceId:uuid,requestedBy:uuid});
const history=z.object({limit:z.coerce.number().int().min(1).max(20).default(5),afterVersion:z.coerce.number().int().min(0).max(2147483647).default(0)}).strict();
type Review={evidence_id:string;version:number;input:z.infer<typeof payload>;source:Record<string,unknown>;[key:string]:unknown};
const markers={admissionCleared:false,cryptographicValidityVerified:false,legalValidityCertified:false,providerStatusFreshlyChecked:false} as const;
async function authority(ctx:ApiContext,i:{requestId:string;evidenceId:string},edit=false){
 await permittedSignatureSend(ctx,i.requestId,'signature-completions.view');const allowed=await permittedSignatureSend(ctx,i.requestId,edit?'signature-completions.review':'signature-completions.inspect');if(edit)await permittedSignatureSend(ctx,i.requestId,'signature-completions.inspect');
 if(!(await ctx.db.query(`SELECT e.id FROM public.signature_completion_evidence e JOIN public.signature_dispatch_starts s ON s.academy_id=e.academy_id AND s.id=e.start_id JOIN public.signature_send_attempts a ON a.academy_id=s.academy_id AND a.id=s.attempt_id WHERE a.request_id=$1 AND e.id=$2`,[i.requestId,i.evidenceId])).rows.length)throw new ApiError(404,'NOT_FOUND');return allowed;
}
async function current(ctx:ApiContext,id:string){return(await ctx.db.query<{record:Review}>('SELECT to_jsonb(r) record FROM public.signature_completion_reviews r WHERE evidence_id=$1',[id])).rows[0]?.record??null;}
async function source(ctx:ApiContext,i:z.infer<typeof payload>,requester:string){
 const s=(await ctx.db.query<{source:Record<string,unknown>|null}>('SELECT public.signature_completion_review_source($1,$2,$3::jsonb) source',[i.evidenceId,requester,JSON.stringify(i)])).rows[0]?.source;if(!s)throw new ApiError(409,'SIGNATURE_REVIEW_EVIDENCE_NOT_READY');return s;
}
export const signatureCompletionReviewActions:ApprovalRegistry={'signature.completion.review':{
 requestCapability:'signature-completions.review',privacyCapability:'signature-completions.view',policyChange:true,
 async validate(ctx,id,raw){await lockAcademyTopology(ctx);const i=payload.parse(raw);if(id!==i.evidenceId)throw new ApiError(400,'INVALID_TARGET');if(ctx.credential.kind!=='human')throw new ApiError(403,'HUMAN_EVIDENCE_REVIEW_REQUIRED');return(await authority(ctx,i,true)).scope;},
 async dependencies(ctx,id,raw,purpose){try{const i=payload.parse(raw),before=await current(ctx,id);if((before?.version??0)!==i.expectedVersion)throw new ApiError(409,'TARGET_CHANGED');
  // Grant ownership is bound to the ORIGINAL proposer,not substituted with an
  // upper reviewer. Approval callbacks execute with the reviewer's identity.
  return {record:before,source:await source(ctx,i,i.requestedBy)};
 }catch(error){if(purpose==='review'&&error instanceof ApiError&&[403,404,409].includes(error.status))return {unavailable:error.code};throw error;}},
 async authorizeReviewer(ctx,p){const i=payload.parse(p.payload),{p:pkg}=await authority(ctx,i);await authorizeAgreementPackageReviewer(ctx,{enrollmentId:pkg.enrollment_id,templateId:pkg.template_id,signerId:pkg.signer_id});},
 async apply(ctx,p){
  if(ctx.credential.kind!=='human'||p.requester_kind!=='human')throw new ApiError(403,'HUMAN_EVIDENCE_REVIEW_REQUIRED');const i=payload.parse(p.payload),s=(p.review_context as {source:Record<string,unknown>}).source;
  if(i.expectedVersion===0)await ctx.db.query('INSERT INTO public.signature_completion_reviews(academy_id,evidence_id,input,source,requested_by,changed_by,approval_id) VALUES($1,$2,$3::jsonb,$4::jsonb,$5,$6,$7)',[ctx.credential.academy_id,i.evidenceId,JSON.stringify(i),JSON.stringify(s),p.requester_id,ctx.credential.person_id,p.id]);
  else await ctx.db.query('UPDATE public.signature_completion_reviews SET version=version+1,input=$2::jsonb,source=$3::jsonb,requested_by=$4,changed_by=$5,approval_id=$6 WHERE evidence_id=$1',[i.evidenceId,JSON.stringify(i),JSON.stringify(s),p.requester_id,ctx.credential.person_id,p.id]);
  await ctx.db.query('INSERT INTO public.signature_completion_review_revisions(academy_id,evidence_id,version,definition) SELECT academy_id,evidence_id,version,to_jsonb(r) FROM public.signature_completion_reviews r WHERE evidence_id=$1',[i.evidenceId]);const after=(await current(ctx,i.evidenceId))!;
  await record(ctx.db,ctx.credential,ctx.requestId,p.action,i.evidenceId,s.hubId as string,{version:after.version,decision:i.decision,hasReason:true,severity:'critical',signingTimeHumanAttested:i.signedAt!==null,admissionCleared:false});return {...after,...markers};
 }
}};
export async function signatureCompletionReviews(ctx:ApiContext,registry:ApprovalRegistry=signatureCompletionReviewActions):Promise<Reply|null>{
 const path=/^signature-send-requests\/([^/]+)\/completion-evidence\/([^/]+)\/review(?:\/(history))?$/.exec(ctx.path);if(!path)return null;const target={requestId:uuid.parse(path[1]),evidenceId:uuid.parse(path[2])},params=Object.fromEntries(new URL(ctx.request.url).searchParams);
 if(ctx.request.method==='POST'){if(path[3])throw new ApiError(405,'METHOD_NOT_ALLOWED');empty.parse(params);const i={...input.parse(await jsonBody(ctx.request)),...target,requestedBy:ctx.credential.person_id};return propose(ctx,registry,'signature.completion.review',target.evidenceId,i.expectedVersion,i);}
 if(ctx.request.method!=='GET')throw new ApiError(405,'METHOD_NOT_ALLOWED');await lockApprovalWrites(ctx);await authority(ctx,target);
 if(path[3]){const q=history.parse(params),rows=(await ctx.db.query<{version:number;definition:Review}>('SELECT version,definition,recorded_at FROM public.signature_completion_review_revisions WHERE evidence_id=$1 AND version>$2 ORDER BY version LIMIT $3',[target.evidenceId,q.afterVersion,q.limit+1])).rows;return {status:200,body:{data:rows.slice(0,q.limit).map(r=>({...r,definition:{...r.definition,...markers}})),nextVersion:rows.length>q.limit?rows[q.limit-1].version:null}};}
 empty.parse(params);const r=await current(ctx,target.evidenceId),stillCurrent=r?(await ctx.db.query<{current:boolean}>('SELECT $1::jsonb IS NOT DISTINCT FROM public.signature_completion_review_source($2,$3,$4::jsonb) current',[JSON.stringify(r.source),target.evidenceId,r.requested_by,JSON.stringify(r.input)])).rows[0].current:null;
 return {status:200,body:{data:r?{...r,...markers}:null,recordedSourceCurrent:stillCurrent,...markers}};
}
export const signatureCompletionReviewsContract=[
 {path:'/api/v1/signature-send-requests/{id}/completion-evidence/{evidenceId}/review',method:'post',humanOnly:true,summary:'Upper-reviewed reversible human evidence decision;accepted requires own exact document and audit grants and explicit content/authentication/signing-time attestations. Native civil-age and original guardian validity at signing;not admission or legal/crypto certification.',schema:input},
 {path:'/api/v1/signature-send-requests/{id}/completion-evidence/{evidenceId}/review',method:'get',summary:'Private persistent latest signing-evidence decision and current-source status;not a fresh provider check or admission'},
 {path:'/api/v1/signature-send-requests/{id}/completion-evidence/{evidenceId}/review/history',method:'get',summary:'Bounded immutable private signing-evidence review history',querySchema:history}
] as const;
