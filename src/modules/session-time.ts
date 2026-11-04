import { randomUUID } from 'node:crypto';
import { Temporal } from '@js-temporal/polyfill';
import { z } from 'zod';
import { jsonBody,mutation,record,type ApiContext,type Reply } from '../core/api.ts';
import { permissionScope,lockApprovalWrites,propose,master,type ApprovalRegistry,type Proposal } from '../core/approvals.ts';
import { ApiError,type Capability } from '../core/policy.ts';
import { classRow,sessionRow,sessionLocalDate } from './classes.ts';
import { lockAcademyTopology } from './academy.ts';

const uuid=z.string().uuid().transform(v=>v.toLowerCase()),version=z.number().int().positive().max(2147483647);
const instant=z.iso.datetime({offset:true}).max(40).refine(v=>!/[.]\d{4}/.test(v),'Use millisecond precision or less');
const reason=z.string().trim().min(1).max(2000).refine(v=>v.isWellFormed()&&!v.includes('\0'));
const times={sessionVersion:version,startsAt:instant,endsAt:instant,reason};
const ownInput=z.object({expectedVersion:z.number().int().min(0).max(2147483647),assignmentId:uuid,assignmentVersion:version,...times}).strict();
const correctionInput=z.object({expectedVersion:version,...times}).strict();
const paging=z.object({limit:z.coerce.number().int().min(1).max(100).default(50),after:uuid.optional()}).strict();
const historyQuery=z.object({limit:z.coerce.number().int().min(1).max(100).default(50),afterVersion:z.coerce.number().int().min(0).max(2147483647).default(0)}).strict();
interface Entry {id:string;session_id:string;class_id:string;hub_id:string;person_id:string;assignment_id:string;assignment_version:number;session_version:number;scheduled_start:Date|string;scheduled_end:Date|string;starts_at:Date|string;ends_at:Date|string;version:number;changed_by:string;approval_id:string|null;reason:string;created_at:Date|string;changed_at:Date|string}
type Times=z.infer<typeof correctionInput>;
function iso(v:Date|string){return v instanceof Date?v.toISOString():v;}
function view(e:Entry,currentVersion?:number){
 const start=Date.parse(iso(e.starts_at)),end=Date.parse(iso(e.ends_at)),regularStart=Date.parse(iso(e.scheduled_start)),regularEnd=Date.parse(iso(e.scheduled_end));
 return {...e,recordedMilliseconds:end-start,outsideScheduleMilliseconds:Math.max(0,end-start-Math.max(0,Math.min(end,regularEnd)-Math.max(start,regularStart))),
  ...(currentVersion===undefined?{}:{currentSessionVersion:currentVersion,scheduleChanged:e.session_version!==currentVersion}),rounded:false,payrollApproved:false,payrollEligibility:'requires_session_evidence_review'};
}
async function row(ctx:ApiContext,id:string){const e=(await ctx.db.query<Entry>('SELECT * FROM public.session_time_entries WHERE id=$1',[id])).rows[0];if(!e)throw new ApiError(404,'NOT_FOUND');return e;}
async function access(ctx:ApiContext,e:Entry,cap:Capability='session-time.view'){
 await classRow(ctx,e.class_id,cap);
}
async function readable(ctx:ApiContext,e:Entry){
 if(ctx.credential.kind==='human'&&ctx.credential.person_id===e.person_id){
  const s=permissionScope(ctx,'session-time.record');
  if(s.all||s.hubs.length||s.classes?.length){try{await access(ctx,e,'session-time.record');return;}catch(error){if(!(error instanceof ApiError)||![403,404].includes(error.status))throw error;}}
 }
 await access(ctx,e);
}
async function sessionBasis(ctx:ApiContext,sessionId:string,cap:Capability,input:Times|z.infer<typeof ownInput>,own=false){
 const s=await sessionRow(ctx,sessionId,cap,true),c=await classRow(ctx,s.class_id,cap);
 const localOn=sessionLocalDate(s,c.time_zone);
 if(s.version!==input.sessionVersion)throw new ApiError(409,'SESSION_CHANGED');
 if(own&&s.status!=='scheduled')throw new ApiError(409,'CANCELLED_SESSION_TIME_REQUIRES_REVIEW');
 const start=Temporal.Instant.from(input.startsAt),end=Temporal.Instant.from(input.endsAt),duration=end.epochMilliseconds-start.epochMilliseconds;
 if(duration<=0||duration>86400000)throw new ApiError(400,'TIME_DURATION_OUT_OF_RANGE');
 const now=(await ctx.db.query<{at:Date|string}>('SELECT clock_timestamp() AS at')).rows[0].at;
 if(end.epochMilliseconds>Date.parse(iso(now)))throw new ApiError(409,'FUTURE_TIME_FORBIDDEN');
 return {s,localOn};
}
async function saveRevision(ctx:ApiContext,e:Entry){
 // Capture PostgreSQL's exact representation, including server timestamps;
 // never round-trip the private revision through JavaScript date formatting.
 await ctx.db.query('INSERT INTO public.session_time_revisions(academy_id,entry_id,version,definition) SELECT academy_id,id,version,to_jsonb(e) FROM public.session_time_entries e WHERE id=$1',[e.id]);
 await record(ctx.db,ctx.credential,ctx.requestId,e.approval_id?'session.time.corrected':'session.time.recorded',e.id,e.hub_id,
  {sessionId:e.session_id,version:e.version,hasReason:true,severity:e.approval_id?'critical':'notification',payrollApproved:false});
}
async function own(ctx:ApiContext,sessionId:string):Promise<Reply>{
 if(ctx.credential.kind!=='human')throw new ApiError(403,'HUMAN_SELF_RECORD_REQUIRED');
 if(ctx.request.method==='GET'){
  z.object({}).strict().parse(Object.fromEntries(new URL(ctx.request.url).searchParams));const s=await sessionRow(ctx,sessionId,'session-time.record');
  const c=await classRow(ctx,s.class_id,'session-time.record'),on=sessionLocalDate(s,c.time_zone);
  const assignment=(await ctx.db.query('SELECT id,version,role FROM public.class_staff WHERE class_id=$1 AND person_id=$2 AND active AND starts_on<=$3::date AND(ends_on IS NULL OR ends_on>=$3::date)',[s.class_id,ctx.credential.person_id,on])).rows[0]??null;
  const e=(await ctx.db.query<Entry>('SELECT * FROM public.session_time_entries WHERE session_id=$1 AND person_id=$2',[s.id,ctx.credential.person_id])).rows[0];
  return {status:200,body:{data:e?view(e,s.version):null,assignment,session:{id:s.id,classId:s.class_id,version:s.version,startsAt:s.starts_at,endsAt:s.ends_at,status:s.status,timeZone:c.time_zone}}};
 }
 if(ctx.request.method!=='POST')throw new ApiError(405,'METHOD_NOT_ALLOWED');
 const input=ownInput.parse(await jsonBody(ctx.request));
 await lockApprovalWrites(ctx);await lockAcademyTopology(ctx);
 await sessionRow(ctx,sessionId,'session-time.record');
 return mutation(ctx,input,async()=>{
  const {s,localOn}=await sessionBasis(ctx,sessionId,'session-time.record',input,true);
  const a=(await ctx.db.query<{id:string;version:number}>(`SELECT id,version FROM public.class_staff WHERE id=$1 AND class_id=$2 AND person_id=$3 AND active AND starts_on<=$4::date AND(ends_on IS NULL OR ends_on>=$4::date) FOR SHARE`,[input.assignmentId,s.class_id,ctx.credential.person_id,localOn])).rows[0];
  if(!a||a.version!==input.assignmentVersion)throw new ApiError(409,'STAFF_ASSIGNMENT_CHANGED');
  const before=(await ctx.db.query<Entry>('SELECT * FROM public.session_time_entries WHERE session_id=$1 AND person_id=$2 FOR UPDATE',[s.id,ctx.credential.person_id])).rows[0];
  if((before?.version??0)!==input.expectedVersion)throw new ApiError(409,'TARGET_CHANGED');
  if(before&&before.assignment_id!==a.id)throw new ApiError(409,'TIME_ASSIGNMENT_IDENTITY_CHANGED');
  const e=before?(await ctx.db.query<Entry>(`UPDATE public.session_time_entries SET assignment_version=$2,session_version=$3,scheduled_start=$4,scheduled_end=$5,starts_at=$6,ends_at=$7,version=version+1,changed_by=$8,approval_id=NULL,reason=$9 WHERE id=$1 RETURNING *`,
   [before.id,a.version,s.version,s.starts_at,s.ends_at,input.startsAt,input.endsAt,ctx.credential.person_id,input.reason])).rows[0]:
   (await ctx.db.query<Entry>(`INSERT INTO public.session_time_entries(academy_id,id,session_id,class_id,hub_id,person_id,assignment_id,assignment_version,session_version,scheduled_start,scheduled_end,starts_at,ends_at,changed_by,reason) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$6,$14) RETURNING *`,
    [ctx.credential.academy_id,randomUUID(),s.id,s.class_id,s.hub_id,ctx.credential.person_id,a.id,a.version,s.version,s.starts_at,s.ends_at,input.startsAt,input.endsAt,input.reason])).rows[0];
  await saveRevision(ctx,e);return {status:before?200:201,body:{data:view(e,s.version)}};
 });
}
async function correctionBasis(ctx:ApiContext,id:string,input:Times){
 const e=await row(ctx,id);await access(ctx,e);await access(ctx,e,'session-time.edit');
 if(e.version!==input.expectedVersion)throw new ApiError(409,'TARGET_CHANGED');
 const {s}=await sessionBasis(ctx,e.session_id,'session-time.edit',input);
 return {entry:e,session:{id:s.id,version:s.version,status:s.status,startsAt:s.starts_at,endsAt:s.ends_at}};
}
export const sessionTimeActions:ApprovalRegistry={'session-time.correct':{
 requestCapability:'session-time.edit',privacyCapability:'session-time.view',
 async validate(ctx,id,raw){await lockAcademyTopology(ctx);const b=await correctionBasis(ctx,id,correctionInput.parse(raw));return {all:false,hubs:[],classes:[{id:b.entry.class_id,hubId:b.entry.hub_id}]};},
 async dependencies(ctx,id,raw,purpose){try{return JSON.parse(JSON.stringify(await correctionBasis(ctx,id,correctionInput.parse(raw))));}catch(error){if(purpose==='review'&&error instanceof ApiError&&[403,404,409].includes(error.status))return {unavailable:error.code};throw error;}},
 async authorizeReviewer(ctx,p){if(await master(ctx))return;const e=await row(ctx,p.target_id);if(ctx.credential.person_id===e.person_id)throw new ApiError(403,'BENEFICIARY_REVIEW_FORBIDDEN');},
 async apply(ctx,p:Proposal){
  if(ctx.credential.kind!=='human')throw new ApiError(403,'HUMAN_REVIEW_REQUIRED');const input=correctionInput.parse(p.payload),b=await correctionBasis(ctx,p.target_id,input);
  const e=(await ctx.db.query<Entry>(`UPDATE public.session_time_entries SET session_version=$2,scheduled_start=$3,scheduled_end=$4,starts_at=$5,ends_at=$6,version=version+1,changed_by=$7,approval_id=$8,reason=$9 WHERE id=$1 AND version=$10 RETURNING *`,
   [p.target_id,b.session.version,b.session.startsAt,b.session.endsAt,input.startsAt,input.endsAt,ctx.credential.person_id,p.id,input.reason,p.target_version])).rows[0];
  if(!e)throw new ApiError(409,'TARGET_CHANGED');await saveRevision(ctx,e);return view(e,b.session.version);
 }
}};
export async function sessionTime(ctx:ApiContext,registry:ApprovalRegistry=sessionTimeActions):Promise<Reply|null>{
 const session=/^sessions\/([^/]+)\/(my-time|time-entries)$/.exec(ctx.path),item=/^session-time-entries\/([^/]+)(?:\/(history|change))?$/.exec(ctx.path);
 if(!session&&!item)return null;
 if(session){const id=uuid.parse(session[1]);if(session[2]==='my-time')return own(ctx,id);
  if(ctx.request.method!=='GET')throw new ApiError(405,'METHOD_NOT_ALLOWED');const s=await sessionRow(ctx,id,'session-time.view'),q=paging.parse(Object.fromEntries(new URL(ctx.request.url).searchParams));
  const rows=(await ctx.db.query<Entry>('SELECT * FROM public.session_time_entries WHERE session_id=$1 AND($2::uuid IS NULL OR id>$2) ORDER BY id LIMIT $3',[id,q.after??null,q.limit+1])).rows;
  return {status:200,body:{sessionId:id,data:rows.slice(0,q.limit).map(e=>view(e,s.version)),nextCursor:rows.length>q.limit?rows[q.limit-1].id:null}};
 }
 const id=uuid.parse(item![1]),section=item![2],e=await row(ctx,id);
 if(section==='change'&&ctx.request.method==='POST'){
  const input=correctionInput.parse(await jsonBody(ctx.request));await access(ctx,e);await access(ctx,e,'session-time.edit');return propose(ctx,registry,'session-time.correct',id,input.expectedVersion,input);
 }
 if(ctx.request.method!=='GET'||section==='change')throw new ApiError(405,'METHOD_NOT_ALLOWED');await readable(ctx,e);
 if(section==='history'){
  const q=historyQuery.parse(Object.fromEntries(new URL(ctx.request.url).searchParams)),rows=(await ctx.db.query<{version:number}>('SELECT version,definition,recorded_at FROM public.session_time_revisions WHERE entry_id=$1 AND version>$2 ORDER BY version LIMIT $3',[id,q.afterVersion,q.limit+1])).rows;
  return {status:200,body:{data:rows.slice(0,q.limit),nextVersion:rows.length>q.limit?rows[q.limit-1].version:null}};
 }
 z.object({}).strict().parse(Object.fromEntries(new URL(ctx.request.url).searchParams));const s=(await ctx.db.query<{version:number}>('SELECT version FROM public.class_sessions WHERE id=$1',[e.session_id])).rows[0];return {status:200,body:{data:view(e,s.version)}};
}
export const sessionTimeContract=[
 {path:'/api/v1/sessions/{id}/my-time',method:'get',summary:'Human own saved time only; not peer hours or payroll approval'},
 {path:'/api/v1/sessions/{id}/my-time',method:'post',summary:'Record own assigned session start/end, unrounded, versioned and audited; no earned-pay calculation',schema:ownInput},
 {path:'/api/v1/sessions/{id}/time-entries',method:'get',summary:'Class-scoped private staff time with exact outside-schedule duration and schedule-drift indicators',querySchema:paging},
 {path:'/api/v1/session-time-entries/{id}',method:'get',summary:'Read authorized own or administrative time record without granting access to peer records'},
 {path:'/api/v1/session-time-entries/{id}/history',method:'get',summary:'Immutable unrounded time revisions; own history or explicit private viewing permission',querySchema:historyQuery},
 {path:'/api/v1/session-time-entries/{id}/change',method:'post',summary:'Propose exact time correction; upper human review, beneficiary restriction and current sources required',schema:correctionInput}
] as const;
