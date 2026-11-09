import { z } from 'zod';
import type { ApiContext,Reply } from '../core/api.ts';
import { ApiError } from '../core/policy.ts';
import { exactReportMoney as exact } from '../core/aging.ts';
import { accountingDate } from './finance-periods.ts';
import { financialIds } from './financial-reports.ts';
import { lockAcademyTopology } from './academy.ts';
import { attributionAuthorization,attributionReportScopes,expenseBillSelectionSQL } from './financial-attribution-access.ts';

export const expenseCostQuery=z.object({from:accountingDate,through:accountingDate,hubIds:financialIds.optional(),classIds:financialIds.optional(),studentIds:financialIds.optional(),accountIds:financialIds.optional(),payeeIds:financialIds.optional(),currencyIds:financialIds.optional(),countryIds:financialIds.optional(),regionIds:financialIds.optional(),cityIds:financialIds.optional()}).strict().refine(q=>q.from<=q.through);
const dimensions=['hub','class','student','account','payee','month','event'] as const;
const measures=['net','tax','recoverableTax','nonRecoverableTax','expense','gross'] as const;
type Raw={key:string|null;currencyId:string;currencyCode:string;unitScale:number;costLineEvents:number;net:string;tax:string;recoverableTax:string;nonRecoverableTax:string;expense:string;gross:string};
// ponytail:10,000 posting/reversal events,100,000 cost-line events,10,000
// groups/dimension/4MiB. Larger reports need chunked aggregation,not a page sum.
export function assertExpenseCostBounds(events:number,lines:number,groups:number[],bytes=0){if([events,lines,...groups,bytes].some(v=>!Number.isSafeInteger(v)||v<0))throw new Error('EXPENSE_COST_REPORT_COUNTS_INVALID');if(events>10000||lines>100000||groups.some(n=>n>10000)||bytes>4_194_304)throw new ApiError(422,'EXPENSE_COST_REPORT_REQUIRES_BACKGROUND_JOB');}
const sql=`WITH permitted AS MATERIALIZED(
 SELECT b.*,c.code currency_code,e.id event_id,e.posted_on event_on,e.kind,e.sign
 FROM public.expense_bills b JOIN public.finance_currencies c ON c.academy_id=b.academy_id AND c.id=b.currency_id
 JOIN public.finance_journals j ON j.academy_id=b.academy_id AND j.id=b.id
 LEFT JOIN public.finance_journals v ON v.academy_id=b.academy_id AND v.id=b.void_id
 CROSS JOIN LATERAL(VALUES(j.id,j.posted_on,'posting'::text,1),(v.id,v.posted_on,'reversal'::text,-1)) e(id,posted_on,kind,sign)
 WHERE e.id IS NOT NULL AND e.posted_on BETWEEN $1::date AND $2::date AND($8::uuid[] IS NULL OR b.payee_id=ANY($8)) AND($9::uuid[] IS NULL OR b.currency_id=ANY($9))
 AND ${expenseBillSelectionSQL('$3::jsonb','$4::jsonb')}
 AND EXISTS(SELECT 1 FROM public.expense_bill_lines l LEFT JOIN public.hubs h ON h.academy_id=l.academy_id AND h.id=l.hub_id LEFT JOIN public.cities ci ON ci.academy_id=h.academy_id AND ci.id=h.city_id LEFT JOIN public.regions r ON r.academy_id=ci.academy_id AND r.id=ci.region_id
 WHERE l.academy_id=b.academy_id AND l.bill_id=b.id AND($5::uuid[] IS NULL OR l.hub_id=ANY($5)) AND($6::uuid[] IS NULL OR l.class_id=ANY($6)) AND($7::uuid[] IS NULL OR l.student_id=ANY($7)) AND($10::uuid[] IS NULL OR l.expense_account=ANY($10)) AND($11::uuid[] IS NULL OR r.country_id=ANY($11)) AND($12::uuid[] IS NULL OR r.id=ANY($12)) AND($13::uuid[] IS NULL OR ci.id=ANY($13)))
 LIMIT 10001
),event_bound AS(SELECT count(*)::integer events FROM permitted),selected AS MATERIALIZED(
 SELECT p.*,l.line_number,l.hub_id,l.class_id,l.student_id,l.expense_account,l.net_minor*p.sign net,l.tax_minor*p.sign tax,l.recoverable_minor*p.sign recoverable,l.gross_minor*p.sign gross
 FROM permitted p JOIN public.expense_bill_lines l ON l.academy_id=p.academy_id AND l.bill_id=p.id
 LEFT JOIN public.hubs h ON h.academy_id=l.academy_id AND h.id=l.hub_id LEFT JOIN public.cities ci ON ci.academy_id=h.academy_id AND ci.id=h.city_id LEFT JOIN public.regions r ON r.academy_id=ci.academy_id AND r.id=ci.region_id
 WHERE(SELECT events FROM event_bound)<=10000 AND($5::uuid[] IS NULL OR l.hub_id=ANY($5)) AND($6::uuid[] IS NULL OR l.class_id=ANY($6)) AND($7::uuid[] IS NULL OR l.student_id=ANY($7)) AND($10::uuid[] IS NULL OR l.expense_account=ANY($10)) AND($11::uuid[] IS NULL OR r.country_id=ANY($11)) AND($12::uuid[] IS NULL OR r.id=ANY($12)) AND($13::uuid[] IS NULL OR ci.id=ANY($13)) LIMIT 100001
),normalized AS MATERIALIZED(
 SELECT s.*,max(unit_scale) OVER(PARTITION BY currency_id) scale FROM selected s WHERE(SELECT count(*) FROM selected)<=100000
),weighted AS MATERIALIZED(SELECT n.*,('1'||repeat('0',scale-unit_scale))::numeric factor FROM normalized n),expanded AS(
 SELECT w.*,d.dimension,d.key FROM weighted w CROSS JOIN LATERAL(VALUES('total',NULL::text),('hub',hub_id::text),('class',class_id::text),('student',student_id::text),('account',expense_account::text),('payee',payee_id::text),('month',to_char(event_on,'YYYY-MM')),('event',kind)) d(dimension,key)
),groups AS(
 SELECT dimension,key,currency_id AS "currencyId",currency_code AS "currencyCode",scale AS "unitScale",count(*)::integer "costLineEvents",sum(net*factor)::text net,sum(tax*factor)::text tax,sum(recoverable*factor)::text "recoverableTax",sum((tax-recoverable)*factor)::text "nonRecoverableTax",sum((net+tax-recoverable)*factor)::text expense,sum(gross*factor)::text gross
 FROM expanded GROUP BY dimension,key,currency_id,currency_code,scale
),ranked AS(SELECT *,row_number() OVER(PARTITION BY dimension ORDER BY "currencyId",key NULLS FIRST) n FROM groups)
 SELECT to_char(statement_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') "snapshotAt",(SELECT events FROM event_bound) events,(SELECT count(*)::integer FROM selected) lines,
 CASE WHEN $14::boolean THEN jsonb_build_object('kind','expense_attribution','bills',coalesce((SELECT jsonb_agg(id ORDER BY id) FROM(SELECT DISTINCT id FROM selected) sources),'[]'::jsonb)) END "authorizationContext",
 coalesce((SELECT jsonb_object_agg(dimension,items) FROM(SELECT dimension,jsonb_agg(to_jsonb(r)-ARRAY['dimension','n'] ORDER BY "currencyId",key NULLS FIRST) items FROM ranked r WHERE n<=10001 GROUP BY dimension) x),'{}'::jsonb) series`;
