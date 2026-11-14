import { z } from 'zod';
import { jsonBody,mutation,record,type ApiContext,type Reply } from '../core/api.ts';
import { permissionScope } from '../core/approvals.ts';
import { ApiError,requireScope,scopeAllowsRef,scopeNonempty,type Capability } from '../core/policy.ts';
import { lockAcademyTopology } from './academy.ts';

const uuid=z.string().uuid().transform(v=>v.toLowerCase()),version=z.number().int().positive().max(2_147_483_647);
const name=z.string().trim().min(1).max(200),reason=z.string().trim().max(2000).default('');
const preferredName=name.nullable(),shirtSize=z.string().trim().min(1).max(40).nullable();
// A birth certificate records a local calendar date, not a UTC timestamp.
// Permit today's date anywhere on Earth (UTC+14), without guessing birthplace.
const birthDate=z.iso.date().refine(v=>v>='1900-01-01'&&v<=new Date(Date.now()+14*60*60*1000).toISOString().slice(0,10));
const recruiter=z.discriminatedUnion('kind',[
  z.object({kind:z.literal('academy')}).strict(),z.object({kind:z.literal('hub'),id:uuid}).strict(),z.object({kind:z.literal('person'),id:uuid}).strict()
]);
const profileInput=z.object({legalName:name,preferredName:preferredName.default(null),dateOfBirth:birthDate,
  shirtSize:shirtSize.default(null),recruiter,reason}).strict();
const createInput=profileInput.extend({personId:uuid});
const updateInput=z.object({expectedVersion:version,legalName:name.optional(),preferredName:preferredName.optional(),dateOfBirth:birthDate.optional(),
  shirtSize:shirtSize.optional(),recruiter:recruiter.optional(),reason}).strict().refine(v=>Object.keys(v).some(k=>!['expectedVersion','reason'].includes(k)));
const listQuery=z.object({limit:z.coerce.number().int().min(1).max(100).default(50),after:uuid.optional(),hubId:uuid.optional(),q:z.string().trim().min(1).max(100).optional()}).strict();
const historyQuery=z.object({limit:z.coerce.number().int().min(1).max(100).default(50),afterVersion:z.coerce.number().int().min(0).max(2_147_483_647).default(0)}).strict();
interface Profile {person_id:string;legal_name:string;preferred_name:string|null;date_of_birth:string;shirt_size:string|null;
  recruiter_kind:'academy'|'hub'|'person';recruiter_hub_id:string|null;recruiter_person_id:string|null;version:number}
