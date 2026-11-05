import { Temporal } from '@js-temporal/polyfill';
import { z } from 'zod';
import type { ApiContext,Reply } from '../core/api.ts';
import { permissionScope,lockApprovalWrites } from '../core/approvals.ts';
import { ApiError,scopeNonempty,type Capability } from '../core/policy.ts';
import { exactReportMoney as exact } from '../core/aging.ts';
import { readMinorUnits } from '../core/money.ts';
import { accountingDate } from './finance-periods.ts';
import { financialAccountSelectionSQL,financialReportAccess } from './financial-reports.ts';
import { journalPointLookupSQL } from './finance-journals.ts';
import { receivableSourcesSQL,assertReceivableAgingBounds } from './receivables-aging.ts';
import { payableSourcesSQL,assertPayableAgingBounds } from './payables-aging.ts';
import { payrollForecastSource,scheduledPayrollForecast,type PayrollForecastSources } from './payroll-forecast.ts';

const uuid=z.string().uuid().transform(v=>v.toLowerCase());
const query=z.object({on:accountingDate,through:accountingDate,timeZone:z.string().min(1).max(100).refine(v=>{if(/^[+-]/.test(v))return false;try{Temporal.Now.instant().toZonedDateTimeISO(v);return true;}catch{return false;}}),hubId:uuid.optional(),currencyId:uuid.optional()}).strict().refine(q=>{try{return q.through>q.on&&Temporal.PlainDate.from(q.on).until(q.through).days<=366;}catch{return false;}},'Choose a future horizon of at most 366 days.');
const arCaps:Capability[]=['financial-outlook.view','financial-reports.view','receivables-reports.view','invoices.view','receipts.view','allocations.view'];
const apCaps:Capability[]=['financial-outlook.view','financial-reports.view','payables-reports.view','expenses.view','expense-payments.view'];
type MoneyRow={currencyId:string;currencyCode:string;scale:number};
type AR=MoneyRow&{id:string;balance:string;allocationReview:boolean;dues:{on:string;minor:string}[]};
type AP=MoneyRow&{id:string;balance:string;dueOn:string};
type Plan=MoneyRow&{id:string;on:string;version:number;gross:string;covered:string;review:boolean};
type Cash=MoneyRow&{id:string;minor:string};
export function assertOutlookBounds(plans:number,occurrences:number,links:number,cash:number){if(plans>1000||occurrences>10000||links>100000||cash>10000)throw new ApiError(422,'FINANCIAL_OUTLOOK_REQUIRES_BACKGROUND_JOB');}
export function assertOutlookOutputBounds(currencies:number,issues:number,points:number){if(currencies>1000||issues>2000||points>10000)throw new ApiError(422,'FINANCIAL_OUTLOOK_REQUIRES_BACKGROUND_JOB');}

