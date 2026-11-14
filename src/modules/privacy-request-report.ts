import {z} from 'zod';
import type {ApiContext,Reply} from '../core/api.ts';
import {lockApprovalWrites,permissionScope} from '../core/approvals.ts';
import {ApiError,scopeNonempty} from '../core/policy.ts';
import {namedTimeZone} from '../core/automation-rules.ts';
import {csvRow,csvText} from '../core/csv.ts';
import type {ResolvedReportWindow} from '../core/report-window.ts';
import {lockAcademyTopology} from './academy.ts';
const uuid=z.string().uuid().transform(v=>v.toLowerCase()),day=z.iso.date().refine(v=>v>='1900-01-01'&&v<='9999-12-31');
export const privacyReportQuery=z.object({from:day,through:day,timeZone:namedTimeZone,hubId:uuid.optional(),subjectId:uuid.optional(),state:z.enum(['received','under_review','needs_information','responded','closed','withdrawn']).optional(),category:z.enum(['access','correction','deletion','consent_question','complaint']).optional()}).strict().refine(q=>q.from<=q.through&&Date.parse(q.through)-Date.parse(q.from)<=3659*86400000,'Choose an inclusive receipt window of at most3660civil days.');
type Counts={total:number;open:number;overdueBaseline:number;overdueTarget:number;needsInformation:number;oldestOpenReceivedOn:string|null};
type Snapshot={snapshotAt:string;summary:Counts;byState:{state:string;count:number}[];byCategory:{category:string;count:number}[];byMonth:{month:string;count:number}[];byHub:{hubId:string|null;count:number}[]};
const sql=`WITH permitted AS MATERIALIZED(
 SELECT h.id,subject.hub_id,h.received_at,r.state,h.intake->>'category' category,h.baseline_review_on,
 coalesce(reply.target,h.baseline_review_on) target_on,(statement_timestamp() AT TIME ZONE h.time_zone)::date today,
 r.state NOT IN('responded','closed','withdrawn') is_open
 FROM public.privacy_requests h JOIN public.privacy_request_revisions r ON r.academy_id=h.academy_id AND r.request_id=h.id AND r.version=h.version
 JOIN public.people subject ON subject.academy_id=h.academy_id AND subject.id=h.subject_id JOIN public.people author ON author.academy_id=h.academy_id AND author.id=h.requested_by
 LEFT JOIN LATERAL(SELECT (d.definition->>'targetResponseOn')::date target FROM public.privacy_request_revisions d WHERE d.academy_id=h.academy_id AND d.request_id=h.id AND d.version<=h.version AND d.definition?'state' ORDER BY d.version DESC LIMIT 1) reply ON true
 WHERE h.academy_id=nullif(current_setting('app.academy_id',true),'')::uuid AND(h.received_at AT TIME ZONE $3)::date BETWEEN $1::date AND $2::date
 AND($5::uuid IS NULL OR subject.hub_id=$5) AND($6::uuid IS NULL OR h.subject_id=$6) AND($7::text IS NULL OR r.state=$7) AND($8::text IS NULL OR h.intake->>'category'=$8)
 AND public.scope_contains($4::jsonb,jsonb_build_object('all',false,'hubs','[]'::jsonb,'people',jsonb_build_array(jsonb_build_object('id',subject.id,'hubId',subject.hub_id)))) IS TRUE
 AND(h.origin<>'self' OR public.scope_contains($4::jsonb,jsonb_build_object('all',false,'hubs','[]'::jsonb,'people',jsonb_build_array(jsonb_build_object('id',author.id,'hubId',author.hub_id)))) IS TRUE)
 ),states AS(SELECT state,count(*)::integer count FROM permitted GROUP BY state),categories AS(SELECT category,count(*)::integer count FROM permitted GROUP BY category),
 months AS(SELECT to_char(received_at AT TIME ZONE $3,'YYYY-MM') AS "month",count(*)::integer count FROM permitted GROUP BY 1),hubs AS(SELECT hub_id,count(*)::integer count FROM permitted GROUP BY hub_id)
 SELECT to_char(statement_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') "snapshotAt",
 jsonb_build_object('total',count(*)::integer,'open',count(*) FILTER(WHERE is_open)::integer,'overdueBaseline',count(*) FILTER(WHERE is_open AND today>baseline_review_on)::integer,'overdueTarget',count(*) FILTER(WHERE is_open AND today>target_on)::integer,'needsInformation',count(*) FILTER(WHERE state='needs_information')::integer,'oldestOpenReceivedOn',to_char((min(received_at) FILTER(WHERE is_open)) AT TIME ZONE $3,'YYYY-MM-DD')) summary,
 coalesce((SELECT jsonb_agg(to_jsonb(s) ORDER BY state) FROM states s),'[]'::jsonb) "byState",coalesce((SELECT jsonb_agg(to_jsonb(c) ORDER BY category) FROM categories c),'[]'::jsonb) "byCategory",
 coalesce((SELECT jsonb_agg(to_jsonb(m) ORDER BY m."month") FROM months m),'[]'::jsonb) "byMonth",coalesce((SELECT jsonb_agg(jsonb_build_object('hubId',hub_id,'count',count) ORDER BY hub_id NULLS FIRST) FROM hubs),'[]'::jsonb) "byHub" FROM permitted`;
