import { z } from 'zod';
import { jsonBody,record,type ApiContext,type Reply } from '../core/api.ts';
import { propose,permissionScope,type ApprovalRegistry,type Proposal } from '../core/approvals.ts';
import { ApiError,requireScope,scopeContains,scopeNonempty,type Capability } from '../core/policy.ts';
import { lockAcademyTopology } from './academy.ts';

const uuid=z.string().uuid().transform(v=>v.toLowerCase()),version=z.number().int().min(1).max(2147483647),text=z.string().refine(v=>v.isWellFormed()&&!v.includes('\0'));
const label=text.pipe(z.string().trim().min(1).max(150)),labels=z.object({en:label,fr:label.optional(),'zh-CN':label.optional()}).strict();
export const achievementTypeDefinition=z.object({name:text.pipe(z.string().trim().min(1).max(200)),description:text.max(2000).default(''),active:z.boolean().default(true),kind:z.enum(['badge','certificate','milestone']).default('badge'),icon:z.enum(['robot','trophy','star','team','code','medal']).default('medal'),points:z.number().int().min(0).max(10000).default(0),labels}).strict();
const reason=text.pipe(z.string().trim().min(1).max(2000)),input=z.object({hubId:uuid.nullable().default(null),definition:achievementTypeDefinition,reason}).strict();
const completeDefinition=achievementTypeDefinition.extend({description:text.max(2000),active:z.boolean(),kind:z.enum(['badge','certificate','milestone']),icon:z.enum(['robot','trophy','star','team','code','medal']),points:z.number().int().min(0).max(10000)});
const createPayload=input.extend({copiedFrom:z.object({id:uuid,version}).strict().nullable().default(null)}),updateInput=z.object({expectedVersion:version,definition:completeDefinition,reason}).strict();
const duplicateInput=z.object({expectedSourceVersion:version,hubId:uuid.nullable().optional().describe('Omit to keep the source ownership; null explicitly requests a shared school template.'),name:text.pipe(z.string().trim().min(1).max(200)),reason}).strict();
const query=z.object({limit:z.coerce.number().int().min(1).max(100).default(50),after:uuid.optional(),hubId:uuid.optional(),includeShared:z.enum(['true','false']).default('true').transform(v=>v==='true'),active:z.enum(['true','false']).transform(v=>v==='true').optional(),q:text.pipe(z.string().trim().min(1).max(100)).optional()}).strict();
const historyQuery=z.object({limit:z.coerce.number().int().min(1).max(20).default(5),afterVersion:z.coerce.number().int().min(0).max(2147483647).default(0)}).strict(),empty=z.object({}).strict();
export const standardAchievementType={name:'First robotics project',description:'Editable school-issued achievement; not an externally accredited qualification.',active:true,kind:'badge' as const,icon:'robot' as const,points:0,labels:{en:'First robotics project',fr:'Premier projet de robotique','zh-CN':'首个机器人项目'}};
type Definition=z.infer<typeof achievementTypeDefinition>;
type AchievementType={id:string;hub_id:string|null;version:number;definition:Definition;copied_from_id:string|null;copied_from_version:number|null;[key:string]:unknown};
function scope(ctx:ApiContext,cap:Capability){const s=permissionScope(ctx,cap);if(!scopeNonempty(s))throw new ApiError(403,'FORBIDDEN');return s;}
async function row(ctx:ApiContext,id:string,edit=false){
 const s=scope(ctx,'achievement-types.view'),r=(await ctx.db.query<{item:AchievementType}>('SELECT to_jsonb(r) item FROM public.achievement_types r WHERE id=$1',[id])).rows[0]?.item;
 if(!r)throw new ApiError(404,'NOT_FOUND');if(r.hub_id&&!scopeContains(s,{all:false,hubs:[r.hub_id]}))throw new ApiError(404,'NOT_FOUND');if(edit)requireScope(scope(ctx,'achievement-types.edit'),r.hub_id??undefined);return r;
}
async function validate(ctx:ApiContext,creating:boolean,id:string,raw:unknown){
 await lockAcademyTopology(ctx);let hubId:string|null;
 if(creating){const i=createPayload.parse(raw);hubId=i.hubId;requireScope(scope(ctx,'achievement-types.edit'),hubId??undefined);requireScope(scope(ctx,'achievement-types.view'),hubId??undefined);if(i.copiedFrom)await row(ctx,i.copiedFrom.id);}
 else{updateInput.parse(raw);hubId=(await row(ctx,id,true)).hub_id;requireScope(scope(ctx,'achievement-types.view'),hubId??undefined);}
 return hubId?{all:false,hubs:[hubId]}:{all:true,hubs:[]};
}
async function basis(ctx:ApiContext,creating:boolean,id:string,raw:unknown){
 const i=creating?createPayload.parse(raw):updateInput.parse(raw),r=creating?null:await row(ctx,id,true);
 if(r&&r.version!==('expectedVersion'in i?i.expectedVersion:0))throw new ApiError(409,'TARGET_CHANGED');
 const copied='copiedFrom'in i?i.copiedFrom:null,hubId='hubId'in i?i.hubId:r!.hub_id;
 const actual=(await ctx.db.query<{basis:{hub:{active:boolean}|null}|null}>('SELECT public.achievement_type_basis($1,$2,$3,$4) basis',[id,hubId,copied?.id??null,copied?.version??null])).rows[0].basis;
 if(!actual||i.definition.active&&actual.hub&&!actual.hub.active)throw new ApiError(409,'ACHIEVEMENT_TYPE_SOURCE_CHANGED');return actual;
}
async function apply(ctx:ApiContext,p:Proposal){
 if(ctx.credential.kind!=='human')throw new ApiError(403,'HUMAN_REVIEW_REQUIRED');const creating=p.action==='achievement-type.create',i=creating?createPayload.parse(p.payload):updateInput.parse(p.payload);
 try{
  if(creating){const c=createPayload.parse(i);await ctx.db.query('INSERT INTO public.achievement_types(academy_id,id,hub_id,definition,copied_from_id,copied_from_version,changed_by,approval_id,reason) VALUES($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9)',[ctx.credential.academy_id,p.target_id,c.hubId,JSON.stringify(c.definition),c.copiedFrom?.id??null,c.copiedFrom?.version??null,ctx.credential.person_id,p.id,c.reason]);}
  else await ctx.db.query('UPDATE public.achievement_types SET definition=$2::jsonb,version=version+1,changed_by=$3,approval_id=$4,reason=$5 WHERE id=$1',[p.target_id,JSON.stringify(i.definition),ctx.credential.person_id,p.id,i.reason]);
 }catch(error){if(error&&typeof error==='object'&&'code'in error&&error.code==='23514'&&'message'in error&&error.message==='ACHIEVEMENT_TYPE_EXACT_APPROVAL_REQUIRED')throw new ApiError(409,'ACHIEVEMENT_TYPE_SOURCE_CHANGED');throw error;}
 await ctx.db.query('INSERT INTO public.achievement_type_revisions(academy_id,type_id,version,definition) SELECT academy_id,id,version,to_jsonb(r) FROM public.achievement_types r WHERE id=$1',[p.target_id]);
 const r=await row(ctx,p.target_id);await record(ctx.db,ctx.credential,ctx.requestId,p.action,p.target_id,r.hub_id,{version:r.version,severity:'critical',hasReason:true});return {...r,studentAwardsCreated:false};
}
export const achievementTypeActions:ApprovalRegistry=Object.fromEntries(['achievement-type.create','achievement-type.update'].map(action=>[action,{
 requestCapability:'achievement-types.edit',privacyCapability:'achievement-types.view',policyChange:true,...action==='achievement-type.create'?{createdStatus:201 as const}:{},
 validate:(ctx:ApiContext,id:string,raw:unknown)=>validate(ctx,action==='achievement-type.create',id,raw),
 async dependencies(ctx:ApiContext,id:string,raw:unknown,purpose:'request'|'review'){try{return await basis(ctx,action==='achievement-type.create',id,raw);}catch(error){if(purpose==='review'&&error instanceof ApiError&&[403,404,409].includes(error.status))return {unavailable:error.code};throw error;}},apply
}])) as ApprovalRegistry;
export async function achievementTypes(ctx:ApiContext,registry:ApprovalRegistry=achievementTypeActions):Promise<Reply|null>{
 const path=/^achievement-types(?:\/([^/]+)(?:\/(change|history|duplicate))?)?$/.exec(ctx.path);if(!path)return null;
 const search=new URL(ctx.request.url).searchParams;if([...search].length!==new Set(search.keys()).size)throw new ApiError(400,'DUPLICATE_QUERY');const params=Object.fromEntries(search),method=ctx.request.method;
 if(path[1]==='presets'){if(path[2])throw new ApiError(404,'NOT_FOUND');if(method!=='GET')throw new ApiError(405,'METHOD_NOT_ALLOWED');empty.parse(params);scope(ctx,'achievement-types.view');return {status:200,body:{data:[{key:'kavosh-standard',definition:standardAchievementType}],persisted:false}};}
 const id=path[1]?uuid.parse(path[1]):null,section=path[2];
 if(method==='POST'){
  empty.parse(params);if(!id)return propose(ctx,registry,'achievement-type.create',null,0,{...input.parse(await jsonBody(ctx.request,65536)),copiedFrom:null});
  if(section==='change'){const i=updateInput.parse(await jsonBody(ctx.request,65536));return propose(ctx,registry,'achievement-type.update',id,i.expectedVersion,i);}
  if(section==='duplicate'){
   const i=duplicateInput.parse(await jsonBody(ctx.request));await row(ctx,id);
   const source=(await ctx.db.query<{definition:AchievementType}>('SELECT definition FROM public.achievement_type_revisions WHERE type_id=$1 AND version=$2',[id,i.expectedSourceVersion])).rows[0]?.definition;if(!source)throw new ApiError(404,'NOT_FOUND');
   // Build the same payload for an exact successful retry. A new request for
   // an outdated source still fails the native current-source dependency check.
   return propose(ctx,registry,'achievement-type.create',null,0,{hubId:i.hubId===undefined?source.hub_id:i.hubId,definition:{...source.definition,name:i.name},copiedFrom:{id,version:i.expectedSourceVersion},reason:i.reason});
  }throw new ApiError(405,'METHOD_NOT_ALLOWED');
 }
 if(method!=='GET')throw new ApiError(405,'METHOD_NOT_ALLOWED');
 if(id){const r=await row(ctx,id);if(section==='history'){const q=historyQuery.parse(params),rows=(await ctx.db.query<{version:number}>('SELECT version,definition,recorded_at FROM public.achievement_type_revisions WHERE type_id=$1 AND version>$2 ORDER BY version LIMIT $3',[id,q.afterVersion,q.limit+1])).rows;return {status:200,body:{data:rows.slice(0,q.limit),nextVersion:rows.length>q.limit?rows[q.limit-1].version:null}};}
  if(section)throw new ApiError(405,'METHOD_NOT_ALLOWED');empty.parse(params);return {status:200,body:{data:{...r}}};
 }
 const s=scope(ctx,'achievement-types.view'),q=query.parse(params),rows=(await ctx.db.query<{id:string}>(`SELECT r.id,r.hub_id,r.version,r.definition->>'name' name,(r.definition->>'active')::boolean active FROM public.achievement_types r
 WHERE((r.hub_id IS NULL AND $4::boolean) OR(r.hub_id IS NOT NULL AND($1::boolean OR r.hub_id=ANY($2::uuid[])) AND NOT r.hub_id=ANY($3::uuid[])))
 AND($5::uuid IS NULL OR r.hub_id=$5 OR(r.hub_id IS NULL AND $4)) AND($6::uuid IS NULL OR r.id>$6) AND($7::boolean IS NULL OR(r.definition->>'active')::boolean=$7)
 AND($8::text IS NULL OR position(lower($8) in lower(r.definition->>'name'))>0) ORDER BY r.id LIMIT $9`,[s.all,s.hubs,s.excludedHubs??[],q.includeShared,q.hubId??null,q.after??null,q.active??null,q.q??null,q.limit+1])).rows;
 return {status:200,body:{data:rows.slice(0,q.limit),nextCursor:rows.length>q.limit?rows[q.limit-1].id:null}};
}
export const achievementTypesContract=[
 {path:'/api/v1/achievement-types/presets',method:'get',summary:'Editable-copy robotics achievement suggestion in EN/FR/zh-CN; no awards,points or qualification issued'},
 {path:'/api/v1/achievement-types',method:'get',summary:'Permission-filtered shared/hub achievement-type catalogue before paging',querySchema:query},
 {path:'/api/v1/achievement-types',method:'post',summary:'Request reviewed versioned school achievement definition; configurable labels,icon,kind and points; no award or publication',schema:input},
 {path:'/api/v1/achievement-types/{id}',method:'get',summary:'Read an authorized achievement definition; history preserves earlier meanings'},
 {path:'/api/v1/achievement-types/{id}/change',method:'post',summary:'Upper-reviewed complete definition revision without changing immutable ownership',schema:updateInput},
 {path:'/api/v1/achievement-types/{id}/duplicate',method:'post',summary:'Review copy of an exact current source version into permitted ownership; independent later revisions',schema:duplicateInput},
 {path:'/api/v1/achievement-types/{id}/history',method:'get',summary:'Private immutable native-JSON achievement-type versions under current source rights',querySchema:historyQuery}
] as const;
