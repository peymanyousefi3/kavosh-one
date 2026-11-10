import { isDeepStrictEqual } from 'node:util';
import type { S3ClientConfig } from '@aws-sdk/client-s3';
import { z } from 'zod';
import { ApiError } from '../core/policy.ts';
import type { Database } from '../core/database.ts';
import type { SigningControlApi } from './signing-control-api.ts';
import { boldSignConnectionSchema,submitBoldSignWireRequest,type BoldSignConnection,type BoldSignSubmissionOutcome } from './boldsign.ts';
import { boldSignSendDraftSchema,boldSignWorkSendDraftSchema } from './boldsign-send-request.ts';
import { boldSignStoredOriginalSchema,prepareStoredBoldSignRequest } from './boldsign-stored-request.ts';
import type { R2DownloadConnections } from './r2-config.ts';
import { probeSignatureResultSink,recordSignatureTransportReceipt } from './signature-result-worker.ts';

const uuid=z.string().uuid().transform(v=>v.toLowerCase()),hash=z.string().regex(/^[a-f0-9]{64}$/);
const taskSchema=z.object({academyId:uuid,requestId:uuid,copyId:uuid,workerId:uuid,attemptKey:uuid,startKey:uuid}).strict().refine(v=>v.attemptKey!==v.startKey);
const settings=z.object({enabled:z.boolean().default(false),dualOtpAccountAttested:z.boolean().default(false),signal:z.instanceof(AbortSignal).optional()}).strict();
const sourceSchema=z.object({data:z.object({draft:boldSignSendDraftSchema,original:boldSignStoredOriginalSchema,originalEvidenceAvailable:z.literal(true),connection:z.object({id:uuid,targetId:hash,region:z.enum(['US','CA','EU','AU'])}).strict()})});
const intention=z.object({data:z.object({id:uuid,attempt_id:uuid.nullable(),dispatch_id:uuid.nullable()})});
const workIntention=z.object({data:z.object({id:uuid,attemptId:uuid.nullable(),dispatchId:uuid.nullable()}).transform(v=>({id:v.id,attempt_id:v.attemptId,dispatch_id:v.dispatchId}))});
const workSourceSchema=sourceSchema.extend({data:sourceSchema.shape.data.extend({draft:boldSignWorkSendDraftSchema})});
const attempt=z.object({id:uuid,request_sha256:hash,request_bytes:z.number().int().min(1).max(16_777_216),document_sha256:hash});
const startSchema=z.object({data:z.object({id:uuid,attempt_id:uuid,original_copy_id:uuid,original_source_fingerprint:hash,originalCopyBound:z.literal(true),state:z.literal('started'),externalRequestMade:z.literal(false)})});
const noAttempt:BoldSignSubmissionOutcome={state:'not_attempted',automaticRetryAllowed:false,reconciliationRequired:false,deliveryVerified:false};
let active=0;
type Services={api:SigningControlApi;resultDatabase:Database;readers:R2DownloadConnections;providers:(academyId:string,connectionId:string,targetId:string)=>BoldSignConnection|null;providerFetch?:typeof fetch;storageHandler?:S3ClientConfig['requestHandler']};

