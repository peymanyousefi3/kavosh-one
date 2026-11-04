import { z } from 'zod';
import { jsonBody,record,type ApiContext,type Reply } from '../core/api.ts';
import { propose,permissionScope,type ApprovalRegistry,type Proposal } from '../core/approvals.ts';
import { ApiError,requireScope,scopeNonempty,type Capability } from '../core/policy.ts';
import { lockAcademyTopology,mergeLabels } from './academy.ts';
import { lockFinanceBook } from '../core/finance-lock.ts';

const uuid=z.string().uuid().transform(v=>v.toLowerCase()),version=z.number().int().positive().max(2_147_483_647);
const text=z.string().refine(v=>v.isWellFormed()&&!v.includes('\0')),name=text.trim().min(1).max(200),reason=text.trim().min(1).max(2000);
const translations=z.object({en:name.optional(),fr:name.optional(),'zh-CN':name.optional()}).strict();
const labelsPatch=z.object({en:name.nullable().optional(),fr:name.nullable().optional(),'zh-CN':name.nullable().optional()}).strict();
const currencyFields={name,symbol:text.max(16),unitScale:z.number().int().min(0).max(18),active:z.boolean(),translations};
const currencyDefinition=z.object(currencyFields).strip();
const currencyCreate=z.object({...currencyFields,code:z.string().regex(/^[A-Z]{3}$/),symbol:currencyFields.symbol.default(''),active:z.boolean().default(true),translations:translations.default({}),reason}).strict();
const currencyUpdate=z.object({...currencyFields,translations:labelsPatch}).partial().extend({expectedVersion:version,reason}).strict().refine(v=>Object.keys(v).some(k=>!['expectedVersion','reason'].includes(k)));
const kind=z.enum(['asset','liability','equity','income','expense']),balance=z.enum(['debit','credit']);
const accountFields={code:z.string().regex(/^[A-Z0-9][A-Z0-9._-]{0,31}$/),name,description:text.max(2000),kind,normalBalance:balance,active:z.boolean(),translations};
const accountDefinition=z.object(accountFields).strip();
const accountCreate=z.object({...accountFields,description:accountFields.description.default(''),normalBalance:balance.optional(),active:z.boolean().default(true),translations:translations.default({}),hubId:uuid.nullable().default(null),currencyId:uuid,currencyVersion:version,reason}).strict();
const accountUpdate=z.object({...accountFields,translations:labelsPatch}).partial().extend({expectedVersion:version,reason}).strict().refine(v=>Object.keys(v).some(k=>!['expectedVersion','reason'].includes(k)));
const listFields={limit:z.coerce.number().int().min(1).max(100).default(50),after:uuid.optional(),q:text.trim().min(1).max(100).optional(),active:z.enum(['true','false']).transform(v=>v==='true').optional()};
const currencyQuery=z.object(listFields).strict(),accountQuery=z.object({...listFields,hubId:uuid.optional(),currencyId:uuid.optional(),kind:kind.optional()}).strict();
const historyQuery=z.object({limit:listFields.limit,afterVersion:z.coerce.number().int().min(0).max(2_147_483_647).default(0)}).strict();
type Currency=z.infer<typeof currencyDefinition>&{id:string;code:string;version:number};
type Account=z.infer<typeof accountDefinition>&{id:string;version:number;hubId:string|null;currencyId:string;currencyVersion:number;unitScale:number};
const currencyFieldsSQL='id,code,version,name,symbol,unit_scale AS "unitScale",active,translations,created_by AS "createdBy",created_at AS "createdAt",revised_at AS "revisedAt"';
const accountFieldsSQL='a.id,a.code,a.version,a.hub_id AS "hubId",a.currency_id AS "currencyId",a.currency_version AS "currencyVersion",a.name,a.description,a.kind,a.normal_balance AS "normalBalance",a.active,a.translations,a.currency_code AS "currencyCode",a.unit_scale AS "unitScale",a.currency_symbol AS "currencySymbol",a.created_by AS "createdBy",a.created_at AS "createdAt",a.revised_at AS "revisedAt"';
function allowed(ctx:ApiContext,cap:Capability){const s=permissionScope(ctx,cap);if(!scopeNonempty(s))throw new ApiError(403,'FORBIDDEN');return s;}
function currencyAuthority(ctx:ApiContext,edit=false){requireScope(allowed(ctx,'currencies.view'));if(edit)requireScope(allowed(ctx,'currencies.edit'));}
async function currencyRow(ctx:ApiContext,id:string,edit=false,lock=false):Promise<Currency> {
  currencyAuthority(ctx,edit);
  if(lock&&!(await ctx.db.query('SELECT id FROM public.finance_currencies WHERE id=$1 FOR UPDATE',[id])).rows.length)throw new ApiError(404,'NOT_FOUND');
  const row=(await ctx.db.query<Currency>('SELECT '+currencyFieldsSQL+' FROM public.finance_currency_catalogue WHERE id=$1',[id])).rows[0];if(!row)throw new ApiError(404,'NOT_FOUND');return row;
}
function accountScope(ctx:ApiContext){const s=allowed(ctx,'accounts.view');return [s.all,s.hubs,s.excludedHubs??[],!s.excludedAreas?.length];}
const selected=`((a.hub_id IS NULL AND $1::boolean AND cardinality($3::uuid[])=0 AND $4::boolean)
 OR(a.hub_id IS NOT NULL AND ($1::boolean OR a.hub_id=ANY($2::uuid[])) AND NOT a.hub_id=ANY($3::uuid[])))`;
