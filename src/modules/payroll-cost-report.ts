import { z } from 'zod';
import type { ApiContext,Reply } from '../core/api.ts';
import { permissionScope } from '../core/approvals.ts';
import { ApiError,scopeNonempty } from '../core/policy.ts';
import { exactReportMoney as exact } from '../core/aging.ts';
import { accountingDate } from './finance-periods.ts';
import { financialIds } from './financial-reports.ts';
import { payrollReportScopes } from './payroll-report-access.ts';
import { lockAcademyTopology } from './academy.ts';
import { tuitionInvoiceSelectionSQL } from './financial-attribution-access.ts';

const kinds=['hourly','manual_bonus','salary','project','tuition_course','tuition_session','tuition_collection'] as const;
export const payrollCostAuthorization=z.object({kind:z.literal('payroll_cost'),sources:z.array(z.object({kind:z.enum(kinds),sourceId:z.string().uuid().transform(v=>v.toLowerCase())}).strict()).max(10000).refine(a=>new Set(a.map(s=>s.kind+':'+s.sourceId)).size===a.length)}).strict();
export function payrollCostScopes(ctx:ApiContext){const work=payrollReportScopes(ctx),accounts=[work.reports,permissionScope(ctx,'accounts.view'),permissionScope(ctx,'ledger.view')];if(accounts.some(s=>!scopeNonempty(s)))throw new ApiError(403,'FORBIDDEN');return {...work,accounts};}
function sourceParameters(ctx:ApiContext,from:string|null=null,through:string|null=null){const {reports,gross,manual,accounts}=payrollCostScopes(ctx);return [from,JSON.stringify(reports),JSON.stringify(gross),JSON.stringify(manual),ctx.credential.all_hubs,ctx.credential.hub_ids,through,JSON.stringify(accounts),JSON.stringify(permissionScope(ctx,'classes.view')),JSON.stringify([permissionScope(ctx,'invoices.view'),reports])];}
export const payrollCostQuery=z.object({from:accountingDate,through:accountingDate,hubIds:financialIds.optional(),classIds:financialIds.optional(),studentIds:financialIds.optional(),personIds:financialIds.optional(),accountIds:financialIds.optional(),currencyIds:financialIds.optional(),countryIds:financialIds.optional(),regionIds:financialIds.optional(),cityIds:financialIds.optional(),kind:z.enum(kinds).optional()}).strict().refine(q=>q.from<=q.through);
const dimensions=['hub','class','student','worker','account','kind','month','event'] as const;
type Row={key:string|null;currencyId:string;currencyCode:string;unitScale:number;allocationEvents:number;expense:string};
export function assertPayrollCostBounds(events:number,allocations:number,groups:number[],bytes=0){if([events,allocations,...groups,bytes].some(n=>!Number.isSafeInteger(n)||n<0))throw Error('PAYROLL_COST_COUNTS_INVALID');if(events>10000||allocations>100000||groups.some(n=>n>10000)||bytes>4_194_304)throw new ApiError(422,'PAYROLL_COST_REPORT_REQUIRES_BACKGROUND_JOB');}
// Only these constant table names/expressions enter SQL. No caller SQL.
const tables={manual_bonus:'payroll_adjustments',salary:'payroll_salary_accruals',project:'payroll_project_accruals',tuition_course:'payroll_tuition_course_accruals',tuition_session:'payroll_tuition_session_accruals',tuition_collection:'payroll_tuition_collection_accruals',hourly:'payroll_hourly_accruals'} as const;
const hub=(f:string)=>`jsonb_build_object('all',${f} IS NULL,'hubs',CASE WHEN ${f} IS NULL THEN '[]'::jsonb ELSE jsonb_build_array(${f}) END)`;
const branches=kinds.map(kind=>{
 const hourly=kind==='hourly',tuition=kind.startsWith('tuition_'),workScope=kind==='manual_bonus'?'$4::jsonb':'$3::jsonb';
 const work=hourly?`public.payroll_preparation_allows(x.source_snapshot->'payroll',jsonb_build_array($2::jsonb,$3::jsonb,jsonb_build_object('all',$5::boolean,'hubs',to_jsonb($6::uuid[]))),jsonb_build_array($9::jsonb))`:
 `public.work_scope_allows($2::jsonb,x.hub_id,x.person_id) AND public.work_scope_allows(${workScope},x.hub_id,x.person_id) AND($5::boolean OR x.hub_id=ANY($6::uuid[]))`;
 return `SELECT x.academy_id,'${kind}'::text kind,x.id,x.person_id,${hourly?'NULL::uuid':'x.hub_id'} hub_id,${tuition?'i.class_id':'NULL::uuid'} class_id,${tuition?'i.student_id':'NULL::uuid'} student_id,x.currency_id,x.unit_scale,x.amount_minor minor,x.posted_on,x.void_id,x.expense_account,x.liability_account,${hourly?"x.earning_plan->'sourceAllocations'":'NULL::jsonb'} hourly_allocations
 FROM public.${tables[kind]} x ${tuition?'JOIN public.tuition_invoices i ON i.academy_id=x.academy_id AND i.id=x.invoice_id':''}
 WHERE ${work} ${tuition?`AND ${tuitionInvoiceSelectionSQL('$10::jsonb','$8::jsonb')} AND public.scope_contains($9::jsonb,jsonb_build_object('all',false,'hubs','[]'::jsonb,'classes',jsonb_build_array(jsonb_build_object('id',i.class_id,'hubId',i.hub_id))))`:''}`;
});
const sourceAllocationsSQL=`SELECT (p->>'hubId')::uuid hub_id,(p->>'classId')::uuid class_id,NULL::uuid student_id,(p#>>'{gross,minor}')::numeric minor FROM jsonb_array_elements(s.hourly_allocations) p WHERE s.kind='hourly' UNION ALL SELECT s.hub_id,s.class_id,s.student_id,s.minor WHERE s.kind<>'hourly'`;
const geographySQL=`LEFT JOIN public.hubs h ON h.academy_id=s.academy_id AND h.id=a.hub_id LEFT JOIN public.cities ci ON ci.academy_id=h.academy_id AND ci.id=h.city_id LEFT JOIN public.regions r ON r.academy_id=ci.academy_id AND r.id=ci.region_id`;
const filterSQL=`NOT EXISTS(SELECT 1 FROM(VALUES('hubIds',a.hub_id),('classIds',a.class_id),('studentIds',a.student_id),('personIds',s.person_id),('accountIds',s.expense_account),('currencyIds',s.currency_id),('countryIds',r.country_id),('regionIds',r.id),('cityIds',ci.id)) f(key,id) WHERE $11::jsonb ? f.key AND(f.id IS NULL OR NOT($11::jsonb->f.key ? f.id::text)))`;
const accountSelectionSQL=`NOT EXISTS(SELECT 1 FROM unnest(ARRAY[s.expense_account,s.liability_account]) pick(id) LEFT JOIN public.finance_accounts a ON a.academy_id=s.academy_id AND a.id=pick.id CROSS JOIN jsonb_array_elements($8::jsonb) scope WHERE a.id IS NULL OR public.scope_contains(scope,${hub('a.hub_id')}) IS NOT TRUE)`;
// Current rights over EVERY captured original source,not a fresh filtered
// subset. The job reader/worker holds the existing policy/topology gates.
export async function requirePayrollCostResultAccess(ctx:ApiContext,raw:unknown){const proof=payrollCostAuthorization.parse(raw),ok=(await ctx.db.query<{ok:boolean}>(`WITH sources AS NOT MATERIALIZED(${branches.join(' UNION ALL ')}) SELECT $1::date IS NULL AND $7::date IS NULL AND NOT EXISTS(SELECT 1 FROM jsonb_to_recordset($11::jsonb) p(kind text,"sourceId" uuid) WHERE NOT EXISTS(SELECT 1 FROM sources s WHERE s.kind=p.kind AND s.id=p."sourceId" AND ${accountSelectionSQL})) ok`,[...sourceParameters(ctx),JSON.stringify(proof.sources)])).rows[0].ok;if(!ok)throw new ApiError(403,'REPORT_SOURCE_ACCESS_CHANGED');}
// ponytail:10,000 source events,100,000 allocations,10,000 groups/dimension,
// 4MiB JSON. Larger complete selections require chunked aggregation,not paging.
const sql=`WITH sources AS NOT MATERIALIZED(${branches.join(' UNION ALL ')}),permitted AS MATERIALIZED(
 SELECT s.*,c.code currency_code,e.event_on,e.event,e.sign FROM sources s JOIN public.finance_currencies c ON c.academy_id=s.academy_id AND c.id=s.currency_id
 LEFT JOIN public.finance_journals v ON v.academy_id=s.academy_id AND v.id=s.void_id
 LEFT JOIN public.payroll_tuition_collection_voids cv ON s.kind='tuition_collection' AND cv.academy_id=s.academy_id AND cv.id=s.void_id
 CROSS JOIN LATERAL(VALUES(s.posted_on,'posting'::text,1),(CASE WHEN s.kind='tuition_collection' THEN cv.posted_on ELSE v.posted_on END,'reversal',-1)) e(event_on,event,sign)
 WHERE e.event_on BETWEEN $1::date AND $7::date AND($11::jsonb->>'kind' IS NULL OR s.kind=$11::jsonb->>'kind')
 AND ${accountSelectionSQL}
 AND EXISTS(SELECT 1 FROM LATERAL(${sourceAllocationsSQL}) a ${geographySQL} WHERE ${filterSQL})
 LIMIT 10001
),source_bound AS(SELECT count(*)::integer events FROM permitted),allocations AS MATERIALIZED(
 SELECT s.kind,s.id,s.person_id,s.currency_id,s.currency_code,s.unit_scale,s.expense_account,s.event_on,s.event,s.sign,a.hub_id,a.class_id,a.student_id,a.minor*s.sign expense
 FROM permitted s CROSS JOIN LATERAL(${sourceAllocationsSQL}) a ${geographySQL}
 WHERE(SELECT events FROM source_bound)<=10000
 AND ${filterSQL} LIMIT 100001
),normalized AS MATERIALIZED(SELECT a.*,max(unit_scale) OVER(PARTITION BY currency_id) scale FROM allocations a WHERE(SELECT count(*) FROM allocations)<=100000),expanded AS(
 SELECT n.*,d.dimension,d.key,n.expense*('1'||repeat('0',scale-unit_scale))::numeric normalized_expense FROM normalized n CROSS JOIN LATERAL(VALUES('total',NULL::text),('hub',hub_id::text),('class',class_id::text),('student',student_id::text),('worker',person_id::text),('account',expense_account::text),('kind',kind),('month',to_char(event_on,'YYYY-MM')),('event',event)) d(dimension,key)
),groups AS(SELECT dimension,key,currency_id "currencyId",currency_code "currencyCode",scale "unitScale",count(*)::integer "allocationEvents",sum(normalized_expense)::text expense FROM expanded GROUP BY dimension,key,currency_id,currency_code,scale),ranked AS(SELECT *,row_number() OVER(PARTITION BY dimension ORDER BY "currencyId",key NULLS FIRST) n FROM groups)
 SELECT statement_timestamp()::text "snapshotAt",(SELECT events FROM source_bound) events,(SELECT count(*)::integer FROM allocations) allocations,CASE WHEN $12::boolean THEN jsonb_build_object('kind','payroll_cost','sources',coalesce((SELECT jsonb_agg(p ORDER BY p->>'kind',p->>'sourceId') FROM(SELECT DISTINCT jsonb_build_object('kind',kind,'sourceId',id) p FROM allocations) sources),'[]'::jsonb)) END "authorizationContext",coalesce((SELECT jsonb_object_agg(dimension,items) FROM(SELECT dimension,jsonb_agg(to_jsonb(g)-ARRAY['dimension','n'] ORDER BY "currencyId",key NULLS FIRST) items FROM ranked g WHERE n<=10001 GROUP BY dimension) d),'{}'::jsonb) series`;