// Internal operator-controlled workflow only. No route/daemon/environment
// activation. An account attestation is NOT live verification/legal clearance.
// Native one-use start is mandatory;no provider retry or private body in output.
async function processSigning(purpose:'unified_enrollment'|'worker_services',raw:unknown,services:Services,options:z.input<typeof settings>={}){
 const parsed=taskSchema.safeParse(raw),configured=settings.safeParse(options);if(!parsed.success||!configured.success)throw new ApiError(400,'INVALID_SIGNING_TASK');const t=parsed.data,o=configured.data;
 const work=purpose==='worker_services',sources=work?workSourceSchema:sourceSchema;
 const result=(state:string,extra:{sendAttempted:boolean;receiptStored:boolean;reconciliationRequired:boolean;startId?:string;attemptId?:string})=>({state,scope:'this_run',automaticRetryAllowed:false,deliveryVerified:false,providerVerified:false,admissionCleared:false,...work?{signedByBothParties:false,legallyEffective:false,paymentCleared:false}:{},...extra});
 if(!o.enabled||!o.dualOtpAccountAttested)return result('disabled',{sendAttempted:false,receiptStored:false,reconciliationRequired:false});
 if(o.signal?.aborted)return result('not_started',{sendAttempted:false,receiptStored:false,reconciliationRequired:false});
 if(active>=2)return result('busy',{sendAttempted:false,receiptStored:false,reconciliationRequired:false});
 active++;let resources:Promise<unknown>|undefined,startId:string|undefined,claimed=false,sendAttempted=false;
 try{
  if(services.api.academyId!==t.academyId||services.api.purpose!==purpose)throw new ApiError(400,'SIGNING_ACADEMY_OR_PURPOSE_MISMATCH');
  const before=(work?workIntention:intention).parse(await services.api.intention(t.requestId,o.signal)).data;
  if(before.id!==t.requestId)throw new Error('WRONG_INTENTION');
  if(before.dispatch_id)return result('already_started',{sendAttempted:false,receiptStored:false,reconciliationRequired:true});
  await probeSignatureResultSink(services.resultDatabase,undefined,purpose);
  const source=sources.parse(await services.api.source(t.requestId,t.copyId,o.signal)).data;
  if(source.original.academyId!==t.academyId||source.original.copyId!==t.copyId)throw new Error('WRONG_SOURCE');
  // Guardian contacts may be previewed and reserved,but the complete original
  // three-party completion/review protocol is not enabled yet. No storage or
  // provider IO,even if an operator attests the account settings.
  if(work&&source.draft.routing.version===3)return result('guardian_dispatch_disabled',{sendAttempted:false,receiptStored:false,reconciliationRequired:false});
  const provider=boldSignConnectionSchema.safeParse(services.providers(t.academyId,source.connection.id,source.connection.targetId));
  if(!provider.success||provider.data.region!==source.connection.region)throw new Error('PROVIDER_NOT_CONFIGURED');
  const reader=services.readers(t.academyId,source.original.storageTargetId);if(!reader)throw new Error('READER_NOT_CONFIGURED');
  const prepared=await prepareStoredBoldSignRequest(reader,{purpose,draft:source.draft},source.original,{signal:o.signal},services.storageHandler);
  const current=sources.parse(await services.api.source(t.requestId,t.copyId,o.signal)).data;
  if(!isDeepStrictEqual(source,current))return result('source_changed',{sendAttempted:false,receiptStored:false,reconciliationRequired:false});
  const manifest={requestSha256:prepared.receipt.requestSha256,requestBytes:prepared.receipt.requestBytes,documentSha256:prepared.receipt.documentSha256};let attemptId=before.attempt_id;
  if(!attemptId){try{attemptId=z.object({data:z.object({id:uuid})}).parse(await services.api.reserve(t.requestId,manifest,t.attemptKey,o.signal)).data.id;}
   catch(error){if(!(error instanceof ApiError)||error.code!==(work?'WORK_SIGNATURE_ATTEMPT_ALREADY_RESERVED':'SIGNATURE_ATTEMPT_ALREADY_RESERVED'))throw error;}}
  // Resume a prior reservation only when its ACTUAL immutable manifest is the
  // exact body just rebuilt;never trust an arbitrary cached attempt identifier.
  const attempts=z.object({data:z.array(attempt).max(1)}).parse(await services.api.attempts(t.requestId,o.signal)).data,existing=attempts[0];
  if(!existing||(attemptId&&existing.id!==attemptId)||existing.request_sha256!==manifest.requestSha256||existing.request_bytes!==manifest.requestBytes||existing.document_sha256!==manifest.documentSha256)return result('reservation_mismatch',{sendAttempted:false,receiptStored:false,reconciliationRequired:true});
  attemptId=existing.id;
  let receipt:unknown;try{receipt=await services.api.start(t.requestId,attemptId,{...manifest,original:{copyId:t.copyId,sourceFingerprint:source.original.sourceFingerprint}},t.startKey,o.signal);}
  catch{return result('start_uncertain',{sendAttempted:false,receiptStored:false,reconciliationRequired:true});}
  const checked=startSchema.safeParse(receipt);if(!checked.success)return result('start_uncertain',{sendAttempted:false,receiptStored:false,reconciliationRequired:true});
  const start=checked.data.data;if(start.attempt_id!==attemptId||start.original_copy_id!==t.copyId||start.original_source_fingerprint!==source.original.sourceFingerprint)return result('start_uncertain',{sendAttempted:false,receiptStored:false,reconciliationRequired:true});
  startId=start.id;claimed=true;let outcome:BoldSignSubmissionOutcome=noAttempt;
  try{
   await probeSignatureResultSink(services.resultDatabase,{academyId:t.academyId,startId,sourceFingerprint:source.original.sourceFingerprint},purpose);
   const latest=sources.parse(await services.api.source(t.requestId,t.copyId,o.signal)).data;
   const connection=boldSignConnectionSchema.safeParse(services.providers(t.academyId,source.connection.id,source.connection.targetId));
   if(isDeepStrictEqual(source,latest)&&connection.success&&connection.data.region===source.connection.region&&!o.signal?.aborted){
    outcome=await submitBoldSignWireRequest(Object.freeze({...connection.data}),prepared.body,services.providerFetch??fetch,o.signal,settled=>{resources=settled;});
   }
  }catch{/* Claimed but not invoked;retain no-attempt through the isolated sink. */}
  sendAttempted=outcome.state!=='not_attempted';
  try{const stored=await recordSignatureTransportReceipt(services.resultDatabase,{academyId:t.academyId,startId,workerId:t.workerId,outcome,purpose});
   return result(!stored.recorded?'receipt_pending':stored.conflict?'reconciliation_required':outcome.state,{startId,attemptId,sendAttempted,receiptStored:stored.recorded,reconciliationRequired:stored.reconciliationRequired});
  }catch{return result('receipt_pending',{startId,attemptId,sendAttempted,receiptStored:false,reconciliationRequired:true});}
 }catch{return result(claimed?'receipt_pending':'not_started',{...startId?{startId}:{},sendAttempted,receiptStored:false,reconciliationRequired:claimed});}
 finally{if(resources)void resources.then(()=>{active--;},()=>{active--;});else active--;}
}
export const processEnrollmentSigning=(raw:unknown,services:Services,options:z.input<typeof settings>={})=>processSigning('unified_enrollment',raw,services,options);
export const processWorkSigning=(raw:unknown,services:Services,options:z.input<typeof settings>={})=>processSigning('worker_services',raw,services,options);
