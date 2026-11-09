import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import type { ApiContext,Reply } from '../core/api.ts';
import { lockApprovalWrites } from '../core/approvals.ts';
import { ApiError } from '../core/policy.ts';
import { assessmentDefinition } from './assessment-rubrics.ts';
import { authorizeLearningRecipient,receivedLearningSelection } from './learning-recipients.ts';
import { studentFeedbackTargetSQL } from './student-feedback.ts';
import { accountingDate } from './finance-periods.ts';
import { performanceReportScope } from './student-performance-access.ts';

const uuid=z.string().uuid().transform(v=>v.toLowerCase()),version=z.number().int().min(1).max(2147483647);
const filters=z.object({from:accountingDate,through:accountingDate,classId:uuid.optional(),hubId:uuid.optional(),rubricId:uuid.optional(),rubricVersion:z.coerce.number().int().min(1).max(2147483647).optional()}).strict();
function ordered(q:z.infer<typeof filters>){return q.from<=q.through&&(Date.parse(q.through)-Date.parse(q.from))/86400000<=3660&&(q.rubricVersion===undefined||q.rubricId!==undefined);}
export const studentPerformanceQuery=filters.extend({studentId:uuid.optional(),visibility:z.enum(['all','published','private']).default('all')}).refine(ordered,'Choose an ordered range of at most3661days;rubricVersion also requires rubricId.');
export const familyPerformanceQuery=filters.refine(ordered,'Choose an ordered range of at most3661days;rubricVersion also requires rubricId.');
const rubric=assessmentDefinition.pick({name:true,criteria:true});
const observation=z.object({feedbackId:uuid,feedbackVersion:version,studentId:uuid,sessionId:uuid,classId:uuid,hubId:uuid,on:accountingDate,startsAt:z.iso.datetime({precision:6}),rubricId:uuid,rubricVersion:version,rubric,ratings:z.array(z.object({code:z.string(),score:z.number().int().min(1).max(5)}).strict()).min(1).max(30),publishedToFamily:z.boolean()}).strict();

