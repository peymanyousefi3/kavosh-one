import { z } from 'zod';
import { isDeepStrictEqual } from 'node:util';
import { jsonBody,record,type ApiContext,type Reply } from '../core/api.ts';
import { assertSchemaReady } from '../core/database.ts';
import { permissionScope,lockApprovalWrites,propose,type ApprovalRegistry,type Proposal } from '../core/approvals.ts';
import { ApiError,scopeContains } from '../core/policy.ts';

const definition=z.object({enabled:z.boolean(),maxDailyEmailRequests:z.number().int().min(0).max(100000),maxDailySmsRequests:z.number().int().min(0).max(100000),maxHourlyRequestsPerRecipient:z.number().int().min(0).max(1000)}).strict();
const input=z.object({expectedVersion:z.number().int().min(0).max(2147483646),definition,reason:z.string().trim().min(1).max(2000).refine(v=>v.isWellFormed()&&!/[\p{Cc}]/u.test(v))}).strict();
const history=z.object({limit:z.coerce.number().int().min(1).max(50).default(10),afterVersion:z.coerce.number().int().min(0).max(2147483647).default(0)}).strict();
const school={all:true,hubs:[]};
type Basis={id:string|null;version:number;definition:z.infer<typeof definition>|null};
function authorize(ctx:ApiContext,edit=false){for(const cap of edit?['delivery-policy.view','delivery-policy.edit'] as const:['delivery-policy.view'] as const)if(!scopeContains(permissionScope(ctx,cap),school))throw new ApiError(403,'SCHOOL_WIDE_DELIVERY_POLICY_REQUIRED');}
async function basis(ctx:ApiContext){return (await ctx.db.query<{data:Basis}>('SELECT public.operational_send_policy_basis() data')).rows[0].data;}
async function current(ctx:ApiContext,id:string,raw:unknown){authorize(ctx,true);const i=input.parse(raw),b=await basis(ctx);if(b.version!==i.expectedVersion||(b.id!==null&&b.id!==id))throw new ApiError(409,'DELIVERY_POLICY_CHANGED');return b;}
async function apply(ctx:ApiContext,p:Proposal){
 if(ctx.credential.kind!=='human')throw new ApiError(403,'HUMAN_REVIEW_REQUIRED');const i=input.parse(p.payload),b=await current(ctx,p.target_id,i);if(!isDeepStrictEqual(b,p.review_context))throw new ApiError(409,'DELIVERY_POLICY_CHANGED');const version=b.version+1;
 await ctx.db.query('INSERT INTO public.operational_send_policy_revisions(academy_id,policy_id,version,definition,source_basis,changed_by,approval_id,reason) VALUES($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7,$8)',[ctx.credential.academy_id,p.target_id,version,JSON.stringify(i.definition),JSON.stringify(b),ctx.credential.person_id,p.id,i.reason]);
 if(b.version===0)await ctx.db.query('INSERT INTO public.operational_send_policies VALUES($1,$2,$3)',[ctx.credential.academy_id,p.target_id,version]);
 else if(!(await ctx.db.query('UPDATE public.operational_send_policies SET version=$3 WHERE academy_id=$1 AND id=$2 AND version=$4 RETURNING id',[ctx.credential.academy_id,p.target_id,version,b.version])).rows.length)throw new ApiError(409,'DELIVERY_POLICY_CHANGED');
 await record(ctx.db,ctx.credential,ctx.requestId,'notification.delivery-policy.change',p.target_id,null,{version,approvalId:p.id,severity:'critical',hasReason:true,operationalOnly:true});return {id:p.target_id,version,definition:i.definition,changesExternalProviderSettings:false};
}
export const deliveryPolicyActions:ApprovalRegistry={'notification.delivery-policy.change':{requestCapability:'delivery-policy.edit',privacyCapability:'delivery-policy.view',policyChange:true,
 async validate(ctx,id,raw){await current(ctx,id,raw);return school;},async dependencies(ctx,id,raw,purpose){try{return await current(ctx,id,raw);}catch(e){if(purpose==='review'&&e instanceof ApiError&&[403,404,409].includes(e.status))return {unavailable:e.code};throw e;}},apply}};
export async function deliveryPolicy(ctx:ApiContext,registry:ApprovalRegistry=deliveryPolicyActions):Promise<Reply|null>{
 const m=/^automations\/delivery-policy(?:\/(history|usage))?$/.exec(ctx.path);if(!m)return null;await assertSchemaReady(ctx.db);
 const params=new URL(ctx.request.url).searchParams;if([...params].length!==new Set(params.keys()).size)throw new ApiError(400,'DUPLICATE_QUERY');
 if(ctx.request.method==='POST'){if(m[1])throw new ApiError(405,'METHOD_NOT_ALLOWED');z.object({}).strict().parse(Object.fromEntries(params));const i=input.parse(await jsonBody(ctx.request));await lockApprovalWrites(ctx,true);authorize(ctx,true);const b=await basis(ctx);return propose(ctx,registry,'notification.delivery-policy.change',b.id,i.expectedVersion,i);}
 if(ctx.request.method!=='GET')throw new ApiError(405,'METHOD_NOT_ALLOWED');await lockApprovalWrites(ctx);authorize(ctx,m[1]==='history');
 const flags={operationalOnly:true,providerDeliveryVerified:false,requestsAreNotCarrierSegments:true,chargesCalculated:false,recipientDetailsIncluded:false,defaultWithoutPolicy:'off',window:'UTC_day_and_rolling_hour',reservationsRefundedOnFailure:false,alreadyInFlightMessagesMayStillArrive:true};
 if(m[1]==='history'){const q=history.parse(Object.fromEntries(params)),rows=(await ctx.db.query<{version:number}>('SELECT version,definition,changed_by "changedBy",approval_id "approvalId",reason,created_at "createdAt" FROM public.operational_send_policy_revisions WHERE version>$1 ORDER BY version LIMIT $2',[q.afterVersion,q.limit+1])).rows;return {status:200,body:{data:rows.slice(0,q.limit),nextVersion:rows.length>q.limit?rows[q.limit-1].version:null,...flags}};}
 z.object({}).strict().parse(Object.fromEntries(params));if(m[1]==='usage')return {status:200,body:{data:(await ctx.db.query<{data:unknown}>('SELECT public.operational_send_usage() data')).rows[0].data,...flags}};
 return {status:200,body:{data:await basis(ctx),...flags}};
}
export const deliveryPolicyContract=[
 {path:'/api/v1/automations/delivery-policy',method:'get',summary:'School-wide operational sending policy;missing policy means OFF. Independent full-school delivery-policy.view required,not ordinary automation or delivery-monitor access.'},
 {path:'/api/v1/automations/delivery-policy',method:'post',summary:'Propose reviewed operational email/SMS request caps and a combined per-recipient rolling-hour cap. Master self-approval or upper human review;bots only propose. Requires the current expectedVersion;obsolete inputs409 even with an old key,with original history preserved. No provider credentials,carrier cost guarantee or send from this request.',schema:input},
 {path:'/api/v1/automations/delivery-policy/history',method:'get',summary:'Bounded immutable policy editions and review reasons under full-school policy view/edit rights;no recipients,contacts or provider secrets.',querySchema:history},
 {path:'/api/v1/automations/delivery-policy/usage',method:'get',summary:'Current academy UTC-day handoff reservation counts as exact integer strings. Includes uncertain/rejected attempts and preserved historical sending-state reservations,not carrier segments,billed costs or delivered messages.'}
] as const;
