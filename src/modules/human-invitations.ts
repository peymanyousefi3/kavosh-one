import { createHmac } from 'node:crypto';
import { z } from 'zod';
import { jsonBody,mutation,record,type ApiContext,type Reply } from '../core/api.ts';
import { lockApprovalWrites,permissionScope,propose,type ApprovalRegistry,type Proposal } from '../core/approvals.ts';
import { ApiError,scopeAllowsRef,scopeNonempty } from '../core/policy.ts';
import { lockAcademyTopology } from './academy.ts';
import { permittedPerson } from './students.ts';

const uuid=z.string().uuid().transform(v=>v.toLowerCase());
const input=z.object({personId:uuid,expectedPersonVersion:z.number().int().positive().max(2147483647),reason:z.string().trim().min(1).max(2000).refine(v=>v.isWellFormed()&&!v.includes('\0'))}).strict();
const empty=z.object({}).strict(),paging=z.object({limit:z.coerce.number().int().min(1).max(100).default(50),after:uuid.optional()}).strict();
type Basis={schoolStatus:string;person:{id:string;hubId:string|null;name:string;email:string|null;kind:string;status:string;version:number;identityBound:boolean;isMaster:boolean};hub:{active:boolean}|null;accessFingerprint:string};
async function basis(ctx:ApiContext,personId:string){
 const value=(await ctx.db.query<{basis:Basis|null}>('SELECT public.human_invitation_basis($1) AS basis',[personId])).rows[0]?.basis;
 if(!value)throw new ApiError(404,'NOT_FOUND');return value;
}
function eligible(b:Basis){return b.schoolStatus==='active'&&b.person.kind==='human'&&b.person.status==='pending'&&!b.person.identityBound&&!b.person.isMaster&&Boolean(b.person.email&&z.string().email().max(254).safeParse(b.person.email).success)&&(!b.hub||b.hub.active);}
async function source(ctx:ApiContext,raw:unknown){
 const i=input.parse(raw);await permittedPerson(ctx,i.personId,'invitations.view');await permittedPerson(ctx,i.personId,'invitations.edit');
 const b=await basis(ctx,i.personId);if(!eligible(b))throw new ApiError(409,'INVITATION_RECIPIENT_UNAVAILABLE');if(b.person.version!==i.expectedPersonVersion)throw new ApiError(409,'PERSON_CHANGED');return b;
}
async function apply(ctx:ApiContext,p:Proposal){
 if(ctx.credential.kind!=='human')throw new ApiError(403,'HUMAN_REVIEW_REQUIRED');const i=input.parse(p.payload),b=await source(ctx,i);
 try{await ctx.db.query('INSERT INTO public.human_invitation_preparations(academy_id,id,person_id,hub_id,source_basis,changed_by,approval_id,reason) VALUES($1,$2,$3,$4,$5::jsonb,$6,$7,$8)',[ctx.credential.academy_id,p.target_id,i.personId,b.person.hubId,JSON.stringify(b),ctx.credential.person_id,p.id,i.reason]);}
 catch(error){if(error&&typeof error==='object'&&'message'in error&&error.message==='INVITATION_EXACT_APPROVAL_REQUIRED')throw new ApiError(409,'INVITATION_SOURCE_CHANGED');throw error;}
 await record(ctx.db,ctx.credential,ctx.requestId,p.action,p.target_id,b.person.hubId,{personId:i.personId,approvalId:p.id,hasReason:true,activationPerformed:false,externalDeliveryPerformed:false,severity:'critical'});
 return{id:p.target_id,personId:i.personId,approved:true,activationPerformed:false,externalDeliveryPerformed:false};
}
export const humanInvitationActions:ApprovalRegistry={'human-invitation.prepare':{
 requestCapability:'invitations.edit',privacyCapability:'invitations.view',createdStatus:201,
 async validate(ctx,id,raw){await lockAcademyTopology(ctx);const b=await source(ctx,raw);return{all:false,hubs:[],people:[{id:b.person.id,hubId:b.person.hubId}]};},
 async dependencies(ctx,id,raw,purpose){try{return await source(ctx,raw) as unknown as Record<string,unknown>;}catch(error){if(purpose==='review'&&error instanceof ApiError&&[403,404,409].includes(error.status))return{unavailable:error.code};throw error;}},apply
}};
async function row(ctx:ApiContext,id:string,edit=false){
 const r=(await ctx.db.query<{id:string;person_id:string;hub_id:string|null;source_basis:Basis;changed_by:string;approval_id:string;reason:string;created_at:string;source_current:boolean}>('SELECT p.*,p.source_basis IS NOT DISTINCT FROM public.human_invitation_basis(p.person_id) AS source_current FROM public.human_invitation_preparations p WHERE id=$1',[id])).rows[0];
 if(!r||!scopeAllowsRef(permissionScope(ctx,'invitations.view'),{id:r.person_id,hubId:r.hub_id},'people'))throw new ApiError(404,'NOT_FOUND');await permittedPerson(ctx,r.person_id,'invitations.view');
 if(edit){if(!scopeAllowsRef(permissionScope(ctx,'invitations.edit'),{id:r.person_id,hubId:r.hub_id},'people'))throw new ApiError(404,'NOT_FOUND');await permittedPerson(ctx,r.person_id,'invitations.edit');}return r;
}
export async function humanInvitations(ctx:ApiContext,registry:ApprovalRegistry=humanInvitationActions,secret?:string):Promise<Reply|null>{
 const person=/^invitations\/people\/([^/]+)$/.exec(ctx.path),match=/^invitations(?:\/([^/]+)(?:\/(token))?)?$/.exec(ctx.path);if(!person&&!match)return null;
 const search=new URL(ctx.request.url).searchParams;if([...search].length!==new Set(search.keys()).size)throw new ApiError(400,'DUPLICATE_QUERY');const query=Object.fromEntries(search);
 if(person){if(ctx.request.method!=='GET')throw new ApiError(405,'METHOD_NOT_ALLOWED');empty.parse(query);await lockAcademyTopology(ctx);const id=uuid.parse(person[1]);await permittedPerson(ctx,id,'invitations.view');const b=await basis(ctx,id);return{status:200,body:{data:{personId:id,name:b.person.name,email:b.person.email,status:b.person.status,schoolStatus:b.schoolStatus,version:b.person.version,eligible:eligible(b)}}};}
 const id=match![1]?uuid.parse(match![1]):null,section=match![2];
 if(ctx.request.method==='POST'&&!id){empty.parse(query);const i=input.parse(await jsonBody(ctx.request));return propose(ctx,registry,'human-invitation.prepare',null,0,i);}
 if(ctx.request.method==='POST'&&id&&section==='token'){
  empty.parse(query);empty.parse(await jsonBody(ctx.request));uuid.parse(ctx.request.headers.get('idempotency-key'));
  if(ctx.credential.kind!=='human')throw new ApiError(403,'HUMAN_INVITATION_HANDOFF_REQUIRED');
  // Secrets never enter generic mutation receipts or approval payloads.
  await lockApprovalWrites(ctx,true);await lockAcademyTopology(ctx,true);const r=await row(ctx,id,true);
  if(!r.source_current)throw new ApiError(409,'INVITATION_SOURCE_CHANGED');if(!secret||secret.length<32)throw new ApiError(503,'INVITATIONS_NOT_CONFIGURED');
  const token='kvi_'+createHmac('sha256',secret).update(JSON.stringify(['school-human-invitation:v1',ctx.credential.academy_id,id])).digest('base64url'),hash=createHmac('sha256',secret).update(token).digest('hex');
  let value:unknown;
  try{value=(await ctx.db.query<{data:unknown}>('SELECT public.issue_human_invitation($1,$2,$3,$4) AS data',[id,ctx.credential.person_id,ctx.credential.token_id,hash])).rows[0]?.data;}
  catch(error){const message=error&&typeof error==='object'&&'message'in error?String(error.message):'';if(['INVITATION_SOURCE_CHANGED','INVITATION_NO_LONGER_CURRENT','INVITATION_TOKEN_KEY_CHANGED','INVITATION_SCHOOL_UNAVAILABLE'].includes(message))throw new ApiError(409,message);throw error;}
  const metadata=z.object({preparationId:uuid,personId:uuid,email:z.string().email(),expiresAt:z.iso.datetime({offset:true}).transform(v=>new Date(v).toISOString()),activationPerformed:z.literal(false),externalDeliveryPerformed:z.literal(false)}).strict(),parsed=metadata.safeParse(value);
  if(!parsed.success||parsed.data.preparationId!==id||parsed.data.personId!==r.person_id)throw new Error('INVALID_INVITATION_RESULT');
  const receipt=await mutation(ctx,{},async()=>{
   await record(ctx.db,ctx.credential,ctx.requestId,'human-invitation.token.issued',id,r.hub_id,{personId:r.person_id,activationPerformed:false,externalDeliveryPerformed:false,severity:'critical'});
   return{status:201,body:{data:parsed.data}};
  });
  const cached=z.object({data:metadata}).strict().safeParse(receipt.body);
  if(receipt.status!==201||!cached.success||JSON.stringify(cached.data.data)!==JSON.stringify(parsed.data))throw new Error('INVALID_INVITATION_RECEIPT');
  return{status:201,body:{data:{...cached.data.data,privateInvitation:token}}};
 }
 if(ctx.request.method!=='GET'||section)throw new ApiError(405,'METHOD_NOT_ALLOWED');
 await lockAcademyTopology(ctx);
 if(id){empty.parse(query);const r=await row(ctx,id),issue=(await ctx.db.query<{issue:unknown}>('SELECT public.human_invitation_issue_status($1) AS issue',[id])).rows[0]?.issue;return{status:200,body:{data:{...r,issue}}};}
 const s=permissionScope(ctx,'invitations.view');if(!scopeNonempty(s))throw new ApiError(403,'FORBIDDEN');const q=paging.parse(query);
 const rows=(await ctx.db.query<{id:string}>(`SELECT r.id,r.person_id,p.name,p.hub_id,r.created_at FROM public.human_invitation_preparations r JOIN public.people p ON p.academy_id=r.academy_id AND p.id=r.person_id
 WHERE(($1::boolean AND(cardinality($4::uuid[])=0 OR p.hub_id IS NOT NULL)) OR p.hub_id=ANY($2::uuid[]) OR p.id=ANY($3::uuid[])) AND NOT coalesce(p.hub_id=ANY($4::uuid[]),false)
 AND(($1::boolean AND(cardinality($4::uuid[])=0 OR r.hub_id IS NOT NULL)) OR r.hub_id=ANY($2::uuid[]) OR p.id=ANY($3::uuid[])) AND NOT coalesce(r.hub_id=ANY($4::uuid[]),false)
 AND NOT p.id=ANY($5::uuid[]) AND($6::uuid IS NULL OR r.id>$6) ORDER BY r.id LIMIT $7`,[s.all,s.hubs,(s.people??[]).map(p=>p.id),s.excludedHubs??[],(s.excludedPeople??[]).map(p=>p.id),q.after??null,q.limit+1])).rows;
 return{status:200,body:{data:rows.slice(0,q.limit),nextCursor:rows.length>q.limit?rows[q.limit-1].id:null}};
}
export const humanInvitationsContract=[
 {path:'/api/v1/invitations/people/{id}',method:'get',summary:'Current permitted human onboarding eligibility and source version; does not disclose identity IDs'},
 {path:'/api/v1/invitations',method:'get',summary:'Permission-filtered approved onboarding preparations',querySchema:paging},
 {path:'/api/v1/invitations',method:'post',summary:'Request upper-approved onboarding for an existing pending teacher,parent,student or staff profile; master self-approves',schema:input},
 {path:'/api/v1/invitations/{id}',method:'get',summary:'Private immutable invitation preparation with current-source comparison; never a token'},
 {path:'/api/v1/invitations/{id}/token',method:'post',summary:'Verified human editor retrieves one private48hour token for this approved preparation; exact retries retain original expiry; no send or activation',schema:empty,humanOnly:true}
] as const;
