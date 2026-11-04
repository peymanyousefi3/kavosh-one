import { Temporal } from '@js-temporal/polyfill';
import { z } from 'zod';
import { jsonBody,record,type ApiContext,type Reply } from '../core/api.ts';
import { propose,permissionScope,master,type ApprovalRegistry,type Proposal } from '../core/approvals.ts';
import { ApiError,scopeNonempty } from '../core/policy.ts';
import { classRow,sessionRow } from './classes.ts';
import { localDateTime } from './calendar.ts';
import { lockAcademyTopology } from './academy.ts';
import { permittedPerson } from './students.ts';

const uuid=z.string().uuid().transform(v=>v.toLowerCase()),version=z.number().int().positive().max(2_147_483_647);
const date=z.iso.date().refine(v=>v>='1900-01-01'&&v<='9999-12-31'),reason=z.string().trim().min(1).max(2000);
const createInput=z.object({studentId:uuid,studentProfileVersion:version,joinsOn:date,leavesOn:date.nullable().default(null),enabled:z.boolean().default(true),reason}).strict();
const createPayload=createInput.extend({classId:uuid});
const updateInput=z.object({expectedVersion:version,studentProfileVersion:version.optional(),joinsOn:date.optional(),leavesOn:date.nullable().optional(),enabled:z.boolean().optional(),reason}).strict()
  .refine(v=>['studentProfileVersion','joinsOn','leavesOn','enabled'].some(k=>Object.hasOwn(v,k)));
