import { z } from 'zod';
import type { ApiContext,Reply } from '../core/api.ts';
import { ApiError } from '../core/policy.ts';
import { lockApprovalWrites } from '../core/approvals.ts';
import { csvText,csvRow } from '../core/csv.ts';
import { financialReports,financialReportsContract } from './financial-reports.ts';
import { cashMovementExport,cashFlowExport } from './cash-movements.ts';
import {completeAssetCurrencyValuationExport} from './asset-currency-valuation.ts';
import { financialStatements,financialStatementsContract } from './financial-statements.ts';
import { catalogueReport,configuredReportContext,resolveConfiguredReportContext } from './report-catalogue.ts';
import type { ResolvedReportWindow } from '../core/report-window.ts';
import { completeAchievementExport } from './achievement-export.ts';
import { completePayrollGrossExport } from './payroll-gross-export.ts';
import { completePayrollSettlementExport } from './payroll-settlement-report.ts';
import { completePayrollRegisterExport } from './payroll-register.ts';
import { completePaidTaxYtdExport } from './paid-tax-ytd.ts';
import { completeT4WorkingPaperExport } from './t4-working-paper.ts';
import { completeT4aWorkingPaperExport } from './t4a-working-paper.ts';
import { completeFinancialOutlookExport } from './financial-outlook-export.ts';
import { completePayrollForecastExport } from './payroll-forecast.ts';
import { completeRecordedWorkExport } from './recorded-work-report.ts';
import { completePollResultsExport } from './poll-results.ts';
import { completePayrollRemittanceExport } from './payroll-remittance-report.ts';
import { completeInventoryExport } from './inventory-report-export.ts';
import { completeAgingExport } from './aging-report-export.ts';
import { completeBankReconciliationExport } from './bank-reconciliation-export.ts';
import { completeLearningExport } from './learning-report-export.ts';
import { completePerformanceExport } from './student-performance-export.ts';
import { completeAttributionExport } from './attribution-report-export.ts';
import { completeProfitabilityExport } from './profitability-report-export.ts';
import { completeCollectorCustodyExport } from './collector-custody-report.ts';
import { completeCounterpartyStatementExport } from './counterparty-statement.ts';

