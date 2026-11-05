import { z } from 'zod';
import { jsonBody,record,type ApiContext,type Reply } from '../core/api.ts';
import { propose,permissionScope,lockApprovalWrites,type ApprovalRegistry,type Proposal } from '../core/approvals.ts';
import { ApiError,scopeContains,scopeNonempty,type Capability } from '../core/policy.ts';
import { lockAcademyTopology } from './academy.ts';
import { pollDefinition,pollAnchor,pollOwnerScope,pollOwnerSQL,pollResponseUnit,pollRespondentMode } from './poll-definition.ts';
import { pollTemplate,type PollTemplate } from './poll-template-source.ts';
import { pollTemplatePresets } from './poll-template-presets.ts';

const uuid=z.string().uuid().transform(v=>v.toLowerCase()),version=z.number().int().min(1).max(2147483647),text=z.string().refine(v=>v.isWellFormed()&&!v.includes('\0')),reason=text.pipe(z.string().trim().min(1).max(2000));
const fields={definition:pollDefinition,active:z.boolean(),responseUnit:pollResponseUnit,respondentMode:pollRespondentMode,reason};
const input=z.object({...fields,anchor:pollAnchor,active:z.boolean().default(true),responseUnit:pollResponseUnit.default('student_family'),respondentMode:pollRespondentMode.default('guardians')}).strict();
const createPayload=input.extend({copiedFrom:z.object({id:uuid,version}).strict().nullable().default(null)}),updateInput=z.object({...fields,expectedVersion:version}).strict();
const duplicateInput=z.object({expectedSourceVersion:version,anchor:pollAnchor.optional(),title:text.pipe(z.string().trim().min(1).max(200)),reason}).strict();
const query=z.object({limit:z.coerce.number().int().min(1).max(20).default(10),after:uuid.optional(),hubId:uuid.optional(),classId:uuid.optional(),kind:z.enum(['academy','hub','class']).optional(),locale:z.enum(['en','fr','zh-CN']).optional(),active:z.enum(['true','false']).transform(v=>v==='true').optional(),q:text.pipe(z.string().trim().min(1).max(100)).optional()}).strict();
const historyQuery=z.object({limit:z.coerce.number().int().min(1).max(10).default(5),afterVersion:z.coerce.number().int().min(0).max(2147483647).default(0)}).strict(),presetQuery=z.object({locale:z.enum(['en','fr','zh-CN']).optional()}).strict(),empty=z.object({}).strict();
type Basis={record:PollTemplate|null;owner:{hubId:string|null;classId:string|null;active:boolean};copy:PollTemplate|null};
async function basis(ctx:ApiContext,creating:boolean,id:string,raw:unknown){
 const i=creating?createPayload.parse(raw):updateInput.parse(raw),before=creating?null:await pollTemplate(ctx,id,true),anchor='anchor'in i?i.anchor:before!.anchor,copied='copiedFrom'in i?i.copiedFrom:null;
 if(before&&before.version!==('expectedVersion'in i?i.expectedVersion:0))throw new ApiError(409,'TARGET_CHANGED');
 const b=(await ctx.db.query<{basis:Basis|null}>('SELECT public.poll_template_basis($1,$2::jsonb,$3,$4) basis',[id,JSON.stringify(anchor),copied?.id??null,copied?.version??null])).rows[0].basis;if(!b||i.active&&!b.owner.active)throw new ApiError(409,'POLL_TEMPLATE_SOURCE_CHANGED');return b;
}
async function validate(ctx:ApiContext,creating:boolean,id:string,raw:unknown){
 await lockAcademyTopology(ctx);const i=creating?createPayload.parse(raw):updateInput.parse(raw);
 if(!creating){const r=await pollTemplate(ctx,id,true);return pollOwnerScope(r.anchor,r.hub_id);}
 const create=createPayload.parse(i),owner=(await ctx.db.query<{owner:Basis['owner']|null}>("SELECT public.poll_source($1::jsonb,statement_timestamp(),'[]'::jsonb)->'owner' owner",[JSON.stringify(create.anchor)])).rows[0].owner;
 if(!owner)throw new ApiError(404,'NOT_FOUND');for(const cap of ['poll-templates.view','poll-templates.edit'] as Capability[])if(!scopeContains(permissionScope(ctx,cap),pollOwnerScope(create.anchor,owner.hubId)))throw new ApiError(404,'NOT_FOUND');if(create.copiedFrom)await pollTemplate(ctx,create.copiedFrom.id);return pollOwnerScope(create.anchor,owner.hubId);
}
async function apply(ctx:ApiContext,p:Proposal){
 if(ctx.credential.kind!=='human')throw new ApiError(403,'HUMAN_REVIEW_REQUIRED');const creating=p.action==='poll-template.create',i=creating?createPayload.parse(p.payload):updateInput.parse(p.payload),b=p.review_context as unknown as Basis;
 try{if(creating){const c=createPayload.parse(i);await ctx.db.query('INSERT INTO public.poll_templates(academy_id,id,anchor,hub_id,class_id,active,definition,response_unit,respondent_mode,copied_from_id,copied_from_version,created_by,recorded_by,changed_by,approval_id,reason) VALUES($1,$2,$3::jsonb,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12,$12,$13,$14,$15)',[ctx.credential.academy_id,p.target_id,JSON.stringify(c.anchor),b.owner.hubId,b.owner.classId,c.active,JSON.stringify(c.definition),c.responseUnit,c.respondentMode,c.copiedFrom?.id??null,c.copiedFrom?.version??null,p.requester_id,ctx.credential.person_id,p.id,c.reason]);}
  else await ctx.db.query('UPDATE public.poll_templates SET version=version+1,definition=$2::jsonb,active=$3,response_unit=$4,respondent_mode=$5,recorded_by=$6,changed_by=$7,approval_id=$8,reason=$9 WHERE id=$1',[p.target_id,JSON.stringify(i.definition),i.active,i.responseUnit,i.respondentMode,p.requester_id,ctx.credential.person_id,p.id,i.reason]);
 }catch(error){if(error&&typeof error==='object'&&'code'in error&&error.code==='23514'&&'message'in error&&/^POLL_TEMPLATE_/.test(String(error.message)))throw new ApiError(409,'POLL_TEMPLATE_SOURCE_CHANGED');throw error;}
 await ctx.db.query('INSERT INTO public.poll_template_revisions(academy_id,template_id,version,definition) SELECT academy_id,id,version,to_jsonb(t) FROM public.poll_templates t WHERE id=$1',[p.target_id]);const r=await pollTemplate(ctx,p.target_id);await record(ctx.db,ctx.credential,ctx.requestId,p.action,p.target_id,r.hub_id,{version:r.version,severity:'critical',hasReason:true,externalDeliveryVerified:false});return r;
}
export const pollTemplateActions:ApprovalRegistry=Object.fromEntries(['poll-template.create','poll-template.update'].map(action=>[action,{
 requestCapability:'poll-templates.edit',privacyCapability:'poll-templates.view',policyChange:true,...action==='poll-template.create'?{createdStatus:201 as const}:{},
 validate:(ctx:ApiContext,id:string,raw:unknown)=>validate(ctx,action==='poll-template.create',id,raw),
 async dependencies(ctx:ApiContext,id:string,raw:unknown,purpose:'request'|'review'){try{return await basis(ctx,action==='poll-template.create',id,raw);}catch(error){if(purpose==='review'&&error instanceof ApiError&&[403,404,409].includes(error.status))return {unavailable:error.code};throw error;}},apply
}])) as ApprovalRegistry;
export async function pollTemplates(ctx:ApiContext,registry:ApprovalRegistry=pollTemplateActions):Promise<Reply|null>{
 const path=/^poll-templates(?:\/([^/]+)(?:\/(change|history|duplicate))?)?$/.exec(ctx.path);if(!path)return null;const method=ctx.request.method,params=Object.fromEntries(new URL(ctx.request.url).searchParams);
 if(path[1]==='presets'){if(path[2])throw new ApiError(404,'NOT_FOUND');if(method!=='GET')throw new ApiError(405,'METHOD_NOT_ALLOWED');const q=presetQuery.parse(params);await lockApprovalWrites(ctx);if(!scopeNonempty(permissionScope(ctx,'poll-templates.view')))throw new ApiError(403,'FORBIDDEN');return {status:200,body:{data:pollTemplatePresets.filter(p=>!q.locale||p.definition.locale===q.locale),persisted:false,requiresApprovedEditableCopy:true,pollsOrAnswersCreated:false}};}
 const id=path[1]?uuid.parse(path[1]):null,section=path[2];
 if(method==='POST'){empty.parse(params);if(!id)return propose(ctx,registry,'poll-template.create',null,0,{...input.parse(await jsonBody(ctx.request,131072)),copiedFrom:null});if(section==='change'){const i=updateInput.parse(await jsonBody(ctx.request,131072));return propose(ctx,registry,'poll-template.update',id,i.expectedVersion,i);}
  if(section==='duplicate'){const i=duplicateInput.parse(await jsonBody(ctx.request));await pollTemplate(ctx,id);const original=(await ctx.db.query<{definition:PollTemplate}>('SELECT definition FROM public.poll_template_revisions WHERE template_id=$1 AND version=$2',[id,i.expectedSourceVersion])).rows[0]?.definition;if(!original)throw new ApiError(404,'NOT_FOUND');return propose(ctx,registry,'poll-template.create',null,0,createPayload.parse({anchor:i.anchor??original.anchor,definition:{...original.definition,title:i.title},active:original.active,responseUnit:original.response_unit,respondentMode:original.respondent_mode,copiedFrom:{id,version:i.expectedSourceVersion},reason:i.reason}));}throw new ApiError(405,'METHOD_NOT_ALLOWED');
 }
 if(method!=='GET')throw new ApiError(405,'METHOD_NOT_ALLOWED');await lockApprovalWrites(ctx);
 if(id){const r=await pollTemplate(ctx,id);if(section==='history'){const q=historyQuery.parse(params),rows=(await ctx.db.query<{version:number;definition:PollTemplate|null}>(`WITH selected AS MATERIALIZED(SELECT version,definition FROM public.poll_template_revisions WHERE template_id=$1 AND version>$2 ORDER BY version LIMIT $3),budget AS(SELECT *,sum(octet_length(definition::text)) OVER(ORDER BY version) bytes FROM selected) SELECT version,CASE WHEN bytes<=2097152 THEN definition ELSE NULL END definition FROM budget ORDER BY version`,[id,q.afterVersion,q.limit+1])).rows,visible=rows.filter((r):r is typeof r&{definition:PollTemplate}=>r.definition!==null).slice(0,q.limit);if(rows.length&&!visible.length)throw new ApiError(409,'POLL_TEMPLATE_HISTORY_REQUIRES_BACKGROUND_JOB');return {status:200,body:{data:visible,nextVersion:rows.length>visible.length?visible.at(-1)!.version:null}};}if(section)throw new ApiError(405,'METHOD_NOT_ALLOWED');empty.parse(params);return {status:200,body:{data:r}};}
 const q=query.parse(params),s=permissionScope(ctx,'poll-templates.view');if(!scopeNonempty(s))throw new ApiError(403,'FORBIDDEN');const rows=(await ctx.db.query<{id:string}>(`SELECT p.id,p.anchor,p.hub_id,p.class_id,p.version,p.active,p.definition->>'title' title,p.definition->>'locale' locale FROM public.poll_templates p WHERE public.scope_contains($1::jsonb,${pollOwnerSQL}) AND($2::uuid IS NULL OR p.id>$2) AND($3::uuid IS NULL OR p.hub_id=$3) AND($4::uuid IS NULL OR p.class_id=$4) AND($5::text IS NULL OR p.anchor->>'kind'=$5) AND($6::text IS NULL OR p.definition->>'locale'=$6) AND($7::boolean IS NULL OR p.active=$7) AND($8::text IS NULL OR position(lower($8) in lower(p.definition->>'title'))>0) ORDER BY p.id LIMIT $9`,[JSON.stringify(s),q.after??null,q.hubId??null,q.classId??null,q.kind??null,q.locale??null,q.active??null,q.q??null,q.limit+1])).rows;return {status:200,body:{data:rows.slice(0,q.limit),nextCursor:rows.length>q.limit?rows[q.limit-1].id:null}};
}
export const pollTemplatesContract=[
 {path:'/api/v1/poll-templates/presets',method:'get',summary:'Six EN/FR/zh-CN parent-feedback/time-preference starting suggestions; save an approved editable copy, never automatic live polls',querySchema:presetQuery},
 {path:'/api/v1/poll-templates',method:'get',summary:'Question-template library filtered by explicit school/hub/class ownership before paging; school-wide access is not implied by class-only rights',querySchema:query},
 {path:'/api/v1/poll-templates',method:'post',summary:'Upper-reviewed persistent question and response-rule template; no audience, response, live notification or class rescheduling',schema:input},
 {path:'/api/v1/poll-templates/{id}',method:'get',summary:'Read an explicitly permitted current template and its response defaults'},
 {path:'/api/v1/poll-templates/{id}/change',method:'post',summary:'Upper-reviewed exact-version template content, response-rule or activation change; immutable ownership and copy provenance',schema:updateInput},
 {path:'/api/v1/poll-templates/{id}/duplicate',method:'post',summary:'Reviewed independent exact-version copy into permitted ownership; rename only on copy, edit contents later',schema:duplicateInput},
 {path:'/api/v1/poll-templates/{id}/history',method:'get',summary:'Private immutable template versions with ten-revision/two-MiB read bound',querySchema:historyQuery}
] as const;
