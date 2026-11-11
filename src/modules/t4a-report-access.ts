import { z } from 'zod';
import type { ApiContext } from '../core/api.ts';
import { permissionScope } from '../core/approvals.ts';
import { ApiError,scopeNonempty } from '../core/policy.ts';
import { requirePayrollEmployerView } from './payroll-employers.ts';
import { requireT4aWorkerAccess } from './t4a-payment-records.ts';
import { payrollSettlementScopes,requirePayrollSettlementResultAccess } from './payroll-settlement-report.ts';

const uuid=z.string().uuid().transform(v=>v.toLowerCase());
export const t4aReportAuthorization=z.object({kind:z.literal('t4a_tax_year'),personId:uuid,employerId:uuid,taxYear:z.number().int().min(1900).max(9999),timeZone:z.string().min(1).max(100).regex(/^[A-Za-z0-9_+./-]+$/),postingIds:z.array(uuid).max(500).refine(v=>new Set(v).size===v.length)}).strict();
export function t4aReportJobScope(ctx:ApiContext){
 try{requirePayrollEmployerView(ctx);}catch(e){if(e instanceof ApiError&&[403,404].includes(e.status))throw new ApiError(403,'FORBIDDEN');throw e;}
 const s=permissionScope(ctx,'payroll-tax.view');if(!ctx.credential.all_hubs||!scopeNonempty(s))throw new ApiError(403,'FORBIDDEN');payrollSettlementScopes(ctx);return s;
}
export async function t4aReportConfigurationAccess(ctx:ApiContext,parameters:Record<string,string>){
 const person=uuid.parse(parameters.personId),employer=uuid.parse(parameters.employerId);await requireT4aWorkerAccess(ctx,person);
 if(!(await ctx.db.query('SELECT 1 FROM public.people p CROSS JOIN public.financial_payees e WHERE p.id=$1 AND p.kind=\'human\' AND e.id=$2 AND e.kind=\'academy\'',[person,employer])).rows.length)throw new ApiError(404,'NOT_FOUND');
}
export async function requireT4aReportResultAccess(ctx:ApiContext,raw:unknown){const p=t4aReportAuthorization.parse(raw);await requireT4aWorkerAccess(ctx,p.personId);await ctx.db.query('SELECT public.lock_hourly_worker($1)',[p.personId]);await requirePayrollSettlementResultAccess(ctx,{kind:'payroll_settlement',postingIds:p.postingIds});}