const fields='person_id,legal_name,preferred_name,date_of_birth::text,shirt_size,recruiter_kind,recruiter_hub_id,recruiter_person_id,version,created_at';
export async function permittedPerson(ctx:ApiContext,id:string,capability:Capability,lock=false) {
  return (await permittedPeople(ctx,[id],capability,lock))[0];
}
export async function permittedPeople(ctx:ApiContext,ids:string[],capability:Capability,lock=false) {
  if(ids.length>1000||new Set(ids).size!==ids.length)throw new ApiError(400,'INVALID_PERSON_SELECTION');if(!ids.length)return [];
  const scope=permissionScope(ctx,capability);if(!scopeNonempty(scope))throw new ApiError(403,'FORBIDDEN');
  const rows=(await ctx.db.query<{id:string;hub_id:string|null;kind:string;status:string}>('SELECT id,hub_id,kind,status FROM public.people WHERE id=ANY($1::uuid[]) ORDER BY id'+(lock?' FOR SHARE':''),[ids])).rows,byId=new Map(rows.map(p=>[p.id,p]));
  return ids.map(id=>{const person=byId.get(id);if(!person||!scopeAllowsRef(scope,{id:person.id,hubId:person.hub_id},'people'))throw new ApiError(404,'NOT_FOUND');if(person.kind!=='human')throw new ApiError(400,'HUMAN_PROFILE_REQUIRED');return person;});
}
async function profile(ctx:ApiContext,id:string,lock=false) {
  const row=(await ctx.db.query<Profile>('SELECT '+fields+' FROM public.student_profiles WHERE person_id=$1'+(lock?' FOR UPDATE':''),[id])).rows[0];
  if(!row)throw new ApiError(404,'NOT_FOUND');return row;
}
async function validateRecruiter(ctx:ApiContext,value:z.infer<typeof recruiter>) {
  if(value.kind==='academy')return;
  if(value.kind==='person'){await permittedPerson(ctx,value.id,'people.view',true);return;}
  const scope=permissionScope(ctx,'hubs.view');requireScope(scope,value.id);
  if(!(await ctx.db.query('SELECT 1 FROM public.hubs WHERE id=$1 FOR SHARE',[value.id])).rows.length)throw new ApiError(400,'INVALID_REFERENCE');
}
export const studentCorrectionFields=z.object({legalName:updateInput.shape.legalName,preferredName:updateInput.shape.preferredName,dateOfBirth:updateInput.shape.dateOfBirth,shirtSize:updateInput.shape.shirtSize}).strict().refine(v=>Object.keys(v).length>0).refine(v=>Object.values(v).every(x=>x===null||x===undefined||x.isWellFormed()&&!/[\u0000-\u001f\u007f]/.test(x)));
export { profile as studentProfileRecord };
export async function writeStudentProfile(ctx:ApiContext,target:string,before:Profile|null,input:z.infer<typeof createInput>|z.infer<typeof updateInput>,person:{hub_id:string|null}):Promise<Reply>{
    const recruited=input.recruiter??{kind:before!.recruiter_kind,...before?.recruiter_kind==='hub'?{id:before.recruiter_hub_id!}:before?.recruiter_kind==='person'?{id:before.recruiter_person_id!}:{}} as z.infer<typeof recruiter>;
    if(input.recruiter)await validateRecruiter(ctx,input.recruiter);
    const body={legalName:input.legalName??before!.legal_name,preferredName:input.preferredName===undefined?before!.preferred_name:input.preferredName,
      dateOfBirth:input.dateOfBirth??before!.date_of_birth,shirtSize:input.shirtSize===undefined?before!.shirt_size:input.shirtSize,
      recruiterKind:recruited.kind,recruiterHubId:recruited.kind==='hub'?recruited.id:null,recruiterPersonId:recruited.kind==='person'?recruited.id:null};
    const params=[target,body.legalName,body.preferredName,body.dateOfBirth,body.shirtSize,body.recruiterKind,body.recruiterHubId,body.recruiterPersonId];
    const after=before?(await ctx.db.query<Profile>('UPDATE public.student_profiles SET legal_name=$2,preferred_name=$3,date_of_birth=$4,shirt_size=$5,recruiter_kind=$6,recruiter_hub_id=$7,recruiter_person_id=$8,version=version+1 WHERE person_id=$1 RETURNING '+fields,params)).rows[0]:
      (await ctx.db.query<Profile>('INSERT INTO public.student_profiles(person_id,legal_name,preferred_name,date_of_birth,shirt_size,recruiter_kind,recruiter_hub_id,recruiter_person_id,academy_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING '+fields,[...params,ctx.credential.academy_id])).rows[0];
    await ctx.db.query('INSERT INTO public.student_profile_revisions(academy_id,person_id,version,definition,changed_by,reason) VALUES($1,$2,$3,$4::jsonb,$5,$6)',[ctx.credential.academy_id,target,after.version,JSON.stringify(after),ctx.credential.person_id,input.reason]);
    // General audit readers do not automatically have private-profile rights.
    // The exact diff remains in the separately authorized revision history.
    await record(ctx.db,ctx.credential,ctx.requestId,before?'student.profile.updated':'student.profile.created',target,person.hub_id,
      {beforeVersion:before?.version??null,afterVersion:after.version,fields:Object.keys(input).filter(k=>!['personId','expectedVersion','reason'].includes(k)),hasReason:Boolean(input.reason)});
    return {status:before?200:201,body:{data:{personId:target,version:after.version}}};
}

