import { z } from 'zod';
import { jsonBody,record,type ApiContext,type Reply } from '../core/api.ts';
import { lockApprovalWrites,master,permissionScope,propose,type ApprovalRegistry,type Proposal } from '../core/approvals.ts';
import { ApiError,scopeAllowsRef } from '../core/policy.ts';

const uuid=z.string().uuid().transform(v=>v.toLowerCase()),text=z.string().trim().min(1).refine(v=>v.isWellFormed()&&!/[\u0000-\u001f\u007f]/.test(v));
const change=z.object({expectedNameVersion:z.number().int().min(0).max(2147483646),name:text.max(200),reason:text.max(2000)}).strict();
const paging=z.object({afterVersion:z.coerce.number().int().min(0).max(2147483647).default(0),limit:z.coerce.number().int().min(1).max(50).default(20)}).strict();
type Basis={id:string;name:string;hubId:string|null;nameVersion:number;[key:string]:unknown};
async function authority(ctx:ApiContext,id:string){
 const p=(await ctx.db.query<{b:Basis|null}>('SELECT public.bot_name_basis($1) b',[id])).rows[0]?.b;
 if(!p||['bots.view','bots.edit'].some(cap=>!scopeAllowsRef(permissionScope(ctx,cap as 'bots.view'|'bots.edit'),{id:p.id,hubId:p.hubId},'people')))throw new ApiError(404,'NOT_FOUND');
 if(!await master(ctx)){let actor=ctx.credential.person_id;if(ctx.credential.kind!=='human'){const owner=(await ctx.db.query<{owner_id:string|null}>('SELECT supervisor_person_id owner_id FROM public.people WHERE id=$1',[actor])).rows[0];if(!owner?.owner_id)throw new ApiError(403,'BOT_OWNER_REQUIRED');actor=owner.owner_id;}if(!(await ctx.db.query<{ok:boolean}>('SELECT public.is_supervisor($1,$2) ok',[actor,id])).rows[0]?.ok)throw new ApiError(403,'BOT_SUPERVISOR_REQUIRED');}
 return p;
}
async function apply(ctx:ApiContext,p:Proposal){
 if(ctx.credential.kind!=='human')throw new ApiError(403,'HUMAN_REVIEW_REQUIRED');const i=change.parse(p.payload);await authority(ctx,p.target_id);
 try{await ctx.db.query('SELECT id FROM public.people WHERE id=$1 FOR UPDATE NOWAIT',[p.target_id]);}catch(e){if(e&&typeof e==='object'&&'code' in e&&e.code==='55P03')throw new ApiError(423,'PERSON_BUSY_RETRY');throw e;}
 const b=await authority(ctx,p.target_id);if(b.nameVersion!==i.expectedNameVersion||p.target_version!==i.expectedNameVersion)throw new ApiError(409,'BOT_NAME_VERSION_CHANGED');if(b.name===i.name)throw new ApiError(409,'BOT_NAME_UNCHANGED');
 const version=i.expectedNameVersion+1;await ctx.db.query('INSERT INTO public.bot_name_changes(academy_id,person_id,version,before_name,after_name,source_basis,changed_by,approval_id,reason) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9)',[ctx.credential.academy_id,p.target_id,version,b.name,i.name,JSON.stringify(p.review_context),ctx.credential.person_id,p.id,i.reason]);
 await ctx.db.query('INSERT INTO public.bot_name_heads(academy_id,person_id,version) VALUES($1,$2,$3) ON CONFLICT(academy_id,person_id) DO UPDATE SET version=excluded.version',[ctx.credential.academy_id,p.target_id,version]);await ctx.db.query('UPDATE public.people SET name=$2 WHERE id=$1',[p.target_id,i.name]);
 await record(ctx.db,ctx.credential,ctx.requestId,'bot.rename',p.target_id,b.hubId,{before:{name:b.name},after:{name:i.name},nameVersion:version,approvalId:p.id,severity:'critical',permissionsChanged:false,credentialsChanged:false});return {id:p.target_id,name:i.name,nameVersion:version,permissionsChanged:false,credentialsChanged:false};
}
export const botNameActions:ApprovalRegistry={'bot.rename':{requestCapability:'bots.edit',privacyCapability:'bots.view',policyChange:true,
 async validate(ctx,id,raw){change.parse(raw);const b=await authority(ctx,id);return {all:false,hubs:[],people:[{id,hubId:b.hubId}]};},
 async dependencies(ctx,id,raw,purpose){try{const b=await authority(ctx,id),i=change.parse(raw);if(b.nameVersion!==i.expectedNameVersion)throw new ApiError(409,'BOT_NAME_VERSION_CHANGED');if(b.name===i.name)throw new ApiError(409,'BOT_NAME_UNCHANGED');return b;}catch(e){if(purpose==='review'&&e instanceof ApiError&&[403,404,409].includes(e.status))return {unavailable:e.code};throw e;}},apply}};
export async function botNames(ctx:ApiContext,registry:ApprovalRegistry=botNameActions):Promise<Reply|null>{
 const m=/^bots\/([^/]+)\/name(?:\/(history))?$/.exec(ctx.path);if(!m)return null;const id=uuid.parse(m[1]),params=new URL(ctx.request.url).searchParams;if([...params].length!==new Set(params.keys()).size)throw new ApiError(400,'DUPLICATE_QUERY');
 if(ctx.request.method==='POST'&&!m[2]){z.object({}).strict().parse(Object.fromEntries(params));await lockApprovalWrites(ctx,true);const i=change.parse(await jsonBody(ctx.request));return propose(ctx,registry,'bot.rename',id,i.expectedNameVersion,i);}
 if(ctx.request.method!=='GET'||!m[2])throw new ApiError(405,'METHOD_NOT_ALLOWED');await lockApprovalWrites(ctx);await authority(ctx,id);const q=paging.parse(Object.fromEntries(params)),rows=(await ctx.db.query<{version:number}>('SELECT version,before_name "beforeName",after_name "afterName",changed_by "changedBy",approval_id "approvalId",reason,created_at::text "changedAt" FROM public.bot_name_changes WHERE person_id=$1 AND version>$2 ORDER BY version LIMIT $3',[id,q.afterVersion,q.limit+1])).rows;return {status:200,body:{data:rows.slice(0,q.limit),nextVersion:rows.length>q.limit?rows[q.limit-1].version:null}};
}
export const botNamesContract=[
 {path:'/api/v1/bots/{id}/name',method:'post',summary:'Review a bot name change with independent name-version concurrency. Upper human approval or master self-entry;does not change access version,owner,roles,status or keys. Busy bot returns423 for safe retry.',schema:change},
 {path:'/api/v1/bots/{id}/name/history',method:'get',summary:'Bounded immutable before/after bot name and approval history for currently scoped bot editors/supervisors. Original registration stays unchanged.',querySchema:paging}
] as const;
