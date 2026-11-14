import { z } from 'zod';
import { providerCostAuthorization,requireProviderCostResultAccess } from './provider-cost-report.ts';
import type { ApiContext } from '../core/api.ts';
import { attributionAuthorization,attributionReportScopes,requireAttributionResultAccess } from './financial-attribution-access.ts';
import { payrollCostAuthorization,payrollCostScopes,requirePayrollCostResultAccess } from './payroll-cost-report.ts';
import { financialReportAccess,requireFinancialReportResultAccess } from './financial-reports.ts';

export const profitabilityAuthorization=z.object({kind:z.literal('academy_profitability'),basis:z.enum(['recorded','reviewed']),ledger:z.object({hubIds:z.array(z.string().uuid().transform(s=>s.toLowerCase())).max(10000).refine(ids=>new Set(ids).size===ids.length),includesGlobal:z.boolean()}).strict(),tuition:attributionAuthorization.refine(p=>p.kind==='tuition_attribution'),supplier:attributionAuthorization.refine(p=>p.kind==='expense_attribution'||p.kind==='allocated_expense_attribution'),payroll:payrollCostAuthorization,manual:attributionAuthorization.refine(p=>p.kind==='manual_journal_attribution'),provider:providerCostAuthorization.optional()}).strict().refine(p=>p.manual.kind==='manual_journal_attribution'&&p.manual.basis===p.basis&&p.payroll.kind===(p.basis==='reviewed'?'allocated_payroll_cost':'payroll_cost')&&p.supplier.kind===(p.basis==='reviewed'?'allocated_expense_attribution':'expense_attribution')).refine(p=>Buffer.byteLength(JSON.stringify(p))<=4_194_304);
export function profitabilityReportScopes(ctx:ApiContext){financialReportAccess(ctx);payrollCostScopes(ctx);for(const id of ['finance.tuition-income','finance.expense-costs','finance.manual-income-costs'])attributionReportScopes(ctx,id);}
export async function requireProfitabilityResultAccess(ctx:ApiContext,raw:unknown){
 const p=profitabilityAuthorization.parse(raw);profitabilityReportScopes(ctx);requireFinancialReportResultAccess(ctx,p.ledger);
 // The baseline,unassigned charts and reconciliation cover sources OUTSIDE
 // selected learners. Every captured original and exact revision still needs
 // authorization before retained bytes or even their hash/size are returned.
 await requireAttributionResultAccess(ctx,p.tuition);await requireAttributionResultAccess(ctx,p.supplier);await requirePayrollCostResultAccess(ctx,p.payroll);await requireAttributionResultAccess(ctx,p.manual);if(p.provider)await requireProviderCostResultAccess(ctx,p.provider);
}
