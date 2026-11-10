import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { jsonBody } from '../core/api.ts';
import { parseBearer } from '../core/tokens.ts';
import type { Database } from '../core/database.ts';
import { probeCheckoutResultSink,recordCheckoutTransportReceipt,recordCheckoutProviderInspection,recordCheckoutFeeInspection,recordCheckoutRefundInspection,recordCheckoutRefundReturnInspection,recordCheckoutDisputeInspection } from './checkout-result-worker.ts';
import { stripeCheckoutDraft,stripeCheckoutTransport,StripeCheckoutError,type StripeCheckoutConnection } from './stripe-checkout.ts';

const uuid=z.string().uuid().transform(v=>v.toLowerCase()),hash=z.string().regex(/^[a-f0-9]{64}$/);
const target=z.object({requestId:uuid,attemptId:uuid}).strict();
const source=z.object({data:z.object({id:uuid,requestId:uuid,sourceCurrent:z.literal(true),start:z.null(),draft:stripeCheckoutDraft,requestSha256:hash,requestBytes:z.number().int().min(1).max(16384),idempotencyKey:z.string()})});
const started=z.object({data:z.object({id:uuid,requestId:uuid,attemptId:uuid,state:z.literal('started'),providerVerified:z.literal(false)})});
const historicalSource=z.object({data:z.object({id:uuid,requestId:uuid,start:z.object({id:uuid}),draft:stripeCheckoutDraft,requestSha256:hash,requestBytes:z.number().int().min(1).max(16384)})});
type WorkerApi={origin:string;token:string;resultDatabase:Database;workerId:string};
export class CheckoutWorkerError extends Error{constructor(readonly stage:'configuration'|'source'|'preflight'|'start',readonly reconciliationRequired:boolean){super('CHECKOUT_WORKER_'+stage.toUpperCase()+'_FAILED');}}

