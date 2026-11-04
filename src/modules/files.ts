import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { jsonBody,mutation,record,type ApiContext,type Reply } from '../core/api.ts';
import { permissionScope } from '../core/approvals.ts';
import { ApiError,requireScope,scopeNonempty,type Capability } from '../core/policy.ts';
import { lockAcademyTopology } from './academy.ts';
import { classRow } from './classes.ts';
import { permittedPerson } from './students.ts';

const uuid=z.string().uuid().transform(v=>v.toLowerCase()),version=z.number().int().positive().max(2_147_483_647);
const text=z.string().refine(v=>v.isWellFormed()&&!v.includes('\0'),'Use valid Unicode without null characters.');
const name=text.trim().min(1).max(200).refine(v=>!/[\/\\\r\n]/.test(v)&&v!=='.'&&v!=='..','Use a filename, not a path.');
const description=text.max(2000),tags=z.array(text.trim().min(1).max(50)).max(20).refine(v=>new Set(v.map(t=>t.toLowerCase())).size===v.length),reason=text.trim().max(2000).default('');
const anchor=z.discriminatedUnion('kind',[z.object({kind:z.literal('academy')}).strict(),...(['hub','class','person'] as const).map(kind=>z.object({kind:z.literal(kind),id:uuid}).strict())]);
const domain=z.enum(['general','student_private','guardian_private','agreement_definition']);
const createInput=z.object({anchor,domain:domain.default('general'),name,description:description.default(''),tags:tags.default([]),
  claimedMimeType:z.string().regex(/^[a-z0-9][a-z0-9.+-]{0,99}\/[a-z0-9][a-z0-9.+-]{0,99}$/),expectedBytes:z.number().int().min(1).max(4_294_967_296),
  expectedSha256:z.string().regex(/^[a-fA-F0-9]{64}$/).transform(v=>v.toLowerCase()).nullable().default(null),reason}).strict()
  .refine(v=>v.domain==='general'||(['student_private','guardian_private'].includes(v.domain)&&v.anchor.kind==='person')||(v.domain==='agreement_definition'&&['academy','hub'].includes(v.anchor.kind)),'Choose an anchor compatible with the protected data domain.');
const updateInput=z.object({expectedVersion:version,name:name.optional(),description:description.optional(),tags:tags.optional(),archived:z.boolean().optional(),reason}).strict().refine(v=>Object.keys(v).some(k=>!['expectedVersion','reason'].includes(k)));
const query=z.object({limit:z.coerce.number().int().min(1).max(100).default(50),after:uuid.optional(),q:text.trim().min(1).max(100).optional(),domain:domain.optional(),
  anchorKind:z.enum(['academy','hub','class','person']).optional(),hubId:uuid.optional(),classId:uuid.optional(),personId:uuid.optional(),archived:z.enum(['true','false']).transform(v=>v==='true').optional()}).strict();
const historyQuery=z.object({limit:query.shape.limit,afterVersion:z.coerce.number().int().min(0).max(2_147_483_647).default(0)}).strict();
interface FileRecord {id:string;anchor_kind:'academy'|'hub'|'class'|'person';hub_id:string|null;class_id:string|null;person_id:string|null;domain:z.infer<typeof domain>;
  name:string;description:string;tags:string[];claimed_mime_type:string;expected_bytes:number;expected_sha256:string|null;archived:boolean;version:number;effective_hub_id:string|null}
const fields=`f.id,f.anchor_kind,f.hub_id,f.class_id,f.person_id,f.domain,f.name,f.description,f.tags,f.claimed_mime_type,
  f.expected_bytes::float8 AS expected_bytes,f.expected_sha256,f.archived,f.version,f.created_by,f.created_at,f.effective_hub_id,
  CASE WHEN EXISTS(SELECT 1 FROM public.file_inspection_requests inspection WHERE inspection.academy_id=f.academy_id AND inspection.file_id=f.id) THEN 'inspection_requested' ELSE 'awaiting_upload' END AS upload_state`;
