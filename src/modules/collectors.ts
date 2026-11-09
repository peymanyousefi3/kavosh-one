import { z } from 'zod';
import { jsonBody,record,type ApiContext,type Reply } from '../core/api.ts';
import { propose,permissionScope,master,type ApprovalRegistry,type Proposal } from '../core/approvals.ts';
import { ApiError,requireScope,scopeNonempty,type Capability } from '../core/policy.ts';
import { lockFinanceBook } from '../core/finance-lock.ts';
import { lockAcademyTopology } from './academy.ts';
import { accountSelection } from './finance.ts';
import { permittedPerson } from './students.ts';
import { payeeRow } from './payees.ts';

const uuid=z.string().uuid().transform(v=>v.toLowerCase()),version=z.number().int().positive().max(2147483647);
const text=z.string().refine(v=>v.isWellFormed()&&!v.includes('\0')),reason=text.trim().min(1).max(2000),name=text.trim().min(1).max(200);
const accounts=z.array(z.object({id:uuid,version}).strict()).min(1).max(50).refine(v=>new Set(v.map(a=>a.id)).size===v.length);
const common={name,active:z.boolean().default(true),accounts,reason};
const create=z.object({...common,hubId:uuid.nullable().default(null),personId:uuid.nullable().default(null),code:z.string().regex(/^[A-Z0-9][A-Z0-9._-]{0,31}$/),kind:z.enum(['academy','hub','person','other']),custody:z.enum(['academy_funds','third_party']),organizationPayee:z.object({id:uuid,version}).strict().optional()}).strict()
 .refine(v=>(v.kind==='person')===(v.personId!==null)&&(v.kind!=='hub'||v.hubId!==null)&&(v.kind!=='academy'||(v.hubId===null&&v.custody==='academy_funds'))&&(!v.organizationPayee||(v.kind==='other'&&v.custody==='third_party')));
