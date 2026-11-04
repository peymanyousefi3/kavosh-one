import { createHash } from 'node:crypto';
import { z } from 'zod';
import { jsonBody,record,type ApiContext,type Reply } from '../core/api.ts';
import { propose,permissionScope,type ApprovalRegistry,type Proposal } from '../core/approvals.ts';
import { ApiError,requireScope,scopeNonempty,type Capability } from '../core/policy.ts';
import { lockAcademyTopology } from './academy.ts';

const text=z.string().refine(v=>v.isWellFormed()&&!v.includes('\0'),'Use valid Unicode without null characters.');
const uuid=z.string().uuid().transform(v=>v.toLowerCase()),version=z.number().int().positive().max(2_147_483_647),name=text.trim().min(1).max(200),reason=text.trim().min(1).max(2000);
const language=z.object({locale:z.enum(['en','fr','zh-CN']),title:name,body:text.min(1).max(32000).refine(v=>v.trim().length>0)}).strict();
const languages=z.array(language).min(1).max(3).refine(v=>new Set(v.map(l=>l.locale)).size===v.length,'Use each language once.')
  .refine(v=>v.reduce((n,l)=>n+l.body.length,0)<=64000,'Use at most 64000 text characters across the languages.');
const provider=z.object({region:z.enum(['US','CA','EU','AU']),templateId:uuid}).strict().nullable();
const content={name,legalEntityName:name,countryCode:z.string().regex(/^[A-Z]{2}$/),jurisdiction:text.trim().min(1).max(200),languages,provider};
const definition=z.object({...content,kind:z.literal('unified_enrollment'),format:z.literal('plain_text'),available:z.boolean()}).strict();
const createInput=z.object({...content,hubId:uuid.nullable().default(null),provider:provider.default(null),available:z.boolean().default(false),reason}).strict();
const createPayload=createInput.extend({source:z.object({templateId:uuid,version}).strict().optional()});
const updateInput=z.object(content).partial().extend({available:z.boolean().optional(),expectedVersion:version,reason}).strict()
  .refine(v=>Object.keys(v).some(k=>k!=='expectedVersion'&&k!=='reason'));
const query=z.object({limit:z.coerce.number().int().min(1).max(100).default(50),after:uuid.optional(),hubId:uuid.optional(),available:z.enum(['true','false']).transform(v=>v==='true').optional(),q:z.string().trim().min(1).max(100).optional()}).strict();
const historyQuery=z.object({limit:query.shape.limit,afterVersion:z.coerce.number().int().min(0).max(2_147_483_647).default(0)}).strict();
const duplicateInput=z.object({sourceVersion:version,name,hubId:uuid.nullable(),reason}).strict();
interface Template {id:string;hub_id:string|null;name:string;available:boolean;version:number;last_approval_id:string;definition:z.infer<typeof definition>;definition_hash:string}
function allowed(ctx:ApiContext,cap:Capability) {const s=permissionScope(ctx,cap);if(!scopeNonempty(s))throw new ApiError(403,'FORBIDDEN');return s;}
const selected=`((t.hub_id IS NULL AND $1::boolean AND cardinality($3::uuid[])=0 AND $4::boolean)
  OR (t.hub_id IS NOT NULL AND ($1::boolean OR t.hub_id=ANY($2::uuid[])) AND NOT t.hub_id=ANY($3::uuid[])))`;
