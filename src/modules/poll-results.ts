import { z } from 'zod';
import type { ApiContext,Reply } from '../core/api.ts';
import { ApiError } from '../core/policy.ts';
import { formatMoney,roundRatio } from '../core/money.ts';
import type { PollDefinition } from './poll-definition.ts';
import { pollRecordSQL } from './poll-responses.ts';
import { csvRow,csvText } from '../core/csv.ts';
import { pollReportForm,pollReportScopes,pollReportAuthorization } from './poll-report-access.ts';

const uuid=z.string().uuid().transform(v=>v.toLowerCase());
const ids=z.string().max(3699).transform(v=>v.split(',')).pipe(z.array(uuid).min(1).max(100)).refine(v=>new Set(v).size===v.length,'Duplicate filter ID');
const query=z.object({formVersion:z.coerce.number().int().min(1).max(2147483647).optional(),hubIds:ids.optional(),classIds:ids.optional(),studentIds:ids.optional()}).strict();
const responseTarget=pollRecordSQL('r.student_id','r.class_id','r.hub_id');
const recipientTarget=pollRecordSQL("member->'studentId'","member->'classId'","member->'hubId'");
const percent=(count:number,total:number)=>total?formatMoney(roundRatio(BigInt(count)*10000n,BigInt(total),'half_even'),2):null;
type Summary={selectedHeads:number;submittedResponses:number;includedResponses:number;excludedResponses:number;withdrawnResponses:number;distinctStudents:number;distinctLastActors:number;distinctIncludedStudents:number;distinctIncludedLastActors:number;configuredAudienceStudents:number};
export const maximumSynchronousPollResponses=10000;
export const maximumBackgroundPollResponses=100000;
type Counts={summary:Summary;question_counts:{id:string;count:number}[];choice_counts:{questionId:string;optionId:string;count:number}[]};
export function pollResultSeries(definition:PollDefinition,r:Counts,background=false){
 if(r.summary.selectedHeads>(background?maximumBackgroundPollResponses:maximumSynchronousPollResponses))throw new ApiError(422,'POLL_RESULTS_REQUIRE_BACKGROUND_JOB');
 const counts=new Map(r.question_counts.map(c=>[c.id,c.count])),choices=new Map(r.choice_counts.map(c=>[c.questionId+':'+c.optionId,c.count]));
 return definition.questions.map(question=>{const count=counts.get(question.id)??0;return {id:question.id,prompt:question.prompt,kind:question.kind,required:question.required,answeringResponses:count,unansweredResponses:r.summary.includedResponses-count,answerCoveragePercent:percent(count,r.summary.includedResponses),...(question.kind==='text'?{textBodiesIncluded:false}:{optionCount:question.options.length,multipleSelections:question.kind==='multiple',choices:question.options.map(o=>{const n=choices.get(question.id+':'+o.id)??0;return {id:o.id,label:o.label,count:n,percentOfAnsweringResponses:percent(n,count)};})})};});
}