const domains=[['student_private','students'],['guardian_private','guardians'],['agreement_definition','agreements']] as const;
function access(ctx:ApiContext,edit=false,operation?:'files.upload') {
  if(!scopeNonempty(permissionScope(ctx,'files.view'))||(edit&&!scopeNonempty(permissionScope(ctx,'files.edit')))||(operation&&!scopeNonempty(permissionScope(ctx,operation))))throw new ApiError(403,'FORBIDDEN');
  const params:unknown[]=[],bind=(value:unknown,type:string)=>{params.push(value);return '$'+params.length+'::'+type;};
  function within(cap:Capability) {
    const s=permissionScope(ctx,cap);if(!scopeNonempty(s))return 'false';
    const broad=bind(s.all,'boolean'),hubs=bind(s.hubs,'uuid[]'),blocked=bind(s.excludedHubs??[],'uuid[]'),unassigned=bind(!s.excludedHubs?.length&&!s.excludedAreas?.length,'boolean');
    const classes=bind((s.classes??[]).map(r=>r.id),'uuid[]'),people=bind((s.people??[]).map(r=>r.id),'uuid[]'),noClasses=bind((s.excludedClasses??[]).map(r=>r.id),'uuid[]'),noPeople=bind((s.excludedPeople??[]).map(r=>r.id),'uuid[]');
    return `((${broad} AND (f.effective_hub_id IS NOT NULL OR ${unassigned}) OR f.effective_hub_id=ANY(${hubs}) OR f.class_id=ANY(${classes}) OR f.person_id=ANY(${people}))
      AND NOT coalesce(f.effective_hub_id=ANY(${blocked}),false) AND NOT coalesce(f.class_id=ANY(${noClasses}),false) AND NOT coalesce(f.person_id=ANY(${noPeople}),false))`;
  }
  const file=within('files.view')+(edit?' AND '+within('files.edit'):'')+(operation?' AND '+within(operation):''),protectedDomains=domains.map(([label,prefix])=>`(f.domain='${label}' AND ${within((prefix+'.view') as Capability)}${edit?' AND '+within((prefix+'.edit') as Capability):''})`);
  return {where:`(${file}) AND (f.domain='general' OR ${protectedDomains.join(' OR ')})`,params,bind};
}
async function file(ctx:ApiContext,id:string,edit=false,lock=false,operation?:'files.upload'):Promise<FileRecord> {
  const a=access(ctx,edit,operation),selected=a.bind(id,'uuid');
  const row=(await ctx.db.query<FileRecord>('SELECT '+fields+' FROM public.file_catalogue f WHERE '+a.where+' AND f.id='+selected,a.params)).rows[0];
  if(!row)throw new ApiError(404,'NOT_FOUND');
  if(lock) {
    await ctx.db.query('SELECT id FROM public.file_records WHERE id=$1 FOR UPDATE',[id]);
    // No joined FOR UPDATE: reread current metadata after any row-lock wait.
    return file(ctx,id,edit,false,operation);
  }
  return row;
}
export { file as permittedFile };
async function validateAnchor(ctx:ApiContext,value:z.infer<typeof anchor>,cap:Capability) {
  if(value.kind==='person')return {hubId:null,personId:(await permittedPerson(ctx,value.id,cap)).id,classId:null};
  if(value.kind==='class'){const c=await classRow(ctx,value.id,cap);return {hubId:c.hub_id,personId:null,classId:c.id};}
  requireScope(permissionScope(ctx,cap),value.kind==='hub'?value.id:undefined);
  if(value.kind==='hub'&&!(await ctx.db.query('SELECT 1 FROM public.hubs WHERE id=$1',[value.id])).rows.length)throw new ApiError(404,'NOT_FOUND');
  return {hubId:value.kind==='hub'?value.id:null,personId:null,classId:null};
}
async function validateReservation(ctx:ApiContext,input:z.infer<typeof createInput>) {
  access(ctx,true);
  await validateAnchor(ctx,input.anchor,'files.view');const target=await validateAnchor(ctx,input.anchor,'files.edit');
  const extra=domains.find(([label])=>label===input.domain);
  if(extra) {
    for(const mode of ['view','edit'])await validateAnchor(ctx,input.anchor,(extra[1]+'.'+mode) as Capability);
    if(input.domain!=='agreement_definition'&&!(await ctx.db.query('SELECT 1 FROM public.'+(input.domain==='student_private'?'student_profiles':'guardian_profiles')+' WHERE person_id=$1',[target.personId])).rows.length)throw new ApiError(404,'NOT_FOUND');
  }
  return target;
}
async function create(ctx:ApiContext):Promise<Reply> {
  const input=createInput.parse(await jsonBody(ctx.request));await validateReservation(ctx,input);
  await lockAcademyTopology(ctx);const target=await validateReservation(ctx,input);
  return mutation(ctx,input,async()=>{
    const id=randomUUID();await ctx.db.query(`INSERT INTO public.file_records(academy_id,id,anchor_kind,hub_id,class_id,person_id,domain,name,description,tags,claimed_mime_type,expected_bytes,expected_sha256,search_text,created_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,[ctx.credential.academy_id,id,input.anchor.kind,target.hubId,target.classId,target.personId,input.domain,input.name,input.description,input.tags,input.claimedMimeType,input.expectedBytes,input.expectedSha256,[input.name,input.description,...input.tags].join(' '),ctx.credential.person_id]);
    const row=await file(ctx,id,true);await revision(ctx,null,row,input.reason);return {status:201,body:{data:row}};
  });
}
async function revision(ctx:ApiContext,before:FileRecord|null,after:FileRecord,why:string) {
  await ctx.db.query('INSERT INTO public.file_record_revisions(academy_id,file_id,version,definition,changed_by,reason) VALUES($1,$2,$3,$4::jsonb,$5,$6)',[ctx.credential.academy_id,after.id,after.version,JSON.stringify(after),ctx.credential.person_id,why]);
  await record(ctx.db,ctx.credential,ctx.requestId,before?'file.metadata.updated':'file.metadata.reserved',after.id,after.effective_hub_id,{beforeVersion:before?.version??null,afterVersion:after.version,archived:after.archived,hasReason:Boolean(why)});
}
export async function files(ctx:ApiContext):Promise<Reply|null> {
  const match=/^files(?:\/([^/]+)(?:\/(change|history))?)?$/.exec(ctx.path);if(!match)return null;
  const id=match[1]?uuid.parse(match[1]):null,section=match[2],method=ctx.request.method;
  if(method==='POST') {
    z.object({}).strict().parse(Object.fromEntries(new URL(ctx.request.url).searchParams));
    if(!id)return create(ctx);
    if(section!=='change')throw new ApiError(405,'METHOD_NOT_ALLOWED');const input=updateInput.parse(await jsonBody(ctx.request));await file(ctx,id,true);await lockAcademyTopology(ctx);
    return mutation(ctx,input,async()=>{
      const before=await file(ctx,id,true,true);if(before.version!==input.expectedVersion)throw new ApiError(409,'TARGET_CHANGED');
      const next={name:input.name??before.name,description:input.description??before.description,tags:input.tags??before.tags,archived:input.archived??before.archived};
      await ctx.db.query('UPDATE public.file_records SET name=$2,description=$3,tags=$4,archived=$5,version=version+1,search_text=$6 WHERE id=$1',[id,next.name,next.description,next.tags,next.archived,[next.name,next.description,...next.tags].join(' ')]);
      const row=await file(ctx,id);await revision(ctx,before,row,input.reason);return {status:200,body:{data:row}};
    });
  }
  if(method!=='GET')throw new ApiError(405,'METHOD_NOT_ALLOWED');
  if(id) {
    const row=await file(ctx,id);
    if(section==='history'){const q=historyQuery.parse(Object.fromEntries(new URL(ctx.request.url).searchParams));const rows=(await ctx.db.query<{version:number}>('SELECT version,definition,changed_by,reason,created_at FROM public.file_record_revisions WHERE file_id=$1 AND version>$2 ORDER BY version LIMIT $3',[id,q.afterVersion,q.limit+1])).rows;return {status:200,body:{data:rows.slice(0,q.limit),nextVersion:rows.length>q.limit?rows[q.limit-1].version:null}};}
    if(section)throw new ApiError(405,'METHOD_NOT_ALLOWED');z.object({}).strict().parse(Object.fromEntries(new URL(ctx.request.url).searchParams));return {status:200,body:{data:row}};
  }
  const q=query.parse(Object.fromEntries(new URL(ctx.request.url).searchParams)),a=access(ctx),filters=[a.where];
  for(const [value,column,type] of [[q.after,'id','uuid'],[q.hubId,'effective_hub_id','uuid'],[q.classId,'class_id','uuid'],[q.personId,'person_id','uuid'],[q.domain,'domain','text'],[q.anchorKind,'anchor_kind','text'],[q.archived,'archived','boolean']] as const)
    if(value!==undefined)filters.push('f.'+column+(column==='id'?'>':'=')+a.bind(value,type));
  if(q.q)filters.push('lower(f.search_text) LIKE '+a.bind('%'+q.q.toLowerCase().replace(/[\\%_]/g,'\\$&')+'%','text'));
  const rows=(await ctx.db.query<{id:string}>('SELECT '+fields+' FROM public.file_catalogue f WHERE '+filters.join(' AND ')+' ORDER BY f.id LIMIT '+a.bind(q.limit+1,'integer'),a.params)).rows;
  return {status:200,body:{data:rows.slice(0,q.limit),nextCursor:rows.length>q.limit?rows[q.limit-1].id:null}};
}
export const filesContract=[
  {path:'/api/v1/files',method:'get',summary:'Permission-filtered private metadata search; reservations are not proof of stored/clean files',querySchema:query},
  {path:'/api/v1/files',method:'post',summary:'Reserve immutable file claims and anchor; no upload URL, bytes or scan status is created',schema:createInput},
  {path:'/api/v1/files/{id}',method:'get',summary:'Read scoped file metadata with protected-domain permission checks'},
  {path:'/api/v1/files/{id}/change',method:'post',summary:'Rename, tag, describe or archive metadata while preserving upload claims and anchor',schema:updateInput},
  {path:'/api/v1/files/{id}/history',method:'get',summary:'Private immutable metadata revisions under current file and domain rights',querySchema:historyQuery}
] as const;
