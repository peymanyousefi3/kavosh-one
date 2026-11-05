import { z } from 'zod';
import type { ApiContext,Reply } from '../core/api.ts';
import { lockApprovalWrites,permissionScope } from '../core/approvals.ts';
import { ApiError,scopeNonempty } from '../core/policy.ts';
import { formatMoney,roundRatio } from '../core/money.ts';
import type { PollDefinition } from './poll-definition.ts';
import { pollOwnerSQL } from './poll-definition.ts';
import { pollRecordSQL } from './poll-responses.ts';

const uuid=z.string().uuid().transform(v=>v.toLowerCase());
const ids=z.string().max(3699).transform(v=>v.split(',')).pipe(z.array(uuid).min(1).max(100)).refine(v=>new Set(v).size===v.length,'Duplicate filter ID');
const query=z.object({formVersion:z.coerce.number().int().min(1).max(2147483647).optional(),hubIds:ids.optional(),classIds:ids.optional(),studentIds:ids.optional()}).strict();
const responseTarget=pollRecordSQL('r.student_id','r.class_id','r.hub_id');
const recipientTarget=pollRecordSQL("member->'studentId'","member->'classId'","member->'hubId'");
const percent=(count:number,total:number)=>total?formatMoney(roundRatio(BigInt(count)*10000n,BigInt(total),'half_even'),2):null;
type Summary={selectedHeads:number;submittedResponses:number;includedResponses:number;excludedResponses:number;withdrawnResponses:number;distinctStudents:number;distinctLastActors:number;distinctIncludedStudents:number;distinctIncludedLastActors:number;configuredAudienceStudents:number};
export const maximumSynchronousPollResponses=10000;
type Counts={summary:Summary;question_counts:{id:string;count:number}[];choice_counts:{questionId:string;optionId:string;count:number}[]};
export function pollResultSeries(definition:PollDefinition,r:Counts){
 if(r.summary.selectedHeads>maximumSynchronousPollResponses)throw new ApiError(422,'POLL_RESULTS_REQUIRE_BACKGROUND_JOB');
 const counts=new Map(r.question_counts.map(c=>[c.id,c.count])),choices=new Map(r.choice_counts.map(c=>[c.questionId+':'+c.optionId,c.count]));
 return definition.questions.map(question=>{const count=counts.get(question.id)??0;return {id:question.id,prompt:question.prompt,kind:question.kind,required:question.required,answeringResponses:count,unansweredResponses:r.summary.includedResponses-count,answerCoveragePercent:percent(count,r.summary.includedResponses),...(question.kind==='text'?{textBodiesIncluded:false}:{multipleSelections:question.kind==='multiple',choices:question.options.map(o=>{const n=choices.get(question.id+':'+o.id)??0;return {id:o.id,label:o.label,count:n,percentOfAnsweringResponses:percent(n,count)};})})};});
}

