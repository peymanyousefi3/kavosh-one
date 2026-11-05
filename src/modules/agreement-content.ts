import { z } from 'zod';
import { jsonBody,record,type ApiContext,type Reply } from '../core/api.ts';
import { propose,approvalReadParameters,type ApprovalRegistry,type Proposal } from '../core/approvals.ts';
import { ApiError } from '../core/policy.ts';
import { lockAcademyTopology } from './academy.ts';
import { template } from './agreements.ts';
import { permittedFile } from './files.ts';
import { agreementRouting as routing } from '../integrations/boldsign.ts';

const uuid=z.string().uuid().transform(v=>v.toLowerCase()),version=z.number().int().positive().max(2_147_483_647);
const text=z.string().refine(v=>v.isWellFormed()&&!v.includes('\0')),note=text.trim().min(1).max(2000);
const input=z.object({templateVersion:version,fileId:uuid,fileVersion:version,inspectionId:uuid,attemptNo:z.number().int().min(1).max(5),locale:z.enum(['en','fr','zh-CN']),
 routing,contentReviewed:z.literal(true),routingReviewed:z.literal(true),contentAttestation:note,reason:note}).strict();
const payload=input.extend({templateId:uuid});
const query=z.object({limit:z.coerce.number().int().min(1).max(100).default(50),after:uuid.optional()}).strict();
type Input=z.infer<typeof payload>;
async function sources(ctx:ApiContext,i:Pick<Input,'templateId'|'fileId'>,edit=false) {
 const t=await template(ctx,i.templateId,edit),f=await permittedFile(ctx,i.fileId);
 if(f.domain!=='agreement_definition'||f.hub_id!==t.hub_id)throw new ApiError(409,'AGREEMENT_FILE_ANCHOR_MISMATCH');
 return {t,f};
}
async function basis(ctx:ApiContext,i:Input) {
 await sources(ctx,i,true);
 const source=(await ctx.db.query<{source:Record<string,unknown>|null}>('SELECT public.agreement_content_source($1,$2,$3,$4,$5,$6,$7) AS source',[i.templateId,i.templateVersion,i.fileId,i.fileVersion,i.inspectionId,i.attemptNo,i.locale])).rows[0].source;
 if(!source)throw new ApiError(409,'AGREEMENT_CONTENT_NOT_READY');return {source};
}
const flags={state:'reviewed_binding',readyToSend:false,admissionCleared:false,safeToServe:false,providerContentVerified:false} as const;
export async function permittedAgreementContent(ctx:ApiContext,id:string) {
 const row=(await ctx.db.query<{id:string;template_id:string;template_version:number;locale:string;file_id:string;source:Record<string,unknown>;routing:unknown;approval_id:string;recordedSourceCurrent:boolean}&Record<string,unknown>>(`SELECT b.*,public.agreement_content_source(b.template_id,b.template_version,b.file_id,b.file_version,b.inspection_id,b.attempt_no,b.locale) IS NOT DISTINCT FROM b.source AS "recordedSourceCurrent" FROM public.agreement_content_bindings b WHERE b.id=$1`,[id])).rows[0];
 if(!row)throw new ApiError(404,'NOT_FOUND');await sources(ctx,{templateId:row.template_id,fileId:row.file_id});return row;
}
async function apply(ctx:ApiContext,p:Proposal) {
 if(ctx.credential.kind!=='human')throw new ApiError(403,'HUMAN_REVIEW_REQUIRED');
 const i=payload.parse(p.payload),b=await basis(ctx,i);
 if(JSON.stringify(b.source)!==JSON.stringify(p.review_context.source))throw new ApiError(409,'AGREEMENT_CONTENT_CHANGED');
 const row=(await ctx.db.query(`INSERT INTO public.agreement_content_bindings(academy_id,id,template_id,template_version,file_id,file_version,inspection_id,attempt_no,locale,source,routing,content_attestation,reason,created_by,approval_id)
 VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12,$13,$14,$15) RETURNING id,template_id,template_version,file_id,file_version,locale,created_at`,
 [ctx.credential.academy_id,p.target_id,i.templateId,i.templateVersion,i.fileId,i.fileVersion,i.inspectionId,i.attemptNo,i.locale,JSON.stringify(b.source),JSON.stringify(i.routing),i.contentAttestation,i.reason,ctx.credential.person_id,p.id])).rows[0];
 await record(ctx.db,ctx.credential,ctx.requestId,'agreement.content.bind',p.target_id,b.source.hubId as string|null,{templateId:i.templateId,templateVersion:i.templateVersion,severity:'critical',hasReason:true});
 return {...row,...flags};
}
export const agreementContentActions:ApprovalRegistry={'agreement.content.bind':{requestCapability:'agreements.edit',privacyCapability:'agreements.view',policyChange:true,createdStatus:201,
 async validate(ctx,_id,raw){await lockAcademyTopology(ctx);const {t}=await sources(ctx,payload.parse(raw),true);return t.hub_id?{all:false,hubs:[t.hub_id]}:{all:true,hubs:[]};},
 async dependencies(ctx,_id,raw,purpose){try{return await basis(ctx,payload.parse(raw));}catch(error){if(purpose==='review'&&error instanceof ApiError&&[403,404,409].includes(error.status))return {unavailable:error.code};throw error;}},apply}};
