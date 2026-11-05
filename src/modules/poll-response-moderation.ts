import { z } from 'zod';
import { jsonBody,record,type ApiContext,type Reply } from '../core/api.ts';
import { propose,master,permissionScope,lockApprovalWrites,type ApprovalRegistry } from '../core/approvals.ts';
import { ApiError,scopeContains,type Capability,type Scope } from '../core/policy.ts';
import { lockAcademyTopology } from './academy.ts';

const uuid=z.string().uuid().transform(v=>v.toLowerCase()),version=z.number().int().min(1).max(2147483647);
const input=z.object({responseVersion:version,expectedVersion:z.number().int().min(0).max(2147483647),excluded:z.boolean(),reason:z.string().trim().min(1).max(2000).refine(v=>v.isWellFormed()&&!v.includes('\0'))}).strict(),payload=input.extend({responseId:uuid});
const selection=z.object({responseVersion:z.coerce.number().int().min(1).max(2147483647)}).strict(),history=selection.extend({limit:z.coerce.number().int().min(1).max(10).default(5),afterVersion:z.coerce.number().int().min(0).max(2147483647).default(0)}).strict(),empty=z.object({}).strict();
type Source={responseId:string;responseVersion:number;pollId:string;formVersion:number;studentId:string;classId:string;hubId:string;on:string;createdBy:string;lastActor:string;state:string};
type Moderation={id:string;response_id:string;response_version:number;version:number;excluded:boolean;source:Source;[key:string]:unknown};
function target(s:Source):Scope{return {all:false,hubs:[],classes:[{id:s.classId,hubId:s.hubId}],people:[{id:s.studentId,hubId:s.hubId}],recordContext:{classId:s.classId,hubId:s.hubId,studentId:s.studentId}};}
function authority(ctx:ApiContext,s:Source){for(const cap of ['polls.view','poll-responses.view','poll-responses.moderate'] as Capability[])if(!scopeContains(permissionScope(ctx,cap),target(s)))throw new ApiError(404,'NOT_FOUND');}
async function current(ctx:ApiContext,id:string,version:number){return(await ctx.db.query<{record:Moderation}>('SELECT to_jsonb(m) record FROM public.poll_response_moderation m WHERE response_id=$1 AND response_version=$2',[id,version])).rows[0]?.record??null;}
async function source(ctx:ApiContext,id:string,version:number){const s=(await ctx.db.query<{source:Source|null}>('SELECT public.poll_moderation_source($1,$2) source',[id,version])).rows[0].source;if(!s)throw new ApiError(404,'NOT_FOUND');authority(ctx,s);return s;}
export const pollModerationActions:ApprovalRegistry={'poll-response.moderate':{
 requestCapability:'poll-responses.moderate',privacyCapability:'poll-responses.moderate',policyChange:true,
 async validate(ctx,_id,raw){await lockAcademyTopology(ctx);const i=payload.parse(raw),s=await source(ctx,i.responseId,i.responseVersion);return target(s);},
 async dependencies(ctx,id,raw,purpose){try{const i=payload.parse(raw),s=await source(ctx,i.responseId,i.responseVersion),before=await current(ctx,i.responseId,i.responseVersion);if((before?.version??0)!==i.expectedVersion||before&&before.id!==id)throw new ApiError(409,'TARGET_CHANGED');if(!before&&!i.excluded)throw new ApiError(409,'POLL_MODERATION_INITIAL_EXCLUSION_REQUIRED');return {record:before,source:s};}catch(error){if(purpose==='review'&&error instanceof ApiError&&[403,404,409].includes(error.status))return {unavailable:error.code};throw error;}},
 async authorizeReviewer(ctx,p){if(await master(ctx))return;const s=(p.review_context as unknown as {source:Source}).source;authority(ctx,s);if([s.studentId,s.createdBy,s.lastActor].includes(ctx.credential.person_id)||(await ctx.db.query('SELECT 1 FROM public.family_relationships WHERE student_id=$1 AND guardian_id=$2',[s.studentId,ctx.credential.person_id])).rows.length)throw new ApiError(403,'BENEFICIARY_REVIEW_FORBIDDEN');},
 async apply(ctx,p){if(ctx.credential.kind!=='human')throw new ApiError(403,'HUMAN_REVIEW_REQUIRED');const i=payload.parse(p.payload),basis=p.review_context as unknown as {record:Moderation|null;source:Source};
  try{if(basis.record)await ctx.db.query('UPDATE public.poll_response_moderation SET version=version+1,excluded=$2,requested_by=$3,changed_by=$4,approval_id=$5,reason=$6 WHERE id=$1',[p.target_id,i.excluded,p.requester_id,ctx.credential.person_id,p.id,i.reason]);
   else await ctx.db.query('INSERT INTO public.poll_response_moderation(academy_id,id,response_id,response_version,excluded,source,requested_by,changed_by,approval_id,reason) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10)',[ctx.credential.academy_id,p.target_id,i.responseId,i.responseVersion,i.excluded,JSON.stringify(basis.source),p.requester_id,ctx.credential.person_id,p.id,i.reason]);
  }catch(error){if(error&&typeof error==='object'&&'code'in error&&error.code==='23514'&&'message'in error&&/^POLL_MODERATION_/.test(String(error.message)))throw new ApiError(409,'POLL_MODERATION_SOURCE_CHANGED');throw error;}
  await ctx.db.query('INSERT INTO public.poll_response_moderation_revisions(academy_id,moderation_id,version,definition) SELECT academy_id,id,version,to_jsonb(m) FROM public.poll_response_moderation m WHERE id=$1',[p.target_id]);const r=(await current(ctx,i.responseId,i.responseVersion))!;await record(ctx.db,ctx.credential,ctx.requestId,p.action,p.target_id,basis.source.hubId,{version:r.version,responseVersion:i.responseVersion,excluded:r.excluded,severity:'critical',hasReason:true,externalDeliveryVerified:false});return r;
 }
}};
export async function pollResponseModeration(ctx:ApiContext,registry:ApprovalRegistry=pollModerationActions):Promise<Reply|null>{
 const match=/^poll-responses\/([^/]+)\/moderation(?:\/(history))?$/.exec(ctx.path);if(!match)return null;const id=uuid.parse(match[1]),params=Object.fromEntries(new URL(ctx.request.url).searchParams);
 if(ctx.request.method==='POST'&&!match[2]){empty.parse(params);const i=input.parse(await jsonBody(ctx.request));await source(ctx,id,i.responseVersion);const before=await current(ctx,id,i.responseVersion);return propose(ctx,registry,'poll-response.moderate',before?.id??null,i.expectedVersion,{...i,responseId:id});}
 if(ctx.request.method!=='GET')throw new ApiError(405,'METHOD_NOT_ALLOWED');await lockApprovalWrites(ctx);const q=match[2]?history.parse(params):selection.parse(params),r=await current(ctx,id,q.responseVersion);if(!r)throw new ApiError(404,'NOT_FOUND');authority(ctx,r.source);
 if(match[2]){const h=q as z.infer<typeof history>,rows=(await ctx.db.query<{version:number;definition:Moderation}>('SELECT version,definition FROM public.poll_response_moderation_revisions WHERE moderation_id=$1 AND version>$2 ORDER BY version LIMIT $3',[r.id,h.afterVersion,h.limit+1])).rows;return {status:200,body:{data:rows.slice(0,h.limit),nextVersion:rows.length>h.limit?rows[h.limit-1].version:null}};}
 return {status:200,body:{data:r}};
}
export const pollModerationContract=[
 {path:'/api/v1/poll-responses/{id}/moderation',method:'post',summary:'Upper-human reviewed inclusion/exclusion of one exact submitted response revision; cannot alter answers or restore respondent-withdrawn votes',schema:input},
 {path:'/api/v1/poll-responses/{id}/moderation',method:'get',summary:'Private exact-response-version moderation decision with current source-scoped authority',querySchema:selection},
 {path:'/api/v1/poll-responses/{id}/moderation/history',method:'get',summary:'Private immutable moderation revision history; no separate copy of respondent answers',querySchema:history}
] as const;