export async function expenseCostReport(ctx:ApiContext,includeAuthorization=false):Promise<Reply|null>{
 if(ctx.path!=='reports/finance/expense-costs')return null;if(ctx.request.method!=='GET')throw new ApiError(405,'METHOD_NOT_ALLOWED');const p=new URL(ctx.request.url).searchParams;if([...p].length!==new Set(p.keys()).size)throw new ApiError(400,'DUPLICATE_QUERY');const q=expenseCostQuery.parse(Object.fromEntries(p));await lockAcademyTopology(ctx);
 const scopes=attributionReportScopes(ctx,'finance.expense-costs');
 const r=(await ctx.db.query<{snapshotAt:string;events:number;lines:number;series:Record<string,Raw[]>;authorizationContext:unknown}>(sql,[q.from,q.through,JSON.stringify(scopes.slice(0,2)),JSON.stringify(scopes.slice(1)),q.hubIds??null,q.classIds??null,q.studentIds??null,q.payeeIds??null,q.currencyIds??null,q.accountIds??null,q.countryIds??null,q.regionIds??null,q.cityIds??null,includeAuthorization])).rows[0];
 assertExpenseCostBounds(r.events,r.lines,Object.values(r.series).map(a=>a.length));
 const view=(row:Raw)=>({key:row.key,currencyId:row.currencyId,currencyCode:row.currencyCode,unitScale:row.unitScale,costLineEvents:row.costLineEvents,...Object.fromEntries(measures.map(k=>[k,exact(row[k],row.unitScale)]))});
 const body={data:{report:'posted_expense_cost_assignments',snapshotAt:r.snapshotAt,filters:q,currencies:(r.series.total??[]).map(view),charts:Object.fromEntries(dimensions.map(d=>[d,(r.series[d]??[]).map(view)])),coverage:'complete_filtered_cost_lines_of_wholly_authorized_bills',sourceBasis:'retained_supplier_and_reimbursement_bills_only',dateBasis:'original_posting_and_void_posting_dates',expenseBasis:'net_plus_charged_tax_minus_declared_recoverable_tax',sharedCostPolicy:'recorded_context_only_no_automatic_student_split',currencyConversion:'none',privateBodiesIncluded:false,payrollIncluded:false,manualJournalsIncluded:false,profitDetermined:false,cashPaidDetermined:false,inventoryStatusChangesExpense:false,additionalLedgerPosting:false}};assertExpenseCostBounds(r.events,r.lines,Object.values(r.series).map(a=>a.length),Buffer.byteLength(JSON.stringify(body)));return {status:200,body:includeAuthorization?{data:{...body.data,authorizationContext:attributionAuthorization.parse(r.authorizationContext)}}:body};
}
export const expenseCostReportContract=[{path:'/api/v1/reports/finance/expense-costs',method:'get',summary:'Exact posted supplier/reimbursement cost assignments by student,class,hub,account,payee,month and posting/reversal. Every original bill context and ledger account must be currently authorized before filters/totals/charts. Separate currencies,declared recoverable tax and dated inverse events;payments/inventory loss never charge expense again. Not whole academy profit or automatic shared-cost allocation.10,000events/100,000line events/10000groups per dimension/4MiB bound.',querySchema:expenseCostQuery}] as const;
