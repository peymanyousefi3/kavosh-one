import { z } from 'zod';
import { jsonBody,record,type ApiContext,type Reply } from '../core/api.ts';
import { propose,permissionScope,master,type ApprovalRegistry,type Proposal } from '../core/approvals.ts';
import { ApiError,requireScope,scopeNonempty,type Capability } from '../core/policy.ts';
import { lockAcademyTopology } from './academy.ts';
import { permittedPerson } from './students.ts';

const uuid=z.string().uuid().transform(v=>v.toLowerCase()),version=z.number().int().positive().max(2147483647),text=z.string().refine(v=>v.isWellFormed()&&!v.includes('\0')),name=text.trim().min(1).max(200),reason=text.trim().min(1).max(2000);
const definition={name,legalName:name.nullable().default(null),active:z.boolean().default(true),reason};
const create=z.object({...definition,hubId:uuid.nullable().default(null),personId:uuid.nullable().default(null),kind:z.enum(['academy','hub','person','organization']),code:z.string().regex(/^[A-Z0-9][A-Z0-9._-]{0,31}$/)}).strict().refine(v=>(v.kind==='person')===(v.personId!==null)&&(v.kind!=='hub'||v.hubId!==null)&&(v.kind!=='academy'||v.hubId===null));
const replace=z.object({...definition,expectedVersion:version}).strict();
const query=z.object({limit:z.coerce.number().int().min(1).max(100).default(50),after:uuid.optional(),q:name.optional(),active:z.enum(['true','false']).transform(v=>v==='true').optional(),hubId:uuid.optional()}).strict();
const history=z.object({limit:query.shape.limit,afterVersion:z.coerce.number().int().min(0).max(2147483647).default(0)}).strict();
export type FinancialPayee={id:string;hub_id:string|null;person_id:string|null;kind:'academy'|'hub'|'person'|'organization';code:string;version:number;currentVersion:number;name:string;legalName:string|null;active:boolean;currentActive:boolean};
const columns='p.id,p.hub_id,p.person_id,p.kind,p.code,v.version,p.version AS "currentVersion",v.name,v.legal_name AS "legalName",v.active,c.active AS "currentActive"';
const source=' FROM public.financial_payees p JOIN public.financial_payee_revisions c ON c.academy_id=p.academy_id AND c.payee_id=p.id AND c.version=p.version JOIN public.financial_payee_revisions v ON v.academy_id=p.academy_id AND v.payee_id=p.id';
const selected='(p.hub_id IS NULL OR (($1::boolean OR p.hub_id=ANY($2::uuid[])) AND NOT p.hub_id=ANY($3::uuid[])))';
function allowed(ctx:ApiContext,cap:Capability){const s=permissionScope(ctx,cap);if(!scopeNonempty(s))throw new ApiError(403,'FORBIDDEN');return s;}
function parameters(ctx:ApiContext){const s=allowed(ctx,'payees.view');return [s.all,s.hubs,s.excludedHubs??[]];}
export async function payeeSelection(ctx:ApiContext,refs:{id:string;version:number}[]):Promise<FinancialPayee[]>{
 if(!refs.length)return [];return(await ctx.db.query<FinancialPayee>('SELECT '+columns+source+' JOIN jsonb_to_recordset($4::jsonb) refs(id uuid,version integer) ON refs.id=p.id AND refs.version=v.version WHERE '+selected,[...parameters(ctx),JSON.stringify(refs)])).rows;
}
export async function payeeRow(ctx:ApiContext,id:string,edit=false):Promise<FinancialPayee>{const p=(await ctx.db.query<FinancialPayee>('SELECT '+columns+source+' WHERE '+selected+' AND v.version=p.version AND p.id=$4',[...parameters(ctx),id])).rows[0];if(!p)throw new ApiError(404,'NOT_FOUND');if(edit)requireScope(allowed(ctx,'payees.edit'),p.hub_id??undefined);return p;}
async function basis(ctx:ApiContext,creating:boolean,id:string,raw:unknown,lock=false){
 const input=creating?create.parse(raw):replace.parse(raw),before=creating?null:await payeeRow(ctx,id,true),hubId=before?before.hub_id:('hubId' in input?input.hubId:null);
 requireScope(allowed(ctx,'payees.view'),hubId??undefined);requireScope(allowed(ctx,'payees.edit'),hubId??undefined);if(lock)await lockAcademyTopology(ctx);
 const hub=hubId?(await ctx.db.query('SELECT id,version,active FROM public.hubs WHERE id=$1',[hubId])).rows[0]:null;if(hubId&&!hub?.active)throw new ApiError(409,'ACTIVE_PAYEE_HUB_REQUIRED');
 const personId=before?before.person_id:('personId' in input?input.personId:null),person=personId?await permittedPerson(ctx,personId,'people.view'):null;
 return {before,hub,person:person?{id:person.id,status:person.status}:null};
}
async function validate(ctx:ApiContext,creating:boolean,id:string,raw:unknown){const b=await basis(ctx,creating,id,raw,true),hubId=b.before?b.before.hub_id:create.parse(raw).hubId;return hubId?{all:false,hubs:[hubId]}:{all:true,hubs:[]};}
async function dependencies(ctx:ApiContext,creating:boolean,id:string,raw:unknown,purpose:'request'|'review'){
 try{const b=await basis(ctx,creating,id,raw),input=creating?create.parse(raw):replace.parse(raw);if(purpose==='request'&&b.before&&'expectedVersion' in input&&b.before.version!==input.expectedVersion)throw new ApiError(409,'PAYEE_CHANGED');if(creating&&b.person?.status!=='active'&&b.person)throw new ApiError(409,'ACTIVE_PAYEE_PERSON_REQUIRED');
  return {...b,existing:creating&&'code' in input?(await ctx.db.query('SELECT id FROM public.financial_payees WHERE(hub_id IS NOT DISTINCT FROM $1 AND code=$2) OR(kind=$3 AND(kind=\'academy\' OR(kind=\'hub\' AND hub_id=$1) OR(kind=\'person\' AND person_id=$4))) ORDER BY id',[input.hubId,input.code,input.kind,input.personId])).rows:[]};
 }catch(error){if(purpose==='review'&&error instanceof ApiError&&[400,403,404,409].includes(error.status))return {unavailable:error.code};throw error;}
}
async function apply(ctx:ApiContext,p:Proposal){
 if(ctx.credential.kind!=='human')throw new ApiError(403,'HUMAN_REVIEW_REQUIRED');const creating=p.action==='finance.payee.create',input=creating?create.parse(p.payload):replace.parse(p.payload),b=await basis(ctx,creating,p.target_id,p.payload,true),v=(b.before?.version??0)+1;
 if(b.before&&(!('expectedVersion' in input)||b.before.version!==input.expectedVersion||p.target_version!==b.before.version))throw new ApiError(409,'PAYEE_CHANGED');
 try{if(b.before)await ctx.db.query('UPDATE public.financial_payees SET version=$2 WHERE id=$1',[p.target_id,v]);else if('kind' in input)await ctx.db.query('INSERT INTO public.financial_payees(academy_id,id,hub_id,person_id,kind,code,created_by) VALUES($1,$2,$3,$4,$5,$6,$7)',[ctx.credential.academy_id,p.target_id,input.hubId,input.personId,input.kind,input.code,ctx.credential.person_id]);
  await ctx.db.query('INSERT INTO public.financial_payee_revisions(academy_id,payee_id,version,name,legal_name,active,changed_by,approval_id,reason) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[ctx.credential.academy_id,p.target_id,v,input.name,input.legalName,input.active,ctx.credential.person_id,p.id,input.reason]);
 }catch(error){if(error&&typeof error==='object'&&'code' in error&&error.code==='23505')throw new ApiError(409,'PAYEE_IDENTITY_OR_CODE_EXISTS');throw error;}
 const result=await payeeRow(ctx,p.target_id);await record(ctx.db,ctx.credential,ctx.requestId,creating?'finance.payee.created':'finance.payee.replaced',p.target_id,result.hub_id,{beforeVersion:b.before?.version??0,afterVersion:v,approvalId:p.id,severity:'critical',hasReason:true});return result;
}
async function reviewer(ctx:ApiContext,p:Proposal){if(await master(ctx))return;const person=p.action==='finance.payee.create'?create.parse(p.payload).personId:(await payeeRow(ctx,p.target_id)).person_id;if(person===ctx.credential.person_id)throw new ApiError(403,'BENEFICIARY_REVIEW_FORBIDDEN');}
export const payeeActions:ApprovalRegistry={
 'finance.payee.create':{requestCapability:'payees.edit',privacyCapability:'payees.edit',policyChange:true,createdStatus:201,validate:(c,id,i)=>validate(c,true,id,i),dependencies:(c,id,i,p)=>dependencies(c,true,id,i,p),authorizeReviewer:reviewer,apply},
 'finance.payee.replace':{requestCapability:'payees.edit',privacyCapability:'payees.edit',policyChange:true,validate:(c,id,i)=>validate(c,false,id,i),dependencies:(c,id,i,p)=>dependencies(c,false,id,i,p),authorizeReviewer:reviewer,apply}
};
export async function payees(ctx:ApiContext,registry:ApprovalRegistry=payeeActions):Promise<Reply|null>{
 const match=/^finance\/payees(?:\/([^/]+)(?:\/(change|history))?)?$/.exec(ctx.path);if(!match)return null;const id=match[1]?uuid.parse(match[1]):null,section=match[2];
 if(ctx.request.method==='POST'){z.object({}).strict().parse(Object.fromEntries(new URL(ctx.request.url).searchParams));if(!id){const input=create.parse(await jsonBody(ctx.request));return propose(ctx,registry,'finance.payee.create',null,0,input);}if(section!=='change')throw new ApiError(405,'METHOD_NOT_ALLOWED');const input=replace.parse(await jsonBody(ctx.request));await payeeRow(ctx,id,true);return propose(ctx,registry,'finance.payee.replace',id,input.expectedVersion,input);}
 if(ctx.request.method!=='GET')throw new ApiError(405,'METHOD_NOT_ALLOWED');if(id){const p=await payeeRow(ctx,id,section==='history');if(section==='history'){const q=history.parse(Object.fromEntries(new URL(ctx.request.url).searchParams)),rows=(await ctx.db.query<{version:number}>('SELECT version,name,legal_name AS "legalName",active,reason,changed_by AS "changedBy",approval_id AS "approvalId",created_at AS "createdAt" FROM public.financial_payee_revisions WHERE payee_id=$1 AND version>$2 ORDER BY version LIMIT $3',[id,q.afterVersion,q.limit+1])).rows;return {status:200,body:{data:rows.slice(0,q.limit),nextVersion:rows.length>q.limit?rows[q.limit-1].version:null}};}z.object({}).strict().parse(Object.fromEntries(new URL(ctx.request.url).searchParams));return {status:200,body:{data:p}};}
 const q=query.parse(Object.fromEntries(new URL(ctx.request.url).searchParams)),rows=(await ctx.db.query<{id:string}>('SELECT '+columns+source+' WHERE '+selected+' AND v.version=p.version AND($4::uuid IS NULL OR p.id>$4) AND($5::uuid IS NULL OR p.hub_id=$5) AND($6::boolean IS NULL OR v.active=$6) AND($7::text IS NULL OR position(lower($7) in lower(p.code||\' \'||v.name))>0) ORDER BY p.id LIMIT $8',[...parameters(ctx),q.after??null,q.hubId??null,q.active??null,q.q??null,q.limit+1])).rows;return {status:200,body:{data:rows.slice(0,q.limit),nextCursor:rows.length>q.limit?rows[q.limit-1].id:null}};
}
export const payeesContract=[
 {path:'/api/v1/finance/payees',method:'get',summary:'Scoped named academy/hub/person/organization payees; shared school labels are selectable, not bank/payment authority',querySchema:query},
 {path:'/api/v1/finance/payees',method:'post',summary:'Request reviewed named payee identity without inventing an account, legal name or tax/employment classification',schema:create},
 {path:'/api/v1/finance/payees/{id}',method:'get',summary:'Read a permitted current payee profile'},
 {path:'/api/v1/finance/payees/{id}/change',method:'post',summary:'Replace name/legal-name/status while retaining immutable identity and earlier revisions',schema:replace},
 {path:'/api/v1/finance/payees/{id}/history',method:'get',summary:'Editor-only bounded immutable payee revisions and private review reasons',querySchema:history}
] as const;
