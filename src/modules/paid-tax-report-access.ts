import { z } from 'zod';
import type { ApiContext } from '../core/api.ts';
import { permissionScope } from '../core/approvals.ts';
import { ApiError,scopeNonempty } from '../core/policy.ts';
import { authorizedPayrollTaxProfile } from './payroll-tax-profiles.ts';
import { payrollSettlementAuthorization,payrollSettlementScopes,requirePayrollSettlementResultAccess } from './payroll-settlement-report.ts';
import { t4aReportConfigurationAccess } from './t4a-report-access.ts';
import { consolidatedT4aConfigurationAccess } from './t4a-consolidated-working-paper.ts';
import { supplierTaxReportConfigurationAccess } from './supplier-tax-working-paper.ts';

const uuid=z.string().uuid().transform(v=>v.toLowerCase());
export function isPaidTaxReport(id:string){return id==='payroll.paid-tax-year-to-date'||id==='payroll.t4-working-paper';}
export const paidTaxYearAuthorization=z.object({kind:z.literal('paid_tax_year'),profileId:uuid,postingIds:payrollSettlementAuthorization.shape.postingIds.max(500)}).strict();
export function paidTaxYearJobScope(ctx:ApiContext){const s=permissionScope(ctx,'payroll-tax.view');if(!ctx.credential.all_hubs||!scopeNonempty(s))throw new ApiError(403,'FORBIDDEN');payrollSettlementScopes(ctx);return s;}
export async function paidTaxYearConfigurationAccess(ctx:ApiContext,configuration:{reportId:string;parameters:Record<string,string>}){if(configuration.reportId==='payroll.t4a-consolidated-working-paper')return consolidatedT4aConfigurationAccess(ctx,configuration.parameters);if(configuration.reportId==='finance.supplier-t4a-working-paper')return void await supplierTaxReportConfigurationAccess(ctx,configuration.parameters);if(configuration.reportId==='payroll.t4a-working-paper')return t4aReportConfigurationAccess(ctx,configuration.parameters);if(isPaidTaxReport(configuration.reportId)){const h=await authorizedPayrollTaxProfile(ctx,uuid.parse(configuration.parameters.profileId));if(configuration.reportId==='payroll.t4-working-paper'&&h.tax_year!==2026)throw new ApiError(409,'T4_WORKING_PAPER_YEAR_UNSUPPORTED');if(configuration.parameters.through!==undefined&&!configuration.parameters.through.startsWith(h.tax_year+'-'))throw new ApiError(400,'PAID_TAX_YTD_YEAR_MISMATCH');}}
export async function requirePaidTaxYearResultAccess(ctx:ApiContext,raw:unknown){const p=paidTaxYearAuthorization.parse(raw),h=await authorizedPayrollTaxProfile(ctx,p.profileId);await ctx.db.query('SELECT public.lock_hourly_worker($1)',[h.person_id]);await requirePayrollSettlementResultAccess(ctx,{kind:'payroll_settlement',postingIds:p.postingIds});}
