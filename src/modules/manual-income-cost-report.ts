import { z } from 'zod';
import type { ApiContext,Reply } from '../core/api.ts';
import { ApiError,scopeNonempty } from '../core/policy.ts';
import { permissionScope } from '../core/approvals.ts';
import { exactReportMoney as exact } from '../core/aging.ts';
import { accountingDate } from './finance-periods.ts';
import { financialIds } from './financial-reports.ts';
import { lockAcademyTopology } from './academy.ts';
import { attributionAuthorization,attributionReportScopes,manualJournalSelectionSQL,attributionRevisionSelectionSQL } from './financial-attribution-access.ts';

export const manualIncomeCostQuery=z.object({from:accountingDate,through:accountingDate,attributionBasis:z.enum(['recorded','reviewed']).optional(),hubIds:financialIds.optional(),classIds:financialIds.optional(),studentIds:financialIds.optional(),accountIds:financialIds.optional(),currencyIds:financialIds.optional(),countryIds:financialIds.optional(),regionIds:financialIds.optional(),cityIds:financialIds.optional()}).strict().refine(q=>q.from<=q.through);
const dimensions=['hub','class','student','account','kind','month','event'] as const,measures=['income','expense','netResult'] as const;
type Raw={key:string|null;currencyId:string;currencyCode:string;unitScale:number;allocationEvents:number;income:string;expense:string;netResult:string};
// ponytail: complete10,000events/100,000targets/10,000groups/4MiB; larger
// aggregation needs chunked processing,never silent truncation or page sums.
export function assertManualIncomeCostBounds(events:number,lines:number,groups:number[],bytes=0){if([events,lines,...groups,bytes].some(v=>!Number.isSafeInteger(v)||v<0))throw new Error('MANUAL_REPORT_COUNTS_INVALID');if(events>10000||lines>100000||groups.some(n=>n>10000)||bytes>4_194_304)throw new ApiError(422,'MANUAL_REPORT_REQUIRES_BACKGROUND_JOB');}
const sourceRows=(parent:string)=>`SELECT l.line_number,a.hub_id,NULL::uuid class_id,NULL::uuid student_id,l.account_id,a.currency_id,c.code currency_code,u.unit_scale,r.kind,
 l.amount_minor*CASE WHEN(r.kind='income' AND l.side='credit') OR(r.kind='expense' AND l.side='debit') THEN 1 ELSE -1 END signed_minor
 FROM public.finance_journal_lines l JOIN public.finance_accounts a ON a.academy_id=l.academy_id AND a.id=l.account_id
 JOIN public.finance_account_revisions r ON r.academy_id=l.academy_id AND r.account_id=l.account_id AND r.version=l.account_version
 JOIN public.finance_currency_revisions u ON u.academy_id=a.academy_id AND u.currency_id=a.currency_id AND u.version=a.currency_version
 JOIN public.finance_currencies c ON c.academy_id=a.academy_id AND c.id=a.currency_id
 WHERE l.academy_id=${parent}.academy_id AND l.journal_id=${parent}.id AND r.kind IN('income','expense') AND ${parent}.allocation_version IS NULL
 UNION ALL SELECT(line->>'lineNumber')::integer,(target->>'hubId')::uuid,(target->>'classId')::uuid,(target->>'studentId')::uuid,(line->>'accountId')::uuid,(line->>'currencyId')::uuid,c.code,(line->>'unitScale')::integer,line->>'kind',(target->>'signedMinor')::numeric
 FROM jsonb_array_elements(${parent}.allocation_snapshot->'lines') line CROSS JOIN LATERAL jsonb_array_elements(line->'targets') target
 JOIN public.finance_currencies c ON c.academy_id=${parent}.academy_id AND c.id=(line->>'currencyId')::uuid WHERE ${parent}.allocation_version IS NOT NULL`;
