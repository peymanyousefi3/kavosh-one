import { z } from 'zod';
import { jsonBody,record,type ApiContext,type Reply } from '../core/api.ts';
import { propose,permissionScope,type ApprovalRegistry,type Proposal } from '../core/approvals.ts';
import { ApiError,requireScope,scopeNonempty,type Capability } from '../core/policy.ts';
import { parseMoney,readMinorUnits,formatMoneyTotal } from '../core/money.ts';
import { lockFinanceBook } from '../core/finance-lock.ts';
import { lockAcademyTopology } from './academy.ts';
import { accountRow } from './finance.ts';
import { accountingDate } from './finance-periods.ts';
import { accountTotalsSQL,accountBalances } from './finance-ledger.ts';

const uuid=z.string().uuid().transform(v=>v.toLowerCase()),text=z.string().refine(v=>v.isWellFormed()&&!v.includes('\0'));
const input=z.object({accountId:uuid,accountVersion:z.number().int().positive().max(2147483647),asOf:accountingDate,state:z.enum(['recorded','void']).default('recorded'),balance:text.regex(/^-?(0|[1-9][0-9]*)(\.[0-9]+)?$/).max(80).nullable(),supersedesId:uuid.nullable().default(null),reference:text.trim().max(200).default(''),reason:text.trim().min(1).max(2000)}).strict()
 .refine(v=>v.state==='recorded'?v.balance!==null:v.balance===null&&v.supersedesId!==null);
