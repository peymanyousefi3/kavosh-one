import { z } from 'zod';
import { jsonBody,record,type ApiContext,type Reply } from '../core/api.ts';
import { permissionScope,master,lockApprovalWrites,propose,type ApprovalRegistry,type Proposal } from '../core/approvals.ts';
import { ApiError,scopeAllowsRef,scopeNonempty,requireScope,type Scope } from '../core/policy.ts';

const uuid=z.string().uuid().transform(v=>v.toLowerCase());
const text=z.string().trim().min(1).refine(v=>v.isWellFormed()&&!/[\u0000-\u001f\u007f]/.test(v));
const create=z.object({name:text.max(200),hubId:uuid.nullable(),ownerId:uuid,expectedOwnerVersion:z.number().int().positive().max(2147483647),reason:text.max(2000)}).strict();
const paging=z.object({limit:z.coerce.number().int().min(1).max(100).default(50),after:uuid.optional(),hubId:uuid.optional(),ownerId:uuid.optional(),status:z.enum(['active','disabled']).optional()}).strict();
type Basis={schoolStatus:string;owner:{id:string;kind:string;status:string;hubId:string|null;version:number;verified:boolean};hub:{id:string;version:number;active:boolean}|null};
async function basis(ctx:ApiContext,raw:unknown){const i=create.parse(raw),b=(await ctx.db.query<{b:Basis|null}>('SELECT public.bot_registration_basis($1,$2) b',[i.ownerId,i.hubId])).rows[0]?.b;if(!b)throw new ApiError(404,'BOT_OWNER_NOT_FOUND');return b;}
async function source(ctx:ApiContext,raw:unknown):Promise<Scope>{
 const i=create.parse(raw),b=await basis(ctx,i);if(b.schoolStatus!=='active'||b.owner.kind!=='human'||b.owner.status!=='active'||!b.owner.verified||i.hubId!==null&&!b.hub?.active)throw new ApiError(409,'BOT_OWNER_OR_HUB_UNAVAILABLE');if(b.owner.version!==i.expectedOwnerVersion)throw new ApiError(409,'BOT_OWNER_CHANGED');
 for(const cap of ['bots.view','bots.edit'] as const){const s=permissionScope(ctx,cap);requireScope(s,i.hubId??undefined);if(!scopeAllowsRef(s,{id:b.owner.id,hubId:b.owner.hubId},'people'))throw new ApiError(404,'BOT_OWNER_NOT_FOUND');}
 if(!await master(ctx)){
  let manager=ctx.credential.person_id;if(ctx.credential.kind!=='human'){const p=(await ctx.db.query<{owner_id:string|null}>('SELECT supervisor_person_id owner_id FROM public.people WHERE id=$1',[manager])).rows[0];if(!p?.owner_id)throw new ApiError(403,'BOT_OWNER_REQUIRED');manager=p.owner_id;}
  if(manager!==i.ownerId&&!(await ctx.db.query<{ok:boolean}>('SELECT public.is_supervisor($1,$2) ok',[manager,i.ownerId])).rows[0]?.ok)throw new ApiError(403,'BOT_OWNER_HIERARCHY_REQUIRED');
 }
 return i.hubId===null?{all:true,hubs:[]}:{all:false,hubs:[i.hubId]};
}
async function apply(ctx:ApiContext,p:Proposal){
 if(ctx.credential.kind!=='human')throw new ApiError(403,'HUMAN_REVIEW_REQUIRED');const i=create.parse(p.payload);await source(ctx,i);
 await ctx.db.query('INSERT INTO public.bot_account_registrations(academy_id,person_id,name,hub_id,owner_id,owner_version,source_basis,changed_by,approval_id,reason) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10)',[ctx.credential.academy_id,p.target_id,i.name,i.hubId,i.ownerId,i.expectedOwnerVersion,JSON.stringify(p.review_context),ctx.credential.person_id,p.id,i.reason]);
 await ctx.db.query("INSERT INTO public.people(academy_id,id,kind,name,hub_id,supervisor_person_id) VALUES($1,$2,'bot',$3,$4,$5)",[ctx.credential.academy_id,p.target_id,i.name,i.hubId,i.ownerId]);
 await record(ctx.db,ctx.credential,ctx.requestId,p.action,p.target_id,i.hubId,{ownerId:i.ownerId,approvalId:p.id,severity:'critical',rolesGranted:0,credentialIssued:false,hasReason:true});
 return {id:p.target_id,name:i.name,hubId:i.hubId,ownerId:i.ownerId,status:'active',version:1,nameVersion:0,creationGrantedPermissions:false,creationIssuedCredential:false};
}
export const botAccountActions:ApprovalRegistry={'bot.create':{requestCapability:'bots.edit',privacyCapability:'bots.view',policyChange:true,createdStatus:201,
 validate:async(ctx,id,raw)=>source(ctx,raw),async dependencies(ctx,id,raw,purpose){try{await source(ctx,raw);return await basis(ctx,raw) as unknown as Record<string,unknown>;}catch(e){if(purpose==='review'&&e instanceof ApiError&&[403,404,409].includes(e.status))return {unavailable:e.code};throw e;}},apply}};