const geography=(alias:string)=>`LEFT JOIN public.hubs h ON h.academy_id=${alias}.academy_id AND h.id=l.hub_id LEFT JOIN public.cities ci ON ci.academy_id=h.academy_id AND ci.id=h.city_id LEFT JOIN public.regions r ON r.academy_id=ci.academy_id AND r.id=ci.region_id`;
const filters=`($5::uuid[] IS NULL OR l.hub_id=ANY($5)) AND($6::uuid[] IS NULL OR l.class_id=ANY($6)) AND($7::uuid[] IS NULL OR l.student_id=ANY($7)) AND($8::uuid[] IS NULL OR l.account_id=ANY($8)) AND($9::uuid[] IS NULL OR l.currency_id=ANY($9)) AND($10::uuid[] IS NULL OR r.country_id=ANY($10)) AND($11::uuid[] IS NULL OR r.id=ANY($11)) AND($12::uuid[] IS NULL OR ci.id=ANY($12))`;
const sql=`WITH sources AS NOT MATERIALIZED(
 SELECT b.academy_id,b.id,b.posted_on,ar.version allocation_version,ar.source_snapshot allocation_snapshot
 FROM public.finance_journals b JOIN public.approval_requests p ON p.academy_id=b.academy_id AND p.id=b.approval_id AND p.action='finance.journal.post' AND p.status='applied'
 LEFT JOIN public.manual_journal_attributions a ON a.academy_id=b.academy_id AND a.journal_id=b.id AND $14::text='reviewed'
 LEFT JOIN public.manual_journal_attribution_revisions ar ON ar.academy_id=a.academy_id AND ar.journal_id=a.journal_id AND ar.version=a.version
 WHERE b.reverses_id IS NULL AND b.purpose='activity'
),permitted AS MATERIALIZED(
 SELECT b.*,e.id event_id,e.posted_on event_on,e.kind event_kind,e.sign
 FROM sources b LEFT JOIN public.finance_journals v ON v.academy_id=b.academy_id AND v.reverses_id=b.id
 CROSS JOIN LATERAL(VALUES(b.id,b.posted_on,'posting'::text,1),(v.id,v.posted_on,'reversal'::text,-1)) e(id,posted_on,kind,sign)
 WHERE e.id IS NOT NULL AND e.posted_on BETWEEN $1::date AND $2::date AND ${manualJournalSelectionSQL('$3::jsonb')}
 AND(b.allocation_version IS NULL OR ${attributionRevisionSelectionSQL('b.allocation_snapshot','$4::jsonb','$15::jsonb','$16::jsonb')})
 AND EXISTS(SELECT 1 FROM(${sourceRows('b')}) l ${geography('b')} WHERE ${filters}) LIMIT 10001
),event_bound AS(SELECT count(*)::integer events FROM permitted),selected AS MATERIALIZED(
 SELECT b.academy_id,b.id,b.allocation_version,b.event_on,b.event_kind,l.*,l.signed_minor*b.sign signed
 FROM permitted b CROSS JOIN LATERAL(${sourceRows('b')}) l ${geography('b')}
 WHERE(SELECT events FROM event_bound)<=10000 AND ${filters} LIMIT 100001
),normalized AS MATERIALIZED(SELECT s.*,max(unit_scale) OVER(PARTITION BY currency_id) scale FROM selected s WHERE(SELECT count(*) FROM selected)<=100000),weighted AS MATERIALIZED(
 SELECT n.*,('1'||repeat('0',scale-unit_scale))::numeric factor FROM normalized n
),expanded AS(SELECT w.*,d.dimension,d.key FROM weighted w CROSS JOIN LATERAL(VALUES('total',NULL::text),('hub',hub_id::text),('class',class_id::text),('student',student_id::text),('account',account_id::text),('kind',kind),('month',to_char(event_on,'YYYY-MM')),('event',event_kind)) d(dimension,key)),groups AS(
 SELECT dimension,key,currency_id AS "currencyId",currency_code AS "currencyCode",scale AS "unitScale",count(*)::integer "allocationEvents",sum(CASE WHEN kind='income' THEN signed*factor ELSE 0 END)::text income,sum(CASE WHEN kind='expense' THEN signed*factor ELSE 0 END)::text expense,sum(CASE WHEN kind='income' THEN signed*factor ELSE -signed*factor END)::text "netResult"
 FROM expanded GROUP BY dimension,key,currency_id,currency_code,scale
),ranked AS(SELECT *,row_number() OVER(PARTITION BY dimension ORDER BY "currencyId",key NULLS FIRST) n FROM groups)
 SELECT to_char(statement_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') "snapshotAt",(SELECT events FROM event_bound) events,(SELECT count(*)::integer FROM selected) lines,
 CASE WHEN $13::boolean THEN jsonb_build_object('kind','manual_journal_attribution','basis',$14::text,'journals',coalesce((SELECT jsonb_agg(id ORDER BY id) FROM(SELECT DISTINCT id FROM selected) j),'[]'::jsonb),'allocations',coalesce((SELECT jsonb_agg(jsonb_build_object('journalId',id,'version',allocation_version) ORDER BY id) FROM(SELECT DISTINCT id,allocation_version FROM selected WHERE allocation_version IS NOT NULL) a),'[]'::jsonb)) END "authorizationContext",
 coalesce((SELECT jsonb_object_agg(dimension,items) FROM(SELECT dimension,jsonb_agg(to_jsonb(r)-ARRAY['dimension','n'] ORDER BY "currencyId",key NULLS FIRST) items FROM ranked r WHERE n<=10001 GROUP BY dimension) x),'{}'::jsonb) series`;
