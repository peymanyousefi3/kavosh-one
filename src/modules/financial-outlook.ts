import { Temporal } from '@js-temporal/polyfill';
import { z } from 'zod';
import type { ApiContext,Reply } from '../core/api.ts';
import { permissionScope } from '../core/approvals.ts';
import { ApiError,scopeNonempty,type Capability } from '../core/policy.ts';
import { exactReportMoney as exact } from '../core/aging.ts';
import { readMinorUnits } from '../core/money.ts';
import { accountingDate } from './finance-periods.ts';
import { financialAccountSelectionSQL,financialReportAccess } from './financial-reports.ts';
import { journalPointLookupSQL } from './finance-journals.ts';
import { receivableSourcesSQL,assertReceivableAgingBounds } from './receivables-aging.ts';
import { payableSourcesSQL,assertPayableAgingBounds } from './payables-aging.ts';
import { payrollForecastSource,scheduledPayrollForecast,type PayrollForecastSources } from './payroll-forecast.ts';
import { recordedPayrollOutlookSource,assertRecordedPayrollOutlookBounds,type RecordedPayrollSource } from './recorded-payroll-outlook.ts';
import { lockAcademyTopology } from './academy.ts';

const uuid=z.string().uuid().transform(v=>v.toLowerCase());
const payrollDates=z.array(z.object({postingId:uuid,payOn:accountingDate}).strict()).max(100).refine(v=>new Set(v.map(e=>e.postingId)).size===v.length);
const payrollDatesText=z.string().max(8000).refine(v=>{try{return payrollDates.safeParse(JSON.parse(v)).success;}catch{return false;}},'Use a JSON array of unique postingId/payOn overrides,at most100.');
const query=z.object({on:accountingDate,through:accountingDate,timeZone:z.string().min(1).max(100).refine(v=>{if(/^[+-]/.test(v))return false;try{Temporal.Now.instant().toZonedDateTimeISO(v);return true;}catch{return false;}}),hubId:uuid.optional(),currencyId:uuid.optional(),payrollDates:payrollDatesText.optional(),payrollCash:z.literal('recorded_net').optional(),payrollOverlap:z.enum(['review','separate_liabilities']).optional()}).strict().refine(q=>(q.payrollOverlap===undefined&&q.payrollDates===undefined)||q.payrollCash==='recorded_net').refine(q=>{try{return q.through>q.on&&Temporal.PlainDate.from(q.on).until(q.through).days<=366;}catch{return false;}},'Choose a future horizon of at most 366 days.');
const arCaps:Capability[]=['financial-outlook.view','financial-reports.view','receivables-reports.view','invoices.view','receipts.view','allocations.view'];
const apCaps:Capability[]=['financial-outlook.view','financial-reports.view','payables-reports.view','expenses.view','expense-payments.view'];
type MoneyRow={currencyId:string;currencyCode:string;scale:number};
type AR=MoneyRow&{id:string;issuedOn:string;notBefore:string;balance:string;allocationReview:boolean;dues:{on:string;minor:string}[]};
type AP=MoneyRow&{id:string;postedOn:string;notBefore:string;balance:string;dueOn:string;payeePersonId?:string|null};
type Plan=MoneyRow&{id:string;on:string;version:number;gross:string;covered:string;review:boolean;payeePersonId?:string|null};
type Cash=MoneyRow&{id:string;minor:string};
type CashEvent=MoneyRow&{on:string;minor:string};
type ARSource={bounds:{invoices:number;installments:number;receipts:number;allocations:number};entries:AR[]};
type APSource={bills:number;events:number;entries:AP[]};
type CashSource={accounts:number;futureLines:number;entries:Cash[];events:CashEvent[]};
export function assertOutlookBounds(plans:number,occurrences:number,links:number,cash:number,futureCashLines=0){if(plans>1000||occurrences>10000||links>100000||cash>10000||futureCashLines>100000)throw new ApiError(422,'FINANCIAL_OUTLOOK_REQUIRES_BACKGROUND_JOB');}
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
 SELECT p.id,d.due_day,r.* FROM limited p CROSS JOIN days d CROSS JOIN LATERAL(SELECT r.academy_id,r.payee_id,r.version,r.currency_id,r.unit_scale,r.source_snapshot,r.definition,r.gross_minor FROM public.expense_commitment_revisions r WHERE r.commitment_id=p.id AND r.effective_on<=d.due_day ORDER BY r.effective_on DESC,r.version DESC LIMIT 1) r
 WHERE public.scope_contains($3::jsonb,public.expense_commitment_scope(r.definition->'lines')) AND public.scope_contains($4::jsonb,public.expense_commitment_scope(r.definition->'lines')) AND public.scope_contains($9::jsonb,public.expense_commitment_scope(r.definition->'lines'))
 AND($8::uuid IS NULL OR r.currency_id=$8)
 AND(((r.definition->>'active')::boolean AND d.due_day>=(r.definition->>'startsOn')::date AND(r.definition->'endsOn'='null'::jsonb OR d.due_day<=(r.definition->>'endsOn')::date) AND public.expense_schedule_occurs(r.definition->'schedule',d.due_day)) OR EXISTS(SELECT 1 FROM links l WHERE l.commitment_id=p.id AND l.occurrence_on=d.due_day AND l.effective_on<=$2::date AND(l.ends_on IS NULL OR l.ends_on>$2::date)))
 LIMIT 10001
),rows AS(
 SELECT o.id,(SELECT person_id FROM public.financial_payees fp WHERE fp.academy_id=o.academy_id AND fp.id=o.payee_id) AS "payeePersonId",o.due_day::text AS "on",o.version,o.currency_id AS "currencyId",o.source_snapshot#>>'{currency,code}' AS "currencyCode",o.unit_scale scale,o.gross_minor::text gross,
 coalesce((SELECT sum(l.expected_minor) FROM links l WHERE l.commitment_id=o.id AND l.occurrence_on=o.due_day AND l.effective_on<=$2::date AND(l.ends_on IS NULL OR l.ends_on>$2::date) AND l.terms_version=o.version),0)::text covered,
 NOT(o.definition->>'active')::boolean OR NOT public.expense_schedule_occurs(o.definition->'schedule',o.due_day) OR EXISTS(
 SELECT 1 FROM links l CROSS JOIN LATERAL(SELECT public.commitment_bill_source_scopes(l.commitment_id,l.terms_version,l.bill_id) scopes) s
 WHERE l.commitment_id=o.id AND l.occurrence_on=o.due_day AND((public.scope_contains($5::jsonb,s.scopes->'combined') AND public.scope_contains($9::jsonb,s.scopes->'combined') AND public.scope_contains($4::jsonb,s.scopes->'commitment') AND public.scope_contains($6::jsonb,s.scopes->'bill')) IS NOT TRUE OR(l.effective_on<=$2::date AND(l.ends_on IS NULL OR l.ends_on>$2::date) AND l.terms_version<>o.version))) review
 FROM occurrences o
)
SELECT(SELECT count(*)::integer FROM plans) plans,(SELECT count(*)::integer FROM occurrences) occurrences,(SELECT count(*)::integer FROM links) links,coalesce((SELECT jsonb_agg(to_jsonb(rows) ORDER BY "on",id) FROM rows),'[]'::jsonb) entries`;

export async function financialOutlook(ctx:ApiContext):Promise<Reply|null>{
 if(ctx.path!=='reports/finance/outlook')return null;if(ctx.request.method!=='GET')throw new ApiError(405,'METHOD_NOT_ALLOWED');
 const p=new URL(ctx.request.url).searchParams;if(new Set(p.keys()).size!==[...p.keys()].length)throw new ApiError(400,'DUPLICATE_QUERY');const q=query.parse(Object.fromEntries(p));await lockAcademyTopology(ctx);
 const scope=(cap:Capability)=>{const s=permissionScope(ctx,cap);if(!scopeNonempty(s))throw new ApiError(403,'FORBIDDEN');return s;},arScopes=arCaps.map(scope),apScopes=apCaps.map(scope),outlook=scope('financial-outlook.view'),reports=scope('financial-reports.view'),plans=scope('expense-commitments.view'),links=scope('expense-commitment-links.view');
 const hubs=q.hubId?[q.hubId]:null,currencies=q.currencyId?[q.currencyId]:null,source=composer(),cashAccess=financialReportAccess(ctx,['financial-outlook.view','financial-reports.view','ledger.view','accounts.view']);
 const arAt=(on:string)=>source.bind(`${receivableSourcesSQL},forecast_receipts AS MATERIALIZED(SELECT r.invoice_id,rev.posted_on reversal_on FROM limited i JOIN public.tuition_receipts r ON r.academy_id=i.academy_id AND r.invoice_id=i.id LEFT JOIN public.finance_journals rev ON rev.academy_id=r.academy_id AND rev.id=r.reversal_id AND rev.posted_on<=$1::date WHERE r.received_on<=$1::date LIMIT 100001) SELECT to_jsonb(bounds)||jsonb_build_object('receipts',greatest(bounds.receipts,(SELECT count(*)::integer FROM forecast_receipts))) bounds,coalesce((SELECT jsonb_agg(jsonb_build_object('id',i.id,'currencyId',i.currency_id,'currencyCode',i.currency_code,'scale',i.unit_scale,'issuedOn',i.issued_on::text,'notBefore',greatest(i.issued_on,(SELECT max(f.reversal_on) FROM forecast_receipts f WHERE f.invoice_id=i.id))::text,'balance',i.balance::text,'allocationReview',i.allocation_review,'dues',coalesce((SELECT jsonb_agg(jsonb_build_object('on',s.due_on::text,'minor',(s.amount_minor-s.allocated)::text) ORDER BY s.due_on,s.ordinal) FROM schedule s WHERE s.invoice_id=i.id AND s.amount_minor>s.allocated),'[]'::jsonb))) FROM amounts i WHERE i.balance<>0),'[]'::jsonb) entries FROM bounds`,[on,JSON.stringify(arScopes),hubs,null,null,null,currencies,null,null,null,false,[30,60,90],null,10001,ctx.credential.all_hubs,ctx.credential.hub_ids,true,[],[],[],null]);
 const apAt=(on:string)=>source.bind(`${payableSourcesSQL} SELECT(SELECT bills FROM bill_bound) bills,(SELECT payment_events FROM event_bound) events,coalesce((SELECT jsonb_agg(jsonb_build_object('id',id,'payeePersonId',(SELECT person_id FROM public.financial_payees fp WHERE fp.academy_id=balances.academy_id AND fp.id=balances.payee_id),'currencyId',currency_id,'currencyCode',currency_code,'scale',unit_scale,'balance',balance::text,'postedOn',posted_on::text,'notBefore',greatest(posted_on,(SELECT max(e.posted_on) FROM events e WHERE e.bill_id=balances.id AND e.delta_minor<0))::text,'dueOn',due_on::text)) FROM balances WHERE balance<>0),'[]'::jsonb) entries`,[on,JSON.stringify(apScopes),hubs,null,null,null,null,currencies,null,null,null,false,[30,60,90],null,10001,ctx.credential.all_hubs,ctx.credential.hub_ids,JSON.stringify(scope('expense-payments.view'))]);
 const ar=arAt(q.on),ap=apAt(q.on),projectedAR=arAt(q.through),projectedAP=apAt(q.through);
 const planned=source.bind(plannedSQL,[q.on,q.through,JSON.stringify(outlook),JSON.stringify(plans),JSON.stringify(links),JSON.stringify(scope('expenses.view')),q.hubId??null,q.currencyId??null,JSON.stringify(reports)]);
 const cash=source.bind(`WITH selected AS MATERIALIZED(${financialAccountSelectionSQL}),cash AS MATERIALIZED(
 SELECT s.* FROM selected s JOIN public.finance_account_catalogue a ON a.id=s.id WHERE a.operational_role IN('cash','bank') LIMIT 10001
 ),limited AS MATERIALIZED(SELECT * FROM cash WHERE(SELECT count(*) FROM cash)<=10000),rows AS(
 SELECT s.id,s.currency_id AS "currencyId",s.currency_code AS "currencyCode",s.unit_scale scale,coalesce((SELECT sum(CASE WHEN l.side='debit' THEN l.amount_minor ELSE -l.amount_minor END) FROM public.finance_journal_lines l ${journalPointLookupSQL} WHERE l.account_id=s.id AND j.posted_on<=$5::date),0)::text minor FROM limited s
 ),future_source AS MATERIALIZED(
 SELECT s.currency_id,s.currency_code,s.unit_scale,j.posted_on,CASE WHEN l.side='debit' THEN l.amount_minor ELSE -l.amount_minor END minor
 FROM limited s JOIN public.finance_journal_lines l ON l.account_id=s.id ${journalPointLookupSQL} WHERE j.posted_on>$5::date AND j.posted_on<=$9::date LIMIT 100001
 ),events AS(
 SELECT currency_id AS "currencyId",currency_code AS "currencyCode",unit_scale scale,posted_on::text AS "on",sum(minor)::text minor FROM future_source WHERE(SELECT count(*) FROM future_source)<=100000 GROUP BY currency_id,currency_code,unit_scale,posted_on
 ) SELECT(SELECT count(*)::integer FROM cash) accounts,(SELECT count(*)::integer FROM future_source) AS "futureLines",coalesce((SELECT jsonb_agg(to_jsonb(rows)) FROM rows),'[]'::jsonb) entries,coalesce((SELECT jsonb_agg(to_jsonb(events) ORDER BY "on","currencyId",scale) FROM events),'[]'::jsonb) events`,[cashAccess.all,cashAccess.hubs,cashAccess.excluded,cashAccess.global,q.on,hubs,currencies,null,q.through]);
 const payrollQuery={from:Temporal.PlainDate.from(q.on).add({days:1}).toString(),through:q.through,timeZone:q.timeZone,...q.hubId?{hubId:q.hubId}:{},...q.currencyId?{currencyId:q.currencyId}:{}},payroll=payrollForecastSource(ctx,payrollQuery,[outlook]);
 const netSource=q.payrollCash?recordedPayrollOutlookSource(ctx,q):null,netSQL=netSource?`(SELECT to_jsonb(s) FROM(${source.bind(netSource.sql,netSource.params)}) s)`:'NULL::jsonb';
 // Every source is evaluated by this single statement, not by fetching API
 // pages or combining independently changing read-committed snapshots.
 // Multi-column source results become JSON at their subquery boundary.
 const statement=`SELECT statement_timestamp()::text AS "snapshotAt",(SELECT to_jsonb(s) FROM(${ar}) s) ar,(SELECT to_jsonb(s) FROM(${ap}) s) ap,(SELECT to_jsonb(s) FROM(${projectedAR}) s) AS "projectedAR",(SELECT to_jsonb(s) FROM(${projectedAP}) s) AS "projectedAP",(SELECT to_jsonb(s) FROM(${planned}) s) planned,(SELECT to_jsonb(s) FROM(${cash}) s) cash,(SELECT to_jsonb(s) FROM(${source.bind(payroll.sql,payroll.params)}) s) payroll,${netSQL} AS "netPayroll"`;
 const r=(await ctx.db.query<{snapshotAt:string;ar:ARSource;ap:APSource;projectedAR:ARSource;projectedAP:APSource;planned:{plans:number;occurrences:number;links:number;entries:Plan[]};cash:CashSource;payroll:PayrollForecastSources;netPayroll:RecordedPayrollSource|null}>(statement,source.params)).rows[0];
 for(const a of [r.ar,r.projectedAR])assertReceivableAgingBounds(a.bounds);for(const a of [r.ap,r.projectedAP])assertPayableAgingBounds(a.bills,a.events,0,0);assertOutlookBounds(r.planned.plans,r.planned.occurrences,r.planned.links,r.cash.accounts,r.cash.futureLines);
 const work=scheduledPayrollForecast(payrollQuery,r.payroll).body.data;
 const net=r.netPayroll??{postings:0,buckets:0,eventLines:0,entries:[]};assertRecordedPayrollOutlookBounds(net);
 const dateOverrides=new Map(q.payrollDates===undefined?[]:payrollDates.parse(JSON.parse(q.payrollDates)).map(e=>[e.postingId,e.payOn])),selectedPayrollIds=new Set(net.entries.map(e=>e.id));if([...dateOverrides.keys()].some(id=>!selectedPayrollIds.has(id)))throw new ApiError(400,'PAYROLL_DATE_OVERRIDE_SOURCE_NOT_SELECTED');
 const payrollByCurrency=new Map<string,typeof net.entries>();for(const e of net.entries){const rows=payrollByCurrency.get(e.currencyId)??[];rows.push(e);payrollByCurrency.set(e.currencyId,rows);}
 const overlaps=new Set<string>();for(const a of r.projectedAP.entries)if(a.payeePersonId&&readMinorUnits(a.balance)>0n)overlaps.add(a.payeePersonId+':'+a.currencyId);for(const a of r.planned.entries)if(a.payeePersonId&&(a.review||readMinorUnits(a.gross)>readMinorUnits(a.covered)))overlaps.add(a.payeePersonId+':'+a.currencyId);
 const all:MoneyRow[]=[...r.ar.entries,...r.ap.entries,...r.projectedAR.entries,...r.projectedAP.entries,...r.planned.entries,...r.cash.entries,...r.cash.events,...net.entries],scales=new Map<string,number>();for(const a of all)scales.set(a.currencyId,Math.max(a.scale,scales.get(a.currencyId)??0));
 assertOutlookOutputBounds(scales.size,0,0);
 const issues:{source:string;id:string;on?:string;code:string}[]=[],issueKeys=new Set<string>(),chart:Record<string,unknown>[]=[];
 const issue=(value:typeof issues[number])=>{const key=JSON.stringify(value);if(!issueKeys.has(key)){issueKeys.add(key);issues.push(value);}};
 const summaries=[...scales].sort(([a],[b])=>a.localeCompare(b)).map(([currencyId,scale])=>{
  const sums:Record<string,bigint>={openingCash:0n,receivable:0n,customerCredit:0n,payable:0n,supplierCredit:0n,undatedReceivable:0n,overdueReceivable:0n,overduePayable:0n,recordedCashChange:0n,recordedHorizonReceivable:0n,recordedHorizonCustomerCredit:0n,recordedHorizonPayable:0n,recordedHorizonSupplierCredit:0n,horizonUnscheduledReceivable:0n,horizonUnscheduledPayable:0n,expectedReceipts:0n,expectedBillPayments:0n,unmatchedPlannedCosts:0n},daily=new Map<string,{recorded:bigint;inflow:bigint;bill:bigint;planned:bigint;payroll:bigint}>();
  if(q.payrollCash)Object.assign(sums,{currentRecordedPayrollUnpaid:0n,horizonRecordedPayrollUnpaid:0n,expectedNetPayrollPayments:0n,horizonUnscheduledPayroll:0n,pastPlannedPayrollPay:0n,payrollDueBeyondHorizon:0n});
  const amount=(a:MoneyRow,n:string)=>readMinorUnits(n)*10n**BigInt(scale-a.scale),day=(on:string)=>{let d=daily.get(on);if(!d){d={recorded:0n,inflow:0n,bill:0n,planned:0n,payroll:0n};daily.set(on,d);}return d;};
  for(const a of r.cash.entries.filter(a=>a.currencyId===currencyId))sums.openingCash+=amount(a,a.minor);
  for(const a of r.cash.events.filter(a=>a.currencyId===currencyId)){const n=amount(a,a.minor);sums.recordedCashChange+=n;day(a.on).recorded+=n;}
  for(const a of r.ar.entries.filter(a=>a.currencyId===currencyId)){const n=amount(a,a.balance);if(n<0n){sums.customerCredit-=n;continue;}sums.receivable+=n;if(a.allocationReview){sums.undatedReceivable+=n;issue({source:'invoice',id:a.id,code:'INSTALLMENT_ALLOCATION_REVIEW_REQUIRED'});continue;}for(const d of a.dues)if(d.on<=q.on)sums.overdueReceivable+=amount(a,d.minor);}
  for(const a of r.ap.entries.filter(a=>a.currencyId===currencyId)){const n=amount(a,a.balance);if(n<0n){sums.supplierCredit-=n;continue;}sums.payable+=n;if(a.dueOn<=q.on)sums.overduePayable+=n;}
  // Reserve ALL retained settlements/corrections through the horizon before
  // assuming an outstanding due item is paid. Their real cash is already in
  // the ledger event stream, even when recorded later than the due date.
  for(const a of r.projectedAR.entries.filter(a=>a.currencyId===currencyId)){
   const n=amount(a,a.balance);if(n<0n){sums.recordedHorizonCustomerCredit-=n;continue;}sums.recordedHorizonReceivable+=n;
   if(a.allocationReview){sums.horizonUnscheduledReceivable+=n;issue({source:'invoice',id:a.id,code:'INSTALLMENT_ALLOCATION_REVIEW_REQUIRED'});continue;}
   for(const d of a.dues){const n=amount(a,d.minor);if(d.on<=q.on){sums.horizonUnscheduledReceivable+=n;if(a.notBefore>q.on)issue({source:'invoice',id:a.id,code:'FORECAST_COLLECTION_DATE_REQUIRED'});}else if(d.on<=q.through){if(d.on<a.notBefore){sums.horizonUnscheduledReceivable+=n;issue({source:'invoice',id:a.id,code:'FORECAST_COLLECTION_DATE_REQUIRED'});}else{sums.expectedReceipts+=n;day(d.on).inflow+=n;}}}
  }
  for(const a of r.projectedAP.entries.filter(a=>a.currencyId===currencyId)){
   const n=amount(a,a.balance);if(n<0n){sums.recordedHorizonSupplierCredit-=n;continue;}sums.recordedHorizonPayable+=n;
   if(a.dueOn<=q.on||a.dueOn<a.notBefore){sums.horizonUnscheduledPayable+=n;if(a.notBefore>q.on)issue({source:'expense_bill',id:a.id,code:'FORECAST_BILL_PAYMENT_DATE_REQUIRED'});}else if(a.dueOn<=q.through){sums.expectedBillPayments+=n;day(a.dueOn).bill+=n;}
  }
  for(const a of r.planned.entries.filter(a=>a.currencyId===currencyId)){if(a.review||readMinorUnits(a.covered)>readMinorUnits(a.gross)){issue({source:'expected_cost',id:a.id,on:a.on,code:'SOURCE_ACCESS_OR_CHANGED_TERMS_REVIEW_REQUIRED'});continue;}const n=amount(a,a.gross)-amount(a,a.covered);sums.unmatchedPlannedCosts+=n;day(a.on).planned+=n;}
  for(const a of payrollByCurrency.get(currencyId)??[]){
   const payOn=dateOverrides.get(a.id)??a.payOn;
   const budget=amount(a,a.budget),current=budget-amount(a,a.paidOn),remaining=budget-amount(a,a.paidThrough);if(current<0n||remaining<0n)throw new Error('PAYROLL_OUTLOOK_BALANCE_INCONSISTENT');
   if(a.activeOn){sums.currentRecordedPayrollUnpaid+=current;if(a.payOn<q.on)sums.pastPlannedPayrollPay+=current;}
   if(!a.activeThrough){if(a.activeOn&&current>0n)issue({source:'payroll_net',id:a.id,code:'PAYROLL_NET_CHANGED_WITHIN_HORIZON_REVIEW'});continue;}sums.horizonRecordedPayrollUnpaid+=remaining;if(remaining===0n)continue;
   if(payOn<=q.on||payOn<a.notBefore){sums.horizonUnscheduledPayroll+=remaining;issue({source:'payroll_net',id:a.id,on:payOn,code:'FORECAST_PAYROLL_PAYMENT_DATE_REQUIRED'});continue;}
   if(payOn>q.through){sums.payrollDueBeyondHorizon+=remaining;continue;}
   if(overlaps.has(a.personId+':'+a.currencyId)){issue({source:'payroll_net',id:a.id,on:payOn,code:q.payrollOverlap==='separate_liabilities'?'PAYROLL_SEPARATE_LIABILITIES_SCENARIO':'PAYROLL_COST_OVERLAP_REVIEW_REQUIRED'});if(q.payrollOverlap!=='separate_liabilities'){sums.horizonUnscheduledPayroll+=remaining;continue;}}
   sums.expectedNetPayrollPayments+=remaining;day(payOn).payroll+=remaining;
  }
  let balance=sums.openingCash;for(const [on,d] of [...daily].sort(([a],[b])=>a.localeCompare(b))){balance+=d.recorded+d.inflow-d.bill-d.planned-d.payroll;chart.push({on,currencyId,unitScale:scale,recordedCashChange:exact(d.recorded,scale),expectedReceipts:exact(d.inflow,scale),expectedBillPayments:exact(d.bill,scale),unmatchedPlannedCosts:exact(d.planned,scale),...(q.payrollCash?{expectedNetPayrollPayments:exact(d.payroll,scale)}:{}),knownScenarioCash:exact(balance,scale)});}
  return {currencyId,currencyCode:all.find(a=>a.currencyId===currencyId)!.currencyCode,unitScale:scale,...Object.fromEntries(Object.entries(sums).map(([key,n])=>[key,exact(n,scale)])),knownScenarioClosingCash:exact(balance,scale)};
 });
 assertOutlookOutputBounds(scales.size,issues.length,chart.length);
 return {status:200,body:{data:{report:'source_scoped_financial_outlook',...q,snapshotAt:r.snapshotAt,currencies:summaries,chartData:chart,reviewRequired:issues,scheduledPayroll:work,
  coverage:q.payrollCash?'visible_cash_receivables_payables_cost_plans_and_recorded_net_payroll':'visible_posted_cash_tuition_expense_bills_and_configured_cost_sources',completeAcademyForecast:false,permissionsAppliedBeforeAggregation:true,sourceSnapshot:'single_statement',openingCashBasis:'posted_balances_of_currently_configured_cash_and_bank_accounts',projectionBasis:'recorded_future_cash_plus_due_items_remaining_after_all_recorded_horizon_settlements',matchingBasis:'explicit_associations_active_at_horizon_after_recorded_releases_and_voids',recordedHorizonBalancesExcludeAssumedPayments:true,reopenedDueTimingPolicy:'conservative_whole_bill_or_invoice_due_portion_requires_review',recordedCashDateBasis:'inclusive_journal_posted_dates_not_external_bank_settlement',collectionDatesBeforeInvoiceIssueAssumed:false,paymentDatesBeforeBillPostingAssumed:false,payrollIncludedInCashScenario:q.payrollCash==='recorded_net',payrollCashCoverage:q.payrollCash?'active_recorded_net_liability_buckets_with_configured_pay_dates':'excluded',payrollOverlapPolicy:q.payrollOverlap??'review',payrollOverlapDetectionBasis:'visible_selected_currency_bill_or_unmatched_commitment_payees_explicitly_bound_to_the_same_person;not_an_automatic_match',payrollHubBasis:'original_wage_liability_account_hub_not_an_assigned_funding_bank',payrollFundingAccountAssigned:false,payrollDateBasis:'approved_planned_pay_on_or_explicit_report_only_override',payrollOverridesChangeRecordedData:false,payrollUnpostedEarningsIncluded:false,unaccruedScheduledPayrollIncludedInCashScenario:false,payrollStatutoryRemittancesIncluded:false,payrollPastPlannedPayIsLegalOverdueDetermination:false,payrollExclusionReason:q.payrollCash?'unposted_gross_unaccrued_scheduled_costs_and_statutory_remittances_not_included':'recorded_net_cash_not_selected_and_unaccrued_gross_not_a_cash_payment_plan',overdueItemsAssignedInventedPaymentDates:false,creditsAssumedRefunded:false,futureDatedPostingsProjected:true,systemKnowledgeAsOf:false,currencyConversion:'none',accrualForecast:false,paymentExecuted:false,bankSettlementVerified:false}}};
}
export const financialOutlookContract=[{path:'/api/v1/reports/finance/outlook',method:'get',summary:'Single-statement financial outlook with baseline cash/AR/AP,future journals,horizon-reserved settlements and unmatched cost plans. Optional payrollCash=recorded_net adds exact permitted original wage-liability buckets at approved planned pay dates or explicit report-only payrollDates overrides(not before posting/reopening),after reserving all horizon payments/corrections. Potential same-person selected-currency bill/plan overlap is unscheduled unless payrollOverlap=separate_liabilities explicitly selects that scenario;not automatic matching. Payroll funding banks,unposted/scheduled gross and statutory remittances remain unassigned/excluded. Full source/current geographic rights;not complete cash/accrual forecasting,bank verification or payment authorization.',querySchema:query}] as const;
