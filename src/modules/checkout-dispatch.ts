import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { jsonBody,mutation,record,type ApiContext,type Reply } from '../core/api.ts';
import { lockApprovalWrites } from '../core/approvals.ts';
import { ApiError } from '../core/policy.ts';
import { lockFinanceBook } from '../core/finance-lock.ts';
import { lockAcademyTopology } from './academy.ts';
import { permittedCheckoutRequest } from './payment-checkouts.ts';
import { financialRecordAuthority } from './tuition.ts';
import { buildStripeCheckout,stripeCheckoutDraft,stripeCheckoutPublicConnection } from '../integrations/stripe-checkout.ts';

const uuid=z.string().uuid().transform(v=>v.toLowerCase()),hash=z.string().regex(/^[a-f0-9]{64}$/),empty=z.object({}).strict(),paging=z.object({limit:z.coerce.number().int().min(1).max(100).default(25),after:uuid.optional()}).strict();
const manifest=z.object({requestSha256:hash,requestBytes:z.number().int().min(1).max(16384)}).strict(),reservation=manifest.extend({sourceFingerprint:hash,expiresAt:z.number().int().positive().max(9_999_999_999)}).strict();
const observation=z.discriminatedUnion('state',[z.object({state:z.enum(['not_attempted','rejected','outcome_unknown'])}).strict(),z.object({state:z.literal('accepted'),sessionId:z.string().regex(/^cs_(test|live)_[A-Za-z0-9]{1,200}$/)}).strict()]);
const flags={providerVerified:false,paymentVerified:false,ledgerAdjusted:false,automaticRetryAllowed:false,dispatchAuthority:false};
type Live={requestId:string;academyId:string;invoiceId:string;connectionId:string;accountId:string;livemode:boolean;apiVersion:'2026-10-28.endive';currencyCode:string;unitScale:number;amountMinor:string;sessionLifetimeMinutes:number;authorizationUntil:string};
type Attempt={id:string;request_id:string;actor_id:string;draft:z.infer<typeof stripeCheckoutDraft>;origin:string;source_fingerprint:string;request_sha256:string;request_bytes:number;created_at:string};
async function allowed(ctx:ApiContext,id:string,execute=false){const r=await permittedCheckoutRequest(ctx,id);if(execute)financialRecordAuthority(ctx,r,'checkouts.execute');return r;}
async function locked(ctx:ApiContext,id:string){await lockApprovalWrites(ctx);const r=await allowed(ctx,id,true);await lockFinanceBook(ctx);await lockAcademyTopology(ctx);await ctx.db.query('SELECT id FROM public.tuition_invoices WHERE id=$1 FOR UPDATE',[r.invoice_id]);await ctx.db.query('SELECT public.lock_payment_checkout_connection($1)',[r.connection_id]);return r;}
async function source(ctx:ApiContext,id:string){const r=(await ctx.db.query<{data:Live|null;fingerprint:string|null}>(`WITH s AS MATERIALIZED(SELECT public.payment_checkout_live_source($1) data) SELECT data,encode(sha256(convert_to(data::text,'UTF8')),'hex') fingerprint FROM s`,[id])).rows[0];if(!r?.data||!r.fingerprint)throw new ApiError(409,'CHECKOUT_DISPATCH_SOURCE_CHANGED');return {data:r.data,fingerprint:r.fingerprint};}
function build(s:Live,expiresAt:number,now=Date.now()){
 const parsed=stripeCheckoutPublicConnection.safeParse({connectionId:s.connectionId,academyId:s.academyId,accountId:s.accountId,livemode:s.livemode,apiVersion:s.apiVersion,origin:process.env.APP_ORIGIN});if(!parsed.success)throw new ApiError(503,'CHECKOUT_RETURN_ORIGIN_NOT_CONFIGURED');
 // Backend return protocol only. No frontend route/visual design or success-
 // page payment evidence. Do not accept caller-controlled callback URLs.
 const base=parsed.data.origin+'/?payment_request='+s.requestId+'&payment_return=';
 return buildStripeCheckout({requestId:s.requestId,academyId:s.academyId,invoiceId:s.invoiceId,connectionId:s.connectionId,accountId:s.accountId,livemode:s.livemode,currencyCode:s.currencyCode,unitScale:s.unitScale,amountMinor:s.amountMinor,expiresAt,successUrl:base+'success',cancelUrl:base+'cancel'},parsed.data,now);
}
async function attempt(ctx:ApiContext,requestId:string,id:string,execute=false){await allowed(ctx,requestId,execute);const a=(await ctx.db.query<Attempt>('SELECT *,created_at::text FROM public.payment_checkout_attempts WHERE id=$1 AND request_id=$2',[id,requestId])).rows[0];if(!a)throw new ApiError(404,'NOT_FOUND');return a;}
async function state(ctx:ApiContext,a:Attempt){const st=(await ctx.db.query<{id:string;actor_id:string;created_at:string}>('SELECT id,actor_id,created_at::text FROM public.payment_checkout_dispatch_starts WHERE attempt_id=$1',[a.id])).rows[0]??null,o=st?(await ctx.db.query('SELECT id,state,provider_session_id,source_current,created_at FROM public.payment_checkout_dispatch_observations WHERE start_id=$1',[st.id])).rows[0]??null:null;return {start:st,observation:o,reconciliationRequired:Boolean(st),state:o?.state??(st?'started_outcome_unrecorded':'reserved_unexecuted')};}
function problem(e:unknown){if(e&&typeof e==='object'&&'code'in e&&(e.code==='23505'||e.code==='23514'&&'message'in e&&String(e.message).startsWith('CHECKOUT_DISPATCH_')))throw new ApiError(409,'CHECKOUT_DISPATCH_CONFLICT');throw e;}
export async function checkoutDispatch(ctx:ApiContext):Promise<Reply|null>{
 const sourcePath=/^finance\/checkout-requests\/([^/]+)\/dispatch-source$/.exec(ctx.path),path=/^finance\/checkout-requests\/([^/]+)\/attempts(?:\/([^/]+)(?:\/(source|dispatch)(?:\/(outcome))?)?)?$/.exec(ctx.path);if(!sourcePath&&!path)return null;
 const params=new URL(ctx.request.url).searchParams;if(new Set(params.keys()).size!==[...params].length)throw new ApiError(400,'DUPLICATE_QUERY');const query=Object.fromEntries(params),requestId=uuid.parse(sourcePath?.[1]??path![1]);
 if(sourcePath){if(ctx.request.method!=='GET')throw new ApiError(405,'METHOD_NOT_ALLOWED');empty.parse(query);await lockApprovalWrites(ctx);const r=await allowed(ctx,requestId,true);if(r.attempt_id)throw new ApiError(409,'CHECKOUT_ATTEMPT_ALREADY_RESERVED');const s=await source(ctx,requestId),now=Date.now(),seconds=s.data.sessionLifetimeMinutes===1440?Math.floor(now/1000):Math.ceil(now/1000),prepared=build(s.data,seconds+s.data.sessionLifetimeMinutes*60,now);await record(ctx.db,ctx.credential,ctx.requestId,'finance.checkout.dispatch.source.read',requestId,r.hub_id,{privateSourceRead:true,providerRequestMade:false});return {status:200,body:{data:{draft:prepared.draft,receipt:prepared.receipt,sourceFingerprint:s.fingerprint,authorizationUntil:s.data.authorizationUntil,...flags}}};}
 const id=path![2]?uuid.parse(path![2]):null,section=path![3],outcome=Boolean(path![4]);
 if(ctx.request.method==='GET'){
  if(outcome||section==='dispatch')throw new ApiError(405,'METHOD_NOT_ALLOWED');
  if(!id){const q=paging.parse(query);await allowed(ctx,requestId);const rows=(await ctx.db.query<{id:string}>('SELECT id,request_id "requestId",request_sha256 "requestSha256",request_bytes "requestBytes",created_at "createdAt" FROM public.payment_checkout_attempts WHERE request_id=$1 AND($2::uuid IS NULL OR id>$2) ORDER BY id LIMIT $3',[requestId,q.after??null,q.limit+1])).rows;return {status:200,body:{data:rows.slice(0,q.limit),nextCursor:rows.length>q.limit?rows[q.limit-1].id:null,...flags}};}
  empty.parse(query);const a=await attempt(ctx,requestId,id,section==='source'),current=(await ctx.db.query<{current:boolean}>('SELECT public.payment_checkout_live_source($1) IS NOT NULL current',[requestId])).rows[0].current;
  return {status:200,body:{data:{id:a.id,requestId,...await state(ctx,a),sourceCurrent:current,requestSha256:a.request_sha256,requestBytes:a.request_bytes,createdAt:a.created_at,...(section==='source'?{draft:a.draft,idempotencyKey:'kavosh-checkout-v1:'+ctx.credential.academy_id+':'+requestId}:{}),...flags}}};
 }
 if(ctx.request.method!=='POST')throw new ApiError(405,'METHOD_NOT_ALLOWED');empty.parse(query);
 if(!id){const input=reservation.parse(await jsonBody(ctx.request));const r=await locked(ctx,requestId);return mutation(ctx,input,async()=>{
   const s=await source(ctx,requestId),prepared=build(s.data,input.expiresAt);if(s.fingerprint!==input.sourceFingerprint||prepared.receipt.requestSha256!==input.requestSha256||prepared.receipt.requestBytes!==input.requestBytes)throw new ApiError(409,'CHECKOUT_DISPATCH_MANIFEST_MISMATCH');
   const target=randomUUID();await record(ctx.db,ctx.credential,ctx.requestId,'finance.checkout.reserved',target,r.hub_id,{requestId,attemptId:target,severity:'critical',providerVerified:false});const audit=(await ctx.db.query<{id:string}>('SELECT id FROM public.audit_events WHERE request_id=$1 AND entity_id=$2 AND action=$3',[ctx.requestId,target,'finance.checkout.reserved'])).rows[0];
   try{await ctx.db.query('INSERT INTO public.payment_checkout_attempts(academy_id,id,request_id,actor_id,audit_id,source_fingerprint,request_sha256,request_bytes,origin,draft) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)',[ctx.credential.academy_id,target,requestId,ctx.credential.person_id,audit.id,s.fingerprint,input.requestSha256,input.requestBytes,new URL(prepared.draft.successUrl).origin,JSON.stringify(prepared.draft)]);}catch(e){problem(e);}
   return {status:201,body:{data:{id:target,requestId,requestSha256:input.requestSha256,requestBytes:input.requestBytes,...flags}}};
  });}
 if(section!=='dispatch')throw new ApiError(405,'METHOD_NOT_ALLOWED');const input=outcome?observation.parse(await jsonBody(ctx.request)):manifest.parse(await jsonBody(ctx.request));const r=await locked(ctx,requestId),a=await attempt(ctx,requestId,id,true),existing=await state(ctx,a);
 if(outcome&&(!existing.start||existing.start.actor_id!==ctx.credential.person_id))throw new ApiError(404,'NOT_FOUND');
 return mutation(ctx,input,async()=>{
  if(!outcome){if(existing.start)throw new ApiError(409,'CHECKOUT_DISPATCH_ALREADY_STARTED');const i=manifest.parse(input),s=await source(ctx,requestId);if(i.requestSha256!==a.request_sha256||i.requestBytes!==a.request_bytes||s.fingerprint!==a.source_fingerprint)throw new ApiError(409,'CHECKOUT_DISPATCH_MANIFEST_MISMATCH');}
  else if(existing.observation)throw new ApiError(409,'CHECKOUT_DISPATCH_OUTCOME_ALREADY_RECORDED');
  const target=randomUUID(),action=outcome?'finance.checkout.dispatch.observed':'finance.checkout.dispatch.started',o=outcome?observation.parse(input):null;await record(ctx.db,ctx.credential,ctx.requestId,action,target,r.hub_id,{requestId,attemptId:a.id,severity:'critical',providerVerified:false,...o?{state:o.state}:{}});
  const audit=(await ctx.db.query<{id:string}>('SELECT id FROM public.audit_events WHERE request_id=$1 AND entity_id=$2 AND action=$3',[ctx.requestId,target,action])).rows[0];
  try{if(o)await ctx.db.query('INSERT INTO public.payment_checkout_dispatch_observations(academy_id,id,start_id,actor_id,audit_id,state,provider_session_id) VALUES($1,$2,$3,$4,$5,$6,$7)',[ctx.credential.academy_id,target,existing.start!.id,ctx.credential.person_id,audit.id,o.state,o.state==='accepted'?o.sessionId:null]);
   else await ctx.db.query('INSERT INTO public.payment_checkout_dispatch_starts(academy_id,id,attempt_id,actor_id,audit_id) VALUES($1,$2,$3,$4,$5)',[ctx.credential.academy_id,target,a.id,ctx.credential.person_id,audit.id]);}catch(e){problem(e);}
  return {status:201,body:{data:{id:target,requestId,attemptId:a.id,state:o?.state??'started',reconciliationRequired:true,providerRequestMade:null,...flags}}};
 },async()=>{if(!outcome)throw new ApiError(409,'CHECKOUT_DISPATCH_ALREADY_STARTED');});
}
export const checkoutDispatchContract=[
 {path:'/api/v1/finance/checkout-requests/{id}/dispatch-source',method:'get',summary:'Audited current approved invoice draft and deterministic body receipt under independent checkouts.execute/view and invoices.view. Nonsecret HTTPS APP_ORIGIN only;fixed root return-query protocol is not frontend implementation or payment evidence. No key,provider call or dispatch authority.'},
 {path:'/api/v1/finance/checkout-requests/{id}/attempts',method:'post',summary:'Reserve one immutable exact server-rebuilt checkout manifest and current native source fingerprint. Caller supplies no money,owner IDs,URLs or keys. No provider IO;SDK sender must preflight/rebuild before separately consuming the one durable start.',schema:reservation},
 {path:'/api/v1/finance/checkout-requests/{id}/attempts',method:'get',summary:'Bounded permitted immutable checkout reservation metadata;no private draft or API credentials',querySchema:paging},
 {path:'/api/v1/finance/checkout-requests/{id}/attempts/{attemptId}',method:'get',summary:'Current-rights reservation/start/actor-observation status;all observations unverified,never a receipt or automatic-retry permit'},
 {path:'/api/v1/finance/checkout-requests/{id}/attempts/{attemptId}/source',method:'get',summary:'Execute-only original immutable body draft and idempotency identity for rebuilding/reconciliation,including after source expiry;not permission for another external POST'},
 {path:'/api/v1/finance/checkout-requests/{id}/attempts/{attemptId}/dispatch',method:'post',summary:'Atomically consume one current invoice/account-bound reservation. Cached repeats return409,not renewed authority. Start permanently blocks ordinary cancellation/replacement even after timeout or unverified not_attempted observation. No provider IO.',schema:manifest},
 {path:'/api/v1/finance/checkout-requests/{id}/attempts/{attemptId}/dispatch/outcome',method:'post',summary:'Starter-only immutable bounded actor transport observation,including after original source changes. Not trusted provider evidence,payment receipt or retry/cancellation clearance.',schema:observation}
] as const;