export function manualIncomeCostReportStatement(ctx:ApiContext,q:z.infer<typeof manualIncomeCostQuery>,includeAuthorization=false){
 const scopes=attributionReportScopes(ctx,'finance.manual-income-costs'),target=permissionScope(ctx,'journal-attribution.view');if(q.attributionBasis==='reviewed'){if(!scopeNonempty(target))throw new ApiError(403,'FORBIDDEN');scopes.push(target);}
 return {sql,parameters:[q.from,q.through,JSON.stringify(scopes),JSON.stringify([target]),q.hubIds??null,q.classIds??null,q.studentIds??null,q.accountIds??null,q.currencyIds??null,q.countryIds??null,q.regionIds??null,q.cityIds??null,includeAuthorization,q.attributionBasis??'recorded',JSON.stringify(permissionScope(ctx,'classes.view')),JSON.stringify(permissionScope(ctx,'students.view'))]};
}
export async function manualIncomeCostReport(ctx:ApiContext,includeAuthorization=false):Promise<Reply|null>{
 if(ctx.path!=='reports/finance/manual-income-costs')return null;if(ctx.request.method!=='GET')throw new ApiError(405,'METHOD_NOT_ALLOWED');const p=new URL(ctx.request.url).searchParams;if([...p].length!==new Set(p.keys()).size)throw new ApiError(400,'DUPLICATE_QUERY');const q=manualIncomeCostQuery.parse(Object.fromEntries(p));await lockAcademyTopology(ctx);
 const statement=manualIncomeCostReportStatement(ctx,q,includeAuthorization);
 const r=(await ctx.db.query<{snapshotAt:string;events:number;lines:number;series:Record<string,Raw[]>;authorizationContext:unknown}>(statement.sql,statement.parameters)).rows[0];
 assertManualIncomeCostBounds(r.events,r.lines,Object.values(r.series).map(a=>a.length));const view=(row:Raw)=>({key:row.key,currencyId:row.currencyId,currencyCode:row.currencyCode,unitScale:row.unitScale,allocationEvents:row.allocationEvents,...Object.fromEntries(measures.map(k=>[k,exact(row[k],row.unitScale)]))});
 const body={data:{report:'posted_manual_income_cost_assignments',snapshotAt:r.snapshotAt,filters:q,currencies:(r.series.total??[]).map(view),charts:Object.fromEntries(dimensions.map(d=>[d,(r.series[d]??[]).map(view)])),coverage:'complete_filtered_operating_lines_of_wholly_authorized_manual_journals',sourceBasis:'explicit_finance_journal_post_activity_only',dateBasis:'original_posting_and_exact_reversal_dates',accountBasis:'original_as_posted_kind_and_currency_precision',geographyBasis:'current_hub_geography',allocationDateBasis:q.attributionBasis==='reviewed'?'latest_approved_at_report_snapshot_not_historical_as_of':'original_account_hub',sharedCostPolicy:'no_automatic_student_split',currencyConversion:'none',privateBodiesIncluded:false,payrollIncluded:false,tuitionIncluded:false,supplierBillsIncluded:false,profitDetermined:false,cashPaidDetermined:false,additionalLedgerPosting:false}};
 assertManualIncomeCostBounds(r.events,r.lines,Object.values(r.series).map(a=>a.length),Buffer.byteLength(JSON.stringify(body)));return {status:200,body:includeAuthorization?{data:{...body.data,authorizationContext:attributionAuthorization.parse(r.authorizationContext)}}:body};
}
export const manualIncomeCostReportContract=[{path:'/api/v1/reports/finance/manual-income-costs',method:'get',summary:'Complete exact separate-currency operating income/expense assignments from explicit standalone finance.journal.post activity only;automated tuition/payroll/supplier sources and opening/closing excluded. Original as-posted kind,account currency precision and exact dated inverses retained. Original whole journal/account/ledger/report rights before filters;optional attributionBasis=reviewed additionally requires original and all pinned target attribution/class/current-student rights. Latest approved splits at generation,not historical as-of. Default original account hubs;no guessed student splits or FX. Chart-ready aggregates,not whole academy profit.10000events/100000targets/10000groups per dimension/4MiB.',querySchema:manualIncomeCostQuery}] as const;
