import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { jsonBody,mutation,record,type ApiContext,type Reply } from '../core/api.ts';
import { permissionScope,lockApprovalWrites } from '../core/approvals.ts';
import { ApiError,scopeContains,scopeNonempty,type Capability,type Scope } from '../core/policy.ts';
import { lockAcademyTopology } from './academy.ts';
import { authorizeLearningRecipient } from './learning-recipients.ts';
import { receivedHomeworkDocument } from './homeworks.ts';

const uuid=z.string().uuid().transform(v=>v.toLowerCase()),version=z.number().int().min(1).max(2147483647),text=z.string().refine(v=>v.isWellFormed()&&!v.includes('\0'));
const answer=z.object({text:text.max(50000),attachments:z.array(z.object({fileId:uuid,fileVersion:version,caption:text.max(2000).default('')}).strict()).max(20).refine(v=>new Set(v.map(f=>f.fileId)).size===v.length,'Duplicate attachment').default([])}).strict();
const input=z.object({expectedVersion:z.number().int().min(0).max(2147483647),homeworkVersion:version,state:z.enum(['draft','submitted']),answer}).strict().refine(v=>v.state==='draft'||Boolean(v.answer.text.trim()||v.answer.attachments.length),'Answer required');
const historyQuery=z.object({limit:z.coerce.number().int().min(1).max(10).default(5),afterVersion:z.coerce.number().int().min(0).max(2147483647).default(0)}).strict(),paging=z.object({limit:z.coerce.number().int().min(1).max(20).default(10),after:uuid.optional()}).strict(),empty=z.object({}).strict();
const readQuery=z.object({version:z.coerce.number().int().min(1).max(2147483647).optional()}).strict();
type Input=z.infer<typeof input>;type TaskDocument=Parameters<typeof receivedHomeworkDocument>[0];
type Source={homework:{id:string;version:number;classId:string;hubId:string;sessionId:string;on:string;timeZone:string;dueAt:string|null;acceptLate:boolean};enrollment:{id:string;version:number;student_id:string};attachments:{id:string;version:number;name:string;claimed_mime_type:string}[]};
type Submission={id:string;homework_id:string;homework_version:number;student_id:string;class_id:string;hub_id:string;version:number;state:'draft'|'submitted';answer:z.infer<typeof answer>;context:Source;instructions:TaskDocument;submitted_at:string|null;changed_at:string;created_at:string;is_late:boolean};
type Task={id:string;class_id:string;hub_id:string;on:string;version:number};
function target(classId:string,hubId:string,studentId:string):Scope{return {all:false,hubs:[],classes:[{id:classId,hubId}],people:[{id:studentId,hubId}],recordContext:{classId,hubId,studentId}};}
function permitted(ctx:ApiContext,r:{class_id:string;hub_id:string;student_id:string},cap:Capability){return scopeContains(permissionScope(ctx,cap),target(r.class_id,r.hub_id,r.student_id));}
const targetSQL=`jsonb_build_object('all',false,'hubs','[]'::jsonb,'classes',jsonb_build_array(jsonb_build_object('id',s.class_id,'hubId',s.hub_id)),'people',jsonb_build_array(jsonb_build_object('id',s.student_id,'hubId',s.hub_id)),'recordContext',jsonb_build_object('classId',s.class_id,'hubId',s.hub_id,'studentId',s.student_id))`;
async function current(ctx:ApiContext,homeworkId:string,studentId:string){return(await ctx.db.query<{submission:Submission}>("SELECT to_jsonb(s)||jsonb_build_object('instructions',h.definition->'document') submission FROM public.homework_submissions s JOIN public.homework_revisions h ON h.academy_id=s.academy_id AND h.homework_id=s.homework_id AND h.version=s.homework_version WHERE s.homework_id=$1 AND s.student_id=$2",[homeworkId,studentId])).rows[0]?.submission??null;}
async function source(ctx:ApiContext,homeworkId:string,studentId:string,a:z.infer<typeof answer>){return(await ctx.db.query<{source:Source|null}>('SELECT public.homework_submission_source($1,$2,$3::jsonb) source',[homeworkId,studentId,JSON.stringify(a)])).rows[0].source;}
async function ownAuthority(ctx:ApiContext,studentId:string,homeworkId:string){
 if(ctx.credential.kind!=='human'||ctx.credential.person_id!==studentId)throw new ApiError(403,'HUMAN_STUDENT_REQUIRED');
 await authorizeLearningRecipient(ctx,studentId,'received-homework.view');await authorizeLearningRecipient(ctx,studentId,'received-submissions.view');
 const t=(await ctx.db.query<Task>("SELECT id,class_id,hub_id,version,context#>>'{source,session,on}' AS on FROM public.homeworks WHERE id=$1",[homeworkId])).rows[0];if(!t)throw new ApiError(404,'NOT_FOUND');
 const r={...t,student_id:studentId};for(const cap of ['homework-submissions.submit','received-homework.view','received-submissions.view'] as Capability[])if(!permitted(ctx,r,cap))throw new ApiError(404,'NOT_FOUND');
 if(!(await ctx.db.query('SELECT 1 FROM public.class_enrollments WHERE class_id=$1 AND student_id=$2 AND enabled AND joins_on<=$3::date AND(leaves_on IS NULL OR leaves_on>=$3::date)',[t.class_id,studentId,t.on])).rows.length)throw new ApiError(404,'NOT_FOUND');return t;
}
function view(r:Submission,editable=false,currentHomeworkVersion?:number){return {id:r.id,homeworkId:r.homework_id,homeworkVersion:r.homework_version,studentId:r.student_id,version:r.version,state:r.state,text:r.answer.text,
 attachments:r.answer.attachments.map((f,n)=>({caption:f.caption,name:r.context.attachments[n]?.name,claimedMimeType:r.context.attachments[n]?.claimed_mime_type,availability:'unavailable'})),
 instructions:receivedHomeworkDocument(r.instructions),sessionOn:r.context.homework.on,timeZone:r.context.homework.timeZone,dueAt:r.context.homework.dueAt,acceptLate:r.context.homework.acceptLate,
 submittedAt:r.submitted_at,changedAt:r.changed_at,createdAt:r.created_at,isLate:r.is_late,...currentHomeworkVersion===undefined?{}:{instructionsChanged:r.homework_version!==currentHomeworkVersion},...editable?{editableAnswer:r.answer}:{},mediaServingEnabled:false,attachmentContentVerified:false,externalDeliveryVerified:false,gradingAvailable:true,solutionsAvailable:false};}
