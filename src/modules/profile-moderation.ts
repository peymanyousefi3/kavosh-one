import { z } from 'zod';
import { isDeepStrictEqual } from 'node:util';
import { jsonBody,record,type ApiContext,type Reply } from '../core/api.ts';
import { permissionScope,propose,master,lockApprovalWrites,type ApprovalRegistry } from '../core/approvals.ts';
import { ApiError,scopeContains,type Scope } from '../core/policy.ts';
import { lockAcademyTopology } from './academy.ts';

const uuid=z.string().uuid().transform(v=>v.toLowerCase()),version=z.number().int().min(0).max(2147483646),reason=z.string().trim().min(1).max(2000).refine(v=>v.isWellFormed()&&!/[\u0000-\u001f\u007f]/.test(v));
const change=z.object({expectedVersion:version,expectedProfileVersion:z.number().int().positive().max(2147483647),restricted:z.boolean(),reason}).strict(),empty=z.object({}).strict(),history=z.object({afterVersion:z.coerce.number().int().min(0).max(2147483647).default(0),limit:z.coerce.number().int().min(1).max(20).default(10)}).strict();
type State={version:number;restricted:boolean};
type Basis=State&{profileId:string;profileVersion:number;owner:{kind:string;id:string;hubId:string|null;scope:Scope}|null};
export async function profileModerationState(ctx:ApiContext,id:string){const s=(await ctx.db.query<{s:State|null}>('SELECT public.profile_moderation_state($1) s',[id])).rows[0]?.s;if(!s)throw new ApiError(404,'NOT_FOUND');return s;}
async function basis(ctx:ApiContext,id:string,edit=false){const b=(await ctx.db.query<{b:Basis|null}>('SELECT public.profile_moderation_basis($1) b',[id])).rows[0]?.b;if(!b?.owner)throw new ApiError(404,'NOT_FOUND');for(const cap of edit?['profile-moderation.view','profile-moderation.edit'] as const:['profile-moderation.view'] as const)if(!scopeContains(permissionScope(ctx,cap),b.owner.scope))throw new ApiError(404,'NOT_FOUND');return b as Basis&{owner:NonNullable<Basis['owner']>};}
export const profileModerationActions:ApprovalRegistry={'community-profile.moderate':{
 requestCapability:'profile-moderation.edit',privacyCapability:'profile-moderation.view',policyChange:true,
 async validate(ctx,id,raw){change.parse(raw);await lockAcademyTopology(ctx);return(await basis(ctx,id,true)).owner.scope;},
 async dependencies(ctx,id,raw,purpose){try{const i=change.parse(raw),b=await basis(ctx,id,true);if(b.version!==i.expectedVersion||b.profileVersion!==i.expectedProfileVersion)throw new ApiError(409,'PROFILE_MODERATION_SOURCE_CHANGED');if(b.restricted===i.restricted)throw new ApiError(409,'PROFILE_MODERATION_UNCHANGED');return b;}catch(e){if(purpose==='review'&&e instanceof ApiError&&[403,404,409].includes(e.status))return {unavailable:e.code};throw e;}},
 async authorizeReviewer(ctx,p){const b=await basis(ctx,p.target_id,true);if(!await master(ctx)&&b.owner.kind==='person'&&b.owner.id===ctx.credential.person_id)throw new ApiError(403,'BENEFICIARY_REVIEW_FORBIDDEN');},
 async apply(ctx,p){if(ctx.credential.kind!=='human')throw new ApiError(403,'HUMAN_REVIEW_REQUIRED');const i=change.parse(p.payload);await ctx.db.query('SELECT id FROM public.community_profiles WHERE id=$1 FOR SHARE',[p.target_id]);const b=await basis(ctx,p.target_id,true);if(!isDeepStrictEqual(b,p.review_context))throw new ApiError(409,'PROFILE_MODERATION_SOURCE_CHANGED');const v=i.expectedVersion+1;
  await ctx.db.query('INSERT INTO public.profile_moderation_changes(academy_id,profile_id,version,before_restricted,restricted,source_basis,changed_by,approval_id,reason) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9)',[ctx.credential.academy_id,p.target_id,v,b.restricted,i.restricted,JSON.stringify(b),ctx.credential.person_id,p.id,i.reason]);await ctx.db.query('INSERT INTO public.profile_moderation_heads(academy_id,profile_id,version) VALUES($1,$2,$3) ON CONFLICT(academy_id,profile_id) DO UPDATE SET version=excluded.version',[ctx.credential.academy_id,p.target_id,v]);
  await record(ctx.db,ctx.credential,ctx.requestId,p.action,p.target_id,b.owner.hubId,{version:v,profileVersion:b.profileVersion,restricted:i.restricted,approvalId:p.id,severity:'critical',privateContentRedacted:true,publicationEnabled:false});return {profileId:p.target_id,version:v,restricted:i.restricted,profileVersion:b.profileVersion,publicationEnabled:false};
 }
}};
export async function profileModeration(ctx:ApiContext,registry:ApprovalRegistry=profileModerationActions):Promise<Reply|null>{
 const m=/^community\/profiles\/([^/]+)\/moderation(?:\/(history))?$/.exec(ctx.path);if(!m)return null;const id=uuid.parse(m[1]),params=new URL(ctx.request.url).searchParams;if([...params].length!==new Set(params.keys()).size)throw new ApiError(400,'DUPLICATE_QUERY');const raw=Object.fromEntries(params);
 if(ctx.request.method==='POST'&&!m[2]){empty.parse(raw);const i=change.parse(await jsonBody(ctx.request));await lockApprovalWrites(ctx,true);return propose(ctx,registry,'community-profile.moderate',id,i.expectedVersion,i);}
 if(ctx.request.method!=='GET')throw new ApiError(405,'METHOD_NOT_ALLOWED');await lockAcademyTopology(ctx);const b=await basis(ctx,id);
 if(m[2]){const q=history.parse(raw),rows=(await ctx.db.query<{version:number}>('SELECT version,before_restricted AS "beforeRestricted",restricted,source_basis AS "sourceBasis",changed_by AS "changedBy",approval_id AS "approvalId",reason,created_at::text AS "changedAt" FROM public.profile_moderation_changes WHERE profile_id=$1 AND version>$2 ORDER BY version LIMIT $3',[id,q.afterVersion,q.limit+1])).rows;return {status:200,body:{data:rows.slice(0,q.limit),nextVersion:rows.length>q.limit?rows[q.limit-1].version:null}};}empty.parse(raw);return {status:200,body:{data:{profileId:id,profileVersion:b.profileVersion,version:b.version,restricted:b.restricted,publicationEnabled:false}}};
}
export const profileModerationContract=[
 {path:'/api/v1/community/profiles/{id}/moderation',method:'get',summary:'Current independent community profile restriction under scoped profile-moderation.view,without draft text or private reasons. Unset means version0/unrestricted,never publication or consent permission.'},
 {path:'/api/v1/community/profiles/{id}/moderation',method:'post',summary:'Propose an independent exact-profile-version restriction or restoration. Upper human review,master self-approval,source-version recheck and immutable private reason/history. Restricted owners cannot edit their profile or issue new self-avatar links;administrator remediation does not clear restriction. Restoration does not publish or authorize consent.',schema:change},
 {path:'/api/v1/community/profiles/{id}/moderation/history',method:'get',summary:'Bounded private immutable restriction/restoration reasons,reviewed source references and approval history under current scoped moderation view,not self-profile rights.',querySchema:history}
] as const;
