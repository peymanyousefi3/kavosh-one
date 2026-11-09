import { z } from 'zod';
import type { ApiContext } from '../core/api.ts';
import { permissionScope } from '../core/approvals.ts';
import { ApiError,scopeNonempty } from '../core/policy.ts';

const uuid=z.string().uuid().transform(v=>v.toLowerCase()),ids=z.array(uuid).max(10000).refine(a=>new Set(a).size===a.length);
export const attributionAuthorization=z.discriminatedUnion('kind',[
 z.object({kind:z.literal('tuition_attribution'),invoices:ids,recognitions:ids}).strict().refine(p=>!p.recognitions.length||p.invoices.length>0),
 z.object({kind:z.literal('expense_attribution'),bills:ids}).strict(),
 z.object({kind:z.literal('allocated_expense_attribution'),bills:ids,allocations:z.array(z.object({billId:uuid,version:z.number().int().positive().max(2147483647)}).strict()).max(10000)}).strict().refine(p=>{const bills=new Set(p.bills);return new Set(p.allocations.map(a=>a.billId)).size===p.allocations.length&&p.allocations.every(a=>bills.has(a.billId));})
]);
export const attributionReportIds=['finance.tuition-income','finance.expense-costs'] as const;
export function attributionReportScopes(ctx:ApiContext,id:string){
 const caps=id==='finance.tuition-income'?['invoices.view','financial-reports.view','accounts.view','ledger.view'] as const:id==='finance.expense-costs'?['expenses.view','financial-reports.view','accounts.view','ledger.view'] as const:null;
 if(!caps)throw new ApiError(409,'REPORT_FORMAT_NOT_AVAILABLE');const scopes=caps.map(c=>permissionScope(ctx,c));if(scopes.some(s=>!scopeNonempty(s)))throw new ApiError(403,'FORBIDDEN');return scopes;
}
// Trusted SQL aliases/parameter expressions only. The same predicates select
// original report sources and reauthorize retained files;no caller SQL.
const hub=(field:string)=>`jsonb_build_object('all',${field} IS NULL,'hubs',CASE WHEN ${field} IS NULL THEN '[]'::jsonb ELSE jsonb_build_array(${field}) END)`;
const tuitionTarget=`jsonb_build_object('all',false,'hubs','[]'::jsonb,'classes',jsonb_build_array(jsonb_build_object('id',i.class_id,'hubId',i.hub_id)),'people',jsonb_build_array(jsonb_build_object('id',i.student_id,'hubId',i.hub_id)),'recordContext',jsonb_build_object('classId',i.class_id,'hubId',i.hub_id,'studentId',i.student_id))`;
export const tuitionInvoiceSelectionSQL=(ownerScopes:string,accountScopes:string)=>`NOT EXISTS(SELECT 1 FROM jsonb_array_elements(${ownerScopes}) s WHERE public.scope_contains(s,${tuitionTarget}) IS NOT TRUE)
 AND NOT EXISTS(SELECT 1 FROM unnest(ARRAY[i.receivable_account,i.consideration_account,i.tax_account]) pick(id) LEFT JOIN public.finance_accounts a ON a.academy_id=i.academy_id AND a.id=pick.id CROSS JOIN jsonb_array_elements(${accountScopes}) s WHERE pick.id IS NOT NULL AND(a.id IS NULL OR public.scope_contains(s,${hub('a.hub_id')}) IS NOT TRUE))`;
export const tuitionRecognitionSelectionSQL=(accountScopes:string)=>`NOT EXISTS(SELECT 1 FROM unnest(ARRAY[rel.deferred_account,rel.revenue_account]) pick(id) LEFT JOIN public.finance_accounts a ON a.academy_id=rel.academy_id AND a.id=pick.id CROSS JOIN jsonb_array_elements(${accountScopes}) s WHERE a.id IS NULL OR public.scope_contains(s,${hub('a.hub_id')}) IS NOT TRUE)`;
export const expenseBillSelectionSQL=(ownerScopes:string,accountScopes:string)=>`NOT EXISTS(SELECT 1 FROM public.expense_bill_lines l CROSS JOIN jsonb_array_elements(${ownerScopes}) s WHERE l.academy_id=b.academy_id AND l.bill_id=b.id AND public.scope_contains(s,${hub('l.hub_id')}) IS NOT TRUE)
 AND NOT EXISTS(SELECT 1 FROM public.finance_journal_lines jl LEFT JOIN public.finance_accounts a ON a.academy_id=jl.academy_id AND a.id=jl.account_id CROSS JOIN jsonb_array_elements(${accountScopes}) s WHERE jl.academy_id=b.academy_id AND jl.journal_id=b.id AND(a.id IS NULL OR public.scope_contains(s,${hub('a.hub_id')}) IS NOT TRUE))`;

