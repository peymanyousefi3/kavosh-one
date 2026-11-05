import { z } from 'zod';
import type { ApiContext,Reply } from '../core/api.ts';
import { lockApprovalWrites,permissionScope } from '../core/approvals.ts';
import { ApiError,type Capability } from '../core/policy.ts';

const uuid=z.string().uuid().transform(v=>v.toLowerCase());
const capabilities:Capability[]=['session-reports.view','attendance.view','rosters.view','session-time.view','staff.view','files.view'];
type Staff={personId:string;assignmentId:string|null;assignmentVersion:number|null;role:string|null;expected:boolean;entryId:string|null;entryVersion:number|null;sessionVersion:number|null;assignmentCurrent:boolean|null;startsAt:string|null;endsAt:string|null;recordedMilliseconds:string|null;outsideScheduleMilliseconds:string|null};
type Snapshot={sessionId:string;sessionVersion:number;classId:string;hubId:string;status:string;classActive:boolean;startsAt:string;endsAt:string;sessionStarted:boolean;sessionEnded:boolean;on:string|null;timeZone:string;snapshotAt:string;sourceValid:boolean;rosterTooLarge:boolean;attendanceVersion:number|null;attendanceCurrent:boolean|null;attendanceEntryCount:number|null;reportVersion:number|null;reportCurrent:boolean|null;hasReportText:boolean;mediaReferenceCount:number;staffCount:number;staff:Staff[]};
// One statement snapshot. Resolve private records only inside the authorized
// class; return counts/references, never student notes, report text or file keys.
// ponytail: synchronous output stops at 200 staff; refuse larger checklists
// until the shared background-report workflow handles them without truncation.
const sql=`WITH permitted AS MATERIALIZED(
 SELECT s.*,c.time_zone,c.active class_active FROM public.class_sessions s JOIN public.classes c ON c.academy_id=s.academy_id AND c.id=s.class_id
 WHERE s.id=$1 AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements($2::jsonb) scope WHERE NOT public.scope_contains(scope,jsonb_build_object('all',false,'hubs','[]'::jsonb,'classes',jsonb_build_array(jsonb_build_object('id',s.class_id,'hubId',s.hub_id)))))
),basis AS MATERIALIZED(
 SELECT s.*,public.session_attendance_source(s.id) attendance_source,a.version attendance_version,a.context attendance_context,jsonb_array_length(a.entries) attendance_entry_count,
 r.version report_version,r.context report_context,r.document,CASE WHEN r.version IS NOT NULL THEN public.session_report_source(s.id,r.document) END report_source
 FROM permitted s LEFT JOIN public.session_attendance a ON a.academy_id=s.academy_id AND a.session_id=s.id LEFT JOIN public.session_reports r ON r.academy_id=s.academy_id AND r.session_id=s.id
),expected AS MATERIALIZED(
 SELECT a.person_id,a.id,a.version,a.role FROM basis s JOIN public.class_staff a ON a.academy_id=s.academy_id AND a.class_id=s.class_id AND a.active
 AND a.starts_on<=(s.attendance_source->>'on')::date AND(a.ends_on IS NULL OR a.ends_on>=(s.attendance_source->>'on')::date)
),recorded AS MATERIALIZED(
 SELECT t.*,a.version current_assignment_version,a.active assignment_active FROM basis s JOIN public.session_time_entries t ON t.academy_id=s.academy_id AND t.session_id=s.id
 JOIN public.class_staff a ON a.academy_id=t.academy_id AND a.id=t.assignment_id
),staff AS MATERIALIZED(
 SELECT coalesce(e.person_id,t.person_id) AS "personId",e.id AS "assignmentId",e.version AS "assignmentVersion",e.role,e.id IS NOT NULL AS expected,t.id AS "entryId",t.version AS "entryVersion",t.session_version AS "sessionVersion",
 CASE WHEN t.id IS NOT NULL THEN t.assignment_version=t.current_assignment_version AND t.assignment_active END AS "assignmentCurrent",t.starts_at::text AS "startsAt",t.ends_at::text AS "endsAt",
 (extract(epoch FROM(t.ends_at-t.starts_at))*1000)::bigint::text AS "recordedMilliseconds",
 (extract(epoch FROM((t.ends_at-t.starts_at)-greatest(interval '0',least(t.ends_at,t.scheduled_end)-greatest(t.starts_at,t.scheduled_start))))*1000)::bigint::text AS "outsideScheduleMilliseconds"
 FROM expected e FULL JOIN recorded t ON t.person_id=e.person_id
)
SELECT s.id AS "sessionId",s.version AS "sessionVersion",s.class_id AS "classId",s.hub_id AS "hubId",s.status,s.class_active AS "classActive",s.starts_at::text AS "startsAt",s.ends_at::text AS "endsAt",s.starts_at<=statement_timestamp() AS "sessionStarted",s.ends_at<=statement_timestamp() AS "sessionEnded",s.attendance_source->>'on' AS on,s.time_zone AS "timeZone",statement_timestamp()::text AS "snapshotAt",
 (s.attendance_source IS NOT NULL AND coalesce(s.attendance_source->>'tooLarge','false')<>'true') AS "sourceValid",coalesce(s.attendance_source->>'tooLarge','false')='true' AS "rosterTooLarge",s.attendance_version AS "attendanceVersion",
 CASE WHEN s.attendance_version IS NOT NULL THEN s.attendance_context IS NOT DISTINCT FROM s.attendance_source END AS "attendanceCurrent",s.attendance_entry_count AS "attendanceEntryCount",s.report_version AS "reportVersion",
 CASE WHEN s.report_version IS NOT NULL THEN s.report_source IS NOT NULL AND s.report_context IS NOT DISTINCT FROM s.report_source END AS "reportCurrent",
 EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(s.document->'blocks','[]'::jsonb)) b WHERE b->>'kind'='text' AND length(btrim(b->>'text'))>0) AS "hasReportText",
 (SELECT count(*)::integer FROM jsonb_array_elements(coalesce(s.document->'blocks','[]'::jsonb)) b WHERE b->>'kind'='media') AS "mediaReferenceCount",
 (SELECT count(*)::integer FROM staff) AS "staffCount",coalesce((SELECT jsonb_agg(to_jsonb(t) ORDER BY "personId") FROM(SELECT * FROM staff ORDER BY "personId" LIMIT 201) t),'[]'::jsonb) staff FROM basis s`;

