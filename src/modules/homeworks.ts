import { z } from 'zod';
import { jsonBody,record,type ApiContext,type Reply } from '../core/api.ts';
import { propose,permissionScope,type ApprovalRegistry,type Proposal } from '../core/approvals.ts';
import { ApiError,type Capability } from '../core/policy.ts';
import { classRow,sessionRow,sessionLocalDate } from './classes.ts';
import { lockAcademyTopology } from './academy.ts';
import { sessionReportDocument } from './session-reports.ts';
import { authorizeLearningRecipient,receivedLearningQuery,receivedLearningSelection } from './learning-recipients.ts';

const uuid=z.string().uuid().transform(v=>v.toLowerCase()),version=z.number().int().min(1).max(2147483647),text=z.string().refine(v=>v.isWellFormed()&&!v.includes('\0'));
const recipient=z.object({enrollmentId:uuid,enrollmentVersion:version}).strict(),recipients=z.array(recipient).max(1000).refine(v=>new Set(v.map(r=>r.enrollmentId)).size===v.length,'Duplicate enrollment').transform(v=>v.sort((a,b)=>a.enrollmentId<b.enrollmentId?-1:1));
const common=z.object({expectedVersion:z.number().int().min(0).max(2147483647),sessionVersion:version,state:z.enum(['draft','published']),document:sessionReportDocument,recipients,dueAt:z.iso.datetime({offset:true}).nullable(),acceptLate:z.boolean(),reason:text.pipe(z.string().trim().min(1).max(2000))}).strict();
const own=common.extend({assignmentId:uuid,assignmentVersion:version}),payload=common.extend({sessionId:uuid,assignmentId:uuid.nullable(),assignmentVersion:version.nullable()});
const withdraw=z.object({expectedVersion:version,reason:common.shape.reason}).strict(),withdrawPayload=withdraw.extend({homeworkId:uuid}),paging=z.object({limit:z.coerce.number().int().min(1).max(20).default(10),after:uuid.optional()}).strict();
const historyQuery=z.object({limit:z.coerce.number().int().min(1).max(10).default(5),afterVersion:z.coerce.number().int().min(0).max(2147483647).default(0)}).strict(),empty=z.object({}).strict();
type Document=z.infer<typeof sessionReportDocument>;type Input=z.infer<typeof payload>;
type Source={session:{id:string;classId:string;hubId:string;version:number;on:string;classActive:boolean;status:string};media:unknown[];recipients:{enrollmentId:string;enrollmentVersion:number;studentId:string}[];assignment:{id:string;version:number;person_id:string}|null};
type Homework={id:string;session_id:string;class_id:string;hub_id:string;version:number;state:string;document:Document;recipients:z.infer<typeof recipients>;context:{source:Source};[key:string]:unknown};
const hasMedia=(d:Document)=>d.blocks.some(b=>b.kind==='media');
export { recipients as homeworkRecipients,sourceAccess as authorizeHomeworkSources,privateScopes as homeworkPrivacyScopes };
function privateScopes(ctx:ApiContext){return JSON.stringify({'homework-recipients.view':permissionScope(ctx,'homework-recipients.view')});}
async function sourceAccess(ctx:ApiContext,r:Pick<Homework,'class_id'|'hub_id'|'document'|'context'>){
 if(hasMedia(r.document))await classRow(ctx,r.class_id,'files.view');
 if(!(await ctx.db.query<{allowed:boolean}>('SELECT public.approval_bindings_allow(public.homework_private_bindings($1::jsonb),$2::jsonb) allowed',[JSON.stringify({class_id:r.class_id,hub_id:r.hub_id,context:r.context}),privateScopes(ctx)])).rows[0].allowed)throw new ApiError(404,'NOT_FOUND');
}
async function row(ctx:ApiContext,id:string,cap:Capability='homeworks.view'){
 const r=(await ctx.db.query<{homework:Homework}>('SELECT to_jsonb(h) homework FROM public.homeworks h WHERE id=$1',[id])).rows[0]?.homework;if(!r)throw new ApiError(404,'NOT_FOUND');
 try{await classRow(ctx,r.class_id,'homeworks.view');if(cap!=='homeworks.view')await classRow(ctx,r.class_id,cap);await sourceAccess(ctx,r);}catch(error){if(error instanceof ApiError&&[403,404].includes(error.status))throw new ApiError(404,'NOT_FOUND');throw error;}return r;
}
function view(r:Homework){return {...r,mediaContentVerified:false,mediaServingEnabled:false,externalDeliveryVerified:false,submissionAvailable:true,gradingAvailable:true,solutionsAvailable:true};}
async function basis(ctx:ApiContext,id:string,i:Input,checkTarget=true){
 const s=await sessionRow(ctx,i.sessionId,'homeworks.view'),c=await classRow(ctx,s.class_id,'homeworks.view');sessionLocalDate(s,c.time_zone);
 const before=(await ctx.db.query<{homework:Homework}>('SELECT to_jsonb(h) homework FROM public.homeworks h WHERE id=$1',[id])).rows[0]?.homework??null;
 if(checkTarget&&((before?.version??0)!==i.expectedVersion||before&&before.session_id!==i.sessionId))throw new ApiError(409,'TARGET_CHANGED');if(before)await sourceAccess(ctx,before);
 if(Buffer.byteLength(JSON.stringify(i.document),'utf8')>100000)throw new ApiError(413,'HOMEWORK_DOCUMENT_TOO_LARGE');
 const source=(await ctx.db.query<{source:Source|null}>('SELECT public.homework_source($1,$2::jsonb,$3::jsonb,$4) source',[i.sessionId,JSON.stringify(i.document),JSON.stringify(i.recipients),i.assignmentId])).rows[0].source;
 if(!source||source.session.version!==i.sessionVersion||source.assignment?.version!==(i.assignmentVersion??undefined))throw new ApiError(409,'HOMEWORK_SOURCE_CHANGED');
 await sourceAccess(ctx,{class_id:s.class_id,hub_id:s.hub_id,document:i.document,context:{source}});
 if(i.state==='published'&&(!source.recipients.length||source.session.status!=='scheduled'||!source.session.classActive||!i.document.blocks.some(b=>b.kind==='text')))throw new ApiError(409,'HOMEWORK_PUBLICATION_SOURCE_REQUIRED');
 if(i.assignmentId&&(source.session.status!=='scheduled'||!source.session.classActive))throw new ApiError(409,'HOMEWORK_SOURCE_CHANGED');
 return {record:before,source};
}
async function validate(ctx:ApiContext,action:string,id:string,raw:unknown,purpose:'request'|'review'){
 await lockAcademyTopology(ctx);
 if(action==='homework.withdraw'){const r=await row(ctx,id,'homeworks.edit');withdrawPayload.parse(raw);await classRow(ctx,r.class_id,'homeworks.publish');return {all:false,hubs:[],classes:[{id:r.class_id,hubId:r.hub_id}]};}
 const i=payload.parse(raw),s=await sessionRow(ctx,i.sessionId,action==='homework.record'&&purpose==='request'?'homeworks.record':'homeworks.edit');await classRow(ctx,s.class_id,'homeworks.view');
 const before=(await ctx.db.query<{state:string}>('SELECT state FROM public.homeworks WHERE id=$1',[id])).rows[0];if(i.state==='published'||before?.state==='published')await classRow(ctx,s.class_id,'homeworks.publish');
 // Recheck private source authority before receipt lookup, but keep the
 // optimistic target version inside mutation dependencies for exact retries.
 const b=await basis(ctx,id,i,false);
 if(action==='homework.record'&&purpose==='request'&&(ctx.credential.kind!=='human'||b.source.assignment?.person_id!==ctx.credential.person_id))throw new ApiError(403,'ASSIGNED_HUMAN_STAFF_REQUIRED');
 return {all:false,hubs:[],classes:[{id:s.class_id,hubId:s.hub_id}]};
}
async function apply(ctx:ApiContext,p:Proposal){
 if(ctx.credential.kind!=='human')throw new ApiError(403,'HUMAN_REVIEW_REQUIRED');
 try{
  if(p.action==='homework.withdraw'){const i=withdrawPayload.parse(p.payload);await ctx.db.query("UPDATE public.homeworks SET state='withdrawn',version=version+1,changed_by=$2,approval_id=$3,reason=$4 WHERE id=$1",[p.target_id,ctx.credential.person_id,p.id,i.reason]);}
  else{const i=payload.parse(p.payload),b=p.review_context as unknown as {record:Homework|null;source:Source},s=b.source.session,values=[p.target_id,i.sessionVersion,i.state,JSON.stringify(i.document),JSON.stringify(i.recipients),i.dueAt,i.acceptLate,JSON.stringify({source:b.source}),i.assignmentId,i.assignmentVersion,p.requester_id,ctx.credential.person_id,p.id,i.reason];
   if(b.record)await ctx.db.query('UPDATE public.homeworks SET version=version+1,session_version=$2,state=$3,document=$4::jsonb,recipients=$5::jsonb,due_at=$6,accept_late=$7,context=$8::jsonb,assignment_id=$9,assignment_version=$10,recorded_by=$11,changed_by=$12,approval_id=$13,reason=$14 WHERE id=$1',values);
   else await ctx.db.query('INSERT INTO public.homeworks(id,session_version,state,document,recipients,due_at,accept_late,context,assignment_id,assignment_version,recorded_by,changed_by,approval_id,reason,academy_id,session_id,class_id,hub_id,created_by) VALUES($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7,$8::jsonb,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$11)',[...values,ctx.credential.academy_id,s.id,s.classId,s.hubId]);
  }
 }catch(error){if(error&&typeof error==='object'&&'code'in error&&error.code==='23514'&&'message'in error&&/^HOMEWORK_/.test(String(error.message)))throw new ApiError(409,'HOMEWORK_SOURCE_CHANGED');throw error;}
 await ctx.db.query('INSERT INTO public.homework_revisions(academy_id,homework_id,version,definition) SELECT academy_id,id,version,to_jsonb(h) FROM public.homeworks h WHERE id=$1',[p.target_id]);
 const r=await row(ctx,p.target_id);await record(ctx.db,ctx.credential,ctx.requestId,p.action,p.target_id,r.hub_id,{version:r.version,state:r.state,hasReason:true,severity:'critical',externalDeliveryVerified:false});return view(r);
}
export const homeworkActions:ApprovalRegistry=Object.fromEntries(['homework.record','homework.edit','homework.withdraw'].map(action=>[action,{
 requestCapability:action==='homework.record'?'homeworks.record':'homeworks.edit',privacyCapability:'homeworks.view',policyChange:true,
 validate:(ctx:ApiContext,id:string,raw:unknown,purpose:'request'|'review')=>validate(ctx,action,id,raw,purpose),
 async dependencies(ctx:ApiContext,id:string,raw:unknown,purpose:'request'|'review'){try{if(action==='homework.withdraw'){const r=await row(ctx,id);if(r.state!=='published'||r.version!==withdrawPayload.parse(raw).expectedVersion)throw new ApiError(409,'TARGET_CHANGED');return {record:r};}return await basis(ctx,id,payload.parse(raw));}catch(error){if(purpose==='review'&&error instanceof ApiError&&[403,404,409].includes(error.status))return {unavailable:error.code};throw error;}},apply
}])) as ApprovalRegistry;
function receivedDocument(d:Document){return {...d,blocks:d.blocks.map(b=>b.kind==='text'?b:{id:b.id,kind:b.kind,mediaKind:b.mediaKind,caption:b.caption,availability:'unavailable'})};}
export { receivedDocument as receivedHomeworkDocument };
async function received(ctx:ApiContext,studentId:string,id?:string):Promise<Reply>{
 if(ctx.request.method!=='GET')throw new ApiError(405,'METHOD_NOT_ALLOWED');const params=Object.fromEntries(new URL(ctx.request.url).searchParams),q=id?(empty.parse(params),null):receivedLearningQuery.parse(params),{s,selected}=await authorizeLearningRecipient(ctx,studentId,'received-homework.view');
 const rows=(await ctx.db.query<{id:string;on:string;document?:Document}&Record<string,unknown>>(`SELECT p.id,p.session_id,p.version,p.due_at,p.accept_late,p.context#>>'{source,session,on}' AS on,p.context#>>'{source,session,timeZone}' time_zone,p.document->>'title' title,p.document->>'locale' locale,c.name class_name${id?',p.document':''}
 FROM public.homeworks p JOIN public.classes c ON c.academy_id=p.academy_id AND c.id=p.class_id JOIN public.approval_requests a ON a.academy_id=p.academy_id AND a.id=p.approval_id
 WHERE p.state='published' AND p.recipient_ids @> ARRAY[$1::uuid] AND a.status='applied' AND a.reviewer_id=p.changed_by AND a.target_id=p.id AND a.action IN('homework.record','homework.edit') AND ${receivedLearningSelection}
 ORDER BY(p.context#>>'{source,session,on}')::date DESC,p.id DESC LIMIT $10`,[studentId,ctx.credential.person_id,id??null,s.all,selected,s.hubs,s.excludedHubs??[],q?.beforeOn??null,q?.after??null,id?1:q!.limit+1])).rows;
 if(id){const r=rows[0];if(!r)throw new ApiError(404,'NOT_FOUND');return {status:200,body:{data:{...r,document:receivedDocument(r.document!),mediaServingEnabled:false,externalDeliveryVerified:false,submissionAvailable:true,gradingAvailable:true,solutionsAvailable:true}}};}
 return {status:200,body:{studentId,data:rows.slice(0,q!.limit),nextCursor:rows.length>q!.limit?{beforeOn:rows[q!.limit-1].on,after:rows[q!.limit-1].id}:null}};
}
export async function homeworks(ctx:ApiContext,registry:ApprovalRegistry=homeworkActions):Promise<Reply|null>{
 const family=/^students\/([^/]+)\/homework(?:\/([^/]+))?$/.exec(ctx.path);if(family)return received(ctx,uuid.parse(family[1]),family[2]?uuid.parse(family[2]):undefined);
 const collection=/^sessions\/([^/]+)\/homeworks(?:\/(change))?$/.exec(ctx.path),item=/^homeworks\/([^/]+)(?:\/(record|change|withdraw|history))?$/.exec(ctx.path);if(!collection&&!item)return null;
 const params=Object.fromEntries(new URL(ctx.request.url).searchParams),method=ctx.request.method;
 if(collection){const id=uuid.parse(collection[1]);
  if(method==='POST'){empty.parse(params);const raw=await jsonBody(ctx.request,262144),i=collection[2]?{...common.parse(raw),assignmentId:null,assignmentVersion:null}:own.parse(raw);return propose(ctx,registry,collection[2]?'homework.edit':'homework.record',null,i.expectedVersion,{...i,sessionId:id});}
  if(method!=='GET'||collection[2])throw new ApiError(405,'METHOD_NOT_ALLOWED');const q=paging.parse(params);await sessionRow(ctx,id,'homeworks.view');let filesAllowed=true;try{await sessionRow(ctx,id,'files.view');}catch(error){if(error instanceof ApiError&&[403,404].includes(error.status))filesAllowed=false;else throw error;}
  const rows=(await ctx.db.query<{id:string}>(`SELECT h.id,h.version,h.state,h.document->>'title' title,h.due_at,h.accept_late FROM public.homeworks h WHERE h.session_id=$1 AND($2::uuid IS NULL OR h.id>$2) AND public.approval_bindings_allow(public.homework_private_bindings(jsonb_build_object('class_id',h.class_id,'hub_id',h.hub_id,'context',h.context)),$4::jsonb) AND($5::boolean OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(h.document->'blocks') b WHERE b->>'kind'='media')) ORDER BY h.id LIMIT $3`,[id,q.after??null,q.limit+1,privateScopes(ctx),filesAllowed])).rows;return {status:200,body:{data:rows.slice(0,q.limit),nextCursor:rows.length>q.limit?rows[q.limit-1].id:null}};
 }
 const id=uuid.parse(item![1]),section=item![2];
 if(method==='POST'){
  empty.parse(params);
  if(section==='withdraw'){const i=withdraw.parse(await jsonBody(ctx.request));return propose(ctx,registry,'homework.withdraw',id,i.expectedVersion,{...i,homeworkId:id});}
  if(section!=='record'&&section!=='change')throw new ApiError(405,'METHOD_NOT_ALLOWED');const before=await row(ctx,id),raw=await jsonBody(ctx.request,262144),i=section==='change'?{...common.parse(raw),assignmentId:null,assignmentVersion:null}:own.parse(raw);return propose(ctx,registry,section==='change'?'homework.edit':'homework.record',id,i.expectedVersion,{...i,sessionId:before.session_id});
 }
 if(method!=='GET'||section&&section!=='history')throw new ApiError(405,'METHOD_NOT_ALLOWED');const r=await row(ctx,id);
 if(section==='history'){const q=historyQuery.parse(params);let filesAllowed=true;try{await classRow(ctx,r.class_id,'files.view');}catch(error){if(error instanceof ApiError&&[403,404].includes(error.status))filesAllowed=false;else throw error;}
  const rows=(await ctx.db.query<{version:number;definition:Homework|null}>(`WITH selected AS MATERIALIZED(SELECT version,definition,recorded_at FROM public.homework_revisions WHERE homework_id=$1 AND version>$2 AND public.approval_bindings_allow(public.homework_private_bindings(definition),$4::jsonb) AND($5::boolean OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(definition#>'{document,blocks}') b WHERE b->>'kind'='media')) ORDER BY version LIMIT $3),budget AS(SELECT *,sum(octet_length(definition::text)) OVER(ORDER BY version) bytes FROM selected) SELECT version,CASE WHEN bytes<=2097152 THEN definition ELSE NULL END definition,recorded_at FROM budget ORDER BY version`,[id,q.afterVersion,q.limit+1,privateScopes(ctx),filesAllowed])).rows;
  const visible=rows.filter((v):v is typeof v&{definition:Homework}=>v.definition!==null).slice(0,q.limit);if(rows.length&&!visible.length)throw new ApiError(409,'HOMEWORK_HISTORY_REQUIRES_BACKGROUND_JOB');return {status:200,body:{data:visible.map(v=>({...v,definition:view(v.definition)})),nextVersion:rows.length>visible.length?visible.at(-1)!.version:null}};
 }
 empty.parse(params);return {status:200,body:{data:view(r)}};
}
export const homeworksContract=[
 {path:'/api/v1/sessions/{id}/homeworks',method:'post',summary:'Assigned human proposes versioned homework with explicitly selected dated enrollments; private draft or reviewed publication',schema:own},
 {path:'/api/v1/sessions/{id}/homeworks/change',method:'post',summary:'Administrative initial homework proposal with upper human review and source-bound recipients',schema:common},
 {path:'/api/v1/sessions/{id}/homeworks',method:'get',summary:'Private session homework directory filtered by current recipient/file rights before paging',querySchema:paging},
 {path:'/api/v1/homeworks/{id}',method:'get',summary:'Private homework instruction/media metadata and exact recipient evidence; not submissions or solutions'},
 {path:'/api/v1/homeworks/{id}/record',method:'post',summary:'Assigned-human proposed homework revision; explicit publication rights also required for currently published instructions',schema:own},
 {path:'/api/v1/homeworks/{id}/change',method:'post',summary:'Administrative exact-version instruction/recipient/deadline replacement without erasing history',schema:common},
 {path:'/api/v1/homeworks/{id}/withdraw',method:'post',summary:'Reviewed withdrawal stops current family visibility without erasing instructions or recipient history',schema:withdraw},
 {path:'/api/v1/homeworks/{id}/history',method:'get',summary:'Private immutable native revisions filtered before version cursor and two-MiB response budget',querySchema:historyQuery},
 {path:'/api/v1/students/{id}/homework',method:'get',summary:'Verified current family/self reads only explicitly assigned and published homework with date/source denials',querySchema:receivedLearningQuery},
 {path:'/api/v1/students/{id}/homework/{homeworkId}',method:'get',summary:'Only assigned instructions and sanitized unavailable media placeholders; no peer roster, private reasons or solutions'}
] as const;
