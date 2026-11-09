import Stripe from 'stripe';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { ApiError } from '../core/policy.ts';
import { jsonBody } from '../core/api.ts';
import { readMinorUnits } from '../core/money.ts';
import { stripeWebhookConnection,stripeSnapshotVersion } from './stripe-webhook-config.ts';

const uuid=z.string().uuid().transform(v=>v.toLowerCase()),integer=z.number().int().min(0).max(999_999_999_999),epoch=z.number().int().positive().max(9_999_999_999),sessionId=z.string().regex(/^cs_(test|live)_[A-Za-z0-9]{1,200}$/),paymentId=z.string().regex(/^pi_[A-Za-z0-9]{1,200}$/),chargeId=z.string().regex(/^ch_[A-Za-z0-9]{1,200}$/);
const origin=z.string().max(2000).refine(value=>{try{const u=new URL(value);return u.origin===value&&u.protocol==='https:'&&!u.username&&!u.password;}catch{return false;}});
export const stripeCheckoutPublicConnection=stripeWebhookConnection.omit({secrets:true}).extend({origin});
export const stripeCheckoutConnection=stripeCheckoutPublicConnection.extend({apiKey:z.string().regex(/^(sk|rk)_(test|live)_[A-Za-z0-9]{16,256}$/)}).strict().refine(c=>c.apiKey.split('_')[1]===(c.livemode?'live':'test'));
export type StripeCheckoutConnection=z.infer<typeof stripeCheckoutConnection>;
// No environment auto-enable,account creation or mounted route. This component
// is for an isolated dispatcher;web/bot request data must never supply keys.
export function configuredStripeCheckout(id:string,env:Record<string,string|undefined>=process.env):StripeCheckoutConnection|null{
 if(env.STRIPE_CHECKOUT_TRANSPORT_ENABLED!=='true')return null;
 try{const selected=uuid.parse(id),raw=env.STRIPE_CHECKOUT_CONNECTIONS;if(!raw||Buffer.byteLength(raw)>1_048_576)throw new Error('INVALID_CONFIG');const all=z.array(stripeCheckoutConnection).max(1000).parse(JSON.parse(raw));if(new Set(all.map(c=>c.connectionId)).size!==all.length||new Set(all.map(c=>JSON.stringify([c.accountId,c.livemode]))).size!==all.length)throw new Error('AMBIGUOUS_CONFIG');return all.find(c=>c.connectionId===selected)??null;}catch{throw new ApiError(503,'STRIPE_CHECKOUT_NOT_CONFIGURED');}
}
const sameOriginUrl=z.string().url().max(8192);
export const stripeCheckoutDraft=z.object({requestId:uuid,academyId:uuid,invoiceId:uuid,connectionId:uuid,accountId:z.string().regex(/^acct_[A-Za-z0-9]{1,200}$/),livemode:z.boolean(),currencyCode:z.string().regex(/^[A-Z]{3}$/),unitScale:z.number().int().min(0).max(18),amountMinor:z.string().max(80).regex(/^[1-9]\d{0,37}(?:\.0+)?$/).transform(v=>readMinorUnits(v).toString()),expiresAt:epoch,successUrl:sameOriginUrl,cancelUrl:sameOriginUrl}).strict();
type Draft=z.infer<typeof stripeCheckoutDraft>;
// Source: https://docs.stripe.com/currencies and its embedded zero_decimal data,
// checked2026-11-09. UGX/ISK retain TWO API decimals but forbid fractional units.
// Three-decimal support: https://support.stripe.com/questions/which-payments-methods-and-products-are-available-in-the-uae
// Account-country availability is fetched,never inferred from this format list.
const zero=new Set(['BIF','CLP','DJF','GNF','JPY','KMF','KRW','MGA','PYG','RWF','VND','VUV','XAF','XOF','XPF']),three=new Set(['BHD','JOD','KWD','OMR','TND']);
export function stripeChargeAmount(currencyCode:string,unitScale:number,minorUnits:string){
 if(!/^[A-Z]{3}$/.test(currencyCode)||!Number.isInteger(unitScale)||unitScale<0||unitScale>18||typeof minorUnits!=='string'||minorUnits.length>80)throw new ApiError(400,'UNSUPPORTED_STRIPE_CURRENCY_FORMAT');
 const scale=zero.has(currencyCode)?0:three.has(currencyCode)?3:2,amount=readMinorUnits(minorUnits),power=10n**BigInt(Math.abs(unitScale-scale));
 if(amount<=0n||amount>=10n**38n||unitScale>scale&&amount%power!==0n)throw new ApiError(400,'STRIPE_MONEY_PRECISION_MISMATCH');
 const value=unitScale>scale?amount/power:amount*power;
 if(value>999_999_999_999n||(['ISK','UGX'].includes(currencyCode)&&value%100n!==0n))throw new ApiError(400,'STRIPE_AMOUNT_NOT_REPRESENTABLE');
 // Current card limit is12digits. Individual networks/settlement-currency
 // minimums can be stricter;the actual API decision is never guessed here.
 return {amount:Number(value),currency:currencyCode.toLowerCase(),providerScale:scale};
}
function metadata(d:Draft){return {kavosh_schema:'checkout-v1',kavosh_request:d.requestId,kavosh_school:d.academyId,kavosh_invoice:d.invoiceId,kavosh_connection:d.connectionId};}
function bound(config:z.infer<typeof stripeCheckoutPublicConnection>,d:Draft){if(d.connectionId!==config.connectionId||d.academyId!==config.academyId||d.accountId!==config.accountId||d.livemode!==config.livemode)throw new ApiError(409,'STRIPE_CONNECTION_MISMATCH');}
export function buildStripeCheckout(raw:unknown,configured:z.infer<typeof stripeCheckoutPublicConnection>,now=Date.now()){
 // The web coordinator requires only public identity/origin,never API keys.
 const c=stripeCheckoutPublicConnection.strip().parse(configured),d=stripeCheckoutDraft.parse(raw);bound(c,d);
 if(d.expiresAt<Math.floor(now/1000)+1800||d.expiresAt>Math.floor(now/1000)+86400)throw new ApiError(409,'STRIPE_CHECKOUT_EXPIRY_INVALID');
 for(const value of [d.successUrl,d.cancelUrl]){const u=new URL(value);if(u.origin!==c.origin||u.username||u.password||u.hash||u.protocol!=='https:')throw new ApiError(400,'STRIPE_RETURN_URL_FORBIDDEN');}
 const money=stripeChargeAmount(d.currencyCode,d.unitScale,d.amountMinor),tags=metadata(d);
 const params:Stripe.Checkout.SessionCreateParams={mode:'payment',ui_mode:'hosted_page',allowed_payment_method_types:['card'],client_reference_id:d.requestId,metadata:tags,payment_intent_data:{capture_method:'automatic',metadata:tags},
  adaptive_pricing:{enabled:false},automatic_tax:{enabled:false},allow_promotion_codes:false,invoice_creation:{enabled:false},customer_creation:'if_required',
  line_items:[{quantity:1,price_data:{currency:money.currency,unit_amount:money.amount,tax_behavior:'inclusive',product_data:{name:'Academy tuition payment'}}}],expires_at:d.expiresAt,success_url:d.successUrl,cancel_url:d.cancelUrl};
 const idempotencyKey='kavosh-checkout-v1:'+d.academyId+':'+d.requestId,canonical=JSON.stringify({idempotencyKey,params}),receipt={requestSha256:createHash('sha256').update(canonical).digest('hex'),requestBytes:Buffer.byteLength(canonical),idempotencyKey};
 return {draft:d,params,receipt,money};
}
const tags=z.object({kavosh_schema:z.literal('checkout-v1'),kavosh_request:uuid,kavosh_school:uuid,kavosh_invoice:uuid,kavosh_connection:uuid});
const session=z.object({id:sessionId,object:z.literal('checkout.session'),livemode:z.boolean(),mode:z.literal('payment'),ui_mode:z.literal('hosted_page'),client_reference_id:uuid,metadata:tags,currency:z.string(),amount_total:integer,amount_subtotal:integer,
 total_details:z.object({amount_discount:z.literal(0),amount_shipping:z.literal(0),amount_tax:z.literal(0)}),automatic_tax:z.object({enabled:z.literal(false)}),payment_method_types:z.array(z.literal('card')).length(1),status:z.enum(['open','complete','expired']),payment_status:z.enum(['paid','unpaid','no_payment_required']),payment_intent:paymentId.nullable(),expires_at:epoch,url:z.string().max(8192).nullable()});
