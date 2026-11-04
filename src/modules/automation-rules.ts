import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { jsonBody,record,type ApiContext,type Reply } from '../core/api.ts';
import { propose,permissionScope,lockApprovalWrites,type ApprovalRegistry,type Proposal } from '../core/approvals.ts';
import { ApiError,requireScope,scopeNonempty,type Capability } from '../core/policy.ts';
import { automationDefinition,automationLanguage,ruleSample,simulateRule,type AutomationDefinition } from '../core/automation-rules.ts';
import { lockAcademyTopology } from './academy.ts';
import { permittedPeople } from './students.ts';
import { boundAutomationEvent,boundEventView } from './automation-events.ts';

const uuid=z.string().uuid().transform(v=>v.toLowerCase()),version=z.number().int().positive().max(2147483647),reason=z.string().trim().min(1).max(2000).refine(v=>v.isWellFormed()&&!v.includes('\0'));
const code=z.string().regex(/^[A-Z0-9][A-Z0-9._-]{0,63}$/),create=z.object({hubId:uuid.nullable().default(null),code,definition:automationDefinition,reason}).strict(),change=z.object({expectedVersion:version,definition:automationDefinition,reason}).strict();
const duplicate=z.object({sourceVersion:version,hubId:uuid.nullable(),code,name:z.string().trim().min(1).max(200),reason}).strict();
const query=z.object({limit:z.coerce.number().int().min(1).max(100).default(50),after:uuid.optional(),hubId:uuid.optional(),enabled:z.enum(['true','false']).transform(v=>v==='true').optional()}).strict(),read=z.object({version:z.coerce.number().int().positive().max(2147483647).optional()}).strict(),history=z.object({limit:query.shape.limit,afterVersion:z.coerce.number().int().min(0).max(2147483647).default(0)}).strict();
const preview=z.object({version:version.optional(),sample:ruleSample,locale:z.enum(['en','fr','zh-CN']).default('en')}).strict();
const eventPreview=z.object({version:version.optional(),eventId:uuid,locale:z.enum(['en','fr','zh-CN']).default('en')}).strict();
type Header={id:string;hub_id:string|null;code:string;version:number};
function allowed(ctx:ApiContext,cap:Capability){const s=permissionScope(ctx,cap);if(!scopeNonempty(s))throw new ApiError(403,'FORBIDDEN');return s;}
function parameters(ctx:ApiContext){const s=allowed(ctx,'automations.view');return [s.all,s.hubs,s.excludedHubs??[],!s.excludedAreas?.length];}
const selected=`((r.hub_id IS NULL AND $1::boolean AND cardinality($3::uuid[])=0 AND $4::boolean) OR(r.hub_id IS NOT NULL AND($1::boolean OR r.hub_id=ANY($2::uuid[])) AND NOT r.hub_id=ANY($3::uuid[])))`;
async function header(ctx:ApiContext,id:string,edit=false){const r=(await ctx.db.query<Header>('SELECT r.* FROM public.automation_rules r WHERE '+selected+' AND r.id=$5',[...parameters(ctx),id])).rows[0];if(!r)throw new ApiError(404,'NOT_FOUND');if(edit)requireScope(allowed(ctx,'automations.edit'),r.hub_id??undefined);return r;}
async function revision(ctx:ApiContext,r:Header,v=r.version){const row=(await ctx.db.query<{version:number;definition:AutomationDefinition}>('SELECT version,definition FROM public.automation_rule_revisions WHERE rule_id=$1 AND version=$2',[r.id,v])).rows[0];if(!row)throw new ApiError(404,'NOT_FOUND');return row;}
export {header as automationRuleHeader,revision as automationRuleRevision};
async function detail(ctx:ApiContext,r:Header,v?:number){return {id:r.id,hubId:r.hub_id,code:r.code,latestVersion:r.version,...await revision(ctx,r,v),runtimeActive:false,configurationOnly:true};}
async function basis(ctx:ApiContext,creating:boolean,id:string,raw:unknown){const i=creating?create.parse(raw):change.parse(raw),before=creating?null:await header(ctx,id,true),hubId=before?before.hub_id:'hubId' in i?i.hubId:null;
 requireScope(allowed(ctx,'automations.view'),hubId??undefined);requireScope(allowed(ctx,'automations.edit'),hubId??undefined);
 if(before&&'expectedVersion' in i&&i.expectedVersion!==before.version)throw new ApiError(409,'AUTOMATION_RULE_CHANGED');
 const hub=hubId?(await ctx.db.query('SELECT id,version,active FROM public.hubs WHERE id=$1',[hubId])).rows[0]:null;if(hubId&&(!hub||(i.definition.enabled&&!hub.active)))throw new ApiError(409,'ACTIVE_AUTOMATION_HUB_REQUIRED');
 if(before&&!i.definition.enabled){const prior=await revision(ctx,before);if(isDeepStrictEqual({...prior.definition,enabled:false},i.definition))return {before,hub,recipients:[],disableOnly:true};}
 const ids=[...new Set(i.definition.actions.flatMap(a=>a.audience.kind==='people'?a.audience.personIds:[]))].sort(),recipients=[];
 for(const p of await permittedPeople(ctx,ids,'people.view')){if(i.definition.enabled&&p.status!=='active')throw new ApiError(409,'HUMAN_AUTOMATION_RECIPIENT_REQUIRED');if(hubId!==null&&p.hub_id!==hubId)throw new ApiError(400,'AUTOMATION_AUDIENCE_HUB_MISMATCH');recipients.push({id:p.id,hubId:p.hub_id,status:p.status});}
 return {before,hub,recipients};
}
async function apply(ctx:ApiContext,p:Proposal){if(ctx.credential.kind!=='human')throw new ApiError(403,'HUMAN_REVIEW_REQUIRED');const creating=p.action==='automation.rule.create',i=creating?create.parse(p.payload):change.parse(p.payload),b=await basis(ctx,creating,p.target_id,i);if(!isDeepStrictEqual(JSON.parse(JSON.stringify(b)),p.review_context))throw new ApiError(409,'AUTOMATION_SOURCES_CHANGED');const v=(b.before?.version??0)+1;
 if(creating&&'code' in i)await ctx.db.query('INSERT INTO public.automation_rules(academy_id,id,hub_id,code) VALUES($1,$2,$3,$4)',[ctx.credential.academy_id,p.target_id,i.hubId,i.code]);else if(!(await ctx.db.query('UPDATE public.automation_rules SET version=$2 WHERE id=$1 AND version=$3 RETURNING id',[p.target_id,v,p.target_version])).rows.length)throw new ApiError(409,'AUTOMATION_RULE_CHANGED');
 await ctx.db.query('INSERT INTO public.automation_rule_revisions(academy_id,rule_id,version,definition,changed_by,approval_id,reason) VALUES($1,$2,$3,$4::jsonb,$5,$6,$7)',[ctx.credential.academy_id,p.target_id,v,JSON.stringify(i.definition),ctx.credential.person_id,p.id,i.reason]);
 const r=await header(ctx,p.target_id);await record(ctx.db,ctx.credential,ctx.requestId,p.action,p.target_id,r.hub_id,{version:v,approvalId:p.id,severity:'critical',hasReason:true,definitionRedacted:true,runtimeActive:false});return detail(ctx,r);
}
function action(creating:boolean):ApprovalRegistry[string]{return {requestCapability:'automations.edit',privacyCapability:'automations.view',createdStatus:creating?201:200,
 async validate(ctx,id,raw){await lockAcademyTopology(ctx);const b=await basis(ctx,creating,id,raw),i=creating?create.parse(raw):null,hubId=b.before?b.before.hub_id:i!.hubId;return hubId?{all:false,hubs:[hubId]}:{all:true,hubs:[]};},
 async dependencies(ctx,id,raw,purpose){try{return JSON.parse(JSON.stringify(await basis(ctx,creating,id,raw)));}catch(error){if(purpose==='review'&&error instanceof ApiError&&[400,403,404,409].includes(error.status))return {unavailable:error.code};throw error;}},apply};}
