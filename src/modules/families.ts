import { z } from 'zod';
import { jsonBody,mutation,record,type ApiContext,type Reply } from '../core/api.ts';
import { propose,permissionScope,lockApprovalWrites,master,type ApprovalRegistry,type Proposal } from '../core/approvals.ts';
import { ApiError,scopeNonempty } from '../core/policy.ts';
import { lockAcademyTopology } from './academy.ts';
import { permittedPerson } from './students.ts';

const uuid=z.string().uuid().transform(v=>v.toLowerCase()),version=z.number().int().positive().max(2_147_483_647);
const instant=z.iso.datetime({offset:true}).refine(v=>v.slice(0,4)>='0001'&&!/\.\d{4}/.test(v)).describe('ISO timestamp with an explicit offset and at most millisecond precision.');
const relationship=z.enum(['parent','legal_guardian','authorized_contact']),state=z.enum(['approved','suspended']),reason=z.string().trim().min(1).max(2000);
const createInput=z.object({guardianId:uuid,relationship,validFrom:instant.nullable().default(null).describe('Inclusive start; null uses database time when approval is applied.'),
  validUntil:instant.nullable().default(null).describe('Exclusive end; null leaves this association open-ended.'),reason}).strict();
const createPayload=createInput.extend({studentId:uuid});
const updateInput=z.object({expectedVersion:version,relationship:relationship.optional(),validFrom:instant.optional(),validUntil:instant.nullable().optional(),state:state.optional(),reason}).strict()
  .refine(v=>['relationship','validFrom','validUntil','state'].some(k=>Object.hasOwn(v,k)));
const suspendInput=z.object({expectedVersion:version,reason}).strict();
const listQuery=z.object({limit:z.coerce.number().int().min(1).max(100).default(50),after:uuid.optional(),at:instant.optional(),state:state.optional()}).strict();
const historyQuery=z.object({limit:z.coerce.number().int().min(1).max(100).default(50),afterVersion:z.coerce.number().int().min(0).max(2_147_483_647).default(0)}).strict();
interface Family {id:string;student_id:string;guardian_id:string;relationship:z.infer<typeof relationship>;valid_from:Date|string;valid_until:Date|string|null;
 state:z.infer<typeof state>;version:number;last_approval_id:string}
