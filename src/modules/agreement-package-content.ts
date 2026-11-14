import { z } from 'zod';
import { jsonBody,record,type ApiContext,type Reply } from '../core/api.ts';
import { propose,type ApprovalRegistry,type Proposal } from '../core/approvals.ts';
import { ApiError } from '../core/policy.ts';
import { authorizeAgreementPackageReviewer,currentAgreementPackage,permittedAgreementPackage } from './agreement-packages.ts';
import { permittedAgreementContent } from './agreement-content.ts';
import { lockAcademyTopology } from './academy.ts';

const uuid=z.string().uuid().transform(v=>v.toLowerCase());
const input=z.object({bindingId:uuid,reason:z.string().trim().min(1).max(2000).refine(v=>v.isWellFormed()&&!v.includes('\0'))}).strict(),payload=input.extend({packageId:uuid});
type Input=z.infer<typeof payload>;
async function sources(ctx:ApiContext,i:Input) {
 const {row:p,basis}=await currentAgreementPackage(ctx,i.packageId),b=await permittedAgreementContent(ctx,i.bindingId);
 if(b.template_id!==p.template_id||b.template_version!==p.template_version||b.locale!==p.locale||b.source.templateHash!==p.template_hash)throw new ApiError(409,'PACKAGE_CONTENT_MISMATCH');
 if(!b.recordedSourceCurrent)throw new ApiError(409,'AGREEMENT_CONTENT_NOT_CURRENT');
 return {p,b,basis};
}
async function dependencies(ctx:ApiContext,i:Input) {
 const {p,b,basis}=await sources(ctx,i);
 if(p.contentAttached)throw new ApiError(409,'PACKAGE_CONTENT_ALREADY_ATTACHED');
 return {package:{id:p.id,approvalId:p.approval_id,basis},content:{id:b.id,approvalId:b.approval_id,source:b.source,routing:b.routing}};
}
async function apply(ctx:ApiContext,p:Proposal) {
 if(ctx.credential.kind!=='human')throw new ApiError(403,'HUMAN_REVIEW_REQUIRED');
 const i=payload.parse(p.payload);
 // The INSERT guard independently recomputes the complete current source basis
 // and compares the exact approval context. Do not repeat those reads in JS.
 let row:{hub_id:string}&Record<string,unknown>;
 try{row=(await ctx.db.query<{hub_id:string}&Record<string,unknown>>(`INSERT INTO public.agreement_package_contents(academy_id,id,package_id,binding_id,approval_id,created_by,reason)
 VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id,package_id,binding_id,approval_id,created_at,(SELECT hub_id FROM public.agreement_packages WHERE id=agreement_package_contents.package_id) AS hub_id`,[ctx.credential.academy_id,p.target_id,i.packageId,i.bindingId,p.id,ctx.credential.person_id,i.reason])).rows[0];}
 catch(error){if(error&&typeof error==='object'&&'code' in error&&error.code==='23514'&&'message' in error&&error.message==='PACKAGE_CONTENT_EXACT_APPROVAL_REQUIRED')throw new ApiError(409,'PACKAGE_CONTENT_SOURCES_CHANGED');throw error;}
 await record(ctx.db,ctx.credential,ctx.requestId,'agreement.content.attach',p.target_id,row.hub_id,{packageId:i.packageId,severity:'critical',hasReason:true});
 return {...row,state:'content_attached',readyToSend:false,admissionCleared:false};
}
export const agreementPackageContentActions:ApprovalRegistry={'agreement.content.attach':{requestCapability:'signatures.edit',privacyCapability:'signatures.view',policyChange:true,createdStatus:201,
 async validate(ctx,_id,raw){await lockAcademyTopology(ctx);const i=payload.parse(raw),{p,basis}=await sources(ctx,i);
  return {all:false,hubs:[],classes:[{id:p.class_id,hubId:p.hub_id}],people:[{id:p.student_id,hubId:basis.studentHubId},...p.signer_id!==p.student_id?[{id:p.signer_id,hubId:basis.signerHubId}]:[]]};},
 async dependencies(ctx,_id,raw,purpose){try{return await dependencies(ctx,payload.parse(raw));}catch(error){if(purpose==='review'&&error instanceof ApiError&&[403,404,409].includes(error.status))return {unavailable:error.code};throw error;}},
 async authorizeReviewer(ctx,p){const i=payload.parse(p.payload),row=await permittedAgreementPackage(ctx,i.packageId);await authorizeAgreementPackageReviewer(ctx,{enrollmentId:row.enrollment_id,templateId:row.template_id,signerId:row.signer_id});},apply}};
export async function agreementPackageContent(ctx:ApiContext,registry:ApprovalRegistry=agreementPackageContentActions):Promise<Reply|null> {
 const match=/^agreement-packages\/([^/]+)\/content$/.exec(ctx.path);if(!match)return null;
 z.object({}).strict().parse(Object.fromEntries(new URL(ctx.request.url).searchParams));const packageId=uuid.parse(match[1]);
 if(ctx.request.method==='POST'){const i={...input.parse(await jsonBody(ctx.request)),packageId};return propose(ctx,registry,'agreement.content.attach',null,0,i);}
 if(ctx.request.method!=='GET')throw new ApiError(405,'METHOD_NOT_ALLOWED');
 await permittedAgreementPackage(ctx,packageId);
 const link=(await ctx.db.query<{binding_id:string}&Record<string,unknown>>(`SELECT l.*,public.agreement_package_content_basis(l.package_id,l.binding_id) IS NOT DISTINCT FROM p.review_context AS "recordedPackageSourcesCurrent" FROM public.agreement_package_contents l JOIN public.approval_requests p ON p.academy_id=l.academy_id AND p.id=l.approval_id WHERE l.package_id=$1`,[packageId])).rows[0];if(!link)throw new ApiError(404,'NOT_FOUND');
 const binding=await permittedAgreementContent(ctx,link.binding_id);
 return {status:200,body:{data:{...link,source:binding.source,routing:binding.routing,recordedSourceCurrent:binding.recordedSourceCurrent,state:'content_attached',readyToSend:false,admissionCleared:false}}};
}
export const agreementPackageContentContract=[
 {path:'/api/v1/agreement-packages/{id}/content',method:'post',summary:'Request one immutable reviewed PDF/routing binding for the exact current prepared student agreement; upper review required, not provider send or admission clearance',schema:input},
 {path:'/api/v1/agreement-packages/{id}/content',method:'get',summary:'Read the immutable package/PDF link under all current party, agreement and file permissions; old packages stay unbound until explicitly approved'}
] as const;
