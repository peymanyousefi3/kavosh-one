import { z } from 'zod';
import { jsonBody,record,type ApiContext,type Reply } from '../core/api.ts';
import { ApiError,requireScope,scopeContains,type Scope } from '../core/policy.ts';
import { lockApprovalWrites,master,permissionScope,propose,type ApprovalRegistry,type Proposal } from '../core/approvals.ts';
import { canManage,assignments,assignedScope } from './administration.ts';

const uuid=z.string().uuid().transform(v=>v.toLowerCase());
const change=z.object({expectedVersion:z.number().int().positive().max(2147483646),enabled:z.boolean(),reason:z.string().trim().min(1).max(2000).refine(s=>s.isWellFormed()&&!/[\u0000-\u001f\u007f]/.test(s))}).strict();
const paging=z.object({afterVersion:z.coerce.number().int().min(0).max(2147483647).default(0),limit:z.coerce.number().int().min(1).max(50).default(20)}).strict();
type Person={id:string;kind:string;status:string;hub_id:string|null;access_version:number;identity_bound:boolean;credentials_valid_after:string|null};
async function authority(ctx:ApiContext,id:string,edit=false):Promise<Scope>{
 const p=(await ctx.db.query<Person>('SELECT id,kind,status,hub_id,access_version,auth_user_id IS NOT NULL identity_bound,credentials_valid_after::text FROM public.people WHERE id=$1',[id])).rows[0];if(!p)throw new ApiError(404,'NOT_FOUND');
 const cap=edit?'access.edit':'access.view',s=permissionScope(ctx,cap);requireScope(s,p.hub_id??undefined);
 if(edit){await canManage(ctx,id);if(id===ctx.credential.person_id)throw new ApiError(403,'SELF_STATUS_CHANGE_FORBIDDEN');if((await ctx.db.query('SELECT 1 FROM public.academies WHERE master_person_id=$1',[id])).rows.length)throw new ApiError(403,'MASTER_STATUS_PROTECTED');}
 else if(!await master(ctx)&&!(await ctx.db.query<{ok:boolean}>('SELECT public.is_supervisor($1,$2) ok',[ctx.credential.person_id,id])).rows[0]?.ok)throw new ApiError(403,'SUPERVISOR_REQUIRED');
 const scopes=(await assignments(ctx,id)).map(assignedScope);for(const scope of scopes)if(!scopeContains(s,scope))throw new ApiError(403,'STATUS_CHANGE_EXCEEDS_SCOPE');
 const all=p.hub_id===null||scopes.some(s=>s.all);return {all,hubs:all?[]:[...new Set([p.hub_id!,...scopes.flatMap(s=>s.hubs)])],...!all&&scopes.some(s=>s.classes?.length)?{classes:scopes.flatMap(s=>s.classes??[])}:{},...!all&&scopes.some(s=>s.people?.length)?{people:scopes.flatMap(s=>s.people??[])}:{},...!all&&scopes.some(s=>s.areas?.length)?{areas:scopes.flatMap(s=>s.areas??[])}:{}};
}
async function basis(ctx:ApiContext,id:string){const b=(await ctx.db.query<{b:Record<string,unknown>}>('SELECT public.person_status_basis($1) b',[id])).rows[0]?.b;if(!b)throw new ApiError(404,'NOT_FOUND');return b;}
async function apply(ctx:ApiContext,p:Proposal){
 if(ctx.credential.kind!=='human')throw new ApiError(403,'HUMAN_REVIEW_REQUIRED');const i=change.parse(p.payload);await authority(ctx,p.target_id,true);
 // Never wait on an actor row while holding the exclusive policy gate: an
 // in-flight request may hold that row and itself need the policy gate.
 let person:Person|undefined;try{person=(await ctx.db.query<Person>('SELECT id,kind,status,hub_id,access_version,auth_user_id IS NOT NULL identity_bound,credentials_valid_after::text FROM public.people WHERE id=$1 FOR UPDATE NOWAIT',[p.target_id])).rows[0];}catch(e){if(e&&typeof e==='object'&&'code' in e&&e.code==='55P03')throw new ApiError(423,'PERSON_BUSY_RETRY');throw e;}
 if(!person||person.access_version!==i.expectedVersion||p.target_version!==i.expectedVersion)throw new ApiError(409,'PERSON_STATUS_VERSION_CHANGED');
 const next=i.enabled?(person.kind==='bot'||person.identity_bound?'active':'pending'):'disabled';if((i.enabled&&person.status!=='disabled')||person.status===next)throw new ApiError(409,'PERSON_STATUS_TRANSITION_UNAVAILABLE');
 await ctx.db.query('INSERT INTO public.person_status_changes(academy_id,person_id,version,before_status,after_status,source_snapshot,changed_by,approval_id) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8)',[ctx.credential.academy_id,p.target_id,i.expectedVersion+1,person.status,next,JSON.stringify(p.review_context),ctx.credential.person_id,p.id]);
 await ctx.db.query('UPDATE public.people SET status=$2,access_version=access_version+1 WHERE id=$1 AND access_version=$3',[p.target_id,next,i.expectedVersion]);
 const result={personId:p.target_id,version:i.expectedVersion+1,status:next,schoolLocal:true,oldCredentialsRevived:false,identityVerificationBypassed:false,financialHistoryRetained:true};await record(ctx.db,ctx.credential,ctx.requestId,'person.status',p.target_id,person.hub_id,{before:{status:person.status},after:{status:next},version:result.version,approvalId:p.id,severity:'critical',financialHistoryRetained:true});return result;
}
export const personStatusActions:ApprovalRegistry={'person.status':{requestCapability:'access.edit',privacyCapability:'access.view',policyChange:true,
 async validate(ctx,id,raw){change.parse(raw);return authority(ctx,id,true);},async dependencies(ctx,id){return basis(ctx,id);},apply}};
