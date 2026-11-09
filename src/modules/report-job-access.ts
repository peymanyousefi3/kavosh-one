import { payrollCostScopes } from './payroll-cost-report.ts';
import type { ApiContext } from '../core/api.ts';
import { ApiError } from '../core/policy.ts';
import { financialReportAccess } from './financial-reports.ts';
import { achievementReportScopes } from './achievement-report-access.ts';
import { payrollReportScopes } from './payroll-report-access.ts';
import { payrollSettlementScopes } from './payroll-settlement-report.ts';
import { payrollRemittanceScopes } from './payroll-remittance-report.ts';
import { isPaidTaxReport,paidTaxYearJobScope,paidTaxYearConfigurationAccess } from './paid-tax-report-access.ts';
import { performanceReportScope } from './student-performance-access.ts';
import { attributionReportIds,attributionReportScopes } from './financial-attribution-access.ts';

export const financialJobReports=['finance.trial-balance','finance.profit-loss','finance.balance-sheet'] as const;
export function reportJobAccess(ctx:ApiContext,reportId:string){if(reportId==='payroll.costs')payrollCostScopes(ctx);else if(attributionReportIds.some(id=>id===reportId))attributionReportScopes(ctx,reportId);else if(reportId==='learning.student-performance')performanceReportScope(ctx);else if(isPaidTaxReport(reportId))paidTaxYearJobScope(ctx);else if(reportId==='community.achievements')achievementReportScopes(ctx);else if(reportId==='payroll.gross-accruals')payrollReportScopes(ctx);else if(reportId==='payroll.remittances')payrollRemittanceScopes(ctx);else if(reportId==='payroll.settlements')payrollSettlementScopes(ctx);else if(financialJobReports.some(id=>id===reportId))financialReportAccess(ctx);else throw new ApiError(409,'REPORT_FORMAT_NOT_AVAILABLE');}
export async function reportPresetJobAccess(ctx:ApiContext,id:string,version:number){const r=(await ctx.db.query<{report:string;parameters:Record<string,string>}>("SELECT definition->>'reportId' report,definition->'parameters' parameters FROM public.report_preset_revisions WHERE preset_id=$1 AND version=$2",[id,version])).rows[0];if(!r)throw new ApiError(404,'NOT_FOUND');reportJobAccess(ctx,r.report);await paidTaxYearConfigurationAccess(ctx,{reportId:r.report,parameters:r.parameters});}
export function permittedJobReportIds(ctx:ApiContext){const ids:string[]=[];for(const report of ['payroll.costs',...attributionReportIds,financialJobReports[0],'learning.student-performance','payroll.gross-accruals','community.achievements','payroll.settlements','payroll.remittances','payroll.paid-tax-year-to-date','payroll.t4-working-paper'])try{reportJobAccess(ctx,report);ids.push(...(report===financialJobReports[0]?financialJobReports:[report]));}catch(error){if(!(error instanceof ApiError)||error.status!==403)throw error;}if(!ids.length)throw new ApiError(403,'FORBIDDEN');return ids;}
