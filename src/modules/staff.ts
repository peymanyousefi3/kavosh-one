import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { jsonBody,mutation,record,type ApiContext,type Reply } from '../core/api.ts';
import { permissionScope } from '../core/approvals.ts';
import { ApiError,scopeAllowsRef } from '../core/policy.ts';
import { lockAcademyTopology } from './academy.ts';
import { classRow } from './classes.ts';

const uuid=z.string().uuid().transform(v=>v.toLowerCase()),version=z.number().int().positive();
const date=z.iso.date().refine(v=>v>='1900-01-01'&&v<='9999-12-31');
const role=z.enum(['teacher','ta','volunteer']),reason=z.string().trim().min(1).max(2000);
const createInput=z.object({personId:uuid,role,startsOn:date,endsOn:date.nullable().default(null),reason}).strict();
const updateInput=z.object({expectedVersion:version,role:role.optional(),startsOn:date.optional(),endsOn:date.nullable().optional(),active:z.boolean().optional(),reason}).strict()
  .refine(v=>['role','startsOn','endsOn','active'].some(k=>Object.hasOwn(v,k)));
const listQuery=z.object({limit:z.coerce.number().int().min(1).max(100).default(50),after:uuid.optional(),on:date.optional(),
  active:z.enum(['true','false']).transform(v=>v==='true').optional(),personId:uuid.optional(),role:role.optional()}).strict();
