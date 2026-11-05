import { z } from 'zod';
import type { ApiContext,Reply } from '../core/api.ts';
import { permissionScope,lockApprovalWrites } from '../core/approvals.ts';
import { ApiError,scopeNonempty } from '../core/policy.ts';
import { readMinorUnits } from '../core/money.ts';
import { exactReportMoney as exact } from '../core/aging.ts';
import { accountingDate } from './finance-periods.ts';
import { financialIds } from './financial-reports.ts';

const uuid=z.string().uuid().transform(v=>v.toLowerCase()),kind=z.enum(['hourly','manual_bonus','project','salary','tuition_course','tuition_session','tuition_collection']);
const query=z.object({on:accountingDate,hubIds:financialIds.optional(),personIds:financialIds.optional(),currencyIds:financialIds.optional(),countryIds:financialIds.optional(),regionIds:financialIds.optional(),cityIds:financialIds.optional(),kind:kind.optional(),afterKind:kind.optional(),afterId:uuid.optional(),afterAllocationId:uuid.optional(),limit:z.coerce.number().int().min(1).max(100).default(50)}).strict().refine(q=>[q.afterKind,q.afterId,q.afterAllocationId].filter(v=>v!==undefined).length%3===0,'Provide all three cursor fields together.');
const limit=10000,chartLimit=1000;
export function assertPayrollGrossBounds(r:{allocations:number;currencyGroups:number;chartGroups:number}){if(r.allocations>limit||r.currencyGroups>chartLimit||r.chartGroups>chartLimit)throw new ApiError(422,'GROSS_EARNINGS_REPORT_REQUIRES_BACKGROUND_JOB');}
// Amounts are approved gross source allocations, NOT net or unpaid balances.
// Hourly rows retain the same whole-worker privacy gate as their canonical
// record reader; a hub filter never attributes a whole mixed-hub earning there.
const sql=`WITH source AS NOT MATERIALIZED(
 SELECT x.academy_id,'manual_bonus'::text kind,x.id,x.person_id,x.hub_id,x.engagement_id allocation_id,x.currency_id,x.unit_scale,x.amount_minor minor,x.posted_on,x.due_on,x.void_id,false legacy_date_review
 FROM public.payroll_adjustments x WHERE public.work_scope_allows($2::jsonb,x.hub_id,x.person_id) AND public.work_scope_allows($4::jsonb,x.hub_id,x.person_id) AND($5::boolean OR x.hub_id=ANY($6::uuid[]))
 UNION ALL SELECT x.academy_id,'salary',x.id,x.person_id,x.hub_id,x.engagement_id,x.currency_id,x.unit_scale,x.amount_minor,x.posted_on,x.due_on,x.void_id,false
 FROM public.payroll_salary_accruals x WHERE public.work_scope_allows($2::jsonb,x.hub_id,x.person_id) AND public.work_scope_allows($3::jsonb,x.hub_id,x.person_id) AND($5::boolean OR x.hub_id=ANY($6::uuid[]))
 UNION ALL SELECT x.academy_id,'project',x.id,x.person_id,x.hub_id,x.engagement_id,x.currency_id,x.unit_scale,x.amount_minor,x.posted_on,x.due_on,x.void_id,false
 FROM public.payroll_project_accruals x WHERE public.work_scope_allows($2::jsonb,x.hub_id,x.person_id) AND public.work_scope_allows($3::jsonb,x.hub_id,x.person_id) AND($5::boolean OR x.hub_id=ANY($6::uuid[]))
 UNION ALL SELECT x.academy_id,'tuition_collection',x.id,x.person_id,x.hub_id,x.engagement_id,x.currency_id,x.unit_scale,x.amount_minor,x.posted_on,x.due_on,x.void_id,false
 FROM public.payroll_tuition_collection_accruals x WHERE public.work_scope_allows($2::jsonb,x.hub_id,x.person_id) AND public.work_scope_allows($3::jsonb,x.hub_id,x.person_id) AND($5::boolean OR x.hub_id=ANY($6::uuid[]))
 UNION ALL SELECT x.academy_id,'tuition_session',x.id,x.person_id,x.hub_id,x.engagement_id,x.currency_id,x.unit_scale,x.amount_minor,x.posted_on,x.due_on,x.void_id,false
 FROM public.payroll_tuition_session_accruals x WHERE public.work_scope_allows($2::jsonb,x.hub_id,x.person_id) AND public.work_scope_allows($3::jsonb,x.hub_id,x.person_id) AND($5::boolean OR x.hub_id=ANY($6::uuid[]))
 UNION ALL SELECT x.academy_id,'tuition_course',x.id,x.person_id,x.hub_id,x.engagement_id,x.currency_id,x.unit_scale,x.amount_minor,x.posted_on,x.due_on,x.void_id,false
 FROM public.payroll_tuition_course_accruals x WHERE public.work_scope_allows($2::jsonb,x.hub_id,x.person_id) AND public.work_scope_allows($3::jsonb,x.hub_id,x.person_id) AND($5::boolean OR x.hub_id=ANY($6::uuid[]))
 UNION ALL SELECT x.academy_id,'hourly',x.id,x.person_id,(w->>'hub_id')::uuid,(a->>'engagementId')::uuid,x.currency_id,x.unit_scale,(a#>>'{gross,minor}')::numeric,x.posted_on,x.due_on,x.void_id,x.release_date_policy=0
 FROM public.payroll_hourly_accruals x CROSS JOIN LATERAL jsonb_array_elements(x.earning_plan->'workAllocations') a
 CROSS JOIN LATERAL jsonb_array_elements(x.source_snapshot#>'{payroll,work}') w
 WHERE w->>'id'=a->>'engagementId' AND public.payroll_preparation_allows(x.source_snapshot->'payroll',jsonb_build_array($2::jsonb,$3::jsonb,jsonb_build_object('all',$5::boolean,'hubs',to_jsonb($6::uuid[]))),'[{"all":true,"hubs":[]}]'::jsonb)
),selected AS MATERIALIZED(
 SELECT s.*,c.code currency_code FROM source s JOIN public.finance_currencies c ON c.academy_id=s.academy_id AND c.id=s.currency_id
 LEFT JOIN public.finance_journals v ON v.academy_id=s.academy_id AND v.id=s.void_id
 LEFT JOIN public.payroll_tuition_collection_voids cv ON s.kind='tuition_collection' AND cv.academy_id=s.academy_id AND cv.id=s.void_id
 LEFT JOIN public.hubs h ON h.academy_id=s.academy_id AND h.id=s.hub_id LEFT JOIN public.cities ci ON ci.academy_id=h.academy_id AND ci.id=h.city_id LEFT JOIN public.regions r ON r.academy_id=ci.academy_id AND r.id=ci.region_id
 WHERE s.posted_on<=$1::date AND(s.void_id IS NULL OR CASE WHEN s.kind='tuition_collection' THEN cv.posted_on ELSE v.posted_on END>$1::date)
 AND($7::uuid[] IS NULL OR s.hub_id=ANY($7)) AND($8::uuid[] IS NULL OR s.person_id=ANY($8)) AND($9::uuid[] IS NULL OR s.currency_id=ANY($9)) AND($10::text IS NULL OR s.kind=$10)
 AND($11::uuid[] IS NULL OR r.country_id=ANY($11)) AND($12::uuid[] IS NULL OR r.id=ANY($12)) AND($13::uuid[] IS NULL OR ci.id=ANY($13)) LIMIT ${limit+1}
),bounds AS(SELECT count(*)::integer allocations FROM selected),usable AS MATERIALIZED(SELECT s.*,max(unit_scale) OVER(PARTITION BY currency_id) scale FROM selected s CROSS JOIN bounds b WHERE b.allocations<=${limit}),
 normalized AS MATERIALIZED(SELECT *,minor*power(10::numeric,scale-unit_scale) normalized_minor FROM usable),
 totals AS MATERIALIZED(SELECT currency_id,currency_code,max(scale) scale,count(DISTINCT(kind,id))::integer source_count,count(DISTINCT(kind,id)) FILTER(WHERE legacy_date_review)::integer legacy_date_sources,count(*)::integer allocation_count,sum(normalized_minor)::text gross,sum(CASE WHEN due_on<$1::date THEN normalized_minor ELSE 0 END)::text past_due FROM normalized GROUP BY currency_id,currency_code),
 charts AS MATERIALIZED(SELECT hub_id,kind,currency_id,currency_code,max(scale) scale,count(*)::integer allocation_count,sum(normalized_minor)::text gross FROM normalized GROUP BY hub_id,kind,currency_id,currency_code),
 page AS(SELECT kind,id "sourceId",allocation_id "allocationId",person_id "personId",hub_id "hubId",currency_id "currencyId",currency_code "currencyCode",unit_scale "unitScale",minor::text minor,posted_on::text "postedOn",due_on::text "dueOn",greatest($1::date-due_on,0) "daysPastConfiguredDue",legacy_date_review "legacyDateReviewRequired" FROM usable WHERE $14::text IS NULL OR(kind,id,allocation_id)>($14::text,$15::uuid,$16::uuid) ORDER BY kind,id,allocation_id LIMIT $17)
 SELECT statement_timestamp()::text "snapshotAt",b.allocations,(SELECT count(*)::integer FROM totals) "currencyGroups",(SELECT count(*)::integer FROM charts) "chartGroups",(SELECT count(DISTINCT(kind,id))::integer FROM usable) "sourceCount",
 coalesce((SELECT jsonb_agg(to_jsonb(t) ORDER BY currency_code,currency_id) FROM(SELECT * FROM totals ORDER BY currency_code,currency_id LIMIT ${chartLimit+1}) t),'[]'::jsonb) currencies,
 coalesce((SELECT jsonb_agg(to_jsonb(c) ORDER BY hub_id,kind,currency_id) FROM(SELECT * FROM charts ORDER BY hub_id,kind,currency_id LIMIT ${chartLimit+1}) c),'[]'::jsonb) charts,
 coalesce((SELECT jsonb_agg(to_jsonb(p) ORDER BY kind,"sourceId","allocationId") FROM page p),'[]'::jsonb) entries FROM bounds b`;