export async function sessionEvidenceReport(ctx:ApiContext):Promise<Reply|null>{
 const match=/^reports\/learning\/sessions\/([^/]+)\/evidence$/.exec(ctx.path);if(!match)return null;if(ctx.request.method!=='GET')throw new ApiError(405,'METHOD_NOT_ALLOWED');
 const params=new URL(ctx.request.url).searchParams;if([...params].length)throw new ApiError(400,'INVALID_QUERY');const id=uuid.parse(match[1]);await lockApprovalWrites(ctx);
 const scopes=capabilities.map(c=>permissionScope(ctx,c));const r=(await ctx.db.query<Snapshot>(sql,[id,JSON.stringify(scopes)])).rows[0];if(!r)throw new ApiError(404,'NOT_FOUND');if(r.staffCount>200||r.rosterTooLarge)throw new ApiError(422,'SESSION_EVIDENCE_REQUIRES_BACKGROUND_JOB');
 const expected=r.staff.filter(s=>s.expected),missingTime=expected.filter(s=>!s.entryId).length,staleTime=r.staff.filter(s=>s.entryId&&(s.sessionVersion!==r.sessionVersion||!s.assignmentCurrent)).length;
 const checks=[{id:'session_source',state:r.sourceValid?'recorded':'invalid'},{id:'attendance',state:!r.attendanceVersion?'missing':r.attendanceCurrent?'recorded':'stale'},{id:'report_text',state:!r.hasReportText?'missing':r.reportCurrent?'recorded':'stale'},{id:'media',state:!r.mediaReferenceCount?'missing':r.reportCurrent?'reference_only':'stale'},{id:'staff_time',state:missingTime?'missing':staleTime?'stale':expected.length?'recorded':'not_applicable'}];
 return {status:200,body:{data:{...r,staff:r.staff.map(s=>({...s,scheduleChanged:s.entryId?s.sessionVersion!==r.sessionVersion:null})),checks,
 summary:{expectedStaff:expected.length,recordedStaff:r.staff.filter(s=>s.entryId).length,missingStaffTime:missingTime,staleStaffTime:staleTime,retainedUnassignedTime:r.staff.filter(s=>!s.expected&&s.entryId).length,missingChecks:checks.filter(c=>c.state==='missing').length,staleChecks:checks.filter(c=>c.state==='stale').length,invalidChecks:checks.filter(c=>c.state==='invalid').length},
 expectedStaffBasis:'current_effective_assignments_on_verified_session_local_day',savedTimeBasis:'all_retained_session_time_including_retired_assignments',mediaBasis:'metadata_references_not_verified_uploads',approvalState:'not_determined_by_this_report',payrollEligibility:'not_determined_by_this_report',earnedLiability:'not_determined_by_this_report',permissionsAppliedBeforeProjection:true}}};
}
export const sessionEvidenceReportContract=[{path:'/api/v1/reports/learning/sessions/{id}/evidence',method:'get',summary:'Same-snapshot staff evidence checklist: complete current attendance/report sources, pending media references, each effective staff member and retained delivered time; requires all six source permissions, no private bodies, no payroll approval or earned-liability decision; 200-person synchronous bound'}] as const;
