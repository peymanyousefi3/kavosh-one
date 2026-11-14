import {z} from 'zod';
import {jsonBody,mutation,record,type ApiContext,type Reply} from '../core/api.ts';
import {permissionScope,propose,type ApprovalRegistry,type Proposal} from '../core/approvals.ts';
import {ApiError,requireScope} from '../core/policy.ts';
import {lockAcademyTopology} from './academy.ts';

export const storageCapacityDefinition=z.object({enabled:z.boolean().default(true),warningPercent:z.number().int().min(1).max(99).default(80),criticalPercent:z.number().int().min(2).max(100).default(95)}).strict().refine(v=>v.criticalPercent>v.warningPercent,'Critical must be above warning.');
const input=z.object({expectedVersion:z.number().int().min(0).max(2147483646),definition:storageCapacityDefinition,reason:z.string().trim().min(1).max(2000).refine(v=>v.isWellFormed()&&!/[\u0000-\u001f\u007f-\u009f]/.test(v))}).strict();
const history=z.object({afterVersion:z.coerce.number().int().min(0).max(2147483647).default(0),limit:z.coerce.number().int().min(1).max(50).default(20)}).strict(),empty=z.object({}).strict();
function authority(ctx:ApiContext,edit=false){requireScope(permissionScope(ctx,'storage.view'));if(edit)requireScope(permissionScope(ctx,'storage.edit'));}
async function lock(ctx:ApiContext){await lockAcademyTopology(ctx);await ctx.db.query('SELECT academy_id FROM public.file_storage_policies WHERE academy_id=$1 FOR UPDATE',[ctx.credential.academy_id]);await ctx.db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,427))',[ctx.credential.academy_id]);}
async function basis(ctx:ApiContext,v:number){return(await ctx.db.query<{data:{version:number;definition:unknown;quotaPolicyVersion:number}}>('SELECT public.storage_capacity_policy_basis($1) data',[v])).rows[0].data;}
async function checked(ctx:ApiContext,raw:unknown){const i=input.parse(raw);authority(ctx,true);await lock(ctx);const current=(await ctx.db.query<{version:number}>('SELECT version FROM public.storage_capacity_policies WHERE academy_id=$1',[ctx.credential.academy_id])).rows[0]?.version??0;if(current!==i.expectedVersion)throw new ApiError(409,'TARGET_CHANGED');return basis(ctx,current);}
export const storageCapacityActions:ApprovalRegistry={'storage.capacity-alerts.set':{requestCapability:'storage.edit',privacyCapability:'storage.view',policyChange:true,
 async validate(ctx,_id,raw){authority(ctx,true);input.parse(raw);await lock(ctx);return {all:true,hubs:[]};},
 async dependencies(ctx,_id,raw,purpose){try{return await checked(ctx,raw);}catch(e){if(purpose==='review'&&e instanceof ApiError&&[403,404,409].includes(e.status))return{unavailable:e.code};throw e;}},
 async apply(ctx,p:Proposal){if(ctx.credential.kind!=='human')throw new ApiError(403,'HUMAN_REVIEW_REQUIRED');const i=input.parse(p.payload);await checked(ctx,i);
  if(i.expectedVersion===0)await ctx.db.query('INSERT INTO public.storage_capacity_policies(academy_id) VALUES($1)',[ctx.credential.academy_id]);else await ctx.db.query('UPDATE public.storage_capacity_policies SET version=version+1 WHERE academy_id=$1',[ctx.credential.academy_id]);
  await ctx.db.query('INSERT INTO public.storage_capacity_policy_revisions(academy_id,version,definition,changed_by,approval_id,reason) VALUES($1,$2,$3::jsonb,$4,$5,$6)',[ctx.credential.academy_id,i.expectedVersion+1,JSON.stringify(i.definition),ctx.credential.person_id,p.id,i.reason]);
  await record(ctx.db,ctx.credential,ctx.requestId,'storage.capacity-alerts.changed',ctx.credential.academy_id,null,{approvalId:p.id,version:i.expectedVersion+1,severity:'critical'});return status(ctx);
 }
}};
async function status(ctx:ApiContext){return(await ctx.db.query<{data:unknown}>('SELECT public.storage_capacity_status() data')).rows[0].data;}
export async function storageCapacity(ctx:ApiContext,registry:ApprovalRegistry=storageCapacityActions):Promise<Reply|null>{
 const m=/^storage-policy\/capacity-alerts(?:\/(history|observations|check))?$/.exec(ctx.path);if(!m)return null;authority(ctx);const params=new URL(ctx.request.url).searchParams;if([...params].length!==new Set(params.keys()).size)throw new ApiError(400,'DUPLICATE_QUERY');
 if(m[1]==='check'){if(ctx.request.method!=='POST')throw new ApiError(405,'METHOD_NOT_ALLOWED');empty.parse(Object.fromEntries(params));empty.parse(await jsonBody(ctx.request,1024));await lock(ctx);return mutation(ctx,{},async()=>{await record(ctx.db,ctx.credential,ctx.requestId,'file.storage.capacity.checked',ctx.credential.academy_id,null,{manualCheck:true,physicalStorageVerified:false});return{status:200,body:{data:await status(ctx)}};});}
 if(ctx.request.method==='POST'&&!m[1]){empty.parse(Object.fromEntries(params));const i=input.parse(await jsonBody(ctx.request,8192));return propose(ctx,registry,'storage.capacity-alerts.set',ctx.credential.academy_id,i.expectedVersion,i);}
 if(ctx.request.method!=='GET')throw new ApiError(405,'METHOD_NOT_ALLOWED');if(!m[1]){empty.parse(Object.fromEntries(params));return{status:200,body:{data:await status(ctx)}};}
 const q=history.parse(Object.fromEntries(params)),observations=m[1]==='observations',rows=(await ctx.db.query<{version:number}>('SELECT '+(observations?'version,snapshot,event_id AS "eventId",created_at AS "recordedAt"':'version,definition,changed_by AS "changedBy",approval_id AS "approvalId",reason,created_at AS "recordedAt"')+' FROM public.'+(observations?'storage_capacity_observations':'storage_capacity_policy_revisions')+' WHERE academy_id=$1 AND version>$2 ORDER BY version LIMIT $3',[ctx.credential.academy_id,q.afterVersion,q.limit+1])).rows;
 return{status:200,body:{data:rows.slice(0,q.limit),nextVersion:rows.length>q.limit?rows[q.limit-1].version:null,usageBasis:'reserved_claims',physicalStorageVerified:false}};
}
export const storageCapacityContract=[
 {path:'/api/v1/storage-policy/capacity-alerts/check',method:'post',summary:'Authorized whole-school human/bot requests a real audited current capacity check,including after import or recovery. Coalesces unchanged levels;never backfills historical activity,changes quotas,purchases storage or deletes files.',schema:empty},
 {path:'/api/v1/storage-policy/capacity-alerts',method:'get',summary:'Whole-school current reserved-byte/file budget status with exact decimal usage,reviewed or explicitly labelled80/95percent default alert thresholds. Not measured R2 usage,billing,physical disposal or automatic storage purchase.'},
 {path:'/api/v1/storage-policy/capacity-alerts',method:'post',summary:'Upper-human-reviewed configurable capacity warnings,critical threshold or disabling. Master may self-approve;bots can propose only. Changes and history are immutable;uploads/quotas are not silently enabled or expanded.',schema:input},
 {path:'/api/v1/storage-policy/capacity-alerts/history',method:'get',summary:'Whole-school immutable reviewed alert configuration editions;unconfigured defaults are not fabricated historical approvals',querySchema:history},
 {path:'/api/v1/storage-policy/capacity-alerts/observations',method:'get',summary:'Bounded immutable native threshold-crossing,recovery and disabling observations;each source follows a real audited reservation/link/quota/configuration change. No repeated alerts while a level persists,no fake physical storage measurement.',querySchema:history}
] as const;
