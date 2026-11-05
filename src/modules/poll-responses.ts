import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { jsonBody,mutation,record,type ApiContext,type Reply } from '../core/api.ts';
import { permissionScope,lockApprovalWrites } from '../core/approvals.ts';
import { ApiError,scopeContains,scopeNonempty,type Capability,type Scope } from '../core/policy.ts';
import { lockAcademyTopology } from './academy.ts';
import { authorizeLearningRecipient } from './learning-recipients.ts';
import { pollAnswers,pollAnswersMatch,type PollAnswers } from './poll-answer.ts';
import type { PollDefinition } from './poll-definition.ts';

const uuid=z.string().uuid().transform(v=>v.toLowerCase()),version=z.number().int().min(1).max(2147483647);
const input=z.object({expectedVersion:z.number().int().min(0).max(2147483647),formVersion:version,answers:pollAnswers}).strict();
const withdrawal=z.object({expectedVersion:version,formVersion:version}).strict();
const selection=z.object({formVersion:z.coerce.number().int().min(1).max(2147483647).optional()}).strict();
const paging=selection.extend({limit:z.coerce.number().int().min(1).max(20).default(10),after:uuid.optional()}).strict();
const historyQuery=selection.extend({limit:z.coerce.number().int().min(1).max(10).default(5),afterVersion:z.coerce.number().int().min(0).max(2147483647).default(0)}).strict(),empty=z.object({}).strict();
type Source={poll:{id:string;version:number;formVersion:number;state:string;responseUnit:string;respondentMode:string;opensAt:string|null;closesAt:string|null};recipient:{studentId:string;classId:string;hubId:string;on:string;timeZone:string;enrollmentId:string;enrollmentVersion:number}};
type Form={form_version:number;definition:PollDefinition;response_unit:string;respondent_mode:string};
type Response={id:string;poll_id:string;form_version:number;student_id:string;respondent_key:string;class_id:string;hub_id:string;posted_on:string;version:number;state:string;answers:PollAnswers;context:Source;created_by:string;changed_by:string;created_at:string;changed_at:string};
function target(r:Pick<Response,'class_id'|'hub_id'|'student_id'>):Scope{return {all:false,hubs:[],classes:[{id:r.class_id,hubId:r.hub_id}],people:[{id:r.student_id,hubId:r.hub_id}],recordContext:{classId:r.class_id,hubId:r.hub_id,studentId:r.student_id}};}
function permitted(ctx:ApiContext,r:Pick<Response,'class_id'|'hub_id'|'student_id'>,cap:Capability){return scopeContains(permissionScope(ctx,cap),target(r));}
function required(ctx:ApiContext,r:Pick<Response,'class_id'|'hub_id'|'student_id'>,cap:Capability){if(!permitted(ctx,r,cap))throw new ApiError(404,'NOT_FOUND');}
const targetSQL=(student:string,cl:string,hub:string)=>`jsonb_build_object('all',false,'hubs','[]'::jsonb,'classes',jsonb_build_array(jsonb_build_object('id',${cl},'hubId',${hub})),'people',jsonb_build_array(jsonb_build_object('id',${student},'hubId',${hub})),'recordContext',jsonb_build_object('classId',${cl},'hubId',${hub},'studentId',${student}))`;
const headTarget=targetSQL('r.student_id','r.class_id','r.hub_id'),revisionTarget=targetSQL("v.definition->'student_id'","v.definition->'class_id'","v.definition->'hub_id'");
async function source(ctx:ApiContext,poll:string,student:string){const s=(await ctx.db.query<{source:Source|null}>('SELECT public.poll_response_source($1,$2) source',[poll,student])).rows[0].source;if(!s)throw new ApiError(404,'NOT_FOUND');return s;}
async function form(ctx:ApiContext,poll:string,version:number){const f=(await ctx.db.query<Form>('SELECT form_version,definition,response_unit,respondent_mode FROM public.poll_form_revisions WHERE poll_id=$1 AND form_version=$2',[poll,version])).rows[0];if(!f)throw new ApiError(404,'NOT_FOUND');return f;}
async function current(ctx:ApiContext,poll:string,student:string,f:Form){const key=f.response_unit==='student_family'?student:ctx.credential.person_id;return(await ctx.db.query<{response:Response}>('SELECT to_jsonb(r) response FROM public.poll_responses r WHERE poll_id=$1 AND form_version=$2 AND student_id=$3 AND respondent_key=$4',[poll,f.form_version,student,key])).rows[0]?.response??null;}
async function familySource(ctx:ApiContext,poll:string,student:string,write=false){
 await authorizeLearningRecipient(ctx,student,'received-polls.view');const s=await source(ctx,poll,student),r={class_id:s.recipient.classId,hub_id:s.recipient.hubId,student_id:student};required(ctx,r,'received-polls.view');if(write){required(ctx,r,'received-polls.respond');if(!(await ctx.db.query<{allowed:boolean}>('SELECT public.report_comment_family($1,$2) allowed',[student,ctx.credential.person_id])).rows[0].allowed)throw new ApiError(403,'CURRENT_FAMILY_RESPONDENT_REQUIRED');}return s;
}
function respondentAllowed(actor:string,student:string,f:Form){return !(actor===student&&f.respondent_mode==='guardians'||actor!==student&&f.respondent_mode==='students');}
async function originalMembership(ctx:ApiContext,r:Response){return Boolean((await ctx.db.query('SELECT 1 FROM public.class_enrollments WHERE id=$1 AND class_id=$2 AND student_id=$3 AND enabled AND joins_on<=$4::date AND(leaves_on IS NULL OR leaves_on>=$4::date)',[r.context.recipient.enrollmentId,r.class_id,r.student_id,r.posted_on])).rows.length);}
async function familyRecord(ctx:ApiContext,r:Response,write=false){required(ctx,r,'received-polls.view');if(write)required(ctx,r,'received-polls.respond');if(!await originalMembership(ctx,r))throw new ApiError(404,'NOT_FOUND');}
function project(r:Response,f:Form){return {id:r.id,pollId:r.poll_id,studentId:r.student_id,formVersion:r.form_version,version:r.version,state:r.state,answers:r.answers,questions:f.definition,responseUnit:f.response_unit,respondentMode:f.respondent_mode,createdBy:r.created_by,lastChangedBy:r.changed_by,createdAt:r.created_at,changedAt:r.changed_at,on:r.posted_on,timeZone:r.context.recipient.timeZone,externalDeliveryVerified:false};}
async function write(ctx:ApiContext,poll:string,student:string,i:z.infer<typeof input>|z.infer<typeof withdrawal>,withdraw=false):Promise<Reply>{
 await familySource(ctx,poll,student,true);const f=await form(ctx,poll,i.formVersion);if(!respondentAllowed(ctx.credential.person_id,student,f))throw new ApiError(403,'POLL_RESPONDENT_MODE_FORBIDDEN');await lockAcademyTopology(ctx);
 return mutation(ctx,i,async()=>{
  const key=f.response_unit==='student_family'?student:ctx.credential.person_id;
  await ctx.db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,34))',[ctx.credential.academy_id+':poll-response:'+poll+':'+i.formVersion+':'+student+':'+key]);
  const before=await current(ctx,poll,student,f);if((before?.version??0)!==i.expectedVersion)throw new ApiError(409,'TARGET_CHANGED');if(before)await familyRecord(ctx,before,true);
  const actual=await familySource(ctx,poll,student,true),id=before?.id??randomUUID();
  if(withdraw){if(!before||before.state!=='submitted')throw new ApiError(409,'POLL_RESPONSE_NOT_SUBMITTED');}
  else{if(actual.poll.formVersion!==i.formVersion)throw new ApiError(409,'POLL_FORM_CHANGED');if(!pollAnswersMatch(f.definition,(i as z.infer<typeof input>).answers))throw new ApiError(400,'POLL_ANSWERS_INVALID');}
  try{if(withdraw)await ctx.db.query("UPDATE public.poll_responses SET version=version+1,state='withdrawn',changed_by=$2 WHERE id=$1",[id,ctx.credential.person_id]);
   else{const answers=(i as z.infer<typeof input>).answers,v=[id,JSON.stringify(answers),JSON.stringify(actual),actual.recipient.classId,actual.recipient.hubId,actual.recipient.on,actual.poll.version,ctx.credential.person_id];
    if(before)await ctx.db.query("UPDATE public.poll_responses SET version=version+1,state='submitted',answers=$2::jsonb,context=$3::jsonb,class_id=$4,hub_id=$5,posted_on=$6,poll_version=$7,changed_by=$8 WHERE id=$1",v);
    else await ctx.db.query("INSERT INTO public.poll_responses(id,answers,context,class_id,hub_id,posted_on,poll_version,changed_by,academy_id,poll_id,form_version,student_id,respondent_key,created_by,state) VALUES($1,$2::jsonb,$3::jsonb,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$8,'submitted')",[...v,ctx.credential.academy_id,poll,i.formVersion,student,key]);
   }
  }catch(error){if(error&&typeof error==='object'&&'code'in error&&error.code==='23514'&&'message'in error&&/^POLL_RESPONSE_/.test(String(error.message)))throw new ApiError(409,String(error.message));throw error;}
  await ctx.db.query('INSERT INTO public.poll_response_revisions(academy_id,response_id,version,definition) SELECT academy_id,id,version,to_jsonb(r) FROM public.poll_responses r WHERE id=$1',[id]);
  const result=(await current(ctx,poll,student,f))!;await record(ctx.db,ctx.credential,ctx.requestId,'poll-response.'+(withdraw?'withdraw':'submit'),id,result.hub_id,{version:result.version,formVersion:i.formVersion,state:result.state,severity:'notification',externalDeliveryVerified:false});return {status:before?200:201,body:{data:project(result,f)}};
 },async reply=>{
  // A later audience or enrollment correction can hide an old revision while
  // leaving today's head readable. Authorize the exact retained receipt too.
  const saved=z.object({data:z.object({id:uuid,version})}).parse(reply.body);
  const original=(await ctx.db.query<{response:Response}>('SELECT definition response FROM public.poll_response_revisions WHERE response_id=$1 AND version=$2',[saved.data.id,saved.data.version])).rows[0]?.response;
  if(!original||original.poll_id!==poll||original.student_id!==student||original.form_version!==i.formVersion||original.respondent_key!== (f.response_unit==='student_family'?student:ctx.credential.person_id))throw new ApiError(404,'NOT_FOUND');
  await familyRecord(ctx,original,true);
 });
}
async function history(ctx:ApiContext,r:Response,f:Form,q:z.infer<typeof historyQuery>,family=false):Promise<Reply>{
 const scope=JSON.stringify(permissionScope(ctx,family?'received-polls.view':'poll-responses.view')),pollScope=JSON.stringify(permissionScope(ctx,'polls.view'));
 const eligible=family?`EXISTS(SELECT 1 FROM public.class_enrollments e WHERE e.id=(v.definition#>>'{context,recipient,enrollmentId}')::uuid AND e.class_id=(v.definition->>'class_id')::uuid AND e.student_id=(v.definition->>'student_id')::uuid AND e.enabled AND e.joins_on<=(v.definition->>'posted_on')::date AND(e.leaves_on IS NULL OR e.leaves_on>=(v.definition->>'posted_on')::date))`:`public.scope_contains($5::jsonb,${revisionTarget})`;
 const rows=(await ctx.db.query<{version:number;definition:Response|null}>(`WITH selected AS MATERIALIZED(SELECT v.version,v.definition FROM public.poll_response_revisions v WHERE v.response_id=$1 AND v.version>$2 AND public.scope_contains($4::jsonb,${revisionTarget}) AND ${eligible} ORDER BY v.version LIMIT $3),budget AS(SELECT *,sum(octet_length(definition::text)) OVER(ORDER BY version) bytes FROM selected) SELECT version,CASE WHEN bytes<=2097152 THEN definition ELSE NULL END definition FROM budget ORDER BY version`,family?[r.id,q.afterVersion,q.limit+1,scope]:[r.id,q.afterVersion,q.limit+1,scope,pollScope])).rows;
 const visible=rows.filter((v):v is typeof v&{definition:Response}=>v.definition!==null).slice(0,q.limit);if(rows.length&&!visible.length)throw new ApiError(409,'POLL_RESPONSE_HISTORY_REQUIRES_BACKGROUND_JOB');return {status:200,body:{data:visible.map(v=>({version:v.version,definition:project(v.definition,f)})),nextVersion:rows.length>visible.length?visible.at(-1)!.version:null}};
}
async function family(ctx:ApiContext,poll:string,student:string,section?:string):Promise<Reply>{
 const params=Object.fromEntries(new URL(ctx.request.url).searchParams),method=ctx.request.method;
 if(method==='POST'){if(section&&section!=='withdraw')throw new ApiError(405,'METHOD_NOT_ALLOWED');empty.parse(params);const raw=await jsonBody(ctx.request,131072);return write(ctx,poll,student,section?withdrawal.parse(raw):input.parse(raw),Boolean(section));}
 if(method!=='GET'||section==='withdraw')throw new ApiError(405,'METHOD_NOT_ALLOWED');const q=section==='history'?historyQuery.parse(params):selection.parse(params),s=await familySource(ctx,poll,student),f=await form(ctx,poll,q.formVersion??s.poll.formVersion),r=await current(ctx,poll,student,f);
 if(section==='context'){return {status:200,body:{pollId:poll,formVersion:f.form_version,currentFormVersion:s.poll.formVersion,expectedVersion:r?.version??0,responseUnit:f.response_unit,respondentMode:f.respondent_mode,questions:f.definition,data:r&&permitted(ctx,r,'received-polls.view')&&await originalMembership(ctx,r)?project(r,f):null,externalDeliveryVerified:false}};}
 if(!r)throw new ApiError(404,'NOT_FOUND');await familyRecord(ctx,r);if(section==='history')return history(ctx,r,f,q as z.infer<typeof historyQuery>,true);return {status:200,body:{data:project(r,f)}};
}
export async function pollResponses(ctx:ApiContext):Promise<Reply|null>{
 const own=/^students\/([^/]+)\/polls\/([^/]+)\/response(?:\/(context|history|withdraw))?$/.exec(ctx.path),list=/^polls\/([^/]+)\/responses$/.exec(ctx.path),item=/^poll-responses\/([^/]+)(?:\/(history))?$/.exec(ctx.path);if(!own&&!list&&!item)return null;
 await lockApprovalWrites(ctx);if(own)return family(ctx,uuid.parse(own[2]),uuid.parse(own[1]),own[3]);if(ctx.request.method!=='GET')throw new ApiError(405,'METHOD_NOT_ALLOWED');const params=Object.fromEntries(new URL(ctx.request.url).searchParams);
 if(list){const id=uuid.parse(list[1]),q=paging.parse(params),s=permissionScope(ctx,'poll-responses.view'),p=permissionScope(ctx,'polls.view');if(!scopeNonempty(s)||!scopeNonempty(p))throw new ApiError(403,'FORBIDDEN');
  const rows=(await ctx.db.query<{id:string}>(`SELECT r.id,r.student_id,r.form_version,r.version,r.state,r.changed_at FROM public.poll_responses r JOIN public.polls p ON p.academy_id=r.academy_id AND p.id=r.poll_id WHERE r.poll_id=$1 AND r.form_version=coalesce($2::integer,p.form_version) AND($3::uuid IS NULL OR r.id>$3) AND public.scope_contains($4::jsonb,${headTarget}) AND public.scope_contains($5::jsonb,${headTarget}) ORDER BY r.id LIMIT $6`,[id,q.formVersion??null,q.after??null,JSON.stringify(s),JSON.stringify(p),q.limit+1])).rows;return {status:200,body:{data:rows.slice(0,q.limit),nextCursor:rows.length>q.limit?rows[q.limit-1].id:null}};
 }
 const id=uuid.parse(item![1]),r=(await ctx.db.query<{response:Response}>('SELECT to_jsonb(r) response FROM public.poll_responses r WHERE id=$1',[id])).rows[0]?.response;if(!r)throw new ApiError(404,'NOT_FOUND');required(ctx,r,'polls.view');required(ctx,r,'poll-responses.view');const f=await form(ctx,r.poll_id,r.form_version);
 if(item![2]){const q=historyQuery.omit({formVersion:true}).parse(params);return history(ctx,r,f,q);}empty.parse(params);return {status:200,body:{data:project(r,f)}};
}
export const pollResponsesContract=[
 {path:'/api/v1/students/{id}/polls/{pollId}/response/context',method:'get',summary:'Own/current linked-family form and shared-family or per-respondent answer context; no peer response selection',querySchema:selection},
 {path:'/api/v1/students/{id}/polls/{pollId}/response',method:'post',summary:'Verified self/current guardian submits exact-form answers under server deadline and optimistic response version; no admin/bot impersonation',schema:input},
 {path:'/api/v1/students/{id}/polls/{pollId}/response',method:'get',summary:'Own or explicitly shared student-family response with exact immutable questions',querySchema:selection},
 {path:'/api/v1/students/{id}/polls/{pollId}/response/history',method:'get',summary:'Own response revisions filtered by original membership and source permissions before paging',querySchema:historyQuery},
 {path:'/api/v1/students/{id}/polls/{pollId}/response/withdraw',method:'post',summary:'Current authorized respondent withdraws their response after closing without deleting evidence or changing answers',schema:withdrawal},
 {path:'/api/v1/polls/{id}/responses',method:'get',summary:'Staff response directory filtered by actual student/class/hub rights, not whole-school ownership, before paging',querySchema:paging},
 {path:'/api/v1/poll-responses/{id}',method:'get',summary:'Scoped individual response retaining exact questions, source day and actor provenance'},
 {path:'/api/v1/poll-responses/{id}/history',method:'get',summary:'Immutable response history filtered by each original student/class/hub source before paging',querySchema:historyQuery.omit({formVersion:true})}
] as const;