async function save(ctx:ApiContext,id?:string):Promise<Reply> {
  z.object({}).strict().parse(Object.fromEntries(new URL(ctx.request.url).searchParams));
  const input=id?updateInput.parse(await jsonBody(ctx.request)):createInput.parse(await jsonBody(ctx.request));
  const target=id??('personId' in input?input.personId:'');
  await lockAcademyTopology(ctx);const person=await permittedPerson(ctx,target,'students.edit',true);
  return mutation(ctx,input,async()=>{
    const before=id?await profile(ctx,target,true):null;
    if(before&&before.version!==('expectedVersion' in input?input.expectedVersion:0))throw new ApiError(409,'TARGET_CHANGED');
    return writeStudentProfile(ctx,target,before,input,person);
  });
}
export async function students(ctx:ApiContext):Promise<Reply|null> {
  const match=/^students(?:\/([^/]+)(?:\/(update|history))?)?$/.exec(ctx.path);if(!match)return null;
  const id=match[1]?uuid.parse(match[1]):undefined,section=match[2];
  if(ctx.request.method==='POST'&&!section&&!id)return save(ctx);
  if(ctx.request.method==='POST'&&section==='update'&&id)return save(ctx,id);
  if(ctx.request.method!=='GET')throw new ApiError(405,'METHOD_NOT_ALLOWED');
  if(id) {
    await permittedPerson(ctx,id,'students.view');
    if(!section){z.object({}).strict().parse(Object.fromEntries(new URL(ctx.request.url).searchParams));return {status:200,body:{data:await profile(ctx,id)}};}
    if(section==='history') {
      await profile(ctx,id);const q=historyQuery.parse(Object.fromEntries(new URL(ctx.request.url).searchParams));
      const rows=(await ctx.db.query<{version:number}>('SELECT version,definition,changed_by,reason,changed_at FROM public.student_profile_revisions WHERE person_id=$1 AND version>$2 ORDER BY version LIMIT $3',[id,q.afterVersion,q.limit+1])).rows;
      return {status:200,body:{data:rows.slice(0,q.limit),nextVersion:rows.length>q.limit?rows[q.limit-1].version:null}};
    }
    throw new ApiError(405,'METHOD_NOT_ALLOWED');
  }
  const s=permissionScope(ctx,'students.view');if(!scopeNonempty(s))throw new ApiError(403,'FORBIDDEN');
  const q=listQuery.parse(Object.fromEntries(new URL(ctx.request.url).searchParams));
  const rows=(await ctx.db.query<{person_id:string}>(`SELECT s.person_id,s.legal_name,s.preferred_name,p.hub_id,p.status,s.version FROM public.student_profiles s
    JOIN public.people p ON p.academy_id=s.academy_id AND p.id=s.person_id WHERE (($1::boolean AND (cardinality($4::uuid[])=0 OR p.hub_id IS NOT NULL)) OR p.hub_id=ANY($2::uuid[]) OR p.id=ANY($3::uuid[]))
    AND NOT coalesce(p.hub_id=ANY($4::uuid[]),false) AND NOT p.id=ANY($5::uuid[]) AND ($6::uuid IS NULL OR p.id>$6)
    AND ($7::uuid IS NULL OR p.hub_id=$7) AND ($8::text IS NULL OR position(lower($8) in lower(s.legal_name||' '||coalesce(s.preferred_name,'')))>0) ORDER BY p.id LIMIT $9`,
    [s.all,s.hubs,(s.people??[]).map(p=>p.id),s.excludedHubs??[],(s.excludedPeople??[]).map(p=>p.id),q.after??null,q.hubId??null,q.q??null,q.limit+1])).rows;
  return {status:200,body:{data:rows.slice(0,q.limit),nextCursor:rows.length>q.limit?rows[q.limit-1].person_id:null}};
}
export const studentsContract=[
  {path:'/api/v1/students',method:'get',summary:'Private student directory without birth dates, care data or guardian contacts',querySchema:listQuery},
  {path:'/api/v1/students',method:'post',summary:'Create private student profile for a selected human; does not activate enrollment or a public profile',schema:createInput},
  {path:'/api/v1/students/{id}',method:'get',summary:'Read authorized private student profile including birth date and recruiter'},
  {path:'/api/v1/students/{id}/update',method:'post',summary:'Versioned profile correction; does not rewrite historical finance/signature evidence',schema:updateInput},
  {path:'/api/v1/students/{id}/history',method:'get',summary:'Authorized private student revisions; not exposed through ordinary audit rights',querySchema:historyQuery}
] as const;
