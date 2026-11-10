import { z } from 'zod';
import { jsonBody,record,type ApiContext,type Reply } from '../core/api.ts';
import { propose,lockApprovalWrites,type ApprovalRegistry,type Proposal } from '../core/approvals.ts';
import { ApiError } from '../core/policy.ts';
import { permittedWorkAgreement,authorizeWorkAgreementReviewer } from './work-agreements.ts';
import { workEngagementScope } from './work-engagements.ts';
import { permittedFile } from './files.ts';
import { lockAcademyTopology } from './academy.ts';
import { lockFinanceBook } from '../core/finance-lock.ts';
import { workAgreementRouting } from '../integrations/boldsign.ts';

const uuid=z.string().uuid().transform(v=>v.toLowerCase()),version=z.number().int().min(1).max(2147483647),note=z.string().trim().min(1).max(2000).refine(v=>v.isWellFormed()&&!v.includes('\0'));
const input=z.object({fileId:uuid,fileVersion:version,inspectionId:uuid,attemptNo:z.number().int().min(1).max(5),routing:workAgreementRouting,contentReviewed:z.literal(true),routingReviewed:z.literal(true),contentAttestation:note,reason:note}).strict(),payload=input.extend({preparationId:uuid}),empty=z.object({}).strict();
type Input=z.infer<typeof payload>;
type Source={preparationId:string;preparationApprovalId:string;framework:{engagement:{hubId:string|null}}&Record<string,unknown>;document:{sha256:string;sizeBytes:number;fileId:string;fileVersion:number;inspectionId:string;attemptNo:number}&Record<string,unknown>;routing:z.infer<typeof workAgreementRouting>};
type Row={id:string;preparation_id:string;input:Input;source_snapshot:Source;approval_id:string;created_at:string};
async function sources(ctx:ApiContext,i:Pick<Input,'preparationId'|'fileId'>,edit=false){const w=await permittedWorkAgreement(ctx,i.preparationId,edit),f=await permittedFile(ctx,i.fileId);if(f.domain!=='work_private'||f.work_context?.engagementId!==w.engagement_id)throw new ApiError(409,'WORK_AGREEMENT_FILE_ANCHOR_MISMATCH');return {w,f};}
async function basis(ctx:ApiContext,i:Input){await sources(ctx,i,true);if((await ctx.db.query('SELECT 1 FROM public.work_agreement_contents WHERE preparation_id=$1',[i.preparationId])).rows.length)throw new ApiError(409,'WORK_AGREEMENT_CONTENT_ALREADY_ATTACHED');const s=(await ctx.db.query<{source:Source|null}>('SELECT public.work_agreement_content_source($1::jsonb) source',[JSON.stringify(i)])).rows[0].source;if(!s)throw new ApiError(409,'WORK_AGREEMENT_CONTENT_NOT_READY');return {source:s};}
const flags={state:'content_attached',readyToSend:false,safeToServe:false,signedByBothParties:false,providerContentVerified:false,legallyEffective:false,paymentCleared:false} as const;
function output(r:Row){return {id:r.id,preparationId:r.preparation_id,sourceSnapshot:r.source_snapshot,approvalId:r.approval_id,createdAt:r.created_at,...flags};}
async function apply(ctx:ApiContext,p:Proposal){if(ctx.credential.kind!=='human')throw new ApiError(403,'HUMAN_REVIEW_REQUIRED');const i=payload.parse(p.payload);
 // The INSERT guard recomputes the exact current framework/file/routing basis
 // and matches the applied review. Reuse that native check,not another JS read.
 let r:Row;try{r=(await ctx.db.query<Row>('INSERT INTO public.work_agreement_contents(academy_id,id,input,source_snapshot,created_by,approval_id) VALUES($1,$2,$3::jsonb,$4::jsonb,$5,$6) RETURNING *,created_at::text',[ctx.credential.academy_id,p.target_id,JSON.stringify(i),JSON.stringify(p.review_context.source),ctx.credential.person_id,p.id])).rows[0];}catch(e){if(e&&typeof e==='object'&&'code'in e&&e.code==='23514'&&'message'in e&&e.message==='WORK_AGREEMENT_CONTENT_EXACT_REVIEW_REQUIRED')throw new ApiError(409,'WORK_AGREEMENT_CONTENT_CHANGED');throw e;}
 await record(ctx.db,ctx.credential,ctx.requestId,'work.agreement.content',p.target_id,r.source_snapshot.framework.engagement.hubId,{severity:'critical',approvalId:p.id,hasReason:true,externalRequestMade:false,signedByBothParties:false});return output(r);
}
export const workAgreementContentActions:ApprovalRegistry={'work.agreement.content':{requestCapability:'work-signatures.edit',privacyCapability:'work-signatures.edit',policyChange:true,createdStatus:201,
 async validate(ctx,_id,raw){const i=payload.parse(raw);await sources(ctx,i,true);await lockFinanceBook(ctx);await lockAcademyTopology(ctx);const {w}=await sources(ctx,i,true);return workEngagementScope({person_id:w.worker_id,hub_id:w.hub_id});},
 async dependencies(ctx,_id,raw,purpose){try{return await basis(ctx,payload.parse(raw));}catch(e){if(purpose==='review'&&e instanceof ApiError&&[403,404,409].includes(e.status))return {unavailable:e.code};throw e;}},
 async authorizeReviewer(ctx,p){const i=payload.parse(p.payload),{w}=await sources(ctx,i,true);await authorizeWorkAgreementReviewer(ctx,{engagementId:w.engagement_id,templateId:w.template_id,academySignerId:w.academy_signer_id});},apply}};