type Currency={currency_id:string;currency_code:string;scale:number;source_count:number;legacy_date_sources:number;allocation_count:number;gross:string;past_due:string};
type Chart={hub_id:string|null;kind:z.infer<typeof kind>;currency_id:string;currency_code:string;scale:number;allocation_count:number;gross:string};
type Entry={kind:z.infer<typeof kind>;sourceId:string;allocationId:string;personId:string;hubId:string|null;currencyId:string;currencyCode:string;unitScale:number;minor:string;postedOn:string;dueOn:string;daysPastConfiguredDue:number;legacyDateReviewRequired:boolean};
export async function payrollGrossReport(ctx:ApiContext):Promise<Reply|null>{
 if(ctx.path!=='reports/payroll/gross-accruals')return null;if(ctx.request.method!=='GET')throw new ApiError(405,'METHOD_NOT_ALLOWED');const params=new URL(ctx.request.url).searchParams;if([...params].length!==new Set(params.keys()).size)throw new ApiError(400,'DUPLICATE_QUERY');const q=query.parse(Object.fromEntries(params));await lockApprovalWrites(ctx);
 const reports=permissionScope(ctx,'financial-reports.view'),gross=permissionScope(ctx,'payroll-accruals.view'),manual=permissionScope(ctx,'payroll-adjustments.view');if(!scopeNonempty(reports)||!scopeNonempty(gross)&&!scopeNonempty(manual))throw new ApiError(403,'FORBIDDEN');
 const r=(await ctx.db.query<{snapshotAt:string;allocations:number;currencyGroups:number;chartGroups:number;sourceCount:number;currencies:Currency[];charts:Chart[];entries:Entry[]}>(sql,[q.on,JSON.stringify(reports),JSON.stringify(gross),JSON.stringify(manual),ctx.credential.all_hubs,ctx.credential.hub_ids,q.hubIds??null,q.personIds??null,q.currencyIds??null,q.kind??null,q.countryIds??null,q.regionIds??null,q.cityIds??null,q.afterKind??null,q.afterId??null,q.afterAllocationId??null,q.limit+1])).rows[0];
 assertPayrollGrossBounds(r);const page=r.entries.slice(0,q.limit),last=page.at(-1);
 return {status:200,body:{data:{report:'recorded_gross_earning_sources',on:q.on,snapshotAt:r.snapshotAt,filters:q,sourceCount:r.sourceCount,allocationCount:r.allocations,
 currencies:r.currencies.map(c=>({currencyId:c.currency_id,currencyCode:c.currency_code,unitScale:c.scale,sourceCount:c.source_count,legacyDateReviewSources:c.legacy_date_sources,allocationCount:c.allocation_count,recordedGross:exact(c.gross,c.scale),pastConfiguredDueGross:exact(c.past_due,c.scale)})),
 chartData:r.charts.map(c=>({hubId:c.hub_id,kind:c.kind,currencyId:c.currency_id,currencyCode:c.currency_code,unitScale:c.scale,allocationCount:c.allocation_count,recordedGross:exact(c.gross,c.scale)})),
 entries:page.map(({minor,...e})=>({...e,recordedGross:exact(readMinorUnits(minor),e.unitScale)})),
 coverage:'permitted_recorded_salary_hourly_project_course_session_and_collection_tuition_manual_gross_sources_only',effectiveDateBasis:'inclusive_posting_and_retained_reversal_dates',allocationBasis:'immutable_hourly_work_allocations_other_sources_recorded_work_hub',geographyBasis:'current_hub_location',paginationSnapshot:'per_request_not_frozen_across_pages',systemKnowledgeAsOf:false,permissionsAppliedBeforeAggregation:true,currencyConversion:'none',paymentStatusKnown:false,unpaidBalancesCalculated:false,netPayCalculated:false,statutoryDeductionsCalculated:false,cashFlowForecast:false,additionalLedgerPosting:false,moneyMovementPerformed:false},nextCursor:r.entries.length>q.limit&&last?{afterKind:last.kind,afterId:last.sourceId,afterAllocationId:last.allocationId}:null}};
}
export const payrollGrossReportContract=[{path:'/api/v1/reports/payroll/gross-accruals',method:'get',summary:'Source-private combined salary/hourly/project/course-session-and-collection-tuition/manual gross accounting report as of effective posting/reversal date, exact currency totals, actual hourly work/hub allocations, configurable worker/hub/geography/source filters and chart data. Past configured due dates are not unpaid/net balances; no withholding or settlement inference. Permissions before bounded aggregates/paging.',querySchema:query}] as const;