const replace=z.object({...common,expectedVersion:version}).strict();
const paging={limit:z.coerce.number().int().min(1).max(100).default(50),after:uuid.optional()};
const query=z.object({...paging,hubId:uuid.optional(),active:z.enum(['true','false']).transform(v=>v==='true').optional(),q:text.trim().min(1).max(100).optional()}).strict();
const history=z.object({limit:paging.limit,afterVersion:z.coerce.number().int().min(0).max(2147483647).default(0)}).strict();
type Collector={id:string;hub_id:string|null;person_id:string|null;code:string;kind:string;custody:string;version:number;name:string;active:boolean;organization_payee_id?:string|null;organization_payee_version?:number|null;accounts:{id:string;version:number;currencyId:string}[]};
function allowed(ctx:ApiContext,cap:Capability){const s=permissionScope(ctx,cap);if(!scopeNonempty(s))throw new ApiError(403,'FORBIDDEN');return s;}
const columns='c.id,c.hub_id,c.person_id,c.code,c.kind,c.custody,c.version,r.name,r.active,r.accounts';
const organizationColumns=',to_jsonb(c)->>\'organization_payee_id\' organization_payee_id,(to_jsonb(c)->>\'organization_payee_version\')::integer organization_payee_version';
const source=' FROM public.finance_collectors c JOIN public.finance_collector_revisions r ON r.academy_id=c.academy_id AND r.collector_id=c.id AND r.version=c.version';
// Shared school collectors can be selected by a hub without granting access to
// account balances or other-hub directories. Mapping reads still require accounts.view.
function parameters(ctx:ApiContext){const s=allowed(ctx,'collectors.view');return [s.all,s.hubs,s.excludedHubs??[]];}
const selected='(c.hub_id IS NULL OR (($1::boolean OR c.hub_id=ANY($2::uuid[])) AND NOT c.hub_id=ANY($3::uuid[])))';
// Receipt/remittance sources use only the original collector identity. An
// optional organization link must not leak into their separately scoped proof.
export async function collectorRow(ctx:ApiContext,id:string,edit=false,includeOrganization=false):Promise<Collector>{
 const c=(await ctx.db.query<Collector>('SELECT '+columns+(includeOrganization?organizationColumns:'')+source+' WHERE '+selected+' AND c.id=$4',[...parameters(ctx),id])).rows[0];if(!c)throw new ApiError(404,'NOT_FOUND');
 if(edit)requireScope(allowed(ctx,'collectors.edit'),c.hub_id??undefined);return c;
}
async function visibleAccounts(ctx:ApiContext,ids:string[]){
 if(!scopeNonempty(permissionScope(ctx,'accounts.view')))return new Set<string>();return new Set((await accountSelection(ctx,[...new Set(ids)])).map(a=>a.id));
}
async function detail(ctx:ApiContext,c:Collector){
 const visible=await visibleAccounts(ctx,c.accounts.map(a=>a.id)),mappings=c.accounts.filter(a=>visible.has(a.id));
 const {organization_payee_id,organization_payee_version,...publicFields}=c;let organizationPayee:null|{id:string;version:number}=null,organizationIdentityRestricted=false;
 if(organization_payee_id)try{await payeeRow(ctx,organization_payee_id);organizationPayee={id:organization_payee_id,version:organization_payee_version!};}catch(error){if(!(error instanceof ApiError)||![403,404].includes(error.status))throw error;organizationIdentityRestricted=true;}
 return {...publicFields,organizationPayee,organizationIdentityRestricted,accounts:mappings,accountMappingsRestricted:mappings.length!==c.accounts.length,paymentReceived:false};
}
async function basis(ctx:ApiContext,creating:boolean,id:string,raw:unknown,lock=false){
 const input=creating?create.parse(raw):replace.parse(raw),before=creating?null:await collectorRow(ctx,id,true,true),hubId=before?before.hub_id:('hubId' in input?input.hubId:null);
 requireScope(allowed(ctx,'collectors.view'),hubId??undefined);requireScope(allowed(ctx,'collectors.edit'),hubId??undefined);
 if(lock){await lockFinanceBook(ctx);await lockAcademyTopology(ctx);}
 const hub=hubId?(await ctx.db.query('SELECT id,version,active FROM public.hubs WHERE id=$1',[hubId])).rows[0]:null;if(hubId&&!hub?.active)throw new ApiError(409,'ACTIVE_HUB_REQUIRED');
 const personId=before?before.person_id:('personId' in input?input.personId:null),person=personId?await permittedPerson(ctx,personId,'people.view'):null;
 const organizationRef=before?.organization_payee_id?{id:before.organization_payee_id,version:before.organization_payee_version!}:('organizationPayee' in input?input.organizationPayee:undefined),organization=organizationRef?await payeeRow(ctx,organizationRef.id):null;
 if(organization&&(organization.kind!=='organization'||(organization.hub_id!==null&&organization.hub_id!==hubId)))throw new ApiError(400,'COLLECTOR_ORGANIZATION_IDENTITY_INVALID');
 if(creating&&organization&&(!organization.currentActive||organization.currentVersion!==organizationRef!.version))throw new ApiError(409,'COLLECTOR_ORGANIZATION_CHANGED');
 if(personId&&(await ctx.db.query('SELECT 1 FROM public.people WHERE id=$1 AND kind=\'human\' AND status=\'active\'',[personId])).rows.length!==1)throw new ApiError(409,'ACTIVE_HUMAN_COLLECTOR_REQUIRED');
 const custody=before?before.custody:('custody' in input?input.custody:''),mapped=[],seen=new Set<string>(),selectedAccounts=new Map((await accountSelection(ctx,input.accounts.map(a=>a.id))).map(a=>[a.id,a]));
 for(const m of input.accounts){const a=selectedAccounts.get(m.id);if(!a)throw new ApiError(404,'NOT_FOUND');if(!a.active||a.version!==m.version)throw new ApiError(409,'COLLECTOR_ACCOUNT_CHANGED');
  if(seen.has(a.currencyId)||(a.hubId!==null&&a.hubId!==hubId)||(custody==='academy_funds'?!['cash','bank'].includes(a.operationalRole):a.operationalRole!=='collector_receivable'))throw new ApiError(400,'COLLECTOR_MAPPING_INVALID');
  seen.add(a.currencyId);mapped.push({id:a.id,version:a.version,currencyId:a.currencyId});
 }
 return {before,hub,person:person?{id:person.id}:null,accounts:mapped,...organization?{organization:{id:organization.id,version:organization.version,active:organization.active,kind:organization.kind,hubId:organization.hub_id}}:{}};
}
async function validate(ctx:ApiContext,creating:boolean,id:string,raw:unknown){const b=await basis(ctx,creating,id,raw,true),hubId=b.before?b.before.hub_id:create.parse(raw).hubId;return hubId?{all:false,hubs:[hubId]}:{all:true,hubs:[]};}
async function dependencies(ctx:ApiContext,creating:boolean,id:string,raw:unknown,purpose:'request'|'review'){
 try{const b=await basis(ctx,creating,id,raw),input=creating?create.parse(raw):replace.parse(raw);if(purpose==='request'&&b.before&&'expectedVersion' in input&&b.before.version!==input.expectedVersion)throw new ApiError(409,'TARGET_CHANGED');
  // New nullable identity columns must not stale an unchanged legacy proposal.
  const {organization_payee_id,organization_payee_version,...legacyBefore}=b.before??{};
  return {...b,...b.before&&!organization_payee_id?{before:legacyBefore}:{},codeOwner:creating&&'code' in input?(await ctx.db.query('SELECT id FROM public.finance_collectors WHERE hub_id IS NOT DISTINCT FROM $1 AND code=$2',[input.hubId,input.code])).rows[0]??null:null};
 }catch(error){if(purpose==='review'&&error instanceof ApiError&&[400,403,404,409].includes(error.status))return {unavailable:error.code};throw error;}
}
async function apply(ctx:ApiContext,p:Proposal){
 if(ctx.credential.kind!=='human')throw new ApiError(403,'HUMAN_REVIEW_REQUIRED');const creating=p.action==='finance.collector.create',input=creating?create.parse(p.payload):replace.parse(p.payload),b=await basis(ctx,creating,p.target_id,p.payload,true),before=b.before,next=(before?.version??0)+1;
 if(before&&(!('expectedVersion' in input)||before.version!==input.expectedVersion||p.target_version!==before.version))throw new ApiError(409,'TARGET_CHANGED');
 try{if(before)await ctx.db.query('UPDATE public.finance_collectors SET version=$2 WHERE id=$1',[p.target_id,next]);
  else if('code' in input){if(input.organizationPayee)await ctx.db.query('INSERT INTO public.finance_collectors(academy_id,id,hub_id,person_id,code,kind,custody,created_by,organization_payee_id,organization_payee_version) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',[ctx.credential.academy_id,p.target_id,input.hubId,input.personId,input.code,input.kind,input.custody,ctx.credential.person_id,input.organizationPayee.id,input.organizationPayee.version]);else await ctx.db.query('INSERT INTO public.finance_collectors(academy_id,id,hub_id,person_id,code,kind,custody,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[ctx.credential.academy_id,p.target_id,input.hubId,input.personId,input.code,input.kind,input.custody,ctx.credential.person_id]);}
  await ctx.db.query('INSERT INTO public.finance_collector_revisions(academy_id,collector_id,version,name,active,accounts,changed_by,approval_id,reason) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9)',[ctx.credential.academy_id,p.target_id,next,input.name,input.active,JSON.stringify(b.accounts),ctx.credential.person_id,p.id,input.reason]);
 }catch(error){if(error&&typeof error==='object'&&'code' in error&&error.code==='23505')throw new ApiError(409,'COLLECTOR_CODE_EXISTS');throw error;}
 const c=await collectorRow(ctx,p.target_id,false,true);await record(ctx.db,ctx.credential,ctx.requestId,creating?'finance.collector.created':'finance.collector.replaced',c.id,c.hub_id,{beforeVersion:before?.version??null,afterVersion:next,approvalId:p.id,severity:'critical',hasReason:true});return detail(ctx,c);
}
async function reviewer(ctx:ApiContext,p:Proposal){if(await master(ctx))return;const person=p.action==='finance.collector.create'?create.parse(p.payload).personId:(await collectorRow(ctx,p.target_id)).person_id;if(person===ctx.credential.person_id)throw new ApiError(403,'BENEFICIARY_REVIEW_FORBIDDEN');}
export const collectorActions:ApprovalRegistry={
 'finance.collector.create':{requestCapability:'collectors.edit',privacyCapability:'collectors.edit',createdStatus:201,policyChange:true,validate:(c,id,i)=>validate(c,true,id,i),dependencies:(c,id,i,p)=>dependencies(c,true,id,i,p),authorizeReviewer:reviewer,apply},
 'finance.collector.replace':{requestCapability:'collectors.edit',privacyCapability:'collectors.edit',policyChange:true,validate:(c,id,i)=>validate(c,false,id,i),dependencies:(c,id,i,p)=>dependencies(c,false,id,i,p),authorizeReviewer:reviewer,apply}
};
export async function collectors(ctx:ApiContext,registry:ApprovalRegistry=collectorActions):Promise<Reply|null>{
 const match=/^finance\/collectors(?:\/([^/]+)(?:\/(change|history))?)?$/.exec(ctx.path);if(!match)return null;const id=match[1]?uuid.parse(match[1]):null,section=match[2];
 if(ctx.request.method==='POST'){z.object({}).strict().parse(Object.fromEntries(new URL(ctx.request.url).searchParams));if(!id){const input=create.parse(await jsonBody(ctx.request));return propose(ctx,registry,'finance.collector.create',null,0,input);}if(section!=='change')throw new ApiError(405,'METHOD_NOT_ALLOWED');const input=replace.parse(await jsonBody(ctx.request));await collectorRow(ctx,id,true);return propose(ctx,registry,'finance.collector.replace',id,input.expectedVersion,input);}
 if(ctx.request.method!=='GET')throw new ApiError(405,'METHOD_NOT_ALLOWED');if(id){const c=await collectorRow(ctx,id,section==='history',true);if(section==='history'){const q=history.parse(Object.fromEntries(new URL(ctx.request.url).searchParams)),rows=(await ctx.db.query<{version:number;accounts:Collector['accounts']}>('SELECT version,name,active,accounts,reason,changed_by AS "changedBy",approval_id AS "approvalId" FROM public.finance_collector_revisions WHERE collector_id=$1 AND version>$2 ORDER BY version LIMIT $3',[id,q.afterVersion,q.limit+1])).rows,page=rows.slice(0,q.limit),visible=await visibleAccounts(ctx,page.flatMap(r=>r.accounts.map(a=>a.id)));
  return {status:200,body:{data:page.map(r=>({...r,accounts:r.accounts.filter(a=>visible.has(a.id)),accountMappingsRestricted:r.accounts.some(a=>!visible.has(a.id))})),nextVersion:rows.length>q.limit?rows[q.limit-1].version:null}};}
  if(section)throw new ApiError(405,'METHOD_NOT_ALLOWED');z.object({}).strict().parse(Object.fromEntries(new URL(ctx.request.url).searchParams));return {status:200,body:{data:await detail(ctx,c)}};}
 const q=query.parse(Object.fromEntries(new URL(ctx.request.url).searchParams)),rows=(await ctx.db.query<{id:string}>('SELECT c.id,c.hub_id,c.person_id,c.kind,c.custody,c.code,c.version,r.name,r.active'+source+' WHERE '+selected+' AND ($4::uuid IS NULL OR c.id>$4) AND ($5::uuid IS NULL OR c.hub_id=$5) AND ($6::boolean IS NULL OR r.active=$6) AND ($7::text IS NULL OR position(lower($7) in lower(c.code||\' \'||r.name))>0) ORDER BY c.id LIMIT $8',[...parameters(ctx),q.after??null,q.hubId??null,q.active??null,q.q??null,q.limit+1])).rows;return {status:200,body:{data:rows.slice(0,q.limit),nextCursor:rows.length>q.limit?rows[q.limit-1].id:null}};
}
export const collectorsContract=[
 {path:'/api/v1/finance/collectors',method:'get',summary:'Scoped payment-recipient directory including selectable shared school recipients; no account balances or payments implied',querySchema:query},
 {path:'/api/v1/finance/collectors',method:'post',summary:'Request reviewed named academy/hub/person/other collector with explicit fund custody and one authorized holding account per currency. A new third-party other collector may pin an explicit organizationPayee identity;immutable after creation,never inferred from names or backfilled onto past collections. Current payee permissions and edition required. Identity matching is not legal setoff or payment authority.',schema:create},
 {path:'/api/v1/finance/collectors/{id}',method:'get',summary:'Read a permitted collector with account mappings filtered by current account-view rights'},
 {path:'/api/v1/finance/collectors/{id}/change',method:'post',summary:'Request a complete name/status/account-map revision without changing collector identity or fund custody',schema:replace},
 {path:'/api/v1/finance/collectors/{id}/history',method:'get',summary:'Editor-only bounded immutable collector revisions and private review reasons',querySchema:history}
] as const;