function checkedSession(raw:unknown,d:Draft){
 const s=session.parse(raw),m=stripeChargeAmount(d.currencyCode,d.unitScale,d.amountMinor);
 if(s.payment_status==='no_payment_required'||s.livemode!==d.livemode||!s.id.startsWith(d.livemode?'cs_live_':'cs_test_')||s.client_reference_id!==d.requestId||JSON.stringify(s.metadata)!==JSON.stringify(metadata(d))||s.currency!==m.currency||s.amount_total!==m.amount||s.amount_subtotal!==m.amount||s.expires_at!==d.expiresAt)throw new Error('STRIPE_SESSION_BINDING_MISMATCH');
 if(s.url){const u=new URL(s.url);if(u.origin!=='https://checkout.stripe.com'||u.username||u.password||!['/c/pay/'+s.id,'/c/pay/'+s.id+'/'].includes(u.pathname))throw new Error('STRIPE_CHECKOUT_URL_FORBIDDEN');}
 return s;
}
function publicSession(s:z.infer<typeof session>){return {sessionId:s.id,paymentId:s.payment_intent,status:s.status,paymentStatus:s.payment_status,expiresAt:s.expires_at,checkoutUrl:s.url,amount:s.amount_total,currency:s.currency,paymentVerified:false as const};}
const intent=z.object({id:paymentId,object:z.literal('payment_intent'),livemode:z.boolean(),currency:z.string(),amount:integer,amount_received:integer,metadata:tags,status:z.enum(['requires_payment_method','requires_confirmation','requires_action','processing','requires_capture','canceled','succeeded']),latest_charge:chargeId.nullable()});
const charge=z.object({id:chargeId,object:z.literal('charge'),livemode:z.boolean(),payment_intent:paymentId,currency:z.string(),amount:integer,amount_captured:integer,amount_refunded:integer,paid:z.boolean(),captured:z.boolean(),disputed:z.boolean(),status:z.enum(['succeeded','pending','failed']),payment_method_details:z.object({type:z.literal('card'),card:z.object({funding:z.enum(['credit','debit','prepaid','unknown'])})})});
const discoveryWindow=z.object({createdAfter:z.number().int().nonnegative(),createdBefore:z.number().int().nonnegative(),after:sessionId.optional()}).strict().refine(v=>v.createdBefore>=v.createdAfter);
const discoveryPage=z.object({object:z.literal('list'),url:z.literal('/v1/checkout/sessions'),has_more:z.boolean(),data:z.array(z.object({id:sessionId,object:z.literal('checkout.session'),created:z.number().int().nonnegative(),client_reference_id:z.string().nullable().optional(),metadata:z.record(z.string(),z.string()).nullable().optional()}).passthrough()).max(100)});
const inspectionBase=z.object({sessionId,paymentId:paymentId.nullable(),bankSettled:z.literal(false),ledgerAdjusted:z.literal(false)});
const captureFields={paymentId,chargeId,amount:integer.positive(),currency:z.string().regex(/^[a-z]{3}$/),cardFunding:z.enum(['credit','debit','prepaid','unknown']),refundedAmount:integer,disputed:z.boolean()};
export const stripeCheckoutInspection=z.discriminatedUnion('state',[
 inspectionBase.extend({state:z.enum(['awaiting_payment','expired']),paymentVerified:z.literal(false)}).strict(),
 inspectionBase.extend({...captureFields,state:z.literal('requires_review'),paymentVerified:z.literal(false)}).strict(),
 inspectionBase.extend({...captureFields,state:z.literal('captured'),paymentVerified:z.literal(true),refundedAmount:z.literal(0),disputed:z.literal(false)}).strict()
]);
export class StripeCheckoutError extends Error{constructor(readonly outcome:'not_attempted'|'rejected'|'outcome_unknown',code:string){super(code);this.name='StripeCheckoutError';}}