// One explicitly selected,already reserved attempt. No polling,automatic
// activation,provider POST retries,caller money/URLs or private web credentials.
// A lost start response means NO provider call;the durable start must still be
// reconciled rather than granted again. Actor notes are not trusted receipts.
function workerContext(raw:unknown,config:StripeCheckoutConnection,api:WorkerApi,send:typeof fetch){
 const selected=target.safeParse(raw);let origin:URL;
 try{origin=new URL(api.origin);uuid.parse(api.workerId);if(!api.resultDatabase||origin.origin!==api.origin||origin.protocol!=='https:'||origin.username||origin.password||origin.origin!==config.origin||!parseBearer('Bearer '+api.token))throw new Error();}catch{throw new CheckoutWorkerError('configuration',false);}
 if(!selected.success)throw new CheckoutWorkerError('configuration',false);
 const t=selected.data,base='/api/v1/finance/checkout-requests/'+t.requestId+'/attempts/'+t.attemptId;
 async function call(suffix:string,body?:unknown){
  const signal=AbortSignal.timeout(10_000),response=await send(api.origin+base+suffix,{method:body===undefined?'GET':'POST',redirect:'error',signal,headers:{authorization:'Bearer '+api.token,...body===undefined?{}:{'content-type':'application/json','idempotency-key':randomUUID()}},...body===undefined?{}:{body:JSON.stringify(body)}});
  if(response.redirected||response.url&&new URL(response.url).origin!==api.origin||!response.ok){void response.body?.cancel().catch(()=>{});throw new Error('BACKEND_UNAVAILABLE');}
  return jsonBody(new Request(api.origin,{method:'POST',headers:{'content-type':response.headers.get('content-type')??''},body:response.body,duplex:'half',signal} as RequestInit&{duplex:'half'}),32768);
 }
 return {t,call};
}
export async function executeCheckoutAttempt(raw:unknown,config:StripeCheckoutConnection,api:WorkerApi,send:typeof fetch=fetch){
 const {t,call}=workerContext(raw,config,api,send);
 let s:z.infer<typeof source>['data'];try{s=source.parse(await call('/source')).data;
  if(s.id!==t.attemptId||s.requestId!==t.requestId||s.draft.requestId!==t.requestId||s.idempotencyKey!=='kavosh-checkout-v1:'+config.academyId+':'+t.requestId)throw new Error();
 }catch{throw new CheckoutWorkerError('source',false);}
 let prepared:ReturnType<ReturnType<typeof stripeCheckoutTransport>['prepare']>;
 try{await probeCheckoutResultSink(api.resultDatabase);const transport=stripeCheckoutTransport(config,send);await transport.preflight();prepared=transport.prepare(s.draft,s);}catch{throw new CheckoutWorkerError('preflight',false);}
 // Only a newly committed exact start response permits THIS process to send.
 // Retries with another key or another process receive409 from the backend.
 let startId:string;try{const r=started.parse(await call('/dispatch',{requestSha256:s.requestSha256,requestBytes:s.requestBytes})).data;if(r.requestId!==t.requestId||r.attemptId!==t.attemptId)throw new Error();startId=r.id;}catch{throw new CheckoutWorkerError('start',true);}
 let outcome:'accepted'|'not_attempted'|'rejected'|'outcome_unknown',session:Awaited<ReturnType<typeof prepared.dispatch>>['session']|null=null;
 let dispatchEntered=false;
 try{await probeCheckoutResultSink(api.resultDatabase,{academyId:config.academyId,startId,requestSha256:s.requestSha256});dispatchEntered=true;const result=await prepared.dispatch();outcome=result.outcome;session=result.session;}
 catch(e){outcome=!dispatchEntered?'not_attempted':e instanceof StripeCheckoutError?e.outcome:'outcome_unknown';}
 let transportReceiptRecorded=false,transportConflict=false;
 try{const r=await recordCheckoutTransportReceipt(api.resultDatabase,{academyId:config.academyId,startId,workerId:api.workerId,requestSha256:s.requestSha256,state:outcome,...session?{sessionId:session.sessionId,checkoutUrl:session.checkoutUrl}:{}});transportReceiptRecorded=r.recorded;transportConflict=r.conflict;}catch{/* Recover this WRITE independently;never resend the provider request. */}
 let observationRecorded=false;
 try{const r=z.object({data:z.object({id:uuid,requestId:uuid,attemptId:uuid,state:z.string(),providerVerified:z.literal(false)})}).parse(await call('/dispatch/outcome',{state:outcome,...session?{sessionId:session.sessionId}:{}})).data;
  observationRecorded=r.requestId===t.requestId&&r.attemptId===t.attemptId&&r.state===outcome;
 }catch{/* Never resend the charge because an observation write failed. */}
 return {requestId:t.requestId,attemptId:t.attemptId,startId,outcome,session,transportReceiptRecorded,transportConflict,observationRecorded,reconciliationRequired:true as const,providerVerified:false as const,paymentVerified:false as const,ledgerAdjusted:false as const,automaticRetryAllowed:false as const};
}
async function recoveryContext(raw:unknown,config:StripeCheckoutConnection,api:WorkerApi,send:typeof fetch){
 const {t,call}=workerContext(raw,config,api,send);let s:z.infer<typeof historicalSource>['data'];
 try{s=historicalSource.parse(await call('/source')).data;if(s.id!==t.attemptId||s.requestId!==t.requestId||s.draft.requestId!==t.requestId)throw new Error();await probeCheckoutResultSink(api.resultDatabase,{academyId:config.academyId,startId:s.start.id,requestSha256:s.requestSha256});}catch{throw new CheckoutWorkerError('source',true);}
 return {t,s,transport:stripeCheckoutTransport(config,send)};
}
export async function discoverCheckoutAttempt(raw:unknown,window:unknown,config:StripeCheckoutConnection,api:WorkerApi,send:typeof fetch=fetch){
 const {s,transport}=await recoveryContext(raw,config,api,send);return transport.discover(s.draft,window);
}
export async function reconcileCheckoutAttempt(raw:unknown,sessionId:string,config:StripeCheckoutConnection,api:WorkerApi,send:typeof fetch=fetch){
 const {t,s,transport}=await recoveryContext(raw,config,api,send),inspection=await transport.inspect(s.draft,sessionId),id=randomUUID();
 const receipt=await recordCheckoutProviderInspection(api.resultDatabase,{academyId:config.academyId,id,startId:s.start.id,workerId:api.workerId,requestSha256:s.requestSha256,inspection});
 return {requestId:t.requestId,attemptId:t.attemptId,startId:s.start.id,inspection,...receipt};
}
export async function inspectCheckoutFees(raw:unknown,sessionId:string,config:StripeCheckoutConnection,api:WorkerApi,send:typeof fetch=fetch){
 const {t,s,transport}=await recoveryContext(raw,config,api,send),principalId=randomUUID(),id=randomUUID();
 // Persist principal review facts FIRST. Fee-only reads must not lose a newly
 // discovered refund/dispute and leave previously available credit spendable.
 const evidence=await transport.inspectFees(s.draft,sessionId,async inspection=>{
  const principal=await recordCheckoutProviderInspection(api.resultDatabase,{academyId:config.academyId,id:principalId,startId:s.start.id,workerId:api.workerId,requestSha256:s.requestSha256,inspection});
  if(!principal.recorded)throw new CheckoutWorkerError('source',true);
 });
 const receipt=await recordCheckoutFeeInspection(api.resultDatabase,{academyId:config.academyId,id,startId:s.start.id,principalInspectionId:principalId,workerId:api.workerId,requestSha256:s.requestSha256,fees:evidence.fees});
 return {requestId:t.requestId,attemptId:t.attemptId,startId:s.start.id,principalInspectionId:principalId,fees:evidence.fees,...receipt};
}
export async function inspectCheckoutRefunds(raw:unknown,sessionId:string,after:string|null,config:StripeCheckoutConnection,api:WorkerApi,send:typeof fetch=fetch){
 const {t,s,transport}=await recoveryContext(raw,config,api,send),principalId=randomUUID(),id=randomUUID();
 const evidence=await transport.inspectRefunds(s.draft,sessionId,after,async inspection=>{
  const principal=await recordCheckoutProviderInspection(api.resultDatabase,{academyId:config.academyId,id:principalId,startId:s.start.id,workerId:api.workerId,requestSha256:s.requestSha256,inspection});if(!principal.recorded)throw new CheckoutWorkerError('source',true);
 });
 const receipt=await recordCheckoutRefundInspection(api.resultDatabase,{academyId:config.academyId,id,startId:s.start.id,principalInspectionId:principalId,workerId:api.workerId,requestSha256:s.requestSha256,page:evidence.page});return {requestId:t.requestId,attemptId:t.attemptId,startId:s.start.id,principalInspectionId:principalId,requestSha256:s.requestSha256,page:evidence.page,...receipt};
}
export async function inspectCheckoutDisputes(raw:unknown,sessionId:string,after:string|null,config:StripeCheckoutConnection,api:WorkerApi,send:typeof fetch=fetch){
 const {t,s,transport}=await recoveryContext(raw,config,api,send),principalId=randomUUID(),id=randomUUID();
 const evidence=await transport.inspectDisputes(s.draft,sessionId,after,async inspection=>{
  const principal=await recordCheckoutProviderInspection(api.resultDatabase,{academyId:config.academyId,id:principalId,startId:s.start.id,workerId:api.workerId,requestSha256:s.requestSha256,inspection});if(!principal.recorded)throw new CheckoutWorkerError('source',true);
 });
 const receipt=await recordCheckoutDisputeInspection(api.resultDatabase,{academyId:config.academyId,id,startId:s.start.id,principalInspectionId:principalId,workerId:api.workerId,requestSha256:s.requestSha256,page:evidence.page});return {requestId:t.requestId,attemptId:t.attemptId,startId:s.start.id,principalInspectionId:principalId,page:evidence.page,...receipt};
}
export async function inspectCheckoutRefundReturn(raw:unknown,sessionId:string,refundId:string,after:string|null,config:StripeCheckoutConnection,api:WorkerApi,send:typeof fetch=fetch){
 // Persist the verified principal AND entire actual refund page first. A
 // balance lookup failure must not lose new warnings or invent a complete page.
 const page=await inspectCheckoutRefunds(raw,sessionId,after,config,api,send);if(!page.recorded)throw new CheckoutWorkerError('source',true);const evidence=await stripeCheckoutTransport(config,send).inspectRefundReturn(page.page,refundId),receipt=await recordCheckoutRefundReturnInspection(api.resultDatabase,{academyId:config.academyId,id:randomUUID(),startId:page.startId,refundInspectionId:page.id,workerId:api.workerId,requestSha256:page.requestSha256,evidence});
 return {requestId:page.requestId,attemptId:page.attemptId,startId:page.startId,refundInspectionId:page.id,evidence,...receipt};
}
