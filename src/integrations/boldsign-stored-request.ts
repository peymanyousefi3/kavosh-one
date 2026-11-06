import type { S3ClientConfig } from '@aws-sdk/client-s3';
import { z } from 'zod';
import { ApiError } from '../core/policy.ts';
import { r2Connection,r2TargetId,type R2Connection } from './r2-config.ts';
import { privateR2 } from './r2.ts';
import { boldSignSendDraftSchema,boldSignWorkSendDraftSchema,buildBoldSignSendRequest,buildBoldSignWorkSendRequest } from './boldsign-send-request.ts';

const uuid=z.string().uuid().transform(v=>v.toLowerCase()),digest=z.string().regex(/^[a-f0-9]{64}$/);
const original=z.object({academyId:uuid,fileId:uuid,fileVersion:z.number().int().positive().max(2147483647),copyId:uuid,sourceFingerprint:digest,storageTargetId:digest,bytes:z.number().int().min(9).max(10_485_760),sha256:digest,etag:z.string().min(3).max(202).regex(/^"[\x21\x23-\x7e]+"$/)}).strict();
export const boldSignStoredOriginalSchema=original;
const request=z.discriminatedUnion('purpose',[
 z.object({purpose:z.literal('unified_enrollment'),draft:boldSignSendDraftSchema}).strict(),
 z.object({purpose:z.literal('worker_services'),draft:boldSignWorkSendDraftSchema}).strict()
]);
const settings=z.object({timeoutMs:z.number().int().min(1).max(120000).default(30000),signal:z.instanceof(AbortSignal).optional()}).strict();
let active=0;

// Internal IO preparation,NOT authorization or a malware/legal-safety boundary.
// Caller must supply current tenant/scoped reviewed source and permanent copy
// evidence,then reauthorize AFTER this IO and durably reserve/consume once.
// Never store/log/return the private body through a public or cached receipt.
// No database connection,provider API key,send,write,retry or daemon is involved.
export async function prepareStoredBoldSignRequest(configuration:R2Connection,raw:unknown,source:unknown,options:z.input<typeof settings>={},handler?:S3ClientConfig['requestHandler']) {
 const configured=r2Connection.safeParse(configuration),selected=request.safeParse(raw),expected=original.safeParse(source),limits=settings.safeParse(options);
 if(!configured.success||!selected.success||!expected.success||!limits.success)throw new ApiError(400,'INVALID_BOLDSIGN_STORED_REQUEST');
 const i=selected.data,s=expected.data,c=configured.data,o=limits.data;
 if(s.bytes>c.maximumUploadBytes||r2TargetId(c)!==s.storageTargetId)throw new ApiError(400,'INVALID_BOLDSIGN_ORIGINAL_TARGET');
 if(i.draft.document.sha256!==s.sha256||i.draft.document.sizeBytes!==s.bytes)throw new ApiError(409,'BOLDSIGN_ORIGINAL_IDENTITY_MISMATCH');
 if(o.signal?.aborted)throw new ApiError(503,'BOLDSIGN_ORIGINAL_CANCELLED');
 // ponytail: two concurrent preparations of at most10MiB originals per process.
 // Returned private request bodies belong to the caller,which must bound its
 // own queue;larger/streaming signing inputs need a separate bounded spool.
 if(active>=2)throw new ApiError(503,'BOLDSIGN_ORIGINAL_BUSY');
 const storage=privateR2(c,s.academyId,handler),deadline=Date.now()+o.timeoutMs;let resources:Promise<unknown>|undefined,readCompleted=false;active++;
 try{
  const read=await storage.inspectClean(s.fileId,{bytes:s.bytes,sha256:s.sha256,ifMatch:s.etag},async(stream,signal)=>{
   const buffer=Buffer.alloc(s.bytes);let used=0;
   for await(const chunk of stream){if(signal.aborted||used+chunk.length>buffer.length)throw new ApiError(409,'FILE_SIZE_MISMATCH');used+=chunk.copy(buffer,used);}
   if(used!==buffer.length)throw new ApiError(409,'FILE_SIZE_MISMATCH');return buffer;
  },o.timeoutMs,o.signal,settled=>{resources=settled;});readCompleted=true;
  if(o.signal?.aborted)throw new ApiError(503,'BOLDSIGN_ORIGINAL_CANCELLED');
  if(Date.now()>deadline)throw new ApiError(503,'BOLDSIGN_ORIGINAL_TIMEOUT');
  const prepared=i.purpose==='worker_services'?buildBoldSignWorkSendRequest(i.draft,read.inspection):buildBoldSignSendRequest(i.draft,read.inspection);
  if(Date.now()>deadline)throw new ApiError(503,'BOLDSIGN_ORIGINAL_TIMEOUT');
  return {...prepared,original:{...s,storageTargetId:storage.storageTargetId,bytes:read.bytes,sha256:read.sha256,etag:read.provider.etag},
   originalBytesMeasured:true as const,fileSafetyCleared:false as const,storageReadPerformed:true as const,signingProviderRequestMade:false as const};
 }catch(error){
  if(error instanceof ApiError){
   if(['FILE_SIZE_MISMATCH','FILE_HASH_MISMATCH','FILE_ETAG_MISMATCH','BOLDSIGN_DOCUMENT_IDENTITY_MISMATCH'].includes(error.code))throw new ApiError(409,'BOLDSIGN_ORIGINAL_IDENTITY_MISMATCH');
   if(error.code==='R2_INSPECTION_CANCELLED'||o.signal?.aborted)throw new ApiError(503,'BOLDSIGN_ORIGINAL_CANCELLED');
   if(error.code==='R2_INSPECTION_TIMEOUT')throw new ApiError(503,'BOLDSIGN_ORIGINAL_TIMEOUT');
   if(['BOLDSIGN_ORIGINAL_CANCELLED','BOLDSIGN_ORIGINAL_TIMEOUT','BOLDSIGN_ROUTING_UNSUPPORTED','BOLDSIGN_REQUEST_TOO_LARGE','INDEPENDENT_WORK_SIGNERS_REQUIRED','INVALID_BOLDSIGN_SIGNER_PHONE'].includes(error.code))throw error;
  }
  throw new ApiError(503,'BOLDSIGN_ORIGINAL_UNAVAILABLE');
 }finally{
  storage.close();
  if(readCompleted){await resources;active--;}
  else if(resources){void resources.then(()=>{active--;},()=>{active--;});}
  else active--;
 }
}
