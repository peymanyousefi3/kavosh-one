import { z } from 'zod';
import { jsonBody,record,type ApiContext,type Reply } from '../core/api.ts';
import { master,permissionScope,propose,type ApprovalRegistry } from '../core/approvals.ts';
import { assertSchemaReady } from '../core/database.ts';
import { ApiError,scopeContains } from '../core/policy.ts';

const id=z.string().uuid().transform(v=>v.toLowerCase());
const paging=z.object({limit:z.coerce.number().int().min(1).max(100).default(50),afterRequestedAt:z.iso.datetime({offset:true}).optional(),afterId:id.optional()}).strict().refine(v=>(v.afterRequestedAt===undefined)===(v.afterId===undefined));
const flags={scope:'own_academy_platform_subscription',tuitionIncluded:false,referencePriceOnly:true,paymentVerified:false,externalBillingVerified:false};
const cancellationInput=z.object({expectedVersion:z.number().int().min(0).max(2147483647),reason:z.string().trim().min(1).max(2000).refine(v=>v.isWellFormed()&&!v.includes('\0'))}).strict();
const withdrawalInput=cancellationInput.extend({expectedVersion:z.literal(1)});
function requestScope(ctx:ApiContext){
 const all={all:true,hubs:[]};if(!scopeContains(permissionScope(ctx,'academy-subscription.view'),all)||!scopeContains(permissionScope(ctx,'academy-subscription.request'),all))throw new ApiError(403,'FORBIDDEN');return all;
}
async function cancellationBasis(ctx:ApiContext,target:string,raw:unknown,withdraw:boolean){
 const input=(withdraw?withdrawalInput:cancellationInput).parse(raw);requestScope(ctx);await assertSchemaReady(ctx.db);
 if(withdraw){const data=(await ctx.db.query<{data:{version:number;status:string}}>('SELECT data FROM public.academy_subscription_cancellations WHERE academy_id=$1 AND id=$2',[ctx.credential.academy_id,target])).rows[0]?.data;if(!data)throw new ApiError(404,'NOT_FOUND');if(data.version!==1||data.status!=='pending')throw new ApiError(409,'CANCELLATION_CHANGED');return {case:data};}
 const source=(await ctx.db.query<{version:number;latestCancellation:{status:string}|null}>('SELECT version,latest_cancellation "latestCancellation" FROM public.academy_subscription_status WHERE academy_id=$1',[ctx.credential.academy_id])).rows[0];
 if(!source)throw new ApiError(404,'NOT_FOUND');if(source.version!==input.expectedVersion)throw new ApiError(409,'SUBSCRIPTION_CHANGED');if(source.latestCancellation?.status==='pending')throw new ApiError(409,'CANCELLATION_ALREADY_PENDING');return {subscriptionVersion:source.version};
}
export const academySubscriptionActions:ApprovalRegistry=Object.fromEntries(['academy.subscription.cancel-request','academy.subscription.cancel-withdraw'].map(action=>[action,{
 requestCapability:'academy-subscription.request',privacyCapability:'academy-subscription.view',createdStatus:200,
 async authorizeReviewer(ctx:ApiContext){if(!await master(ctx))throw new ApiError(403,'SCHOOL_MASTER_REVIEW_REQUIRED');},
 async validate(ctx:ApiContext,_target:string,raw:unknown){(action.endsWith('cancel-withdraw')?withdrawalInput:cancellationInput).parse(raw);await assertSchemaReady(ctx.db);return requestScope(ctx);},
 async dependencies(ctx:ApiContext,target:string,raw:unknown,purpose:'request'|'review'){try{return await cancellationBasis(ctx,target,raw,action.endsWith('cancel-withdraw'));}catch(error){if(purpose==='review'&&error instanceof ApiError&&[403,404,409].includes(error.status))return{unavailable:error.code};throw error;}},
 async apply(ctx:ApiContext,p:import('../core/approvals.ts').Proposal){
  if(!await master(ctx))throw new ApiError(403,'SCHOOL_MASTER_REVIEW_REQUIRED');
  let data:unknown;try{data=(await ctx.db.query<{data:unknown}>('SELECT public.apply_school_cancellation($1,$2,$3) data',[p.id,ctx.credential.person_id,ctx.credential.token_id])).rows[0]?.data;}catch(error){if(error&&typeof error==='object'&&'code'in error&&error.code==='23514'&&'message'in error&&['PLATFORM_CANCELLATION_ALREADY_PENDING','PLATFORM_CANCELLATION_ALREADY_DECIDED','PLATFORM_SUBSCRIPTION_VERSION_CHANGED'].includes(String(error.message)))throw new ApiError(409,String(error.message));throw error;}if(!data)throw new Error('SCHOOL_CANCELLATION_EFFECTS_MISSING');
  await record(ctx.db,ctx.credential,ctx.requestId,p.action,p.target_id,null,{approvalId:p.id,severity:'critical',schoolAccessChanged:false});return data;
 }
}])) as ApprovalRegistry;
export async function academySubscription(ctx:ApiContext):Promise<Reply|null>{
 const mutation=/^academy\/subscription\/cancellations(?:\/([a-f0-9-]{36})\/(withdraw))?$/.exec(ctx.path);
 if(mutation&&ctx.request.method==='POST'){
  z.object({}).strict().parse(Object.fromEntries(new URL(ctx.request.url).searchParams));const target=mutation[1]?id.parse(mutation[1]):null,input=(target?withdrawalInput:cancellationInput).parse(await jsonBody(ctx.request));
  return propose(ctx,academySubscriptionActions,target?'academy.subscription.cancel-withdraw':'academy.subscription.cancel-request',target,target?1:0,input);
 }
 const match=/^academy\/subscription(?:\/(cancellations)(?:\/([a-f0-9-]{36}))?)?$/.exec(ctx.path);if(!match)return null;
 if(ctx.request.method!=='GET')throw new ApiError(405,'METHOD_NOT_ALLOWED');
 if(!scopeContains(permissionScope(ctx,'academy-subscription.view'),{all:true,hubs:[]}))throw new ApiError(403,'FORBIDDEN');
 const params=new URL(ctx.request.url).searchParams;if([...params].length!==new Set(params.keys()).size)throw new ApiError(400,'DUPLICATE_QUERY');
 const cancellationId=match[2]?id.parse(match[2]):null,query=match[1]&&!cancellationId?paging.parse(Object.fromEntries(params)):(z.object({}).strict().parse(Object.fromEntries(params)),null);
 await assertSchemaReady(ctx.db);
 if(!match[1]){
  const data=(await ctx.db.query('SELECT academy_id "academyId",version,operational_status "operationalStatus",effective_status "effectiveStatus",subscription_state "subscriptionState",terms,plan_reference "planReference",permanent_free "permanentFree",latest_cancellation "latestCancellation" FROM public.academy_subscription_status WHERE academy_id=$1',[ctx.credential.academy_id])).rows[0];if(!data)throw new ApiError(404,'NOT_FOUND');
  await record(ctx.db,ctx.credential,ctx.requestId,'academy.subscription.read',ctx.credential.academy_id,null,{kind:'summary'});return{status:200,body:{data,...flags}};
 }
 if(cancellationId){
  const data=(await ctx.db.query<{data:unknown}>('SELECT data FROM public.academy_subscription_cancellations WHERE academy_id=$1 AND id=$2',[ctx.credential.academy_id,cancellationId])).rows[0]?.data;if(!data)throw new ApiError(404,'NOT_FOUND');
  await record(ctx.db,ctx.credential,ctx.requestId,'academy.subscription.read',ctx.credential.academy_id,null,{kind:'cancellation',cancellationId});return{status:200,body:{data,...flags}};
 }
 const rows=(await ctx.db.query<{id:string;requestedAt:string;data:unknown}>(`SELECT id,to_char(requested_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') "requestedAt",data FROM public.academy_subscription_cancellations WHERE academy_id=$1 AND($2::timestamptz IS NULL OR(requested_at,id)<($2::timestamptz,$3::uuid)) ORDER BY requested_at DESC,id DESC LIMIT $4`,[ctx.credential.academy_id,query!.afterRequestedAt??null,query!.afterId??null,query!.limit+1])).rows,tail=rows[query!.limit-1];
 await record(ctx.db,ctx.credential,ctx.requestId,'academy.subscription.read',ctx.credential.academy_id,null,{kind:'cancellations',rows:Math.min(rows.length,query!.limit)});return{status:200,body:{data:rows.slice(0,query!.limit).map(r=>r.data),nextCursor:rows.length>query!.limit?{afterRequestedAt:tail.requestedAt,afterId:tail.id}:null,...flags}};
}
export const academySubscriptionContract=[
 {path:'/api/v1/academy/subscription/cancellations',method:'post',capability:'academy-subscription.request',summary:'Own academy whole-school request; staff and bots prepare an approval,only its human school master applies it. The native30-day clock starts on approval. No access change,charge,provider cancellation or deletion; platform owner must confirm later.',schema:cancellationInput},
 {path:'/api/v1/academy/subscription/cancellations/{id}/withdraw',method:'post',capability:'academy-subscription.request',summary:'School-master-reviewed withdrawal of a pending own-school cancellation; cannot undo a confirmed case. Remains available in read-only mode; no licence renewal or payment effect.',schema:withdrawalInput},
 {path:'/api/v1/academy/subscription',method:'get',capability:'academy-subscription.view',summary:'Own academy only,whole-academy permission required: pinned reference plan,exact minor units,access state and latest cancellation; not tuition,an invoice,payment proof or platform-wide access'},
 {path:'/api/v1/academy/subscription/cancellations',method:'get',capability:'academy-subscription.view',summary:'Own academy cancellation history with native stable time/id pagination; no platform notes,actor sessions or other school data',querySchema:paging},
 {path:'/api/v1/academy/subscription/cancellations/{id}',method:'get',capability:'academy-subscription.view',summary:'One own-school cancellation case,including its original waiting clock and recorded outcome; not authority to confirm or delete'}
] as const;
