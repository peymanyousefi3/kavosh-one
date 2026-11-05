import { z } from 'zod';
import { jsonBody,record,type ApiContext,type Reply } from '../core/api.ts';
import { propose,master,permissionScope,type ApprovalRegistry,type Proposal } from '../core/approvals.ts';
import { ApiError,scopeContains,scopeNonempty,type Capability,type Scope } from '../core/policy.ts';
import { sessionLocalDate } from './classes.ts';
import { lockAcademyTopology } from './academy.ts';
import { authorizeLearningRecipient,receivedLearningQuery,receivedLearningSelection } from './learning-recipients.ts';

const uuid=z.string().uuid().transform(v=>v.toLowerCase()),version=z.number().int().min(1).max(2147483647),text=z.string().refine(v=>v.isWellFormed()&&!v.includes('\0'));
const ratings=z.array(z.object({code:z.string().regex(/^[a-z][a-z0-9_]{0,39}$/),score:z.number().int().min(1).max(5)}).strict()).min(1).max(30).refine(v=>new Set(v.map(r=>r.code)).size===v.length,'Duplicate criterion').transform(v=>v.sort((a,b)=>a.code<b.code?-1:1));
const common=z.object({expectedVersion:z.number().int().min(0).max(2147483647),sessionVersion:version,enrollmentId:uuid,enrollmentVersion:version,rubricId:uuid,rubricVersion:version,ratings,note:text.pipe(z.string().trim().min(1).max(10000)),publishToFamily:z.boolean().default(false),reason:text.pipe(z.string().trim().min(1).max(2000))}).strict();
const staffInput=common.extend({assignmentId:uuid,assignmentVersion:version}),payload=common.extend({sessionId:uuid,assignmentId:uuid.nullable(),assignmentVersion:version.nullable()});
const withdrawal=z.object({expectedVersion:version,reason:common.shape.reason}).strict(),withdrawPayload=withdrawal.extend({feedbackId:uuid});
const paging=z.object({limit:z.coerce.number().int().min(1).max(20).default(10),after:uuid.optional()}).strict(),historyQuery=z.object({limit:z.coerce.number().int().min(1).max(10).default(5),afterVersion:z.coerce.number().int().min(0).max(2147483647).default(0)}).strict(),empty=z.object({}).strict();
const optionsQuery=paging.extend({enrollmentId:uuid,administrative:z.enum(['true','false']).default('false').transform(v=>v==='true')});
type Input=z.infer<typeof payload>;type Session=Parameters<typeof sessionLocalDate>[0]&{time_zone:string};
type Enrollment={id:string;class_id:string;student_id:string;version:number;enabled:boolean;joins_on:string;leaves_on:string|null};
type Source={session:{id:string;classId:string;hubId:string;version:number;status:string;classActive:boolean;startsAt:string;on:string;timeZone:string};enrollment:Enrollment;student:{id:string;hub_id:string|null};rubric:{id:string;version:number;current_version:number;current_active:boolean;definition:{name:string;criteria:{code:string;labels:Record<string,string>}[]}};assignment:{id:string;version:number;person_id:string}|null};
type Feedback={id:string;session_id:string;class_id:string;hub_id:string;student_id:string;version:number;session_version:number;enrollment_id:string;enrollment_version:number;rubric_id:string;rubric_version:number;ratings:z.infer<typeof ratings>;note:string;publish_to_family:boolean;assignment_id:string|null;assignment_version:number|null;recorded_by:string;context:{source:Source};[key:string]:unknown};
function target(classId:string,hubId:string,studentId:string):Scope{return {all:false,hubs:[],classes:[{id:classId,hubId}],people:[{id:studentId,hubId}],recordContext:{classId,hubId,studentId}};}
function authorize(ctx:ApiContext,t:Scope,cap:Capability='student-feedback.view'){for(const c of ['student-feedback.view',cap] as Capability[])if(!scopeContains(permissionScope(ctx,c),t))throw new ApiError(404,'NOT_FOUND');}
async function head(ctx:ApiContext,id:string,cap:Capability='student-feedback.view'){
 const f=(await ctx.db.query<{feedback:Feedback}>('SELECT to_jsonb(f) feedback FROM public.student_feedback f WHERE id=$1',[id])).rows[0]?.feedback;if(!f)throw new ApiError(404,'NOT_FOUND');authorize(ctx,target(f.class_id,f.hub_id,f.student_id),cap);return f;
}
async function selected(ctx:ApiContext,sessionId:string,enrollmentId:string,cap:Capability){
 const s=(await ctx.db.query<Session>('SELECT s.*,c.time_zone FROM public.class_sessions s JOIN public.classes c ON c.academy_id=s.academy_id AND c.id=s.class_id WHERE s.id=$1',[sessionId])).rows[0];if(!s)throw new ApiError(404,'NOT_FOUND');
 const e=(await ctx.db.query<Enrollment>('SELECT id,class_id,student_id,version,enabled,joins_on::text,leaves_on::text FROM public.class_enrollments WHERE id=$1 AND class_id=$2',[enrollmentId,s.class_id])).rows[0];if(!e)throw new ApiError(404,'NOT_FOUND');
 const t=target(s.class_id,s.hub_id,e.student_id);authorize(ctx,t,cap);return {s,e,t,on:sessionLocalDate(s,s.time_zone)};
}
async function basis(ctx:ApiContext,id:string,i:Input){
 const b=await selected(ctx,i.sessionId,i.enrollmentId,'student-feedback.view'),before=(await ctx.db.query<{feedback:Feedback}>('SELECT to_jsonb(f) feedback FROM public.student_feedback f WHERE session_id=$1 AND student_id=$2',[i.sessionId,b.e.student_id])).rows[0]?.feedback??null;
 if((before?.version??0)!==i.expectedVersion||(before&&before.id!==id))throw new ApiError(409,'TARGET_CHANGED');
 const actual=(await ctx.db.query<{source:Source|null}>('SELECT public.student_feedback_source($1,$2,$3,$4,$5) source',[i.sessionId,i.enrollmentId,i.rubricId,i.rubricVersion,i.assignmentId])).rows[0].source;
 if(!actual||actual.session.version!==i.sessionVersion||actual.enrollment.version!==i.enrollmentVersion||actual.assignment?.version!==(i.assignmentVersion??undefined))throw new ApiError(409,'FEEDBACK_SOURCE_CHANGED');
 if(i.assignmentId&&(actual.session.status!=='scheduled'||!actual.session.classActive||!actual.rubric.current_active||actual.rubric.current_version!==i.rubricVersion))throw new ApiError(409,'FEEDBACK_SOURCE_CHANGED');
 if(!(await ctx.db.query<{valid:boolean}>('SELECT public.feedback_ratings_valid($1::jsonb,$2::jsonb) valid',[JSON.stringify(actual.rubric.definition),JSON.stringify(i.ratings)])).rows[0].valid)throw new ApiError(409,'RUBRIC_CRITERIA_CHANGED');
 if(Date.parse(actual.session.startsAt)>Date.now())throw new ApiError(409,'FUTURE_FEEDBACK_FORBIDDEN');return {record:before,source:actual};
}
async function validate(ctx:ApiContext,action:string,id:string,raw:unknown,purpose:'request'|'review'){
 await lockAcademyTopology(ctx);
 if(action==='student-feedback.withdraw'){const f=await head(ctx,id,'student-feedback.edit'),t=target(f.class_id,f.hub_id,f.student_id);authorize(ctx,t,'student-feedback.publish');return t;}
 const i=payload.parse(raw),cap=action==='student-feedback.record'&&purpose==='request'?'student-feedback.record':'student-feedback.edit',b=await selected(ctx,i.sessionId,i.enrollmentId,cap);
 const published=(await ctx.db.query<{publish_to_family:boolean}>('SELECT publish_to_family FROM public.student_feedback WHERE session_id=$1 AND student_id=$2',[i.sessionId,b.e.student_id])).rows[0]?.publish_to_family;
 if(i.publishToFamily||published)authorize(ctx,b.t,'student-feedback.publish');
 if(action==='student-feedback.record'&&purpose==='request'){
  if(ctx.credential.kind!=='human')throw new ApiError(403,'HUMAN_STAFF_RECORD_REQUIRED');
  const a=(await ctx.db.query<{id:string}>('SELECT id FROM public.class_staff WHERE id=$1 AND class_id=$2 AND person_id=$3 AND version=$4 AND active AND starts_on<=$5::date AND(ends_on IS NULL OR ends_on>=$5::date)',[i.assignmentId,b.s.class_id,ctx.credential.person_id,i.assignmentVersion,b.on])).rows[0];if(!a)throw new ApiError(409,'STAFF_ASSIGNMENT_CHANGED');
 }
 return b.t;
}
function view(f:Feedback){const values=new Map(f.ratings.map(r=>[r.code,r.score]));return {...f,assessment:f.context.source.rubric.definition.criteria.map(c=>({...c,score:values.get(c.code)})),scale:{minimum:1,maximum:5},payrollApproved:false,performanceIndependentlyVerified:false};}
async function apply(ctx:ApiContext,p:Proposal){
 if(ctx.credential.kind!=='human')throw new ApiError(403,'HUMAN_REVIEW_REQUIRED');
 try{
  if(p.action==='student-feedback.withdraw'){const i=withdrawPayload.parse(p.payload);await ctx.db.query('UPDATE public.student_feedback SET publish_to_family=false,version=version+1,changed_by=$2,approval_id=$3,reason=$4 WHERE id=$1',[p.target_id,ctx.credential.person_id,p.id,i.reason]);}
  else{const i=payload.parse(p.payload),b=p.review_context as unknown as {record:Feedback|null;source:Source},s=b.source;
   const params=[p.target_id,i.sessionVersion,i.enrollmentId,i.enrollmentVersion,i.rubricId,i.rubricVersion,JSON.stringify(i.ratings),i.note,i.publishToFamily,JSON.stringify({source:s}),i.assignmentId,i.assignmentVersion,p.requester_id,ctx.credential.person_id,p.id,i.reason];
   if(b.record)await ctx.db.query('UPDATE public.student_feedback SET version=version+1,session_version=$2,enrollment_id=$3,enrollment_version=$4,rubric_id=$5,rubric_version=$6,ratings=$7::jsonb,note=$8,publish_to_family=$9,context=$10::jsonb,assignment_id=$11,assignment_version=$12,recorded_by=$13,changed_by=$14,approval_id=$15,reason=$16 WHERE id=$1',params);
   else await ctx.db.query('INSERT INTO public.student_feedback(id,session_version,enrollment_id,enrollment_version,rubric_id,rubric_version,ratings,note,publish_to_family,context,assignment_id,assignment_version,recorded_by,changed_by,approval_id,reason,academy_id,session_id,class_id,hub_id,student_id,created_by) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10::jsonb,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$13)',[...params,ctx.credential.academy_id,s.session.id,s.session.classId,s.session.hubId,s.enrollment.student_id]);
  }
 }catch(error){if(error&&typeof error==='object'&&'code'in error&&error.code==='23514'&&'message'in error&&/^FEEDBACK_/.test(String(error.message)))throw new ApiError(409,'FEEDBACK_SOURCE_CHANGED');throw error;}
 await ctx.db.query('INSERT INTO public.student_feedback_revisions(academy_id,feedback_id,version,definition) SELECT academy_id,id,version,to_jsonb(f) FROM public.student_feedback f WHERE id=$1',[p.target_id]);
 const f=await head(ctx,p.target_id);await record(ctx.db,ctx.credential,ctx.requestId,p.action,p.target_id,f.hub_id,{version:f.version,publishedToFamily:f.publish_to_family,hasReason:true,severity:'critical',payrollApproved:false});return view(f);
}
export const studentFeedbackActions:ApprovalRegistry=Object.fromEntries(['student-feedback.record','student-feedback.edit','student-feedback.withdraw'].map(action=>[action,{
 requestCapability:action==='student-feedback.record'?'student-feedback.record':'student-feedback.edit',privacyCapability:'student-feedback.view',policyChange:true,
 validate:(ctx:ApiContext,id:string,raw:unknown,purpose:'request'|'review')=>validate(ctx,action,id,raw,purpose),
 async dependencies(ctx:ApiContext,id:string,raw:unknown,purpose:'request'|'review'){try{if(action==='student-feedback.withdraw'){const r=await head(ctx,id);if(!r.publish_to_family)throw new ApiError(409,'FEEDBACK_ALREADY_PRIVATE');return {record:r};}return await basis(ctx,id,payload.parse(raw));}catch(error){if(purpose==='review'&&error instanceof ApiError&&[403,404,409].includes(error.status))return {unavailable:error.code};throw error;}},
 async authorizeReviewer(ctx:ApiContext,p:Proposal){if(await master(ctx))return;const student=p.action==='student-feedback.withdraw'?(await head(ctx,p.target_id)).student_id:(await selected(ctx,payload.parse(p.payload).sessionId,payload.parse(p.payload).enrollmentId,'student-feedback.view')).e.student_id;
  if(ctx.credential.person_id===student||(await ctx.db.query('SELECT 1 FROM public.family_relationships WHERE student_id=$1 AND guardian_id=$2',[student,ctx.credential.person_id])).rows.length)throw new ApiError(403,'BENEFICIARY_REVIEW_FORBIDDEN');},apply
}])) as ApprovalRegistry;
const targetSQL=`jsonb_build_object('all',false,'hubs','[]'::jsonb,'classes',jsonb_build_array(jsonb_build_object('id',f.class_id,'hubId',f.hub_id)),'people',jsonb_build_array(jsonb_build_object('id',f.student_id,'hubId',f.hub_id)),'recordContext',jsonb_build_object('classId',f.class_id,'hubId',f.hub_id,'studentId',f.student_id))`;
async function familyFeedback(ctx:ApiContext,studentId:string,id?:string):Promise<Reply>{
 if(ctx.request.method!=='GET')throw new ApiError(405,'METHOD_NOT_ALLOWED');const params=Object.fromEntries(new URL(ctx.request.url).searchParams),q=id?(empty.parse(params),null):receivedLearningQuery.parse(params),{s,selected}=await authorizeLearningRecipient(ctx,studentId);
 const rows=(await ctx.db.query<{id:string;on:string;note?:string;ratings?:Feedback['ratings'];rubric?:Source['rubric']['definition']}&Record<string,unknown>>(`SELECT p.id,p.session_id,p.version,p.rubric_id,p.rubric_version,p.context#>>'{source,session,on}' AS on,p.context#>>'{source,session,timeZone}' time_zone,p.context#>>'{source,rubric,definition,name}' AS rubric_name,c.name AS class_name${id?",p.note,p.ratings,p.context#>'{source,rubric,definition}' AS rubric":''}
 FROM public.student_feedback p JOIN public.classes c ON c.academy_id=p.academy_id AND c.id=p.class_id JOIN public.approval_requests a ON a.academy_id=p.academy_id AND a.id=p.approval_id
 WHERE p.student_id=$1 AND p.publish_to_family AND a.status='applied' AND a.reviewer_id=p.changed_by AND a.action IN('student-feedback.record','student-feedback.edit') AND a.target_id=p.id AND ${receivedLearningSelection}
 ORDER BY(p.context#>>'{source,session,on}')::date DESC,p.id DESC LIMIT $10`,[studentId,ctx.credential.person_id,id??null,s.all,selected,s.hubs,s.excludedHubs??[],q?.beforeOn??null,q?.after??null,id?1:q!.limit+1])).rows;
 if(id){const r=rows[0];if(!r)throw new ApiError(404,'NOT_FOUND');const {ratings,rubric,...header}=r,values=new Map(ratings!.map(v=>[v.code,v.score]));return {status:200,body:{data:{...header,assessment:rubric!.criteria.map(c=>({...c,score:values.get(c.code)})),scale:{minimum:1,maximum:5},externalDeliveryVerified:false,payrollApproved:false,performanceIndependentlyVerified:false}}};}
 return {status:200,body:{studentId,data:rows.slice(0,q!.limit),nextCursor:rows.length>q!.limit?{beforeOn:rows[q!.limit-1].on,after:rows[q!.limit-1].id}:null}};
}
export async function studentFeedback(ctx:ApiContext,registry:ApprovalRegistry=studentFeedbackActions):Promise<Reply|null>{
 const received=/^students\/([^/]+)\/session-feedback(?:\/([^/]+))?$/.exec(ctx.path);if(received)return familyFeedback(ctx,uuid.parse(received[1]),received[2]?uuid.parse(received[2]):undefined);
 const session=/^sessions\/([^/]+)\/student-feedback(?:\/(change|options))?$/.exec(ctx.path),item=/^student-feedback\/([^/]+)(?:\/(history|withdraw))?$/.exec(ctx.path);if(!session&&!item)return null;
 const method=ctx.request.method,params=Object.fromEntries(new URL(ctx.request.url).searchParams);
 if(session){const sessionId=uuid.parse(session[1]),section=session[2];
  if(section==='options'){
   if(method!=='GET')throw new ApiError(405,'METHOD_NOT_ALLOWED');const q=optionsQuery.parse(params),b=await selected(ctx,sessionId,q.enrollmentId,q.administrative?'student-feedback.edit':'student-feedback.record');
   if(!b.e.enabled||b.e.joins_on>b.on||b.e.leaves_on!==null&&b.e.leaves_on<b.on)throw new ApiError(409,'INELIGIBLE_SESSION_ENROLLMENT');
   const a=(await ctx.db.query('SELECT id,version,role FROM public.class_staff WHERE class_id=$1 AND person_id=$2 AND active AND starts_on<=$3::date AND(ends_on IS NULL OR ends_on>=$3::date)',[b.s.class_id,ctx.credential.person_id,b.on])).rows[0]??null;
   if(!q.administrative&&(ctx.credential.kind!=='human'||!a))throw new ApiError(403,'ASSIGNED_STAFF_REQUIRED');
   const rows=(await ctx.db.query<{id:string}>('SELECT id,version,definition FROM public.assessment_rubrics WHERE (hub_id IS NULL OR hub_id=$1) AND(definition->>\'active\')::boolean AND($2::uuid IS NULL OR id>$2) ORDER BY id LIMIT $3',[b.s.hub_id,q.after??null,q.limit+1])).rows;return {status:200,body:{data:rows.slice(0,q.limit),assignment:a,sessionVersion:b.s.version,enrollmentVersion:b.e.version,nextCursor:rows.length>q.limit?rows[q.limit-1].id:null}};
  }
  if(method==='POST'){
   empty.parse(params);const raw=await jsonBody(ctx.request,65536),i=section==='change'?{...common.parse(raw),assignmentId:null,assignmentVersion:null}:staffInput.parse(raw),b=await selected(ctx,sessionId,i.enrollmentId,section==='change'?'student-feedback.edit':'student-feedback.record');
   if(i.expectedVersion>0&&!Object.hasOwn(raw as object,'publishToFamily'))throw new ApiError(400,'EXPLICIT_FEEDBACK_VISIBILITY_REQUIRED');
   const existing=(await ctx.db.query<{id:string}>('SELECT id FROM public.student_feedback WHERE session_id=$1 AND student_id=$2',[sessionId,b.e.student_id])).rows[0];return propose(ctx,registry,section==='change'?'student-feedback.edit':'student-feedback.record',existing?.id??null,i.expectedVersion,{...i,sessionId});
  }
  if(method!=='GET'||section)throw new ApiError(405,'METHOD_NOT_ALLOWED');const q=paging.parse(params),s=permissionScope(ctx,'student-feedback.view');if(!scopeNonempty(s))throw new ApiError(403,'FORBIDDEN');
  const rows=(await ctx.db.query<{id:string}>(`SELECT f.id,f.student_id,f.version,f.rubric_id,f.rubric_version,f.publish_to_family FROM public.student_feedback f WHERE f.session_id=$1 AND public.scope_contains($2::jsonb,${targetSQL}) AND($3::uuid IS NULL OR f.id>$3) ORDER BY f.id LIMIT $4`,[sessionId,JSON.stringify(s),q.after??null,q.limit+1])).rows;return {status:200,body:{data:rows.slice(0,q.limit),nextCursor:rows.length>q.limit?rows[q.limit-1].id:null}};
 }
 const id=uuid.parse(item![1]),section=item![2];
 if(section==='withdraw'){if(method!=='POST')throw new ApiError(405,'METHOD_NOT_ALLOWED');empty.parse(params);const i=withdrawal.parse(await jsonBody(ctx.request));return propose(ctx,registry,'student-feedback.withdraw',id,i.expectedVersion,{...i,feedbackId:id});}
 if(method!=='GET')throw new ApiError(405,'METHOD_NOT_ALLOWED');const f=await head(ctx,id);
 if(section==='history'){const q=historyQuery.parse(params),rows=(await ctx.db.query<{version:number;definition:Feedback}>('SELECT version,definition,recorded_at FROM public.student_feedback_revisions WHERE feedback_id=$1 AND version>$2 ORDER BY version LIMIT $3',[id,q.afterVersion,q.limit+1])).rows;return {status:200,body:{data:rows.slice(0,q.limit).map(r=>({...r,definition:view(r.definition)})),nextVersion:rows.length>q.limit?rows[q.limit-1].version:null}};}
 empty.parse(params);return {status:200,body:{data:view(f)}};
}
export const studentFeedbackContract=[
 {path:'/api/v1/sessions/{id}/student-feedback/options',method:'get',summary:'Authorized enrollment-context active rubric definitions and own dated assignment; not catalogue admin notes',querySchema:optionsQuery},
 {path:'/api/v1/sessions/{id}/student-feedback',method:'get',summary:'Current private feedback directory filtered by exact student/class source rights before paging',querySchema:paging},
 {path:'/api/v1/sessions/{id}/student-feedback',method:'post',summary:'Assigned human proposes reviewed complete 1–5 feedback; family visibility separately permissioned and explicit',schema:staffInput},
 {path:'/api/v1/sessions/{id}/student-feedback/change',method:'post',summary:'Administrative reviewed initial/corrected feedback with explicitly selected historical rubric revision',schema:common},
 {path:'/api/v1/student-feedback/{id}',method:'get',summary:'Authorized private current feedback with pinned labels and unverified-observation markers'},
 {path:'/api/v1/student-feedback/{id}/history',method:'get',summary:'Immutable private feedback/withdrawal revisions, never implicit family access',querySchema:historyQuery},
 {path:'/api/v1/student-feedback/{id}/withdraw',method:'post',summary:'Upper-reviewed family withdrawal even after source retirement; preserves scores, notes and provenance',schema:withdrawal},
 {path:'/api/v1/students/{id}/session-feedback',method:'get',summary:'Current linked-family/self recipient with explicit publication, dated membership and source-hub denials',querySchema:receivedLearningQuery},
 {path:'/api/v1/students/{id}/session-feedback/{feedbackId}',method:'get',summary:'Only this student’s reviewed family-visible note and pinned 1–5 criteria; no private reason/history or peer data'}
] as const;
