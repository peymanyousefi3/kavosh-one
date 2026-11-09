import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import Stripe from 'stripe';
import { verifiedStripeEvent,stripePaymentEventTypes } from '../src/integrations/stripe-event.ts';
import { configuredStripeWebhook,stripeConnectionTarget } from '../src/integrations/stripe-webhook-config.ts';
import { paymentConnection,paymentEvent,stripeHeader,stripeTestSecret } from './stripe-fixture.ts';

test('official SDK verifies exact bytes without credentials or network and extracts no card, money, customer or invoice claims',()=>{
 const c=paymentConnection(),value=paymentEvent(),bytes=Buffer.from(JSON.stringify(value)),header=Stripe.webhooks.generateTestHeaderString({payload:bytes.toString(),secret:stripeTestSecret});
 const p=verifiedStripeEvent(bytes,header,c);assert.equal(p.eventId,value.id);assert.equal(p.resourceId,value.data.object.id);assert.equal(p.payloadBytes,bytes.length);assert.doesNotMatch(JSON.stringify(p),/PRIVATE|customer|99999|academyId|paid|amount/);
 assert.throws(()=>verifiedStripeEvent(Buffer.from(JSON.stringify(value,null,2)),header,c),{code:'INVALID_STRIPE_SIGNATURE'});
 assert.equal(verifiedStripeEvent(bytes,header,{...c,secrets:['whsec_PreviousSyntheticSecret123456789',stripeTestSecret]}).eventId,value.id);
});
test('signature parser rejects missing, truncated, stale, future, duplicate and ambiguous timestamps without leaking payload',()=>{
 const c=paymentConnection(),bytes=Buffer.from(JSON.stringify(paymentEvent())),now=Date.now(),seconds=Math.floor(now/1000),valid=stripeHeader(bytes);
 for(const header of [null,'',valid.replace('v1=','v0='),valid.replace(/.$/,'Z'),stripeHeader(bytes,stripeTestSecret,seconds-301),stripeHeader(bytes,stripeTestSecret,seconds+301),valid+',t='+seconds,valid.replace('t='+seconds,'t='+seconds+'junk'),'x'.repeat(2049),valid+Array.from({length:8},()=>',v1='+'0'.repeat(64)).join('')])assert.throws(()=>verifiedStripeEvent(bytes,header,c,now),{code:'INVALID_STRIPE_SIGNATURE'});
 assert.equal(verifiedStripeEvent(bytes,valid+',v0=old,v1='+'0'.repeat(64),c,now).payloadBytes,bytes.length);
});
test('snapshot stream rejects wrong mode/version, connected-account and thin events, mismatched object types and future creation',()=>{
 const c=paymentConnection(),p=paymentEvent();
 for(const value of [{...p,livemode:true},{...p,api_version:'2024-01-01'},{...p,account:c.accountId},{...p,context:c.accountId},{...p,object:'v2.core.event'},{...p,type:'customer.created'},{...p,created:p.created+1000},{...p,data:{object:{id:'cs_live_synthetic',object:'checkout.session'}}},{...p,data:{object:{id:'pi_synthetic',object:'checkout.session'}}},{...p,type:'payment_intent.succeeded'},{...p,id:'not_provider_event'}]){
  const bytes=Buffer.from(JSON.stringify(value));assert.throws(()=>verifiedStripeEvent(bytes,stripeHeader(bytes),c));
 }
 const invalid=Buffer.from([0xff]);assert.throws(()=>verifiedStripeEvent(invalid,stripeHeader(invalid),c));
});
test('all accepted event types identify their exact supported provider object, without interpreting state or timestamp order',()=>{
 const c=paymentConnection();
 for(const type of stripePaymentEventTypes){
  const [object,id]=type.startsWith('checkout.')?['checkout.session','cs_test_123']:type.startsWith('payment_intent.')?['payment_intent','pi_123']:type.startsWith('charge.dispute.')?['dispute','dp_123']:type.startsWith('refund.')?['refund','re_123']:type.startsWith('payout.')?['payout','po_123']:['charge','ch_123'];
  const value={...paymentEvent(),type,data:{object:{object,id}}},bytes=Buffer.from(JSON.stringify(value));assert.equal(verifiedStripeEvent(bytes,stripeHeader(bytes),c).eventType,type);
 }
});
test('payment callback configuration is default-off, exact-versioned and forbids shared endpoints, keys or account streams',()=>{
 const c=paymentConnection(),env={STRIPE_WEBHOOK_ENABLED:'true',STRIPE_WEBHOOK_CONNECTIONS:JSON.stringify([c])};
 assert.equal(configuredStripeWebhook(c.connectionId,{}),null);assert.deepEqual(configuredStripeWebhook(c.connectionId,env),c);assert.equal(configuredStripeWebhook(randomUUID(),env),null);
 const rotated={...c,secrets:['rotated']};assert.equal(stripeConnectionTarget(c),stripeConnectionTarget(rotated));assert.notEqual(stripeConnectionTarget(c),stripeConnectionTarget({...c,academyId:randomUUID()}));
 for(const entries of [[c,c],[c,{...paymentConnection(),secrets:c.secrets}],[c,{...paymentConnection(),accountId:c.accountId,secrets:['whsec_OtherSyntheticSecret123456789']}],[{...c,apiVersion:'2024-01-01'}],[{...c,secrets:['REPLACE_ME']}],[{...c,secrets:[stripeTestSecret,stripeTestSecret]}],[{...c,apiKey:'forbidden'}]])assert.throws(()=>configuredStripeWebhook(c.connectionId,{...env,STRIPE_WEBHOOK_CONNECTIONS:JSON.stringify(entries)}),{code:'STRIPE_WEBHOOK_NOT_CONFIGURED'});
});