export function stripeCheckoutTransport(configured:StripeCheckoutConnection,send:typeof fetch=fetch){
 if(process.env.NODE_TLS_REJECT_UNAUTHORIZED==='0')throw new StripeCheckoutError('not_attempted','INSECURE_TRANSPORT_ENVIRONMENT');
 const c=stripeCheckoutConnection.parse(configured);
 const guardedFetch:typeof fetch=async(url,init)=>{
  const target=new URL(String(url));if(target.origin!=='https://api.stripe.com'||!target.pathname.startsWith('/v1/')||target.username||target.password)throw new Error('STRIPE_ENDPOINT_FORBIDDEN');
  const response=await send(url,{...init,redirect:'error'});
  let consumed=false;try{
   if(response.redirected||response.url&&new URL(response.url).origin!=='https://api.stripe.com')throw new Error('STRIPE_REDIRECT_FORBIDDEN');
   // Reuse bounded UTF-8/deadline/cancellation handling. Never log raw SDK data.
   const bodyInit:RequestInit&{duplex:'half'}={method:'POST',headers:{'content-type':response.headers.get('content-type')??''},body:response.body,signal:init?.signal,duplex:'half'},body=await jsonBody(new Request(target,bodyInit),1_048_576);consumed=true;
   const headers=new Headers(response.headers);for(const name of ['content-length','content-encoding','transfer-encoding'])headers.delete(name);
   return Response.json(body,{status:response.status,headers});
  }finally{if(!consumed)void response.body?.cancel().catch(()=>{});}
 };
 const sdk=new Stripe(c.apiKey,{apiVersion:stripeSnapshotVersion,host:'api.stripe.com',port:443,protocol:'https',timeout:10_000,maxNetworkRetries:0,telemetry:false,emitEventBodies:false,httpClient:Stripe.createFetchHttpClient(guardedFetch)});
 let readiness:{country:string;currencies:string[];at:number}|null=null,identityAt=0,identifying:ReturnType<typeof sdk.accounts.retrieveCurrent>|null=null;
 async function identify(){
  if(!identifying){identityAt=0;identifying=(async()=>{const raw=await sdk.accounts.retrieveCurrent(),a=z.object({id:z.string(),object:z.literal('account')}).parse(raw);if(a.id!==c.accountId)throw new Error('WRONG_ACCOUNT');identityAt=Date.now();return raw;})().finally(()=>{identifying=null;});}
  return identifying;
 }
 async function preflight(){
  readiness=null;try{
   const a=z.object({id:z.string(),object:z.literal('account'),country:z.string().regex(/^[A-Z]{2}$/),charges_enabled:z.literal(true),capabilities:z.object({card_payments:z.literal('active')})}).parse(await identify());
   const country=z.object({id:z.string(),object:z.literal('country_spec'),supported_payment_currencies:z.array(z.string().regex(/^[a-z]{3}$/)).min(1).max(300),supported_payment_methods:z.array(z.string()).max(100)}).parse(await sdk.countrySpecs.retrieve(a.country));
   if(country.id!==a.country||!country.supported_payment_methods.includes('card'))throw new Error('CARD_NOT_AVAILABLE');readiness={country:a.country,currencies:country.supported_payment_currencies,at:Date.now()};
   return {accountId:c.accountId,livemode:c.livemode,country:a.country,supportedCurrencies:[...country.supported_payment_currencies],cardPaymentsEnabled:true};
  }catch{throw new StripeCheckoutError('not_attempted','STRIPE_ACCOUNT_CHECK_FAILED');}
 }
 return {preflight,
  // Caller MUST first persist the exact manifest and atomically claim dispatch
  // using the original approved invoice source. One-use below is reentry-only,
  // NOT durable crash safety. Never retry an ambiguous create blindly.
  prepare(raw:unknown,reserved:{requestSha256:string;requestBytes:number}){
   const built=buildStripeCheckout(raw,c);if(built.receipt.requestSha256!==reserved.requestSha256||built.receipt.requestBytes!==reserved.requestBytes)throw new ApiError(409,'STRIPE_RESERVED_MANIFEST_MISMATCH');
   let used=false;return {receipt:Object.freeze({...built.receipt}),async dispatch(){
    if(used)throw new StripeCheckoutError('not_attempted','STRIPE_DISPATCH_ALREADY_USED');used=true;
    if(!readiness||Date.now()-readiness.at>60_000||!readiness.currencies.includes(built.money.currency))throw new StripeCheckoutError('not_attempted','STRIPE_ACCOUNT_CHECK_REQUIRED');
    if(built.draft.expiresAt<Math.floor(Date.now()/1000)+1800)throw new StripeCheckoutError('not_attempted','STRIPE_CHECKOUT_EXPIRY_INVALID');
    try{const s=checkedSession(await sdk.checkout.sessions.create(built.params,{idempotencyKey:built.receipt.idempotencyKey}),built.draft);return {outcome:'accepted' as const,session:publicSession(s),bankSettled:false as const};}
    catch(e){const rejected=e instanceof Stripe.errors.StripeError&&[400,401,402,403,404,422].includes(e.statusCode??0);throw new StripeCheckoutError(rejected?'rejected':'outcome_unknown',rejected?'STRIPE_CHECKOUT_REJECTED':'STRIPE_CHECKOUT_OUTCOME_UNKNOWN');}
   }};
  },
  // One bounded read-only page per invocation. A lost create response must
  // never be "recovered" by resending a POST after provider idempotency expiry.
  // Search windows/cursors are explicit;an empty/bounded search is NOT proof
  // that nothing happened or permission to create another checkout.
  async discover(raw:unknown,window:unknown){
   const d=stripeCheckoutDraft.parse(raw);bound(c,d);const w=discoveryWindow.parse(window);
   if(w.after&&!w.after.startsWith(c.livemode?'cs_live_':'cs_test_'))throw new ApiError(409,'STRIPE_SESSION_MODE_MISMATCH');
   try{
    if(!identityAt||Date.now()-identityAt>60_000)await identify();
    const page=discoveryPage.parse(await sdk.checkout.sessions.list({created:{gte:w.createdAfter,lte:w.createdBefore},limit:100,...w.after?{starting_after:w.after}:{}}));
    const ids=page.data.map(v=>v.id);if(new Set(ids).size!==ids.length||w.after&&ids.includes(w.after)||page.has_more&&!ids.length||page.data.some(v=>v.created<w.createdAfter||v.created>w.createdBefore))throw new Error('INVALID_DISCOVERY_PAGE');
    const matches=page.data.filter(v=>v.client_reference_id===d.requestId||v.metadata?.kavosh_request===d.requestId).map(v=>checkedSession(v,d).id);
    return {requestId:d.requestId,createdAfter:w.createdAfter,createdBefore:w.createdBefore,examined:ids.length,matchingSessionIds:matches,nextCursor:page.has_more?ids.at(-1)!:null,searchCompleteWithinWindow:!page.has_more,absenceVerified:false as const,paymentVerified:false as const,automaticRetryAllowed:false as const,bankSettled:false as const,ledgerAdjusted:false as const};
   }catch{throw new StripeCheckoutError('outcome_unknown','STRIPE_CHECKOUT_DISCOVERY_REQUIRES_REVIEW');}
  },
  async inspect(raw:unknown,id:string){
   const d=stripeCheckoutDraft.parse(raw);bound(c,d);const selected=sessionId.parse(id);if(!selected.startsWith(c.livemode?'cs_live_':'cs_test_'))throw new ApiError(409,'STRIPE_SESSION_MODE_MISMATCH');
   try{
    // Disabling NEW charges must not prevent reconciliation of earlier money.
    if(!identityAt||Date.now()-identityAt>60_000)await identify();
    const s=checkedSession(await sdk.checkout.sessions.retrieve(selected),d);if(s.id!==selected)throw new Error('WRONG_SESSION');
    const base={sessionId:s.id,paymentId:s.payment_intent,bankSettled:false as const,ledgerAdjusted:false as const};
    if(!s.payment_intent){if(s.payment_status==='paid')throw new Error('PAID_WITHOUT_PAYMENT');return {...base,state:s.status==='expired'?'expired' as const:'awaiting_payment' as const,paymentVerified:false as const};}
    const p=intent.parse(await sdk.paymentIntents.retrieve(s.payment_intent)),m=stripeChargeAmount(d.currencyCode,d.unitScale,d.amountMinor);
    if(p.id!==s.payment_intent||p.livemode!==c.livemode||p.currency!==m.currency||p.amount!==m.amount||JSON.stringify(p.metadata)!==JSON.stringify(metadata(d)))throw new Error('PAYMENT_MISMATCH');
    if(p.status!=='succeeded'){if(s.payment_status==='paid')throw new Error('INCONSISTENT_PAID_STATUS');return {...base,state:p.status==='canceled'||s.status==='expired'?'expired' as const:'awaiting_payment' as const,paymentVerified:false as const};}
    if(!p.latest_charge)throw new Error('MISSING_CHARGE');const q=charge.parse(await sdk.charges.retrieve(p.latest_charge));
    if(q.id!==p.latest_charge||q.payment_intent!==p.id||q.livemode!==c.livemode||q.currency!==m.currency||q.amount!==m.amount||q.amount_captured!==m.amount||p.amount_received!==m.amount||!q.paid||!q.captured||q.status!=='succeeded'||q.amount_refunded>q.amount_captured)throw new Error('CAPTURE_MISMATCH');
    const proof={...base,chargeId:q.id,amount:m.amount,currency:m.currency,cardFunding:q.payment_method_details.card.funding,refundedAmount:q.amount_refunded,disputed:q.disputed};
    if(q.amount_refunded||q.disputed||s.status!=='complete'||s.payment_status!=='paid')return {...proof,state:'requires_review' as const,paymentVerified:false as const};
    return {...proof,state:'captured' as const,paymentVerified:true as const};
   }catch{throw new StripeCheckoutError('outcome_unknown','STRIPE_PAYMENT_RECONCILIATION_REQUIRED');}
  }
 };
}
