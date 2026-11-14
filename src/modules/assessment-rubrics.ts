import { z } from 'zod';
import { jsonBody,record,type ApiContext,type Reply } from '../core/api.ts';
import { propose,permissionScope,type ApprovalRegistry,type Proposal } from '../core/approvals.ts';
import { ApiError,requireScope,scopeNonempty,type Capability } from '../core/policy.ts';
import { lockAcademyTopology } from './academy.ts';

const uuid=z.string().uuid().transform(v=>v.toLowerCase()),version=z.number().int().min(1).max(2147483647),text=z.string().refine(v=>v.isWellFormed()&&!v.includes('\0'));
const label=text.pipe(z.string().trim().min(1).max(150)),labels=z.object({en:label,fr:label.optional(),'zh-CN':label.optional()}).strict();
const criterion=z.object({code:z.string().regex(/^[a-z][a-z0-9_]{0,39}$/),labels}).strict();
export const assessmentDefinition=z.object({name:text.pipe(z.string().trim().min(1).max(200)),description:text.max(2000).default(''),active:z.boolean().default(true),criteria:z.array(criterion).min(1).max(30).refine(v=>new Set(v.map(c=>c.code)).size===v.length,'Duplicate criterion code')}).strict();
const reason=text.pipe(z.string().trim().min(1).max(2000)),input=z.object({hubId:uuid.nullable().default(null),definition:assessmentDefinition,reason}).strict();
const completeDefinition=assessmentDefinition.extend({description:text.max(2000),active:z.boolean()});
const createPayload=input.extend({copiedFrom:z.object({id:uuid,version}).strict().nullable().default(null)}),updateInput=z.object({expectedVersion:version,definition:completeDefinition,reason}).strict();
const duplicateInput=z.object({expectedSourceVersion:version,hubId:uuid.nullable().optional().describe('Omit to keep the source ownership; null explicitly requests a shared school template.'),name:text.pipe(z.string().trim().min(1).max(200)),reason}).strict();
const query=z.object({limit:z.coerce.number().int().min(1).max(100).default(50),after:uuid.optional(),hubId:uuid.optional(),includeShared:z.enum(['true','false']).default('true').transform(v=>v==='true'),active:z.enum(['true','false']).transform(v=>v==='true').optional(),q:text.pipe(z.string().trim().min(1).max(100)).optional()}).strict();
const historyQuery=z.object({limit:z.coerce.number().int().min(1).max(20).default(5),afterVersion:z.coerce.number().int().min(0).max(2147483647).default(0)}).strict(),empty=z.object({}).strict();
export const standardAssessmentRubric={name:'Student session development',description:'Standard Kavosh criteria; copy and edit as needed.',active:true,criteria:[
 {code:'focus',labels:{en:'Focus',fr:'Concentration','zh-CN':'专注力'}},{code:'performance',labels:{en:'Performance',fr:'Performance','zh-CN':'表现'}},
 {code:'teamwork',labels:{en:'Teamwork',fr:"Travail d’équipe",'zh-CN':'团队合作'}},{code:'behaviour',labels:{en:'Behaviour',fr:'Comportement','zh-CN':'行为'}},
 {code:'problem_solving',labels:{en:'Problem solving',fr:'Résolution de problèmes','zh-CN':'解决问题'}},{code:'recall',labels:{en:'Remembering previous modules',fr:'Rappel des modules précédents','zh-CN':'回顾先前模块'}}
]};
type Definition=z.infer<typeof assessmentDefinition>;
type Rubric={id:string;hub_id:string|null;version:number;definition:Definition;copied_from_id:string|null;copied_from_version:number|null;[key:string]:unknown};
function scope(ctx:ApiContext,cap:Capability){const s=permissionScope(ctx,cap);if(!scopeNonempty(s))throw new ApiError(403,'FORBIDDEN');return s;}
async function row(ctx:ApiContext,id:string,edit=false){
 const s=scope(ctx,'assessment-rubrics.view'),r=(await ctx.db.query<{rubric:Rubric}>('SELECT to_jsonb(r) rubric FROM public.assessment_rubrics r WHERE id=$1',[id])).rows[0]?.rubric;
 if(!r)throw new ApiError(404,'NOT_FOUND');if(r.hub_id)requireScope(s,r.hub_id);if(edit)requireScope(scope(ctx,'assessment-rubrics.edit'),r.hub_id??undefined);return r;
}
async function validate(ctx:ApiContext,creating:boolean,id:string,raw:unknown){
 await lockAcademyTopology(ctx);let hubId:string|null;
 if(creating){const i=createPayload.parse(raw);hubId=i.hubId;requireScope(scope(ctx,'assessment-rubrics.edit'),hubId??undefined);requireScope(scope(ctx,'assessment-rubrics.view'),hubId??undefined);if(i.copiedFrom)await row(ctx,i.copiedFrom.id);}
 else{updateInput.parse(raw);hubId=(await row(ctx,id,true)).hub_id;requireScope(scope(ctx,'assessment-rubrics.view'),hubId??undefined);}
 return hubId?{all:false,hubs:[hubId]}:{all:true,hubs:[]};
}
async function basis(ctx:ApiContext,creating:boolean,id:string,raw:unknown){
 const i=creating?createPayload.parse(raw):updateInput.parse(raw),r=creating?null:await row(ctx,id,true);
 if(r&&r.version!==('expectedVersion'in i?i.expectedVersion:0))throw new ApiError(409,'TARGET_CHANGED');
 const copied='copiedFrom'in i?i.copiedFrom:null,hubId='hubId'in i?i.hubId:r!.hub_id;
 const actual=(await ctx.db.query<{basis:{hub:{active:boolean}|null}|null}>('SELECT public.assessment_rubric_basis($1,$2,$3,$4) basis',[id,hubId,copied?.id??null,copied?.version??null])).rows[0].basis;
 if(!actual||i.definition.active&&actual.hub&&!actual.hub.active)throw new ApiError(409,'RUBRIC_SOURCE_CHANGED');return actual;
}
async function apply(ctx:ApiContext,p:Proposal){
 if(ctx.credential.kind!=='human')throw new ApiError(403,'HUMAN_REVIEW_REQUIRED');const creating=p.action==='assessment-rubric.create',i=creating?createPayload.parse(p.payload):updateInput.parse(p.payload);
 try{
  if(creating){const c=createPayload.parse(i);await ctx.db.query('INSERT INTO public.assessment_rubrics(academy_id,id,hub_id,definition,copied_from_id,copied_from_version,changed_by,approval_id,reason) VALUES($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9)',[ctx.credential.academy_id,p.target_id,c.hubId,JSON.stringify(c.definition),c.copiedFrom?.id??null,c.copiedFrom?.version??null,ctx.credential.person_id,p.id,c.reason]);}
  else await ctx.db.query('UPDATE public.assessment_rubrics SET definition=$2::jsonb,version=version+1,changed_by=$3,approval_id=$4,reason=$5 WHERE id=$1',[p.target_id,JSON.stringify(i.definition),ctx.credential.person_id,p.id,i.reason]);
 }catch(error){if(error&&typeof error==='object'&&'code'in error&&error.code==='23514'&&'message'in error&&error.message==='RUBRIC_EXACT_APPROVAL_REQUIRED')throw new ApiError(409,'RUBRIC_SOURCE_CHANGED');throw error;}
 await ctx.db.query('INSERT INTO public.assessment_rubric_revisions(academy_id,rubric_id,version,definition) SELECT academy_id,id,version,to_jsonb(r) FROM public.assessment_rubrics r WHERE id=$1',[p.target_id]);
 const r=await row(ctx,p.target_id);await record(ctx.db,ctx.credential,ctx.requestId,p.action,p.target_id,r.hub_id,{version:r.version,severity:'critical',hasReason:true});return {...r,scale:{minimum:1,maximum:5},studentScoresCreated:false};
}
export const assessmentRubricActions:ApprovalRegistry=Object.fromEntries(['assessment-rubric.create','assessment-rubric.update'].map(action=>[action,{
 requestCapability:'assessment-rubrics.edit',privacyCapability:'assessment-rubrics.view',policyChange:true,...action==='assessment-rubric.create'?{createdStatus:201 as const}:{},
 validate:(ctx:ApiContext,id:string,raw:unknown)=>validate(ctx,action==='assessment-rubric.create',id,raw),
 async dependencies(ctx:ApiContext,id:string,raw:unknown,purpose:'request'|'review'){try{return await basis(ctx,action==='assessment-rubric.create',id,raw);}catch(error){if(purpose==='review'&&error instanceof ApiError&&[403,404,409].includes(error.status))return {unavailable:error.code};throw error;}},apply
}])) as ApprovalRegistry;
export async function assessmentRubrics(ctx:ApiContext,registry:ApprovalRegistry=assessmentRubricActions):Promise<Reply|null>{
 const path=/^assessment-rubrics(?:\/([^/]+)(?:\/(change|history|duplicate))?)?$/.exec(ctx.path);if(!path)return null;
 const params=Object.fromEntries(new URL(ctx.request.url).searchParams),method=ctx.request.method;
 if(path[1]==='presets'){if(path[2])throw new ApiError(404,'NOT_FOUND');if(method!=='GET')throw new ApiError(405,'METHOD_NOT_ALLOWED');empty.parse(params);scope(ctx,'assessment-rubrics.view');return {status:200,body:{data:[{key:'kavosh-standard',definition:standardAssessmentRubric}],scale:{minimum:1,maximum:5},persisted:false}};}
 const id=path[1]?uuid.parse(path[1]):null,section=path[2];
 if(method==='POST'){
  empty.parse(params);if(!id)return propose(ctx,registry,'assessment-rubric.create',null,0,{...input.parse(await jsonBody(ctx.request,65536)),copiedFrom:null});
  if(section==='change'){const i=updateInput.parse(await jsonBody(ctx.request,65536));return propose(ctx,registry,'assessment-rubric.update',id,i.expectedVersion,i);}
  if(section==='duplicate'){
   const i=duplicateInput.parse(await jsonBody(ctx.request));await row(ctx,id);
   const source=(await ctx.db.query<{definition:Rubric}>('SELECT definition FROM public.assessment_rubric_revisions WHERE rubric_id=$1 AND version=$2',[id,i.expectedSourceVersion])).rows[0]?.definition;if(!source)throw new ApiError(404,'NOT_FOUND');
   // Build the same payload for an exact successful retry. A new request for
   // an outdated source still fails the native current-source dependency check.
   return propose(ctx,registry,'assessment-rubric.create',null,0,{hubId:i.hubId===undefined?source.hub_id:i.hubId,definition:{...source.definition,name:i.name},copiedFrom:{id,version:i.expectedSourceVersion},reason:i.reason});
  }throw new ApiError(405,'METHOD_NOT_ALLOWED');
 }
 if(method!=='GET')throw new ApiError(405,'METHOD_NOT_ALLOWED');
 if(id){const r=await row(ctx,id);if(section==='history'){const q=historyQuery.parse(params),rows=(await ctx.db.query<{version:number}>('SELECT version,definition,recorded_at FROM public.assessment_rubric_revisions WHERE rubric_id=$1 AND version>$2 ORDER BY version LIMIT $3',[id,q.afterVersion,q.limit+1])).rows;return {status:200,body:{data:rows.slice(0,q.limit),nextVersion:rows.length>q.limit?rows[q.limit-1].version:null}};}
  if(section)throw new ApiError(405,'METHOD_NOT_ALLOWED');empty.parse(params);return {status:200,body:{data:{...r,scale:{minimum:1,maximum:5}}}};
 }
 const s=scope(ctx,'assessment-rubrics.view'),q=query.parse(params),rows=(await ctx.db.query<{id:string}>(`SELECT r.id,r.hub_id,r.version,r.definition->>'name' name,(r.definition->>'active')::boolean active FROM public.assessment_rubrics r
 WHERE((r.hub_id IS NULL AND $4::boolean) OR(r.hub_id IS NOT NULL AND($1::boolean OR r.hub_id=ANY($2::uuid[])) AND NOT r.hub_id=ANY($3::uuid[])))
 AND($5::uuid IS NULL OR r.hub_id=$5 OR(r.hub_id IS NULL AND $4)) AND($6::uuid IS NULL OR r.id>$6) AND($7::boolean IS NULL OR(r.definition->>'active')::boolean=$7)
 AND($8::text IS NULL OR position(lower($8) in lower(r.definition->>'name'))>0) ORDER BY r.id LIMIT $9`,[s.all,s.hubs,s.excludedHubs??[],q.includeShared,q.hubId??null,q.after??null,q.active??null,q.q??null,q.limit+1])).rows;
 return {status:200,body:{data:rows.slice(0,q.limit),nextCursor:rows.length>q.limit?rows[q.limit-1].id:null}};
}
export const assessmentRubricsContract=[
 {path:'/api/v1/assessment-rubrics/presets',method:'get',summary:'Standard six editable-copy criteria in EN/FR/zh-CN; read-only factory preset, not student scores'},
 {path:'/api/v1/assessment-rubrics',method:'get',summary:'Permission-filtered shared/hub criterion catalogue before paging',querySchema:query},
 {path:'/api/v1/assessment-rubrics',method:'post',summary:'Request reviewed versioned 1–5 assessment-criterion template; no scores or family publication',schema:input},
 {path:'/api/v1/assessment-rubrics/{id}',method:'get',summary:'Read authorized current rubric; history preserves earlier meanings'},
 {path:'/api/v1/assessment-rubrics/{id}/change',method:'post',summary:'Upper-reviewed complete definition revision without changing immutable ownership',schema:updateInput},
 {path:'/api/v1/assessment-rubrics/{id}/duplicate',method:'post',summary:'Review copy of an exact current source version into permitted ownership; independent later revisions',schema:duplicateInput},
 {path:'/api/v1/assessment-rubrics/{id}/history',method:'get',summary:'Private immutable native-JSON rubric versions under current source rights',querySchema:historyQuery}
] as const;