// ponytail: complete synchronous export is bounded at2,000 entries/4MiB.
// Larger results must use queued generation,never a partial screen-page file.
export const financialExportEntryLimit=2000,financialExportByteLimit=4_194_304;
const money=z.object({minor:z.string().max(256).regex(/^-?\d+$/),amount:z.string().max(300).regex(/^-?\d+(?:\.\d+)?$/)}),kind=z.enum(['asset','liability','equity','income','expense']);
const currency=z.looseObject({currencyId:z.string().uuid(),currencyCode:z.string().min(1).max(32),unitScale:z.number().int().min(0).max(18),balanced:z.boolean().optional(),debit:money.optional(),credit:money.optional(),difference:money.optional(),income:money.optional(),expenses:money.optional(),netResult:money.optional(),assets:money.optional(),liabilities:money.optional(),equity:money.optional(),unclosedPostedResult:money.optional(),liabilitiesEquityAndResult:money.optional()});
const entry=z.looseObject({accountId:z.string().uuid(),chartVersion:z.number().int().positive(),hubId:z.string().uuid().nullable(),code:z.string().max(32),name:z.string().max(200),kind,currentKind:kind.optional(),section:z.string().max(32).optional(),currencyId:z.string().uuid(),currencyCode:z.string().max(32),unitScale:z.number().int().min(0).max(18),closing:money.optional(),debit:money.optional(),credit:money.optional(),debitNet:money.optional(),amount:money.optional()});
const dataSchema=z.looseObject({report:z.enum(['posted_trial_balance','posted_profit_loss','posted_balance_sheet']),from:z.iso.date().nullable().optional(),through:z.iso.date(),snapshotAt:z.string().min(1).max(100),coverage:z.string().max(100),scopeMayOmitCounterparties:z.boolean(),currencyConversion:z.literal('none'),postingBasis:z.string().max(100),chartBasis:z.string().max(100).optional(),journalPurposeTreatment:z.string().max(200).optional(),classificationBasis:z.string().max(100).optional(),labelBasis:z.string().max(100).optional(),unclassifiedLineCount:z.string().regex(/^\d+$/).optional(),requiresPurposeReview:z.boolean().optional(),accountCount:z.number().int().nonnegative(),rowCount:z.number().int().nonnegative().optional(),currencies:z.array(currency),entries:z.array(entry)});
export type FinancialExportData=z.infer<typeof dataSchema>;
function completeData(input:unknown,entryLimit=financialExportEntryLimit){const d=dataSchema.parse(input),expected=d.report==='posted_trial_balance'?d.accountCount:d.rowCount;if(expected===undefined||expected!==d.entries.length||d.entries.length>entryLimit)throw new ApiError(409,'REPORT_REQUIRES_BACKGROUND_JOB');if(d.entries.some(e=>d.report==='posted_trial_balance'?!e.closing||!e.debit||!e.credit:!e.debitNet||!e.amount))throw new Error('FINANCIAL_REPORT_MONEY_MISSING');return d;}
const blocked=/^(?:after|statementAfter|ledgerAfter)|^(?:limit|snapshot)$/i;
export function financialExportParameters(request:Request){const q=new URL(request.url).searchParams;if([...q].length!==new Set(q.keys()).size)throw new ApiError(400,'DUPLICATE_QUERY');if([...q.keys()].some(k=>blocked.test(k)))throw new ApiError(400,'EXPORT_PAGINATION_NOT_ALLOWED');return q;}
export async function completeFinancialReport(ctx:ApiContext,entryLimit=financialExportEntryLimit){
 financialExportParameters(ctx.request);await lockApprovalWrites(ctx);const reply=ctx.path==='reports/finance/trial-balance'?await financialReports(ctx,entryLimit):await financialStatements(ctx,entryLimit);if(!reply||reply.status!==200)throw new Error('FINANCIAL_REPORT_INVALID');
 const body=reply.body as {data:unknown;nextCursor:unknown};if(body.nextCursor)throw new ApiError(409,'REPORT_REQUIRES_BACKGROUND_JOB');return completeData(body.data,entryLimit);
}
export function financialReportCsv(input:unknown,provenance?:{id?:string;version?:number;retryOfJobId?:string;dateWindow?:ResolvedReportWindow&{overriddenFields?:string[]};scheduledOccurrence?:{scheduleId:string;dueAt:string;recordedAt:string}},entryLimit=financialExportEntryLimit):Reply{
 const d=completeData(input,entryLimit);
 const width=23,rows:(string|number|boolean|null|undefined)[][]=[['section','field','value','account_id','account_code','account_name','hub_id','classification','current_classification','currency_id','currency_code','unit_scale','closing_minor','closing_amount','debit_minor','debit_amount','credit_minor','credit_amount','debit_net_minor','debit_net_amount','amount_minor','amount','current_account_version']];
 const meta=(field:string,value:string|number|boolean|null|undefined)=>{if(value!==undefined)rows.push(['metadata',field,typeof value==='string'?csvText(value):value]);};
 for(const field of ['report','from','through','snapshotAt','coverage','scopeMayOmitCounterparties','currencyConversion','postingBasis','chartBasis','journalPurposeTreatment','classificationBasis','labelBasis','unclassifiedLineCount','requiresPurposeReview','accountCount','rowCount'] as const)meta(field,d[field]);
 meta('exportCompleteness','complete_permitted_report_within_limits');meta('currencyPolicy','Separate currencies; no invented exchange conversion.');meta('numericPrecisionPolicy','Money and minor units are exact CSV text. Import as text to preserve long decimals; spreadsheet auto-conversion can lose precision.');meta('textPolicy','Formula-like free text uses a visible text: prefix; original records are unchanged.');meta('blankNumericCells','Not applicable; never an invented zero.');
 if(provenance){meta('presetId',provenance.id);meta('presetVersion',provenance.version);meta('retryOfJobId',provenance.retryOfJobId);}
 if(provenance?.scheduledOccurrence){meta('scheduleId',provenance.scheduledOccurrence.scheduleId);meta('scheduledFor',provenance.scheduledOccurrence.dueAt);meta('scheduleOccurrenceRecordedAt',provenance.scheduledOccurrence.recordedAt);meta('dateWindowClockBasis','scheduled_occurrence_not_worker_restart');}
 if(provenance?.dateWindow){const w=provenance.dateWindow;meta('dateWindowKind',w.window.kind);meta('dateWindowTimeZone',w.window.timeZone);meta('dateWindowResolvedAt',w.resolvedAt);meta('dateWindowGeneratedFrom',w.from);meta('dateWindowGeneratedThrough',w.through);meta('dateWindowOverriddenFields',JSON.stringify(w.overriddenFields??[]));}
 const measures=['debit','credit','difference','income','expenses','netResult','assets','liabilities','equity','unclosedPostedResult','liabilitiesEquityAndResult'] as const;
 for(const c of d.currencies){for(const m of measures){const value=c[m];if(value){const row:(string|number|boolean|null|undefined)[]=[];Object.assign(row,{0:'currency_total',1:m,9:c.currencyId,10:csvText(c.currencyCode),11:c.unitScale,20:value.minor,21:value.amount});rows.push(row);}}if(c.balanced!==undefined)rows.push(['currency_status','balanced',c.balanced,'','','','','','',c.currencyId,csvText(c.currencyCode),c.unitScale]);}
 for(const e of d.entries)rows.push(['account',csvText(e.section??e.kind),'',e.accountId,csvText(e.code),csvText(e.name),e.hubId,e.kind,e.currentKind??e.kind,e.currencyId,csvText(e.currencyCode),e.unitScale,e.closing?.minor,e.closing?.amount,e.debit?.minor,e.debit?.amount,e.credit?.minor,e.credit?.amount,e.debitNet?.minor,e.debitNet?.amount,e.amount?.minor,e.amount?.amount,e.chartVersion]);
 const body='\uFEFF'+rows.map(row=>csvRow(Array.from({length:width},(_,i)=>row[i]))).join('\r\n')+'\r\n';if(Buffer.byteLength(body,'utf8')>financialExportByteLimit)throw new ApiError(409,'REPORT_REQUIRES_BACKGROUND_JOB');
 const report=d.report.slice('posted_'.length).replaceAll('_','-');return {status:200,body,csv:{filename:`financial-${report}-${d.from?d.from+'-':''}${d.through}.csv`}};
}
export async function financialReportExport(ctx:ApiContext):Promise<Reply|null>{
 const m=/^reports\/finance\/(trial-balance|profit-loss|balance-sheet)\/export$/.exec(ctx.path);if(!m)return null;if(ctx.request.method!=='GET')throw new ApiError(405,'METHOD_NOT_ALLOWED');financialExportParameters(ctx.request);
 const path='reports/finance/'+m[1],url=new URL(ctx.request.url);url.pathname='/api/v1/'+path;return financialReportCsv(await completeFinancialReport({...ctx,path,request:new Request(url,{method:'GET'})}));
}
export async function exportConfiguredFinancialReport(ctx:ApiContext,configuration:Parameters<typeof configuredReportContext>[1],overrides:Record<string,string>,provenance:{id:string;version:number}){
 if(!catalogueReport(configuration.reportId).csv)throw new ApiError(409,'REPORT_FORMAT_NOT_AVAILABLE');financialExportParameters(ctx.request);
 if(['finance.cash-flow','finance.cash-movements'].includes(configuration.reportId)){const {context,resolvedDateWindow}=await resolveConfiguredReportContext(ctx,configuration,overrides);return (configuration.reportId==='finance.cash-flow'?cashFlowExport:cashMovementExport)(context,{...provenance,dateWindow:resolvedDateWindow});}
 if(configuration.reportId==='payroll.scheduled-costs'){const {context,resolvedDateWindow}=await resolveConfiguredReportContext(ctx,configuration,overrides);return completePayrollForecastExport(context,{...provenance,dateWindow:resolvedDateWindow});}
 if(configuration.reportId==='payroll.recorded-time'){const {context,resolvedDateWindow}=await resolveConfiguredReportContext(ctx,configuration,overrides);return completeRecordedWorkExport(context,{...provenance,dateWindow:resolvedDateWindow});}
 if(configuration.reportId==='learning.polls.by-id'){const {context}=await resolveConfiguredReportContext(ctx,configuration,overrides);return completePollResultsExport(context,provenance);}
 if(configuration.reportId==='finance.asset-valuation'){const {context,resolvedDateWindow}=await resolveConfiguredReportContext(ctx,configuration,overrides);return completeAssetCurrencyValuationExport(context,{...provenance,dateWindow:resolvedDateWindow});}
 if(configuration.reportId==='finance.profitability'){const {context,resolvedDateWindow}=await resolveConfiguredReportContext(ctx,configuration,overrides);return completeProfitabilityExport(context,{...provenance,dateWindow:resolvedDateWindow});}
 if(configuration.reportId==='finance.collector-custody'){const {context:source,resolvedDateWindow}=await resolveConfiguredReportContext(ctx,configuration,overrides),url=new URL(source.request.url);url.searchParams.delete('limit');return completeCollectorCustodyExport({...source,request:new Request(url)},{...provenance,dateWindow:resolvedDateWindow});}
 if(configuration.reportId==='finance.counterparty-statement'){const {context:source,resolvedDateWindow}=await resolveConfiguredReportContext(ctx,configuration,overrides),url=new URL(source.request.url);url.searchParams.delete('limit');return completeCounterpartyStatementExport({...source,request:new Request(url)},{...provenance,dateWindow:resolvedDateWindow});}
 if(['finance.manual-income-costs','payroll.costs','finance.expense-costs','finance.tuition-income'].includes(configuration.reportId)){const {context,resolvedDateWindow}=await resolveConfiguredReportContext(ctx,configuration,overrides);return completeAttributionExport(context,{...provenance,dateWindow:resolvedDateWindow});}
 if(configuration.reportId==='learning.student-performance'){const {context,resolvedDateWindow}=await resolveConfiguredReportContext(ctx,configuration,overrides);return completePerformanceExport(context,{...provenance,dateWindow:resolvedDateWindow});}
 if(['learning.session-follow-up','learning.sessions.by-id.evidence'].includes(configuration.reportId)){const {context,resolvedDateWindow}=await resolveConfiguredReportContext(ctx,configuration,overrides),url=new URL(context.request.url);url.searchParams.delete('limit');return completeLearningExport({...context,request:new Request(url)},{...provenance,dateWindow:resolvedDateWindow});}
 if(configuration.reportId==='payroll.t4-working-paper'){const {context}=await resolveConfiguredReportContext(ctx,configuration,overrides);return completeT4WorkingPaperExport(context,provenance);}
 if(configuration.reportId==='payroll.t4a-working-paper'){const {context}=await resolveConfiguredReportContext(ctx,configuration,overrides);return completeT4aWorkingPaperExport(context,provenance);}
 if(configuration.reportId==='payroll.paid-tax-year-to-date'){const {context,resolvedDateWindow}=await resolveConfiguredReportContext(ctx,configuration,overrides);return completePaidTaxYtdExport(context,{...provenance,dateWindow:resolvedDateWindow});}
 const {context:source,resolvedDateWindow}=await resolveConfiguredReportContext(ctx,configuration,overrides),url=new URL(source.request.url);url.searchParams.delete('limit');const context={...source,request:new Request(url,{method:'GET'})},origin={...provenance,dateWindow:resolvedDateWindow};if(configuration.reportId==='payroll.register')return completePayrollRegisterExport(context,origin);if(configuration.reportId==='finance.bank-reconciliation')return completeBankReconciliationExport(context,origin);if(['finance.receivables-aging','finance.payables-aging'].includes(configuration.reportId))return completeAgingExport(context,origin);if(configuration.reportId==='inventory.stock')return completeInventoryExport(context,origin);if(configuration.reportId==='payroll.remittances')return completePayrollRemittanceExport(context,origin);if(configuration.reportId==='finance.outlook')return completeFinancialOutlookExport(context,origin);if(configuration.reportId==='community.achievements')return completeAchievementExport(context,origin);if(configuration.reportId==='payroll.gross-accruals')return completePayrollGrossExport(context,origin);if(configuration.reportId==='payroll.settlements')return completePayrollSettlementExport(context,origin);return financialReportCsv(await completeFinancialReport(context),origin);
}
export const financialReportExportContract=[financialReportsContract[0],...financialStatementsContract].map(c=>({path:c.path+'/export',method:'get' as const,summary:'Complete same-source-snapshot financial CSV with original intersected source rights,exact currency totals,classification/review/coverage warnings and formula-safe text; no cursors or page limit;2,000entries/4MiB ceiling refuses larger results rather than truncating',querySchema:(c.querySchema as z.ZodObject).safeExtend({limit:z.never().optional(),afterKind:z.never().optional(),afterCode:z.never().optional(),afterId:z.never().optional()}),responseContentType:'text/csv' as const}));