export async function pollResults(ctx:ApiContext,background=false){
 const match=/^reports\/learning\/polls\/([^/]+)$/.exec(ctx.path);if(!match)return null;if(ctx.request.method!=='GET')throw new ApiError(405,'METHOD_NOT_ALLOWED');
 const params=new URL(ctx.request.url).searchParams;if(new Set(params.keys()).size!==[...params.keys()].length)throw new ApiError(400,'DUPLICATE_QUERY');const q=query.parse(Object.fromEntries(params)),id=uuid.parse(match[1]),f=await pollReportForm(ctx,id,q.formVersion),scopes=pollReportScopes(ctx).map(s=>JSON.stringify(s)),maximum=background?maximumBackgroundPollResponses:maximumSynchronousPollResponses;
 // Metadata access is anchored to the selected form's own audience, not a
 // later form's newly assigned class, or to an authorized historical response.
 // ponytail: synchronous/background results cap 10,000/100,000 authorized
 // response heads; larger selections need partitioned jobs,never partial counts.
 // Materialize only bounded metadata first, not thousands of private answer bodies.
 const r=(await ctx.db.query<Counts&{snapshot_at:string;contexts?:z.infer<typeof pollReportAuthorization>['contexts']}>(`WITH eligible AS MATERIALIZED(
 SELECT r.id,r.student_id,r.class_id,r.hub_id,r.changed_by,r.state,coalesce(m.excluded,false) excluded FROM public.poll_responses r LEFT JOIN public.poll_response_moderation m ON m.academy_id=r.academy_id AND m.response_id=r.id AND m.response_version=r.version WHERE r.poll_id=$1 AND r.form_version=$2
 AND public.scope_contains($3::jsonb,${responseTarget}) AND public.scope_contains($4::jsonb,${responseTarget})
 AND($5::uuid[] IS NULL OR r.hub_id=ANY($5)) AND($6::uuid[] IS NULL OR r.class_id=ANY($6)) AND($7::uuid[] IS NULL OR r.student_id=ANY($7)) ORDER BY r.id LIMIT ${maximum+1}),
 totals AS(SELECT count(*)::integer selected,count(*) FILTER(WHERE state='submitted')::integer submitted,count(*) FILTER(WHERE state='submitted' AND NOT excluded)::integer included,count(*) FILTER(WHERE state='submitted' AND excluded)::integer excluded,count(*) FILTER(WHERE state='withdrawn')::integer withdrawn,count(DISTINCT student_id) FILTER(WHERE state='submitted')::integer students,count(DISTINCT changed_by) FILTER(WHERE state='submitted')::integer actors,count(DISTINCT student_id) FILTER(WHERE state='submitted' AND NOT excluded)::integer included_students,count(DISTINCT changed_by) FILTER(WHERE state='submitted' AND NOT excluded)::integer included_actors FROM eligible),
 counts AS MATERIALIZED(SELECT(a->>'questionId')::uuid question_id,(choice#>>'{}')::uuid option_id,count(*)::integer count FROM eligible e JOIN public.poll_responses r ON r.id=e.id CROSS JOIN totals t
 JOIN LATERAL jsonb_array_elements(r.answers) a ON true
 JOIN LATERAL jsonb_array_elements(jsonb_build_array(NULL::text)||CASE a->>'kind' WHEN 'single' THEN jsonb_build_array(a->'optionId') WHEN 'multiple' THEN a->'optionIds' ELSE '[]'::jsonb END) choice ON true
 WHERE e.state='submitted' AND NOT e.excluded AND t.selected<=${maximum} GROUP BY 1,2),
 questions AS(SELECT question_id id,count FROM counts WHERE option_id IS NULL),
 choices AS(SELECT question_id,option_id,count FROM counts WHERE option_id IS NOT NULL),
 audience_rows AS MATERIALIZED(SELECT(member->>'studentId')::uuid student_id,(member->>'classId')::uuid class_id,(member->>'hubId')::uuid hub_id FROM public.poll_revisions v JOIN LATERAL jsonb_array_elements(v.definition#>'{context,source,recipients}') member ON true WHERE v.poll_id=$1 AND v.version=$8 AND public.scope_contains($3::jsonb,${recipientTarget}) AND public.scope_contains($4::jsonb,${recipientTarget}) AND($5::uuid[] IS NULL OR(member->>'hubId')::uuid=ANY($5)) AND($6::uuid[] IS NULL OR(member->>'classId')::uuid=ANY($6)) AND($7::uuid[] IS NULL OR(member->>'studentId')::uuid=ANY($7))),
 audience AS(SELECT count(*)::integer count FROM audience_rows),
 contexts AS(SELECT student_id,class_id,hub_id FROM(SELECT student_id,class_id,hub_id FROM eligible UNION SELECT student_id,class_id,hub_id FROM audience_rows) s ORDER BY student_id,class_id,hub_id LIMIT 10001)
 SELECT statement_timestamp()::text snapshot_at,jsonb_build_object('selectedHeads',t.selected,'submittedResponses',t.submitted,'includedResponses',t.included,'excludedResponses',t.excluded,'withdrawnResponses',t.withdrawn,'distinctStudents',t.students,'distinctLastActors',t.actors,'distinctIncludedStudents',t.included_students,'distinctIncludedLastActors',t.included_actors,'configuredAudienceStudents',audience.count) summary,
 coalesce((SELECT jsonb_agg(jsonb_build_object('id',id,'count',count)) FROM questions),'[]'::jsonb) question_counts,
 coalesce((SELECT jsonb_agg(jsonb_build_object('questionId',question_id,'optionId',option_id,'count',count)) FROM choices),'[]'::jsonb) choice_counts,
 CASE WHEN ${background} THEN coalesce((SELECT jsonb_agg(jsonb_build_object('studentId',student_id,'classId',class_id,'hubId',hub_id) ORDER BY student_id,class_id,hub_id) FROM contexts),'[]'::jsonb) ELSE NULL END contexts FROM totals t CROSS JOIN audience`,[id,f.form_version,...scopes,q.hubIds??null,q.classIds??null,q.studentIds??null,f.audience_version])).rows[0];
 const questions=pollResultSeries(f.definition,r,background);if(background&&r.contexts&&r.contexts.length>10000)throw new ApiError(422,'POLL_RESULTS_REQUIRE_BACKGROUND_JOB');const authorizationContext=background?pollReportAuthorization.parse({kind:'poll_aggregate',pollId:id,formVersion:f.form_version,audiencePollVersion:f.audience_version,contexts:r.contexts}):undefined;
 return {status:200,body:{pollId:id,...(authorizationContext?{authorizationContext}:{}),pollVersion:f.poll_version,formVersion:f.form_version,audiencePollVersion:f.audience_version,state:f.state,title:f.definition.title,description:f.definition.description,locale:f.definition.locale,responseUnit:f.response_unit,respondentMode:f.respondent_mode,snapshotAt:r.snapshot_at,filters:{...q,formVersion:f.form_version},summary:r.summary,questionCount:questions.length,questions,
 countingPolicy:'current_submitted_nonexcluded_response_heads_in_scope_including_former_recipients',permissionsAppliedBeforeAggregation:true,percentageRounding:'half_even_2dp',freeTextIncluded:false,moderationAvailable:true,moderationAppliesTo:'exact_response_revision',externalDeliveryVerified:false}};
}
export const pollResultsContract=[{path:'/api/v1/reports/learning/polls/{id}',method:'get',summary:'Exact-form source-scoped poll charts count current submitted nonexcluded heads; separately report included/excluded/withdrawn and student/actor counts; combined hub/class/student filters; no free-text or global totals; 10000-head synchronous cap',querySchema:query}] as const;