async function write(ctx:ApiContext,studentId:string,homeworkId:string,i:Input):Promise<Reply>{
 await ownAuthority(ctx,studentId,homeworkId);await lockAcademyTopology(ctx);
 return mutation(ctx,i,async()=>{
  await ctx.db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,29))',[ctx.credential.academy_id+':'+homeworkId+':'+studentId]);const before=await current(ctx,homeworkId,studentId);
  if((before?.version??0)!==i.expectedVersion)throw new ApiError(409,'TARGET_CHANGED');if(Buffer.byteLength(JSON.stringify(i.answer),'utf8')>100000)throw new ApiError(413,'SUBMISSION_ANSWER_TOO_LARGE');
  const actual=await source(ctx,homeworkId,studentId,i.answer);if(!actual||actual.homework.version!==i.homeworkVersion)throw new ApiError(409,'SUBMISSION_SOURCE_CHANGED');const id=before?.id??randomUUID();
  try{if(before)await ctx.db.query('UPDATE public.homework_submissions SET version=version+1,homework_version=$2,state=$3,answer=$4::jsonb,context=$5::jsonb,changed_by=$6 WHERE id=$1',[id,i.homeworkVersion,i.state,JSON.stringify(i.answer),JSON.stringify(actual),studentId]);
   else await ctx.db.query('INSERT INTO public.homework_submissions(academy_id,id,homework_id,homework_version,student_id,class_id,hub_id,state,answer,context,changed_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$5)',[ctx.credential.academy_id,id,homeworkId,i.homeworkVersion,studentId,actual.homework.classId,actual.homework.hubId,i.state,JSON.stringify(i.answer),JSON.stringify(actual)]);
  }catch(error){if(error&&typeof error==='object'&&'code'in error&&error.code==='23514'&&'message'in error&&/^SUBMISSION_/.test(String(error.message)))throw new ApiError(409,error.message==='SUBMISSION_DEADLINE_PASSED'?'SUBMISSION_DEADLINE_PASSED':'SUBMISSION_SOURCE_CHANGED');throw error;}
  await ctx.db.query('INSERT INTO public.homework_submission_revisions(academy_id,submission_id,version,definition) SELECT academy_id,id,version,to_jsonb(s) FROM public.homework_submissions s WHERE id=$1',[id]);
  const r=(await current(ctx,homeworkId,studentId))!;await record(ctx.db,ctx.credential,ctx.requestId,'homework.answer.'+i.state,id,r.hub_id,{version:r.version,homeworkVersion:r.homework_version,isLate:r.is_late,severity:'notification',contentVerified:false});return {status:before?200:201,body:{data:view(r,true,i.homeworkVersion)}};
 });
}
function datedMembership(parameter:3|5){return `($${parameter}::uuid IS NULL OR EXISTS(SELECT 1 FROM public.class_enrollments e WHERE e.class_id=(v.definition->>'class_id')::uuid AND e.student_id=$${parameter} AND e.enabled AND e.joins_on<=(v.definition#>>'{context,homework,on}')::date AND(e.leaves_on IS NULL OR e.leaves_on>=(v.definition#>>'{context,homework,on}')::date)))`;}
const instructionRevisionJoin=`JOIN public.homework_revisions h ON h.academy_id=v.academy_id AND h.homework_id=(v.definition->>'homework_id')::uuid AND h.version=(v.definition->>'homework_version')::integer`;
async function selectedRevision(ctx:ApiContext,id:string,drafts:boolean,studentId?:string,exactVersion?:number){return(await ctx.db.query<{definition:Submission}>(`SELECT v.definition||jsonb_build_object('instructions',h.definition->'document') definition FROM public.homework_submission_revisions v ${instructionRevisionJoin} WHERE v.submission_id=$1 AND($2::boolean OR v.state='submitted') AND ${datedMembership(3)} AND($4::integer IS NULL OR v.version=$4) ORDER BY v.version DESC LIMIT 1`,[id,drafts,studentId??null,exactVersion??null])).rows[0]?.definition??null;}
async function history(ctx:ApiContext,id:string,drafts:boolean,q:z.infer<typeof historyQuery>,editable:boolean,currentVersion?:number,studentId?:string):Promise<Reply>{
 const rows=(await ctx.db.query<{version:number;definition:Submission|null}>(`WITH selected AS MATERIALIZED(SELECT v.version,v.definition||jsonb_build_object('instructions',h.definition->'document') definition FROM public.homework_submission_revisions v ${instructionRevisionJoin} WHERE v.submission_id=$1 AND v.version>$2 AND($4::boolean OR v.state='submitted') AND ${datedMembership(5)} ORDER BY v.version LIMIT $3),budget AS(SELECT *,sum(octet_length(definition::text)) OVER(ORDER BY version) bytes FROM selected) SELECT version,CASE WHEN bytes<=2097152 THEN definition ELSE NULL END definition FROM budget ORDER BY version`,[id,q.afterVersion,q.limit+1,drafts,studentId??null])).rows;
 const visible=rows.filter((r):r is typeof r&{definition:Submission}=>r.definition!==null).slice(0,q.limit);if(rows.length&&!visible.length)throw new ApiError(409,'SUBMISSION_HISTORY_REQUIRES_BACKGROUND_JOB');return {status:200,body:{data:visible.map(r=>({version:r.version,definition:view(r.definition,editable,currentVersion)})),nextVersion:rows.length>visible.length?visible.at(-1)!.version:null}};
}
async function family(ctx:ApiContext,studentId:string,homeworkId:string,section?:string):Promise<Reply>{
 const params=Object.fromEntries(new URL(ctx.request.url).searchParams),method=ctx.request.method;
 if(method==='POST'&&!section){empty.parse(params);return write(ctx,studentId,homeworkId,input.parse(await jsonBody(ctx.request,131072)));}
 if(method!=='GET')throw new ApiError(405,'METHOD_NOT_ALLOWED');const q=section==='history'?historyQuery.parse(params):null;if(section==='context')empty.parse(params);const exactVersion=section?undefined:readQuery.parse(params).version;
 if(section==='context'){
  const task=await ownAuthority(ctx,studentId,homeworkId),actual=await source(ctx,homeworkId,studentId,{text:'',attachments:[]});if(!actual)throw new ApiError(409,'SUBMISSION_SOURCE_CHANGED');const r=await current(ctx,homeworkId,studentId),now=(await ctx.db.query<{now:string}>('SELECT clock_timestamp()::text now')).rows[0].now;
  const document=(await ctx.db.query<{document:TaskDocument}>("SELECT definition->'document' document FROM public.homework_revisions WHERE homework_id=$1 AND version=$2",[homeworkId,task.version])).rows[0].document;
  return {status:200,body:{homeworkId,homeworkVersion:task.version,expectedVersion:r?.version??0,instructions:receivedHomeworkDocument(document),dueAt:actual.homework.dueAt,acceptLate:actual.homework.acceptLate,canSubmitBeforeValidation:actual.homework.acceptLate||!actual.homework.dueAt||Date.parse(now)<=Date.parse(actual.homework.dueAt),data:r?view(r,true,task.version):null,attachmentContentVerified:false}};
 }
 await authorizeLearningRecipient(ctx,studentId,'received-submissions.view');const r=await current(ctx,homeworkId,studentId);if(!r||!permitted(ctx,r,'received-submissions.view'))throw new ApiError(404,'NOT_FOUND');
 const self=ctx.credential.person_id===studentId,drafts=self||permitted(ctx,r,'received-submissions.drafts'),h=(await ctx.db.query<{version:number}>('SELECT version FROM public.homeworks WHERE id=$1',[homeworkId])).rows[0];
 const selected=await selectedRevision(ctx,r.id,drafts,studentId,exactVersion);if(!selected)throw new ApiError(404,'NOT_FOUND');
 if(section==='history')return history(ctx,r.id,drafts,q!,false,h?.version,studentId);return {status:200,body:{data:view(selected,self,h?.version)}};
}
export async function homeworkSubmissions(ctx:ApiContext):Promise<Reply|null>{
 const received=/^students\/([^/]+)\/homework\/([^/]+)\/submission(?:\/(history|context))?$/.exec(ctx.path),item=/^homework-submissions\/([^/]+)(?:\/(history))?$/.exec(ctx.path),list=/^homeworks\/([^/]+)\/submissions$/.exec(ctx.path);if(!received&&!item&&!list)return null;
 await lockApprovalWrites(ctx);if(received)return family(ctx,uuid.parse(received[1]),uuid.parse(received[2]),received[3]);if(ctx.request.method!=='GET')throw new ApiError(405,'METHOD_NOT_ALLOWED');
 const params=Object.fromEntries(new URL(ctx.request.url).searchParams);
 if(list){const id=uuid.parse(list[1]),q=paging.parse(params),scope=permissionScope(ctx,'homework-submissions.view'),draftScope=permissionScope(ctx,'homework-submissions.drafts');if(!scopeNonempty(scope))throw new ApiError(403,'FORBIDDEN');
  // Separate branches make the submitted-only index eligible without asking
  // the planner to infer draft visibility through a mixed-state OR predicate.
  const rows=(await ctx.db.query<{id:string;definition:Submission;current_version:number}>(`SELECT s.id,r.definition,h.version current_version FROM public.homework_submissions s JOIN public.homeworks h ON h.academy_id=s.academy_id AND h.id=s.homework_id JOIN LATERAL(
   (SELECT definition FROM public.homework_submission_revisions WHERE academy_id=s.academy_id AND submission_id=s.id AND state='submitted' AND NOT public.scope_contains($3::jsonb,${targetSQL}) ORDER BY version DESC LIMIT 1)
   UNION ALL(SELECT definition FROM public.homework_submission_revisions WHERE academy_id=s.academy_id AND submission_id=s.id AND public.scope_contains($3::jsonb,${targetSQL}) ORDER BY version DESC LIMIT 1)
  ) r ON true WHERE s.homework_id=$1 AND($2::uuid IS NULL OR s.id>$2) AND public.scope_contains($4::jsonb,${targetSQL}) ORDER BY s.id LIMIT $5`,[id,q.after??null,JSON.stringify(draftScope),JSON.stringify(scope),q.limit+1])).rows;
  return {status:200,body:{data:rows.slice(0,q.limit).map(r=>({id:r.id,studentId:r.definition.student_id,version:r.definition.version,state:r.definition.state,homeworkVersion:r.definition.homework_version,instructionsChanged:r.current_version!==r.definition.homework_version,submittedAt:r.definition.submitted_at,isLate:r.definition.is_late})),nextCursor:rows.length>q.limit?rows[q.limit-1].id:null}};
 }
 const id=uuid.parse(item![1]),r=(await ctx.db.query<{submission:Submission}>('SELECT to_jsonb(s) submission FROM public.homework_submissions s WHERE id=$1',[id])).rows[0]?.submission;if(!r||!permitted(ctx,r,'homework-submissions.view'))throw new ApiError(404,'NOT_FOUND');const drafts=permitted(ctx,r,'homework-submissions.drafts');
 const h=(await ctx.db.query<{version:number}>('SELECT version FROM public.homeworks WHERE id=$1',[r.homework_id])).rows[0];
 if(item![2])return history(ctx,id,drafts,historyQuery.parse(params),false,h?.version);const q=readQuery.parse(params),selected=await selectedRevision(ctx,id,drafts,undefined,q.version);if(!selected)throw new ApiError(404,'NOT_FOUND');return {status:200,body:{data:view(selected,false,h?.version)}};
}
export const homeworkSubmissionsContract=[
 {path:'/api/v1/students/{id}/homework/{homeworkId}/submission/context',method:'get',summary:'Verified own-student authoring context and private editable answer; explicit instruction version and server deadline hint'},
 {path:'/api/v1/students/{id}/homework/{homeworkId}/submission',method:'post',summary:'Verified self student saves a draft or submits an immutable-history answer against the current exact assignment; no guardian/admin/bot impersonation',schema:input},
 {path:'/api/v1/students/{id}/homework/{homeworkId}/submission',method:'get',summary:'Current scoped self/guardian answer or exact permitted revision; no implicit access to drafts or ineligible original session days',querySchema:readQuery},
 {path:'/api/v1/students/{id}/homework/{homeworkId}/submission/history',method:'get',summary:'Own/linked student answer revisions filtered by draft permission before cursor and two-MiB budget',querySchema:historyQuery},
 {path:'/api/v1/homeworks/{id}/submissions',method:'get',summary:'Exact student/class-scoped answer directory; latest submitted revision remains visible when a newer private draft exists',querySchema:paging},
 {path:'/api/v1/homework-submissions/{id}',method:'get',summary:'Scoped submitted student work or exact permitted revision with pinned instructions; no draft bypass through version selection',querySchema:readQuery},
 {path:'/api/v1/homework-submissions/{id}/history',method:'get',summary:'Immutable submitted answer history; separate explicit permission needed for private drafts',querySchema:historyQuery}
] as const;
