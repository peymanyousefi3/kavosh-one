import { z } from 'zod';
import { record,type ApiContext,type Reply } from '../core/api.ts';
import { permissionScope } from '../core/approvals.ts';
import { assertSchemaReady } from '../core/database.ts';
import { ApiError,scopeContains } from '../core/policy.ts';

const id=z.string().uuid().transform(v=>v.toLowerCase());
const paging=z.object({limit:z.coerce.number().int().min(1).max(100).default(50),afterRequestedAt:z.iso.datetime({offset:true}).optional(),afterId:id.optional()}).strict().refine(v=>(v.afterRequestedAt===undefined)===(v.afterId===undefined));
const flags={scope:'own_academy_platform_subscription',tuitionIncluded:false,referencePriceOnly:true,paymentVerified:false,externalBillingVerified:false};
export async function academySubscription(ctx:ApiContext):Promise<Reply|null>{
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
 {path:'/api/v1/academy/subscription',method:'get',capability:'academy-subscription.view',summary:'Own academy only,whole-academy permission required: pinned reference plan,exact minor units,access state and latest cancellation; not tuition,an invoice,payment proof or platform-wide access'},
 {path:'/api/v1/academy/subscription/cancellations',method:'get',capability:'academy-subscription.view',summary:'Own academy cancellation history with native stable time/id pagination; no platform notes,actor sessions or other school data',querySchema:paging},
 {path:'/api/v1/academy/subscription/cancellations/{id}',method:'get',capability:'academy-subscription.view',summary:'One own-school cancellation case,including its original waiting clock and recorded outcome; not authority to confirm or delete'}
] as const;
