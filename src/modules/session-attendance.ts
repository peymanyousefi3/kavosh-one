import { z } from 'zod';
import { jsonBody,mutation,record,type ApiContext,type Reply } from '../core/api.ts';
import { propose,master,lockApprovalWrites,type ApprovalRegistry,type Proposal } from '../core/approvals.ts';
import { ApiError,type Capability } from '../core/policy.ts';
import { classRow,sessionRow,sessionLocalDate } from './classes.ts';
import { lockAcademyTopology } from './academy.ts';

const uuid=z.string().uuid().transform(v=>v.toLowerCase()),version=z.number().int().min(1).max(2147483647);
const text=z.string().refine(v=>v.isWellFormed()&&!v.includes('\0'));
const entry=z.object({enrollmentId:uuid,enrollmentVersion:version,status:z.enum(['present','late','absent','excused']),note:text.max(1000).default('')}).strict();
const entries=z.array(entry).max(1000).refine(v=>new Set(v.map(e=>e.enrollmentId)).size===v.length,'Duplicate enrollment').transform(v=>v.sort((a,b)=>a.enrollmentId<b.enrollmentId?-1:1));
const correction=z.object({expectedVersion:z.number().int().min(0).max(2147483647),sessionVersion:version,entries,reason:text.pipe(z.string().trim().min(1).max(2000))}).strict();
const ownInput=correction.extend({assignmentId:uuid,assignmentVersion:version});
const historyQuery=z.object({limit:z.coerce.number().int().min(1).max(20).default(5),afterVersion:z.coerce.number().int().min(0).max(2147483647).default(0)}).strict();
const empty=z.object({}).strict();
type Input=z.infer<typeof correction>;
interface Source {sessionId:string;classId:string;hubId:string;sessionVersion:number;classVersion:number;classActive:boolean;status:string;startsAt:string;on:string;timeZone:string;members:{enrollmentId:string;enrollmentVersion:number;studentId:string}[];tooLarge?:boolean}
interface Sheet {session_id:string;class_id:string;hub_id:string;version:number;session_version:number;entries:z.infer<typeof entry>[];context:Source;changed_by:string;approval_id:string|null;[key:string]:unknown}

