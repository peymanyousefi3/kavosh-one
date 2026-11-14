import type { ApiContext } from '../core/api.ts';
import { permissionScope } from '../core/approvals.ts';
import { ApiError } from '../core/policy.ts';
import { sessionEvidenceCapabilities } from './session-evidence-report.ts';

type Earning={kind:string;sourceId:string;allocationId:string;personId:string;hubId:string|null;currencyId:string;unitScale:number;minor:string;postedOn:string;dueOn:string;from:string;through:string};
type Ref={sourceId:string;kind:string;sessionId:string;classId:string;hubId:string;entryId:string|null;entryVersion:number|null;currentEntryVersion:number|null;currentPersonId:string|null;currentSessionId:string|null};
type Staff={personId:string;entryId:string|null;entryVersion:number|null;sessionVersion:number|null;assignmentCurrent:boolean|null;recordedMilliseconds:string|null;outsideScheduleMilliseconds:string|null};
type Snapshot={sessionId:string;sessionVersion:number;classId:string;hubId:string;status:string;classActive:boolean;sessionEnded:boolean;sourceValid:boolean;rosterTooLarge:boolean;staffCount:number;staff:Staff[];attendanceVersion:number|null;attendanceCurrent:boolean|null;reportVersion:number|null;reportTextCurrent:boolean|null;hasReportText:boolean;reportCurrent:boolean|null;mediaReferenceCount:number};
type Session={snapshot:Snapshot;reviewVersion:number|null;decision:string|null;waiveReport:boolean|null;waiveMedia:boolean|null;reviewCurrent:boolean};
export function assertPayrunReadinessBounds(sessions:number,entries:number){if(sessions>200||entries>2000)throw new ApiError(422,'PAYRUN_READINESS_REQUIRES_BACKGROUND_JOB');}

// Resolve all retained and current class contexts BEFORE reporting a budget
// error or returning a partial checklist. All priced hourly sources matter,
// including shadowed classes whose conserved allocation is zero cents.
const refsSQL=`WITH items AS MATERIALIZED(SELECT * FROM jsonb_to_recordset($1::jsonb) r(kind text,"sourceId" uuid,"allocationId" uuid)),
 parents AS MATERIALIZED(SELECT DISTINCT h.id,h.earning_plan FROM items i JOIN public.payroll_hourly_accruals h ON i.kind='hourly' AND h.id=i."sourceId"),
 refs AS MATERIALIZED(
 SELECT DISTINCT p.id source_id,'hourly'::text kind,(s->>'sessionId')::uuid session_id,(s->>'classId')::uuid class_id,(s->>'hubId')::uuid hub_id,(s->>'entryId')::uuid entry_id,(s->>'entryVersion')::integer entry_version
 FROM parents p CROSS JOIN LATERAL jsonb_array_elements(coalesce(p.earning_plan->'sourceAssessments','[]'::jsonb)) s
 UNION SELECT x.id,'tuition_session',x.session_id,(x.source_snapshot#>>'{tuition,classId}')::uuid,x.hub_id,NULL::uuid,NULL::integer FROM items i JOIN public.payroll_tuition_session_accruals x ON i.kind='tuition_session' AND x.id=i."sourceId"
),contexts AS MATERIALIZED(
 SELECT class_id,hub_id FROM refs UNION SELECT t.class_id,t.hub_id FROM refs r JOIN public.session_time_entries t ON t.id=r.entry_id UNION SELECT s.class_id,s.hub_id FROM refs r JOIN public.class_sessions s ON s.id=r.session_id
),authority AS(SELECT NOT EXISTS(SELECT 1 FROM contexts c CROSS JOIN jsonb_array_elements($2::jsonb) p WHERE public.scope_contains(p,jsonb_build_object('all',false,'hubs','[]'::jsonb,'classes',jsonb_build_array(jsonb_build_object('id',c.class_id,'hubId',c.hub_id)))) IS NOT TRUE) allowed),
 bounds AS(SELECT count(*)::integer entries,count(DISTINCT session_id)::integer sessions FROM refs)
 SELECT a.allowed,b.entries,b.sessions,
 (SELECT count(*)::integer FROM parents WHERE jsonb_array_length(coalesce(earning_plan->'sourceAssessments','[]'::jsonb))=0) "unmappedHourlyParents",
 CASE WHEN a.allowed AND b.sessions<=200 AND b.entries<=2000 THEN coalesce((SELECT jsonb_agg(jsonb_build_object('sourceId',r.source_id,'kind',r.kind,'sessionId',r.session_id,'classId',r.class_id,'hubId',r.hub_id,'entryId',r.entry_id,'entryVersion',r.entry_version,'currentEntryVersion',t.version,'currentPersonId',t.person_id,'currentSessionId',t.session_id) ORDER BY r.session_id,r.source_id,r.entry_id) FROM refs r LEFT JOIN public.session_time_entries t ON t.id=r.entry_id),'[]'::jsonb) ELSE '[]'::jsonb END refs
 FROM authority a CROSS JOIN bounds b`;