export async function agreementContent(ctx:ApiContext,registry:ApprovalRegistry=agreementContentActions):Promise<Reply|null> {
 const collection=/^agreements\/([^/]+)\/content-bindings$/.exec(ctx.path),item=/^agreement-content-bindings\/([^/]+)$/.exec(ctx.path);if(!collection&&!item)return null;
 const params=Object.fromEntries(new URL(ctx.request.url).searchParams);
 if(collection) {
  const templateId=uuid.parse(collection[1]);
  if(ctx.request.method==='POST'){z.object({}).strict().parse(params);const i={...input.parse(await jsonBody(ctx.request,131072)),templateId};await sources(ctx,i,true);return propose(ctx,registry,'agreement.content.bind',null,0,i);}
  if(ctx.request.method!=='GET')throw new ApiError(405,'METHOD_NOT_ALLOWED');
  await template(ctx,templateId);const q=query.parse(params),scopes=(await approvalReadParameters(ctx))[4];
  // Current file/domain/source rights filter BEFORE paging; a known template
  // or historical approval cannot disclose hidden file references or counts.
  const rows=(await ctx.db.query<{id:string}>(`SELECT b.id,b.template_id,b.template_version,b.file_id,b.file_version,b.locale,b.created_at
   FROM public.agreement_content_bindings b JOIN public.approval_requests p ON p.academy_id=b.academy_id AND p.id=b.approval_id
   WHERE b.template_id=$1 AND public.approval_bindings_allow(p.privacy_bindings,$2::jsonb) AND($3::uuid IS NULL OR b.id>$3) ORDER BY b.id LIMIT $4`,[templateId,scopes,q.after??null,q.limit+1])).rows;
  return {status:200,body:{data:rows.slice(0,q.limit).map(r=>({...r,...flags})),nextCursor:rows.length>q.limit?rows[q.limit-1].id:null}};
 }
 if(ctx.request.method!=='GET')throw new ApiError(405,'METHOD_NOT_ALLOWED');z.object({}).strict().parse(params);
 const row=await permittedAgreementContent(ctx,uuid.parse(item![1]));
 return {status:200,body:{data:{...row,...flags}}};
}
export const agreementContentContract=[
 {path:'/api/v1/agreements/{id}/content-bindings',method:'post',summary:'Request human-reviewed inspected PDF identity and field geometry bound to an immutable agreement revision; not send or admission clearance',schema:input},
 {path:'/api/v1/agreements/{id}/content-bindings',method:'get',summary:'Current-permission filtered reviewed PDF identity history; no file bytes or provider calls',querySchema:query},
 {path:'/api/v1/agreement-content-bindings/{id}',method:'get',summary:'Private immutable PDF identity, geometry and human equivalence attestation; not a safe-file or legal validation receipt'}
] as const;
