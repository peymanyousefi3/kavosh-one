import { z } from 'zod';
import type { ApiContext,Reply } from '../core/api.ts';
import { ApiError } from '../core/policy.ts';
import { exactReportMoney as exact } from '../core/aging.ts';
import { readMinorUnits } from '../core/money.ts';
import { accountingDate } from './finance-periods.ts';
import { financialIds,financialReportAccess } from './financial-reports.ts';
import { financialStatementSQL } from './financial-statements.ts';
import { lockAcademyTopology } from './academy.ts';
import { tuitionIncomeQuery,tuitionIncomeReportStatement,assertTuitionIncomeBounds } from './tuition-income-report.ts';
import { expenseCostQuery,expenseCostReportStatement,assertExpenseCostBounds } from './expense-cost-report.ts';
import { manualIncomeCostQuery,manualIncomeCostReportStatement,assertManualIncomeCostBounds } from './manual-income-cost-report.ts';
import { payrollCostQuery,payrollCostReportStatement,assertPayrollCostBounds } from './payroll-cost-report.ts';
import { profitabilityAuthorization } from './profitability-report-access.ts';
import { profitabilityCoverageSQL,type ProfitabilityCoverageRow } from './profitability-coverage.ts';

export const profitabilityQuery=z.object({from:accountingDate,through:accountingDate,attributionBasis:z.enum(['recorded','reviewed']).default('recorded'),hubIds:financialIds.optional(),classIds:financialIds.optional(),studentIds:financialIds.optional(),currencyIds:financialIds.optional(),countryIds:financialIds.optional(),regionIds:financialIds.optional(),cityIds:financialIds.optional()}).strict().refine(q=>q.from<=q.through);
const sources=['tuition','supplier','payroll','manual'] as const,dimensions=['hub','class','student','month','source'] as const;
const measures=['tuitionIncome','manualIncome','supplierExpense','payrollExpense','manualExpense','income','expenses','netResult'] as const;
type Source=typeof sources[number];
type RawRow={key:string|null;currencyId:string;currencyCode:string;unitScale:number;[key:string]:unknown};
type SourceResult={events:number;lines?:number;allocations?:number;series:Record<string,RawRow[]>;authorizationContext?:unknown};
type LedgerRow={currencyId:string;currencyCode:string;unitScale:number;incomeMinor:string;expenseMinor:string};
type Ledger={currencies:LedgerRow[];unclassifiedLineCount:string;accountCount:number;authorizationHubs:(string|null)[]};
type MoneyRow={key:string|null;currencyId:string;currencyCode:string;unitScale:number}&Record<typeof measures[number],bigint>;
// These are the SAME prepared statements used by the dedicated reports. Only
// fixed internal SQL placeholders are rebased;all caller values stay bound.
// One combined database statement gives sources,assignments and ledger ONE
// MVCC snapshot without a new isolation level or blocking financial writers.
function sourceStatements(ctx:ApiContext,q:z.infer<typeof profitabilityQuery>,includeAuthorization=false){
 const {attributionBasis,...rest}=q,common=Object.fromEntries(Object.entries(rest).map(([key,value])=>[key,Array.isArray(value)?value.join(','):value]));
 return {
  tuition:tuitionIncomeReportStatement(ctx,tuitionIncomeQuery.parse(common),includeAuthorization),
  supplier:expenseCostReportStatement(ctx,expenseCostQuery.parse({...common,costBasis:attributionBasis}),includeAuthorization),
  payroll:payrollCostReportStatement(ctx,payrollCostQuery.parse({...common,attributionBasis}),includeAuthorization),
  manual:manualIncomeCostReportStatement(ctx,manualIncomeCostQuery.parse({...common,attributionBasis}),includeAuthorization)
 };
}
function checkSource(kind:Source,r:SourceResult){const groups=Object.values(r.series).map(a=>a.length);if(kind==='tuition')assertTuitionIncomeBounds(r.events,groups);else if(kind==='supplier')assertExpenseCostBounds(r.events,r.lines!,groups);else if(kind==='payroll')assertPayrollCostBounds(r.events,r.allocations!,groups);else assertManualIncomeCostBounds(r.events,r.lines!,groups);}
function sourceMeasures(kind:Source,r:RawRow){const value=(key:string)=>{if(typeof r[key]!=='string')throw new Error('PROFITABILITY_SOURCE_INVALID');return readMinorUnits(r[key]);};return {tuitionIncome:kind==='tuition'?value('recognizedRevenue'):0n,manualIncome:kind==='manual'?value('income'):0n,supplierExpense:kind==='supplier'?value('expense'):0n,payrollExpense:kind==='payroll'?value('expense'):0n,manualExpense:kind==='manual'?value('expense'):0n};}
export async function profitabilityReport(ctx:ApiContext,includeAuthorization=false):Promise<Reply|null>{
 if(ctx.path!=='reports/finance/profitability')return null;if(ctx.request.method!=='GET')throw new ApiError(405,'METHOD_NOT_ALLOWED');
 const params=new URL(ctx.request.url).searchParams;if([...params].length!==new Set(params.keys()).size)throw new ApiError(400,'DUPLICATE_QUERY');const q=profitabilityQuery.parse(Object.fromEntries(params));await lockAcademyTopology(ctx);
 const contextual=['hubIds','classIds','studentIds','countryIds','regionIds','cityIds'].some(k=>Object.hasOwn(q,k)),baseline=sourceStatements(ctx,{from:q.from,through:q.through,attributionBasis:q.attributionBasis,...q.currencyIds?{currencyIds:q.currencyIds}:{}},true),selected=contextual?sourceStatements(ctx,q):baseline,access=financialReportAccess(ctx);
 const parameters:unknown[]=[],ctes:string[]=[],parts:string[]=[];
 const add=(name:string,statement:{sql:string;parameters:unknown[]})=>{const offset=parameters.length;parameters.push(...statement.parameters);ctes.push(`${name} AS MATERIALIZED(${statement.sql.replace(/\$(\d+)\b/g,(_m,n:string)=>'$'+(Number(n)+offset))})`);return `(SELECT to_jsonb(${name}) FROM ${name})`;};
 for(const kind of sources){const whole=add('baseline_'+kind,baseline[kind]);parts.push(`'baseline_${kind}',${whole}`);parts.push(`'selected_${kind}',${contextual?add('selected_'+kind,selected[kind]):whole}`);}
 parts.push(`'ledger',${add('ledger',{sql:financialStatementSQL,parameters:[access.all,access.hubs,access.excluded,access.global,q.through,null,q.currencyIds??null,null,q.from,false,null,null,null,1]})}`);
 parts.push(`'coverage',${add('coverage',{sql:profitabilityCoverageSQL,parameters:[access.all,access.hubs,access.excluded,access.global,q.through,null,q.currencyIds??null,null,q.from]})}`);
 const r=(await ctx.db.query<{snapshotAt:string;oversized:boolean;reports:Record<string,SourceResult>&{ledger:Ledger;coverage:{currencies:ProfitabilityCoverageRow[]}}}>(`WITH ${ctes.join(',')},payload AS MATERIALIZED(SELECT jsonb_build_object(${parts.join(',')}) reports),bounded AS MATERIALIZED(SELECT reports,octet_length(reports::text)>16777216 oversized FROM payload) SELECT to_char(statement_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') "snapshotAt",oversized,CASE WHEN NOT oversized THEN reports END reports FROM bounded`,parameters)).rows[0];
 if(r.oversized)throw new ApiError(422,'PROFITABILITY_REPORT_REQUIRES_BACKGROUND_JOB');
 // ponytail: retain existing10,000events/100,000targets limits per source,
 // 10,000combined groups/dimension,16MiB internal payload and4MiB output.
 // The database suppresses oversized payloads BEFORE sending them to Node.
 // Chunking remains a separate job;
 // no partial source,interactive page sum or silent fallback is returned.
 const scales=new Map<string,{scale:number;code:string}>();
 const remember=(row:{currencyId:string;currencyCode:string;unitScale:number})=>{const old=scales.get(row.currencyId);if(old&&old.code!==row.currencyCode)throw new Error('PROFITABILITY_CURRENCY_INVALID');scales.set(row.currencyId,{code:row.currencyCode,scale:Math.max(old?.scale??0,row.unitScale)});};
 for(const kind of sources)for(const prefix of ['baseline','selected']){const d=r.reports[prefix+'_'+kind];checkSource(kind,d);for(const row of d.series.total??[])remember(row);}
 for(const row of r.reports.ledger.currencies)remember(row);
 for(const row of r.reports.coverage.currencies)remember(row);
 const sums=(rows:{kind:Source;row:RawRow}[])=>{const out=new Map<string,MoneyRow>();for(const {kind,row} of rows){const {scale,code}=scales.get(row.currencyId)!,id=JSON.stringify([row.currencyId,row.key]),item=out.get(id)??{key:row.key,currencyId:row.currencyId,currencyCode:code,unitScale:scale,...Object.fromEntries(measures.map(k=>[k,0n]))} as MoneyRow,factor=10n**BigInt(scale-row.unitScale);for(const [k,value] of Object.entries(sourceMeasures(kind,row)))item[k as keyof ReturnType<typeof sourceMeasures>]+=value*factor;out.set(id,item);}for(const item of out.values()){item.income=item.tuitionIncome+item.manualIncome;item.expenses=item.supplierExpense+item.payrollExpense+item.manualExpense;item.netResult=item.income-item.expenses;}return [...out.values()].sort((a,b)=>a.currencyId.localeCompare(b.currencyId)||(a.key??'').localeCompare(b.key??''));};
 const grouped=(prefix:string,dim:string)=>sums(sources.flatMap(kind=>(r.reports[prefix+'_'+kind].series[dim]??[]).map(row=>({kind,row}))));
 const view=(row:MoneyRow)=>({...row,...Object.fromEntries(measures.map(k=>[k,exact(row[k],row.unitScale)]))});
 const currencies=grouped('selected','total'),whole=grouped('baseline','total'),charts=Object.fromEntries(dimensions.map(dim=>[dim,(dim==='source'?sums(sources.flatMap(kind=>(r.reports['selected_'+kind].series.total??[]).map(row=>({kind,row:{...row,key:kind}})))):grouped('selected',dim)).map(view)]));
 if(Object.values(charts).some(rows=>rows.length>10000))throw new ApiError(422,'PROFITABILITY_REPORT_REQUIRES_BACKGROUND_JOB');
 const reconciliation=[...scales].map(([currencyId,{scale,code}])=>{const covered=r.reports.coverage.currencies.find(c=>c.currencyId===currencyId),counts={postedOperatingLineCount:covered?.postedOperatingLineCount??'0',representedOperatingLineCount:covered?.representedOperatingLineCount??'0',unrepresentedOperatingLineCount:covered?.unrepresentedOperatingLineCount??'0',multiplyRepresentedOperatingLineCount:covered?.multiplyRepresentedOperatingLineCount??'0'},ledger=r.reports.ledger.currencies.find(c=>c.currencyId===currencyId),source=whole.find(c=>c.currencyId===currencyId),factor=10n**BigInt(scale-(ledger?.unitScale??scale)),income=readMinorUnits(ledger?.incomeMinor??'0')*factor,expenses=readMinorUnits(ledger?.expenseMinor??'0')*factor,sourceIncome=source?.income??0n,sourceExpenses=source?.expenses??0n,differenceIncome=income-sourceIncome,differenceExpenses=expenses-sourceExpenses;return {currencyId,currencyCode:code,unitScale:scale,postedIncome:exact(income,scale),postedExpenses:exact(expenses,scale),postedNetResult:exact(income-expenses,scale),sourceIncome:exact(sourceIncome,scale),sourceExpenses:exact(sourceExpenses,scale),unreconciledIncome:exact(differenceIncome,scale),unreconciledExpenses:exact(differenceExpenses,scale),moneyReconciles:differenceIncome===0n&&differenceExpenses===0n,...counts,sourceLineCoverageComplete:counts.unrepresentedOperatingLineCount==='0'&&counts.multiplyRepresentedOperatingLineCount==='0'};});
 const unassigned=Object.fromEntries(['hub','class','student'].map(dim=>[dim,grouped('baseline',dim).filter(row=>row.key===null).map(view)]));
 const body={data:{report:'posted_academy_profitability',snapshotAt:r.snapshotAt,filters:q,currencies:currencies.map(view),charts,ledgerReconciliation:reconciliation,unassigned,ledgerCoverage:access.global?'complete_selected_currencies':'scoped_selected_accounts',ledgerUnclassifiedLineCount:r.reports.ledger.unclassifiedLineCount,requiresPurposeReview:r.reports.ledger.unclassifiedLineCount!=='0',selectedResultBasis:'authorized_source_contribution_after_context_filters',reconciliationBasis:'all_authorized_accounts_and_sources_before_context_filters',reconciliationIsCompletenessProof:false,sourceCoverageBasis:'same_snapshot_authorized_original_journal_and_line_membership',requiresSourceReview:r.reports.ledger.unclassifiedLineCount!=='0'||reconciliation.some(r=>!r.moneyReconciles||!r.sourceLineCoverageComplete),sharedCostPolicy:'original_or_explicit_reviewed_targets_never_guessed',allocationDateBasis:q.attributionBasis==='reviewed'?'latest_approved_at_single_report_snapshot_not_historical_as_of':'original_recorded_contexts',currencyConversion:'none',chargedTaxIsRevenue:false,recoverableTaxIsExpense:false,deferredBillingsAreIncome:false,receiptsOrPaymentsCreateProfit:false,inventoryStatusChangesExpense:false,privateBodiesIncluded:false,additionalLedgerPosting:false,contextFiltersApplied:contextual,contextProfitRequiresSharedCostReview:true}};
 if(Buffer.byteLength(JSON.stringify(body))>4_194_304)throw new ApiError(422,'PROFITABILITY_REPORT_REQUIRES_BACKGROUND_JOB');const ledger=r.reports.ledger;return {status:200,body:includeAuthorization?{data:{...body.data,authorizationContext:profitabilityAuthorization.parse({kind:'academy_profitability',basis:q.attributionBasis,ledger:{hubIds:ledger.authorizationHubs.filter((id):id is string=>id!==null),includesGlobal:ledger.authorizationHubs.includes(null)},...Object.fromEntries(sources.map(kind=>[kind,r.reports['baseline_'+kind].authorizationContext]))})}}:body};
}
export const profitabilityReportContract=[{path:'/api/v1/reports/finance/profitability',method:'get',summary:'Consolidated exact tuition recognized income,supplier costs,gross plus employer payroll costs and manual operating entries in ONE source/assignment/ledger snapshot. Charts combine hub,class,student,month and source;original whole-source privacy and reviewed target rights apply before all filters. Full authorized ledger operating result and separate income/expense reconciliation remain visible BEFORE context filters;zero net difference alone never certifies source completeness. Same-snapshot posted operating-line counts identify unrepresented or multiply represented entries even when amounts cancel;no restricted source IDs are exposed. Unassigned shared costs are explicit,not guessed onto students. Separate currencies and immutable precision;deferred billings,tax,receipts,payments and inventory removal never manufacture profit. Existing per-source limits,10000combined groups/dimension/4MiB. No private documents or new ledger postings.',querySchema:profitabilityQuery}] as const;