async function access(ctx:ApiContext,id:string,cap:Capability='attendance.view',lock=false){
 const s=await sessionRow(ctx,id,cap,lock);await classRow(ctx,s.class_id,'rosters.view');if(cap!=='attendance.view')await classRow(ctx,s.class_id,'attendance.view');return s;
}
async function sheet(ctx:ApiContext,id:string){return(await ctx.db.query<{sheet:Sheet}>('SELECT to_jsonb(a) sheet FROM public.session_attendance a WHERE session_id=$1',[id])).rows[0]?.sheet??null;}
async function source(ctx:ApiContext,id:string){
 const s=(await ctx.db.query<{source:Source|null}>('SELECT public.session_attendance_source($1) source',[id])).rows[0].source;
 if(!s)throw new ApiError(409,'SESSION_TIME_EVIDENCE_INVALID');if(s.tooLarge)throw new ApiError(409,'ATTENDANCE_REQUIRES_BACKGROUND_JOB');return s;
}
function view(s:Sheet){
 const observedCounts={present:0,late:0,absent:0,excused:0};for(const e of s.entries)observedCounts[e.status]++;
 return {...s,entries:s.entries.map(({status,...e})=>({...e,observedStatus:status,effectiveAttendance:'absent',absenceReason:'agreement_clearance_unverified'})),observedCounts,
  admissionClearanceVerified:false,payrollApproved:false,sessionEvidenceApproved:false};
}
async function basis(ctx:ApiContext,id:string,input:Input,cap:Capability){
 if(Buffer.byteLength(JSON.stringify(input.entries),'utf8')>450000)throw new ApiError(413,'ATTENDANCE_PAYLOAD_TOO_LARGE');
 const s=await access(ctx,id,cap,true),c=await classRow(ctx,s.class_id,cap),on=sessionLocalDate(s,c.time_zone),actual=await source(ctx,id),current=await sheet(ctx,id);
 if((current?.version??0)!==input.expectedVersion)throw new ApiError(409,'TARGET_CHANGED');
 if(s.version!==input.sessionVersion)throw new ApiError(409,'SESSION_CHANGED');
 const selected=input.entries.map(e=>[e.enrollmentId,e.enrollmentVersion]),members=actual.members.map(e=>[e.enrollmentId,e.enrollmentVersion]);
 if(JSON.stringify(selected)!==JSON.stringify(members))throw new ApiError(409,'ATTENDANCE_ROSTER_CHANGED');
 const now=(await ctx.db.query<{started:boolean}>('SELECT starts_at<=clock_timestamp() started FROM public.class_sessions WHERE id=$1',[id])).rows[0];
 if(!now.started)throw new ApiError(409,'FUTURE_ATTENDANCE_FORBIDDEN');
 return {s,on,current,source:actual};
}
async function persist(ctx:ApiContext,id:string,input:Input,b:Awaited<ReturnType<typeof basis>>,assignment:{id:string;version:number}|null,approvalId:string|null){
 const params=[id,input.sessionVersion,JSON.stringify(b.source),JSON.stringify(input.entries),ctx.credential.person_id,assignment?.id??null,assignment?.version??null,approvalId,input.reason];
 let after:Sheet;
 try{
  if(b.current)await ctx.db.query('UPDATE public.session_attendance SET version=version+1,session_version=$2,context=$3::jsonb,entries=$4::jsonb,changed_by=$5,assignment_id=$6,assignment_version=$7,approval_id=$8,reason=$9 WHERE session_id=$1',params);
  else await ctx.db.query('INSERT INTO public.session_attendance(session_id,session_version,context,entries,changed_by,assignment_id,assignment_version,approval_id,reason,academy_id,class_id,hub_id) VALUES($1,$2,$3::jsonb,$4::jsonb,$5,$6,$7,$8,$9,$10,$11,$12)',[...params,ctx.credential.academy_id,b.s.class_id,b.s.hub_id]);
  after=(await sheet(ctx,id))!;
 }catch(error){if(error&&typeof error==='object'&&'code' in error&&error.code==='23514'&&'message' in error&&/^ATTENDANCE_/.test(String(error.message)))throw new ApiError(409,'ATTENDANCE_SOURCE_CHANGED');throw error;}
 await ctx.db.query('INSERT INTO public.session_attendance_revisions(academy_id,session_id,version,definition) SELECT academy_id,session_id,version,to_jsonb(a) FROM public.session_attendance a WHERE session_id=$1',[id]);
 await record(ctx.db,ctx.credential,ctx.requestId,approvalId?'attendance.correct':'session.attendance.recorded',id,b.s.hub_id,{version:after.version,hasReason:true,severity:approvalId?'critical':'notification',payrollApproved:false});
 return view(after);
}
export const attendanceActions:ApprovalRegistry={'attendance.correct':{
 requestCapability:'attendance.edit',privacyCapability:'attendance.view',
 async validate(ctx,id,raw){await lockAcademyTopology(ctx);const b=await basis(ctx,id,correction.parse(raw),'attendance.edit');return {all:false,hubs:[],classes:[{id:b.s.class_id,hubId:b.s.hub_id}]};},
 async dependencies(ctx,id,raw,purpose){try{const b=await basis(ctx,id,correction.parse(raw),'attendance.edit');return {sheet:b.current,source:b.source};}catch(error){if(purpose==='review'&&error instanceof ApiError&&[403,404,409].includes(error.status))return {unavailable:error.code};throw error;}},
 async authorizeReviewer(ctx,p){if(await master(ctx))return;const before=await sheet(ctx,p.target_id);if(before?.changed_by===ctx.credential.person_id)throw new ApiError(403,'BENEFICIARY_REVIEW_FORBIDDEN');},
 async apply(ctx,p:Proposal){if(ctx.credential.kind!=='human')throw new ApiError(403,'HUMAN_REVIEW_REQUIRED');const i=correction.parse(p.payload),b=await basis(ctx,p.target_id,i,'attendance.edit');return persist(ctx,p.target_id,i,b,null,p.id);}
}};
export async function sessionAttendance(ctx:ApiContext,registry:ApprovalRegistry=attendanceActions):Promise<Reply|null>{
 const path=/^sessions\/([^/]+)\/attendance(?:\/(history|change))?$/.exec(ctx.path);if(!path)return null;
 const id=uuid.parse(path[1]),section=path[2],method=ctx.request.method,params=Object.fromEntries(new URL(ctx.request.url).searchParams);
 if(method==='POST'){
  empty.parse(params);
  if(section==='change'){const input=correction.parse(await jsonBody(ctx.request,524288));return propose(ctx,registry,'attendance.correct',id,input.expectedVersion,input);}
  if(section)throw new ApiError(405,'METHOD_NOT_ALLOWED');
  if(ctx.credential.kind!=='human')throw new ApiError(403,'HUMAN_STAFF_RECORD_REQUIRED');const input=ownInput.parse(await jsonBody(ctx.request,524288));
  await lockApprovalWrites(ctx);await lockAcademyTopology(ctx);await access(ctx,id,'attendance.record');
  return mutation(ctx,input,async()=>{
   const b=await basis(ctx,id,input,'attendance.record');if(b.s.status!=='scheduled'||!b.source.classActive)throw new ApiError(409,'INACTIVE_SESSION_ATTENDANCE_REQUIRES_REVIEW');
   const a=(await ctx.db.query<{id:string;version:number}>('SELECT id,version FROM public.class_staff WHERE id=$1 AND class_id=$2 AND person_id=$3 AND active AND starts_on<=$4::date AND(ends_on IS NULL OR ends_on>=$4::date) FOR SHARE',[input.assignmentId,b.s.class_id,ctx.credential.person_id,b.on])).rows[0];
   if(!a||a.version!==input.assignmentVersion)throw new ApiError(409,'STAFF_ASSIGNMENT_CHANGED');const data=await persist(ctx,id,input,b,a,null);return {status:b.current?200:201,body:{data}};
  });
 }
 if(method!=='GET'||section==='change')throw new ApiError(405,'METHOD_NOT_ALLOWED');await access(ctx,id);
 if(section==='history'){
  const q=historyQuery.parse(params),rows=(await ctx.db.query<{version:number;definition:Sheet|null}>(`WITH selected AS MATERIALIZED(
   SELECT version,definition,recorded_at FROM public.session_attendance_revisions WHERE session_id=$1 AND version>$2 ORDER BY version LIMIT $3),
   budget AS(SELECT *,sum(octet_length(definition::text)) OVER(ORDER BY version) bytes FROM selected)
   SELECT version,CASE WHEN bytes<=2097152 THEN definition ELSE NULL END definition,recorded_at FROM budget ORDER BY version`,[id,q.afterVersion,q.limit+1])).rows;
  const visible=rows.filter((r):r is typeof r&{definition:Sheet}=>r.definition!==null).slice(0,q.limit);
  if(rows.length&&!visible.length)throw new ApiError(409,'ATTENDANCE_REQUIRES_BACKGROUND_JOB');
  return {status:200,body:{data:visible.map(r=>({...r,definition:view(r.definition)})),nextVersion:rows.length>visible.length?visible.at(-1)!.version:null}};
 }
 empty.parse(params);const current=await sheet(ctx,id),actual=await source(ctx,id);
 const names=(await ctx.db.query<{person_id:string;display_name:string}>('SELECT person_id,coalesce(preferred_name,legal_name) display_name FROM public.student_profiles WHERE person_id=ANY($1::uuid[])',[actual.members.map(m=>m.studentId)])).rows;
 const namesById=new Map(names.map(n=>[n.person_id,n.display_name]));
 return {status:200,body:{data:current?view(current):null,currentSource:actual,roster:actual.members.map(m=>({...m,displayName:namesById.get(m.studentId)??null})),currentSessionStatus:actual.status,
  recordedSourceCurrent:current?(await ctx.db.query<{current:boolean}>('SELECT $1::jsonb=$2::jsonb current',[JSON.stringify(current.context),JSON.stringify(actual)])).rows[0].current:null,admissionClearanceVerified:false,payrollApproved:false}};
}
export const sessionAttendanceContract=[
 {path:'/api/v1/sessions/{id}/attendance',method:'get',summary:'Shared class-private observed attendance and exact date-filtered roster; unverified agreements remain operationally absent'},
 {path:'/api/v1/sessions/{id}/attendance',method:'post',summary:'Assigned human saves complete versioned observed roster, not signed eligibility or payroll approval',schema:ownInput},
 {path:'/api/v1/sessions/{id}/attendance/history',method:'get',summary:'Immutable shared attendance revisions within current attendance and roster rights',querySchema:historyQuery},
 {path:'/api/v1/sessions/{id}/attendance/change',method:'post',summary:'Propose upper-reviewed initial attendance or correction, including cancelled historical sessions; never a waiver override',schema:correction}
] as const;