export async function payrunRecordedSources(ctx:ApiContext,run:{id:string;source_snapshot:{items:Earning[]}}){
 return(await ctx.db.query<{kind:string;sourceId:string;allocationId:string;sourceCurrent:boolean;claimCurrent:boolean}>(`SELECT v->>'kind' kind,v->>'sourceId' "sourceId",v->>'allocationId' "allocationId",
 coalesce(c.void_id IS NULL AND c.person_id::text=v->>'personId' AND c.hub_id::text IS NOT DISTINCT FROM v->>'hubId' AND c.currency_id::text=v->>'currencyId' AND c.unit_scale=(v->>'unitScale')::integer AND c.amount_minor=(v->>'minor')::numeric AND c.posted_on=(v->>'postedOn')::date AND c.due_on=(v->>'dueOn')::date AND c.from_on=(v->>'from')::date AND c.through_on=(v->>'through')::date,false) "sourceCurrent",
 EXISTS(SELECT 1 FROM public.payrun_earning_claims q WHERE q.run_id=$2 AND q.kind=v->>'kind' AND q.source_id=(v->>'sourceId')::uuid AND q.allocation_id=(v->>'allocationId')::uuid AND q.released_by IS NULL) "claimCurrent"
 FROM jsonb_array_elements($1::jsonb) v LEFT JOIN public.payrun_earning_catalogue c ON c.kind=v->>'kind' AND c.source_id=(v->>'sourceId')::uuid AND c.allocation_id=(v->>'allocationId')::uuid ORDER BY v->>'kind',v->>'sourceId',v->>'allocationId'`,[JSON.stringify(run.source_snapshot.items),run.id])).rows;
}
export async function payrunReadiness(ctx:ApiContext,run:{id:string;person_id:string;cancellation_id:string|null;source_snapshot:{items:Earning[]}}){
 const items=run.source_snapshot.items,scopes=[...sessionEvidenceCapabilities,'session-evidence.view' as const].map(c=>permissionScope(ctx,c)),ceiling={all:ctx.credential.all_hubs,hubs:ctx.credential.hub_ids};
 const refs=(await ctx.db.query<{allowed:boolean;entries:number;sessions:number;unmappedHourlyParents:number;refs:Ref[]}>(refsSQL,[JSON.stringify(items),JSON.stringify([...scopes,ceiling])])).rows[0];
 if(!refs.allowed)throw new ApiError(404,'NOT_FOUND');assertPayrunReadinessBounds(refs.sessions,refs.entries);
 const sources=await payrunRecordedSources(ctx,run);
 const ids=[...new Set(refs.refs.map(r=>r.sessionId))].sort();
const rows=(await ctx.db.query<Session>(`WITH snapshots AS MATERIALIZED(SELECT id,public.session_evidence_snapshot_read(id) snapshot FROM public.class_sessions WHERE id=ANY($1::uuid[]))
 SELECT s.snapshot,r.version "reviewVersion",r.decision,r.waive_report "waiveReport",r.waive_media "waiveMedia",coalesce(r.source=s.snapshot-ARRAY['snapshotAt','sessionStarted','sessionEnded'],false) "reviewCurrent" FROM snapshots s LEFT JOIN public.session_evidence_reviews r ON r.session_id=s.id ORDER BY s.id`,[ids])).rows;
 if(rows.some(r=>r.snapshot.staffCount>200||r.snapshot.rosterTooLarge))throw new ApiError(422,'PAYRUN_READINESS_REQUIRES_BACKGROUND_JOB');
 const bySession=new Map<string,Ref[]>();for(const ref of refs.refs)if(ref.entryId!==null){const group=bySession.get(ref.sessionId)??[];group.push(ref);bySession.set(ref.sessionId,group);}
 const sessions=rows.map(r=>{
  const s=r.snapshot,staff=s.staff.filter(v=>v.personId===run.person_id),entryRefs=bySession.get(s.sessionId)??[],timePresent=staff.some(v=>v.entryId!==null),timeSourceCurrent=entryRefs.every(v=>v.currentEntryVersion===v.entryVersion&&v.currentPersonId===run.person_id&&v.currentSessionId===v.sessionId),personalTimeCurrent=timePresent&&timeSourceCurrent&&staff.every(v=>v.entryId!==null&&v.sessionVersion===s.sessionVersion&&v.assignmentCurrent===true),reviewAccepted=r.decision==='accepted'&&r.reviewCurrent;
  const reportPresent=s.hasReportText&&s.reportTextCurrent===true,mediaReferenced=s.mediaReferenceCount>0&&s.reportCurrent===true,reportSatisfied=reportPresent||reviewAccepted&&r.waiveReport===true,mediaSatisfied=mediaReferenced||reviewAccepted&&r.waiveMedia===true;
  return {sessionId:s.sessionId,classId:s.classId,hubId:s.hubId,evidencePath:'/api/v1/reports/learning/sessions/'+s.sessionId+'/evidence',reviewPath:'/api/v1/sessions/'+s.sessionId+'/evidence-review',sessionVersion:s.sessionVersion,sessionEnded:s.sessionEnded,sessionStatus:s.status,classActive:s.classActive,sourceValid:s.sourceValid,attendanceVersion:s.attendanceVersion,attendanceCurrent:s.attendanceCurrent===true,reportVersion:s.reportVersion,reportTextCurrent:reportPresent,mediaReferenceCount:s.mediaReferenceCount,mediaReferencesCurrent:mediaReferenced,reportRequirementSatisfied:reportSatisfied,mediaReferenceRequirementSatisfied:mediaSatisfied,reviewVersion:r.reviewVersion,reviewDecision:r.decision,reviewSourceCurrent:r.reviewCurrent,inputReviewAccepted:reviewAccepted,reportExceptionApplied:reviewAccepted&&r.waiveReport===true,mediaExceptionApplied:reviewAccepted&&r.waiveMedia===true,personalTimePresent:timePresent,personalTimeCurrent,retainedTimeSourceCurrent:timeSourceCurrent,
   personalTime:staff.map(v=>({entryId:v.entryId,entryVersion:v.entryVersion,recordedMilliseconds:v.recordedMilliseconds,outsideScheduleMilliseconds:v.outsideScheduleMilliseconds,scheduleChanged:v.sessionVersion!==s.sessionVersion})),
   classInputReviewCurrent:s.sourceValid&&s.sessionEnded&&s.status==='scheduled'&&s.classActive&&s.attendanceCurrent===true&&reportSatisfied&&mediaSatisfied&&personalTimeCurrent&&reviewAccepted};
 });
 const unresolved=items.filter(i=>i.kind==='tuition_course'||i.kind==='tuition_collection').map(i=>({kind:i.kind,sourceId:i.sourceId,allocationId:i.allocationId,code:'EXPLICIT_SERVICE_EVIDENCE_MAPPING_REQUIRED'}));
 const cancelled=run.cancellation_id!==null,sourceCurrent=sources.length===items.length&&sources.every(s=>s.sourceCurrent&&s.claimCurrent),missingSessions=ids.length!==sessions.length;
 return {runId:run.id,runStatus:cancelled?'cancelled':'gross_grouped',recordedSourcesCurrent:sourceCurrent,sourceChecks:sources,sessionCount:sessions.length,retainedEntryReferences:refs.entries,sessions,unresolvedEvidenceMappings:unresolved,unmappedHourlyParents:refs.unmappedHourlyParents,
  classInputReviewCurrent:!cancelled&&sourceCurrent&&!missingSessions&&!refs.unmappedHourlyParents&&!unresolved.length&&sessions.length>0&&sessions.every(s=>s.classInputReviewCurrent),
  classEvidenceCoverage:'all_priced_sources_of_selected_hourly_parents_including_shadowed_classes_and_explicit_session_tuition',
  otherEarningKinds:items.filter(i=>!['hourly','tuition_session','tuition_course','tuition_collection'].includes(i.kind)).map(i=>({kind:i.kind,sourceId:i.sourceId,allocationId:i.allocationId,classEvidenceMapping:'not_defined_by_this_gross_source'})),
  missingSessionSources:missingSessions,recordedGrossScope:'recorded_amount_dates_and_live_payrun_claims_only',underlyingTuitionSourcesVerified:false,payoutReady:false,teacherAgreementVerified:false,mediaContentDeliveryVerified:false,statutoryDeductionsCalculated:false,netPayCalculated:false,paymentApproved:false,paymentExecuted:false,earnedWagesErased:false,accountingModified:false,
  basis:'current_read_only_same_request_checks_not_a_retained_payout_clearance',snapshotConsistency:'per_statement_read_committed_not_retained_for_payment',reviewedMediaBasis:'metadata_references_only_not_clean_uploaded_bytes',sourcePermissionsAppliedBeforeProjection:true};
}