export async function personStatus(ctx:ApiContext,registry:ApprovalRegistry=personStatusActions):Promise<Reply|null>{
 const m=/^people\/([^/]+)\/status(?:\/(history))?$/.exec(ctx.path);if(!m)return null;const id=uuid.parse(m[1]),params=new URL(ctx.request.url).searchParams;if([...params].length!==new Set(params.keys()).size)throw new ApiError(400,'DUPLICATE_QUERY');
 if(ctx.request.method==='POST'&&!m[2]){await lockApprovalWrites(ctx,true);const i=change.parse(await jsonBody(ctx.request));return propose(ctx,registry,'person.status',id,i.expectedVersion,i);}
 if(ctx.request.method!=='GET')throw new ApiError(405,'METHOD_NOT_ALLOWED');await lockApprovalWrites(ctx);await authority(ctx,id);
 if(m[2]){const q=paging.parse(Object.fromEntries(params)),rows=(await ctx.db.query<{version:number}>('SELECT version,before_status "beforeStatus",after_status "afterStatus",changed_by "changedBy",approval_id "approvalId",created_at::text "changedAt" FROM public.person_status_changes WHERE person_id=$1 AND version>$2 ORDER BY version LIMIT $3',[id,q.afterVersion,q.limit+1])).rows;return {status:200,body:{data:rows.slice(0,q.limit),nextVersion:rows.length>q.limit?rows[q.limit-1].version:null}};}
 z.object({}).strict().parse(Object.fromEntries(params));const p=(await ctx.db.query<Person>('SELECT id,kind,status,access_version,auth_user_id IS NOT NULL identity_bound,credentials_valid_after::text FROM public.people WHERE id=$1',[id])).rows[0];return {status:200,body:{data:{personId:p.id,kind:p.kind,status:p.status,version:p.access_version,identityBound:p.identity_bound,credentialsValidAfter:p.credentials_valid_after,schoolLocal:true}}};
}
export const personStatusContract=[
 {path:'/api/v1/people/{id}/status',method:'get',summary:'Supervisor-only school-local account status under access.view and the full target assignment scope;no identity secrets.'},
 {path:'/api/v1/people/{id}/status',method:'post',summary:'Propose versioned disabling/reactivation under full subordinate access.edit authority. Upper human review,master self-approval;sole master and self changes protected. Reactivation cannot bypass invitation verification or revive older sessions/bot keys. A busy active request returns423 for safe retry,not a partial status change.',schema:change},
 {path:'/api/v1/people/{id}/status/history',method:'get',summary:'Bounded immutable school-local status/approval metadata under supervisor access.view and full target scope.',querySchema:paging}
] as const;
