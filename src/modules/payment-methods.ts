import { z } from 'zod';
import { jsonBody,record,type ApiContext,type Reply } from '../core/api.ts';
import { propose,permissionScope,type ApprovalRegistry,type Proposal } from '../core/approvals.ts';
import { ApiError,requireScope,scopeNonempty,type Capability } from '../core/policy.ts';
import { lockAcademyTopology,mergeLabels } from './academy.ts';

const uuid=z.string().uuid().transform(v=>v.toLowerCase()),version=z.number().int().positive().max(2_147_483_647);
const text=z.string().refine(v=>v.isWellFormed()&&!v.includes('\0')),name=text.trim().min(1).max(200),reason=text.trim().min(1).max(2000);
const translations=z.object({en:name.optional(),fr:name.optional(),'zh-CN':name.optional()}).strict();
const labelsPatch=z.object({en:name.nullable().optional(),fr:name.nullable().optional(),'zh-CN':name.nullable().optional()}).strict();
const category=z.enum(['cash','e_transfer','credit_card','debit_card','cheque','bank_transfer','other']);
const definition=z.object({name,active:z.boolean(),translations}).strip();
const create=z.object({name,active:z.boolean().default(true),translations:translations.default({}),category,
 code:z.string().regex(/^[A-Z0-9][A-Z0-9._-]{0,31}$/),hubId:uuid.nullable().default(null),reason}).strict();
const change=z.object({name:name.optional(),active:z.boolean().optional(),translations:labelsPatch.optional(),expectedVersion:version,reason}).strict()
 .refine(v=>['name','active','translations'].some(k=>Object.hasOwn(v,k)));
const paging={limit:z.coerce.number().int().min(1).max(100).default(50),after:uuid.optional()};
const query=z.object({...paging,hubId:uuid.optional(),category:category.optional(),active:z.enum(['true','false']).transform(v=>v==='true').optional(),q:text.trim().min(1).max(100).optional()}).strict();
const historyQuery=z.object({limit:paging.limit,afterVersion:z.coerce.number().int().min(0).max(2_147_483_647).default(0)}).strict();
type Method=z.infer<typeof definition>&{id:string;code:string;category:z.infer<typeof category>;hubId:string|null;version:number};
const columns='m.id,m.code,m.category,m.hub_id AS "hubId",m.version,m.name,m.active,m.translations,m.created_by AS "createdBy",m.created_at AS "createdAt",m.revised_at AS "revisedAt"';
const selected=`((m.hub_id IS NULL AND $1::boolean AND cardinality($3::uuid[])=0 AND $4::boolean)
 OR(m.hub_id IS NOT NULL AND ($1::boolean OR m.hub_id=ANY($2::uuid[])) AND NOT m.hub_id=ANY($3::uuid[])))`;