export async function pollResults(ctx:ApiContext):Promise<Reply|null>{
 const match=/^reports\/learning\/polls\/([^/]+)$/.exec(ctx.path);if(!match)return null;if(ctx.request.method!=='GET')throw new ApiError(405,'METHOD_NOT_ALLOWED');
 const params=new URL(ctx.request.url).searchParams;if(new Set(params.keys()).size!==[...params.keys()].length)throw new ApiError(400,'DUPLICATE_QUERY');const q=query.parse(Object.fromEntries(params)),id=uuid.parse(match[1]);await lockApprovalWrites(ctx);
 const results=permissionScope(ctx,'poll-results.view'),polls=permissionScope(ctx,'polls.view');if(!scopeNonempty(results)||!scopeNonempty(polls))throw new ApiError(403,'FORBIDDEN');
 const scopes=[JSON.stringify(results),JSON.stringify(polls)];
 // Metadata access is anchored to the selected form's own audience, not a
 // later form's newly assigned class, or to an authorized historical response.
 const f=(await ctx.db.query<{form_version:number;definition:PollDefinition;response_unit:string;respondent_mode:string;state:string;poll_version:number;audience_version:number}>(`SELECT f.form_version,f.definition,f.response_unit,f.respondent_mode,p.state,p.version poll_version,basis.version audience_version
 FROM public.polls p JOIN public.poll_form_revisions f ON f.academy_id=p.academy_id AND f.poll_id=p.id AND f.form_version=coalesce($2::integer,p.form_version)
 JOIN LATERAL(SELECT v.version,v.definition FROM public.poll_revisions v WHERE v.academy_id=p.academy_id AND v.poll_id=p.id AND(v.definition->>'form_version')::integer=f.form_version ORDER BY v.version DESC LIMIT 1) basis ON true WHERE p.id=$1 AND(
 (public.scope_contains($3::jsonb,${pollOwnerSQL}) AND public.scope_contains($4::jsonb,${pollOwnerSQL}))
 OR EXISTS(SELECT 1 FROM jsonb_array_elements(basis.definition#>'{context,source,recipients}') member WHERE public.scope_contains($3::jsonb,${recipientTarget}) AND public.scope_contains($4::jsonb,${recipientTarget}))
 OR EXISTS(SELECT 1 FROM public.poll_responses r WHERE r.academy_id=p.academy_id AND r.poll_id=p.id AND r.form_version=f.form_version AND public.scope_contains($3::jsonb,${responseTarget}) AND public.scope_contains($4::jsonb,${responseTarget})))`,[id,q.formVersion??null,...scopes])).rows[0];if(!f)throw new ApiError(404,'NOT_FOUND');
 // ponytail: synchronous results cap 10,000 authorized response heads. Refuse
 // oversized reports, never truncate denominators; queued reports remain required.
 // Materialize only bounded metadata first, not thousands of private answer bodies.
 const r=(await ctx.db.query<Counts&{snapshot_at:string}>(`WITH eligible AS MATERIALIZED(
 SELECT r.id,r.student_id,r.changed_by,r.state,coalesce(m.excluded,false) excluded FROM public.poll_responses r LEFT JOIN public.poll_response_moderation m ON m.academy_id=r.academy_id AND m.response_id=r.id AND m.response_version=r.version WHERE r.poll_id=$1 AND r.form_version=$2
 AND public.scope_contains($3::jsonb,${responseTarget}) AND public.scope_contains($4::jsonb,${responseTarget})
 AND($5::uuid[] IS NULL OR r.hub_id=ANY($5)) AND($6::uuid[] IS NULL OR r.class_id=ANY($6)) AND($7::uuid[] IS NULL OR r.student_id=ANY($7)) ORDER BY r.id LIMIT ${maximumSynchronousPollResponses+1}),
 totals AS(SELECT count(*)::integer selected,count(*) FILTER(WHERE state='submitted')::integer submitted,count(*) FILTER(WHERE state='submitted' AND NOT excluded)::integer included,count(*) FILTER(WHERE state='submitted' AND excluded)::integer excluded,count(*) FILTER(WHERE state='withdrawn')::integer withdrawn,count(DISTINCT student_id) FILTER(WHERE state='submitted')::integer students,count(DISTINCT changed_by) FILTER(WHERE state='submitted')::integer actors,count(DISTINCT student_id) FILTER(WHERE state='submitted' AND NOT excluded)::integer included_students,count(DISTINCT changed_by) FILTER(WHERE state='submitted' AND NOT excluded)::integer included_actors FROM eligible),
 counts AS MATERIALIZED(SELECT(a->>'questionId')::uuid question_id,(choice#>>'{}')::uuid option_id,count(*)::integer count FROM eligible e JOIN public.poll_responses r ON r.id=e.id CROSS JOIN totals t
 JOIN LATERAL jsonb_array_elements(r.answers) a ON true
 JOIN LATERAL jsonb_array_elements(jsonb_build_array(NULL::text)||CASE a->>'kind' WHEN 'single' THEN jsonb_build_array(a->'optionId') WHEN 'multiple' THEN a->'optionIds' ELSE '[]'::jsonb END) choice ON true
 WHERE e.state='submitted' AND NOT e.excluded AND t.selected<=${maximumSynchronousPollResponses} GROUP BY 1,2),
 questions AS(SELECT question_id id,count FROM counts WHERE option_id IS NULL),
 choices AS(SELECT question_id,option_id,count FROM counts WHERE option_id IS NOT NULL),
 audience AS(SELECT count(*)::integer count FROM public.poll_revisions v JOIN LATERAL jsonb_array_elements(v.definition#>'{context,source,recipients}') member ON true WHERE v.poll_id=$1 AND v.version=$8 AND public.scope_contains($3::jsonb,${recipientTarget}) AND public.scope_contains($4::jsonb,${recipientTarget}) AND($5::uuid[] IS NULL OR(member->>'hubId')::uuid=ANY($5)) AND($6::uuid[] IS NULL OR(member->>'classId')::uuid=ANY($6)) AND($7::uuid[] IS NULL OR(member->>'studentId')::uuid=ANY($7)))
 SELECT statement_timestamp()::text snapshot_at,jsonb_build_object('selectedHeads',t.selected,'submittedResponses',t.submitted,'includedResponses',t.included,'excludedResponses',t.excluded,'withdrawnResponses',t.withdrawn,'distinctStudents',t.students,'distinctLastActors',t.actors,'distinctIncludedStudents',t.included_students,'distinctIncludedLastActors',t.included_actors,'configuredAudienceStudents',audience.count) summary,
 coalesce((SELECT jsonb_agg(jsonb_build_object('id',id,'count',count)) FROM questions),'[]'::jsonb) question_counts,
 coalesce((SELECT jsonb_agg(jsonb_build_object('questionId',question_id,'optionId',option_id,'count',count)) FROM choices),'[]'::jsonb) choice_counts FROM totals t CROSS JOIN audience`,[id,f.form_version,...scopes,q.hubIds??null,q.classIds??null,q.studentIds??null,f.audience_version])).rows[0];
 const questions=pollResultSeries(f.definition,r);
 return {status:200,body:{pollId:id,pollVersion:f.poll_version,formVersion:f.form_version,audiencePollVersion:f.audience_version,state:f.state,title:f.definition.title,description:f.definition.description,locale:f.definition.locale,responseUnit:f.response_unit,respondentMode:f.respondent_mode,snapshotAt:r.snapshot_at,filters:{...q,formVersion:f.form_version},summary:r.summary,questions,
 countingPolicy:'current_submitted_nonexcluded_response_heads_in_scope_including_former_recipients',permissionsAppliedBeforeAggregation:true,percentageRounding:'half_even_2dp',freeTextIncluded:false,moderationAvailable:true,moderationAppliesTo:'exact_response_revision',externalDeliveryVerified:false}};
}
export const pollResultsContract=[{path:'/api/v1/reports/learning/polls/{id}',method:'get',summary:'Exact-form source-scoped poll charts count current submitted nonexcluded heads; separately report included/excluded/withdrawn and student/actor counts; combined hub/class/student filters; no free-text or global totals; 10000-head synchronous cap',querySchema:query}] as const;
