import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { jsonBody,mutation,record,type ApiContext,type Reply } from '../core/api.ts';
import { permissionScope,propose,type ApprovalRegistry,type Proposal } from '../core/approvals.ts';
import { ApiError,requireScope,scopeNonempty,type Capability,type Scope } from '../core/policy.ts';
import { lockAcademyTopology } from './academy.ts';
import { compileSchedule,scheduleInput,localDateTime,disambiguation } from './calendar.ts';

const uuid=z.string().uuid().transform(value=>value.toLowerCase());
const name=z.string().trim().min(1).max(200),code=z.string().regex(/^[A-Z0-9][A-Z0-9_-]{0,99}$/);
const version=z.number().int().min(1),mode=z.enum(['in_person','online']);
const onlineUrl=z.string().url().max(2048).refine(value=>{const url=new URL(value);return url.protocol==='https:'&&!url.username&&!url.password;}).nullable();
const createInput=z.object({hubId:uuid,courseId:uuid,courseVersion:version,name,code:code.optional(),mode,
  onlineUrl:onlineUrl.default(null),schedule:scheduleInput}).strict();
const updateInput=z.object({expectedVersion:version,name:name.optional(),code:code.optional(),mode:mode.optional(),onlineUrl:onlineUrl.optional(),active:z.boolean().optional()}).strict().refine(value=>Object.keys(value).length>1);
const appendInput=z.object({expectedVersion:version,schedule:scheduleInput}).strict();
const changeInput=z.object({expectedVersion:version,reason:z.string().trim().min(1).max(2000),change:z.discriminatedUnion('kind',[
  z.object({kind:z.literal('cancel')}).strict(),z.object({kind:z.literal('restore')}).strict(),
  z.object({kind:z.literal('reschedule'),start:localDateTime,end:localDateTime,disambiguation}).strict(),
  z.object({kind:z.literal('delivery'),mode,onlineUrl:onlineUrl.default(null)}).strict()
])}).strict();
const listQuery=z.object({limit:z.coerce.number().int().min(1).max(100).default(50),after:uuid.optional(),hubId:uuid.optional(),courseId:uuid.optional(),
  active:z.enum(['true','false']).transform(v=>v==='true').optional(),q:z.string().trim().min(1).max(100).optional()}).strict();
const sessionQuery=z.object({limit:z.coerce.number().int().min(1).max(100).default(50),after:uuid.optional(),
  from:z.iso.datetime({offset:true}).optional(),through:z.iso.datetime({offset:true}).optional(),status:z.enum(['scheduled','cancelled']).optional()}).strict();
const scheduleQuery=z.object({limit:z.coerce.number().int().min(1).max(100).default(50),afterVersion:z.coerce.number().int().min(0).default(0)}).strict();
interface ClassRow {id:string;hub_id:string;course_id:string;course_version:number;name:string;code:string;time_zone:string;mode:'online'|'in_person';online_url:string|null;active:boolean;version:number}
interface SessionRow {id:string;class_id:string;hub_id:string;starts_at:Date|string;ends_at:Date|string;time_info:Record<string,unknown>;mode:'online'|'in_person';online_url:string|null;status:'scheduled'|'cancelled';version:number}

