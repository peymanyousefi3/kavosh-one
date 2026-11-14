import { z } from 'zod';
import { isDeepStrictEqual } from 'node:util';
import { jsonBody,record,type ApiContext,type Reply } from '../core/api.ts';
import { propose,master,lockApprovalWrites,type ApprovalRegistry,type Proposal } from '../core/approvals.ts';
import { ApiError } from '../core/policy.ts';
import { parseMoney,readMinorUnits,formatMoney } from '../core/money.ts';
import { lockFinanceBook } from '../core/finance-lock.ts';
import { lockAcademyTopology } from './academy.ts';
import { invoiceRow } from './invoices.ts';
import { financialRecordAuthority } from './tuition.ts';

const uuid=z.string().uuid().transform(v=>v.toLowerCase()),reason=z.string().trim().min(1).max(2000).refine(v=>v.isWellFormed()&&!v.includes('\0')),empty=z.object({}).strict();
const input=z.object({connectionId:uuid,priorId:uuid.nullable().default(null),amount:z.string().max(80),sessionLifetimeMinutes:z.number().int().min(30).max(1440),dispatchWithinMinutes:z.number().int().min(1).max(1440),reason}).strict(),payload=input.extend({invoiceId:uuid}),cancel=z.object({reason}).strict(),cancelPayload=cancel.extend({requestId:uuid});
const paging=z.object({limit:z.coerce.number().int().min(1).max(100).default(25),after:uuid.optional()}).strict();
type Source={invoice:{id:string;planId:string;planVersion:number;studentId:string;classId:string;hubId:string;creditId:string|null;journalId:string|null};terms:{currencyId:string;unitScale:number;currencyCode:string;grossMinor:string;receivedMinor:string;outstandingMinor:string};connection:{id:string;academyId:string;accountId:string;livemode:boolean;apiVersion:string;enabled:boolean};prior:{id:string;authorizationUntil:string;cancellationId:string|null}|null;headId:string|null};
type Row={id:string;invoice_id:string;student_id:string;class_id:string;hub_id:string;connection_id:string;prior_id:string|null;amount_minor:string;currency_code:string;unit_scale:number;session_lifetime_minutes:number;dispatch_within_minutes:number;created_at:string;authorization_until:string;approval_id:string;reason:string;context:unknown;cancellation_id:string|null;successor_id:string|null;attempt_id:string|null;dispatch_id:string|null;expired:boolean};
const fields='r.*,r.amount_minor::text,r.created_at::text,r.authorization_until::text,c.id cancellation_id,s.id successor_id,a.id attempt_id,st.id dispatch_id,r.authorization_until<=statement_timestamp() expired',from='FROM public.payment_checkout_requests r LEFT JOIN public.payment_checkout_cancellations c ON c.academy_id=r.academy_id AND c.request_id=r.id LEFT JOIN public.payment_checkout_requests s ON s.academy_id=r.academy_id AND s.prior_id=r.id LEFT JOIN public.payment_checkout_attempts a ON a.academy_id=r.academy_id AND a.request_id=r.id LEFT JOIN public.payment_checkout_dispatch_starts st ON st.academy_id=a.academy_id AND st.attempt_id=a.id';
function view(r:Row){return {id:r.id,invoiceId:r.invoice_id,studentId:r.student_id,classId:r.class_id,hubId:r.hub_id,connectionId:r.connection_id,priorId:r.prior_id,amount:formatMoney(readMinorUnits(r.amount_minor),r.unit_scale),currencyCode:r.currency_code,unitScale:r.unit_scale,sessionLifetimeMinutes:r.session_lifetime_minutes,dispatchWithinMinutes:r.dispatch_within_minutes,createdAt:r.created_at,authorizationUntil:r.authorization_until,approvalId:r.approval_id,cancellationId:r.cancellation_id,successorId:r.successor_id,attemptId:r.attempt_id,dispatchId:r.dispatch_id,state:r.successor_id?'superseded':r.cancellation_id?'cancelled':r.dispatch_id?'dispatch_started_unverified':r.expired?'authorization_expired':r.attempt_id?'reserved_unexecuted':'approved_unexecuted',providerRequestMade:r.dispatch_id?null:false,checkoutUrl:null,paymentReceived:false,ledgerAdjusted:false,sourceRechecked:false,reconciliationRequired:Boolean(r.dispatch_id)};}
async function authority(ctx:ApiContext,id:string,edit=false){const i=await invoiceRow(ctx,id);financialRecordAuthority(ctx,i,'checkouts.view');if(edit)financialRecordAuthority(ctx,i,'checkouts.edit');return i;}
async function row(ctx:ApiContext,id:string,edit=false){const r=(await ctx.db.query<Row>('SELECT '+fields+' '+from+' WHERE r.id=$1',[id])).rows[0];if(!r)throw new ApiError(404,'NOT_FOUND');await authority(ctx,r.invoice_id,edit);return r;}
async function basis(ctx:ApiContext,raw:unknown,lock=false,checkState=true){
 const i=payload.parse(raw),invoice=await authority(ctx,i.invoiceId,true);
 if(lock){await lockFinanceBook(ctx);await lockAcademyTopology(ctx);await ctx.db.query('SELECT id FROM public.tuition_invoices WHERE id=$1 FOR UPDATE',[i.invoiceId]);if(!(await ctx.db.query<{locked:boolean}>('SELECT public.lock_payment_checkout_connection($1) locked',[i.connectionId])).rows[0]?.locked)throw new ApiError(404,'NOT_FOUND');}
 const s=(await ctx.db.query<{data:Source|null}>('SELECT public.payment_checkout_source($1,$2,$3) data',[i.invoiceId,i.connectionId,i.priorId])).rows[0].data;if(!s)throw new ApiError(404,'NOT_FOUND');
 const amount=parseMoney(i.amount,s.terms.unitScale);if(amount<=0n)throw new ApiError(400,'POSITIVE_CHECKOUT_REQUIRED');
 if(checkState){
  if(i.priorId&&(await ctx.db.query('SELECT 1 FROM public.payment_checkout_attempts a JOIN public.payment_checkout_dispatch_starts s ON s.academy_id=a.academy_id AND s.attempt_id=a.id WHERE a.request_id=$1',[i.priorId])).rows.length)throw new ApiError(409,'CHECKOUT_DISPATCH_RECONCILIATION_REQUIRED');
  if(s.invoice.creditId||!s.invoice.journalId)throw new ApiError(409,'CHECKOUT_POSTED_INVOICE_REQUIRED');if(!s.connection.enabled)throw new ApiError(409,'CHECKOUT_CONNECTION_DISABLED');if(amount>readMinorUnits(s.terms.outstandingMinor))throw new ApiError(409,'CHECKOUT_EXCEEDS_OUTSTANDING');
  if(s.headId!==i.priorId||i.priorId&&(!s.prior||!s.prior.cancellationId&&Date.parse(s.prior.authorizationUntil)>Date.now()))throw new ApiError(409,'CHECKOUT_PRIOR_NOT_REPLACEABLE');
 }
 return {invoice,source:s,amount:amount.toString()};
}
async function cancellationBasis(ctx:ApiContext,raw:unknown,lock=false,checkState=true){
 const i=cancelPayload.parse(raw),r=await row(ctx,i.requestId,true);if(lock){await lockFinanceBook(ctx);await lockAcademyTopology(ctx);await ctx.db.query('SELECT id FROM public.tuition_invoices WHERE id=$1 FOR UPDATE',[r.invoice_id]);}
 const s=(await ctx.db.query<{data:{id:string;invoiceId:string;connectionId:string;approvalId:string;cancellationId:string|null;successorId:string|null}|null}>('SELECT public.payment_checkout_cancel_source($1) data',[i.requestId])).rows[0].data;
 if(!s)throw new ApiError(404,'NOT_FOUND');if(checkState&&r.dispatch_id)throw new ApiError(409,'CHECKOUT_DISPATCH_RECONCILIATION_REQUIRED');if(checkState&&(s.cancellationId||s.successorId))throw new ApiError(409,'CHECKOUT_CANNOT_CANCEL');return {row:r,source:s};
}
export const paymentCheckoutActions:ApprovalRegistry=Object.fromEntries(['finance.checkout.request','finance.checkout.cancel'].map(action=>[action,{
 requestCapability:'checkouts.edit',privacyCapability:'checkouts.edit',createdStatus:201,
 async validate(ctx:ApiContext,_id:string,raw:unknown){const r=action==='finance.checkout.request'?(await basis(ctx,raw,true,false)).invoice:(await cancellationBasis(ctx,raw,true,false)).row;return financialRecordAuthority(ctx,r,'checkouts.edit');},
 async dependencies(ctx:ApiContext,_id:string,raw:unknown,purpose:'request'|'review'){try{return {source:action==='finance.checkout.request'?(await basis(ctx,raw)).source:(await cancellationBasis(ctx,raw)).source};}catch(e){if(purpose==='review'&&e instanceof ApiError&&[400,403,404,409].includes(e.status))return {unavailable:e.code};throw e;}},
 async authorizeReviewer(ctx:ApiContext,p:Proposal){if(await master(ctx))return;const invoice=action==='finance.checkout.request'?await authority(ctx,payload.parse(p.payload).invoiceId,true):await authority(ctx,(await row(ctx,cancelPayload.parse(p.payload).requestId,true)).invoice_id,true);if(invoice.student_id===ctx.credential.person_id||(await ctx.db.query('SELECT 1 FROM public.family_relationships WHERE student_id=$1 AND guardian_id=$2 LIMIT 1',[invoice.student_id,ctx.credential.person_id])).rows.length)throw new ApiError(403,'BENEFICIARY_REVIEW_FORBIDDEN');},
 async apply(ctx:ApiContext,p:Proposal){
  if(ctx.credential.kind!=='human')throw new ApiError(403,'HUMAN_REVIEW_REQUIRED');let id:string,hub:string;
  try{if(action==='finance.checkout.request'){
   const i=payload.parse(p.payload),b=await basis(ctx,i,true);if(!isDeepStrictEqual({source:b.source},p.review_context))throw new ApiError(409,'CHECKOUT_SOURCE_CHANGED');id=p.target_id;hub=b.invoice.hub_id;
   await ctx.db.query(`INSERT INTO public.payment_checkout_requests(academy_id,id,invoice_id,student_id,class_id,hub_id,connection_id,prior_id,amount_text,amount_minor,currency_id,unit_scale,currency_code,session_lifetime_minutes,dispatch_within_minutes,context,approval_id,created_by,reason)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::numeric,$11,$12,$13,$14,$15,$16::jsonb,$17,$18,$19)`,[ctx.credential.academy_id,id,i.invoiceId,b.invoice.student_id,b.invoice.class_id,hub,i.connectionId,i.priorId,i.amount,b.amount,b.source.terms.currencyId,b.source.terms.unitScale,b.source.terms.currencyCode,i.sessionLifetimeMinutes,i.dispatchWithinMinutes,JSON.stringify(p.review_context),p.id,ctx.credential.person_id,i.reason]);
  }else{
   const i=cancelPayload.parse(p.payload),b=await cancellationBasis(ctx,i,true);if(!isDeepStrictEqual({source:b.source},p.review_context))throw new ApiError(409,'CHECKOUT_SOURCE_CHANGED');id=b.row.id;hub=b.row.hub_id;
   await ctx.db.query('INSERT INTO public.payment_checkout_cancellations(academy_id,id,request_id,approval_id,created_by,reason) VALUES($1,$2,$3,$4,$5,$6)',[ctx.credential.academy_id,p.target_id,id,p.id,ctx.credential.person_id,i.reason]);
  }}catch(e){if(e&&typeof e==='object'&&'code'in e&&(e.code==='23505'||e.code==='23514'&&'message'in e&&['CHECKOUT_CURRENT_SOURCE_REQUIRED','CHECKOUT_CANCEL_CURRENT_SOURCE_REQUIRED'].includes(String(e.message))))throw new ApiError(409,'CHECKOUT_SOURCE_CHANGED');throw e;}
  await record(ctx.db,ctx.credential,ctx.requestId,action,p.target_id,hub,{approvalId:p.id,severity:'critical',hasReason:true,providerRequestMade:false});return view(await row(ctx,id));
 }
}])) as ApprovalRegistry;
export async function paymentCheckouts(ctx:ApiContext,registry:ApprovalRegistry=paymentCheckoutActions):Promise<Reply|null>{
 const collection=/^finance\/invoices\/([^/]+)\/(checkout-requests|checkout-connections)$/.exec(ctx.path),item=/^finance\/checkout-requests\/([^/]+)(?:\/(review|cancel))?$/.exec(ctx.path);if(!collection&&!item)return null;
 const params=new URL(ctx.request.url).searchParams;if([...params].length!==new Set(params.keys()).size)throw new ApiError(400,'DUPLICATE_QUERY');const q=Object.fromEntries(params);
 if(collection){const invoiceId=uuid.parse(collection[1]);if(collection[2]==='checkout-connections'){
   if(ctx.request.method!=='GET')throw new ApiError(405,'METHOD_NOT_ALLOWED');empty.parse(q);await authority(ctx,invoiceId);const rows=(await ctx.db.query('SELECT id,livemode,api_version "snapshotApiVersion" FROM public.payment_connections WHERE enabled ORDER BY id LIMIT 101')).rows;if(rows.length>100)throw new ApiError(422,'TOO_MANY_PAYMENT_CONNECTIONS');return {status:200,body:{data:rows,provider:'stripe',liveProviderVerified:false,onlinePaymentAvailable:false}};
  }
  if(ctx.request.method==='POST'){empty.parse(q);const i={...input.parse(await jsonBody(ctx.request)),invoiceId};return propose(ctx,registry,'finance.checkout.request',null,0,i);}
  if(ctx.request.method!=='GET')throw new ApiError(405,'METHOD_NOT_ALLOWED');const i=paging.parse(q);await authority(ctx,invoiceId);const rows=(await ctx.db.query<Row>('SELECT '+fields+' '+from+' WHERE r.invoice_id=$1 AND($2::uuid IS NULL OR r.id>$2) ORDER BY r.id LIMIT $3',[invoiceId,i.after??null,i.limit+1])).rows;return {status:200,body:{data:rows.slice(0,i.limit).map(view),nextCursor:rows.length>i.limit?rows[i.limit-1].id:null}};
 }
 const id=uuid.parse(item![1]),section=item![2];empty.parse(q);
 if(section==='cancel'){if(ctx.request.method!=='POST')throw new ApiError(405,'METHOD_NOT_ALLOWED');return propose(ctx,registry,'finance.checkout.cancel',null,0,{...cancel.parse(await jsonBody(ctx.request)),requestId:id});}
 if(ctx.request.method!=='GET')throw new ApiError(405,'METHOD_NOT_ALLOWED');await lockApprovalWrites(ctx);const r=await row(ctx,id,section==='review');return {status:200,body:{data:{...view(r),...(section==='review'?{sourceSnapshot:r.context,reason:r.reason}:{})}}};
}
export const paymentCheckoutsContract=[
 {path:'/api/v1/finance/invoices/{id}/checkout-connections',method:'get',summary:'Read bounded enabled school Stripe connection IDs/modes for a permitted invoice. No secrets,other school accounts,live provider verification or working checkout implied.'},
 {path:'/api/v1/finance/invoices/{id}/checkout-requests',method:'post',summary:'Propose exact partial/full invoice checkout preparation under checkouts.edit/view and invoices.view,upper human review/master self-approval. Pins original invoice terms,actual active receipts,operator-owned school/account/mode/API and bounded authorization/session lifetime;stale money/configuration fails closed. Explicit priorId replaces only a cancelled or expired unused chain head. No provider call,reserved funds,checkout URL,payment or ledger posting.',schema:input},
 {path:'/api/v1/finance/invoices/{id}/checkout-requests',method:'get',summary:'Bounded permitted immutable checkout intention history;no private review reason/source or claim of received money.',querySchema:paging},
 {path:'/api/v1/finance/checkout-requests/{id}',method:'get',summary:'Read original permitted intention,expiry,cancellation and replacement status. Metadata is not fresh dispatch authorization or a payment receipt.'},
 {path:'/api/v1/finance/checkout-requests/{id}/review',method:'get',summary:'Editor-only exact original invoice/account/source snapshot and private review reason,subject to current invoice/checkout rights.'},
 {path:'/api/v1/finance/checkout-requests/{id}/cancel',method:'post',summary:'Upper-human-reviewed immutable cancellation of an unused checkout intention;no external session expiration or refund is performed.',schema:cancel}
] as const;
export {row as permittedCheckoutRequest};