// Entire pinned revision,not only filtered/exported targets. Resolve student
// permissions against their CURRENT person hub,not the analytical cost hub.
export const expenseAllocationSelectionSQL=(snapshot:string,ownerScopes:string,classScope:string,studentScope:string)=>`NOT EXISTS(
 SELECT 1 FROM jsonb_array_elements(${snapshot}->'lines') line CROSS JOIN LATERAL jsonb_array_elements(line->'targets') target
 LEFT JOIN public.classes cl ON cl.academy_id=b.academy_id AND cl.id=(target->>'classId')::uuid
 LEFT JOIN public.people person ON person.academy_id=b.academy_id AND person.id=(target->>'studentId')::uuid
 WHERE EXISTS(SELECT 1 FROM jsonb_array_elements(${ownerScopes}) scope(value) WHERE public.scope_contains(scope.value,${hub("(target->>'hubId')::uuid")}) IS NOT TRUE)
 OR(target->>'classId' IS NOT NULL AND(cl.id IS NULL OR cl.hub_id IS DISTINCT FROM(target->>'hubId')::uuid OR public.scope_contains(${classScope},jsonb_build_object('all',false,'hubs','[]'::jsonb,'classes',jsonb_build_array(jsonb_build_object('id',cl.id,'hubId',cl.hub_id)))) IS NOT TRUE))
 OR(target->>'studentId' IS NOT NULL AND(person.id IS NULL OR public.scope_contains(${studentScope},jsonb_build_object('all',false,'hubs','[]'::jsonb,'people',jsonb_build_array(jsonb_build_object('id',person.id,'hubId',person.hub_id)))) IS NOT TRUE)))`;

// A saved file is not a newly filtered live report. Every captured immutable
// source must still be authorized BEFORE its bytes or hash metadata is read.
// The caller holds the existing policy/topology gates,as other report proofs do.
export async function requireAttributionResultAccess(ctx:ApiContext,raw:unknown){
 const p=attributionAuthorization.parse(raw),scopes=attributionReportScopes(ctx,p.kind==='tuition_attribution'?'finance.tuition-income':'finance.expense-costs'),owners=JSON.stringify(scopes.slice(0,2)),accounts=JSON.stringify(scopes.slice(1));
 const ok=p.kind==='tuition_attribution'?(await ctx.db.query<{ok:boolean}>(`SELECT
  NOT EXISTS(SELECT 1 FROM unnest($1::uuid[]) wanted(id) WHERE NOT EXISTS(SELECT 1 FROM public.tuition_invoices i WHERE i.id=wanted.id AND($5::boolean OR i.hub_id=ANY($6::uuid[])) AND ${tuitionInvoiceSelectionSQL('$3::jsonb','$4::jsonb')}))
  AND NOT EXISTS(SELECT 1 FROM unnest($2::uuid[]) wanted(id) WHERE NOT EXISTS(SELECT 1 FROM public.tuition_recognitions rel WHERE rel.id=wanted.id AND rel.invoice_id=ANY($1::uuid[]) AND ${tuitionRecognitionSelectionSQL('$4::jsonb')})) ok`,[p.invoices,p.recognitions,owners,accounts,ctx.credential.all_hubs,ctx.credential.hub_ids])).rows[0].ok:
  (await ctx.db.query<{ok:boolean}>(`SELECT NOT EXISTS(SELECT 1 FROM unnest($1::uuid[]) wanted(id) WHERE NOT EXISTS(SELECT 1 FROM public.expense_bills b WHERE b.id=wanted.id AND ${expenseBillSelectionSQL('$2::jsonb','$3::jsonb')})) ok`,[p.bills,owners,accounts])).rows[0].ok;
 if(!ok)throw new ApiError(403,'REPORT_SOURCE_ACCESS_CHANGED');
 if(p.kind==='allocated_expense_attribution'){
  const allowed=(await ctx.db.query<{ok:boolean}>(`SELECT NOT EXISTS(SELECT 1 FROM jsonb_to_recordset($1::jsonb) wanted("billId" uuid,version integer) WHERE NOT EXISTS(
   SELECT 1 FROM public.expense_bills b JOIN public.expense_cost_allocation_revisions ar ON ar.academy_id=b.academy_id AND ar.bill_id=b.id AND ar.version=wanted.version
   WHERE b.id=wanted."billId" AND ${expenseAllocationSelectionSQL('ar.source_snapshot','$2::jsonb','$3::jsonb','$4::jsonb')})) ok`,[JSON.stringify(p.allocations),owners,JSON.stringify(permissionScope(ctx,'classes.view')),JSON.stringify(permissionScope(ctx,'students.view'))])).rows[0].ok;
  if(!allowed)throw new ApiError(403,'REPORT_SOURCE_ACCESS_CHANGED');
 }
}
