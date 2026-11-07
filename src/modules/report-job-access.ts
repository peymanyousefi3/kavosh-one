import type { ApiContext } from '../core/api.ts';
import { ApiError } from '../core/policy.ts';
import { financialReportAccess } from './financial-reports.ts';
import { payrollReportScopes } from './payroll-report-access.ts';

export const financialJobReports=['finance.trial-balance','finance.profit-loss','finance.balance-sheet'] as const;
export function reportJobAccess(ctx:ApiContext,reportId:string){if(reportId==='payroll.gross-accruals')payrollReportScopes(ctx);else financialReportAccess(ctx);}
export async function reportPresetJobAccess(ctx:ApiContext,id:string,version:number){const r=(await ctx.db.query<{report:string}>("SELECT definition->>'reportId' report FROM public.report_preset_revisions WHERE preset_id=$1 AND version=$2",[id,version])).rows[0];if(!r)throw new ApiError(404,'NOT_FOUND');reportJobAccess(ctx,r.report);}
export function permittedJobReportIds(ctx:ApiContext){const ids:string[]=[];for(const report of [financialJobReports[0],'payroll.gross-accruals'])try{reportJobAccess(ctx,report);ids.push(...(report==='payroll.gross-accruals'?[report]:financialJobReports));}catch(error){if(!(error instanceof ApiError)||error.status!==403)throw error;}if(!ids.length)throw new ApiError(403,'FORBIDDEN');return ids;}
