import { z } from 'zod';
import { jsonBody,record,type ApiContext,type Reply } from '../core/api.ts';
import { propose,permissionScope,type ApprovalRegistry,type Proposal } from '../core/approvals.ts';
import { ApiError,requireScope,scopeNonempty,type Capability } from '../core/policy.ts';
import { parseMoney,formatMoney,readMinorUnits } from '../core/money.ts';
import { lockAcademyTopology } from './academy.ts';
import { accountingDate } from './finance-periods.ts';
import { lockFinanceBook } from '../core/finance-lock.ts';
import { journalCounterpartyLines,retainedJournalCounterparties,prepareJournalCounterparties,insertJournalCounterparties,counterpartyJournalReviewer } from './journal-counterparties.ts';

const uuid=z.string().uuid().transform(v=>v.toLowerCase()),version=z.number().int().positive().max(2_147_483_647);
const text=z.string().refine(v=>v.isWellFormed()&&!v.includes('\0')),reason=text.trim().min(1).max(2000);
const line=z.object({accountId:uuid,accountVersion:version,side:z.enum(['debit','credit']),amount:text.max(80),note:text.max(500).default('')}).strict();
const common={periodId:uuid,periodVersion:version,postedOn:accountingDate,description:text.trim().min(1).max(2000),reference:text.max(200).default(''),reason};
const create=z.object({...common,purpose:z.enum(['activity','opening','closing']).default('activity').describe('Ordinary activity by default. Opening uses permanent accounts at the period start; closing uses income/expense/equity at its end. Purpose is immutable and inherited by exact reversals.'),lines:z.array(line).min(2).max(200),counterpartyLines:journalCounterpartyLines.optional()}).strict();
const reverse=z.object(common).strict();
const reversal=reverse.extend({reversesId:uuid});
const query=z.object({limit:z.coerce.number().int().min(1).max(100).default(50),after:uuid.optional(),periodId:uuid.optional(),accountId:uuid.optional(),from:accountingDate.optional(),through:accountingDate.optional()}).strict().refine(v=>!v.from||!v.through||v.from<=v.through);
type Line={accountId:string;accountVersion:number;side:'debit'|'credit';amountMinor:string;note:string};
type Account={id:string;hubId:string|null;version:number;active:boolean;kind:string;operationalRole:string;currencyId:string;currencyVersion:number;unitScale:number};
type Period={version:number;state:string;startsOn:string;endsOn:string;closedThrough:string|null};
function checkPostingState(input:z.infer<typeof create>|z.infer<typeof reversal>,accounts:Pick<Account,'id'|'version'|'active'|'kind'>[],p:Period,reversing:boolean){
  if(p.state!=='open')throw new ApiError(409,'OPEN_PERIOD_REQUIRED');if(p.version!==input.periodVersion)throw new ApiError(409,'PERIOD_CHANGED');if(input.postedOn<p.startsOn||input.postedOn>p.endsOn)throw new ApiError(409,'POSTING_DATE_OUTSIDE_PERIOD');if(p.closedThrough&&input.postedOn<=p.closedThrough)throw new ApiError(409,'FINANCIAL_CLOSED_THROUGH');
  if(!reversing&&'lines' in input){
    if((input.purpose==='opening'&&input.postedOn!==p.startsOn)||(input.purpose==='closing'&&input.postedOn!==p.endsOn))throw new ApiError(409,'PURPOSE_DATE_INVALID');
    if(accounts.some(a=>input.purpose==='opening'?['income','expense'].includes(a.kind):input.purpose==='closing'?['asset','liability'].includes(a.kind):false))throw new ApiError(400,'PURPOSE_ACCOUNT_INVALID');
    const byId=new Map(accounts.map(a=>[a.id,a]));for(const l of input.lines){const a=byId.get(l.accountId);if(!a)throw new ApiError(404,'NOT_FOUND');if(!a.active)throw new ApiError(409,'ACTIVE_ACCOUNT_REQUIRED');if(a.version!==l.accountVersion)throw new ApiError(409,'ACCOUNT_CHANGED');}
  }
}
// Keep range predicates outside this correlated point lookup. On fresh native
// statistics, flattening the join selected a whole date-range index scan for
// each line (25 million rejected pairs). OFFSET0 is an intentional planner
// fence; native load/plan checks must be repeated on database major upgrades.
// Both aliases are code-owned, never request-selected identifiers.
// ponytail: indexed per-account history scans; use measured date-keyed lines
// or rollups if larger histories outgrow the interactive query budget.
export const journalPointLookupSQL=`JOIN LATERAL (
 SELECT h.id,h.posted_on,h.purpose,h.reverses_id FROM public.finance_journals h
 WHERE h.academy_id=l.academy_id AND h.id=l.journal_id OFFSET 0
) j ON true`;
const header=`j.id,j.purpose,j.closing_run_id AS "closingRunId",j.period_id AS "periodId",j.period_version AS "periodVersion",j.posted_on::text AS "postedOn",j.description,j.reference,j.line_count AS "lineCount",j.reverses_id AS "reversesId",j.posted_by AS "postedBy",j.approval_id AS "approvalId",j.created_at AS "createdAt",
 (SELECT r.id FROM public.finance_journals r WHERE r.reverses_id=j.id) AS "reversedById"`;
