import type { ApiContext,Reply } from '../core/api.ts';
import { ApiError } from '../core/policy.ts';
import { csvRow,csvText } from '../core/csv.ts';
import { formatMoneyTotal,readMinorUnits } from '../core/money.ts';
import type { ResolvedReportWindow } from '../core/report-window.ts';
import { financialOutlook,financialOutlookContract,assertOutlookOutputBounds } from './financial-outlook.ts';

type Data=NonNullable<Awaited<ReturnType<typeof financialOutlook>>>['body']['data'];
type Provenance={id:string;version:number;dateWindow?:ResolvedReportWindow&{overriddenFields?:string[]}};
const baseMeasures=['openingCash','receivable','customerCredit','payable','supplierCredit','undatedReceivable','overdueReceivable','overduePayable','recordedCashChange','recordedHorizonReceivable','recordedHorizonCustomerCredit','recordedHorizonPayable','recordedHorizonSupplierCredit','horizonUnscheduledReceivable','horizonUnscheduledPayable','expectedReceipts','expectedBillPayments','unmatchedPlannedCosts','knownScenarioClosingCash'] as const;
const payrollMeasures=['currentRecordedPayrollUnpaid','horizonRecordedPayrollUnpaid','expectedNetPayrollPayments','horizonUnscheduledPayroll','pastPlannedPayrollPay','payrollDueBeyondHorizon'] as const;
const flows=['recordedCashChange','expectedReceipts','expectedBillPayments','unmatchedPlannedCosts'] as const;
// ponytail: synchronous complete source/output bounds remain in the read engine;
// CSV adds a4MiB limit. Queued/chunked outlook exports are not yet supported.
export function financialOutlookCsv(d:Data,provenance?:Provenance):Reply{
 assertOutlookOutputBounds(d.currencies.length,d.reviewRequired.length,d.chartData.length);
 if(new Set(d.currencies.map(c=>c.currencyId)).size!==d.currencies.length||d.snapshotAt!==d.scheduledPayroll.snapshotAt)throw new Error('OUTLOOK_EXPORT_SNAPSHOT_INVALID');
 const header=['section','field','value','currency_id','currency_code','unit_scale','on','source_id','minor','amount','details_json'],rows:(string|number|boolean|null|undefined)[][]=[header];
 const meta=(section:string,k:string,v:unknown)=>{if(v!==undefined)rows.push([section,k,csvText(typeof v==='string'?v:JSON.stringify(v))]);};
 for(const [k,v] of Object.entries(d))if(!['currencies','chartData','reviewRequired','scheduledPayroll'].includes(k))meta('metadata',k,v);
 meta('metadata','exportCompleteness','complete_permitted_report_within_source_and_output_limits');meta('metadata','numericPrecisionPolicy','Money and minor units are exact CSV text; import as text to avoid spreadsheet precision loss.');meta('metadata','textPolicy','Formula-like free text uses a visible text: prefix; stored records are unchanged.');meta('metadata','scheduledPayrollPolicy','Scheduled gross costs are separate estimates,not cash payments or additional deductions from the cash scenario.');
 if(provenance){meta('metadata','presetId',provenance.id);meta('metadata','presetVersion',provenance.version);if(provenance.dateWindow){const w=provenance.dateWindow;meta('metadata','dateWindow',w);}}
 type Currency={currencyId:string;currencyCode:string;unitScale:number};
 const money=(raw:unknown,c:Currency)=>{const m=raw as {minor:string;amount:string}|undefined;if(!m||typeof m.minor!=='string'||m.amount!==formatMoneyTotal(readMinorUnits(m.minor),c.unitScale))throw new Error('OUTLOOK_EXPORT_MONEY_INVALID');return m;};
 const amountRow=(section:string,field:string,c:Currency,raw:unknown,on?:string,id?:string,details?:unknown)=>{const m=money(raw,c);rows.push([section,field,'',c.currencyId,csvText(c.currencyCode),c.unitScale,on,id,m.minor,m.amount,details===undefined?undefined:csvText(JSON.stringify(details))]);return readMinorUnits(m.minor);};
 const charts=new Map<string,typeof d.chartData>();for(const point of d.chartData){const id=point.currencyId;if(typeof id!=='string')throw new Error('OUTLOOK_EXPORT_CHART_INVALID');const group=charts.get(id)??[];group.push(point);charts.set(id,group);}
 for(const c of d.currencies){
  const values=c as typeof c&Record<string,unknown>,measures=[...baseMeasures,...d.payrollIncludedInCashScenario?payrollMeasures:[]];for(const field of measures)amountRow('currency_total',field,c,values[field]);
  const sums=new Map<string,bigint>(),seen=new Set<string>();let balance=readMinorUnits(money(values.openingCash,c).minor),last=d.on;
  for(const p of charts.get(c.currencyId)??[]){const on=p.on;if(typeof on!=='string'||on<=last||on>d.through||p.unitScale!==c.unitScale||seen.has(on))throw new Error('OUTLOOK_EXPORT_CHART_INVALID');seen.add(on);last=on;for(const field of [...flows,...d.payrollIncludedInCashScenario?['expectedNetPayrollPayments']:[]]){const n=amountRow('chart',field,c,p[field],on);sums.set(field,(sums.get(field)??0n)+n);balance+=field==='recordedCashChange'||field==='expectedReceipts'?n:-n;}if(amountRow('chart','knownScenarioCash',c,p.knownScenarioCash,on)!==balance)throw new Error('OUTLOOK_EXPORT_CHART_INCONSISTENT');}
  for(const field of [...flows,...d.payrollIncludedInCashScenario?['expectedNetPayrollPayments']:[]])if((sums.get(field)??0n)!==readMinorUnits(money(values[field],c).minor))throw new Error('OUTLOOK_EXPORT_TOTALS_INCONSISTENT');if(balance!==readMinorUnits(money(values.knownScenarioClosingCash,c).minor))throw new Error('OUTLOOK_EXPORT_TOTALS_INCONSISTENT');charts.delete(c.currencyId);
 }
 if(charts.size)throw new Error('OUTLOOK_EXPORT_CHART_INVALID');
 for(const e of d.reviewRequired)rows.push(['review',csvText(e.code),'','','','',e.on,e.id,'','',csvText(JSON.stringify({source:e.source}))]);
 for(const [k,v] of Object.entries(d.scheduledPayroll))if(k!=='currencies')meta('scheduled_metadata',k,v);
 for(const c of d.scheduledPayroll.currencies){
  for(const field of ['knownHourlySubtotal','knownSalarySubtotal','knownSubtotal'] as const)amountRow('scheduled_total',field,c,c[field]);if(c.estimatedTotal===null)rows.push(['scheduled_status','estimatedTotal','unpriced_components_present',c.currencyId,csvText(c.currencyCode),c.unitScale]);else amountRow('scheduled_total','estimatedTotal',c,c.estimatedTotal);
  for(const e of c.unpricedComponents)rows.push(['scheduled_review',csvText(e.reason),'',c.currencyId,csvText(c.currencyCode),c.unitScale,'',e.engagementId,'','',csvText(JSON.stringify(e))]);
  for(const e of c.salaryPayments){const {estimatedCost,...details}=e;amountRow('scheduled_salary','estimatedCost',c,estimatedCost,e.on,e.engagementId,details);}
  // The read engine has already scoped and bounded these plans. Preserve all
  // pinned segment sources and allocation details,not only aggregate totals.
  for(const e of c.hourlyPlans){const {estimatedCost,...details}=e;amountRow('scheduled_hourly','estimatedCost',c,estimatedCost,undefined,undefined,details);}
 }
 const body='\uFEFF'+rows.map(row=>csvRow(Array.from({length:header.length},(_,i)=>row[i]))).join('\r\n')+'\r\n';if(Buffer.byteLength(body)>4_194_304)throw new ApiError(422,'FINANCIAL_OUTLOOK_REQUIRES_BACKGROUND_JOB');return {status:200,body,csv:{filename:`financial-outlook-${d.on}-${d.through}.csv`}};
}
export async function completeFinancialOutlookExport(ctx:ApiContext,provenance?:Provenance){const reply=await financialOutlook(ctx);if(!reply||reply.status!==200)throw new Error('OUTLOOK_REPORT_INVALID');return financialOutlookCsv(reply.body.data,provenance);}
export async function financialOutlookExport(ctx:ApiContext):Promise<Reply|null>{if(ctx.path!=='reports/finance/outlook/export')return null;if(ctx.request.method!=='GET')throw new ApiError(405,'METHOD_NOT_ALLOWED');const path='reports/finance/outlook',url=new URL(ctx.request.url);url.pathname='/api/v1/'+path;return completeFinancialOutlookExport({...ctx,path,request:new Request(url,{method:'GET'})});}
export const financialOutlookExportContract=[{path:'/api/v1/reports/finance/outlook/export',method:'get',summary:'Complete same-snapshot source-scoped financial-outlook CSV:exact currency totals,all cash-chart points,review flags,scenario overrides and separate scheduled gross totals/unpriced cases/hourly segments/salary allocations. Original current permissions and source/output ceilings apply;4MiB refuses oversized files,never truncates. Preserves explicit forecast limitations;not bank verification,payroll approval or complete accounting. No queued outlook export yet.',querySchema:financialOutlookContract[0].querySchema,responseContentType:'text/csv' as const}] as const;