function scope(ctx:ApiContext,capability:Capability){const result=permissionScope(ctx,capability);if(!scopeNonempty(result))throw new ApiError(403,'FORBIDDEN');return result;}
function scopeParams(value:Scope){return [value.all,value.hubs,value.excludedHubs??[]];}
// Code-owned SQL identifiers only; all values remain query parameters.
function permittedClass(column:'id'|'class_id',allowed=5,denied=6){return `(($1::boolean OR hub_id=ANY($2::uuid[]) OR ${column}=ANY($${allowed}::uuid[])) AND NOT coalesce(hub_id=ANY($3::uuid[]),false) AND NOT ${column}=ANY($${denied}::uuid[]))`;}
function classIds(value:Scope){return [(value.classes??[]).map(r=>r.id),(value.excludedClasses??[]).map(r=>r.id)];}
async function classRow(ctx:ApiContext,id:string,capability:Capability='classes.view',lock=false) {
  const s=scope(ctx,capability),row=(await ctx.db.query<ClassRow>('SELECT * FROM public.classes WHERE '+permittedClass('id')+' AND id=$4'+(lock?' FOR UPDATE':''),[...scopeParams(s),id,...classIds(s)])).rows[0];
  if(!row)throw new ApiError(404,'NOT_FOUND');return row;
}
async function sessionRow(ctx:ApiContext,id:string,capability:Capability='classes.view',lock=false) {
  const s=scope(ctx,capability),row=(await ctx.db.query<SessionRow>('SELECT * FROM public.class_sessions WHERE '+permittedClass('class_id')+' AND id=$4'+(lock?' FOR UPDATE':''),[...scopeParams(s),id,...classIds(s)])).rows[0];
  if(!row)throw new ApiError(404,'NOT_FOUND');return row;
}
function validateMode(value:{mode:string;onlineUrl:string|null}) {
  if((value.mode==='online')!==Boolean(value.onlineUrl))throw new ApiError(400,'ONLINE_LINK_MODE_MISMATCH');
}
async function writeSchedule(ctx:ApiContext,c:ClassRow,definition:z.infer<typeof scheduleInput>,compiled:ReturnType<typeof compileSchedule>) {
  if(!compiled.count)throw new ApiError(400,'EMPTY_CLASS_SCHEDULE');
  const id=randomUUID(),sessions=compiled.sessions.map(time=>({id:randomUUID(),...time}));
  await ctx.db.query(`INSERT INTO public.class_schedules(academy_id,id,class_id,class_version,definition,compiled,created_by)
    VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7)`,[ctx.credential.academy_id,id,c.id,c.version,JSON.stringify(definition),JSON.stringify(compiled),ctx.credential.person_id]);
  await ctx.db.query(`INSERT INTO public.class_sessions(academy_id,id,class_id,hub_id,schedule_id,course_id,course_version,starts_at,ends_at,time_info,mode,online_url)
    SELECT $1,(r->>'id')::uuid,$2,$3,$4,$5,$6,(r->>'start')::timestamptz,(r->>'end')::timestamptz,r-'id',$8,$9
    FROM jsonb_array_elements($7::jsonb) r`,[ctx.credential.academy_id,c.id,c.hub_id,id,c.course_id,c.course_version,JSON.stringify(sessions),c.mode,c.online_url]);
  await record(ctx.db,ctx.credential,ctx.requestId,'class.schedule.created',id,c.hub_id,{classId:c.id,classVersion:c.version,sessionIds:sessions.map(s=>s.id),excluded:compiled.excluded});
  return {id,classVersion:c.version,sessionCount:sessions.length,excluded:compiled.excluded};
}
async function createClass(ctx:ApiContext):Promise<Reply> {
  const initial=scope(ctx,'classes.edit'),input=createInput.parse(await jsonBody(ctx.request,128*1024));requireScope(initial,input.hubId);
  validateMode(input);await lockAcademyTopology(ctx);requireScope(scope(ctx,'classes.edit'),input.hubId);
  return mutation(ctx,input,async()=>{
    const h=(await ctx.db.query<{active:boolean;time_zone:string|null;currency:string|null;city_id:string|null}>('SELECT active,time_zone,currency,city_id FROM public.hubs WHERE id=$1',[input.hubId])).rows[0];
    if(!h)throw new ApiError(400,'INVALID_REFERENCE');
    if(!h.active)throw new ApiError(400,'ACTIVE_HUB_REQUIRED');
    if(!h.time_zone||!h.currency||!h.city_id)throw new ApiError(409,'HUB_SETUP_REQUIRED');
    const course=(await ctx.db.query<{id:string;version:number;hub_id:string|null;code:string;active:boolean}>('SELECT id,version,hub_id,code,active FROM public.courses WHERE id=$1 FOR SHARE',[input.courseId])).rows[0];
    if(!course)throw new ApiError(400,'INVALID_REFERENCE');
    const courseScope=scope(ctx,'courses.view');if(course.hub_id)requireScope(courseScope,course.hub_id);
    if(course.hub_id&&course.hub_id!==input.hubId)throw new ApiError(400,'COURSE_HUB_MISMATCH');
    if(!course.active)throw new ApiError(400,'ACTIVE_COURSE_REQUIRED');
    if(course.version!==input.courseVersion)throw new ApiError(409,'COURSE_CHANGED');
    const compiled=compileSchedule(input.schedule,h.time_zone);if(!compiled.count)throw new ApiError(400,'EMPTY_CLASS_SCHEDULE');
    const id=randomUUID(),generated=course.code+'-'+input.hubId.slice(0,8).toUpperCase()+'-'+compiled.sessions[0].requestedStart.replace(/[-:T]/g,'')+'-'+id.slice(0,6).toUpperCase();
    const row=(await ctx.db.query<ClassRow>(`INSERT INTO public.classes(academy_id,id,hub_id,course_id,course_version,name,code,time_zone,mode,online_url)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,[ctx.credential.academy_id,id,input.hubId,input.courseId,input.courseVersion,input.name,input.code??generated,h.time_zone,input.mode,input.onlineUrl])).rows[0];
    const schedule=await writeSchedule(ctx,row,input.schedule,compiled);
    await record(ctx.db,ctx.credential,ctx.requestId,'class.created',id,row.hub_id,{before:null,after:row});
    return {status:201,body:{data:row,schedule}};
  });
}
async function updateClass(ctx:ApiContext,id:string):Promise<Reply> {
  scope(ctx,'classes.edit');const input=updateInput.parse(await jsonBody(ctx.request));
  await lockAcademyTopology(ctx);await classRow(ctx,id,'classes.edit');
  return mutation(ctx,input,async()=>{
    const before=await classRow(ctx,id,'classes.edit',true);if(before.version!==input.expectedVersion)throw new ApiError(409,'TARGET_CHANGED');
    const body={name:input.name??before.name,code:input.code??before.code,mode:input.mode??before.mode,onlineUrl:input.onlineUrl===undefined?before.online_url:input.onlineUrl,active:input.active??before.active};validateMode(body);
    if(!body.active&&(await ctx.db.query("SELECT 1 FROM public.class_sessions WHERE class_id=$1 AND status='scheduled' AND ends_at>now() LIMIT 1",[id])).rows.length)throw new ApiError(409,'FUTURE_SESSIONS_EXIST');
    if(body.active&&!before.active&&!(await ctx.db.query('SELECT 1 FROM public.hubs WHERE id=$1 AND active',[before.hub_id])).rows.length)throw new ApiError(400,'ACTIVE_HUB_REQUIRED');
    const after=(await ctx.db.query<ClassRow>('UPDATE public.classes SET name=$2,code=$3,mode=$4,online_url=$5,active=$6,version=version+1 WHERE id=$1 RETURNING *',[id,body.name,body.code,body.mode,body.onlineUrl,body.active])).rows[0];
    await record(ctx.db,ctx.credential,ctx.requestId,'class.updated',id,after.hub_id,{before,after});return {status:200,body:{data:after}};
  });
}
async function appendSchedule(ctx:ApiContext,id:string):Promise<Reply> {
  scope(ctx,'classes.edit');const input=appendInput.parse(await jsonBody(ctx.request,128*1024));
  await lockAcademyTopology(ctx);await classRow(ctx,id,'classes.edit');
  return mutation(ctx,input,async()=>{
    const c=await classRow(ctx,id,'classes.edit',true);if(c.version!==input.expectedVersion)throw new ApiError(409,'TARGET_CHANGED');
    if(!c.active)throw new ApiError(409,'CLASS_ARCHIVED');
    if(!(await ctx.db.query('SELECT 1 FROM public.hubs WHERE id=$1 AND active',[c.hub_id])).rows.length)throw new ApiError(400,'ACTIVE_HUB_REQUIRED');
    const compiled=compileSchedule(input.schedule,c.time_zone);
    c.version++;await ctx.db.query('UPDATE public.classes SET version=$2 WHERE id=$1',[id,c.version]);
    const schedule=await writeSchedule(ctx,c,input.schedule,compiled);return {status:201,body:{data:schedule,classVersion:c.version}};
  });
}
async function readClasses(ctx:ApiContext,id?:string):Promise<Reply> {
  if(id){z.object({}).strict().parse(Object.fromEntries(new URL(ctx.request.url).searchParams));const data=await classRow(ctx,id);const curriculum=(await ctx.db.query('SELECT version,definition FROM public.course_revisions WHERE course_id=$1 AND version=$2',[data.course_id,data.course_version])).rows[0];return {status:200,body:{data,curriculum}};}
  const s=scope(ctx,'classes.view'),q=listQuery.parse(Object.fromEntries(new URL(ctx.request.url).searchParams));
  const rows=(await ctx.db.query<ClassRow>('SELECT * FROM public.classes WHERE '+permittedClass('id',10,11)+` AND ($4::uuid IS NULL OR id>$4) AND ($5::uuid IS NULL OR hub_id=$5)
    AND ($6::uuid IS NULL OR course_id=$6) AND ($7::boolean IS NULL OR active=$7) AND ($8::text IS NULL OR position(lower($8) in lower(name||' '||code))>0) ORDER BY id LIMIT $9`,
    [...scopeParams(s),q.after??null,q.hubId??null,q.courseId??null,q.active??null,q.q??null,q.limit+1,...classIds(s)])).rows;
  return {status:200,body:{data:rows.slice(0,q.limit),nextCursor:rows.length>q.limit?rows[q.limit-1].id:null}};
}
async function readSessions(ctx:ApiContext,id:string):Promise<Reply> {
  await classRow(ctx,id);const q=sessionQuery.parse(Object.fromEntries(new URL(ctx.request.url).searchParams));
  if(q.from&&q.through&&Date.parse(q.from)>=Date.parse(q.through))throw new ApiError(400,'INVALID_CALENDAR_RANGE');
  const cursor=q.after?(await ctx.db.query<{starts_at:Date|string}>('SELECT starts_at FROM public.class_sessions WHERE class_id=$1 AND id=$2',[id,q.after])).rows[0]:null;
  if(q.after&&!cursor)throw new ApiError(400,'INVALID_CURSOR');
  const rows=(await ctx.db.query<{id:string}>(`SELECT * FROM public.class_sessions WHERE class_id=$1 AND ($2::timestamptz IS NULL OR ends_at>$2)
    AND ($3::timestamptz IS NULL OR starts_at<$3) AND ($4::text IS NULL OR status=$4) AND ($5::uuid IS NULL OR (starts_at,id)>($6::timestamptz,$5::uuid)) ORDER BY starts_at,id LIMIT $7`,
    [id,q.from??null,q.through??null,q.status??null,q.after??null,cursor?.starts_at??null,q.limit+1])).rows;
  return {status:200,body:{data:rows.slice(0,q.limit),nextCursor:rows.length>q.limit?rows[q.limit-1].id:null}};
}
async function readSchedules(ctx:ApiContext,id:string):Promise<Reply> {
  await classRow(ctx,id);const q=scheduleQuery.parse(Object.fromEntries(new URL(ctx.request.url).searchParams));
  const rows=(await ctx.db.query<{class_version:number}>('SELECT * FROM public.class_schedules WHERE class_id=$1 AND class_version>$2 ORDER BY class_version LIMIT $3',[id,q.afterVersion,q.limit+1])).rows;
  return {status:200,body:{data:rows.slice(0,q.limit),nextVersion:rows.length>q.limit?rows[q.limit-1].class_version:null}};
}
async function validateChange(ctx:ApiContext,id:string,raw:unknown,purpose:'request'|'review') {
  const input=changeInput.parse(raw),capability=purpose==='review'?'classes.edit':'sessions.request';
  await lockAcademyTopology(ctx);const s=await sessionRow(ctx,id,capability);
  if(input.change.kind==='delivery')validateMode(input.change);
  if(input.change.kind==='reschedule') {
    const c=await classRow(ctx,s.class_id,capability);
    compileSchedule({oneOff:[{start:input.change.start,end:input.change.end,disambiguation:input.change.disambiguation}]},c.time_zone);
  }
  return {all:false,hubs:[],classes:[{id:s.class_id,hubId:s.hub_id}]};
}
async function changeDependencies(ctx:ApiContext,id:string) {
  const row=(await ctx.db.query(`SELECT s.version,s.status,s.starts_at,s.ends_at,s.mode,s.online_url,s.time_info,c.active AS class_active,c.time_zone,h.active AS hub_active
    FROM public.class_sessions s JOIN public.classes c ON c.academy_id=s.academy_id AND c.id=s.class_id
    JOIN public.hubs h ON h.academy_id=c.academy_id AND h.id=c.hub_id WHERE s.id=$1`,[id])).rows[0];
  return {session:row??null};
}
async function applyChange(ctx:ApiContext,p:Proposal) {
  const input=changeInput.parse(p.payload),pre=(await ctx.db.query<{class_id:string}>('SELECT class_id FROM public.class_sessions WHERE id=$1',[p.target_id])).rows[0];
  if(!pre)throw new ApiError(404,'NOT_FOUND');
  // Lock the parent first, consistently with append/archive, then the session.
  const c=await classRow(ctx,pre.class_id,'classes.edit',true),before=await sessionRow(ctx,p.target_id,'classes.edit',true);
  if(before.version!==p.target_version||before.version!==input.expectedVersion)throw new ApiError(409,'TARGET_CHANGED');
  const change=input.change;
  let starts=before.starts_at,ends=before.ends_at,timeInfo=before.time_info,nextMode=before.mode,url=before.online_url,status=before.status;
  if(change.kind==='cancel'){if(status==='cancelled')throw new ApiError(409,'ALREADY_CANCELLED');status='cancelled';}
  else {
    if(!c.active||!(await ctx.db.query('SELECT 1 FROM public.hubs WHERE id=$1 AND active',[c.hub_id])).rows.length)throw new ApiError(409,'CLASS_OR_HUB_INACTIVE');
    if(change.kind==='restore'){if(status!=='cancelled')throw new ApiError(409,'NOT_CANCELLED');status='scheduled';}
    else if(change.kind==='reschedule') {
      if(status!=='scheduled')throw new ApiError(409,'RESTORE_SESSION_FIRST');
      const time=compileSchedule({oneOff:[{start:change.start,end:change.end,disambiguation:change.disambiguation}]},c.time_zone).sessions[0];starts=time.start;ends=time.end;timeInfo={...time};
    }else {nextMode=change.mode;url=change.onlineUrl;validateMode(change);}
  }
  let after:SessionRow;
  try{after=(await ctx.db.query<SessionRow>(`UPDATE public.class_sessions SET starts_at=$2,ends_at=$3,time_info=$4::jsonb,mode=$5,online_url=$6,status=$7,version=version+1 WHERE id=$1 RETURNING *`,
    [before.id,starts,ends,JSON.stringify(timeInfo),nextMode,url,status])).rows[0];}
  catch(error){if(error&&typeof error==='object'&&'code' in error&&error.code==='23P01')throw new ApiError(409,'SESSION_OVERLAP');throw error;}
  await record(ctx.db,ctx.credential,ctx.requestId,'session.changed',before.id,before.hub_id,{before,after,reason:input.reason,approvalId:p.id,change:change.kind});return after;
}
export const sessionActions:ApprovalRegistry={'session.change':{requestCapability:'sessions.request',validate:validateChange,dependencies:(ctx,id)=>changeDependencies(ctx,id),apply:applyChange}};
export async function classes(ctx:ApiContext,registry:ApprovalRegistry=sessionActions):Promise<Reply|null> {
  const sessionMatch=/^sessions\/([^/]+)(?:\/(change))?$/.exec(ctx.path);
  if(sessionMatch) {
    const id=uuid.parse(sessionMatch[1]);
    if(ctx.request.method==='GET'&&!sessionMatch[2]){z.object({}).strict().parse(Object.fromEntries(new URL(ctx.request.url).searchParams));return {status:200,body:{data:await sessionRow(ctx,id)}};}
    if(ctx.request.method==='POST'&&sessionMatch[2]){const input=changeInput.parse(await jsonBody(ctx.request));return propose(ctx,registry,'session.change',id,input.expectedVersion,input);}
    throw new ApiError(405,'METHOD_NOT_ALLOWED');
  }
  const match=/^classes(?:\/([^/]+)(?:\/(update|sessions|schedules))?)?$/.exec(ctx.path);
  if(!match)return null;const id=match[1]?uuid.parse(match[1]):undefined,section=match[2],method=ctx.request.method;
  if(!id&&method==='POST')return createClass(ctx);
  if(method==='GET'&&!section)return readClasses(ctx,id);
  if(id&&method==='POST'&&section==='update')return updateClass(ctx,id);
  if(id&&section==='schedules') {if(method==='GET')return readSchedules(ctx,id);if(method==='POST')return appendSchedule(ctx,id);}
  if(id&&method==='GET'&&section==='sessions')return readSessions(ctx,id);
  throw new ApiError(405,'METHOD_NOT_ALLOWED');
}
export const classesContract=[
  {path:'/api/v1/classes',method:'get',summary:'List permitted classes',querySchema:listQuery},
  {path:'/api/v1/classes',method:'post',summary:'Create class with pinned curriculum and atomic first schedule',schema:createInput},
  {path:'/api/v1/classes/{id}',method:'get',summary:'Read permitted class and its exact pinned curriculum'},
  {path:'/api/v1/classes/{id}/update',method:'post',summary:'Update class metadata/default delivery mode without rewriting existing sessions',schema:updateInput},
  {path:'/api/v1/classes/{id}/schedules',method:'get',summary:'Read immutable schedule batches and holiday evidence',querySchema:scheduleQuery},
  {path:'/api/v1/classes/{id}/schedules',method:'post',summary:'Append version-checked weekly or irregular sessions; conflicts roll back the entire batch',schema:appendInput},
  {path:'/api/v1/classes/{id}/sessions',method:'get',summary:'Read class sessions in chronological order with time-range filters',querySchema:sessionQuery},
  {path:'/api/v1/sessions/{id}',method:'get',summary:'Read permitted session and its original time-zone evidence'},
  {path:'/api/v1/sessions/{id}/change',method:'post',summary:'Request exact cancellation, restoration, reschedule or delivery change; upper human review required except master self-approval',schema:changeInput}
] as const;