function scope(ctx:ApiContext,cap:Capability){const s=permissionScope(ctx,cap);if(!scopeNonempty(s))throw new ApiError(403,'FORBIDDEN');return s;}
function parameters(ctx:ApiContext){const s=scope(ctx,'journals.view');return [s.all,s.hubs,s.excludedHubs??[],!s.excludedAreas?.length];}
// A mixed-hub journal is visible only as a whole, never as a leaking header or
// misleading partial amount. A school-wide account needs unqualified rights.
const visible=`NOT EXISTS(SELECT 1 FROM public.finance_journal_lines l JOIN public.finance_accounts a ON a.academy_id=l.academy_id AND a.id=l.account_id
 WHERE l.academy_id=j.academy_id AND l.journal_id=j.id AND NOT((a.hub_id IS NULL AND $1::boolean AND cardinality($3::uuid[])=0 AND $4::boolean)
 OR(a.hub_id IS NOT NULL AND ($1::boolean OR a.hub_id=ANY($2::uuid[])) AND NOT a.hub_id=ANY($3::uuid[]))))`;
async function journal(ctx:ApiContext,id:string){
  const found=(await ctx.db.query<{id:string;purpose:string;reversesId:string|null;reversedById:string|null}>('SELECT '+header+' FROM public.finance_journals j WHERE '+visible+' AND j.id=$5',[...parameters(ctx),id])).rows[0];if(!found)throw new ApiError(404,'NOT_FOUND');
  const lines=(await ctx.db.query<Line&{lineNumber:number;unitScale:number;currencyCode:string;currencyId:string;currencyVersion:number;accountCode:string;accountName:string}>(`SELECT l.line_number AS "lineNumber",l.account_id AS "accountId",l.account_version AS "accountVersion",l.side,l.amount_minor::text AS "amountMinor",l.note,
   a.currency_id AS "currencyId",a.currency_version AS "currencyVersion",c.code AS "currencyCode",u.unit_scale AS "unitScale",r.code AS "accountCode",r.name AS "accountName"
   FROM public.finance_journal_lines l JOIN public.finance_accounts a ON a.academy_id=l.academy_id AND a.id=l.account_id
   JOIN public.finance_account_revisions r ON r.academy_id=l.academy_id AND r.account_id=l.account_id AND r.version=l.account_version
   JOIN public.finance_currencies c ON c.academy_id=a.academy_id AND c.id=a.currency_id
   JOIN public.finance_currency_revisions u ON u.academy_id=a.academy_id AND u.currency_id=a.currency_id AND u.version=a.currency_version
   WHERE l.journal_id=$1 ORDER BY l.line_number`,[id])).rows;
  return {...found,lines:lines.map(l=>{const minor=readMinorUnits(l.amountMinor);return {...l,amountMinor:minor.toString(),amount:formatMoney(minor,l.unitScale)};})};
}
async function period(ctx:ApiContext,input:z.infer<typeof reverse>,lock:boolean){
  if(lock)await ctx.db.query('SELECT id FROM public.finance_periods WHERE id=$1 FOR SHARE',[input.periodId]);
  const p=(await ctx.db.query<Period>('SELECT version,state,starts_on::text AS "startsOn",ends_on::text AS "endsOn",(SELECT max(c.ends_on)::text FROM public.finance_periods c WHERE c.active_closing_run_id IS NOT NULL AND c.state=\'closed\') AS "closedThrough" FROM public.finance_periods WHERE id=$1',[input.periodId])).rows[0];
  if(!p)throw new ApiError(404,'NOT_FOUND');return p;
}
async function prepare(ctx:ApiContext,reversing:boolean,raw:unknown,lock:boolean,checkState=true){
  scope(ctx,'journals.edit');scope(ctx,'journals.view');
  const input=reversing?reversal.parse(raw):create.parse(raw);
  const source='reversesId' in input?await journal(ctx,input.reversesId):null;
  if(source?.reversesId)throw new ApiError(409,'REVERSAL_OF_REVERSAL_FORBIDDEN');
  const rawLines=source?source.lines.map(l=>({...l,side:l.side==='debit'?'credit' as const:'debit' as const})):('lines' in input?input.lines:[]);
  const ids=[...new Set(rawLines.map(l=>l.accountId))].sort();
  const read=async()=>(await ctx.db.query<Account>("SELECT id,hub_id AS \"hubId\",version,active,kind,coalesce(to_jsonb(finance_account_catalogue)->>'operational_role','unclassified') AS \"operationalRole\",currency_id AS \"currencyId\",currency_version AS \"currencyVersion\",unit_scale AS \"unitScale\" FROM public.finance_account_catalogue WHERE id=ANY($1::uuid[]) ORDER BY id",[ids])).rows;
  function permitted(accounts:Account[]){
    if(accounts.length!==ids.length)throw new ApiError(404,'NOT_FOUND');
    for(const a of accounts){try{requireScope(scope(ctx,'journals.view'),a.hubId??undefined);requireScope(scope(ctx,'journals.edit'),a.hubId??undefined);requireScope(scope(ctx,'accounts.view'),a.hubId??undefined);}catch(error){if(error instanceof ApiError&&error.status===403)throw new ApiError(404,'NOT_FOUND');throw error;}}
  }
  let accounts=await read();permitted(accounts);
  let selectedPeriod;
  if(lock){await lockFinanceBook(ctx);await lockAcademyTopology(ctx);selectedPeriod=await period(ctx,input,true);await ctx.db.query('SELECT id FROM public.finance_accounts WHERE id=ANY($1::uuid[]) ORDER BY id FOR SHARE',[ids]);accounts=await read();permitted(accounts);}else selectedPeriod=await period(ctx,input,false);
  if(checkState)checkPostingState(input,accounts,selectedPeriod,reversing);
  const byId=new Map(accounts.map(a=>[a.id,a])),totals=new Map<string,bigint>(),lines:Line[]=[];
  for(const l of rawLines){
    const a=byId.get(l.accountId)!;
    const minor=source?readMinorUnits((l as typeof source.lines[number]).amountMinor):parseMoney((l as z.infer<typeof line>).amount,a.unitScale);if(minor<=0n)throw new ApiError(400,'POSITIVE_POSTING_AMOUNT_REQUIRED');
    const key=a.currencyId,normalized=minor*10n**BigInt(18-a.unitScale);totals.set(key,(totals.get(key)??0n)+(l.side==='debit'?normalized:-normalized));lines.push({accountId:l.accountId,accountVersion:l.accountVersion,side:l.side,amountMinor:minor.toString(),note:l.note});
  }
  if([...totals.values()].some(total=>total!==0n))throw new ApiError(400,'JOURNAL_UNBALANCED');
  const tags=source?await retainedJournalCounterparties(ctx,source.id):('counterpartyLines' in input?input.counterpartyLines:undefined),counterparties=await prepareJournalCounterparties(ctx,tags,accounts,lines,source?.purpose??('purpose' in input?input.purpose:'activity'),true,checkState,Boolean(source));
  return {input,source,accounts,lines,counterparties,scope:counterparties?.scope??(accounts.some(a=>a.hubId===null)?{all:true,hubs:[]}:{all:false,hubs:[...new Set(accounts.map(a=>a.hubId!))].sort()})};
}
async function dependencies(ctx:ApiContext,reversing:boolean,raw:unknown,purpose:'request'|'review'){
  const input=reversing?reversal.parse(raw):create.parse(raw),source='reversesId' in input?input.reversesId:null;
  const ids=source?(await ctx.db.query<{id:string}>('SELECT DISTINCT account_id AS id FROM public.finance_journal_lines WHERE journal_id=$1 ORDER BY account_id',[source])).rows.map(r=>r.id):('lines' in input?[...new Set(input.lines.map(l=>l.accountId))].sort():[]);
  // Old pending requests did not state a purpose. Invalidate their dependency
  // hash on review rather than silently assigning them the new activity default.
  const selectedPeriod=await period(ctx,input,false),accounts=(await ctx.db.query<Pick<Account,'id'|'version'|'active'|'kind'>>('SELECT id,version,active,kind,currency_version FROM public.finance_account_catalogue WHERE id=ANY($1::uuid[]) ORDER BY id',[ids])).rows;
  // Only new requests need current posting-state checks. Exact receipts still
  // reauthorize every account before lookup, including after close/retirement.
  if(purpose==='request')checkPostingState(input,accounts,selectedPeriod,reversing);
  const tags=source?await retainedJournalCounterparties(ctx,source):('counterpartyLines' in input?input.counterpartyLines:undefined),counterparties=tags?(await prepare(ctx,reversing,input,false,purpose==='request')).counterparties:undefined;
  return {journalPurposeVersion:2,...counterparties?{counterparties}:{},period:{version:selectedPeriod.version,state:selectedPeriod.state,starts_on:selectedPeriod.startsOn,ends_on:selectedPeriod.endsOn,closedThrough:selectedPeriod.closedThrough},accounts,
    source:source?{id:source,reversedById:(await ctx.db.query<{id:string}>('SELECT id FROM public.finance_journals WHERE reverses_id=$1',[source])).rows[0]?.id??null}:null};
}
async function apply(ctx:ApiContext,p:Proposal,reversing=p.action==='finance.journal.reverse'){
  if(ctx.credential.kind!=='human')throw new ApiError(403,'HUMAN_REVIEW_REQUIRED');
  const prepared=await prepare(ctx,reversing,p.payload,true),{input,source,lines}=prepared;
  try{
    await ctx.db.query(`INSERT INTO public.finance_journals(academy_id,id,period_id,period_version,posted_on,description,reference,line_count,reverses_id,posted_by,approval_id,purpose)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,[ctx.credential.academy_id,p.target_id,input.periodId,input.periodVersion,input.postedOn,input.description,input.reference,lines.length,source?.id??null,ctx.credential.person_id,p.id,source?.purpose??('purpose' in input?input.purpose:'activity')]);
    await ctx.db.query(`INSERT INTO public.finance_journal_lines(academy_id,journal_id,line_number,account_id,account_version,side,amount_minor,note)
      SELECT $1,$2,l.ordinality::smallint,(l.value->>'accountId')::uuid,(l.value->>'accountVersion')::integer,l.value->>'side',(l.value->>'amountMinor')::numeric,l.value->>'note' FROM jsonb_array_elements($3::jsonb) WITH ORDINALITY l(value,ordinality)`,[ctx.credential.academy_id,p.target_id,JSON.stringify(lines)]);
  }catch(error){if(error&&typeof error==='object'&&'code' in error&&error.code==='23505')throw new ApiError(409,'JOURNAL_ALREADY_REVERSED');throw error;}
  if(!source)await insertJournalCounterparties(ctx,p,prepared.counterparties?.tags);
  await record(ctx.db,ctx.credential,ctx.requestId,source?'finance.journal.reversed':'finance.journal.posted',p.target_id,prepared.scope.hubs.length===1?prepared.scope.hubs[0]:null,{approvalId:p.id,periodId:input.periodId,purpose:source?.purpose??('purpose' in input?input.purpose:'activity'),lineCount:lines.length,reversesId:source?.id??null,severity:'critical',hasReason:true});return journal(ctx,p.target_id);
}
async function standaloneReversal(ctx:ApiContext,input:unknown,lock:boolean){
 const prepared=await prepare(ctx,true,input,lock,false);
 if(prepared.source&&(await ctx.db.query('SELECT 1 FROM public.payrun_payments WHERE id=$1 LIMIT 1',[prepared.source.id])).rows.length)throw new ApiError(409,'PAYRUN_PAYMENT_CORRECTION_WORKFLOW_REQUIRED');
 if(prepared.source&&(await ctx.db.query('SELECT 1 FROM public.payrun_remittances WHERE id=$1 LIMIT 1',[prepared.source.id])).rows.length)throw new ApiError(409,'PAYRUN_REMITTANCE_CORRECTION_WORKFLOW_REQUIRED');
 if(prepared.source&&(await ctx.db.query('SELECT 1 FROM public.payrun_net_postings WHERE id=$1 LIMIT 1',[prepared.source.id])).rows.length)throw new ApiError(409,'PAYRUN_NET_POSTING_CORRECTION_WORKFLOW_REQUIRED');
 if(prepared.source&&(await ctx.db.query('SELECT 1 FROM public.tuition_invoices WHERE journal_id=$1 LIMIT 1',[prepared.source.id])).rows.length)throw new ApiError(409,'INVOICE_CREDIT_WORKFLOW_REQUIRED');
 if(prepared.source&&(await ctx.db.query('SELECT 1 FROM public.tuition_receipts WHERE id=$1 LIMIT 1',[prepared.source.id])).rows.length)throw new ApiError(409,'RECEIPT_CORRECTION_WORKFLOW_REQUIRED');
 if(prepared.source&&(await ctx.db.query('SELECT 1 FROM public.collector_remittances WHERE id=$1 LIMIT 1',[prepared.source.id])).rows.length)throw new ApiError(409,'REMITTANCE_CORRECTION_WORKFLOW_REQUIRED');
  if(prepared.source&&(await ctx.db.query('SELECT 1 FROM public.finance_transfers WHERE id=$1 LIMIT 1',[prepared.source.id])).rows.length)throw new ApiError(409,'TRANSFER_CORRECTION_WORKFLOW_REQUIRED');
  if(prepared.source&&(await ctx.db.query('SELECT 1 FROM public.expense_bills WHERE id=$1 LIMIT 1',[prepared.source.id])).rows.length)throw new ApiError(409,'EXPENSE_VOID_WORKFLOW_REQUIRED');
  if(prepared.source&&(await ctx.db.query('SELECT 1 FROM public.expense_payments WHERE id=$1 LIMIT 1',[prepared.source.id])).rows.length)throw new ApiError(409,'EXPENSE_PAYMENT_CORRECTION_WORKFLOW_REQUIRED');
  if(prepared.source&&(await ctx.db.query('SELECT 1 FROM public.payroll_adjustments WHERE id=$1 LIMIT 1',[prepared.source.id])).rows.length)throw new ApiError(409,'PAYROLL_ADJUSTMENT_CORRECTION_WORKFLOW_REQUIRED');
  if(prepared.source&&(await ctx.db.query('SELECT 1 FROM public.payroll_hourly_accruals WHERE id=$1 LIMIT 1',[prepared.source.id])).rows.length)throw new ApiError(409,'HOURLY_CORRECTION_WORKFLOW_REQUIRED');
  if(prepared.source&&(await ctx.db.query('SELECT 1 FROM public.payroll_salary_accruals WHERE id=$1 LIMIT 1',[prepared.source.id])).rows.length)throw new ApiError(409,'SALARY_CORRECTION_WORKFLOW_REQUIRED');
  if(prepared.source&&(await ctx.db.query('SELECT 1 FROM public.payroll_project_accruals WHERE id=$1 LIMIT 1',[prepared.source.id])).rows.length)throw new ApiError(409,'PROJECT_CORRECTION_WORKFLOW_REQUIRED');
  if(prepared.source&&(await ctx.db.query('SELECT 1 FROM public.payroll_tuition_course_accruals WHERE id=$1 LIMIT 1',[prepared.source.id])).rows.length)throw new ApiError(409,'TUITION_COURSE_CORRECTION_WORKFLOW_REQUIRED');
  if(prepared.source&&(await ctx.db.query('SELECT 1 FROM public.payroll_tuition_session_accruals WHERE id=$1 LIMIT 1',[prepared.source.id])).rows.length)throw new ApiError(409,'TUITION_SESSION_CORRECTION_WORKFLOW_REQUIRED');
  if(prepared.source&&(await ctx.db.query('SELECT 1 FROM public.payroll_tuition_collection_accruals WHERE id=$1 LIMIT 1',[prepared.source.id])).rows.length)throw new ApiError(409,'TUITION_COLLECTION_CORRECTION_WORKFLOW_REQUIRED');
 return prepared;
}
export const journalActions:ApprovalRegistry={
  'finance.journal.post':{requestCapability:'journals.edit',privacyCapability:'journals.edit',createdStatus:201,validate:async(ctx,id,input)=>(await prepare(ctx,false,input,true,false)).scope,dependencies:(ctx,id,input,purpose)=>dependencies(ctx,false,input,purpose),authorizeReviewer:counterpartyJournalReviewer,apply},
  'finance.journal.reverse':{requestCapability:'journals.edit',privacyCapability:'journals.edit',createdStatus:201,validate:async(ctx,id,input)=>(await standaloneReversal(ctx,input,true)).scope,dependencies:(ctx,id,input,purpose)=>dependencies(ctx,true,input,purpose),authorizeReviewer:counterpartyJournalReviewer,apply}
};
export async function financeJournals(ctx:ApiContext,registry:ApprovalRegistry=journalActions):Promise<Reply|null>{
  const match=/^finance\/journals(?:\/([^/]+)(?:\/(reverse|counterparties))?)?$/.exec(ctx.path);if(!match)return null;
  const search=new URL(ctx.request.url).searchParams;if([...search].length!==new Set(search.keys()).size)throw new ApiError(400,'DUPLICATE_QUERY');
  const id=match[1]?uuid.parse(match[1]):null,section=match[2];
  if(ctx.request.method==='POST'){
    z.object({}).strict().parse(Object.fromEntries(new URL(ctx.request.url).searchParams));scope(ctx,'journals.edit');
    if(!id){const input=create.parse(await jsonBody(ctx.request,262144));await prepare(ctx,false,input,false,false);return propose(ctx,registry,'finance.journal.post',null,0,input);}
    if(section!=='reverse')throw new ApiError(405,'METHOD_NOT_ALLOWED');const input={...reverse.parse(await jsonBody(ctx.request)),reversesId:id};await standaloneReversal(ctx,input,false);return propose(ctx,registry,'finance.journal.reverse',null,0,input);
  }
  if(ctx.request.method==='GET'&&id&&section==='counterparties'){
    z.object({}).strict().parse(Object.fromEntries(search));const j=await journal(ctx,id),accounts=(await ctx.db.query<Account>('SELECT id,hub_id AS "hubId",kind,operational_role AS "operationalRole" FROM public.finance_account_catalogue WHERE id=ANY($1::uuid[])',[j.lines.map(l=>l.accountId)])).rows;
    for(const a of accounts)for(const cap of ['accounts.view','ledger.view','counterparty-balances.view'] as Capability[])requireScope(scope(ctx,cap),a.hubId??undefined);
    const tags=await retainedJournalCounterparties(ctx,id);await prepareJournalCounterparties(ctx,tags,accounts,j.lines,j.purpose,false,false,true);return {status:200,body:{data:{journalId:id,inheritedFromJournalId:j.reversesId,counterpartyLines:tags??[],classification:tags?'explicit_retained_links':'unattributed',amountsSource:'original_pinned_journal_lines',taxCalculated:false,moneyMovementPerformed:false}}};
  }
  if(ctx.request.method!=='GET'||section)throw new ApiError(405,'METHOD_NOT_ALLOWED');
  if(id){z.object({}).strict().parse(Object.fromEntries(new URL(ctx.request.url).searchParams));return {status:200,body:{data:await journal(ctx,id)}};}
  const q=query.parse(Object.fromEntries(new URL(ctx.request.url).searchParams)),rows=(await ctx.db.query<{id:string}>('SELECT '+header+' FROM public.finance_journals j WHERE '+visible+' AND ($5::uuid IS NULL OR j.id>$5) AND ($6::uuid IS NULL OR j.period_id=$6) AND ($7::date IS NULL OR j.posted_on>=$7) AND ($8::date IS NULL OR j.posted_on<=$8) AND ($9::uuid IS NULL OR EXISTS(SELECT 1 FROM public.finance_journal_lines l WHERE l.journal_id=j.id AND l.account_id=$9)) ORDER BY j.id LIMIT $10',[...parameters(ctx),q.after??null,q.periodId??null,q.from??null,q.through??null,q.accountId??null,q.limit+1])).rows;
  return {status:200,body:{data:rows.slice(0,q.limit),nextCursor:rows.length>q.limit?rows[q.limit-1].id:null}};
}
export const journalsContract=[
  {path:'/api/v1/finance/journals',method:'get',summary:'Entirely scope-authorized immutable posted journal headers, filtered before pagination',querySchema:query},
  {path:'/api/v1/finance/journals',method:'post',summary:'Request upper-human-reviewed exact double-entry posting balanced by pinned currency unit. Optional explicit counterpartyLines link only non-control asset/liability lines to current named external payees for loans,repayments,opening balances or reviewed adjustments;separate counterparty-balance rights and original payee boundaries apply. No name guessing,additional posting,automatic interest/tax or external money movement.',schema:create},
  {path:'/api/v1/finance/journals/{id}',method:'get',summary:'Read exact amounts and immutable account/currency snapshots of a wholly permitted journal'},
  {path:'/api/v1/finance/journals/{id}/counterparties',method:'get',summary:'Read explicit retained external hub/person/organization balance-sheet line links under whole journal/account/ledger,counterparty-balance and payee scope. Corrections inherit original links,never guess parties from account labels. No additional journal,tax calculation or external payment.'},
  {path:'/api/v1/finance/journals/{id}/reverse',method:'post',summary:'Request one exact inverse in an open period; original posting is retained and inactive original accounts may be cleared',schema:reverse}
] as const;
export { prepare as prepareJournal,dependencies as journalDependencies,apply as applyJournal };