export async function privacyRequestReportData(ctx:ApiContext){
 const p=new URL(ctx.request.url).searchParams;if([...p].length!==new Set(p.keys()).size)throw new ApiError(400,'DUPLICATE_QUERY');const q=privacyReportQuery.parse(Object.fromEntries(p));await lockApprovalWrites(ctx);await lockAcademyTopology(ctx);const scope=permissionScope(ctx,'privacy-requests.view');if(!scopeNonempty(scope))throw new ApiError(403,'FORBIDDEN');
 const r=(await ctx.db.query<Snapshot>(sql,[q.from,q.through,q.timeZone,JSON.stringify(scope),q.hubId??null,q.subjectId??null,q.state??null,q.category??null])).rows[0];if(!r)throw new Error('PRIVACY_REPORT_SOURCE_UNAVAILABLE');
 const data={report:'operational_privacy_request_summary',snapshotAt:r.snapshotAt,filters:q,summary:r.summary,charts:{byState:r.byState,byCategory:r.byCategory,byMonth:r.byMonth,byHub:r.byHub},coverage:'complete_current_authorized_receipt_window',statusBasis:'current_case_state_not_action_history',receiptDateBasis:'inclusive_receipt_civil_days_in_report_time_zone',overdueBasis:'current_database_day_in_each_immutable_original_request_zone',hubBasis:'current_subject_hub_with_complete_subject_and_original_requester_scope',missingChartBuckets:'zero_within_filtered_authorized_selection',nullHubMeaning:'current_subject_has_no_hub',permissionsAppliedBeforeAggregation:true,privateCaseContentIncluded:false,legalDeadlineVerified:false,automaticDisclosurePerformed:false,automaticDeletionPerformed:false,notificationsGenerated:false};
 if(Buffer.byteLength(JSON.stringify(data))>1048576)throw new ApiError(422,'PRIVACY_REPORT_SELECTION_TOO_LARGE');return data;
}
export async function completePrivacyRequestExport(ctx:ApiContext,provenance?:{id:string;version:number;dateWindow?:ResolvedReportWindow&{overriddenFields?:string[]}}):Promise<Reply>{
 const data=await privacyRequestReportData(ctx),rows:(string|number|boolean|null)[][]=[['section','key','count','value']];for(const [k,v] of Object.entries(data))if(k!=='charts'&&k!=='summary')rows.push(['metadata',k,'',typeof v==='object'?JSON.stringify(v):v]);if(provenance)rows.push(['metadata','preset','',JSON.stringify(provenance)]);
 for(const[k,v]of Object.entries(data.summary))rows.push(['summary',k,typeof v==='number'?v:'',typeof v==='number'?'':v]);for(const[section,values]of Object.entries(data.charts))for(const row of values)rows.push([section,'state'in row?row.state:'category'in row?row.category:'month'in row?row.month:row.hubId,row.count,'']);
 const body='\uFEFF'+rows.map(r=>csvRow(r.map(v=>typeof v==='string'?csvText(v):v))).join('\r\n')+'\r\n';if(Buffer.byteLength(body)>2097152)throw new ApiError(422,'PRIVACY_REPORT_SELECTION_TOO_LARGE');return{status:200,body,csv:{filename:'privacy-request-summary.csv'}};
}
export async function privacyRequestReport(ctx:ApiContext):Promise<Reply|null>{
 if(!['reports/administration/privacy-requests','reports/administration/privacy-requests/export'].includes(ctx.path))return null;if(ctx.request.method!=='GET')throw new ApiError(405,'METHOD_NOT_ALLOWED');return ctx.path.endsWith('/export')?completePrivacyRequestExport(ctx):{status:200,body:{data:await privacyRequestReportData(ctx)}};
}
export const privacyRequestReportContract=[{path:'/api/v1/reports/administration/privacy-requests',method:'get',summary:'Complete authorized operational privacy receipt-window counts and state/category/month/current-subject-hub chart data in one database snapshot. Both current subject and original self/guardian scopes apply before filters and totals. Explicit report zone groups receipts;overdue uses each case original zone and reviewed target. No private request/response content,identities,case listing,notification action,erasure or legal-deadline certification.3660civil-day/1MiB bounds refuse rather than truncate.',querySchema:privacyReportQuery}] as const;
export const privacyRequestReportExportContract=[{...privacyRequestReportContract[0],path:'/api/v1/reports/administration/privacy-requests/export',summary:'Complete private operational privacy-summary CSV from the same authorized one-statement aggregate;no detail pagination or partial totals. Fixed summary and state/category/month/hub chart rows,no request text,contact or case identifiers. Formula-safe metadata;2MiB ceiling. Not a statutory-compliance determination.',responseContentType:'text/csv' as const}] as const;
