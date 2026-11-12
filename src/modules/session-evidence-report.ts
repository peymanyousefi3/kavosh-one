import { z } from 'zod';
import type { ApiContext,Reply } from '../core/api.ts';
import { lockApprovalWrites,permissionScope } from '../core/approvals.ts';
import { ApiError,type Capability } from '../core/policy.ts';

const uuid=z.string().uuid().transform(v=>v.toLowerCase());
export const sessionEvidenceCapabilities:Capability[]=['session-reports.view','attendance.view','rosters.view','session-time.view','staff.view','files.view'];
type Staff={personId:string;assignmentId:string|null;assignmentVersion:number|null;role:string|null;expected:boolean;entryId:string|null;entryVersion:number|null;sessionVersion:number|null;assignmentCurrent:boolean|null;startsAt:string|null;endsAt:string|null;recordedMilliseconds:string|null;outsideScheduleMilliseconds:string|null};
export type EvidenceSnapshot={sessionId:string;sessionVersion:number;classId:string;hubId:string;status:string;classActive:boolean;startsAt:string;endsAt:string;sessionStarted:boolean;sessionEnded:boolean;on:string|null;timeZone:string;snapshotAt:string;sourceValid:boolean;rosterTooLarge:boolean;attendanceVersion:number|null;attendanceCurrent:boolean|null;attendanceEntryCount:number|null;reportVersion:number|null;reportCurrent:boolean|null;reportTextCurrent:boolean|null;hasReportText:boolean;mediaReferenceCount:number;staffCount:number;staff:Staff[];sourceDigests:Record<string,string>};
export function sessionEvidenceChecks(r:Omit<EvidenceSnapshot,'sourceDigests'>){
 const expected=r.staff.filter(s=>s.expected),missingTime=expected.filter(s=>!s.entryId).length,staleTime=r.staff.filter(s=>s.entryId&&(s.sessionVersion!==r.sessionVersion||!s.assignmentCurrent)).length;
 const checks=[{id:'session_source',state:r.sourceValid?'recorded':'invalid'},{id:'attendance',state:!r.attendanceVersion?'missing':r.attendanceCurrent?'recorded':'stale'},{id:'report_text',state:!r.hasReportText?'missing':r.reportTextCurrent?'recorded':'stale'},{id:'media',state:!r.mediaReferenceCount?'missing':r.reportCurrent?'reference_only':'stale'},{id:'staff_time',state:missingTime?'missing':staleTime?'stale':expected.length?'recorded':'not_applicable'}];
 return {checks,summary:{expectedStaff:expected.length,recordedStaff:r.staff.filter(s=>s.entryId).length,missingStaffTime:missingTime,staleStaffTime:staleTime,retainedUnassignedTime:r.staff.filter(s=>!s.expected&&s.entryId).length,missingChecks:checks.filter(c=>c.state==='missing').length,staleChecks:checks.filter(c=>c.state==='stale').length,invalidChecks:checks.filter(c=>c.state==='invalid').length}};
}
// One statement snapshot. Resolve private records only inside the authorized
// class; return counts/references, never student notes, report text or file keys.
// ponytail: synchronous output stops at 200 staff; refuse larger checklists
// until the shared background-report workflow handles them without truncation.
const authoritySQL=`SELECT s.id,s.class_id,s.hub_id FROM public.class_sessions s WHERE s.id=$1 AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements($2::jsonb) scope WHERE public.scope_contains(scope,jsonb_build_object('all',false,'hubs','[]'::jsonb,'classes',jsonb_build_array(jsonb_build_object('id',s.class_id,'hubId',s.hub_id)))) IS NOT TRUE)`;
const sql=(readOnly:boolean)=>`WITH permitted AS MATERIALIZED(${authoritySQL}) SELECT public.${readOnly?'session_evidence_snapshot_read':'session_evidence_snapshot'}(id) snapshot FROM permitted`;

export async function sessionEvidenceReport(ctx:ApiContext):Promise<Reply|null>{
 const match=/^reports\/learning\/sessions\/([^/]+)\/evidence$/.exec(ctx.path);if(!match)return null;if(ctx.request.method!=='GET')throw new ApiError(405,'METHOD_NOT_ALLOWED');
 return {status:200,body:{data:await sessionEvidenceData(ctx,uuid.parse(match[1]))}};
}
export async function sessionEvidenceData(ctx:ApiContext,id:string){
 const params=new URL(ctx.request.url).searchParams;if([...params].length)throw new ApiError(400,'INVALID_QUERY');await lockApprovalWrites(ctx);
 const {sourceDigests:_sourceDigests,...r}=await sessionEvidenceSnapshot(ctx,id,[],true);
 return {...r,staff:r.staff.map(s=>({...s,scheduleChanged:s.entryId?s.sessionVersion!==r.sessionVersion:null})),...sessionEvidenceChecks(r),
 expectedStaffBasis:'current_effective_assignments_on_verified_session_local_day',savedTimeBasis:'all_retained_session_time_including_retired_assignments',mediaBasis:'metadata_references_not_verified_uploads',approvalState:'not_determined_by_this_report',payrollEligibility:'not_determined_by_this_report',earnedLiability:'not_determined_by_this_report',permissionsAppliedBeforeProjection:true};
}
export const sessionEvidenceReportContract=[{path:'/api/v1/reports/learning/sessions/{id}/evidence',method:'get',summary:'Same-snapshot staff evidence checklist: complete current attendance/report sources, pending media references, each effective staff member and retained delivered time; requires all six source permissions, no private bodies, no payroll approval or earned-liability decision; 200-person synchronous bound'}] as const;
export async function sessionEvidenceSnapshot(ctx:ApiContext,id:string,extra:Capability[]=[],readOnly=false){
 const scopes=[...sessionEvidenceCapabilities,...extra].map(c=>permissionScope(ctx,c));const r=(await ctx.db.query<{snapshot:EvidenceSnapshot|null}>(sql(readOnly),[id,JSON.stringify(scopes)])).rows[0]?.snapshot;if(!r)throw new ApiError(404,'NOT_FOUND');if(r.staffCount>200||r.rosterTooLarge)throw new ApiError(422,'SESSION_EVIDENCE_REQUIRES_BACKGROUND_JOB');return r;
}
export async function sessionEvidenceAuthority(ctx:ApiContext,id:string,extra:Capability[]=[]){
 const scopes=[...sessionEvidenceCapabilities,...extra].map(c=>permissionScope(ctx,c)),r=(await ctx.db.query<{class_id:string;hub_id:string}>(authoritySQL,[id,JSON.stringify(scopes)])).rows[0];if(!r)throw new ApiError(404,'NOT_FOUND');return {all:false,hubs:[],classes:[{id:r.class_id,hubId:r.hub_id}]};
}