type Point={feedbackId:string;feedbackVersion:number;sessionId:string;classId:string;hubId:string;on:string;startsAt:string;score:number;publishedToFamily:boolean};
type Criterion={code:string;labels:Record<string,string|undefined>;count:number;sum:number;average:{numerator:string;denominator:string};minimum:number;maximum:number;change:number|null;distribution:{score:number;count:number}[];points:Point[]};
type Series={studentId:string;rubricId:string;rubricVersion:number;rubricName:string;criteria:Criterion[]};
// ponytail: complete live and queued trends cap200feedbacks/6,000points/4MiB.
// Larger selections need chunked aggregation,never partial means.
export const performanceFeedbackLimit=200;
export function studentPerformanceData(raw:unknown,captureAuthorization=false){
 const observations=z.array(observation).max(performanceFeedbackLimit+1).parse(raw);if(observations.length>performanceFeedbackLimit)throw new ApiError(422,'STUDENT_PERFORMANCE_REQUIRES_BACKGROUND_JOB');
 const groups=new Map<string,Series>(),definitions=new Map<string,z.infer<typeof rubric>>();
 const seen=new Set<string>();let observationCount=0;
 for(const r of observations){
  if(seen.has(r.feedbackId))throw new Error('PERFORMANCE_DUPLICATE_FEEDBACK');seen.add(r.feedbackId);
  if(r.ratings.length!==r.rubric.criteria.length||new Set(r.ratings.map(v=>v.code)).size!==r.ratings.length||r.ratings.some(v=>!r.rubric.criteria.some(c=>c.code===v.code)))throw new Error('PERFORMANCE_RATINGS_INVALID');
  const rubricKey=r.rubricId+':'+r.rubricVersion,prior=definitions.get(rubricKey);if(prior&&!isDeepStrictEqual(prior,r.rubric))throw new Error('PERFORMANCE_RUBRIC_DEFINITION_CHANGED');definitions.set(rubricKey,r.rubric);
  const key=r.studentId+':'+rubricKey,g:Series=groups.get(key)??{studentId:r.studentId,rubricId:r.rubricId,rubricVersion:r.rubricVersion,rubricName:r.rubric.name,criteria:r.rubric.criteria.map(c=>({code:c.code,labels:c.labels,count:0,sum:0,average:{numerator:'0',denominator:'0'},minimum:5,maximum:1,change:null,distribution:[1,2,3,4,5].map(score=>({score,count:0})),points:[]}))};groups.set(key,g);
  for(const c of g.criteria){const score=r.ratings.find(v=>v.code===c.code)!.score;c.points.push({feedbackId:r.feedbackId,feedbackVersion:r.feedbackVersion,sessionId:r.sessionId,classId:r.classId,hubId:r.hubId,on:r.on,startsAt:r.startsAt,score,publishedToFamily:r.publishedToFamily});c.count++;c.sum+=score;c.minimum=Math.min(c.minimum,score);c.maximum=Math.max(c.maximum,score);c.distribution[score-1].count++;observationCount++;}
 }
 for(const g of groups.values())for(const c of g.criteria){c.points.sort((a,b)=>a.startsAt.localeCompare(b.startsAt)||a.feedbackId.localeCompare(b.feedbackId));c.average={numerator:String(c.sum),denominator:String(c.count)};c.change=c.count>1?c.points.at(-1)!.score-c.points[0].score:null;}
 const chartData=[...groups.values()].sort((a,b)=>a.studentId.localeCompare(b.studentId)||a.rubricId.localeCompare(b.rubricId)||a.rubricVersion-b.rubricVersion);
 return {...(captureAuthorization?{authorizationContext:{kind:'student_performance' as const,sources:observations.map(r=>({feedbackId:r.feedbackId,studentId:r.studentId,classId:r.classId,hubId:r.hubId}))}}:{}),chartData,summary:{feedbacks:observations.length,criterionObservations:observationCount,students:new Set(observations.map(r=>r.studentId)).size,pinnedRubricSeries:chartData.length},scale:{minimum:1,maximum:5},coverage:'complete_current_authorized_selection',dateBasis:'recorded_session_local_date',trendOrder:'recorded_session_start_UTC_microseconds_then_feedback_id',rubricBasis:'pinned_reviewed_definition_not_latest_labels',averages:'exact_sum_over_count_only_within_student_and_pinned_rubric_version',missingScoresImputed:false,privateNotesIncluded:false,performanceIndependentlyVerified:false,payrollApproved:false};
}
function projection(alias:'f'|'p'){return `jsonb_build_object('feedbackId',${alias}.id,'feedbackVersion',${alias}.version,'studentId',${alias}.student_id,'sessionId',${alias}.session_id,'classId',${alias}.class_id,'hubId',${alias}.hub_id,'on',${alias}.context#>>'{source,session,on}','startsAt',to_char((${alias}.context#>>'{source,session,startsAt}')::timestamptz AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'rubricId',${alias}.rubric_id,'rubricVersion',${alias}.rubric_version,'rubric',jsonb_build_object('name',${alias}.context#>>'{source,rubric,definition,name}','criteria',${alias}.context#>'{source,rubric,definition,criteria}'),'ratings',${alias}.ratings,'publishedToFamily',${alias}.publish_to_family)`;}
const envelope=(sql:string)=>`WITH selected AS MATERIALIZED(${sql}) SELECT jsonb_build_object('snapshotAt',to_char(statement_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'observations',coalesce(jsonb_agg(observation),'[]'::jsonb)) data FROM selected`;
const approval=(alias:'f'|'p')=>`JOIN public.approval_requests a ON a.academy_id=${alias}.academy_id AND a.id=${alias}.approval_id AND a.status='applied' AND a.reviewer_id=${alias}.changed_by AND a.target_id=${alias}.id`;
export async function studentPerformance(ctx:ApiContext):Promise<Reply|null>{
 const family=/^students\/([^/]+)\/performance$/.exec(ctx.path);if(!family&&ctx.path!=='reports/learning/student-performance')return null;if(ctx.request.method!=='GET')throw new ApiError(405,'METHOD_NOT_ALLOWED');
 return {status:200,body:await studentPerformanceResult(ctx)};
}
export async function studentPerformanceResult(ctx:ApiContext,captureAuthorization=false){
 const family=/^students\/([^/]+)\/performance$/.exec(ctx.path);if(!family&&ctx.path!=='reports/learning/student-performance')throw new Error('INVALID_PERFORMANCE_REPORT_PATH');if(family&&captureAuthorization)throw new Error('FAMILY_REPORT_RETENTION_NOT_SUPPORTED');
 const p=new URL(ctx.request.url).searchParams;if([...p].length!==new Set(p.keys()).size)throw new ApiError(400,'DUPLICATE_QUERY');let sql:string,values:unknown[],query:z.infer<typeof studentPerformanceQuery>|z.infer<typeof familyPerformanceQuery>;
 if(family){const student=uuid.parse(family[1]),q=familyPerformanceQuery.parse(Object.fromEntries(p));query=q;const {s,selected}=await authorizeLearningRecipient(ctx,student);
  sql=envelope(`SELECT ${projection('p')} observation FROM public.student_feedback p ${approval('p')} WHERE p.student_id=$1 AND p.publish_to_family AND a.action IN('student-feedback.record','student-feedback.edit') AND ${receivedLearningSelection} AND(p.context#>>'{source,session,on}') BETWEEN $10::text AND $11::text AND($12::uuid IS NULL OR p.class_id=$12) AND($13::uuid IS NULL OR p.hub_id=$13) AND($14::uuid IS NULL OR p.rubric_id=$14) AND($15::integer IS NULL OR p.rubric_version=$15) ORDER BY(p.context#>>'{source,session,on}'),p.id LIMIT ${performanceFeedbackLimit+1}`);
  values=[student,ctx.credential.person_id,null,s.all,selected,s.hubs,s.excludedHubs??[],null,null,q.from,q.through,q.classId??null,q.hubId??null,q.rubricId??null,q.rubricVersion??null];
 }else{const q=studentPerformanceQuery.parse(Object.fromEntries(p));query=q;await lockApprovalWrites(ctx);const scope=performanceReportScope(ctx);
  sql=envelope(`SELECT ${projection('f')} observation FROM public.student_feedback f ${approval('f')} WHERE public.scope_contains($1::jsonb,${studentFeedbackTargetSQL}) AND a.action IN('student-feedback.record','student-feedback.edit','student-feedback.withdraw') AND(f.context#>>'{source,session,on}') BETWEEN $2::text AND $3::text AND($4::uuid IS NULL OR f.student_id=$4) AND($5::uuid IS NULL OR f.class_id=$5) AND($6::uuid IS NULL OR f.hub_id=$6) AND($7::uuid IS NULL OR f.rubric_id=$7) AND($8::integer IS NULL OR f.rubric_version=$8) AND($9='all' OR f.publish_to_family=($9='published')) ORDER BY(f.context#>>'{source,session,on}'),f.id LIMIT ${performanceFeedbackLimit+1}`);
  values=[JSON.stringify(scope),q.from,q.through,q.studentId??null,q.classId??null,q.hubId??null,q.rubricId??null,q.rubricVersion??null,q.visibility];
 }
 const result=(await ctx.db.query<{data:{snapshotAt:string;observations:unknown}}>(sql,values)).rows[0].data,body={data:studentPerformanceData(result.observations,captureAuthorization),snapshotAt:result.snapshotAt,filters:query,publishedOnly:Boolean(family)||('visibility'in query&&query.visibility==='published'),sourcePermissions:'current_caller',resultsStored:false,externalRequestMade:false};if(Buffer.byteLength(JSON.stringify(body))>4_194_304)throw new ApiError(422,'STUDENT_PERFORMANCE_REQUIRES_BACKGROUND_JOB');return body;
}
export const studentPerformanceReportContract=[{path:'/api/v1/reports/learning/student-performance',method:'get',summary:'Complete current-source-scoped student performance trends,1-5 distributions and exact sum/count averages per student and PINNED rubric version,never mixing changed criteria. Current feedback view scopes before date/student/class/hub/publication filters and totals.200feedback/6000point/4MiB limit refuses partial results. No private notes,rankings,payroll decision or certified performance.',querySchema:studentPerformanceQuery}] as const;
export const familyPerformanceContract=[{path:'/api/v1/students/{id}/performance',method:'get',humanOnly:true,summary:'Human linked-family/self performance trends from actually approved and published feedback only,with current relationship,dated enrollment and source-hub denials before counts. No drafts,withdrawn scores,private notes,other students or administrative reasons. Pinned criteria/versions remain separate;exact averages,1-5 distributions and complete200feedback bound.',querySchema:familyPerformanceQuery}] as const;
