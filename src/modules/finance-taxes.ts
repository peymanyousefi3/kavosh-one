import { z } from 'zod';
import { jsonBody,record,type ApiContext,type Reply } from '../core/api.ts';
import { propose,permissionScope,type ApprovalRegistry,type Proposal } from '../core/approvals.ts';
import { ApiError,requireScope,scopeNonempty,type Capability } from '../core/policy.ts';
import { parseMoney,formatMoney,roundRatio } from '../core/money.ts';
import { accountingDate } from './finance-periods.ts';
import { lockAcademyTopology,mergeLabels } from './academy.ts';

const uuid=z.string().uuid().transform(v=>v.toLowerCase()),version=z.number().int().positive().max(2_147_483_647);
const text=z.string().refine(v=>v.isWellFormed()&&!v.includes('\0')),name=text.trim().min(1).max(200),reason=text.trim().min(1).max(2000);
const translations=z.object({en:name.optional(),fr:name.optional(),'zh-CN':name.optional()}).strict();
const labelsPatch=z.object({en:name.nullable().optional(),fr:name.nullable().optional(),'zh-CN':name.nullable().optional()}).strict();
const classification=z.enum(['taxable','zero_rated','exempt','out_of_scope']);
const percent=z.string().regex(/^(?:0|[1-9][0-9]{0,2})(?:\.[0-9]{1,4})?$/).refine(v=>parseMoney(v,4)<=1000000n);
const fields={name,countryCode:z.string().regex(/^[A-Z]{2}$/),regionCode:z.string().regex(/^[A-Z0-9][A-Z0-9_-]{0,19}$/).nullable(),classification,ratePercent:percent,
 startsOn:accountingDate,endsOn:accountingDate.nullable(),legalBasis:reason,active:z.boolean(),translations};
const definition=z.object(fields).strip().superRefine((v,ctx)=>{
 if((v.classification==='taxable')!==(parseMoney(v.ratePercent,4)>0n))ctx.addIssue({code:'custom',message:'Positive rates require taxable classification; other classifications require zero.'});
 if(v.endsOn&&v.endsOn<v.startsOn)ctx.addIssue({code:'custom',message:'End date cannot precede start date.'});
});
const create=z.object({...fields,code:z.string().regex(/^[A-Z0-9][A-Z0-9._-]{0,31}$/),hubId:uuid.nullable().default(null),regionCode:fields.regionCode.default(null),endsOn:fields.endsOn.default(null),active:z.boolean().default(true),translations:translations.default({}),reason}).strict();
const change=z.object({...fields,translations:labelsPatch}).partial().extend({expectedVersion:version,reason}).strict().refine(v=>Object.keys(v).some(k=>!['expectedVersion','reason'].includes(k)));
const paging={limit:z.coerce.number().int().min(1).max(100).default(50),after:uuid.optional()};
const query=z.object({...paging,hubId:uuid.optional(),classification:classification.optional(),active:z.enum(['true','false']).transform(v=>v==='true').optional(),on:accountingDate.optional(),q:text.trim().min(1).max(100).optional()}).strict();
const historyQuery=z.object({limit:paging.limit,afterVersion:z.coerce.number().int().min(0).max(2_147_483_647).default(0)}).strict();
const previewInput=z.object({expectedVersion:version,currencyId:uuid,currencyVersion:version,on:accountingDate,amount:z.string().min(1).max(80),pricing:z.enum(['tax_inclusive','tax_exclusive','not_applicable'])}).strict();
type Tax=z.infer<typeof definition>&{id:string;code:string;hubId:string|null;version:number};
const columns='t.id,t.code,t.hub_id AS "hubId",t.version,t.name,t.country_code AS "countryCode",t.region_code AS "regionCode",t.classification,round(t.rate_millionths::numeric/10000,4)::text AS "ratePercent",t.starts_on::text AS "startsOn",t.ends_on::text AS "endsOn",t.legal_basis AS "legalBasis",t.active,t.translations,t.created_by AS "createdBy",t.created_at AS "createdAt",t.revised_at AS "revisedAt"';
const selected=`((t.hub_id IS NULL AND $1::boolean AND cardinality($3::uuid[])=0 AND $4::boolean)
 OR(t.hub_id IS NOT NULL AND ($1::boolean OR t.hub_id=ANY($2::uuid[])) AND NOT t.hub_id=ANY($3::uuid[])))`;
