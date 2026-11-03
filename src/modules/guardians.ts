import { z } from 'zod';
import { jsonBody,mutation,record,type ApiContext,type Reply } from '../core/api.ts';
import { permissionScope } from '../core/approvals.ts';
import { ApiError,scopeNonempty } from '../core/policy.ts';
import { lockAcademyTopology } from './academy.ts';
import { permittedPerson } from './students.ts';

const uuid=z.string().uuid().transform(v=>v.toLowerCase()),version=z.number().int().positive().max(2_147_483_647);
const legalName=z.string().trim().min(1).max(200),wechatId=z.string().trim().min(1).max(100).nullable(),reason=z.string().trim().max(2000).default('');
const createInput=z.object({personId:uuid,legalName,wechatId:wechatId.default(null),reason}).strict();
const updateInput=z.object({expectedVersion:version,legalName:legalName.optional(),wechatId:wechatId.optional(),reason}).strict().refine(v=>v.legalName!==undefined||v.wechatId!==undefined);
const listQuery=z.object({limit:z.coerce.number().int().min(1).max(100).default(50),after:uuid.optional(),hubId:uuid.optional(),q:z.string().trim().min(1).max(100).optional()}).strict();
const historyQuery=z.object({limit:z.coerce.number().int().min(1).max(100).default(50),afterVersion:z.coerce.number().int().min(0).max(2_147_483_647).default(0)}).strict();
interface Guardian {person_id:string;legal_name:string;wechat_id:string|null;version:number}
const fields='person_id,legal_name,wechat_id,version,created_at';
async function profile(ctx:ApiContext,id:string,lock=false) {
  const row=(await ctx.db.query<Guardian>('SELECT '+fields+' FROM public.guardian_profiles WHERE person_id=$1'+(lock?' FOR UPDATE':''),[id])).rows[0];
  if(!row)throw new ApiError(404,'NOT_FOUND');return row;
}
async function guardianContacts(ctx:ApiContext,id:string) {
  const row=(await ctx.db.query<{email:string|null;phone:string|null;email_verified:boolean;phone_verified:boolean;account_active:boolean}>('SELECT * FROM public.guardian_contact_status($1)',[id])).rows[0];
  if(!row)throw new ApiError(404,'NOT_FOUND');
  return {...row,verification_complete:row.account_active&&row.email_verified&&row.phone_verified};
}
async function save(ctx:ApiContext,id?:string):Promise<Reply> {
  z.object({}).strict().parse(Object.fromEntries(new URL(ctx.request.url).searchParams));
  const input=id?updateInput.parse(await jsonBody(ctx.request)):createInput.parse(await jsonBody(ctx.request));
  const target=id??('personId' in input?input.personId:'');
  await lockAcademyTopology(ctx);const person=await permittedPerson(ctx,target,'guardians.edit',true);
  return mutation(ctx,input,async()=>{
    const before=id?await profile(ctx,target,true):null;
    if(before&&before.version!==('expectedVersion' in input?input.expectedVersion:0))throw new ApiError(409,'TARGET_CHANGED');
    const name=input.legalName??before!.legal_name,wechat=input.wechatId===undefined?before!.wechat_id:input.wechatId;
    const after=before?(await ctx.db.query<Guardian>('UPDATE public.guardian_profiles SET legal_name=$2,wechat_id=$3,version=version+1 WHERE person_id=$1 RETURNING '+fields,[target,name,wechat])).rows[0]:
      (await ctx.db.query<Guardian>('INSERT INTO public.guardian_profiles(academy_id,person_id,legal_name,wechat_id) VALUES($1,$2,$3,$4) RETURNING '+fields,[ctx.credential.academy_id,target,name,wechat])).rows[0];
    await ctx.db.query('INSERT INTO public.guardian_profile_revisions(academy_id,person_id,version,definition,changed_by,reason) VALUES($1,$2,$3,$4::jsonb,$5,$6)',[ctx.credential.academy_id,target,after.version,JSON.stringify(after),ctx.credential.person_id,input.reason]);
    await record(ctx.db,ctx.credential,ctx.requestId,before?'guardian.profile.updated':'guardian.profile.created',target,person.hub_id,
      {beforeVersion:before?.version??null,afterVersion:after.version,fields:Object.keys(input).filter(k=>!['personId','expectedVersion','reason'].includes(k)),hasReason:Boolean(input.reason)});
    return {status:before?200:201,body:{data:{personId:target,version:after.version}}};
  });
}
export async function guardians(ctx:ApiContext):Promise<Reply|null> {
  const match=/^guardians(?:\/([^/]+)(?:\/(update|history))?)?$/.exec(ctx.path);if(!match)return null;
  const id=match[1]?uuid.parse(match[1]):undefined,section=match[2];
  if(ctx.request.method==='POST'&&!section&&!id)return save(ctx);
  if(ctx.request.method==='POST'&&section==='update'&&id)return save(ctx,id);
  if(ctx.request.method!=='GET')throw new ApiError(405,'METHOD_NOT_ALLOWED');
  if(id) {
    await permittedPerson(ctx,id,'guardians.view');
    if(!section){z.object({}).strict().parse(Object.fromEntries(new URL(ctx.request.url).searchParams));return {status:200,body:{data:await profile(ctx,id),contacts:await guardianContacts(ctx,id)}};}
    if(section==='history') {
      await profile(ctx,id);const q=historyQuery.parse(Object.fromEntries(new URL(ctx.request.url).searchParams));
      const rows=(await ctx.db.query<{version:number}>('SELECT version,definition,changed_by,reason,changed_at FROM public.guardian_profile_revisions WHERE person_id=$1 AND version>$2 ORDER BY version LIMIT $3',[id,q.afterVersion,q.limit+1])).rows;
      return {status:200,body:{data:rows.slice(0,q.limit),nextVersion:rows.length>q.limit?rows[q.limit-1].version:null}};
    }
    throw new ApiError(405,'METHOD_NOT_ALLOWED');
  }
  const s=permissionScope(ctx,'guardians.view');if(!scopeNonempty(s))throw new ApiError(403,'FORBIDDEN');
  const q=listQuery.parse(Object.fromEntries(new URL(ctx.request.url).searchParams));
  const rows=(await ctx.db.query<{person_id:string}>(`SELECT g.person_id,g.legal_name,p.hub_id,p.status,g.version FROM public.guardian_profiles g
    JOIN public.people p ON p.academy_id=g.academy_id AND p.id=g.person_id WHERE (($1::boolean AND (cardinality($4::uuid[])=0 OR p.hub_id IS NOT NULL)) OR p.hub_id=ANY($2::uuid[]) OR p.id=ANY($3::uuid[]))
    AND NOT coalesce(p.hub_id=ANY($4::uuid[]),false) AND NOT p.id=ANY($5::uuid[]) AND ($6::uuid IS NULL OR p.id>$6)
    AND ($7::uuid IS NULL OR p.hub_id=$7) AND ($8::text IS NULL OR position(lower($8) in lower(g.legal_name))>0) ORDER BY p.id LIMIT $9`,
    [s.all,s.hubs,(s.people??[]).map(p=>p.id),s.excludedHubs??[],(s.excludedPeople??[]).map(p=>p.id),q.after??null,q.hubId??null,q.q??null,q.limit+1])).rows;
  return {status:200,body:{data:rows.slice(0,q.limit),nextCursor:rows.length>q.limit?rows[q.limit-1].person_id:null}};
}
export const guardiansContract=[
  {path:'/api/v1/guardians',method:'get',summary:'Private guardian directory; contact details and WeChat IDs omitted',querySchema:listQuery},
  {path:'/api/v1/guardians',method:'post',summary:'Create draft guardian details for a selected human; no family authority or verification is granted',schema:createInput},
  {path:'/api/v1/guardians/{id}',method:'get',summary:'Authorized guardian profile plus current identity-sourced contact verification status'},
  {path:'/api/v1/guardians/{id}/update',method:'post',summary:'Versioned guardian detail correction; cannot set identity verification or contact fields',schema:updateInput},
  {path:'/api/v1/guardians/{id}/history',method:'get',summary:'Private immutable guardian profile revisions',querySchema:historyQuery}
] as const;
