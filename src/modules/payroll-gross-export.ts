import { z } from 'zod';
import type { ApiContext,Reply } from '../core/api.ts';
import { ApiError } from '../core/policy.ts';
import { csvText,csvRow } from '../core/csv.ts';
import { payrollGrossReport,payrollGrossReportContract } from './payroll-gross-report.ts';
import type { ResolvedReportWindow } from '../core/report-window.ts';

// ponytail: bounded synchronous export; queue support must retain payroll's
// person/whole-worker authority,not borrow the account-only financial manifest.
export const payrollGrossExportLimit=2000,payrollGrossExportBytes=4_194_304;
type GrossData={report:string;on:string;snapshotAt:string;allocationCount:number;sourceCount:number;filters:unknown;coverage:string;effectiveDateBasis:string;allocationBasis:string;geographyBasis:string;systemKnowledgeAsOf:boolean;permissionsAppliedBeforeAggregation:boolean;currencyConversion:string;paymentStatusKnown:boolean;unpaidBalancesCalculated:boolean;netPayCalculated:boolean;statutoryDeductionsCalculated:boolean;cashFlowForecast:boolean;additionalLedgerPosting:boolean;moneyMovementPerformed:boolean;
 currencies:{currencyId:string;currencyCode:string;unitScale:number;sourceCount:number;legacyDateReviewSources:number;allocationCount:number;recordedGross:{minor:string;amount:string};pastConfiguredDueGross:{minor:string;amount:string}}[];
 chartData:{hubId:string|null;kind:string;currencyId:string;currencyCode:string;unitScale:number;allocationCount:number;recordedGross:{minor:string;amount:string}}[];
 entries:{kind:string;sourceId:string;allocationId:string;personId:string;hubId:string|null;currencyId:string;currencyCode:string;unitScale:number;postedOn:string;dueOn:string;daysPastConfiguredDue:number;legacyDateReviewRequired:boolean;recordedGross:{minor:string;amount:string}}[]};
export function payrollGrossCsv(d:GrossData,provenance?:{id:string;version:number;dateWindow?:ResolvedReportWindow&{overriddenFields?:string[]}}):Reply{
 if(d.allocationCount!==d.entries.length||d.entries.length>payrollGrossExportLimit)throw new ApiError(409,'REPORT_REQUIRES_BACKGROUND_JOB');
 const rows:(string|number|boolean|null|undefined)[][]=[['section','field','value','kind','source_id','allocation_id','person_id','hub_id','currency_id','currency_code','unit_scale','gross_minor','gross_amount','past_configured_due_minor','past_configured_due_amount','posted_on','configured_due_on','days_past_configured_due','legacy_date_review_required','allocation_count','source_count','legacy_date_review_sources']];
 const meta=(k:string,v:string|number|boolean)=>rows.push(['metadata',k,typeof v==='string'?csvText(v):v]);
 for(const k of ['report','on','snapshotAt','allocationCount','sourceCount','coverage','effectiveDateBasis','allocationBasis','geographyBasis','systemKnowledgeAsOf','permissionsAppliedBeforeAggregation','currencyConversion','paymentStatusKnown','unpaidBalancesCalculated','netPayCalculated','statutoryDeductionsCalculated','cashFlowForecast','additionalLedgerPosting','moneyMovementPerformed'] as const)meta(k,d[k]);
 meta('filters',JSON.stringify(d.filters));meta('exportCompleteness','complete_permitted_report_within_limits');meta('numericPrecisionPolicy','Money and minor units are exact CSV text; import as text to avoid spreadsheet precision loss.');meta('pastDuePolicy','Configured due dates do not establish unpaid balances. This is not a net paystub or payment approval.');meta('textPolicy','Formula-like free text uses a visible text: prefix; stored records are unchanged.');
 if(provenance){meta('presetId',provenance.id);meta('presetVersion',provenance.version);if(provenance.dateWindow){meta('dateWindowKind',provenance.dateWindow.window.kind);meta('dateWindowTimeZone',provenance.dateWindow.window.timeZone);meta('dateWindowResolvedAt',provenance.dateWindow.resolvedAt);meta('dateWindowOverriddenFields',JSON.stringify(provenance.dateWindow.overriddenFields??[]));}}
 for(const c of d.currencies)rows.push(['currency_total','','','','','','','',c.currencyId,csvText(c.currencyCode),c.unitScale,c.recordedGross.minor,c.recordedGross.amount,c.pastConfiguredDueGross.minor,c.pastConfiguredDueGross.amount,'','','','',c.allocationCount,c.sourceCount,c.legacyDateReviewSources]);
 for(const c of d.chartData)rows.push(['chart','','',c.kind,'','','',c.hubId,c.currencyId,csvText(c.currencyCode),c.unitScale,c.recordedGross.minor,c.recordedGross.amount,'','','','','','',c.allocationCount]);
 for(const e of d.entries)rows.push(['earning','','',e.kind,e.sourceId,e.allocationId,e.personId,e.hubId,e.currencyId,csvText(e.currencyCode),e.unitScale,e.recordedGross.minor,e.recordedGross.amount,'','',e.postedOn,e.dueOn,e.daysPastConfiguredDue,e.legacyDateReviewRequired]);
 const body='\uFEFF'+rows.map(r=>csvRow(Array.from({length:22},(_,i)=>r[i]))).join('\r\n')+'\r\n';if(Buffer.byteLength(body)>payrollGrossExportBytes)throw new ApiError(409,'REPORT_REQUIRES_BACKGROUND_JOB');return {status:200,body,csv:{filename:`payroll-gross-accruals-${d.on}.csv`}};
}
export async function completePayrollGrossExport(ctx:ApiContext,provenance?:Parameters<typeof payrollGrossCsv>[1]){
 const params=new URL(ctx.request.url).searchParams;if([...params].length!==new Set(params.keys()).size)throw new ApiError(400,'DUPLICATE_QUERY');if([...params.keys()].some(k=>k==='limit'||k.startsWith('after')))throw new ApiError(400,'EXPORT_PAGINATION_NOT_ALLOWED');
 const reply=await payrollGrossReport(ctx,payrollGrossExportLimit);if(!reply||reply.status!==200)throw new Error('PAYROLL_REPORT_INVALID');const r=reply.body as {data:GrossData;nextCursor:unknown};if(r.nextCursor)throw new ApiError(409,'REPORT_REQUIRES_BACKGROUND_JOB');return payrollGrossCsv(r.data,provenance);
}
export async function payrollGrossExport(ctx:ApiContext):Promise<Reply|null>{
 if(ctx.path!=='reports/payroll/gross-accruals/export')return null;if(ctx.request.method!=='GET')throw new ApiError(405,'METHOD_NOT_ALLOWED');const url=new URL(ctx.request.url);url.pathname='/api/v1/reports/payroll/gross-accruals';return completePayrollGrossExport({...ctx,path:'reports/payroll/gross-accruals',request:new Request(url)});
}
export const payrollGrossExportContract=[{path:'/api/v1/reports/payroll/gross-accruals/export',method:'get',summary:'Complete same-snapshot permitted gross-earning CSV with exact currency totals,chart series,all selected allocations,source-review warnings and all original worker/hub/geography rights. No cursor/page limit;2,000allocations/4MiB ceiling rejects partial files. Not net pay,paystub,unpaid balance,withholding or payment approval.',querySchema:(payrollGrossReportContract[0].querySchema as z.ZodObject).safeExtend({limit:z.never().optional(),afterKind:z.never().optional(),afterId:z.never().optional(),afterAllocationId:z.never().optional()}),responseContentType:'text/csv' as const}] as const;