function allowed(ctx:ApiContext,cap:Capability){const s=permissionScope(ctx,cap);if(!scopeNonempty(s))throw new ApiError(403,'FORBIDDEN');return s;}
function scope(ctx:ApiContext){const s=allowed(ctx,'payment-methods.view');return [s.all,s.hubs,s.excludedHubs??[],!s.excludedAreas?.length];}
// A directory entry never implies an online gateway or a received payment.
const publicMethod=(m:Method)=>({...m,processing:'manual_record_only' as const,onlinePaymentEnabled:false});
export async function paymentMethodRow(ctx:ApiContext,id:string,edit=false,lock=false):Promise<Method>{
 const r=(await ctx.db.query<Method>('SELECT '+columns+' FROM public.finance_payment_method_catalogue m WHERE '+selected+' AND m.id=$5',[...scope(ctx),id])).rows[0];
 if(!r)throw new ApiError(404,'NOT_FOUND');if(edit)requireScope(allowed(ctx,'payment-methods.edit'),r.hubId??undefined);
 if(lock){await ctx.db.query('SELECT id FROM public.finance_payment_methods WHERE id=$1 FOR UPDATE',[id]);return paymentMethodRow(ctx,id,edit);}return r;
}
async function destination(ctx:ApiContext,hubId:string|null){
 requireScope(allowed(ctx,'payment-methods.view'),hubId??undefined);requireScope(allowed(ctx,'payment-methods.edit'),hubId??undefined);
 if(hubId&&!(await ctx.db.query('SELECT 1 FROM public.hubs WHERE id=$1 AND active',[hubId])).rows.length)throw new ApiError(409,'ACTIVE_HUB_REQUIRED');
 return hubId?{all:false,hubs:[hubId]}:{all:true,hubs:[]};
}
async function validate(ctx:ApiContext,creating:boolean,id:string,raw:unknown){
 const input=creating?create.parse(raw):change.parse(raw);
 if(creating&&'hubId' in input){await destination(ctx,input.hubId);await lockAcademyTopology(ctx);return destination(ctx,input.hubId);}
 await paymentMethodRow(ctx,id,true);await lockAcademyTopology(ctx);const before=await paymentMethodRow(ctx,id,true,true);
 if(!('expectedVersion' in input)||input.expectedVersion!==before.version)throw new ApiError(409,'TARGET_CHANGED');
 return before.hubId?{all:false,hubs:[before.hubId]}:{all:true,hubs:[]};
}
async function dependencies(ctx:ApiContext,creating:boolean,id:string,raw:unknown){
 const current=(await ctx.db.query('SELECT id,hub_id,code,category,version FROM public.finance_payment_methods WHERE id=$1',[id])).rows[0]??null,input=creating?create.parse(raw):null,hubId=creating?input!.hubId:current?.hub_id;
 return {current,hub:hubId?(await ctx.db.query('SELECT id,version,active FROM public.hubs WHERE id=$1',[hubId])).rows[0]??null:null,
  codeOwner:input?(await ctx.db.query('SELECT id FROM public.finance_payment_methods WHERE hub_id IS NOT DISTINCT FROM $1 AND code=$2',[input.hubId,input.code])).rows[0]??null:null};
}
async function apply(ctx:ApiContext,p:Proposal){
 if(ctx.credential.kind!=='human')throw new ApiError(403,'HUMAN_REVIEW_REQUIRED');
 const creating=p.action==='finance.payment-method.create',input=creating?create.parse(p.payload):change.parse(p.payload),before=creating?null:await paymentMethodRow(ctx,p.target_id,true,true);
 if(before&&(!('expectedVersion' in input)||before.version!==input.expectedVersion||before.version!==p.target_version))throw new ApiError(409,'TARGET_CHANGED');
 const body=definition.parse({...before,...input,translations:mergeLabels(before?.translations,input.translations)}),next=before?before.version+1:1,hubId=before?before.hubId:('hubId' in input?input.hubId:null);
 try {
  if(before)await ctx.db.query('UPDATE public.finance_payment_methods SET version=$2 WHERE id=$1',[p.target_id,next]);
  else if('code' in input)await ctx.db.query('INSERT INTO public.finance_payment_methods(academy_id,id,hub_id,code,category,created_by) VALUES($1,$2,$3,$4,$5,$6)',[ctx.credential.academy_id,p.target_id,hubId,input.code,input.category,ctx.credential.person_id]);
  await ctx.db.query(`INSERT INTO public.finance_payment_method_revisions(academy_id,method_id,version,name,active,translations,changed_by,approval_id,reason)
   VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9)`,[ctx.credential.academy_id,p.target_id,next,body.name,body.active,JSON.stringify(body.translations),ctx.credential.person_id,p.id,input.reason]);
 }catch(error){if(error&&typeof error==='object'&&'code' in error&&error.code==='23505')throw new ApiError(409,'PAYMENT_METHOD_CODE_EXISTS');throw error;}
 await record(ctx.db,ctx.credential,ctx.requestId,creating?'finance.payment-method.created':'finance.payment-method.updated',p.target_id,hubId,{beforeVersion:before?.version??null,afterVersion:next,approvalId:p.id,severity:'critical',hasReason:true});return publicMethod(await paymentMethodRow(ctx,p.target_id));
}
export const paymentMethodActions:ApprovalRegistry={
 'finance.payment-method.create':{requestCapability:'payment-methods.edit',privacyCapability:'payment-methods.edit',createdStatus:201,validate:(c,id,i)=>validate(c,true,id,i),dependencies:(c,id,i)=>dependencies(c,true,id,i),apply},
 'finance.payment-method.update':{requestCapability:'payment-methods.edit',privacyCapability:'payment-methods.edit',validate:(c,id,i)=>validate(c,false,id,i),dependencies:(c,id,i)=>dependencies(c,false,id,i),apply}
};
export async function paymentMethods(ctx:ApiContext,registry:ApprovalRegistry=paymentMethodActions):Promise<Reply|null>{
 const match=/^finance\/payment-methods(?:\/([^/]+)(?:\/(change|history))?)?$/.exec(ctx.path);if(!match)return null;
 const id=match[1]?uuid.parse(match[1]):null,section=match[2];
 if(ctx.request.method==='POST'){
  z.object({}).strict().parse(Object.fromEntries(new URL(ctx.request.url).searchParams));
  if(!id){const input=create.parse(await jsonBody(ctx.request));await destination(ctx,input.hubId);return propose(ctx,registry,'finance.payment-method.create',null,0,input);}
  if(section!=='change')throw new ApiError(405,'METHOD_NOT_ALLOWED');const input=change.parse(await jsonBody(ctx.request));await paymentMethodRow(ctx,id,true);return propose(ctx,registry,'finance.payment-method.update',id,input.expectedVersion,input);
 }
 if(ctx.request.method!=='GET')throw new ApiError(405,'METHOD_NOT_ALLOWED');
 if(id){const data=await paymentMethodRow(ctx,id,section==='history');
  if(section==='history'){const q=historyQuery.parse(Object.fromEntries(new URL(ctx.request.url).searchParams)),rows=(await ctx.db.query<{version:number}>('SELECT version,name,active,translations,changed_by AS "changedBy",approval_id AS "approvalId",reason,created_at AS "createdAt" FROM public.finance_payment_method_revisions WHERE method_id=$1 AND version>$2 ORDER BY version LIMIT $3',[id,q.afterVersion,q.limit+1])).rows;return {status:200,body:{data:rows.slice(0,q.limit),nextVersion:rows.length>q.limit?rows[q.limit-1].version:null}};}
  if(section)throw new ApiError(405,'METHOD_NOT_ALLOWED');z.object({}).strict().parse(Object.fromEntries(new URL(ctx.request.url).searchParams));return {status:200,body:{data:publicMethod(data)}};
 }
 const q=query.parse(Object.fromEntries(new URL(ctx.request.url).searchParams)),rows=(await ctx.db.query<Method>('SELECT '+columns+' FROM public.finance_payment_method_catalogue m WHERE '+selected+' AND ($5::uuid IS NULL OR m.id>$5) AND ($6::uuid IS NULL OR m.hub_id=$6) AND ($7::boolean IS NULL OR m.active=$7) AND ($8::text IS NULL OR m.category=$8) AND ($9::text IS NULL OR position(lower($9) in lower(m.name||\' \'||m.code))>0) ORDER BY m.id LIMIT $10',[...scope(ctx),q.after??null,q.hubId??null,q.active??null,q.category??null,q.q??null,q.limit+1])).rows;
 return {status:200,body:{data:rows.slice(0,q.limit).map(publicMethod),nextCursor:rows.length>q.limit?rows[q.limit-1].id:null}};
}
export const paymentMethodsContract=[
 {path:'/api/v1/finance/payment-methods',method:'get',summary:'Scoped manual payment-method directory; no online gateway, payment receipt or tax exemption implied',querySchema:query},
 {path:'/api/v1/finance/payment-methods',method:'post',summary:'Request a reviewed school/hub-owned payment-method definition without card or bank credentials',schema:create},
 {path:'/api/v1/finance/payment-methods/{id}',method:'get',summary:'Read a permitted current payment-method definition'},
 {path:'/api/v1/finance/payment-methods/{id}/change',method:'post',summary:'Request immutable label/status revisions; method code/category/ownership cannot silently move',schema:change},
 {path:'/api/v1/finance/payment-methods/{id}/history',method:'get',summary:'Editor-only immutable payment-method definitions and private review reasons',querySchema:historyQuery}
] as const;
