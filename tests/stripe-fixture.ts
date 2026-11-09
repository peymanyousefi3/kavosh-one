import { randomUUID,createHmac } from 'node:crypto';
import { stripeSnapshotVersion,type StripeWebhookConnection } from '../src/integrations/stripe-webhook-config.ts';

export const stripeTestSecret='whsec_SyntheticEndpointSecret123456789';
export function paymentConnection(academyId=randomUUID()):StripeWebhookConnection{return {connectionId:randomUUID(),academyId,accountId:'acct_'+randomUUID().replaceAll('-',''),livemode:false,apiVersion:stripeSnapshotVersion,secrets:[stripeTestSecret]};}
export function paymentEvent(){return {id:'evt_'+randomUUID().replaceAll('-',''),object:'event',api_version:stripeSnapshotVersion,created:Math.floor(Date.now()/1000),livemode:false,type:'checkout.session.completed',data:{object:{id:'cs_test_'+randomUUID().replaceAll('-',''),object:'checkout.session',payment_status:'unpaid',amount_total:99999,metadata:{academyId:randomUUID()},customer_email:'PRIVATE@example.test'}}};}
export function stripeHeader(bytes:Uint8Array,secret=stripeTestSecret,timestamp=Math.floor(Date.now()/1000)){return `t=${timestamp},v1=${createHmac('sha256',secret).update(timestamp+'.').update(bytes).digest('hex')}`;}