const fields='p.id,p.name,coalesce((SELECT h.version FROM public.bot_name_heads h WHERE h.academy_id=p.academy_id AND h.person_id=p.id),0) "nameVersion",p.hub_id "hubId",coalesce(p.supervisor_person_id,a.master_person_id) "ownerId",p.supervisor_person_id IS NOT NULL "explicitOwner",p.status,p.access_version version,r.person_id IS NOT NULL "registrationEvidenceAvailable"';
const visible=`public.scope_contains($1::jsonb,jsonb_build_object('all',false,'hubs','[]'::jsonb,'people',jsonb_build_array(jsonb_build_object('id',p.id,'hubId',p.hub_id))))`;
export async function botAccounts(ctx:ApiContext,registry:ApprovalRegistry=botAccountActions):Promise<Reply|null>{
 const m=/^bots(?:\/([^/]+)(?:\/(registration))?)?$/.exec(ctx.path);if(!m)return null;const id=m[1]?uuid.parse(m[1]):null,params=new URL(ctx.request.url).searchParams;if([...params].length!==new Set(params.keys()).size)throw new ApiError(400,'DUPLICATE_QUERY');const q=Object.fromEntries(params);
 if(ctx.request.method==='POST'&&!id){z.object({}).strict().parse(q);await lockApprovalWrites(ctx,true);return propose(ctx,registry,'bot.create',null,0,create.parse(await jsonBody(ctx.request)));}
 if(ctx.request.method!=='GET')throw new ApiError(405,'METHOD_NOT_ALLOWED');await lockApprovalWrites(ctx);const s=permissionScope(ctx,'bots.view');if(!scopeNonempty(s))throw new ApiError(403,'FORBIDDEN');
 if(id){z.object({}).strict().parse(q);const p=(await ctx.db.query<{id:string;hubId:string|null;registrationEvidenceAvailable:boolean}>(`SELECT ${fields} FROM public.people p JOIN public.academies a ON a.id=p.academy_id LEFT JOIN public.bot_account_registrations r ON r.academy_id=p.academy_id AND r.person_id=p.id WHERE p.id=$2 AND p.kind='bot' AND ${visible}`,[JSON.stringify(s),id])).rows[0];if(!p)throw new ApiError(404,'NOT_FOUND');if(m[2]){if(!scopeAllowsRef(permissionScope(ctx,'bots.edit'),{id:p.id,hubId:p.hubId},'people'))throw new ApiError(403,'FORBIDDEN');const r=(await ctx.db.query('SELECT person_id "personId",name,hub_id "hubId",owner_id "ownerId",owner_version "ownerVersion",changed_by "approvedBy",approval_id "approvalId",reason,created_at::text "registeredAt" FROM public.bot_account_registrations WHERE person_id=$1',[id])).rows[0];if(!r)throw new ApiError(404,'BOT_REGISTRATION_EVIDENCE_UNAVAILABLE');return {status:200,body:{data:r,registrationImmutable:true}};}return {status:200,body:{data:p,authenticationStatus:'not_assessed'}};}
 const i=paging.parse(q),rows=(await ctx.db.query<{id:string}>(`SELECT ${fields} FROM public.people p JOIN public.academies a ON a.id=p.academy_id LEFT JOIN public.bot_account_registrations r ON r.academy_id=p.academy_id AND r.person_id=p.id WHERE p.kind='bot' AND ${visible} AND($2::uuid IS NULL OR p.id>$2) AND($3::uuid IS NULL OR p.hub_id=$3) AND($4::uuid IS NULL OR coalesce(p.supervisor_person_id,a.master_person_id)=$4) AND($5::text IS NULL OR p.status=$5) ORDER BY p.id LIMIT $6`,[JSON.stringify(s),i.after??null,i.hubId??null,i.ownerId??null,i.status??null,i.limit+1])).rows;return {status:200,body:{data:rows.slice(0,i.limit),nextCursor:rows.length>i.limit?rows[i.limit-1].id:null,authenticationStatus:'not_assessed'}};
}
export const botAccountsContract=[
 {path:'/api/v1/bots',method:'post',summary:'Create an owned bot account through upper-human review;master self-approves. Verified human owner and permitted active hub required. No role permissions or API credential are issued automatically.',schema:create},
 {path:'/api/v1/bots',method:'get',summary:'Current-permission-filtered bot directory,including labelled legacy accounts,with bounded cursor and owner/hub/status filters. Does not expose API keys or assess key validity.',querySchema:paging},
 {path:'/api/v1/bots/{id}',method:'get',summary:'Read a currently permitted bot account and whether portal registration evidence exists;not authentication material.'},
 {path:'/api/v1/bots/{id}/registration',method:'get',summary:'Editor-only immutable original registration,owner/version,approval and reason;legacy operator accounts explicitly have no fabricated portal registration.'}
] as const;