export async function payrollCostReport(ctx:ApiContext,includeAuthorization=false):Promise<Reply|null>{
 if(ctx.path!=='reports/payroll/costs')return null;if(ctx.request.method!=='GET')throw new ApiError(405,'METHOD_NOT_ALLOWED');const params=new URL(ctx.request.url).searchParams;if([...params].length!==new Set(params.keys()).size)throw new ApiError(400,'DUPLICATE_QUERY');const q=payrollCostQuery.parse(Object.fromEntries(params));await lockAcademyTopology(ctx);
 const filters=Object.fromEntries(Object.entries(q).map(([k,v])=>[k,k.endsWith('Ids')?String(v).split(','):v]));
 const r=(await ctx.db.query<{snapshotAt:string;events:number;allocations:number;series:Record<string,Row[]>;authorizationContext:unknown}>(sql,[...sourceParameters(ctx,q.from,q.through),JSON.stringify(filters),includeAuthorization])).rows[0];assertPayrollCostBounds(r.events,r.allocations,Object.values(r.series).map(a=>a.length));
 const view=(row:Row)=>({...row,expense:exact(row.expense,row.unitScale)}),body={data:{report:'posted_gross_payroll_cost_assignments',snapshotAt:r.snapshotAt,filters:q,currencies:(r.series.total??[]).map(view),charts:Object.fromEntries(dimensions.map(d=>[d,(r.series[d]??[]).map(view)])),sourceBasis:'approved_salary_hourly_project_tuition_and_manual_gross_accruals',dateBasis:'original_posting_and_dated_reversal_events',allocationBasis:'immutable_hourly_source_allocations_other_sources_recorded_work_hub',studentAllocationPolicy:'explicit_tuition_source_only_no_automatic_class_student_split',geographyBasis:'current_attributed_hub_location',currencyConversion:'none',employerContributionsIncluded:false,unassignedSharedCostsRedistributed:false,netPayDetermined:false,cashPaidDetermined:false,profitDetermined:false,privateBodiesIncluded:false,additionalLedgerPosting:false}};assertPayrollCostBounds(r.events,r.allocations,Object.values(r.series).map(a=>a.length),Buffer.byteLength(JSON.stringify(body)));return {status:200,body:includeAuthorization?{data:{...body.data,authorizationContext:payrollCostAuthorization.parse(r.authorizationContext)}}:body};
}
export const payrollCostReportContract=[{path:'/api/v1/reports/payroll/costs',method:'get',summary:'Exact gross payroll cost flows by class,hub,student,worker,expense account,kind,month and posting/reversal. Saved highest-rate hourly allocations prevent duplicate overlapping pay. All original work and mapped account rights before filters;hourly whole-source classes and tuition original invoice/class rights also apply. Salaries/projects/bonuses remain explicitly unassigned to classes/students unless source records supply that context. Separate currencies;no net pay,cash,employer contributions,automatic shared-cost split or full profit inference.10000source events/100000allocations/10000groups per dimension/4MiB bound.',querySchema:payrollCostQuery}] as const;
