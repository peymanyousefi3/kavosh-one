import {z} from 'zod';
import {isDeepStrictEqual} from 'node:util';
import {jsonBody,record,type ApiContext,type Reply} from '../core/api.ts';
import {permissionScope,propose,master,lockApprovalWrites,type ApprovalRegistry} from '../core/approvals.ts';
import {ApiError,scopeContains,type Scope,type Capability} from '../core/policy.ts';
import {lockAcademyTopology} from './academy.ts';
import {permittedFile} from './files.ts';
import {achievementHeader} from './achievements.ts';

const uuid=z.string().uuid().transform(v=>v.toLowerCase()),version=z.number().int().positive().max(2147483647),text=z.string().trim().min(1).max(300).refine(v=>v.isWellFormed()&&!/[\p{Cc}]/u.test(v));
const alt=z.object({en:text,fr:text.optional(),'zh-CN':text.optional()}).strict();
const choice=z.discriminatedUnion('kind',[z.object({kind:z.literal('avatar'),alt}).strict(),z.object({kind:z.literal('achievement'),awardId:uuid,awardVersion:version,assetVersion:version,attachmentNo:z.number().int().min(1).max(10),alt}).strict()]);
const selection=z.array(choice).max(100).refine(v=>new Set(v.map(x=>x.kind==='avatar'?'avatar':x.awardId+':'+x.attachmentNo)).size===v.length).refine(v=>Buffer.byteLength(JSON.stringify(v))<=60000);
const input=z.object({expectedVersion:z.number().int().min(0).max(2147483646),state:z.enum(['published','withdrawn']),selection,reason:z.string().trim().min(1).max(2000).refine(v=>v.isWellFormed()&&!/[\p{Cc}]/u.test(v))}).strict().refine(v=>v.state==='withdrawn'?v.selection.length===0:v.selection.length>0);
const history=z.object({afterVersion:z.coerce.number().int().min(0).max(2147483647).default(0),limit:z.coerce.number().int().min(1).max(10).default(5)}).strict(),empty=z.object({}).strict();
type Owner={kind:'academy'|'hub'|'person';id:string;hubId:string|null;scope:Scope};
type Source={profile:{owner:Owner};images:{choice:z.infer<typeof choice>;file:{fileId:string}}[];eligible:boolean};
type Revision={version:number;state:string;selection:z.infer<typeof selection>;source:Source;changed_by:string;created_at:string};
async function latest(ctx:ApiContext,id:string){return(await ctx.db.query<{r:Revision}>('SELECT to_jsonb(r) r FROM public.profile_image_releases r WHERE profile_id=$1 ORDER BY version DESC LIMIT 1',[id])).rows[0]?.r??null;}
async function owner(ctx:ApiContext,id:string,edit=false){
 const b=(await ctx.db.query<{b:{owner:Owner}|null}>('SELECT public.profile_publication_basis($1) b',[id])).rows[0]?.b;if(!b?.owner)throw new ApiError(404,'NOT_FOUND');const o=b.owner;
 const student=o.kind==='person'&&(await ctx.db.query<{yes:boolean}>('SELECT EXISTS(SELECT 1 FROM public.student_profiles WHERE person_id=$1) yes',[o.id])).rows[0].yes;
 const caps:Capability[]=['profiles.view','profile-images.view'];if(edit)caps.push('profile-images.publish');
 if(o.kind==='person')caps.push(student?'student-profiles.view':'worker-profiles.view');
 for(const cap of caps)if(!scopeContains(permissionScope(ctx,cap),o.scope))throw new ApiError(404,'NOT_FOUND');return o;
}
async function imageRights(ctx:ApiContext,s:Source|null|undefined){if(!s)return;for(const id of new Set(s.images.map(x=>x.file.fileId)))await permittedFile(ctx,id);for(const id of new Set(s.images.flatMap(x=>x.choice.kind==='achievement'?[x.choice.awardId]:[])))await achievementHeader(ctx,id);}
async function basis(ctx:ApiContext,id:string,raw:unknown){const i=input.parse(raw);await owner(ctx,id,true);const before=await latest(ctx,id);if((before?.version??0)!==i.expectedVersion)throw new ApiError(409,'PROFILE_IMAGE_RELEASE_CHANGED');await imageRights(ctx,before?.source);const s=(await ctx.db.query<{s:Source|null}>('SELECT public.profile_image_source($1,$2,$3::jsonb) s',[id,i.state,JSON.stringify(i.selection)])).rows[0].s;if(!s)throw new ApiError(409,'PROFILE_IMAGE_SOURCE_UNAVAILABLE');await imageRights(ctx,s);return{before,source:s};}
export const profileImageActions:ApprovalRegistry={'profile-images.publish':{
 requestCapability:'profile-images.publish',privacyCapability:'profile-images.view',policyChange:true,
 async validate(ctx,id,raw){await lockAcademyTopology(ctx);const i=input.parse(raw),o=await owner(ctx,id,true),before=await latest(ctx,id);await imageRights(ctx,before?.source);
  // Authorization runs before idempotency lookup. Recheck original-file rights
  // for a retained acknowledgement,but leave version/source conflicts inside
  // the actual mutation so an exact retry does not become a second edit.
  const replay=(await ctx.db.query<{source:Source}>('SELECT source FROM public.profile_image_releases WHERE profile_id=$1 AND version=$2',[id,i.expectedVersion+1])).rows[0];await imageRights(ctx,replay?.source);for(const c of i.selection)if(c.kind==='achievement')await achievementHeader(ctx,c.awardId);
  const s=(await ctx.db.query<{s:Source|null}>('SELECT public.profile_image_source($1,$2,$3::jsonb) s',[id,i.state,JSON.stringify(i.selection)])).rows[0].s;await imageRights(ctx,s);return o.scope;},
 async dependencies(ctx,id,raw,purpose){try{return await basis(ctx,id,raw);}catch(e){if(purpose==='review'&&e instanceof ApiError&&[400,403,404,409].includes(e.status))return{unavailable:e.code};throw e;}},
 async authorizeReviewer(ctx,p){if(await master(ctx))return;const o=await owner(ctx,p.target_id,true);if(o.kind==='person'&&(o.id===ctx.credential.person_id||(await ctx.db.query('SELECT 1 FROM public.family_relationships WHERE student_id=$1 AND guardian_id=$2',[o.id,ctx.credential.person_id])).rows.length))throw new ApiError(403,'BENEFICIARY_REVIEW_FORBIDDEN');},
 async apply(ctx,p){if(ctx.credential.kind!=='human')throw new ApiError(403,'HUMAN_REVIEW_REQUIRED');const i=input.parse(p.payload),b=await basis(ctx,p.target_id,i);if(!isDeepStrictEqual(b,p.review_context))throw new ApiError(409,'PROFILE_IMAGE_SOURCE_CHANGED');const r=await ctx.db.query('INSERT INTO public.profile_image_releases(academy_id,profile_id,version,state,selection,source,changed_by,approval_id,reason) VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8,$9) RETURNING version',[ctx.credential.academy_id,p.target_id,i.expectedVersion+1,i.state,JSON.stringify(i.selection),JSON.stringify(b.source),ctx.credential.person_id,p.id,i.reason]);if(r.rows.length!==1)throw Error('PROFILE_IMAGE_EFFECT_MISSING');await record(ctx.db,ctx.credential,ctx.requestId,p.action,p.target_id,b.source.profile.owner.hubId,{version:i.expectedVersion+1,state:i.state,imageCount:i.selection.length,approvalId:p.id,severity:'critical',privateContentRedacted:true});return{profileId:p.target_id,version:i.expectedVersion+1,state:i.state,imageCount:i.selection.length,derivativesPrepared:false,imagesServed:false};}
}};
export async function profileImages(ctx:ApiContext,registry:ApprovalRegistry=profileImageActions):Promise<Reply|null>{
 const m=/^community\/profiles\/([^/]+)\/image-release(?:\/(history))?$/.exec(ctx.path);if(!m)return null;const id=uuid.parse(m[1]),p=new URL(ctx.request.url).searchParams;if([...p].length!==new Set(p.keys()).size)throw new ApiError(400,'DUPLICATE_QUERY');const q=Object.fromEntries(p);
 if(ctx.request.method==='POST'&&!m[2]){empty.parse(q);const i=input.parse(await jsonBody(ctx.request,131072));await lockApprovalWrites(ctx,true);return propose(ctx,registry,'profile-images.publish',id,i.expectedVersion,i);}
 if(ctx.request.method!=='GET')throw new ApiError(405,'METHOD_NOT_ALLOWED');await lockApprovalWrites(ctx);await lockAcademyTopology(ctx);await owner(ctx,id);
 if(m[2]){const h=history.parse(q),rows=(await ctx.db.query<Revision>('SELECT * FROM public.profile_image_releases WHERE profile_id=$1 AND version>$2 ORDER BY version LIMIT $3',[id,h.afterVersion,h.limit+1])).rows;for(const r of rows)await imageRights(ctx,r.source);return{status:200,body:{data:rows.slice(0,h.limit).map(r=>({version:r.version,state:r.state,selection:r.selection,changedBy:r.changed_by,recordedAt:r.created_at})),nextVersion:rows.length>h.limit?rows[h.limit-1].version:null}};}
 empty.parse(q);const r=await latest(ctx,id);await imageRights(ctx,r?.source);const s=r?(await ctx.db.query<{s:Source|null}>('SELECT public.profile_image_source($1,$2,$3::jsonb) s',[id,r.state,JSON.stringify(r.selection)])).rows[0].s:null;return{status:200,body:{data:{profileId:id,version:r?.version??0,state:r?.state??'withdrawn',selection:r?.selection??[],sourceCurrent:!!r&&s!==null&&isDeepStrictEqual(s,r.source),derivativesPrepared:false,imagesServed:false}}};
}
export const profileImagesContract=[
 {path:'/api/v1/community/profiles/{id}/image-release',method:'get',summary:'Private exact reviewed image selection and current-source status;separate image/profile and file/achievement authority,not image delivery'},
 {path:'/api/v1/community/profiles/{id}/image-release',method:'post',summary:'Upper-human-reviewed explicit avatar or selected achievement image release. Current profile visibility/consent,exact academic/asset editions and verified private copies are required. Text-only publication never implies images;withdrawal leaves originals untouched. No rendering,storage write or public delivery during approval.',schema:input},
 {path:'/api/v1/community/profiles/{id}/image-release/history',method:'get',summary:'Current-authorized immutable reviewed image-selection history;no raw storage source,consent evidence or bearer URLs',querySchema:history}
]as const;