export const automationActions:ApprovalRegistry={'automation.rule.create':action(true),'automation.rule.change':action(false)};
export async function automationRules(ctx:ApiContext,registry:ApprovalRegistry=automationActions):Promise<Reply|null>{
 if(ctx.path==='automations/language'){if(ctx.request.method!=='GET')throw new ApiError(405,'METHOD_NOT_ALLOWED');allowed(ctx,'automations.view');z.object({}).strict().parse(Object.fromEntries(new URL(ctx.request.url).searchParams));return {status:200,body:{data:automationLanguage}};}
 const m=/^automations\/rules(?:\/([^/]+)(?:\/(change|history|duplicate|preview|event-preview))?)?$/.exec(ctx.path);if(!m)return null;const id=m[1]?uuid.parse(m[1]):null,section=m[2];
 if(ctx.request.method==='POST'){
  z.object({}).strict().parse(Object.fromEntries(new URL(ctx.request.url).searchParams));
  if(id&&section==='preview'){const input=preview.parse(await jsonBody(ctx.request,64*1024)),r=await header(ctx,id),v=await revision(ctx,r,input.version);return {status:200,body:{data:{ruleId:r.id,version:v.version,...simulateRule(v.definition,r.hub_id,input.sample,input.locale)}}};}
  if(id&&section==='event-preview'){const input=eventPreview.parse(await jsonBody(ctx.request)),r=await header(ctx,id),v=await revision(ctx,r,input.version),event=await boundAutomationEvent(ctx,input.eventId);return {status:200,body:{data:{ruleId:r.id,version:v.version,...simulateRule(v.definition,r.hub_id,ruleSample.parse(event.projection),input.locale),sampleSource:'server_bound_approval_event',event:boundEventView(event),sourceVerification:'database_bound_approval_event'}}};}
  if(id&&section==='duplicate'){const input=duplicate.parse(await jsonBody(ctx.request));await lockApprovalWrites(ctx);await lockAcademyTopology(ctx);const source=await header(ctx,id),v=await revision(ctx,source,input.sourceVersion);return propose(ctx,registry,'automation.rule.create',null,0,create.parse({hubId:input.hubId,code:input.code,definition:{...v.definition,name:input.name,enabled:false},reason:input.reason}));}
  if(id&&section!=='change')throw new ApiError(405,'METHOD_NOT_ALLOWED');const input=(id?change:create).parse(await jsonBody(ctx.request,128*1024));return propose(ctx,registry,id?'automation.rule.change':'automation.rule.create',id,'expectedVersion' in input?input.expectedVersion:0,input);
 }
 if(ctx.request.method!=='GET'||['change','duplicate','preview','event-preview'].includes(section??''))throw new ApiError(405,'METHOD_NOT_ALLOWED');
 if(id){const r=await header(ctx,id,section==='history');if(section==='history'){const q=history.parse(Object.fromEntries(new URL(ctx.request.url).searchParams)),rows=(await ctx.db.query<{version:number}>('SELECT version,definition,changed_by,approval_id,reason,created_at FROM public.automation_rule_revisions WHERE rule_id=$1 AND version>$2 ORDER BY version LIMIT $3',[id,q.afterVersion,q.limit+1])).rows;return {status:200,body:{data:rows.slice(0,q.limit),nextVersion:rows.length>q.limit?rows[q.limit-1].version:null}};}const q=read.parse(Object.fromEntries(new URL(ctx.request.url).searchParams));return {status:200,body:{data:await detail(ctx,r,q.version)}};}
 const q=query.parse(Object.fromEntries(new URL(ctx.request.url).searchParams)),rows=(await ctx.db.query<Header>(`SELECT r.id,r.hub_id,r.code,r.version,v.definition->>'name' AS name,(v.definition->>'enabled')::boolean AS enabled FROM public.automation_rules r JOIN public.automation_rule_revisions v ON v.academy_id=r.academy_id AND v.rule_id=r.id AND v.version=r.version WHERE ${selected} AND($5::uuid IS NULL OR r.id>$5) AND($6::uuid IS NULL OR r.hub_id=$6) AND($7::boolean IS NULL OR(v.definition->>'enabled')::boolean=$7) ORDER BY r.id LIMIT $8`,[...parameters(ctx),q.after??null,q.hubId??null,q.enabled??null,q.limit+1])).rows;return {status:200,body:{data:rows.slice(0,q.limit),nextCursor:rows.length>q.limit?rows[q.limit-1].id:null,runtimeActive:false}};
}
export const automationRulesContract=[
 {path:'/api/v1/automations/language',method:'get',summary:'Registered deterministic rule operators, plain-text tokens and current runtime limits; no arbitrary code'},
 {path:'/api/v1/automations/rules',method:'get',summary:'Permission-filtered persisted rule configurations; configuration-enabled does not mean runtime/delivery is active',querySchema:query},
 {path:'/api/v1/automations/rules',method:'post',summary:'Request exact reviewed rule, notification templates, audience and execution budgets; does not start a worker or send messages',schema:create},
 {path:'/api/v1/automations/rules/{id}',method:'get',summary:'Authorized current or immutable historical rule version',querySchema:read},
 {path:'/api/v1/automations/rules/{id}/change',method:'post',summary:'Replace a rule configuration with upper-human approval and source/version checks',schema:change},
 {path:'/api/v1/automations/rules/{id}/duplicate',method:'post',summary:'Copy an authorized rule to a new reviewed, disabled configuration with destination permission checks',schema:duplicate},
 {path:'/api/v1/automations/rules/{id}/history',method:'get',summary:'Editor-only private rule definition and review history',querySchema:history},
 {path:'/api/v1/automations/rules/{id}/preview',method:'post',summary:'Read-only deterministic simulation against an explicitly unverified caller sample; no recipient expansion, queue, budget use, message or external request',schema:preview,readOnly:true},
 {path:'/api/v1/automations/rules/{id}/event-preview',method:'post',summary:'Read-only evaluation of a current-authorized server-bound approval event, never a caller-substituted payload; source-state drift is explicit, dispatch is not performed',schema:eventPreview,readOnly:true}
] as const;
