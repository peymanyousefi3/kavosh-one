import {z} from 'zod';
import {jsonBody,record,type ApiContext,type Reply} from '../core/api.ts';
import {permissionScope,propose,type ApprovalRegistry,type Proposal} from '../core/approvals.ts';
import {ApiError,requireScope} from '../core/policy.ts';
import {lockAcademyTopology} from './academy.ts';

const uuid=z.string().uuid().transform(v=>v.toLowerCase()),version=z.number().int().positive().max(2147483646),text=z.string().refine(v=>v.isWellFormed()&&!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(v)),reason=text.trim().min(1).max(2000);
export const websitePolicyCode=z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
export const websitePolicyKind=z.enum(['privacy_notice','terms_of_service','cookie_notice','accessibility_statement','acceptable_use','cancellation_refund','copyright_ip','security_contact','subprocessors','data_processing','retention_schedule','incident_response']);
const translation=z.object({title:text.trim().min(1).max(200).refine(v=>!/[\r\n\t]/.test(v)),body:text.trim().min(1).max(20000)}).strict();
export const websitePolicyContent=z.object({en:translation,fr:translation.optional(),'zh-CN':translation.optional()}).strict().refine(v=>Buffer.byteLength(JSON.stringify(v),'utf8')<=250000);
const create=z.object({code:websitePolicyCode,kind:websitePolicyKind,content:websitePolicyContent,reason}).strict(),change=z.object({expectedVersion:version,content:websitePolicyContent,reason}).strict();
const publication=z.object({expectedVersion:z.number().int().min(0).max(2147483646),documentVersion:version,documentSha256:z.string().regex(/^[a-f0-9]{64}$/),audience:z.enum(['public','internal','unpublished']),reviewReference:reason,reason}).strict();
const page=z.object({after:uuid.optional(),limit:z.coerce.number().int().min(1).max(50).default(25),locale:z.enum(['en','fr','zh-CN']).default('en')}).strict(),history=z.object({afterVersion:z.coerce.number().int().min(0).max(2147483647).default(0),limit:z.coerce.number().int().min(1).max(20).default(10)}).strict(),empty=z.object({}).strict();
type Head={id:string;code:string;kind:z.infer<typeof websitePolicyKind>;version:number;publication_version:number};
function authority(ctx:ApiContext,edit=false,publish=false){requireScope(permissionScope(ctx,'website-policies.view'));if(edit)requireScope(permissionScope(ctx,'website-policies.edit'));if(publish)requireScope(permissionScope(ctx,'website-policies.publish'));}
async function head(ctx:ApiContext,id:string,lock=false){const h=(await ctx.db.query<Head>('SELECT id,code,kind,version,publication_version FROM public.website_policies WHERE id=$1'+(lock?' FOR UPDATE':''),[id])).rows[0];if(!h)throw new ApiError(404,'NOT_FOUND');return h;}
async function basis(ctx:ApiContext,id:string,draft:number,published:number,selected=0){return(await ctx.db.query<{data:Record<string,unknown>}>('SELECT public.website_policy_basis($1,$2,$3,$4) data',[id,draft,published,selected])).rows[0].data;}
const flags={contentFormat:'plain_text',legalValidityCertified:false,signatureOrConsentRecorded:false,externalDeliveryPerformed:false};
async function checked(ctx:ApiContext,action:string,id:string,raw:unknown){
 await lockAcademyTopology(ctx);authority(ctx,action!=='website-policy.publish',action==='website-policy.publish');
 if(action==='website-policy.create'){const i=create.parse(raw);if((await ctx.db.query('SELECT 1 FROM public.website_policies WHERE code=$1',[i.code])).rows.length)throw new ApiError(409,'WEBSITE_POLICY_CODE_EXISTS');return {h:null,source:await basis(ctx,id,0,0)};}
 const h=await head(ctx,id,true);
 if(action==='website-policy.change'){const i=change.parse(raw);if(h.version!==i.expectedVersion)throw new ApiError(409,'TARGET_CHANGED');return {h,source:await basis(ctx,id,h.version,h.publication_version)};}
 const i=publication.parse(raw);if(h.publication_version!==i.expectedVersion)throw new ApiError(409,'WEBSITE_POLICY_PUBLICATION_CHANGED');
 const selected=(await ctx.db.query<{content_sha256:string}>('SELECT content_sha256 FROM public.website_policy_revisions WHERE policy_id=$1 AND version=$2',[id,i.documentVersion])).rows[0];if(!selected||selected.content_sha256!==i.documentSha256)throw new ApiError(409,'WEBSITE_POLICY_EDITION_CHANGED');
 if(h.kind==='incident_response'&&i.audience==='public')throw new ApiError(409,'INTERNAL_POLICY_PUBLICATION_FORBIDDEN');
 if(i.audience==='unpublished'&&!(await ctx.db.query('SELECT 1 FROM public.website_policy_publications WHERE policy_id=$1 AND version=$2 AND document_version=$3 AND audience<>\'unpublished\'',[id,h.publication_version,i.documentVersion])).rows.length)throw new ApiError(409,'WEBSITE_POLICY_PUBLICATION_CHANGED');
 return {h,source:await basis(ctx,id,h.version,h.publication_version,i.documentVersion)};
}
async function apply(ctx:ApiContext,p:Proposal){
 if(ctx.credential.kind!=='human')throw new ApiError(403,'HUMAN_REVIEW_REQUIRED');const b=await checked(ctx,p.action,p.target_id,p.payload);
 if(p.action==='website-policy.publish'){
  const i=publication.parse(p.payload);await ctx.db.query('UPDATE public.website_policies SET publication_version=publication_version+1 WHERE id=$1',[p.target_id]);
  await ctx.db.query('INSERT INTO public.website_policy_publications(academy_id,policy_id,version,document_version,audience,review_reference,changed_by,approval_id,reason) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[ctx.credential.academy_id,p.target_id,i.expectedVersion+1,i.documentVersion,i.audience,i.reviewReference,ctx.credential.person_id,p.id,i.reason]);
 }else{
  const creating=p.action==='website-policy.create',i=creating?create.parse(p.payload):change.parse(p.payload),v=(b.h?.version??0)+1;
  if(creating){const c=create.parse(i);await ctx.db.query('INSERT INTO public.website_policies(academy_id,id,code,kind) VALUES($1,$2,$3,$4)',[ctx.credential.academy_id,p.target_id,c.code,c.kind]);}
  else await ctx.db.query('UPDATE public.website_policies SET version=version+1 WHERE id=$1',[p.target_id]);
  await ctx.db.query('INSERT INTO public.website_policy_revisions(academy_id,policy_id,version,content,changed_by,approval_id,reason) VALUES($1,$2,$3,$4::jsonb,$5,$6,$7)',[ctx.credential.academy_id,p.target_id,v,JSON.stringify(i.content),ctx.credential.person_id,p.id,i.reason]);
 }
 await record(ctx.db,ctx.credential,ctx.requestId,p.action,p.target_id,null,{approvalId:p.id,severity:'critical',privateReviewContentIncluded:false});return detail(ctx,p.target_id);
}
export const websitePolicyActions:ApprovalRegistry=Object.fromEntries(['website-policy.create','website-policy.change','website-policy.publish'].map(action=>[action,{
 requestCapability:action==='website-policy.publish'?'website-policies.publish':'website-policies.edit',privacyCapability:'website-policies.view',policyChange:true,createdStatus:action==='website-policy.create'?201:200,
 async validate(ctx:ApiContext,id:string,raw:unknown){
  await lockAcademyTopology(ctx);authority(ctx,action!=='website-policy.publish',action==='website-policy.publish');
  // Current access is checked before the idempotency cache. Version/unique-code
  // conflicts belong in dependencies after it,so exact successful retries work.
  if(action==='website-policy.create')create.parse(raw);else{(action==='website-policy.publish'?publication:change).parse(raw);await head(ctx,id);}
  return {all:true,hubs:[]};
 },
 async dependencies(ctx:ApiContext,id:string,raw:unknown,purpose:'request'|'review'){try{return(await checked(ctx,action,id,raw)).source;}catch(e){if(purpose==='review'&&e instanceof ApiError&&[403,404,409].includes(e.status))return {unavailable:e.code};throw e;}},apply
}])) as ApprovalRegistry;
async function detail(ctx:ApiContext,id:string){const h=await head(ctx,id),draft=(await ctx.db.query('SELECT version,content,content_sha256,changed_by,approval_id,reason,created_at FROM public.website_policy_revisions WHERE policy_id=$1 AND version=$2',[id,h.version])).rows[0],published=h.publication_version?(await ctx.db.query('SELECT p.*,r.content,r.content_sha256 FROM public.website_policy_publications p JOIN public.website_policy_revisions r ON r.academy_id=p.academy_id AND r.policy_id=p.policy_id AND r.version=p.document_version WHERE p.policy_id=$1 AND p.version=$2',[id,h.publication_version])).rows[0]:null;return {...h,draft,publication:published,...flags};}
export async function websitePolicies(ctx:ApiContext,registry:ApprovalRegistry=websitePolicyActions):Promise<Reply|null>{
 const m=/^website-policies(?:\/([^/]+)(?:\/(change|history|publication|publication-history))?)?$/.exec(ctx.path);if(!m)return null;authority(ctx);const id=m[1]?uuid.parse(m[1]):null,section=m[2],params=new URL(ctx.request.url).searchParams;if([...params].length!==new Set(params.keys()).size)throw new ApiError(400,'DUPLICATE_QUERY');
 if(ctx.request.method==='POST'){empty.parse(Object.fromEntries(params));if(!id){const i=create.parse(await jsonBody(ctx.request,262144));return propose(ctx,registry,'website-policy.create',null,0,i);}if(section==='change'){const i=change.parse(await jsonBody(ctx.request,262144));return propose(ctx,registry,'website-policy.change',id,i.expectedVersion,i);}if(section==='publication'){const i=publication.parse(await jsonBody(ctx.request));return propose(ctx,registry,'website-policy.publish',id,i.expectedVersion,i);}throw new ApiError(405,'METHOD_NOT_ALLOWED');}
 if(ctx.request.method!=='GET'||section==='change')throw new ApiError(405,'METHOD_NOT_ALLOWED');
 if(!id){const q=page.parse(Object.fromEntries(params)),rows=(await ctx.db.query<Head>('SELECT h.id,h.code,h.kind,h.version,h.publication_version,coalesce(r.content->$3,r.content->\'en\')->>\'title\' AS title,CASE WHEN r.content?$3 THEN $3 ELSE \'en\' END AS locale FROM public.website_policies h JOIN public.website_policy_revisions r ON r.academy_id=h.academy_id AND r.policy_id=h.id AND r.version=h.version WHERE($1::uuid IS NULL OR h.id>$1) ORDER BY h.id LIMIT $2',[q.after??null,q.limit+1,q.locale])).rows;return {status:200,body:{data:rows.slice(0,q.limit),nextCursor:rows.length>q.limit?rows[q.limit-1].id:null,...flags}};}
 await head(ctx,id);if(section==='history'||section==='publication-history'){const q=history.parse(Object.fromEntries(params)),rows=(await ctx.db.query<{version:number}>('SELECT * FROM public.'+(section==='history'?'website_policy_revisions':'website_policy_publications')+' WHERE policy_id=$1 AND version>$2 ORDER BY version LIMIT $3',[id,q.afterVersion,q.limit+1])).rows;return {status:200,body:{data:rows.slice(0,q.limit),nextVersion:rows.length>q.limit?rows[q.limit-1].version:null,...flags}};}
 empty.parse(Object.fromEntries(params));const data=await detail(ctx,id);return {status:200,body:{data:section==='publication'?data.publication:data,...flags}};
}
export const websitePoliciesContract=[
 {path:'/api/v1/website-policies',method:'get',summary:'Whole-school authorized website-policy draft catalogue;no anonymous draft access',querySchema:page},
 {path:'/api/v1/website-policies',method:'post',summary:'Propose a reviewed localized plain-text website policy,not a signed enrollment agreement or certified legal text',schema:create},
 {path:'/api/v1/website-policies/{id}',method:'get',summary:'Authorized current draft and separately pinned publication;draft edits do not replace published text'},
 {path:'/api/v1/website-policies/{id}/change',method:'post',summary:'Upper-human-reviewed complete draft revision;published edition remains unchanged',schema:change},
 {path:'/api/v1/website-policies/{id}/history',method:'get',summary:'Private immutable content editions with exact native content hashes',querySchema:history},
 {path:'/api/v1/website-policies/{id}/publication',method:'get',summary:'Private exact currently published/internal/withdrawn edition and its review record'},
 {path:'/api/v1/website-policies/{id}/publication',method:'post',summary:'Human-reviewed exact-hash public/internal publication or withdrawal;separate permission,no incident-plan public exposure,no signature/consent or legal certification',schema:publication},
 {path:'/api/v1/website-policies/{id}/publication-history',method:'get',summary:'Private immutable publication/withdrawal history;no policy text or reviewer notes in generic notifications',querySchema:history}
] as const;