type PollResult=NonNullable<Awaited<ReturnType<typeof pollResults>>>['body'];
export function pollResultsCsv(data:PollResult,provenance?:{id?:string;version?:number;scheduledOccurrence?:unknown;retryOfJobId?:string},background=false):Reply{
 const summary=data.summary;
 if(!uuid.safeParse(data.pollId).success||!Number.isSafeInteger(data.formVersion)||data.formVersion<1||data.freeTextIncluded!==false||data.permissionsAppliedBeforeAggregation!==true||!Number.isSafeInteger(data.questionCount)||data.questionCount<1||data.questionCount>20||data.questions.length!==data.questionCount||new Set(data.questions.map(q=>q.id)).size!==data.questions.length)throw new Error('POLL_EXPORT_INVALID');
 if(Object.values(summary).some(n=>!Number.isSafeInteger(n)||n<0)||summary.selectedHeads>(background?maximumBackgroundPollResponses:maximumSynchronousPollResponses)||summary.selectedHeads!==summary.submittedResponses+summary.withdrawnResponses||summary.submittedResponses!==summary.includedResponses+summary.excludedResponses||summary.distinctStudents>summary.submittedResponses||summary.distinctLastActors>summary.submittedResponses||summary.distinctIncludedStudents>Math.min(summary.includedResponses,summary.distinctStudents)||summary.distinctIncludedLastActors>Math.min(summary.includedResponses,summary.distinctLastActors))throw new Error('POLL_EXPORT_COUNTS_INVALID');
 const header=['section','field','value','question_id','prompt','kind','required','answering_responses','unanswered_responses','answer_coverage_percent','option_id','option_label','choice_count','percent_of_answering_responses'],rows:(string|number|boolean|null|undefined)[][]=[header];
 const meta=(field:string,value:unknown)=>{if(value!==undefined)rows.push(['metadata',field,csvText(typeof value==='string'?value:JSON.stringify(value))]);};
 // Explicit public-result fields only. Never serialize response bodies or a
 // newly added private field by iterating the whole source object.
 for(const field of ['pollId','pollVersion','formVersion','audiencePollVersion','state','title','description','locale','responseUnit','respondentMode','snapshotAt','questionCount','filters','countingPolicy','permissionsAppliedBeforeAggregation','percentageRounding','freeTextIncluded','moderationAvailable','moderationAppliesTo','externalDeliveryVerified'] as const)meta(field,data[field]);
 meta('exportCompleteness','complete_permitted_exact_form_aggregates_within_source_limits');meta('textPolicy','Formula-like authored text uses a visible text: prefix; stored records are unchanged.');meta('percentageNullPolicy','Empty percentage cell means no denominator,not zero percent.');
 if(provenance?.id)meta('presetId',provenance.id);if(provenance?.version!==undefined)meta('presetVersion',provenance.version);if(provenance?.scheduledOccurrence)meta('scheduledOccurrence',provenance.scheduledOccurrence);if(provenance?.retryOfJobId)meta('retryOfJobId',provenance.retryOfJobId);
 for(const [field,value]of Object.entries(summary))rows.push(['summary',field,String(value)]);
 for(const question of data.questions){
  if(!uuid.safeParse(question.id).success||!['text','single','multiple'].includes(question.kind)||typeof question.required!=='boolean'||![question.answeringResponses,question.unansweredResponses].every(n=>Number.isSafeInteger(n)&&n>=0)||question.answeringResponses+question.unansweredResponses!==summary.includedResponses||question.answerCoveragePercent!==percent(question.answeringResponses,summary.includedResponses))throw new Error('POLL_EXPORT_QUESTION_INVALID');
  const common=[question.id,csvText(question.prompt),question.kind,question.required,question.answeringResponses,question.unansweredResponses,question.answerCoveragePercent];rows.push(['question','answer_counts','',...common]);
  if(question.kind==='text'){if('choices'in question||!('textBodiesIncluded'in question)||question.textBodiesIncluded!==false)throw new Error('POLL_EXPORT_PRIVATE_TEXT_INVALID');continue;}
  if(!('choices'in question)||!('multipleSelections'in question)||!('optionCount'in question))throw new Error('POLL_EXPORT_CHOICES_INVALID');const choices=question.choices;
  if(!Array.isArray(choices)||choices.length<2||choices.length>20||choices.length!==question.optionCount||new Set(choices.map(c=>c.id)).size!==choices.length||question.multipleSelections!==(question.kind==='multiple'))throw new Error('POLL_EXPORT_CHOICES_INVALID');
  let selected=0;for(const choice of choices){if(!uuid.safeParse(choice.id).success||!Number.isSafeInteger(choice.count)||choice.count<0||choice.count>question.answeringResponses||choice.percentOfAnsweringResponses!==percent(choice.count,question.answeringResponses))throw new Error('POLL_EXPORT_CHOICES_INVALID');selected+=choice.count;rows.push(['choice','selection_counts','',...common,choice.id,csvText(choice.label),choice.count,choice.percentOfAnsweringResponses]);}
  if(question.kind==='single'?selected!==question.answeringResponses:selected<question.answeringResponses)throw new Error('POLL_EXPORT_CHOICES_INVALID');
 }
 const body='\uFEFF'+rows.map(row=>csvRow(Array.from({length:header.length},(_,i)=>row[i]))).join('\r\n')+'\r\n';if(Buffer.byteLength(body)>4_194_304)throw new ApiError(422,'POLL_RESULTS_REQUIRE_BACKGROUND_JOB');return{status:200,body,csv:{filename:`poll-results-${data.pollId}-form-${data.formVersion}.csv`}};
}
export async function completePollResultsExport(ctx:ApiContext,provenance?:{id:string;version:number}){const reply=await pollResults(ctx);if(!reply||reply.status!==200)throw new Error('POLL_EXPORT_SOURCE_INVALID');return pollResultsCsv(reply.body,provenance);}
export async function pollResultsExport(ctx:ApiContext):Promise<Reply|null>{const m=/^reports\/learning\/polls\/([^/]+)\/export$/.exec(ctx.path);if(!m)return null;if(ctx.request.method!=='GET')throw new ApiError(405,'METHOD_NOT_ALLOWED');const path='reports/learning/polls/'+uuid.parse(m[1]),url=new URL(ctx.request.url);url.pathname='/api/v1/'+path;return completePollResultsExport({...ctx,path,request:new Request(url,{method:'GET'})});}
export const pollResultsExportContract=[{...pollResultsContract[0],path:pollResultsContract[0].path+'/export',summary:'Complete exact-form scoped poll aggregate CSV:all authorized summary counts,question/option chart series,authored labels and percentage denominators;Empty percentage cells denote missing denominators,not zero percent. Same current polls/results rights,combined selectors and10000response-head cap;4MiB refuses oversized files without partial counts. Formula-safe authored text;NO free-text answers,respondent names,identities or response bodies. Saved preset provenance retained;not a response-detail export export;larger selections may use requester-bound aggregate jobs within their advertised limits.',responseContentType:'text/csv' as const}] as const;