const historyQuery=z.object({limit:z.coerce.number().int().min(1).max(100).default(50),afterVersion:z.coerce.number().int().min(0).default(0)}).strict();
interface StaffRow {id:string;class_id:string;person_id:string;role:'teacher'|'ta'|'volunteer';starts_on:string;ends_on:string|null;active:boolean;version:number}
const fields='id,class_id,person_id,role,starts_on::text,ends_on::text,active,version,created_at';
async function assignment(ctx:ApiContext,id:string,edit=false) {
  const row=(await ctx.db.query<StaffRow>('SELECT '+fields+' FROM public.class_staff WHERE id=$1',[id])).rows[0];
  if(!row)throw new ApiError(404,'NOT_FOUND');
  const c=await classRow(ctx,row.class_id,edit?'staff.edit':'staff.view',edit);
  return {row,c};
}
async function save(ctx:ApiContext,classId:string|null,id?:string):Promise<Reply> {
  z.object({}).strict().parse(Object.fromEntries(new URL(ctx.request.url).searchParams));
  const input=id?updateInput.parse(await jsonBody(ctx.request)):createInput.parse(await jsonBody(ctx.request));
  await lockAcademyTopology(ctx);
  const existing=id?await assignment(ctx,id,true):null,c=existing?.c??await classRow(ctx,classId!,'staff.edit',true);
  return mutation(ctx,input,async()=>{
    const before=existing?(await ctx.db.query<StaffRow>('SELECT '+fields+' FROM public.class_staff WHERE id=$1 FOR UPDATE',[id])).rows[0]:null;
    if(before&&before.version!==('expectedVersion' in input?input.expectedVersion:0))throw new ApiError(409,'TARGET_CHANGED');
    const body={personId:before?.person_id??('personId' in input?input.personId:''),role:input.role??before!.role,startsOn:input.startsOn??before!.starts_on,
      endsOn:input.endsOn===undefined?before!.ends_on:input.endsOn,active:'active' in input?input.active??before!.active:before?.active??true};
    if(body.endsOn!==null&&body.endsOn<body.startsOn)throw new ApiError(400,'INVALID_DATE_RANGE');
    if(body.active&&!c.active)throw new ApiError(409,'CLASS_ARCHIVED');
    if(!before||(!before.active&&body.active)) {
      const person=(await ctx.db.query<{id:string;hub_id:string|null;kind:string;status:string}>('SELECT id,hub_id,kind,status FROM public.people WHERE id=$1 FOR SHARE',[body.personId])).rows[0];
      if(!person||!scopeAllowsRef(permissionScope(ctx,'people.view'),{id:person.id,hubId:person.hub_id},'people'))throw new ApiError(404,'PERSON_NOT_FOUND');
      if(person.kind!=='human'||person.status==='disabled')throw new ApiError(400,'HUMAN_STAFF_REQUIRED');
    }
    const actual=id??randomUUID();let after:StaffRow;
    try {
      after=before?(await ctx.db.query<StaffRow>('UPDATE public.class_staff SET role=$2,starts_on=$3,ends_on=$4,active=$5,version=version+1 WHERE id=$1 RETURNING '+fields,[actual,body.role,body.startsOn,body.endsOn,body.active])).rows[0]:
        (await ctx.db.query<StaffRow>('INSERT INTO public.class_staff(academy_id,id,class_id,person_id,role,starts_on,ends_on) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING '+fields,
          [ctx.credential.academy_id,actual,c.id,body.personId,body.role,body.startsOn,body.endsOn])).rows[0];
    }catch(error){if(error&&typeof error==='object'&&'code' in error&&error.code==='23P01')throw new ApiError(409,'STAFF_ASSIGNMENT_OVERLAP');throw error;}
    await ctx.db.query('INSERT INTO public.class_staff_revisions(academy_id,assignment_id,version,definition,changed_by,reason) VALUES($1,$2,$3,$4::jsonb,$5,$6)',
      [ctx.credential.academy_id,actual,after.version,JSON.stringify(after),ctx.credential.person_id,input.reason]);
    await record(ctx.db,ctx.credential,ctx.requestId,before?'class.staff.updated':'class.staff.created',actual,c.hub_id,{before,after,reason:input.reason});
    return {status:before?200:201,body:{data:after}};
  });
}
export async function staff(ctx:ApiContext):Promise<Reply|null> {
  const list=/^classes\/([^/]+)\/staff$/.exec(ctx.path),item=/^class-staff\/([^/]+)\/(update|history)$/.exec(ctx.path);
  if(!list&&!item)return null;
  const id=uuid.parse((list??item)![1]);
  if(list) {
    if(ctx.request.method==='POST')return save(ctx,id);
    if(ctx.request.method!=='GET')throw new ApiError(405,'METHOD_NOT_ALLOWED');
    await classRow(ctx,id,'staff.view');const q=listQuery.parse(Object.fromEntries(new URL(ctx.request.url).searchParams));
    const rows=(await ctx.db.query<StaffRow>(`SELECT s.id,s.class_id,s.person_id,p.name,s.role,s.starts_on::text,s.ends_on::text,s.active,s.version,s.created_at
      FROM public.class_staff s JOIN public.people p ON p.academy_id=s.academy_id AND p.id=s.person_id WHERE s.class_id=$1
      AND ($2::uuid IS NULL OR s.id>$2) AND ($3::date IS NULL OR s.starts_on<=$3 AND (s.ends_on IS NULL OR s.ends_on>=$3))
      AND ($4::boolean IS NULL OR s.active=$4) AND ($5::uuid IS NULL OR s.person_id=$5) AND ($6::text IS NULL OR s.role=$6) ORDER BY s.id LIMIT $7`,
      [id,q.after??null,q.on??null,q.active??null,q.personId??null,q.role??null,q.limit+1])).rows;
    return {status:200,body:{data:rows.slice(0,q.limit),nextCursor:rows.length>q.limit?rows[q.limit-1].id:null}};
  }
  if(item![2]==='update'&&ctx.request.method==='POST')return save(ctx,null,id);
  if(item![2]==='history'&&ctx.request.method==='GET') {
    await assignment(ctx,id);const q=historyQuery.parse(Object.fromEntries(new URL(ctx.request.url).searchParams));
    const rows=(await ctx.db.query<{version:number}>('SELECT version,definition,changed_by,reason,changed_at FROM public.class_staff_revisions WHERE assignment_id=$1 AND version>$2 ORDER BY version LIMIT $3',[id,q.afterVersion,q.limit+1])).rows;
    return {status:200,body:{data:rows.slice(0,q.limit),nextVersion:rows.length>q.limit?rows[q.limit-1].version:null}};
  }
  throw new ApiError(405,'METHOD_NOT_ALLOWED');
}
export const staffContract=[
  {path:'/api/v1/classes/{id}/staff',method:'get',summary:'Class-scoped staff roster, with optional inclusive local-date filter',querySchema:listQuery},
  {path:'/api/v1/classes/{id}/staff',method:'post',summary:'Assign a teacher, TA or volunteer with effective dates; does not grant login rights or compensation',schema:createInput},
  {path:'/api/v1/class-staff/{id}/update',method:'post',summary:'Versioned staff dates/role change or reversible deactivation; reason required',schema:updateInput},
  {path:'/api/v1/class-staff/{id}/history',method:'get',summary:'Immutable staff assignment revisions and reasons',querySchema:historyQuery}
] as const;
