import {z} from 'zod';
import {jsonBody,record,type ApiContext,type Reply} from '../core/api.ts';
import {permissionScope,propose,type ApprovalRegistry,type Proposal} from '../core/approvals.ts';
import {ApiError,requireScope} from '../core/policy.ts';
import {lockFinanceBook} from '../core/finance-lock.ts';
import {lockAcademyTopology} from './academy.ts';

const uuid=z.string().uuid().transform(v=>v.toLowerCase()),version=z.number().int().positive().max(2147483647);
const definition=z.object({currency:z.object({id:uuid,version}).strict(),maximumRateAgeDays:z.number().int().min(0).max(3660)}).strict();
const input=z.object({expectedVersion:z.number().int().min(0).max(2147483646),definition,reason:z.string().trim().min(1).max(2000).refine(v=>v.isWellFormed()&&!v.includes('\0'))}).strict();
const history=z.object({limit:z.coerce.number().int().min(1).max(50).default(10),afterVersion:z.coerce.number().int().min(0).max(2147483647).default(0)}).strict();
type Basis={version:number;definition:z.infer<typeof definition>|null;currency:{id:string;version:number;code:string;unitScale:number;active:boolean}|null};
function authorize(ctx:ApiContext,edit=false){for(const cap of edit?['currencies.view','reporting-defaults.view','reporting-defaults.edit'] as const:['currencies.view','reporting-defaults.view'] as const)requireScope(permissionScope(ctx,cap));}
async function basis(ctx:ApiContext,raw:unknown,lock=false,checkState=true){
 const i=input.parse(raw);authorize(ctx,true);if(lock){await lockFinanceBook(ctx);await lockAcademyTopology(ctx);await ctx.db.query('SELECT id FROM public.finance_currencies WHERE id=$1 FOR SHARE',[i.definition.currency.id]);await ctx.db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,291))',[ctx.credential.academy_id]);}
 const b=(await ctx.db.query<{data:Basis}>('SELECT public.reporting_currency_source($1::jsonb) data',[JSON.stringify(i)])).rows[0].data;if(!b.currency)throw new ApiError(404,'NOT_FOUND');
 if(checkState&&(b.version!==i.expectedVersion||b.currency.version!==i.definition.currency.version))throw new ApiError(409,'REPORTING_DEFAULTS_CHANGED');if(checkState&&!b.currency.active)throw new ApiError(409,'ACTIVE_CURRENCY_REQUIRED');return b;
}
export const reportingCurrencyActions:ApprovalRegistry={'finance.reporting-defaults.change':{requestCapability:'reporting-defaults.edit',privacyCapability:'reporting-defaults.view',
 async validate(ctx,_id,raw){await basis(ctx,raw,true,false);return {all:true,hubs:[]};},
 async dependencies(ctx,_id,raw,purpose){try{return await basis(ctx,raw) as unknown as Record<string,unknown>;}catch(e){if(purpose==='review'&&e instanceof ApiError&&[403,404,409].includes(e.status))return {unavailable:e.code};throw e;}},
 async apply(ctx,p:Proposal){if(ctx.credential.kind!=='human')throw new ApiError(403,'HUMAN_REVIEW_REQUIRED');const i=input.parse(p.payload),b=await basis(ctx,i,true),next=b.version+1;
  await ctx.db.query('INSERT INTO public.finance_reporting_preferences(academy_id,version,definition,source_basis,currency_id,currency_version,maximum_rate_age_days,approval_id,changed_by,reason) VALUES($1,$2,$3::jsonb,$4::jsonb,$5,$6,$7,$8,$9,$10)',[ctx.credential.academy_id,next,JSON.stringify(i.definition),JSON.stringify(b),i.definition.currency.id,i.definition.currency.version,i.definition.maximumRateAgeDays,p.id,ctx.credential.person_id,i.reason]);
  await record(ctx.db,ctx.credential,ctx.requestId,'finance.reporting-defaults.change',ctx.credential.academy_id,null,{version:next,approvalId:p.id,severity:'critical',hasReason:true,ledgerAdjusted:false});return {version:next,definition:i.definition,ledgerAdjusted:false};
 }
}};
export async function reportingCurrencyDefaults(ctx:ApiContext,registry:ApprovalRegistry=reportingCurrencyActions):Promise<Reply|null>{
 const m=/^finance\/reporting-defaults(?:\/(history))?$/.exec(ctx.path);if(!m)return null;const params=new URL(ctx.request.url).searchParams;if(new Set(params.keys()).size!==[...params.keys()].length)throw new ApiError(400,'DUPLICATE_QUERY');
 if(ctx.request.method==='POST'){if(m[1])throw new ApiError(405,'METHOD_NOT_ALLOWED');z.object({}).strict().parse(Object.fromEntries(params));authorize(ctx,true);const i=input.parse(await jsonBody(ctx.request));return propose(ctx,registry,'finance.reporting-defaults.change',ctx.credential.academy_id,i.expectedVersion,i);}
 if(ctx.request.method!=='GET')throw new ApiError(405,'METHOD_NOT_ALLOWED');authorize(ctx,Boolean(m[1]));
 if(m[1]){const q=history.parse(Object.fromEntries(params)),rows=(await ctx.db.query<{version:number}>('SELECT version,definition,approval_id "approvalId",changed_by "changedBy",reason,created_at "createdAt" FROM public.finance_reporting_preferences WHERE version>$1 ORDER BY version LIMIT $2',[q.afterVersion,q.limit+1])).rows;return {status:200,body:{data:rows.slice(0,q.limit),nextVersion:rows.length>q.limit?rows[q.limit-1].version:null}};}
 z.object({}).strict().parse(Object.fromEntries(params));const row=(await ctx.db.query<{version:number;definition:z.infer<typeof definition>}>('SELECT version,definition FROM public.finance_reporting_preferences ORDER BY version DESC LIMIT 1')).rows[0];return {status:200,body:{data:row??{version:0,definition:null},noConfiguredDefault:!row,affectsPostedMoney:false,branchCurrencySource:'existing_hub_currency_code',targetPrecedence:['explicit_report_currency','single_selected_or_unique_permitted_hub_currency','school_reporting_default'],maximumAgePrecedence:['explicit_report_age','school_reporting_default','zero_days'],scopeGrantedByDefaults:false}};
}
export const reportingCurrencyDefaultsContract=[
 {path:'/api/v1/finance/reporting-defaults',method:'get',summary:'Read configured school reporting currency and default maximum reference-price age,or explicit version0/unconfigured. No guessed CAD default,no ledger conversion or new data authority. A single selected permitted hub,or the unique permitted hub without an explicit hub filter,reuses its existing configured currency code before school fallback.'},
 {path:'/api/v1/finance/reporting-defaults',method:'post',summary:'Request upper-human-reviewed school reporting defaults,master self-approval or bot proposal only. Expected preference/current active currency versions,append-only history,critical redacted audit. Exact-key retries retain receipts under current authority. Does not change currency editions,posted money,hub metadata or provider settings.',schema:input},
 {path:'/api/v1/finance/reporting-defaults/history',method:'get',summary:'Bounded immutable reporting-default editions and original private review notes,under full-school preference view/edit and currency-view rights.',querySchema:history}
] as const;