const fields='t.id,t.hub_id,t.name,t.available,t.version,t.last_approval_id,t.created_at,r.definition,r.definition_hash';
const from='public.agreement_templates t JOIN public.agreement_template_revisions r ON r.academy_id=t.academy_id AND r.template_id=t.id AND r.version=t.version';
function scopeParams(ctx:ApiContext,cap:Capability) {const s=allowed(ctx,cap);return [s.all,s.hubs,s.excludedHubs??[],!s.excludedAreas?.length];}
async function template(ctx:ApiContext,id:string,edit=false,lock=false) {
  const params=[...scopeParams(ctx,'agreements.view'),id];
  // Lock the parent alone, then read its revision in a fresh statement snapshot.
  // A joined FOR UPDATE can recheck a newly committed parent against the old
  // revision snapshot after waiting, incorrectly turning a conflict into 404.
  if(lock&&!(await ctx.db.query('SELECT t.id FROM public.agreement_templates t WHERE '+selected+' AND t.id=$5 FOR UPDATE',params)).rows.length)throw new ApiError(404,'NOT_FOUND');
  const row=(await ctx.db.query<Template>('SELECT '+fields+' FROM '+from+' WHERE '+selected+' AND t.id=$5',params)).rows[0];
  if(!row)throw new ApiError(404,'NOT_FOUND');
  if(edit)requireScope(allowed(ctx,'agreements.edit'),row.hub_id??undefined);return row;
}
async function destination(ctx:ApiContext,hubId:string|null) {
  requireScope(allowed(ctx,'agreements.view'),hubId??undefined);requireScope(allowed(ctx,'agreements.edit'),hubId??undefined);
  if(hubId&&!(await ctx.db.query('SELECT 1 FROM public.hubs WHERE id=$1',[hubId])).rows.length)throw new ApiError(404,'NOT_FOUND');
  return hubId?{all:false,hubs:[hubId]}:{all:true,hubs:[]};
}
async function validate(ctx:ApiContext,creating:boolean,id:string,raw:unknown) {
  await lockAcademyTopology(ctx);
  if(creating) {
    const input=createPayload.parse(raw),target=await destination(ctx,input.hubId);
    if(!input.source)return target;
    const source=await template(ctx,input.source.templateId);
    if(!(await ctx.db.query('SELECT 1 FROM public.agreement_template_revisions WHERE template_id=$1 AND version=$2',[source.id,input.source.version])).rows.length)throw new ApiError(404,'NOT_FOUND');
    // Pending cross-hub copies disclose the source text only to reviewers whose
    // private-case scope covers both ends, not merely the destination hub.
    return target.all||source.hub_id===null?{all:true,hubs:[]}:{all:false,hubs:[...new Set([...target.hubs,source.hub_id])]};
  }
  updateInput.parse(raw);const t=await template(ctx,id,true,true);return t.hub_id?{all:false,hubs:[t.hub_id]}:{all:true,hubs:[]};
}
async function dependencies(ctx:ApiContext,creating:boolean,id:string,raw:unknown) {
  const t=creating?null:(await ctx.db.query('SELECT id,hub_id,version,available FROM public.agreement_templates WHERE id=$1',[id])).rows[0]??null;
  const input=creating?createPayload.parse(raw):null,hubId=creating?input!.hubId:t?.hub_id;
  return {template:t,hub:hubId?(await ctx.db.query('SELECT id,version,active FROM public.hubs WHERE id=$1',[hubId])).rows[0]??null:null,
    source:input?.source?(await ctx.db.query('SELECT template_id,version,definition_hash FROM public.agreement_template_revisions WHERE template_id=$1 AND version=$2',[input.source.templateId,input.source.version])).rows[0]??null:null};
}
async function apply(ctx:ApiContext,p:Proposal) {
  if(ctx.credential.kind!=='human')throw new ApiError(403,'HUMAN_REVIEW_REQUIRED');
  const creating=p.action==='agreement.create',input=creating?createPayload.parse(p.payload):updateInput.parse(p.payload),before=creating?null:await template(ctx,p.target_id,true,true);
  if(before&&(before.version!==p.target_version||before.version!==('expectedVersion' in input?input.expectedVersion:0)))throw new ApiError(409,'TARGET_CHANGED');
  const why=input.reason;
  // Input is already strict; strip request-only reason/version/hub metadata
  // from the canonical definition rather than hashing it as agreement content.
  const body=definition.strip().parse({...before?.definition,...input,kind:'unified_enrollment',format:'plain_text'}),hubId=before?before.hub_id:('hubId' in input?input.hubId:null);
  if(body.available&&hubId&&!(await ctx.db.query('SELECT 1 FROM public.hubs WHERE id=$1 AND active',[hubId])).rows.length)throw new ApiError(409,'ACTIVE_HUB_REQUIRED');
  const next=before?before.version+1:1,hash=createHash('sha256').update(JSON.stringify(body)).digest('hex');
  if(before)await ctx.db.query('UPDATE public.agreement_templates SET name=$2,available=$3,version=$4,last_approval_id=$5 WHERE id=$1',[p.target_id,body.name,body.available,next,p.id]);
  else await ctx.db.query('INSERT INTO public.agreement_templates(academy_id,id,hub_id,name,available,last_approval_id) VALUES($1,$2,$3,$4,$5,$6)',[ctx.credential.academy_id,p.target_id,hubId,body.name,body.available,p.id]);
  await ctx.db.query('INSERT INTO public.agreement_template_revisions(academy_id,template_id,version,definition,definition_hash,changed_by,approval_id,reason) VALUES($1,$2,$3,$4::jsonb,$5,$6,$7,$8)',[ctx.credential.academy_id,p.target_id,next,JSON.stringify(body),hash,ctx.credential.person_id,p.id,why]);
  await record(ctx.db,ctx.credential,ctx.requestId,before?'agreement.template.updated':'agreement.template.created',p.target_id,hubId,{beforeVersion:before?.version??null,afterVersion:next,definitionHash:hash,severity:'critical',hasReason:true});
  return template(ctx,p.target_id);
}
export const agreementActions:ApprovalRegistry={
  'agreement.create':{requestCapability:'agreements.edit',privacyCapability:'agreements.view',createdStatus:201,validate:(ctx,id,input)=>validate(ctx,true,id,input),dependencies:(ctx,id,input)=>dependencies(ctx,true,id,input),apply},
  'agreement.update':{requestCapability:'agreements.edit',privacyCapability:'agreements.view',validate:(ctx,id,input)=>validate(ctx,false,id,input),dependencies:(ctx,id,input)=>dependencies(ctx,false,id,input),apply}
};
export async function agreements(ctx:ApiContext,registry:ApprovalRegistry=agreementActions):Promise<Reply|null> {
  const match=/^agreements(?:\/([^/]+)(?:\/(change|history|duplicate))?)?$/.exec(ctx.path);if(!match)return null;
  const id=match[1]?uuid.parse(match[1]):null,section=match[2],method=ctx.request.method;
  if(method==='POST') {
    z.object({}).strict().parse(Object.fromEntries(new URL(ctx.request.url).searchParams));
    if(!id){const input=createInput.parse(await jsonBody(ctx.request,262144));await destination(ctx,input.hubId);return propose(ctx,registry,'agreement.create',null,0,input);}
    if(section==='change'){const input=updateInput.parse(await jsonBody(ctx.request,262144));await template(ctx,id,true);return propose(ctx,registry,'agreement.update',id,input.expectedVersion,input);}
    if(section==='duplicate') {
      const input=duplicateInput.parse(await jsonBody(ctx.request));await template(ctx,id);await destination(ctx,input.hubId);
      const source=(await ctx.db.query<{definition:unknown}>('SELECT definition FROM public.agreement_template_revisions WHERE template_id=$1 AND version=$2',[id,input.sourceVersion])).rows[0];if(!source)throw new ApiError(404,'NOT_FOUND');
      const {kind:ignoredKind,format:ignoredFormat,...copy}=definition.parse(source.definition);
      return propose(ctx,registry,'agreement.create',null,0,{...createInput.parse({...copy,name:input.name,hubId:input.hubId,available:false,reason:input.reason}),source:{templateId:id,version:input.sourceVersion}});
    }
    throw new ApiError(405,'METHOD_NOT_ALLOWED');
  }
  if(method!=='GET')throw new ApiError(405,'METHOD_NOT_ALLOWED');
  if(id) {
    const row=await template(ctx,id);
    if(section==='history'){const q=historyQuery.parse(Object.fromEntries(new URL(ctx.request.url).searchParams));const rows=(await ctx.db.query<{version:number}>('SELECT version,definition,definition_hash,changed_by,approval_id,reason,created_at FROM public.agreement_template_revisions WHERE template_id=$1 AND version>$2 ORDER BY version LIMIT $3',[id,q.afterVersion,q.limit+1])).rows;return {status:200,body:{data:rows.slice(0,q.limit),nextVersion:rows.length>q.limit?rows[q.limit-1].version:null}};}
    if(section)throw new ApiError(405,'METHOD_NOT_ALLOWED');z.object({}).strict().parse(Object.fromEntries(new URL(ctx.request.url).searchParams));return {status:200,body:{data:row}};
  }
  const q=query.parse(Object.fromEntries(new URL(ctx.request.url).searchParams)),rows=(await ctx.db.query<{id:string}>('SELECT t.id,t.hub_id,t.name,t.available,t.version,t.created_at,r.definition_hash FROM '+from+' WHERE '+selected+' AND ($5::uuid IS NULL OR t.id>$5) AND ($6::uuid IS NULL OR t.hub_id=$6) AND ($7::boolean IS NULL OR t.available=$7) AND ($8::text IS NULL OR position(lower($8) in lower(t.name))>0) ORDER BY t.id LIMIT $9',[...scopeParams(ctx,'agreements.view'),q.after??null,q.hubId??null,q.available??null,q.q??null,q.limit+1])).rows;
  return {status:200,body:{data:rows.slice(0,q.limit),nextCursor:rows.length>q.limit?rows[q.limit-1].id:null}};
}
export const agreementsContract=[
  {path:'/api/v1/agreements',method:'get',summary:'Scoped agreement definitions without full legal text in directory responses',querySchema:query},
  {path:'/api/v1/agreements',method:'post',summary:'Request a versioned unified agreement definition; availability never proves legal approval or signed admission',schema:createInput},
  {path:'/api/v1/agreements/{id}',method:'get',summary:'Authorized current plain-text agreement definition; not a signed provider document'},
  {path:'/api/v1/agreements/{id}/change',method:'post',summary:'Request versioned partial agreement corrections preserving omitted content and fixed hub ownership',schema:updateInput},
  {path:'/api/v1/agreements/{id}/history',method:'get',summary:'Immutable agreement definitions, hashes and approval reasons',querySchema:historyQuery},
  {path:'/api/v1/agreements/{id}/duplicate',method:'post',summary:'Copy a specific immutable revision into a new unavailable definition under destination rights',schema:duplicateInput}
] as const;