export async function workAgreementContent(ctx:ApiContext,registry:ApprovalRegistry=workAgreementContentActions):Promise<Reply|null>{
 const match=/^payroll\/work-agreements\/([^/]+)\/content(?:\/(review))?$/.exec(ctx.path);if(!match)return null;const params=new URL(ctx.request.url).searchParams;if([...params].length!==new Set(params.keys()).size)throw new ApiError(400,'DUPLICATE_QUERY');empty.parse(Object.fromEntries(params));const preparationId=uuid.parse(match[1]);
 if(ctx.request.method==='POST'){if(match[2])throw new ApiError(405,'METHOD_NOT_ALLOWED');const i={...input.parse(await jsonBody(ctx.request,65536)),preparationId};await sources(ctx,i,true);return propose(ctx,registry,'work.agreement.content',null,0,i);}
 if(ctx.request.method!=='GET')throw new ApiError(405,'METHOD_NOT_ALLOWED');await lockApprovalWrites(ctx);await permittedWorkAgreement(ctx,preparationId,Boolean(match[2]));const r=(await ctx.db.query<Row>('SELECT x.*,created_at::text FROM public.work_agreement_contents x WHERE preparation_id=$1',[preparationId])).rows[0];if(!r)throw new ApiError(404,'NOT_FOUND');await sources(ctx,r.input,Boolean(match[2]));
 if(match[2])return {status:200,body:{data:{...output(r),contentAttestation:r.input.contentAttestation,reason:r.input.reason}}};
 const current=(await ctx.db.query<{current:boolean}>('SELECT public.work_agreement_content_source($1::jsonb) IS NOT DISTINCT FROM $2::jsonb current',[JSON.stringify(r.input),JSON.stringify(r.source_snapshot)])).rows[0].current;return {status:200,body:{data:{...output(r),recordedSourcesCurrent:current}}};
}
export const workAgreementContentContract=[
 {path:'/api/v1/payroll/work-agreements/{id}/content',method:'post',summary:'Upper-human-reviewed exact inspected PDF identity and required worker/academy signature geometry for one current work preparation; no one-party fallback,provider call,safe serving or legal effectiveness. Version2 may add distinct optional unchecked worker public/member-profile questions in this SAME document;both signatures stay required,academy signers cannot answer for workers,and routing never grants consent or publication.',schema:input},
 {path:'/api/v1/payroll/work-agreements/{id}/content',method:'get',summary:'Read immutable two-party PDF binding and current source status under all current work,template and file permissions; not live sending or completed-signature proof'},
 {path:'/api/v1/payroll/work-agreements/{id}/content/review',method:'get',summary:'Editor-only PDF equivalence and two-party routing review notes under current source and file rights'}
] as const;