// Only server-owned SQL fragments are composed. Dense parameter rebinding also
// removes unused aging/paging parameters; no input becomes SQL syntax.
function composer(){const params:unknown[]=[];return {params,bind(sql:string,values:unknown[]){const mapped=new Map<number,number>();return sql.replace(/\$(\d+)/g,(_,n:string)=>{const old=Number(n);if(old<1||old>values.length)throw new Error('OUTLOOK_PARAMETER_MISSING');if(!mapped.has(old)){params.push(values[old-1]);mapped.set(old,params.length);}return '$'+mapped.get(old);});}};}
const plannedSQL=`WITH plans AS MATERIALIZED(
 SELECT h.id FROM public.expense_commitments h JOIN public.expense_commitment_revisions r ON r.commitment_id=h.id AND r.version=h.version
 WHERE public.scope_contains($3::jsonb,public.expense_commitment_scope(r.definition->'lines')) AND public.scope_contains($4::jsonb,public.expense_commitment_scope(r.definition->'lines')) AND public.scope_contains($9::jsonb,public.expense_commitment_scope(r.definition->'lines'))
 AND($7::uuid IS NULL OR EXISTS(SELECT 1 FROM jsonb_array_elements(r.definition->'lines') l WHERE l->>'hubId'=$7::text))
 LIMIT 1001
),limited AS MATERIALIZED(SELECT * FROM plans WHERE(SELECT count(*) FROM plans)<=1000),
 links AS MATERIALIZED(SELECT i.* FROM public.expense_commitment_link_intervals i JOIN limited p ON p.id=i.commitment_id WHERE i.occurrence_on>$1::date AND i.occurrence_on<=$2::date LIMIT 100001),
 days AS(SELECT $1::date+n AS due_day FROM generate_series(1,$2::date-$1::date) n),
 occurrences AS MATERIALIZED(
 SELECT p.id,d.due_day,r.* FROM limited p CROSS JOIN days d CROSS JOIN LATERAL(SELECT r.version,r.currency_id,r.unit_scale,r.source_snapshot,r.definition,r.gross_minor FROM public.expense_commitment_revisions r WHERE r.commitment_id=p.id AND r.effective_on<=d.due_day ORDER BY r.effective_on DESC,r.version DESC LIMIT 1) r
 WHERE public.scope_contains($3::jsonb,public.expense_commitment_scope(r.definition->'lines')) AND public.scope_contains($4::jsonb,public.expense_commitment_scope(r.definition->'lines')) AND public.scope_contains($9::jsonb,public.expense_commitment_scope(r.definition->'lines'))
 AND($8::uuid IS NULL OR r.currency_id=$8)
 AND(((r.definition->>'active')::boolean AND d.due_day>=(r.definition->>'startsOn')::date AND(r.definition->'endsOn'='null'::jsonb OR d.due_day<=(r.definition->>'endsOn')::date) AND public.expense_schedule_occurs(r.definition->'schedule',d.due_day)) OR EXISTS(SELECT 1 FROM links l WHERE l.commitment_id=p.id AND l.occurrence_on=d.due_day AND l.effective_on<=$1::date AND(l.ends_on IS NULL OR l.ends_on>$1::date)))
 LIMIT 10001
),rows AS(
 SELECT o.id,o.due_day::text AS "on",o.version,o.currency_id AS "currencyId",o.source_snapshot#>>'{currency,code}' AS "currencyCode",o.unit_scale scale,o.gross_minor::text gross,
 coalesce((SELECT sum(l.expected_minor) FROM links l WHERE l.commitment_id=o.id AND l.occurrence_on=o.due_day AND l.effective_on<=$1::date AND(l.ends_on IS NULL OR l.ends_on>$1::date) AND l.terms_version=o.version),0)::text covered,
 NOT(o.definition->>'active')::boolean OR NOT public.expense_schedule_occurs(o.definition->'schedule',o.due_day) OR EXISTS(
 SELECT 1 FROM links l CROSS JOIN LATERAL(SELECT public.commitment_bill_source_scopes(l.commitment_id,l.terms_version,l.bill_id) scopes) s
 WHERE l.commitment_id=o.id AND l.occurrence_on=o.due_day AND((public.scope_contains($5::jsonb,s.scopes->'combined') AND public.scope_contains($9::jsonb,s.scopes->'combined') AND public.scope_contains($4::jsonb,s.scopes->'commitment') AND public.scope_contains($6::jsonb,s.scopes->'bill')) IS NOT TRUE OR(l.effective_on<=$1::date AND(l.ends_on IS NULL OR l.ends_on>$1::date) AND l.terms_version<>o.version))) review
 FROM occurrences o
)
SELECT(SELECT count(*)::integer FROM plans) plans,(SELECT count(*)::integer FROM occurrences) occurrences,(SELECT count(*)::integer FROM links) links,coalesce((SELECT jsonb_agg(to_jsonb(rows) ORDER BY "on",id) FROM rows),'[]'::jsonb) entries`;