function allowed(ctx:ApiContext,cap:Capability){const s=permissionScope(ctx,cap);if(!scopeNonempty(s))throw new ApiError(403,'FORBIDDEN');return s;}
function scope(ctx:ApiContext){const s=allowed(ctx,'tax-codes.view');return [s.all,s.hubs,s.excludedHubs??[],!s.excludedAreas?.length];}
async function row(ctx:ApiContext,id:string,edit=false,lock=false):Promise<Tax> {
 const r=(await ctx.db.query<Tax>('SELECT '+columns+' FROM public.finance_tax_catalogue t WHERE '+selected+' AND t.id=$5',[...scope(ctx),id])).rows[0];
 if(!r)throw new ApiError(404,'NOT_FOUND');if(edit)requireScope(allowed(ctx,'tax-codes.edit'),r.hubId??undefined);
 if(lock){await ctx.db.query('SELECT id FROM public.finance_tax_codes WHERE id=$1 FOR UPDATE',[id]);return row(ctx,id,edit);}return r;
}
async function destination(ctx:ApiContext,hubId:string|null){
 requireScope(allowed(ctx,'tax-codes.view'),hubId??undefined);requireScope(allowed(ctx,'tax-codes.edit'),hubId??undefined);
 if(hubId&&!(await ctx.db.query('SELECT 1 FROM public.hubs WHERE id=$1 AND active',[hubId])).rows.length)throw new ApiError(409,'ACTIVE_HUB_REQUIRED');
 return hubId?{all:false,hubs:[hubId]}:{all:true,hubs:[]};
}
function merged(before:Tax|null,input:z.infer<typeof create>|z.infer<typeof change>){return definition.parse({...before,...input,translations:mergeLabels(before?.translations,input.translations)});}
async function validate(ctx:ApiContext,creating:boolean,id:string,raw:unknown){
 const input=creating?create.parse(raw):change.parse(raw);
 if(creating&&'hubId' in input){merged(null,input);await destination(ctx,input.hubId);await lockAcademyTopology(ctx);return destination(ctx,input.hubId);}
 await row(ctx,id,true);await lockAcademyTopology(ctx);const before=await row(ctx,id,true,true);
 if(!('expectedVersion' in input)||input.expectedVersion!==before.version)throw new ApiError(409,'TARGET_CHANGED');merged(before,input);
 return before.hubId?{all:false,hubs:[before.hubId]}:{all:true,hubs:[]};
}
async function dependencies(ctx:ApiContext,creating:boolean,id:string,raw:unknown){
 const current=(await ctx.db.query('SELECT id,hub_id,code,version FROM public.finance_tax_codes WHERE id=$1',[id])).rows[0]??null,input=creating?create.parse(raw):null,hubId=creating?input!.hubId:current?.hub_id;
 return {current,hub:hubId?(await ctx.db.query('SELECT id,version,active FROM public.hubs WHERE id=$1',[hubId])).rows[0]??null:null,
  codeOwner:input?(await ctx.db.query('SELECT id FROM public.finance_tax_codes WHERE hub_id IS NOT DISTINCT FROM $1 AND code=$2',[input.hubId,input.code])).rows[0]??null:null};
}
async function apply(ctx:ApiContext,p:Proposal){
 if(ctx.credential.kind!=='human')throw new ApiError(403,'HUMAN_REVIEW_REQUIRED');
 const creating=p.action==='finance.tax-code.create',input=creating?create.parse(p.payload):change.parse(p.payload),before=creating?null:await row(ctx,p.target_id,true,true);
 if(before&&(!('expectedVersion' in input)||before.version!==input.expectedVersion||before.version!==p.target_version))throw new ApiError(409,'TARGET_CHANGED');
 const body=merged(before,input),next=before?before.version+1:1,hubId=before?before.hubId:('hubId' in input?input.hubId:null);
 try {
  if(before)await ctx.db.query('UPDATE public.finance_tax_codes SET version=$2 WHERE id=$1',[p.target_id,next]);
  else if('code' in input)await ctx.db.query('INSERT INTO public.finance_tax_codes(academy_id,id,hub_id,code,created_by) VALUES($1,$2,$3,$4,$5)',[ctx.credential.academy_id,p.target_id,hubId,input.code,ctx.credential.person_id]);
  await ctx.db.query(`INSERT INTO public.finance_tax_code_revisions(academy_id,tax_code_id,version,name,country_code,region_code,classification,rate_millionths,starts_on,ends_on,legal_basis,active,translations,changed_by,approval_id,reason)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14,$15,$16)`,[ctx.credential.academy_id,p.target_id,next,body.name,body.countryCode,body.regionCode,body.classification,Number(parseMoney(body.ratePercent,4)),body.startsOn,body.endsOn,body.legalBasis,body.active,JSON.stringify(body.translations),ctx.credential.person_id,p.id,input.reason]);
 }catch(error){if(error&&typeof error==='object'&&'code' in error&&error.code==='23505')throw new ApiError(409,'TAX_CODE_EXISTS');throw error;}
 await record(ctx.db,ctx.credential,ctx.requestId,creating?'finance.tax-code.created':'finance.tax-code.updated',p.target_id,hubId,{beforeVersion:before?.version??null,afterVersion:next,approvalId:p.id,severity:'critical',hasReason:true});return row(ctx,p.target_id);
}
export const taxActions:ApprovalRegistry={
 'finance.tax-code.create':{requestCapability:'tax-codes.edit',privacyCapability:'tax-codes.edit',createdStatus:201,validate:(c,id,i)=>validate(c,true,id,i),dependencies:(c,id,i)=>dependencies(c,true,id,i),apply},
 'finance.tax-code.update':{requestCapability:'tax-codes.edit',privacyCapability:'tax-codes.edit',validate:(c,id,i)=>validate(c,false,id,i),dependencies:(c,id,i)=>dependencies(c,false,id,i),apply}
};
async function preview(ctx:ApiContext,id:string){
 const input=previewInput.parse(await jsonBody(ctx.request));await row(ctx,id);requireScope(permissionScope(ctx,'currencies.view'));
 // One snapshot binds current code and currency revisions; no source is read
 // from a second, potentially changed definition after the calculation begins.
 const r=(await ctx.db.query<Tax&{unitScale:number;currencyCode:string;currencyActive:boolean}>('SELECT '+columns+',c.code AS "currencyCode",u.unit_scale AS "unitScale",u.active AS "currencyActive" FROM public.finance_tax_catalogue t JOIN public.finance_currencies c ON c.academy_id=t.academy_id AND c.id=$6 AND c.version=$7 JOIN public.finance_currency_revisions u ON u.academy_id=c.academy_id AND u.currency_id=c.id AND u.version=c.version WHERE '+selected+' AND t.id=$5 AND t.version=$8',[...scope(ctx),id,input.currencyId,input.currencyVersion,input.expectedVersion])).rows[0];
 if(!r)throw new ApiError(409,'TAX_OR_CURRENCY_CHANGED');if(!r.active||!r.currencyActive||input.on<r.startsOn||(r.endsOn&&input.on>r.endsOn))throw new ApiError(409,'ACTIVE_EFFECTIVE_TAX_AND_CURRENCY_REQUIRED');
 const nonTax=r.classification==='exempt'||r.classification==='out_of_scope';if(nonTax!==(input.pricing==='not_applicable'))throw new ApiError(400,'TAX_PRICING_CLASSIFICATION_MISMATCH');
 const amount=parseMoney(input.amount,r.unitScale),rate=parseMoney(r.ratePercent,4),tax=roundRatio(amount*rate,input.pricing==='tax_inclusive'?1000000n+rate:1000000n,'half_away');
 const net=input.pricing==='tax_inclusive'?amount-tax:amount,gross=input.pricing==='tax_inclusive'?amount:amount+tax;
 return {status:200,body:{data:{taxCodeId:r.id,taxCodeVersion:r.version,currencyId:input.currencyId,currencyVersion:input.currencyVersion,currencyCode:r.currencyCode,unitScale:r.unitScale,on:input.on,classification:r.classification,ratePercent:r.ratePercent,pricing:input.pricing,rounding:'half_away',net:formatMoney(net,r.unitScale),tax:formatMoney(tax,r.unitScale),gross:formatMoney(gross,r.unitScale),previewOnly:true,posted:false,taxEligibilityDetermined:false}}};
}
export async function financeTaxes(ctx:ApiContext,registry:ApprovalRegistry=taxActions):Promise<Reply|null>{
 const match=/^finance\/tax-codes(?:\/([^/]+)(?:\/(change|history|preview))?)?$/.exec(ctx.path);if(!match)return null;
 const id=match[1]?uuid.parse(match[1]):null,section=match[2];
 if(ctx.request.method==='POST'){
  z.object({}).strict().parse(Object.fromEntries(new URL(ctx.request.url).searchParams));
  if(id&&section==='preview')return preview(ctx,id);
  if(!id){const input=create.parse(await jsonBody(ctx.request));merged(null,input);await destination(ctx,input.hubId);return propose(ctx,registry,'finance.tax-code.create',null,0,input);}
  if(section!=='change')throw new ApiError(405,'METHOD_NOT_ALLOWED');const input=change.parse(await jsonBody(ctx.request));await row(ctx,id,true);return propose(ctx,registry,'finance.tax-code.update',id,input.expectedVersion,input);
 }
 if(ctx.request.method!=='GET')throw new ApiError(405,'METHOD_NOT_ALLOWED');
 if(id){const data=await row(ctx,id,section==='history');
  if(section==='history'){const q=historyQuery.parse(Object.fromEntries(new URL(ctx.request.url).searchParams)),rows=(await ctx.db.query<{version:number}>(`SELECT version,name,country_code AS "countryCode",region_code AS "regionCode",classification,round(rate_millionths::numeric/10000,4)::text AS "ratePercent",starts_on::text AS "startsOn",ends_on::text AS "endsOn",legal_basis AS "legalBasis",active,translations,changed_by AS "changedBy",approval_id AS "approvalId",reason,created_at AS "createdAt" FROM public.finance_tax_code_revisions WHERE tax_code_id=$1 AND version>$2 ORDER BY version LIMIT $3`,[id,q.afterVersion,q.limit+1])).rows;return {status:200,body:{data:rows.slice(0,q.limit),nextVersion:rows.length>q.limit?rows[q.limit-1].version:null}};}
  if(section)throw new ApiError(405,'METHOD_NOT_ALLOWED');z.object({}).strict().parse(Object.fromEntries(new URL(ctx.request.url).searchParams));return {status:200,body:{data}};
 }
 const q=query.parse(Object.fromEntries(new URL(ctx.request.url).searchParams)),rows=(await ctx.db.query<{id:string}>('SELECT '+columns+' FROM public.finance_tax_catalogue t WHERE '+selected+' AND ($5::uuid IS NULL OR t.id>$5) AND ($6::uuid IS NULL OR t.hub_id=$6) AND ($7::boolean IS NULL OR t.active=$7) AND ($8::text IS NULL OR t.classification=$8) AND ($9::date IS NULL OR(t.starts_on<=$9 AND(t.ends_on IS NULL OR t.ends_on>=$9))) AND ($10::text IS NULL OR position(lower($10) in lower(t.name||\' \'||t.code))>0) ORDER BY t.id LIMIT $11',[...scope(ctx),q.after??null,q.hubId??null,q.active??null,q.classification??null,q.on??null,q.q??null,q.limit+1])).rows;
 return {status:200,body:{data:rows.slice(0,q.limit),nextCursor:rows.length>q.limit?rows[q.limit-1].id:null}};
}
export const taxesContract=[
 {path:'/api/v1/finance/tax-codes',method:'get',summary:'Scoped configured tax classifications, exact rates and effective dates; not an automatic legal determination',querySchema:query},
 {path:'/api/v1/finance/tax-codes',method:'post',summary:'Request upper-human reviewed tax code with explicit classification, rate and legal basis',schema:create},
 {path:'/api/v1/finance/tax-codes/{id}',method:'get',summary:'Read a permitted current tax-code definition'},
 {path:'/api/v1/finance/tax-codes/{id}/change',method:'post',summary:'Request an immutable tax-code revision without changing historical definitions or ownership',schema:change},
 {path:'/api/v1/finance/tax-codes/{id}/history',method:'get',summary:'Editor-only immutable tax definitions and private review reasons',querySchema:historyQuery},
 {path:'/api/v1/finance/tax-codes/{id}/preview',method:'post',readOnly:true,summary:'Exact single-code inclusive/exclusive amount preview under current source versions; no posting, remittance or input-credit eligibility decision',schema:previewInput}
] as const;
