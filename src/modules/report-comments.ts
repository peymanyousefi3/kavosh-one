import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { databaseInstant } from '../core/date-time-input.ts';
import { jsonBody,mutation,record,type ApiContext,type Reply } from '../core/api.ts';
import { propose,master,permissionScope,lockApprovalWrites,type ApprovalRegistry,type Proposal } from '../core/approvals.ts';
import { ApiError,scopeContains,type Capability,type Scope } from '../core/policy.ts';
import { lockAcademyTopology } from './academy.ts';
import { authorizeLearningRecipient } from './learning-recipients.ts';

const uuid=z.string().uuid().transform(v=>v.toLowerCase()),version=z.number().int().min(1).max(2147483647),text=z.string().refine(v=>v.isWellFormed()&&!v.includes('\0'));
const body=text.pipe(z.string().trim().min(1).max(10000)).refine(v=>Buffer.byteLength(v,'utf8')<=32000,'Comment exceeds 32000 UTF-8 bytes');
const create=z.object({body,replyTo:uuid.nullable().default(null)}).strict(),edit=z.object({expectedVersion:version,body}).strict(),retract=z.object({expectedVersion:version}).strict();
const moderate=z.object({expectedVersion:version,state:z.enum(['hidden','visible']),reason:text.pipe(z.string().trim().min(1).max(2000))}).strict(),moderatePayload=moderate.extend({commentId:uuid});
const paging=z.object({limit:z.coerce.number().int().min(1).max(20).default(10),afterAt:databaseInstant.optional(),after:uuid.optional()}).strict().refine(q=>Boolean(q.afterAt)===Boolean(q.after),'Use both cursor fields'),historyQuery=z.object({limit:z.coerce.number().int().min(1).max(10).default(5),afterVersion:z.coerce.number().int().min(0).max(2147483647).default(0)}).strict(),empty=z.object({}).strict();
type Kind='class_report'|'student_feedback';type Side='family'|'staff';
type Source={kind:Kind;id:string;version:number;studentId:string;classId:string;hubId:string;sessionId:string;on:string;active:boolean;eligible:boolean;hasMedia:boolean};
type Comment={id:string;source_kind:Kind;source_id:string;student_id:string;class_id:string;hub_id:string;posted_on:string;author_id:string;author_side:Side;reply_to:string|null;version:number;body:string;state:'visible'|'hidden'|'retracted';last_action:string;context:{source:Source};changed_by:string;created_at:string;changed_at:string;[key:string]:unknown};
function target(s:Pick<Source,'classId'|'hubId'|'studentId'>):Scope{return {all:false,hubs:[],classes:[{id:s.classId,hubId:s.hubId}],people:[{id:s.studentId,hubId:s.hubId}],recordContext:{classId:s.classId,hubId:s.hubId,studentId:s.studentId}};}
async function source(ctx:ApiContext,kind:Kind,id:string,student:string){const s=(await ctx.db.query<{source:Source|null}>('SELECT public.report_discussion_source($1,$2,$3) source',[kind,id,student])).rows[0].source;if(!s)throw new ApiError(404,'NOT_FOUND');return s;}
async function staffAuthority(ctx:ApiContext,s:Source,cap:Capability='report-comments.view'){
 const scopes=Object.fromEntries((['report-comments.view','report-publications.view','session-reports.view','files.view','student-feedback.view'] as Capability[]).map(c=>[c,permissionScope(ctx,c)]));
 if(!scopeContains(permissionScope(ctx,cap),target(s))||!(await ctx.db.query<{allowed:boolean}>('SELECT public.approval_bindings_allow(public.report_comment_private_bindings($1,$2,$3),$4::jsonb) allowed',[s.kind,s.id,s.studentId,JSON.stringify(scopes)])).rows[0].allowed)throw new ApiError(404,'NOT_FOUND');
}
async function memberOn(ctx:ApiContext,s:Source,on:string){return Boolean((await ctx.db.query('SELECT 1 FROM public.class_enrollments WHERE class_id=$1 AND student_id=$2 AND enabled AND joins_on<=$3::date AND(leaves_on IS NULL OR leaves_on>=$3::date)',[s.classId,s.studentId,on])).rows.length);}
async function familyAuthority(ctx:ApiContext,s:Source,write=false,on?:string){
 await authorizeLearningRecipient(ctx,s.studentId,'received-comments.view');await authorizeLearningRecipient(ctx,s.studentId,'received-reports.view');
 for(const cap of ['received-comments.view','received-reports.view',...write?['received-comments.write']:[]] as Capability[])if(!scopeContains(permissionScope(ctx,cap),target(s)))throw new ApiError(404,'NOT_FOUND');
 if(!s.active||!s.eligible||on&&!await memberOn(ctx,s,on))throw new ApiError(404,'NOT_FOUND');if(write&&!(await ctx.db.query<{allowed:boolean}>('SELECT public.report_comment_family($1,$2) allowed',[s.studentId,ctx.credential.person_id])).rows[0].allowed)throw new ApiError(403,'CURRENT_FAMILY_WRITER_REQUIRED');
}
async function authority(ctx:ApiContext,s:Source,side:Side,write=false,on?:string){if(side==='family')await familyAuthority(ctx,s,write,on);else{await staffAuthority(ctx,s,write?'report-comments.write':'report-comments.view');if(write&&(!s.active||!s.eligible))throw new ApiError(409,'COMMENT_SOURCE_CHANGED');}}
async function row(ctx:ApiContext,id:string,side:Side,student?:string,write=false){const c=(await ctx.db.query<{comment:Comment}>('SELECT to_jsonb(c) comment FROM public.report_comments c WHERE id=$1',[id])).rows[0]?.comment;if(!c||student&&student!==c.student_id)throw new ApiError(404,'NOT_FOUND');const s=await source(ctx,c.source_kind,c.source_id,c.student_id);await authority(ctx,s,side,write,c.posted_on);return {c,s};}
function project(c:Comment,sourceVersion:number,name:string,actor:string){return {id:c.id,version:c.version,state:c.state,body:c.state==='visible'?c.body:null,author:{id:c.author_id,name,side:c.author_side},own:c.author_id===actor,replyTo:c.reply_to,createdAt:c.created_at,changedAt:c.changed_at,parentVersionAtPosting:c.context.source.version,parentChanged:c.context.source.version!==sourceVersion,externalDeliveryVerified:false};}
async function projection(ctx:ApiContext,c:Comment,s:Source){const name=(await ctx.db.query<{name:string}>('SELECT name FROM public.people WHERE id=$1',[c.author_id])).rows[0]?.name??'';return project(c,s.version,name,ctx.credential.person_id);}
async function appendHistory(ctx:ApiContext,id:string){await ctx.db.query('INSERT INTO public.report_comment_revisions(academy_id,comment_id,version,definition) SELECT academy_id,id,version,to_jsonb(c) FROM public.report_comments c WHERE id=$1',[id]);}
function nativeError(error:unknown):never{if(error&&typeof error==='object'&&'code'in error&&error.code==='23514'&&'message'in error&&/^COMMENT_/.test(String(error.message))){const code=String(error.message);throw new ApiError(code==='COMMENT_RATE_LIMITED'?429:code==='COMMENT_VERIFIED_HUMAN_REQUIRED'?403:409,code);}throw error;}
async function threadLock(ctx:ApiContext,s:Source){
 // ponytail: serialize one family/report thread, not the school or unrelated
 // families. Per-comment locks only if this measured write path becomes hot.
 await ctx.db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,31))',[ctx.credential.academy_id+':report-thread:'+s.kind+':'+s.id+':'+s.studentId]);
}
async function write(ctx:ApiContext,s:Source,side:Side,input:z.infer<typeof create>|z.infer<typeof edit>|z.infer<typeof retract>,id?:string,action:'create'|'edit'|'retract'='create'){
 if(ctx.credential.kind!=='human')throw new ApiError(403,'HUMAN_COMMENT_REQUIRED');await authority(ctx,s,side,true);if(id){const b=await row(ctx,id,side,s.studentId,true);if(b.c.author_id!==ctx.credential.person_id||b.c.author_side!==side)throw new ApiError(403,'OWN_COMMENT_CHANNEL_REQUIRED');}
 return mutation(ctx,input,async()=>{await threadLock(ctx,s);const commentId=id??randomUUID();
  try{if(id){const b=await row(ctx,id,side,s.studentId,true),i=input as z.infer<typeof edit>;if(b.c.version!==i.expectedVersion)throw new ApiError(409,'TARGET_CHANGED');if(b.c.state!=='visible')throw new ApiError(409,'COMMENT_NOT_VISIBLE');await ctx.db.query('UPDATE public.report_comments SET version=version+1,body=$2,state=$3,last_action=$4,changed_by=$5,approval_id=NULL,reason=NULL WHERE id=$1',[id,action==='edit'?i.body:b.c.body,action==='retract'?'retracted':'visible',action,ctx.credential.person_id]);}
   else{const i=input as z.infer<typeof create>;await ctx.db.query("INSERT INTO public.report_comments(academy_id,id,source_kind,source_id,student_id,class_id,hub_id,posted_on,author_id,author_side,reply_to,body,state,last_action,context,changed_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'visible','create',$13::jsonb,$9)",[ctx.credential.academy_id,commentId,s.kind,s.id,s.studentId,s.classId,s.hubId,s.on,ctx.credential.person_id,side,i.replyTo,i.body,JSON.stringify({source:s})]);}
  }catch(error){nativeError(error);}await appendHistory(ctx,commentId);const result=await row(ctx,commentId,side,s.studentId);await record(ctx.db,ctx.credential,ctx.requestId,'report-comment.'+action,commentId,s.hubId,{version:result.c.version,severity:'notification',externalDeliveryVerified:false});return {status:id?200:201,body:{data:await projection(ctx,result.c,result.s)}};
 });
}
async function moderationAuthority(ctx:ApiContext,id:string){const b=await row(ctx,id,'staff');await staffAuthority(ctx,b.s,'report-comments.moderate');return b;}
export const reportCommentActions:ApprovalRegistry={'report-comment.moderate':{
 requestCapability:'report-comments.moderate',privacyCapability:'report-comments.moderate',policyChange:true,
 async validate(ctx,id,raw){await lockAcademyTopology(ctx);moderatePayload.parse(raw);const b=await moderationAuthority(ctx,id);return target(b.s);},
 async dependencies(ctx,id,raw,purpose){try{const i=moderatePayload.parse(raw),b=await moderationAuthority(ctx,id);if(b.c.version!==i.expectedVersion||!(b.c.state==='visible'&&i.state==='hidden'||b.c.state==='hidden'&&i.state==='visible'))throw new ApiError(409,'COMMENT_MODERATION_CHANGED');return {record:b.c};}catch(error){if(purpose==='review'&&error instanceof ApiError&&[403,404,409].includes(error.status))return {unavailable:error.code};throw error;}},
 async authorizeReviewer(ctx,p){if(await master(ctx))return;const b=await moderationAuthority(ctx,p.target_id);if(b.c.author_id===ctx.credential.person_id||b.c.student_id===ctx.credential.person_id||(await ctx.db.query('SELECT 1 FROM public.family_relationships WHERE student_id=$1 AND guardian_id=$2',[b.c.student_id,ctx.credential.person_id])).rows.length)throw new ApiError(403,'BENEFICIARY_REVIEW_FORBIDDEN');},
 async apply(ctx,p:Proposal){if(ctx.credential.kind!=='human')throw new ApiError(403,'HUMAN_REVIEW_REQUIRED');const i=moderatePayload.parse(p.payload);try{await ctx.db.query("UPDATE public.report_comments SET version=version+1,state=$2,last_action='moderate',changed_by=$3,approval_id=$4,reason=$5 WHERE id=$1",[p.target_id,i.state,ctx.credential.person_id,p.id,i.reason]);}catch(error){nativeError(error);}await appendHistory(ctx,p.target_id);const b=await moderationAuthority(ctx,p.target_id);await record(ctx.db,ctx.credential,ctx.requestId,p.action,p.target_id,b.c.hub_id,{version:b.c.version,state:b.c.state,severity:'critical',hasReason:true,externalDeliveryVerified:false});return projection(ctx,b.c,b.s);}
}};
async function list(ctx:ApiContext,s:Source,side:Side,q:z.infer<typeof paging>):Promise<Reply>{
 const rows=(await ctx.db.query<{comment:Comment;name:string}>(`SELECT jsonb_build_object('id',c.id,'version',c.version,'state',c.state,'body',CASE WHEN c.state='visible' THEN c.body ELSE NULL END,'author_id',c.author_id,'author_side',c.author_side,'reply_to',c.reply_to,'created_at',c.created_at,'changed_at',c.changed_at,'context',jsonb_build_object('source',jsonb_build_object('version',c.context#>'{source,version}'))) comment,p.name
 FROM public.report_comments c JOIN public.people p ON p.academy_id=c.academy_id AND p.id=c.author_id WHERE c.source_kind=$1 AND c.source_id=$2 AND c.student_id=$3 AND($4::timestamptz IS NULL OR(c.created_at,c.id)>($4,$5::uuid))
 AND($7::boolean OR EXISTS(SELECT 1 FROM public.class_enrollments e WHERE e.academy_id=c.academy_id AND e.class_id=c.class_id AND e.student_id=c.student_id AND e.enabled AND e.joins_on<=c.posted_on AND(e.leaves_on IS NULL OR e.leaves_on>=c.posted_on))) ORDER BY c.created_at,c.id LIMIT $6`,[s.kind,s.id,s.studentId,q.afterAt??null,q.after??null,q.limit+1,side==='staff'])).rows;
 const last=rows[q.limit-1]?.comment;return {status:200,body:{data:rows.slice(0,q.limit).map(r=>project(r.comment,s.version,r.name,ctx.credential.person_id)),nextCursor:rows.length>q.limit?{afterAt:last.created_at,after:last.id}:null,externalDeliveryVerified:false}};
}
export async function reportComments(ctx:ApiContext,registry:ApprovalRegistry=reportCommentActions):Promise<Reply|null>{
 const family=/^students\/([^/]+)\/(published-reports|session-feedback)\/([^/]+)\/comments$/.exec(ctx.path),staff=/^(report-publications|student-feedback)\/([^/]+)\/students\/([^/]+)\/comments$/.exec(ctx.path),familyItem=/^students\/([^/]+)\/report-comments\/([^/]+)(?:\/(edit|retract))?$/.exec(ctx.path),item=/^report-comments\/([^/]+)(?:\/(edit|retract|moderate|history))?$/.exec(ctx.path);if(!family&&!staff&&!familyItem&&!item)return null;
 const method=ctx.request.method,params=Object.fromEntries(new URL(ctx.request.url).searchParams);
 if(item?.[2]==='moderate'){if(method!=='POST')throw new ApiError(405,'METHOD_NOT_ALLOWED');empty.parse(params);const id=uuid.parse(item[1]),i=moderate.parse(await jsonBody(ctx.request));return propose(ctx,registry,'report-comment.moderate',id,i.expectedVersion,{...i,commentId:id});}
 await lockApprovalWrites(ctx);if(method==='POST')await lockAcademyTopology(ctx);if(ctx.credential.kind!=='human')throw new ApiError(403,'HUMAN_COMMENT_REQUIRED');
 if(family||staff){const side:Side=family?'family':'staff',kind:Kind=(family?family[2]==='published-reports':staff![1]==='report-publications')?'class_report':'student_feedback',id=uuid.parse(family?family[3]:staff![2]),student=uuid.parse(family?family[1]:staff![3]),s=await source(ctx,kind,id,student);
  if(method==='POST'){empty.parse(params);return write(ctx,s,side,create.parse(await jsonBody(ctx.request,65536)));}if(method!=='GET')throw new ApiError(405,'METHOD_NOT_ALLOWED');await authority(ctx,s,side);return list(ctx,s,side,paging.parse(params));
 }
 const side:Side=familyItem?'family':'staff',id=uuid.parse(familyItem?familyItem[2]:item![1]),section=familyItem?familyItem[3]:item![2],student=familyItem?uuid.parse(familyItem[1]):undefined,b=await row(ctx,id,side,student);
 if(method==='POST'){empty.parse(params);if(section!=='edit'&&section!=='retract')throw new ApiError(405,'METHOD_NOT_ALLOWED');return write(ctx,b.s,side,section==='edit'?edit.parse(await jsonBody(ctx.request,65536)):retract.parse(await jsonBody(ctx.request)),id,section);}
 if(method!=='GET'||section&&section!=='history')throw new ApiError(405,'METHOD_NOT_ALLOWED');if(section==='history'){await moderationAuthority(ctx,id);const q=historyQuery.parse(params),rows=(await ctx.db.query<{version:number;definition:Comment}>('SELECT version,definition FROM public.report_comment_revisions WHERE comment_id=$1 AND version>$2 ORDER BY version LIMIT $3',[id,q.afterVersion,q.limit+1])).rows;return {status:200,body:{data:rows.slice(0,q.limit),nextVersion:rows.length>q.limit?rows[q.limit-1].version:null}};}empty.parse(params);return {status:200,body:{data:await projection(ctx,b.c,b.s)}};
}
export const reportCommentsContract=[
 ...['published-reports','session-feedback'].flatMap(kind=>[
  {path:`/api/v1/students/{studentId}/${kind}/{id}/comments`,method:'get',summary:'Current verified own-family report discussion only, original comment-day eligibility before chronological paging',querySchema:paging},
  {path:`/api/v1/students/{studentId}/${kind}/{id}/comments`,method:'post',summary:'Verified current family writes own report-linked text reply; no recipient selection or direct messages',schema:create}
 ]),
 ...['report-publications','student-feedback'].flatMap(kind=>[
  {path:`/api/v1/${kind}/{id}/students/{studentId}/comments`,method:'get',summary:'Selected student report discussion under current private comment and original report permissions',querySchema:paging},
  {path:`/api/v1/${kind}/{id}/students/{studentId}/comments`,method:'post',summary:'Verified scoped human staff replies to an active released report, never impersonating a family author',schema:create}
 ]),
 ...['/api/v1/students/{studentId}/report-comments/{id}','/api/v1/report-comments/{id}'].flatMap(path=>[
  {path,method:'get',summary:'Authorized comment projection; hidden/retracted text is a tombstone, not private revision evidence'},
  {path:path+'/edit',method:'post',summary:'Author-only same-channel edit of a currently visible reply; optimistic version and immutable private history',schema:edit},
  {path:path+'/retract',method:'post',summary:'Author-only retraction preserves text privately and returns a tombstone to the conversation',schema:retract}
 ]),
 {path:'/api/v1/report-comments/{id}/moderate',method:'post',summary:'Upper-human-reviewed hide/restore; never edits authorship/content or restores an author-retracted message',schema:moderate},
 {path:'/api/v1/report-comments/{id}/history',method:'get',summary:'Source-scoped moderators only: immutable author edits, retractions and applied moderation evidence',querySchema:historyQuery}
] as const;