export async function financialOutlook(ctx:ApiContext):Promise<Reply|null>{
 if(ctx.path!=='reports/finance/outlook')return null;if(ctx.request.method!=='GET')throw new ApiError(405,'METHOD_NOT_ALLOWED');
 const p=new URL(ctx.request.url).searchParams;if(new Set(p.keys()).size!==[...p.keys()].length)throw new ApiError(400,'DUPLICATE_QUERY');const q=query.parse(Object.fromEntries(p));await lockApprovalWrites(ctx);
 const scope=(cap:Capability)=>{const s=permissionScope(ctx,cap);if(!scopeNonempty(s))throw new ApiError(403,'FORBIDDEN');return s;},arScopes=arCaps.map(scope),apScopes=apCaps.map(scope),outlook=scope('financial-outlook.view'),reports=scope('financial-reports.view'),plans=scope('expense-commitments.view'),links=scope('expense-commitment-links.view');
 const hubs=q.hubId?[q.hubId]:null,currencies=q.currencyId?[q.currencyId]:null,source=composer(),cashAccess=financialReportAccess(ctx,['financial-outlook.view','financial-reports.view','ledger.view','accounts.view']);
 const ar=source.bind(`${receivableSourcesSQL} SELECT to_jsonb(bounds) bounds,coalesce((SELECT jsonb_agg(jsonb_build_object('id',i.id,'currencyId',i.currency_id,'currencyCode',i.currency_code,'scale',i.unit_scale,'balance',i.balance::text,'allocationReview',i.allocation_review,'dues',coalesce((SELECT jsonb_agg(jsonb_build_object('on',s.due_on::text,'minor',(s.amount_minor-s.allocated)::text) ORDER BY s.due_on,s.ordinal) FROM schedule s WHERE s.invoice_id=i.id AND s.amount_minor>s.allocated),'[]'::jsonb))) FROM amounts i WHERE i.balance<>0),'[]'::jsonb) entries FROM bounds`,[q.on,JSON.stringify(arScopes),hubs,null,null,null,currencies,null,null,null,false,[30,60,90],null,10001,ctx.credential.all_hubs,ctx.credential.hub_ids,true,[],[],[],null]);
 const ap=source.bind(`${payableSourcesSQL} SELECT(SELECT bills FROM bill_bound) bills,(SELECT payment_events FROM event_bound) events,coalesce((SELECT jsonb_agg(jsonb_build_object('id',id,'currencyId',currency_id,'currencyCode',currency_code,'scale',unit_scale,'balance',balance::text,'dueOn',due_on::text)) FROM balances WHERE balance<>0),'[]'::jsonb) entries`,[q.on,JSON.stringify(apScopes),hubs,null,null,null,null,currencies,null,null,null,false,[30,60,90],null,10001,ctx.credential.all_hubs,ctx.credential.hub_ids,JSON.stringify(scope('expense-payments.view'))]);
 const planned=source.bind(plannedSQL,[q.on,q.through,JSON.stringify(outlook),JSON.stringify(plans),JSON.stringify(links),JSON.stringify(scope('expenses.view')),q.hubId??null,q.currencyId??null,JSON.stringify(reports)]);
 const cash=source.bind(`WITH selected AS MATERIALIZED(${financialAccountSelectionSQL}),cash AS MATERIALIZED(SELECT s.* FROM selected s JOIN public.finance_account_catalogue a ON a.id=s.id WHERE a.operational_role IN('cash','bank') LIMIT 10001),rows AS(SELECT s.id,s.currency_id AS "currencyId",s.currency_code AS "currencyCode",s.unit_scale scale,coalesce((SELECT sum(CASE WHEN l.side='debit' THEN l.amount_minor ELSE -l.amount_minor END) FROM public.finance_journal_lines l ${journalPointLookupSQL} WHERE l.account_id=s.id AND j.posted_on<=$5::date),0)::text minor FROM cash s WHERE(SELECT count(*) FROM cash)<=10000) SELECT(SELECT count(*)::integer FROM cash) accounts,coalesce((SELECT jsonb_agg(to_jsonb(rows)) FROM rows),'[]'::jsonb) entries`,[cashAccess.all,cashAccess.hubs,cashAccess.excluded,cashAccess.global,q.on,hubs,currencies,null]);
 const payrollQuery={from:Temporal.PlainDate.from(q.on).add({days:1}).toString(),through:q.through,timeZone:q.timeZone,...q.hubId?{hubId:q.hubId}:{},...q.currencyId?{currencyId:q.currencyId}:{}},payroll=payrollForecastSource(ctx,payrollQuery,[outlook]);
 // Every source is evaluated by this single statement, not by fetching API
 // pages or combining independently changing read-committed snapshots.
 // Multi-column source results become JSON at their subquery boundary.
 const statement=`SELECT statement_timestamp()::text AS "snapshotAt",(SELECT to_jsonb(s) FROM(${ar}) s) ar,(SELECT to_jsonb(s) FROM(${ap}) s) ap,(SELECT to_jsonb(s) FROM(${planned}) s) planned,(SELECT to_jsonb(s) FROM(${cash}) s) cash,(SELECT to_jsonb(s) FROM(${source.bind(payroll.sql,payroll.params)}) s) payroll`;
 const r=(await ctx.db.query<{snapshotAt:string;ar:{bounds:{invoices:number;installments:number;receipts:number;allocations:number};entries:AR[]};ap:{bills:number;events:number;entries:AP[]};planned:{plans:number;occurrences:number;links:number;entries:Plan[]};cash:{accounts:number;entries:Cash[]};payroll:PayrollForecastSources}>(statement,source.params)).rows[0];
 assertReceivableAgingBounds(r.ar.bounds);assertPayableAgingBounds(r.ap.bills,r.ap.events,0,0);assertOutlookBounds(r.planned.plans,r.planned.occurrences,r.planned.links,r.cash.accounts);
 const work=scheduledPayrollForecast(payrollQuery,r.payroll).body.data;
 const all:MoneyRow[]=[...r.ar.entries,...r.ap.entries,...r.planned.entries,...r.cash.entries],scales=new Map<string,number>();for(const a of all)scales.set(a.currencyId,Math.max(a.scale,scales.get(a.currencyId)??0));
 const issues:{source:string;id:string;on?:string;code:string}[]=[],chart:Record<string,unknown>[]=[];
 const summaries=[...scales].sort(([a],[b])=>a.localeCompare(b)).map(([currencyId,scale])=>{
  const sums:Record<string,bigint>={openingCash:0n,receivable:0n,customerCredit:0n,payable:0n,supplierCredit:0n,undatedReceivable:0n,overdueReceivable:0n,overduePayable:0n,expectedReceipts:0n,expectedBillPayments:0n,unmatchedPlannedCosts:0n},daily=new Map<string,{inflow:bigint;bill:bigint;planned:bigint}>();
  const amount=(a:MoneyRow,n:string)=>readMinorUnits(n)*10n**BigInt(scale-a.scale),day=(on:string)=>{let d=daily.get(on);if(!d){d={inflow:0n,bill:0n,planned:0n};daily.set(on,d);}return d;};
  for(const a of r.cash.entries.filter(a=>a.currencyId===currencyId))sums.openingCash+=amount(a,a.minor);
  for(const a of r.ar.entries.filter(a=>a.currencyId===currencyId)){const n=amount(a,a.balance);if(n<0n){sums.customerCredit-=n;continue;}sums.receivable+=n;if(a.allocationReview){sums.undatedReceivable+=n;issues.push({source:'invoice',id:a.id,code:'INSTALLMENT_ALLOCATION_REVIEW_REQUIRED'});continue;}for(const d of a.dues){const n=amount(a,d.minor);if(d.on<=q.on)sums.overdueReceivable+=n;else if(d.on<=q.through){sums.expectedReceipts+=n;day(d.on).inflow+=n;}}}
  for(const a of r.ap.entries.filter(a=>a.currencyId===currencyId)){const n=amount(a,a.balance);if(n<0n){sums.supplierCredit-=n;continue;}sums.payable+=n;if(a.dueOn<=q.on)sums.overduePayable+=n;else if(a.dueOn<=q.through){sums.expectedBillPayments+=n;day(a.dueOn).bill+=n;}}
  for(const a of r.planned.entries.filter(a=>a.currencyId===currencyId)){if(a.review||readMinorUnits(a.covered)>readMinorUnits(a.gross)){issues.push({source:'expected_cost',id:a.id,on:a.on,code:'SOURCE_ACCESS_OR_CHANGED_TERMS_REVIEW_REQUIRED'});continue;}const n=amount(a,a.gross)-amount(a,a.covered);sums.unmatchedPlannedCosts+=n;day(a.on).planned+=n;}
  let balance=sums.openingCash;for(const [on,d] of [...daily].sort(([a],[b])=>a.localeCompare(b))){balance+=d.inflow-d.bill-d.planned;chart.push({on,currencyId,unitScale:scale,expectedReceipts:exact(d.inflow,scale),expectedBillPayments:exact(d.bill,scale),unmatchedPlannedCosts:exact(d.planned,scale),knownScenarioCash:exact(balance,scale)});}
  return {currencyId,currencyCode:all.find(a=>a.currencyId===currencyId)!.currencyCode,unitScale:scale,...Object.fromEntries(Object.entries(sums).map(([key,n])=>[key,exact(n,scale)])),knownScenarioClosingCash:exact(balance,scale)};
 });
 assertOutlookOutputBounds(scales.size,issues.length,chart.length);
 return {status:200,body:{data:{report:'source_scoped_financial_outlook',...q,snapshotAt:r.snapshotAt,currencies:summaries,chartData:chart,reviewRequired:issues,scheduledPayroll:work,
  coverage:'visible_posted_cash_tuition_expense_bills_and_configured_cost_sources',completeAcademyForecast:false,permissionsAppliedBeforeAggregation:true,sourceSnapshot:'single_statement',openingCashBasis:'posted_balances_of_currently_configured_cash_and_bank_accounts',projectionBasis:'future_due_dates_of_current_outstanding_items_and_unmatched_expected_costs',matchingBasis:'explicit_associations_active_on_baseline_date',payrollIncludedInCashScenario:false,payrollExclusionReason:'actual_bill_overlap_and_hourly_cash_payment_dates_not_reconciled',overdueItemsAssignedInventedPaymentDates:false,creditsAssumedRefunded:false,futureDatedPostingsProjected:false,systemKnowledgeAsOf:false,currencyConversion:'none',accrualForecast:false,paymentExecuted:false,bankSettlementVerified:false}}};
}
export const financialOutlookContract=[{path:'/api/v1/reports/finance/outlook',method:'get',summary:'Single-source-snapshot financial outlook: posted cash, dated current receivable/payable obligations, explicitly unmatched future cost occurrences and separate scheduled payroll estimates; exact per-currency chart scenario with unresolved timing/access/terms visible, not a complete cash/accrual forecast or bank verification',querySchema:query}] as const;
