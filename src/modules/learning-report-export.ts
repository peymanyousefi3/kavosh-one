import { z } from 'zod';
import type { ApiContext,Reply } from '../core/api.ts';
import { ApiError } from '../core/policy.ts';
import { csvRow,csvText } from '../core/csv.ts';
import type { ResolvedReportWindow } from '../core/report-window.ts';
import { sessionEvidenceData } from './session-evidence-report.ts';
import { sessionFollowUpData,sessionFollowUpQuery } from './session-follow-up.ts';

// ponytail: one native snapshot,200 sessions/200 staff per session/4MiB.
// Larger selections require queued generation,never page stitching or truncation.
const limit=200,byteLimit=4_194_304,uuid=z.string().uuid().transform(v=>v.toLowerCase());
type Cell=string|number|boolean|null|undefined;
type Provenance={id:string;version:number;dateWindow?:ResolvedReportWindow&{overriddenFields?:string[]}};
function attachment(header:string[],rows:Cell[][],filename:string,metadata:Record<string,unknown>,provenance?:Provenance):Reply{
 const meta={...metadata,exportCompleteness:'complete_permitted_report_within_limits',textPolicy:'Formula-like text uses a visible text: prefix; original records unchanged.',unknownPolicy:'Unknown values are blank,not zero.',numericPrecisionPolicy:'Durations in exact decimal milliseconds; import as text.',...(provenance?{presetId:provenance.id,presetVersion:provenance.version,...(provenance.dateWindow?{dateWindow:provenance.dateWindow}:{})}:{})};
 const all:Cell[][]=[header,...Object.entries(meta).filter(([,v])=>v!==undefined).map(([k,v])=>['metadata',k,v===null?null:typeof v==='string'?v:JSON.stringify(v)]),...rows];
 const body='\uFEFF'+all.map(row=>csvRow(Array.from({length:header.length},(_,i)=>typeof row[i]==='string'?csvText(row[i]):row[i]))).join('\r\n')+'\r\n';
 if(Buffer.byteLength(body)>byteLimit)throw new ApiError(422,'LEARNING_REPORT_REQUIRES_BACKGROUND_JOB');return {status:200,body,csv:{filename}};
}
export async function completeLearningExport(ctx:ApiContext,provenance?:Provenance):Promise<Reply>{
 const params=new URL(ctx.request.url).searchParams;if([...params].length!==new Set(params.keys()).size)throw new ApiError(400,'DUPLICATE_QUERY');
 if([...params.keys()].some(k=>/^(?:limit|snapshot|after.*)$/i.test(k)))throw new ApiError(400,'EXPORT_PAGINATION_NOT_ALLOWED');
 const match=/^reports\/learning\/sessions\/([^/]+)\/evidence$/.exec(ctx.path);
 if(match){
  const d=await sessionEvidenceData(ctx,uuid.parse(match[1])),header=['section','field','value','session_id','class_id','hub_id','person_id','assignment_id','assignment_version','role','expected','entry_id','entry_version','recorded_session_version','assignment_current','starts_at','ends_at','recorded_milliseconds','outside_schedule_milliseconds','schedule_changed'],rows:Cell[][]=[];
  for(const c of d.checks)rows.push(['check',c.id,c.state,d.sessionId,d.classId,d.hubId]);
  for(const s of d.staff)rows.push(['staff','','',d.sessionId,d.classId,d.hubId,s.personId,s.assignmentId,s.assignmentVersion,s.role,s.expected,s.entryId,s.entryVersion,s.sessionVersion,s.assignmentCurrent,s.startsAt,s.endsAt,s.recordedMilliseconds,s.outsideScheduleMilliseconds,s.scheduleChanged]);
  const {staff:_staff,checks:_checks,...metadata}=d;return attachment(header,rows,`session-evidence-${d.sessionId}.csv`,metadata,provenance);
 }
 if(ctx.path!=='reports/learning/session-follow-up')throw new Error('LEARNING_EXPORT_REPORT_INVALID');
 const d=await sessionFollowUpData(ctx,limit),header=['section','field','value','session_id','class_id','hub_id','session_version','status','starts_at','ends_at','local_date','time_zone','snapshot_at','state','needs_attention','due_at','overdue','review_version','review_decision','review_source_current','waive_report','waive_media','waivers_effective','expected_staff','recorded_staff','missing_staff_time','stale_staff_time','retained_unassigned_time','missing_checks','stale_checks','invalid_checks','attendance','report_text','media','staff_time','session_source'],rows:Cell[][]=[];
 for(const s of d.data){const v=s.summary!,review=s.review;rows.push(['session','','',s.sessionId,s.classId,s.hubId,s.sessionVersion,s.status,s.startsAt,s.endsAt,s.on,s.timeZone,s.snapshotAt,s.state,s.needsAttention,s.dueAt,s.overdue,review?.version,review?.decision,review?.sourceCurrent,review?.waiveReport,review?.waiveMedia,s.waiversEffective,v.expectedStaff,v.recordedStaff,v.missingStaffTime,v.staleStaffTime,v.retainedUnassignedTime,v.missingChecks,v.staleChecks,v.invalidChecks,...['attendance','report_text','media','staff_time','session_source'].map(id=>s.checks.find(c=>c.id===id)?.state)]);}
 const {data:_data,nextCursor:_nextCursor,pageSummary:summary,...metadata}=d;
 return attachment(header,rows,'session-follow-up.csv',{...metadata,summary,mediaBasis:'metadata_references_not_verified_uploads',earnedLiabilityDetermined:false},provenance);
}
export async function learningReportExport(ctx:ApiContext):Promise<Reply|null>{
 if(!/^reports\/learning\/(?:session-follow-up|sessions\/[^/]+\/evidence)\/export$/.test(ctx.path))return null;
 if(ctx.request.method!=='GET')throw new ApiError(405,'METHOD_NOT_ALLOWED');const path=ctx.path.slice(0,-'/export'.length),url=new URL(ctx.request.url);url.pathname='/api/v1/'+path;return completeLearningExport({...ctx,path,request:new Request(url)});
}
export const learningReportExportContract=[
 {path:'/api/v1/reports/learning/session-follow-up/export',method:'get',summary:'Complete same-snapshot session follow-up CSV under all seven current source rights before selection. Includes exact current input reviews,waivers,overdue flags and complete filtered summary,not payroll approval or verified uploads. At most200sessions/200staff per session/4MiB;oversized selections refuse without a partial attachment. No page/cursor parameters,private reasons,report text,students or storage keys.',querySchema:(sessionFollowUpQuery as z.ZodObject).safeExtend({limit:z.never().optional(),afterStartsAt:z.never().optional(),afterId:z.never().optional()}),responseContentType:'text/csv' as const},
 {path:'/api/v1/reports/learning/sessions/{id}/evidence/export',method:'get',summary:'Complete single-session evidence CSV from the original six-right source snapshot,with exact staff time,durations,currentness and missing/stale check states. No private report/attendance bodies,file keys or source digests;does not decide payroll or certify media uploads.200staff/4MiB bound,no query parameters.',responseContentType:'text/csv' as const}
] as const;
