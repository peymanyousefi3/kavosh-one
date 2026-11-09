import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { jsonBody } from '../core/api.ts';
import { parseBearer } from '../core/tokens.ts';
import { stripeCheckoutDraft,stripeCheckoutTransport,StripeCheckoutError,type StripeCheckoutConnection } from './stripe-checkout.ts';

const uuid=z.string().uuid().transform(v=>v.toLowerCase()),hash=z.string().regex(/^[a-f0-9]{64}$/);
const target=z.object({requestId:uuid,attemptId:uuid}).strict();
const source=z.object({data:z.object({id:uuid,requestId:uuid,sourceCurrent:z.literal(true),start:z.null(),draft:stripeCheckoutDraft,requestSha256:hash,requestBytes:z.number().int().min(1).max(16384),idempotencyKey:z.string()})});
const started=z.object({data:z.object({id:uuid,requestId:uuid,attemptId:uuid,state:z.literal('started'),providerVerified:z.literal(false)})});
export class CheckoutWorkerError extends Error{constructor(readonly stage:'configuration'|'source'|'preflight'|'start',readonly reconciliationRequired:boolean){super('CHECKOUT_WORKER_'+stage.toUpperCase()+'_FAILED');}}

// One explicitly selected,already reserved attempt. No polling,automatic
// activation,provider POST retries,caller money/URLs or private web credentials.
// A lost start response means NO provider call;the durable start must still be
// reconciled rather than granted again. Actor notes are not trusted receipts.
export async function executeCheckoutAttempt(raw:unknown,config:StripeCheckoutConnection,api:{origin:string;token:string},send:typeof fetch=fetch){
 const selected=target.safeParse(raw);let origin:URL;
 try{origin=new URL(api.origin);if(origin.origin!==api.origin||origin.protocol!=='https:'||origin.username||origin.password||origin.origin!==config.origin||!parseBearer('Bearer '+api.token))throw new Error();}catch{throw new CheckoutWorkerError('configuration',false);}
 if(!selected.success)throw new CheckoutWorkerError('configuration',false);
 const t=selected.data,base='/api/v1/finance/checkout-requests/'+t.requestId+'/attempts/'+t.attemptId;
 async function call(suffix:string,body?:unknown){
  const signal=AbortSignal.timeout(10_000),response=await send(api.origin+base+suffix,{method:body===undefined?'GET':'POST',redirect:'error',signal,headers:{authorization:'Bearer '+api.token,...body===undefined?{}:{'content-type':'application/json','idempotency-key':randomUUID()}},...body===undefined?{}:{body:JSON.stringify(body)}});
  if(response.redirected||response.url&&new URL(response.url).origin!==api.origin||!response.ok){void response.body?.cancel().catch(()=>{});throw new Error('BACKEND_UNAVAILABLE');}
  return jsonBody(new Request(api.origin,{method:'POST',headers:{'content-type':response.headers.get('content-type')??''},body:response.body,duplex:'half',signal} as RequestInit&{duplex:'half'}),32768);
 }
 let s:z.infer<typeof source>['data'];try{s=source.parse(await call('/source')).data;
  if(s.id!==t.attemptId||s.requestId!==t.requestId||s.draft.requestId!==t.requestId||s.idempotencyKey!=='kavosh-checkout-v1:'+config.academyId+':'+t.requestId)throw new Error();
 }catch{throw new CheckoutWorkerError('source',false);}
 let prepared:ReturnType<ReturnType<typeof stripeCheckoutTransport>['prepare']>;
 try{const transport=stripeCheckoutTransport(config,send);await transport.preflight();prepared=transport.prepare(s.draft,s);}catch{throw new CheckoutWorkerError('preflight',false);}
 // Only a newly committed exact start response permits THIS process to send.
 // Retries with another key or another process receive409 from the backend.
 try{const r=started.parse(await call('/dispatch',{requestSha256:s.requestSha256,requestBytes:s.requestBytes})).data;if(r.requestId!==t.requestId||r.attemptId!==t.attemptId)throw new Error();}catch{throw new CheckoutWorkerError('start',true);}
 let outcome:'accepted'|'not_attempted'|'rejected'|'outcome_unknown',session:Awaited<ReturnType<typeof prepared.dispatch>>['session']|null=null;
 try{const result=await prepared.dispatch();outcome=result.outcome;session=result.session;}
 catch(e){outcome=e instanceof StripeCheckoutError?e.outcome:'outcome_unknown';}
 let observationRecorded=false;
 try{const r=z.object({data:z.object({id:uuid,requestId:uuid,attemptId:uuid,state:z.string(),providerVerified:z.literal(false)})}).parse(await call('/dispatch/outcome',{state:outcome,...session?{sessionId:session.sessionId}:{}})).data;
  observationRecorded=r.requestId===t.requestId&&r.attemptId===t.attemptId&&r.state===outcome;
 }catch{/* Never resend the charge because an observation write failed. */}
 return {requestId:t.requestId,attemptId:t.attemptId,outcome,session,observationRecorded,reconciliationRequired:true as const,providerVerified:false as const,paymentVerified:false as const,ledgerAdjusted:false as const,automaticRetryAllowed:false as const};
}