const fields='id,student_id,guardian_id,relationship,valid_from,valid_until,state,version,last_approval_id,created_at';
async function child(ctx:ApiContext,id:string,edit=false,lock=edit) {
  const person=await permittedPerson(ctx,id,'families.view',lock);
  if(edit)await permittedPerson(ctx,id,'families.edit');
  if(!(await ctx.db.query('SELECT 1 FROM public.student_profiles WHERE person_id=$1',[id])).rows.length)throw new ApiError(404,'NOT_FOUND');
  return person;
}
async function relation(ctx:ApiContext,id:string,edit=false,lock=edit) {
  if(!scopeNonempty(permissionScope(ctx,'families.view')))throw new ApiError(403,'FORBIDDEN');
  const row=(await ctx.db.query<Family>('SELECT '+fields+' FROM public.family_relationships WHERE id=$1',[id])).rows[0];
  if(!row)throw new ApiError(404,'NOT_FOUND');
  const person=await child(ctx,row.student_id,edit,lock);return {row,person};
}
async function validate(ctx:ApiContext,action:'family.create'|'family.update',id:string,raw:unknown) {
  await lockAcademyTopology(ctx);
  let person;
  if(action==='family.create') {
    const input=createPayload.parse(raw);person=await child(ctx,input.studentId,true);
    if(input.studentId===input.guardianId)throw new ApiError(400,'SELF_GUARDIANSHIP_FORBIDDEN');
    await permittedPerson(ctx,input.guardianId,'guardians.view',true);
    if(!(await ctx.db.query('SELECT 1 FROM public.guardian_profiles WHERE person_id=$1',[input.guardianId])).rows.length)throw new ApiError(404,'GUARDIAN_NOT_FOUND');
  }else{updateInput.parse(raw);person=(await relation(ctx,id,true)).person;}
  return {all:false,hubs:[],people:[{id:person.id,hubId:person.hub_id}]};
}
async function dependencies(ctx:ApiContext,action:'family.create'|'family.update',id:string,raw:unknown) {
  const existing=action==='family.update'?(await ctx.db.query('SELECT '+fields+' FROM public.family_relationships WHERE id=$1',[id])).rows[0]:null;
  const input=action==='family.create'?createPayload.parse(raw):null;
  const studentId=input?.studentId??existing?.student_id,guardianId=input?.guardianId??existing?.guardian_id;
  // Approval viewers need versions/IDs, not private names, DOB or contacts.
  return {relationship:existing,student:(await ctx.db.query('SELECT person_id,version FROM public.student_profiles WHERE person_id=$1',[studentId??null])).rows[0]??null,
    guardian:(await ctx.db.query('SELECT person_id,version FROM public.guardian_profiles WHERE person_id=$1',[guardianId??null])).rows[0]??null,
    relatedPeriods:(await ctx.db.query('SELECT id,version,state,valid_from,valid_until FROM public.family_relationships WHERE student_id=$1 AND guardian_id=$2 ORDER BY id',[studentId??null,guardianId??null])).rows};
}
async function revision(ctx:ApiContext,before:Family|null,after:Family,why:string,approvalId:string|null,hubId:string|null) {
  await ctx.db.query('INSERT INTO public.family_relationship_revisions(academy_id,relationship_id,version,definition,changed_by,approval_id,reason) VALUES($1,$2,$3,$4::jsonb,$5,$6,$7)',
    [ctx.credential.academy_id,after.id,after.version,JSON.stringify(after),ctx.credential.person_id,approvalId,why]);
  await record(ctx.db,ctx.credential,ctx.requestId,!approvalId?'family.relationship.suspended':before?'family.relationship.updated':'family.relationship.created',after.id,hubId,
    {beforeVersion:before?.version??null,afterVersion:after.version,state:after.state,severity:'critical',hasReason:true});
}
async function apply(ctx:ApiContext,p:Proposal) {
  if(ctx.credential.kind!=='human')throw new ApiError(403,'HUMAN_REVIEW_REQUIRED');
  const creating=p.action==='family.create',input=creating?createPayload.parse(p.payload):updateInput.parse(p.payload);
  const before=creating?null:(await ctx.db.query<Family>('SELECT '+fields+' FROM public.family_relationships WHERE id=$1 FOR UPDATE',[p.target_id])).rows[0];
  if(!creating&&!before)throw new ApiError(404,'NOT_FOUND');
  if(before&&(before.version!==p.target_version||before.version!==('expectedVersion' in input?input.expectedVersion:0)))throw new ApiError(409,'TARGET_CHANGED');
  const studentId=creating?('studentId' in input?input.studentId:''):before!.student_id,guardianId=creating?('guardianId' in input?input.guardianId:''):before!.guardian_id;
  const defaultTime=creating&&!input.validFrom?(await ctx.db.query<{instant:Date|string}>("SELECT date_trunc('milliseconds',clock_timestamp()) AS instant")).rows[0].instant:null;
  const from=input.validFrom??before?.valid_from??defaultTime!,until=input.validUntil===undefined?before!.valid_until:input.validUntil;
  const ms=(v:Date|string)=>v instanceof Date?v.getTime():Date.parse(v);
  if(until!==null&&ms(until)<=ms(from))throw new ApiError(409,'INVALID_EFFECTIVE_PERIOD');
  const role=input.relationship??before!.relationship,nextState='state' in input?input.state??before!.state:before?.state??'approved';
  let after:Family;
  try {
    after=before?(await ctx.db.query<Family>('UPDATE public.family_relationships SET relationship=$2,valid_from=$3,valid_until=$4,state=$5,version=version+1,last_approval_id=$6 WHERE id=$1 RETURNING '+fields,[p.target_id,role,from,until,nextState,p.id])).rows[0]:
      (await ctx.db.query<Family>('INSERT INTO public.family_relationships(academy_id,id,student_id,guardian_id,relationship,valid_from,valid_until,state,last_approval_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING '+fields,
        [ctx.credential.academy_id,p.target_id,studentId,guardianId,role,from,until,nextState,p.id])).rows[0];
  }catch(error){if(error&&typeof error==='object'&&'code' in error&&error.code==='23P01')throw new ApiError(409,'FAMILY_PERIOD_OVERLAP');throw error;}
  const person=(await ctx.db.query<{hub_id:string|null}>('SELECT hub_id FROM public.people WHERE id=$1',[studentId])).rows[0];
  await revision(ctx,before,after,input.reason,p.id,person.hub_id);return after;
}
async function suspend(ctx:ApiContext,id:string):Promise<Reply> {
  if(ctx.credential.kind!=='human')throw new ApiError(403,'HUMAN_ACTION_REQUIRED');
  z.object({}).strict().parse(Object.fromEntries(new URL(ctx.request.url).searchParams));const input=suspendInput.parse(await jsonBody(ctx.request));
  await relation(ctx,id,true,false);
  await lockApprovalWrites(ctx,true);await lockAcademyTopology(ctx);const {person}=await relation(ctx,id,true);
  return mutation(ctx,input,async()=>{
    const before=(await ctx.db.query<Family>('SELECT '+fields+' FROM public.family_relationships WHERE id=$1 FOR UPDATE',[id])).rows[0];
    if(before.version!==input.expectedVersion)throw new ApiError(409,'TARGET_CHANGED');
    if(before.state==='suspended')throw new ApiError(409,'ALREADY_SUSPENDED');
    const after=(await ctx.db.query<Family>("UPDATE public.family_relationships SET state='suspended',version=version+1 WHERE id=$1 RETURNING "+fields,[id])).rows[0];
    await revision(ctx,before,after,input.reason,null,person.hub_id);return {status:200,body:{data:after}};
  });
}
async function authorizeReviewer(ctx:ApiContext,p:Proposal) {
  if(await master(ctx))return;
  const parties=p.action==='family.create'?createPayload.parse(p.payload):(await ctx.db.query<{student_id:string;guardian_id:string}>('SELECT student_id,guardian_id FROM public.family_relationships WHERE id=$1',[p.target_id])).rows[0];
  const studentId=parties&&('studentId' in parties?parties.studentId:parties.student_id),guardianId=parties&&('guardianId' in parties?parties.guardianId:parties.guardian_id);
  if(ctx.credential.person_id===studentId||ctx.credential.person_id===guardianId)throw new ApiError(403,'BENEFICIARY_REVIEW_FORBIDDEN');
}
export const familyActions:ApprovalRegistry={
  'family.create':{requestCapability:'families.edit',privacyCapability:'families.view',policyChange:true,createdStatus:201,
    validate:(ctx,id,input)=>validate(ctx,'family.create',id,input),dependencies:(ctx,id,input)=>dependencies(ctx,'family.create',id,input),authorizeReviewer,apply},
  'family.update':{requestCapability:'families.edit',privacyCapability:'families.view',policyChange:true,
    validate:(ctx,id,input)=>validate(ctx,'family.update',id,input),dependencies:(ctx,id,input)=>dependencies(ctx,'family.update',id,input),authorizeReviewer,apply}
};
export async function families(ctx:ApiContext,registry:ApprovalRegistry=familyActions):Promise<Reply|null> {
  const list=/^students\/([^/]+)\/guardians$/.exec(ctx.path),item=/^family-relationships\/([^/]+)(?:\/(change|suspend|history))?$/.exec(ctx.path);
  if(!list&&!item)return null;const id=uuid.parse((list??item)![1]),method=ctx.request.method;
  if(list) {
    if(method==='POST') {
      z.object({}).strict().parse(Object.fromEntries(new URL(ctx.request.url).searchParams));const input=createInput.parse(await jsonBody(ctx.request));
      await child(ctx,id,true,false);await permittedPerson(ctx,input.guardianId,'guardians.view');
      return propose(ctx,registry,'family.create',null,0,{...input,studentId:id});
    }
    if(method!=='GET')throw new ApiError(405,'METHOD_NOT_ALLOWED');
    await child(ctx,id);const q=listQuery.parse(Object.fromEntries(new URL(ctx.request.url).searchParams));
    const rows=(await ctx.db.query<{id:string}>(`SELECT r.*,coalesce(v.account_active AND v.email_verified AND v.phone_verified,false) AS identity_verification_complete
      FROM public.family_relationships r LEFT JOIN LATERAL public.guardian_contact_status(r.guardian_id) v ON true
      WHERE r.student_id=$1 AND ($2::uuid IS NULL OR r.id>$2) AND ($3::text IS NULL OR r.state=$3)
      AND ($4::timestamptz IS NULL OR r.valid_from<=$4 AND (r.valid_until IS NULL OR r.valid_until>$4)) ORDER BY r.id LIMIT $5`,[id,q.after??null,q.state??null,q.at??null,q.limit+1])).rows;
    return {status:200,body:{data:rows.slice(0,q.limit),nextCursor:rows.length>q.limit?rows[q.limit-1].id:null}};
  }
  const section=item![2];
  if(method==='POST'&&section==='suspend')return suspend(ctx,id);
  if(method==='POST'&&section==='change') {
    z.object({}).strict().parse(Object.fromEntries(new URL(ctx.request.url).searchParams));const input=updateInput.parse(await jsonBody(ctx.request));
    await relation(ctx,id,true,false);
    return propose(ctx,registry,'family.update',id,input.expectedVersion,input);
  }
  if(method==='GET') {
    const {row}=await relation(ctx,id);
    if(!section){z.object({}).strict().parse(Object.fromEntries(new URL(ctx.request.url).searchParams));return {status:200,body:{data:row}};}
    if(section==='history') {
      const q=historyQuery.parse(Object.fromEntries(new URL(ctx.request.url).searchParams));
      const rows=(await ctx.db.query<{version:number}>('SELECT version,definition,changed_by,approval_id,reason,changed_at FROM public.family_relationship_revisions WHERE relationship_id=$1 AND version>$2 ORDER BY version LIMIT $3',[id,q.afterVersion,q.limit+1])).rows;
      return {status:200,body:{data:rows.slice(0,q.limit),nextVersion:rows.length>q.limit?rows[q.limit-1].version:null}};
    }
  }
  throw new ApiError(405,'METHOD_NOT_ALLOWED');
}
export const familiesContract=[
  {path:'/api/v1/students/{id}/guardians',method:'get',summary:'Private approved/suspended family associations and current identity verification status; not an access grant',querySchema:listQuery},
  {path:'/api/v1/students/{id}/guardians',method:'post',summary:'Request a family association; upper human approval or master self-approval required',schema:createInput},
  {path:'/api/v1/family-relationships/{id}',method:'get',summary:'Read an authorized family association, not a legal guardianship certificate'},
  {path:'/api/v1/family-relationships/{id}/change',method:'post',summary:'Request a versioned family role/period change or reinstatement',schema:updateInput},
  {path:'/api/v1/family-relationships/{id}/suspend',method:'post',summary:'Human-only immediate protective suspension, with critical audit/outbox evidence',schema:suspendInput},
  {path:'/api/v1/family-relationships/{id}/history',method:'get',summary:'Private immutable family association revisions',querySchema:historyQuery}
] as const;
