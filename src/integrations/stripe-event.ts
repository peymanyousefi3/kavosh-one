import Stripe from 'stripe';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { ApiError } from '../core/policy.ts';
import { stripeSnapshotVersion,type StripeWebhookConnection } from './stripe-webhook-config.ts';

const objectTypes={
 'checkout.session.completed':'checkout.session','checkout.session.async_payment_succeeded':'checkout.session','checkout.session.async_payment_failed':'checkout.session','checkout.session.expired':'checkout.session',
 'payment_intent.succeeded':'payment_intent','payment_intent.payment_failed':'payment_intent','payment_intent.canceled':'payment_intent',
 'charge.refunded':'charge','refund.created':'refund','refund.updated':'refund','refund.failed':'refund',
 'charge.dispute.created':'dispute','charge.dispute.updated':'dispute','charge.dispute.closed':'dispute',
 'payout.paid':'payout','payout.failed':'payout','payout.canceled':'payout'
} as const;
export const stripePaymentEventTypes=Object.keys(objectTypes) as [keyof typeof objectTypes,...(keyof typeof objectTypes)[]];
const ids:Record<typeof objectTypes[keyof typeof objectTypes],RegExp>={
 'checkout.session':/^cs_(test|live)_[A-Za-z0-9]{1,200}$/,payment_intent:/^pi_[A-Za-z0-9]{1,200}$/,charge:/^ch_[A-Za-z0-9]{1,200}$/,refund:/^re_[A-Za-z0-9]{1,200}$/,dispute:/^dp_[A-Za-z0-9]{1,200}$/,payout:/^po_[A-Za-z0-9]{1,200}$/
};
// Discard card/customer/contact/metadata and all monetary claims here. A worker
// must retrieve and bind the original object to a server-created checkout before
// proposing any accounting effect. Completed checkout is NOT proof of payment.
export const stripeWebhookBody=z.object({id:z.string().regex(/^evt_[A-Za-z0-9]{1,200}$/),object:z.literal('event'),api_version:z.literal(stripeSnapshotVersion),created:z.number().int().min(0).max(Number.MAX_SAFE_INTEGER-300),livemode:z.boolean(),account:z.null().optional(),context:z.null().optional(),type:z.enum(stripePaymentEventTypes),data:z.object({object:z.object({id:z.string().max(220),object:z.enum(['checkout.session','payment_intent','charge','refund','dispute','payout'])})})}).describe('Original UTF-8 snapshot JSON bytes, at most 1 MiB. Required Stripe-Signature authenticates the configured account-level endpoint. Unknown provider data is discarded; no payment or ledger status is changed.');

export function verifiedStripeEvent(bytes:Uint8Array,header:string|null,c:StripeWebhookConnection,now=Date.now()){
 const invalid=()=>new ApiError(401,'INVALID_STRIPE_SIGNATURE');
 if(!header||header.length>2048)throw invalid();
 const fields=header.split(','),times=fields.filter(v=>v.startsWith('t=')),signatures=fields.filter(v=>v.startsWith('v1='));
 if(times.length!==1||!/^t=[1-9]\d{0,12}$/.test(times[0])||signatures.length<1||signatures.length>8||signatures.some(v=>!/^v1=[a-f0-9]{64}$/.test(v)))throw invalid();
 const signed=Number(times[0].slice(2));
 // The SDK checks old timestamps but accepts future ones. Bound both directions
 // before verification, and reject ambiguous or parseInt-truncated timestamps.
 if(!Number.isSafeInteger(signed)||Math.abs(Math.floor(now/1000)-signed)>300)throw invalid();
 let authentic=false;
 for(const secret of c.secrets){try{Stripe.webhooks.constructEvent(bytes,header,secret,300,undefined,now);authentic=true;break;}catch{/* Do not log SDK errors: they can contain the raw private payload. */}}
 if(!authentic)throw invalid();
 let raw:unknown;try{raw=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{throw new ApiError(400,'INVALID_STRIPE_EVENT');}
 const p=stripeWebhookBody.parse(raw),resource=p.data.object;
 if(p.livemode!==c.livemode||p.api_version!==c.apiVersion||p.created>signed+300||resource.object!==objectTypes[p.type]||!ids[resource.object].test(resource.id)||resource.object==='checkout.session'&&!resource.id.startsWith(c.livemode?'cs_live_':'cs_test_'))throw new ApiError(400,'STRIPE_STREAM_MISMATCH');
 return {eventId:p.id,eventCreated:p.created,signatureTimestamp:signed,eventType:p.type,objectType:resource.object,resourceId:resource.id,payloadSha256:createHash('sha256').update(bytes).digest('hex'),payloadBytes:bytes.byteLength};
}