const paging={limit:z.coerce.number().int().min(1).max(100).default(50),after:uuid.optional()};
const listQuery=z.object({...paging,studentId:uuid.optional(),on:date.optional(),enabled:z.enum(['true','false']).transform(v=>v==='true').optional()}).strict();
const rosterQuery=z.object({...paging,on:date.optional()}).strict(),sessionRosterQuery=z.object(paging).strict();
const historyQuery=z.object({limit:paging.limit,afterVersion:z.coerce.number().int().min(0).max(2_147_483_647).default(0)}).strict();
interface Enrollment {id:string;class_id:string;hub_id:string;student_id:string;student_profile_version:number;joins_on:string;leaves_on:string|null;enabled:boolean;version:number;last_approval_id:string}
const fields='id,class_id,hub_id,student_id,student_profile_version,joins_on::text,leaves_on::text,enabled,version,last_approval_id,created_at';
async function permittedClass(ctx:ApiContext,id:string,edit=false,lock=edit) {
  const c=await classRow(ctx,id,'enrollments.view',!edit&&lock);return edit?classRow(ctx,id,'enrollments.edit',lock):c;
}
export async function enrollment(ctx:ApiContext,id:string,edit=false,lock=edit) {
  if(!scopeNonempty(permissionScope(ctx,'enrollments.view')))throw new ApiError(403,'FORBIDDEN');
  const row=(await ctx.db.query<Enrollment>('SELECT '+fields+' FROM public.class_enrollments WHERE id=$1',[id])).rows[0];
  if(!row)throw new ApiError(404,'NOT_FOUND');return {row,c:await permittedClass(ctx,row.class_id,edit,lock)};
}
async function selectedStudent(ctx:ApiContext,id:string,lock=false) {
  await permittedPerson(ctx,id,'students.view',lock);
  const row=(await ctx.db.query<{person_id:string;version:number}>('SELECT person_id,version FROM public.student_profiles WHERE person_id=$1'+(lock?' FOR SHARE':''),[id])).rows[0];
  if(!row)throw new ApiError(404,'STUDENT_NOT_FOUND');return row;
}
async function validate(ctx:ApiContext,action:'enrollment.create'|'enrollment.update',id:string,raw:unknown) {
  await lockAcademyTopology(ctx);let c;
  if(action==='enrollment.create') {const input=createPayload.parse(raw);c=await permittedClass(ctx,input.classId,true);await selectedStudent(ctx,input.studentId,true);}
  else {const input=updateInput.parse(raw),current=await enrollment(ctx,id,true);c=current.c;if(input.studentProfileVersion!==undefined||input.joinsOn!==undefined||input.enabled===true)await selectedStudent(ctx,current.row.student_id,true);}
  return {all:false,hubs:[],classes:[{id:c.id,hubId:c.hub_id}]};
}
async function dependencies(ctx:ApiContext,action:'enrollment.create'|'enrollment.update',id:string,raw:unknown) {
  const prior=action==='enrollment.update'?(await ctx.db.query<Enrollment>('SELECT '+fields+' FROM public.class_enrollments WHERE id=$1',[id])).rows[0]??null:null;
  const input=action==='enrollment.create'?createPayload.parse(raw):null,classId=input?.classId??prior?.class_id,studentId=input?.studentId??prior?.student_id;
  return {enrollment:prior,class:(await ctx.db.query('SELECT id,hub_id,version,active,time_zone FROM public.classes WHERE id=$1',[classId??null])).rows[0]??null,
    student:(await ctx.db.query('SELECT person_id,version FROM public.student_profiles WHERE person_id=$1',[studentId??null])).rows[0]??null,
    periods:(await ctx.db.query('SELECT id,version,enabled,joins_on::text,leaves_on::text FROM public.class_enrollments WHERE class_id=$1 AND student_id=$2 ORDER BY id',[classId??null,studentId??null])).rows};
}
async function authorizeReviewer(ctx:ApiContext,p:Proposal) {
  if(await master(ctx))return;
  const studentId=p.action==='enrollment.create'?createPayload.parse(p.payload).studentId:(await ctx.db.query<{student_id:string}>('SELECT student_id FROM public.class_enrollments WHERE id=$1',[p.target_id])).rows[0]?.student_id;
  if(ctx.credential.person_id===studentId||(await ctx.db.query('SELECT 1 FROM public.family_relationships WHERE student_id=$1 AND guardian_id=$2 LIMIT 1',[studentId??null,ctx.credential.person_id])).rows.length)
    throw new ApiError(403,'BENEFICIARY_REVIEW_FORBIDDEN');
}
async function apply(ctx:ApiContext,p:Proposal) {
  if(ctx.credential.kind!=='human')throw new ApiError(403,'HUMAN_REVIEW_REQUIRED');
  const creating=p.action==='enrollment.create',input=creating?createPayload.parse(p.payload):updateInput.parse(p.payload);
  const before=creating?null:(await ctx.db.query<Enrollment>('SELECT '+fields+' FROM public.class_enrollments WHERE id=$1 FOR UPDATE',[p.target_id])).rows[0];
  if(!creating&&!before)throw new ApiError(404,'NOT_FOUND');
  if(before&&(before.version!==p.target_version||before.version!==('expectedVersion' in input?input.expectedVersion:0)))throw new ApiError(409,'TARGET_CHANGED');
  const classId=creating?('classId' in input?input.classId:''):before!.class_id,studentId=creating?('studentId' in input?input.studentId:''):before!.student_id;
  const c=await classRow(ctx,classId,'enrollments.edit');
  const body={profileVersion:input.studentProfileVersion??before!.student_profile_version,joinsOn:input.joinsOn??before!.joins_on,
    leavesOn:input.leavesOn===undefined?before!.leaves_on:input.leavesOn,enabled:input.enabled??before?.enabled??true};
  if(body.leavesOn!==null&&body.leavesOn<body.joinsOn)throw new ApiError(409,'INVALID_ENROLLMENT_PERIOD');
  if(body.enabled&&(!before||!before.enabled)&&!c.active)throw new ApiError(409,'CLASS_ARCHIVED');
  if(input.studentProfileVersion!==undefined) {
    const actual=(await ctx.db.query<{version:number}>('SELECT version FROM public.student_profiles WHERE person_id=$1',[studentId])).rows[0];
    if(actual?.version!==body.profileVersion)throw new ApiError(409,'STUDENT_PROFILE_CHANGED');
  }
  if(body.enabled) {
    const basis=(await ctx.db.query<{birth_date:string}>('SELECT definition->>\'date_of_birth\' AS birth_date FROM public.student_profile_revisions WHERE person_id=$1 AND version=$2',[studentId,body.profileVersion])).rows[0];
    const birth=date.safeParse(basis?.birth_date);if(!birth.success)throw new ApiError(409,'PROFILE_BASIS_INVALID');
    if(body.joinsOn<birth.data)throw new ApiError(409,'JOINS_BEFORE_BIRTH');
  }
  let after:Enrollment;
  try {
    after=before?(await ctx.db.query<Enrollment>('UPDATE public.class_enrollments SET student_profile_version=$2,joins_on=$3,leaves_on=$4,enabled=$5,version=version+1,last_approval_id=$6 WHERE id=$1 RETURNING '+fields,[p.target_id,body.profileVersion,body.joinsOn,body.leavesOn,body.enabled,p.id])).rows[0]:
      (await ctx.db.query<Enrollment>('INSERT INTO public.class_enrollments(academy_id,id,class_id,hub_id,student_id,student_profile_version,joins_on,leaves_on,enabled,last_approval_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING '+fields,
        [ctx.credential.academy_id,p.target_id,classId,c.hub_id,studentId,body.profileVersion,body.joinsOn,body.leavesOn,body.enabled,p.id])).rows[0];
  }catch(error){if(error&&typeof error==='object'&&'code' in error&&error.code==='23P01')throw new ApiError(409,'ENROLLMENT_PERIOD_OVERLAP');throw error;}
  await ctx.db.query('INSERT INTO public.class_enrollment_revisions(academy_id,enrollment_id,version,definition,changed_by,approval_id,reason) VALUES($1,$2,$3,$4::jsonb,$5,$6,$7)',[ctx.credential.academy_id,after.id,after.version,JSON.stringify(after),ctx.credential.person_id,p.id,input.reason]);
  await record(ctx.db,ctx.credential,ctx.requestId,before?'class.enrollment.updated':'class.enrollment.created',after.id,c.hub_id,{beforeVersion:before?.version??null,afterVersion:after.version,enabled:after.enabled,severity:'critical',hasReason:true});
  return after;
}
export const enrollmentActions:ApprovalRegistry={
  'enrollment.create':{requestCapability:'enrollments.edit',privacyCapability:'enrollments.view',policyChange:true,createdStatus:201,
    validate:(ctx,id,input)=>validate(ctx,'enrollment.create',id,input),dependencies:(ctx,id,input)=>dependencies(ctx,'enrollment.create',id,input),authorizeReviewer,apply},
  'enrollment.update':{requestCapability:'enrollments.edit',privacyCapability:'enrollments.view',policyChange:true,
    validate:(ctx,id,input)=>validate(ctx,'enrollment.update',id,input),dependencies:(ctx,id,input)=>dependencies(ctx,'enrollment.update',id,input),authorizeReviewer,apply}
};
async function roster(ctx:ApiContext,c:Awaited<ReturnType<typeof classRow>>,on:string,q:z.infer<typeof sessionRosterQuery>,session?:{id:string;status:string}):Promise<Reply> {
  const rows=session?.status==='cancelled'?[]:(await ctx.db.query<{student_id:string}>(`SELECT e.id AS enrollment_id,e.student_id,coalesce(s.preferred_name,s.legal_name) AS display_name
    FROM public.class_enrollments e JOIN public.student_profiles s ON s.academy_id=e.academy_id AND s.person_id=e.student_id
    WHERE e.class_id=$1 AND e.enabled AND e.joins_on<=$2::date AND (e.leaves_on IS NULL OR e.leaves_on>=$2::date)
    AND ($3::uuid IS NULL OR e.student_id>$3) ORDER BY e.student_id LIMIT $4`,[c.id,on,q.after??null,q.limit+1])).rows;
  return {status:200,body:{classId:c.id,on,timeZone:c.time_zone,...session?{sessionId:session.id,sessionStatus:session.status}:{},data:rows.slice(0,q.limit),nextCursor:rows.length>q.limit?rows[q.limit-1].student_id:null}};
}
async function registrations(ctx:ApiContext,id:string):Promise<Reply> {
  await permittedPerson(ctx,id,'registrations.view');
  if(!(await ctx.db.query('SELECT 1 FROM public.student_profiles WHERE person_id=$1',[id])).rows.length)throw new ApiError(404,'NOT_FOUND');
  const q=rosterQuery.parse(Object.fromEntries(new URL(ctx.request.url).searchParams)),s=permissionScope(ctx,'registrations.view');
  const selected=Boolean(s.people?.some(p=>p.id===id));
  const rows=(await ctx.db.query<{id:string}>(`SELECT e.id,e.class_id,c.name AS class_name,c.code AS class_code,c.course_id,c.course_version,
      v.definition->>'name' AS course_name,e.hub_id,c.time_zone,e.joins_on::text,e.leaves_on::text,e.version
    FROM public.class_enrollments e JOIN public.classes c ON c.academy_id=e.academy_id AND c.id=e.class_id
    JOIN public.course_revisions v ON v.academy_id=c.academy_id AND v.course_id=c.course_id AND v.version=c.course_version
    WHERE e.student_id=$1 AND e.enabled AND ($2::uuid IS NULL OR e.id>$2) AND ($3::date IS NULL OR e.joins_on<=$3 AND (e.leaves_on IS NULL OR e.leaves_on>=$3))
      AND ($4::boolean OR $5::boolean OR e.hub_id=ANY($6::uuid[])) AND NOT e.hub_id=ANY($7::uuid[])
      AND ($8::boolean OR e.hub_id=ANY($9::uuid[])) ORDER BY e.id LIMIT $10`,
    [id,q.after??null,q.on??null,s.all,selected,s.hubs,s.excludedHubs??[],ctx.credential.all_hubs,ctx.credential.hub_ids,q.limit+1])).rows;
  return {status:200,body:{studentId:id,data:rows.slice(0,q.limit),nextCursor:rows.length>q.limit?rows[q.limit-1].id:null}};
}
export async function enrollments(ctx:ApiContext,registry:ApprovalRegistry=enrollmentActions):Promise<Reply|null> {
  const list=/^classes\/([^/]+)\/enrollments$/.exec(ctx.path),item=/^enrollments\/([^/]+)(?:\/(change|history))?$/.exec(ctx.path),rosterPath=/^(classes|sessions)\/([^/]+)\/roster$/.exec(ctx.path);
  const method=ctx.request.method;
  const personal=/^students\/([^/]+)\/enrollments$/.exec(ctx.path);
  if(personal){if(method!=='GET')throw new ApiError(405,'METHOD_NOT_ALLOWED');return registrations(ctx,uuid.parse(personal[1]));}
  if(rosterPath) {
    if(method!=='GET')throw new ApiError(405,'METHOD_NOT_ALLOWED');const id=uuid.parse(rosterPath[2]);
    if(rosterPath[1]==='classes') {const c=await classRow(ctx,id,'rosters.view'),q=rosterQuery.parse(Object.fromEntries(new URL(ctx.request.url).searchParams));return roster(ctx,c,q.on??Temporal.Now.plainDateISO(c.time_zone).toString(),q);}
    const s=await sessionRow(ctx,id,'rosters.view'),c=await classRow(ctx,s.class_id,'rosters.view'),q=sessionRosterQuery.parse(Object.fromEntries(new URL(ctx.request.url).searchParams));
    const local=localDateTime.safeParse(s.time_info.localStart);
    try {
      const actual=s.starts_at instanceof Date?s.starts_at.getTime():Date.parse(s.starts_at);
      if(!local.success||s.time_info.timeZone!==c.time_zone||typeof s.time_info.startOffset!=='string'||typeof s.time_info.start!=='string'
        ||Temporal.Instant.from(local.data+s.time_info.startOffset).epochMilliseconds!==actual||Temporal.Instant.from(s.time_info.start).epochMilliseconds!==actual)throw new Error('invalid time evidence');
    }catch{throw new ApiError(409,'SESSION_TIME_EVIDENCE_INVALID');}
    return roster(ctx,c,local.data!.slice(0,10),q,s);
  }
  if(!list&&!item)return null;const id=uuid.parse((list??item)![1]);
  if(list) {
    if(method==='POST') {
      z.object({}).strict().parse(Object.fromEntries(new URL(ctx.request.url).searchParams));const input=createInput.parse(await jsonBody(ctx.request));
      await permittedClass(ctx,id,true,false);await selectedStudent(ctx,input.studentId);
      return propose(ctx,registry,'enrollment.create',null,0,{...input,classId:id});
    }
    if(method!=='GET')throw new ApiError(405,'METHOD_NOT_ALLOWED');await permittedClass(ctx,id);const q=listQuery.parse(Object.fromEntries(new URL(ctx.request.url).searchParams));
    const rows=(await ctx.db.query<{id:string}>('SELECT '+fields+' FROM public.class_enrollments WHERE class_id=$1 AND ($2::uuid IS NULL OR id>$2) AND ($3::uuid IS NULL OR student_id=$3) AND ($4::date IS NULL OR joins_on<=$4 AND (leaves_on IS NULL OR leaves_on>=$4)) AND ($5::boolean IS NULL OR enabled=$5) ORDER BY id LIMIT $6',[id,q.after??null,q.studentId??null,q.on??null,q.enabled??null,q.limit+1])).rows;
    return {status:200,body:{data:rows.slice(0,q.limit),nextCursor:rows.length>q.limit?rows[q.limit-1].id:null}};
  }
  const section=item![2];
  if(method==='POST'&&section==='change') {
    z.object({}).strict().parse(Object.fromEntries(new URL(ctx.request.url).searchParams));const input=updateInput.parse(await jsonBody(ctx.request));
    const current=await enrollment(ctx,id,true,false);if(input.studentProfileVersion!==undefined||input.joinsOn!==undefined||input.enabled===true)await selectedStudent(ctx,current.row.student_id);
    return propose(ctx,registry,'enrollment.update',id,input.expectedVersion,input);
  }
  if(method==='GET') {
    const {row}=await enrollment(ctx,id);
    if(!section){z.object({}).strict().parse(Object.fromEntries(new URL(ctx.request.url).searchParams));return {status:200,body:{data:row}};}
    if(section==='history') {const q=historyQuery.parse(Object.fromEntries(new URL(ctx.request.url).searchParams));const rows=(await ctx.db.query<{version:number}>('SELECT version,definition,changed_by,approval_id,reason,changed_at FROM public.class_enrollment_revisions WHERE enrollment_id=$1 AND version>$2 ORDER BY version LIMIT $3',[id,q.afterVersion,q.limit+1])).rows;return {status:200,body:{data:rows.slice(0,q.limit),nextVersion:rows.length>q.limit?rows[q.limit-1].version:null}};}
  }
  throw new ApiError(405,'METHOD_NOT_ALLOWED');
}
export const enrollmentsContract=[
  {path:'/api/v1/classes/{id}/enrollments',method:'get',summary:'Administrative enrollment-period records, including future planning; not an attendance picker',querySchema:listQuery},
  {path:'/api/v1/classes/{id}/enrollments',method:'post',summary:'Request dated membership pinned to a student profile revision; signed admission remains separate',schema:createInput},
  {path:'/api/v1/enrollments/{id}',method:'get',summary:'Read an authorized administrative class enrollment'},
  {path:'/api/v1/enrollments/{id}/change',method:'post',summary:'Request a versioned joining/leaving/voiding correction or explicit profile-basis refresh',schema:updateInput},
  {path:'/api/v1/enrollments/{id}/history',method:'get',summary:'Private immutable enrollment revisions',querySchema:historyQuery},
  {path:'/api/v1/classes/{id}/roster',method:'get',summary:'Date-filtered roster candidates, defaulting to today in the class time zone; not signed admission clearance',querySchema:rosterQuery},
  {path:'/api/v1/sessions/{id}/roster',method:'get',summary:'Roster candidates using preserved session civil-time evidence; excludes pre-join and cancelled sessions, not a waiver override',querySchema:sessionRosterQuery},
  {path:'/api/v1/students/{id}/enrollments',method:'get',summary:'Selected-student registration summaries only; no peers, private profile, lesson links or admission clearance',querySchema:rosterQuery}
] as const;
