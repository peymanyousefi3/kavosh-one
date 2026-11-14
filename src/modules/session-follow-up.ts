import { z } from 'zod';
import type { ApiContext,Reply } from '../core/api.ts';
import { lockApprovalWrites,permissionScope } from '../core/approvals.ts';
import { ApiError,scopeNonempty } from '../core/policy.ts';
import { sessionEvidenceCapabilities,sessionEvidenceChecks,type EvidenceSnapshot } from './session-evidence-report.ts';

const uuid=z.string().uuid().transform(v=>v.toLowerCase()),instant=z.iso.datetime({offset:true});
export const sessionFollowUpQuery=z.object({from:instant,through:instant,hubId:uuid.optional(),classId:uuid.optional(),status:z.enum(['scheduled','cancelled','all']).default('scheduled'),attention:z.enum(['all','needs_attention','overdue']).optional(),graceMinutes:z.coerce.number().int().min(0).max(43200).default(1440),limit:z.coerce.number().int().min(1).max(50).default(25),afterStartsAt:instant.optional(),afterId:uuid.optional()}).strict().refine(q=>(q.afterStartsAt===undefined)===(q.afterId===undefined)).refine(q=>Date.parse(q.through)>=Date.parse(q.from)&&Date.parse(q.through)-Date.parse(q.from)<=366*86400000,'Select an inclusive start-time range of at most366days.');
type Row={snapshot:EvidenceSnapshot;starts_at:string;due_at:string;past_due:boolean;needs_attention:boolean;review_version:number|null;decision:'accepted'|'needs_changes'|'rejected'|null;review_current:boolean;waive_report:boolean|null;waive_media:boolean|null};
const attentionScanLimit=100;
function sourceCTEs(maximum?:number){return `WITH selected AS MATERIALIZED(
 SELECT s.academy_id,s.id,s.starts_at FROM public.class_sessions s WHERE s.starts_at BETWEEN $1::timestamptz AND $2::timestamptz
 AND($3::uuid IS NULL OR s.hub_id=$3) AND($4::uuid IS NULL OR s.class_id=$4) AND($5='all' OR s.status=$5)
 AND(s.starts_at,s.id)>(coalesce($6::timestamptz,'-infinity'),coalesce($7::uuid,'00000000-0000-0000-0000-000000000000'::uuid))
 AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements($8::jsonb) scope WHERE public.scope_contains(scope,jsonb_build_object('all',false,'hubs','[]'::jsonb,'classes',jsonb_build_array(jsonb_build_object('id',s.class_id,'hubId',s.hub_id)))) IS NOT TRUE)
 ORDER BY s.starts_at,s.id LIMIT ${maximum===undefined?'$9':maximum+1}
),snapshots AS MATERIALIZED(SELECT p.academy_id,p.id,p.starts_at,public.session_evidence_snapshot_read(p.id) snapshot FROM selected p ORDER BY p.starts_at,p.id${maximum===undefined?'':' LIMIT '+maximum})`;}
const projectionSQL=`SELECT p.snapshot,to_char(p.starts_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') starts_at,
 to_char(((p.snapshot->>'endsAt')::timestamptz+$10::integer*interval '1 minute') AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') due_at,
 (p.snapshot->>'endsAt')::timestamptz+$10::integer*interval '1 minute'<=statement_timestamp() past_due,
 public.session_follow_up_attention(p.snapshot,r.source,r.decision) needs_attention,r.version review_version,r.decision,r.source IS NOT DISTINCT FROM(p.snapshot-ARRAY['snapshotAt','sessionStarted','sessionEnded']) review_current,r.waive_report,r.waive_media
 FROM snapshots p LEFT JOIN public.session_evidence_reviews r ON r.academy_id=p.academy_id AND r.session_id=p.id ORDER BY p.starts_at,p.id`;
const sql=sourceCTEs()+' '+projectionSQL;
// ponytail: inspect at most100 authorized candidates per attention request.
// Continue even after an empty page;complete exports retain their200source cap.
function attentionSQL(maximum:number){return sourceCTEs(maximum)+`,evaluated AS MATERIALIZED(${projectionSQL}),
 matches AS(SELECT * FROM evaluated WHERE needs_attention AND($11='needs_attention' OR past_due) ORDER BY starts_at,snapshot->>'sessionId' LIMIT $9)
 SELECT coalesce((SELECT jsonb_agg(to_jsonb(m) ORDER BY starts_at,snapshot->>'sessionId') FROM matches m),'[]'::jsonb) entries,
 (SELECT count(*)::integer FROM snapshots) scanned,(SELECT count(*)>${maximum} FROM selected) "moreCandidates",EXISTS(SELECT 1 FROM snapshots WHERE snapshot IS NULL) "invalidSource",
 (SELECT jsonb_build_object('afterStartsAt',to_char(p.starts_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'afterId',p.id) FROM snapshots p ORDER BY p.starts_at DESC,p.id DESC LIMIT 1) "nextCandidateCursor"`;}