export async function accountRow(ctx:ApiContext,id:string,edit=false,lock=false):Promise<Account> {
  const params=[...accountScope(ctx),id];const row=(await ctx.db.query<Account>('SELECT '+accountFieldsSQL+' FROM public.finance_account_catalogue a WHERE '+selected+' AND a.id=$5',params)).rows[0];
  if(!row)throw new ApiError(404,'NOT_FOUND');if(edit)requireScope(allowed(ctx,'accounts.edit'),row.hubId??undefined);
  if(lock){await ctx.db.query('SELECT id FROM public.finance_accounts WHERE id=$1 FOR UPDATE',[id]);return accountRow(ctx,id,edit);}
  return row;
}
async function accountDestination(ctx:ApiContext,hubId:string|null){
  requireScope(allowed(ctx,'accounts.view'),hubId??undefined);requireScope(allowed(ctx,'accounts.edit'),hubId??undefined);
  if(hubId&&!(await ctx.db.query('SELECT 1 FROM public.hubs WHERE id=$1 AND active',[hubId])).rows.length)throw new ApiError(409,'ACTIVE_HUB_REQUIRED');
  return hubId?{all:false,hubs:[hubId]}:{all:true,hubs:[]};
}
async function accountCurrency(ctx:ApiContext,input:z.infer<typeof accountCreate>){
  const currency=await currencyRow(ctx,input.currencyId);if(!currency.active)throw new ApiError(409,'ACTIVE_CURRENCY_REQUIRED');if(currency.version!==input.currencyVersion)throw new ApiError(409,'CURRENCY_CHANGED');return currency;
}
async function validateCurrency(ctx:ApiContext,create:boolean,id:string,raw:unknown){
  currencyAuthority(ctx,true);await lockFinanceBook(ctx);if(create)currencyCreate.parse(raw);else {const input=currencyUpdate.parse(raw),before=await currencyRow(ctx,id,true,true);if(before.version!==input.expectedVersion)throw new ApiError(409,'TARGET_CHANGED');}
  return {all:true,hubs:[]};
}
async function validateAccount(ctx:ApiContext,create:boolean,id:string,raw:unknown){
  if(create){const input=accountCreate.parse(raw);await accountDestination(ctx,input.hubId);currencyAuthority(ctx);await lockFinanceBook(ctx);await lockAcademyTopology(ctx);const scope=await accountDestination(ctx,input.hubId);await accountCurrency(ctx,input);return scope;}
  const input=accountUpdate.parse(raw);await accountRow(ctx,id,true);await lockFinanceBook(ctx);await lockAcademyTopology(ctx);const before=await accountRow(ctx,id,true,true);if(before.version!==input.expectedVersion)throw new ApiError(409,'TARGET_CHANGED');
  return before.hubId?{all:false,hubs:[before.hubId]}:{all:true,hubs:[]};
}
async function currencyDependencies(ctx:ApiContext,create:boolean,id:string,raw:unknown){
  const current=(await ctx.db.query('SELECT id,code,version FROM public.finance_currencies WHERE id=$1',[id])).rows[0]??null;
  const input=create?currencyCreate.parse(raw):null;
  return {current,codeOwner:input?(await ctx.db.query('SELECT id FROM public.finance_currencies WHERE code=$1',[input.code])).rows[0]??null:null};
}
async function accountDependencies(ctx:ApiContext,create:boolean,id:string,raw:unknown){
  const current=(await ctx.db.query('SELECT id,hub_id,currency_id,currency_version,code,version FROM public.finance_accounts WHERE id=$1',[id])).rows[0]??null;
  const input=create?accountCreate.parse(raw):null,hubId=create?input!.hubId:current?.hub_id;
  return {current,hub:hubId?(await ctx.db.query('SELECT id,version,active FROM public.hubs WHERE id=$1',[hubId])).rows[0]??null:null,
    currency:input?(await ctx.db.query('SELECT id,version,active FROM public.finance_currency_catalogue WHERE id=$1',[input.currencyId])).rows[0]??null:null};
}
function failure(error:unknown,code:string):never {if(error&&typeof error==='object'&&'code' in error&&error.code==='23505')throw new ApiError(409,code);throw error;}
async function applyCurrency(ctx:ApiContext,p:Proposal){
  if(ctx.credential.kind!=='human')throw new ApiError(403,'HUMAN_REVIEW_REQUIRED');
  const creating=p.action==='finance.currency.create',input=creating?currencyCreate.parse(p.payload):currencyUpdate.parse(p.payload),before=creating?null:await currencyRow(ctx,p.target_id,true,true);
  if(before&&(before.version!==p.target_version||!('expectedVersion' in input)||before.version!==input.expectedVersion))throw new ApiError(409,'TARGET_CHANGED');
  const body=currencyDefinition.parse({...before,...input,translations:mergeLabels(before?.translations,input.translations)}),next=before?before.version+1:1;
  try {
    if(before)await ctx.db.query('UPDATE public.finance_currencies SET version=$2 WHERE id=$1',[p.target_id,next]);
    else await ctx.db.query('INSERT INTO public.finance_currencies(academy_id,id,code,created_by) VALUES($1,$2,$3,$4)',[ctx.credential.academy_id,p.target_id,'code' in input?input.code:null,ctx.credential.person_id]);
    await ctx.db.query(`INSERT INTO public.finance_currency_revisions(academy_id,currency_id,version,name,symbol,unit_scale,active,translations,changed_by,approval_id,reason)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11)`,[ctx.credential.academy_id,p.target_id,next,body.name,body.symbol,body.unitScale,body.active,JSON.stringify(body.translations),ctx.credential.person_id,p.id,input.reason]);
  }catch(error){failure(error,'CURRENCY_CODE_EXISTS');}
  await record(ctx.db,ctx.credential,ctx.requestId,creating?'finance.currency.created':'finance.currency.updated',p.target_id,null,{beforeVersion:before?.version??null,afterVersion:next,approvalId:p.id,severity:'critical',hasReason:true});return currencyRow(ctx,p.target_id);
}
async function applyAccount(ctx:ApiContext,p:Proposal){
  if(ctx.credential.kind!=='human')throw new ApiError(403,'HUMAN_REVIEW_REQUIRED');
  const creating=p.action==='finance.account.create',input=creating?accountCreate.parse(p.payload):accountUpdate.parse(p.payload),before=creating?null:await accountRow(ctx,p.target_id,true,true);
  if(before&&(before.version!==p.target_version||!('expectedVersion' in input)||before.version!==input.expectedVersion))throw new ApiError(409,'TARGET_CHANGED');
  // Standard defaults are editable, including contra accounts. A partial type
  // correction never silently changes an explicitly configured normal side.
  // https://openstax.org/books/principles-financial-accounting/pages/3-1-describe-principles-assumptions-and-concepts-of-accounting-and-their-relationship-to-financial-statements
  const body=accountDefinition.parse({...before,...input,normalBalance:input.normalBalance??before?.normalBalance??(['asset','expense'].includes(input.kind??'')?'debit':'credit'),translations:mergeLabels(before?.translations,input.translations)}),next=before?before.version+1:1;
  const hubId=before?before.hubId:('hubId' in input?input.hubId:null);
  try {
    if(before)await ctx.db.query('UPDATE public.finance_accounts SET code=$2,version=$3 WHERE id=$1',[p.target_id,body.code,next]);
    else if('currencyId' in input)await ctx.db.query('INSERT INTO public.finance_accounts(academy_id,id,hub_id,currency_id,currency_version,code,created_by) VALUES($1,$2,$3,$4,$5,$6,$7)',[ctx.credential.academy_id,p.target_id,hubId,input.currencyId,input.currencyVersion,body.code,ctx.credential.person_id]);
    await ctx.db.query(`INSERT INTO public.finance_account_revisions(academy_id,account_id,version,code,name,description,kind,normal_balance,active,translations,changed_by,approval_id,reason)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13)`,[ctx.credential.academy_id,p.target_id,next,body.code,body.name,body.description,body.kind,body.normalBalance,body.active,JSON.stringify(body.translations),ctx.credential.person_id,p.id,input.reason]);
  }catch(error){failure(error,'ACCOUNT_CODE_EXISTS');}
  await record(ctx.db,ctx.credential,ctx.requestId,creating?'finance.account.created':'finance.account.updated',p.target_id,hubId,{beforeVersion:before?.version??null,afterVersion:next,approvalId:p.id,severity:'critical',hasReason:true});return accountRow(ctx,p.target_id);
}
export const financeActions:ApprovalRegistry={
  'finance.currency.create':{requestCapability:'currencies.edit',privacyCapability:'currencies.edit',policyChange:true,createdStatus:201,validate:(ctx,id,input)=>validateCurrency(ctx,true,id,input),dependencies:(ctx,id,input)=>currencyDependencies(ctx,true,id,input),apply:applyCurrency},
  'finance.currency.update':{requestCapability:'currencies.edit',privacyCapability:'currencies.edit',policyChange:true,validate:(ctx,id,input)=>validateCurrency(ctx,false,id,input),dependencies:(ctx,id,input)=>currencyDependencies(ctx,false,id,input),apply:applyCurrency},
  'finance.account.create':{requestCapability:'accounts.edit',privacyCapability:'accounts.edit',createdStatus:201,validate:(ctx,id,input)=>validateAccount(ctx,true,id,input),dependencies:(ctx,id,input)=>accountDependencies(ctx,true,id,input),apply:applyAccount},
  'finance.account.update':{requestCapability:'accounts.edit',privacyCapability:'accounts.edit',validate:(ctx,id,input)=>validateAccount(ctx,false,id,input),dependencies:(ctx,id,input)=>accountDependencies(ctx,false,id,input),apply:applyAccount}
};
export async function finance(ctx:ApiContext,registry:ApprovalRegistry=financeActions):Promise<Reply|null>{
  const match=/^finance\/(currencies|accounts)(?:\/([^/]+)(?:\/(change|history))?)?$/.exec(ctx.path);if(!match)return null;
  const currencies=match[1]==='currencies',id=match[2]?uuid.parse(match[2]):null,section=match[3];
  if(ctx.request.method==='POST'){
    z.object({}).strict().parse(Object.fromEntries(new URL(ctx.request.url).searchParams));
    if(!id){
      if(currencies){const input=currencyCreate.parse(await jsonBody(ctx.request));currencyAuthority(ctx,true);return propose(ctx,registry,'finance.currency.create',null,0,input);}
      const input=accountCreate.parse(await jsonBody(ctx.request));await accountDestination(ctx,input.hubId);await accountCurrency(ctx,input);return propose(ctx,registry,'finance.account.create',null,0,input);
    }
    if(section!=='change')throw new ApiError(405,'METHOD_NOT_ALLOWED');
    if(currencies){const input=currencyUpdate.parse(await jsonBody(ctx.request));await currencyRow(ctx,id,true);return propose(ctx,registry,'finance.currency.update',id,input.expectedVersion,input);}
    const input=accountUpdate.parse(await jsonBody(ctx.request));await accountRow(ctx,id,true);return propose(ctx,registry,'finance.account.update',id,input.expectedVersion,input);
  }
  if(ctx.request.method!=='GET')throw new ApiError(405,'METHOD_NOT_ALLOWED');
  if(id){
    const row=currencies?await currencyRow(ctx,id,section==='history'):await accountRow(ctx,id,section==='history');
    if(section==='history'){
      const q=historyQuery.parse(Object.fromEntries(new URL(ctx.request.url).searchParams));
      const sql=currencies?'SELECT version,name,symbol,unit_scale AS "unitScale",active,translations,changed_by AS "changedBy",approval_id AS "approvalId",reason,created_at AS "createdAt" FROM public.finance_currency_revisions WHERE currency_id=$1 AND version>$2 ORDER BY version LIMIT $3'
        :'SELECT version,code,name,description,kind,normal_balance AS "normalBalance",active,translations,changed_by AS "changedBy",approval_id AS "approvalId",reason,created_at AS "createdAt" FROM public.finance_account_revisions WHERE account_id=$1 AND version>$2 ORDER BY version LIMIT $3';
      const rows=(await ctx.db.query<{version:number}>(sql,[id,q.afterVersion,q.limit+1])).rows;return {status:200,body:{data:rows.slice(0,q.limit),nextVersion:rows.length>q.limit?rows[q.limit-1].version:null}};
    }
    if(section)throw new ApiError(405,'METHOD_NOT_ALLOWED');z.object({}).strict().parse(Object.fromEntries(new URL(ctx.request.url).searchParams));return {status:200,body:{data:row}};
  }
  if(currencies){
    currencyAuthority(ctx);const q=currencyQuery.parse(Object.fromEntries(new URL(ctx.request.url).searchParams));
    const rows=(await ctx.db.query<{id:string}>('SELECT '+currencyFieldsSQL+' FROM public.finance_currency_catalogue WHERE ($1::uuid IS NULL OR id>$1) AND ($2::boolean IS NULL OR active=$2) AND ($3::text IS NULL OR position(lower($3) in lower(name||\' \'||code))>0) ORDER BY id LIMIT $4',[q.after??null,q.active??null,q.q??null,q.limit+1])).rows;
    return {status:200,body:{data:rows.slice(0,q.limit),nextCursor:rows.length>q.limit?rows[q.limit-1].id:null}};
  }
  const q=accountQuery.parse(Object.fromEntries(new URL(ctx.request.url).searchParams)),rows=(await ctx.db.query<{id:string}>('SELECT '+accountFieldsSQL+' FROM public.finance_account_catalogue a WHERE '+selected+' AND ($5::uuid IS NULL OR a.id>$5) AND ($6::uuid IS NULL OR a.hub_id=$6) AND ($7::uuid IS NULL OR a.currency_id=$7) AND ($8::boolean IS NULL OR a.active=$8) AND ($9::text IS NULL OR a.kind=$9) AND ($10::text IS NULL OR position(lower($10) in lower(a.name||\' \'||a.code))>0) ORDER BY a.id LIMIT $11',[...accountScope(ctx),q.after??null,q.hubId??null,q.currencyId??null,q.active??null,q.kind??null,q.q??null,q.limit+1])).rows;
  return {status:200,body:{data:rows.slice(0,q.limit),nextCursor:rows.length>q.limit?rows[q.limit-1].id:null}};
}
export const financeContract=[
  {path:'/api/v1/finance/currencies',method:'get',summary:'Configured currency units; not ISO validation, exchange rates or balances',querySchema:currencyQuery},
  {path:'/api/v1/finance/currencies',method:'post',summary:'Request a reviewed versioned currency definition with explicit precision',schema:currencyCreate},
  {path:'/api/v1/finance/currencies/{id}',method:'get',summary:'Read current configured currency metadata'},
  {path:'/api/v1/finance/currencies/{id}/change',method:'post',summary:'Request versioned currency metadata/precision changes; existing account units remain pinned',schema:currencyUpdate},
  {path:'/api/v1/finance/currencies/{id}/history',method:'get',summary:'Editor-only immutable currency definitions and private review reasons',querySchema:historyQuery},
  {path:'/api/v1/finance/accounts',method:'get',summary:'Scope-filtered chart of accounts; no fabricated balance or bank connection',querySchema:accountQuery},
  {path:'/api/v1/finance/accounts',method:'post',summary:'Request academy/hub account setup with pinned currency units and upper-human review',schema:accountCreate},
  {path:'/api/v1/finance/accounts/{id}',method:'get',summary:'Read a permitted current chart-of-accounts record and its pinned currency precision'},
  {path:'/api/v1/finance/accounts/{id}/change',method:'post',summary:'Request versioned account metadata changes; ownership and currency binding cannot be silently moved',schema:accountUpdate},
  {path:'/api/v1/finance/accounts/{id}/history',method:'get',summary:'Editor-scoped immutable account revisions and private review reasons',querySchema:historyQuery}
] as const;