const query=z.object({limit:z.coerce.number().int().min(1).max(100).default(50),after:uuid.optional(),from:accountingDate.optional(),through:accountingDate.optional(),includeHistory:z.enum(['true','false']).transform(v=>v==='true').default(false)}).strict().refine(v=>!v.from||!v.through||v.from<=v.through);
type Observation={id:string;account_id:string;account_version:number;currency_id:string;unit_scale:number;normal_balance:'debit'|'credit';as_of:string;state:'recorded'|'void';balance_minor:string|null;supersedes_id:string|null;reference:string;approval_id:string;created_at:Date|string};
const columns='o.id,o.account_id,o.account_version,o.currency_id,o.unit_scale,o.normal_balance,o.as_of::text,o.state,o.balance_minor::text,o.supersedes_id,o.reference,o.approval_id,o.created_at';
function allowed(ctx:ApiContext,cap:Capability){const s=permissionScope(ctx,cap);if(!scopeNonempty(s))throw new ApiError(403,'FORBIDDEN');return s;}
async function account(ctx:ApiContext,id:string,edit=false){
 const a=await accountRow(ctx,id);requireScope(allowed(ctx,'bank-balances.view'),a.hubId??undefined);if(edit)requireScope(allowed(ctx,'bank-balances.edit'),a.hubId??undefined);return a;
}
async function observation(ctx:ApiContext,id:string){
 allowed(ctx,'bank-balances.view');const row=(await ctx.db.query<Observation>('SELECT '+columns+' FROM public.finance_balance_observations o WHERE o.id=$1',[id])).rows[0];
 if(!row)throw new ApiError(404,'NOT_FOUND');try{const a=await account(ctx,row.account_id);return {row,a};}catch(error){if(error instanceof ApiError&&error.status===403)throw new ApiError(404,'NOT_FOUND');throw error;}
}
function view(o:Observation,supersededBy:string|null=null){return {id:o.id,accountId:o.account_id,accountVersion:o.account_version,currencyId:o.currency_id,unitScale:o.unit_scale,normalBalance:o.normal_balance,asOf:o.as_of,state:o.state,balance:o.balance_minor===null?null:{minor:o.balance_minor,amount:formatMoneyTotal(readMinorUnits(o.balance_minor),o.unit_scale)},reference:o.reference,supersedesId:o.supersedes_id,supersededBy,approvalId:o.approval_id,createdAt:o.created_at,source:'manual_total',balanceConvention:'pinned_account_normal_balance',externallyVerified:false,ledgerAdjusted:false,moneyMovementPerformed:false};}
async function basis(ctx:ApiContext,raw:unknown,lock=false,checkState=true){
 const v=input.parse(raw);let a=await account(ctx,v.accountId,true);
 if(lock){await lockFinanceBook(ctx);await lockAcademyTopology(ctx);await ctx.db.query('SELECT id FROM public.finance_accounts WHERE id=$1 FOR UPDATE',[a.id]);a=await account(ctx,a.id,true);}
 if(checkState&&a.version!==v.accountVersion)throw new ApiError(409,'ACCOUNT_CHANGED');
 if(checkState&&v.state==='recorded'&&(!a.active||!['cash','bank','credit_card'].includes(a.operationalRole)))throw new ApiError(409,'ACTIVE_TREASURY_ACCOUNT_REQUIRED');
 if(!(await ctx.db.query<{valid:boolean}>("SELECT $1::date<=(clock_timestamp() AT TIME ZONE 'UTC'+interval '14 hours')::date AS valid",[v.asOf])).rows[0].valid)throw new ApiError(400,'FUTURE_BALANCE_OBSERVATION_FORBIDDEN');
 const prior=v.supersedesId?(await ctx.db.query<Observation>('SELECT '+columns+' FROM public.finance_balance_observations o WHERE o.id=$1',[v.supersedesId])).rows[0]:null;
 if(v.supersedesId&&(!prior||prior.account_id!==a.id||prior.as_of!==v.asOf))throw new ApiError(409,'BALANCE_OBSERVATION_PRIOR_INVALID');
 if(v.state==='void'&&prior?.state==='void')throw new ApiError(409,'BALANCE_OBSERVATION_ALREADY_VOID');
 const existing=checkState?(await ctx.db.query<{id:string}>(`SELECT id FROM public.finance_balance_observations WHERE account_id=$1 AND as_of=$2::date AND ${v.supersedesId?'supersedes_id=$3':'supersedes_id IS NULL'}`,[a.id,v.asOf,...v.supersedesId?[v.supersedesId]:[]])).rows[0]:null;
 if(checkState&&existing)throw new ApiError(409,'BALANCE_OBSERVATION_PRIOR_CHANGED');
 const minor=v.balance===null?null:parseMoney(v.balance,a.unitScale).toString();
 return {a,minor,prior,accounts:[{id:a.id,version:a.version,hubId:a.hubId,currencyId:a.currencyId,unitScale:a.unitScale,normalBalance:a.normalBalance,operationalRole:a.operationalRole,active:a.active}]};
}
async function dependencies(ctx:ApiContext,raw:unknown,purpose:'request'|'review'){
 try{const {accounts,prior}=await basis(ctx,raw);return JSON.parse(JSON.stringify({accounts,prior}));}catch(error){if(purpose==='review'&&error instanceof ApiError&&[400,403,404,409].includes(error.status))return {unavailable:error.code};throw error;}
}
export const balanceObservationActions:ApprovalRegistry={'finance.balance-observation.record':{
 requestCapability:'bank-balances.edit',privacyCapability:'bank-balances.edit',createdStatus:201,
 async validate(ctx,_id,raw){const {a}=await basis(ctx,raw,true,false);return a.hubId?{all:false,hubs:[a.hubId]}:{all:true,hubs:[]};},
 dependencies:(ctx,_id,raw,purpose)=>dependencies(ctx,raw,purpose),
 async apply(ctx,p:Proposal){
  if(ctx.credential.kind!=='human')throw new ApiError(403,'HUMAN_REVIEW_REQUIRED');const v=input.parse(p.payload),b=await basis(ctx,v,true);
  let row:Observation;try{row=(await ctx.db.query<Observation>(`INSERT INTO public.finance_balance_observations(academy_id,id,account_id,account_version,currency_id,unit_scale,normal_balance,as_of,state,balance_minor,supersedes_id,reference,reason,approval_id,created_by)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id,account_id,account_version,currency_id,unit_scale,normal_balance,as_of::text,state,balance_minor::text,supersedes_id,reference,approval_id,created_at`,[ctx.credential.academy_id,p.target_id,b.a.id,b.a.version,b.a.currencyId,b.a.unitScale,b.a.normalBalance,v.asOf,v.state,b.minor,v.supersedesId,v.reference,v.reason,p.id,ctx.credential.person_id])).rows[0];}
  catch(error){if(error&&typeof error==='object'&&'code'in error&&error.code==='23505')throw new ApiError(409,'BALANCE_OBSERVATION_PRIOR_CHANGED');throw error;}
  await record(ctx.db,ctx.credential,ctx.requestId,'finance.balance-observation.recorded',row.id,b.a.hubId,{approvalId:p.id,state:row.state,hasReason:true,severity:'critical',ledgerAdjusted:false});return view(row);
 }
}};
export async function balanceObservations(ctx:ApiContext,registry:ApprovalRegistry=balanceObservationActions):Promise<Reply|null>{
 const list=/^finance\/accounts\/([^/]+)\/balance-observations$/.exec(ctx.path),item=/^finance\/balance-observations\/([^/]+)(?:\/(comparison))?$/.exec(ctx.path);
 if(!list&&!item&&ctx.path!=='finance/balance-observations')return null;
 if(ctx.path==='finance/balance-observations'){
  if(ctx.request.method!=='POST')throw new ApiError(405,'METHOD_NOT_ALLOWED');z.object({}).strict().parse(Object.fromEntries(new URL(ctx.request.url).searchParams));const v=input.parse(await jsonBody(ctx.request));await account(ctx,v.accountId,true);return propose(ctx,registry,'finance.balance-observation.record',null,0,v);
 }
 if(ctx.request.method!=='GET')throw new ApiError(405,'METHOD_NOT_ALLOWED');
 if(list){const id=uuid.parse(list[1]);await account(ctx,id);const q=query.parse(Object.fromEntries(new URL(ctx.request.url).searchParams));const rows=(await ctx.db.query<Observation&{superseded_by:string|null}>(`SELECT ${columns},child.id AS superseded_by FROM public.finance_balance_observations o LEFT JOIN public.finance_balance_observations child ON child.academy_id=o.academy_id AND child.supersedes_id=o.id
   WHERE o.account_id=$1 AND($2::uuid IS NULL OR o.id>$2) AND($3::date IS NULL OR o.as_of>=$3) AND($4::date IS NULL OR o.as_of<=$4) AND($5::boolean OR child.id IS NULL) ORDER BY o.id LIMIT $6`,[id,q.after??null,q.from??null,q.through??null,q.includeHistory,q.limit+1])).rows;return {status:200,body:{accountId:id,data:rows.slice(0,q.limit).map(o=>view(o,o.superseded_by)),nextCursor:rows.length>q.limit?rows[q.limit-1].id:null}};}
 z.object({}).strict().parse(Object.fromEntries(new URL(ctx.request.url).searchParams));const id=uuid.parse(item![1]),{row:o,a}=await observation(ctx,id);
 if(!item![2]){const child=(await ctx.db.query<{id:string}>('SELECT id FROM public.finance_balance_observations WHERE supersedes_id=$1',[id])).rows[0];return {status:200,body:{data:view(o,child?.id??null)}};}
 requireScope(allowed(ctx,'ledger.view'),a.hubId??undefined);
 type Totals=Parameters<typeof accountBalances>[0];
 const result=(await ctx.db.query<Totals&{snapshot_at:string;superseded_by:string|null}>(`WITH totals AS(${accountTotalsSQL}) SELECT totals.*,statement_timestamp()::text AS snapshot_at,(SELECT id FROM public.finance_balance_observations WHERE supersedes_id=$4) AS superseded_by FROM totals`,[a.id,null,o.as_of,o.id])).rows[0];
 const book=accountBalances(result,o.unit_scale),normal=BigInt(book.closing.minor)*(o.normal_balance==='credit'?-1n:1n),observed=o.balance_minor===null?null:readMinorUnits(o.balance_minor),difference=observed===null?null:observed-normal;
 const exact=(n:bigint)=>({minor:n.toString(),amount:formatMoneyTotal(n,o.unit_scale)});
 return {status:200,body:{data:{observation:view(o,result.superseded_by),snapshotAt:result.snapshot_at,ledger:{basis:book.basis,through:o.as_of,normalBalance:o.normal_balance,balance:exact(normal),lineCount:book.lineCount,journalCount:book.journalCount},difference:difference===null?null:exact(difference),amountsEqual:difference===null?null:difference===0n,observationCurrent:result.superseded_by===null&&o.state==='recorded',reconciled:false,transactionMatchingPerformed:false,externallyVerified:false,ledgerAdjusted:false,moneyMovementPerformed:false}}};
}
export const balanceObservationsContract=[
 {path:'/api/v1/finance/balance-observations',method:'post',summary:'Request a reviewed manual cash/bank/card closing balance, immutable correction or void; never adjust the ledger or connect to a bank',schema:input},
 {path:'/api/v1/finance/accounts/{id}/balance-observations',method:'get',summary:'Permitted current observation heads by default, or retained correction/void history; UUID pagination',querySchema:query},
 {path:'/api/v1/finance/balance-observations/{id}',method:'get',summary:'Read a permitted reviewed manual balance and retained supersession links; no private reason'},
 {path:'/api/v1/finance/balance-observations/{id}/comparison',method:'get',summary:'Additional ledger permission required: same-snapshot posted balance and current supersession compared with a manual observation, never bank verification or transaction reconciliation'}
] as const;