function view(row:Row){
 const r=row.snapshot,oversized=r.staffCount>200||r.rosterTooLarge,review=row.review_version?{version:row.review_version,decision:row.decision,sourceCurrent:row.review_current,waiveReport:row.waive_report,waiveMedia:row.waive_media}:null,waiversEffective=review?.decision==='accepted'&&review.sourceCurrent;
 const evidence=oversized?null:sessionEvidenceChecks(r),checks=evidence?.checks.map(c=>({...c,state:waiversEffective&&((c.id==='report_text'&&review.waiveReport)||(c.id==='media'&&review.waiveMedia))?'waived':c.state}))??[];
 // A current exact human decision is authoritative for this input review.
 // Keep its warning flags;do not reopen it merely for warnings it reviewed.
 const state=r.status==='cancelled'?'cancelled':!r.sessionEnded?'not_due':oversized?'requires_background':review?.sourceCurrent?review.decision:checks.some(c=>c.state==='invalid')?'invalid_source':checks.some(c=>c.state==='missing')?'inputs_missing':checks.some(c=>c.state==='stale')?'inputs_stale':review?'review_stale':'awaiting_review',needsAttention=row.needs_attention;
 return {sessionId:r.sessionId,classId:r.classId,hubId:r.hubId,sessionVersion:r.sessionVersion,status:r.status,startsAt:r.startsAt,endsAt:r.endsAt,on:r.on,timeZone:r.timeZone,snapshotAt:r.snapshotAt,state,needsAttention,dueAt:row.due_at,overdue:needsAttention&&row.past_due,checks,summary:evidence?.summary??null,review,waiversEffective:Boolean(waiversEffective),mediaBasis:'metadata_references_not_verified_uploads',payrollApproved:false,earnedLiabilityDetermined:false};
}
export async function sessionFollowUp(ctx:ApiContext):Promise<Reply|null>{
 if(ctx.path!=='reports/learning/session-follow-up')return null;if(ctx.request.method!=='GET')throw new ApiError(405,'METHOD_NOT_ALLOWED');
 return {status:200,body:await sessionFollowUpData(ctx)};
}
export async function sessionFollowUpData(ctx:ApiContext,completeLimit?:number){
 if(completeLimit!==undefined&&(!Number.isInteger(completeLimit)||completeLimit<1||completeLimit>200))throw new Error('INVALID_SESSION_FOLLOW_UP_LIMIT');
 const p=new URL(ctx.request.url).searchParams;if([...p].length!==new Set(p.keys()).size)throw new ApiError(400,'DUPLICATE_QUERY');const q=sessionFollowUpQuery.parse(Object.fromEntries(p));await lockApprovalWrites(ctx);
 const scopes=[...sessionEvidenceCapabilities,'session-evidence.view' as const].map(c=>permissionScope(ctx,c));if(scopes.some(s=>!scopeNonempty(s)))throw new ApiError(403,'FORBIDDEN');
 const limit=completeLimit??q.limit,args=[q.from,q.through,q.hubId??null,q.classId??null,q.status,q.afterStartsAt??null,q.afterId??null,JSON.stringify(scopes),limit+1,q.graceMinutes];
 const maximum=completeLimit??attentionScanLimit,filtering=q.attention!==undefined&&q.attention!=='all',scan=filtering?(await ctx.db.query<{entries:Row[];scanned:number;moreCandidates:boolean;invalidSource:boolean;nextCandidateCursor:{afterStartsAt:string;afterId:string}|null}>(attentionSQL(maximum),[...args,q.attention])).rows[0]:undefined;
 if(filtering&&(!scan||scan.invalidSource||!Array.isArray(scan.entries)||scan.entries.length>limit+1||!Number.isInteger(scan.scanned)||scan.scanned<0||scan.scanned>maximum||typeof scan.moreCandidates!=='boolean'||(scan.moreCandidates&&!scan.nextCandidateCursor)))throw new Error('SESSION_FOLLOW_UP_SCAN_INVALID');
 const rows=scan?scan.entries:(await ctx.db.query<Row>(sql,args)).rows,selected=rows.slice(0,limit),data=selected.map(view),last=selected.at(-1),nextCursor=rows.length>limit?{afterStartsAt:last!.starts_at,afterId:last!.snapshot.sessionId}:scan?.moreCandidates?scan.nextCandidateCursor:null;
 if(completeLimit!==undefined&&(rows.length>limit||scan?.moreCandidates||data.some(r=>r.state==='requires_background'||r.summary===null)))throw new ApiError(422,'SESSION_FOLLOW_UP_REQUIRES_BACKGROUND_JOB');
 return {data,nextCursor,...(scan?{scan:{authorizedCandidatesExamined:scan.scanned,maximumAuthorizedCandidates:maximum,additionalAuthorizedCandidatesAvailable:scan.moreCandidates,continueEvenIfEmpty:data.length===0&&nextCursor!==null}}:{}),pageSummary:{sessions:data.length,needingAttention:data.filter(r=>r.needsAttention).length,overdue:data.filter(r=>r.overdue).length,accepted:data.filter(r=>r.state==='accepted').length,requiresBackground:data.filter(r=>r.state==='requires_background').length},summaryCoverage:completeLimit===undefined?'current_authorized_page_only':'complete_current_authorized_selection',filters:{from:q.from,through:q.through,status:q.status,graceMinutes:q.graceMinutes,...(q.attention?{attention:q.attention}:{}),...(q.hubId?{hubId:q.hubId}:{}),...(q.classId?{classId:q.classId}:{})},followUpBasis:'current_evidence_and_exact_current_review_not_notification_read_state',notificationsGenerated:false,payrollApproved:false,externalRequestMade:false};
}
export const sessionFollowUpContract=[{path:'/api/v1/reports/learning/session-follow-up',method:'get',summary:'Central current session follow-up list with source-permission filtering before precise start-time paging;optional needs_attention/overdue selection evaluates at most100authorized candidates before matching-page limits. Follow nextCursor even when data is empty;scan metadata prevents claiming no further issues from a bounded empty window. Missing/stale inputs,exact current decisions and reversible waivers,server-clock overdue and explicit oversized flags;seven source rights,hub/class/status/time filters,page-only totals,no private bodies or payroll decision;reading sends no notification. Unfiltered legacy paging is unchanged;complete filtered exports refuse unfinished scans.',querySchema:sessionFollowUpQuery}] as const;
