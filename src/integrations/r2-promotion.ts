import { S3Client,PutObjectCommand,type S3ClientConfig } from '@aws-sdk/client-s3';
import { z } from 'zod';
import { ApiError } from '../core/policy.ts';
import { r2Connection,type R2Connection } from './r2-config.ts';
import { privateR2 } from './r2.ts';

const digest=z.string().regex(/^[a-f0-9]{64}$/),uuid=z.string().uuid().transform(v=>v.toLowerCase());
const claims=z.object({academyId:uuid,fileId:uuid,storageTargetId:digest,bytes:z.number().int().min(1).max(33_554_432),sha256:digest}).strict();
const optionsSchema=z.object({timeoutMs:z.number().int().min(1).max(600000).default(120000),signal:z.instanceof(AbortSignal).optional()}).strict();
let active=0;

// Internal IO adapter,NOT an authorization/scan/approval boundary. Durable
// source approval and current scoped download authorization remain separate.
// Use distinct bucket-scoped credentials: quarantine signer cannot write clean
// content,and public/download processes must not receive promotion credentials.
// No route,daemon,environment reader,automatic retry,delete or URL is provided.
export async function promoteQuarantinedFile(sourceConfiguration:R2Connection,destinationConfiguration:R2Connection,input:z.input<typeof claims>,options:z.input<typeof optionsSchema>={},handlers?:{source?:S3ClientConfig['requestHandler'];destination?:S3ClientConfig['requestHandler']}){
 const sourceConfig=r2Connection.safeParse(sourceConfiguration),destinationConfig=r2Connection.safeParse(destinationConfiguration),parsed=claims.safeParse(input),settings=optionsSchema.safeParse(options);
 if(!sourceConfig.success||!destinationConfig.success||!parsed.success||!settings.success)throw new ApiError(400,'INVALID_FILE_PROMOTION_CONFIGURATION');
 const c=destinationConfig.data,expected=parsed.data,limits=settings.data;
 if(expected.bytes>sourceConfig.data.maximumUploadBytes||expected.bytes>c.maximumUploadBytes)throw new ApiError(400,'INVALID_FILE_PROMOTION_CONFIGURATION');
 if(limits.signal?.aborted)throw new ApiError(503,'FILE_PROMOTION_CANCELLED');
 // ponytail: at most two 32 MiB broker-owned copy buffers per process. Larger media needs
 // separately bounded spool/streaming verification,not an unbounded Buffer.
 if(active>=2)throw new ApiError(503,'FILE_PROMOTION_BUSY');
 const source=privateR2(sourceConfig.data,expected.academyId,handlers?.source),destination=privateR2(c,expected.academyId,handlers?.destination);
 if(source.storageTargetId!==expected.storageTargetId||source.storageTargetId===destination.storageTargetId){source.close();destination.close();throw new ApiError(400,'INVALID_FILE_PROMOTION_TARGET');}
 const client=new S3Client({endpoint:`https://${c.accountId}${c.jurisdiction==='eu'?'.eu':''}.r2.cloudflarestorage.com`,region:'auto',forcePathStyle:true,followRegionRedirects:false,maxAttempts:1,
  credentials:{accessKeyId:c.accessKeyId,secretAccessKey:c.secretAccessKey},requestChecksumCalculation:'WHEN_REQUIRED',responseChecksumValidation:'WHEN_REQUIRED',...(handlers?.destination?{requestHandler:handlers.destination}:{})});
 const controller=new AbortController();let expired=false,writeAttempted=false,stop!:(error:ApiError)=>void;
 const halted=new Promise<never>((_resolve,reject)=>{stop=reject;});
 const cancel=()=>{controller.abort();stop(new ApiError(503,'FILE_PROMOTION_CANCELLED'));};
 const timer=setTimeout(()=>{expired=true;controller.abort();stop(new ApiError(503,'FILE_PROMOTION_TIMEOUT'));},limits.timeoutMs);
 limits.signal?.addEventListener('abort',cancel,{once:true});active++;
 try{
  const operation=async()=>{
   if(limits.signal?.aborted){cancel();throw new Error('CANCELLED');}
   const original=await source.inspectQuarantine(expected.fileId,{bytes:expected.bytes,sha256:expected.sha256},async stream=>{
    const buffer=Buffer.alloc(expected.bytes);let used=0;for await(const chunk of stream){if(controller.signal.aborted||used+chunk.length>buffer.length)throw new Error('INVALID_SOURCE');used+=chunk.copy(buffer,used);}if(used!==buffer.length)throw new Error('INVALID_SOURCE');return buffer;
   },limits.timeoutMs,controller.signal);
   if(controller.signal.aborted)throw new Error('CANCELLED');
   let existed=false;
   try{
    writeAttempted=true;
    // Cloudflare documents atomic PutObject If-None-Match across concurrent
    // writes. CopyObject's source condition does not protect a destination.
    // https://developers.cloudflare.com/r2/api/s3/extensions/
    await client.send(new PutObjectCommand({Bucket:c.bucket,Key:`academies/${expected.academyId}/clean/${expected.fileId}`,Body:original.inspection,ContentLength:expected.bytes,
     ContentType:'application/octet-stream',ContentDisposition:'attachment',CacheControl:'private, no-store',IfNoneMatch:'*'}),{abortSignal:controller.signal});
   }catch(error){
    if(error&&typeof error==='object'&&'$metadata' in error&&(error.$metadata as {httpStatusCode?:unknown})?.httpStatusCode===412)existed=true;
    else throw error;
   }
   if(controller.signal.aborted)throw new Error('CANCELLED');
   // Neither PUT success,ETag nor custom checksum metadata proves stored bytes.
   // Existing destinations are read and verified too;never overwrite or delete
   // a mismatch. A negative read after an unknown PUT is NOT failure finality.
   const verified=await destination.inspectClean(expected.fileId,{bytes:expected.bytes,sha256:expected.sha256},async stream=>{for await(const _chunk of stream){if(controller.signal.aborted)throw new Error('CANCELLED');}return true;},limits.timeoutMs,controller.signal);
   return {outcome:existed?'existing_verified' as const:'written_verified' as const,bytes:verified.bytes,sha256:verified.sha256,
    source:{storageTargetId:source.storageTargetId,etag:original.provider.etag},destination:{storageTargetId:destination.storageTargetId,etag:verified.provider.etag}};
  };
  const pending=operation();
  // A deadline rejects the caller,not an uncooperative transport's pending
  // write. Retain its memory/admission reservation until actual settlement so
  // repeated cancellation cannot accumulate unbounded 32 MiB request bodies.
  void pending.then(()=>{active--;},()=>{active--;});
  return await Promise.race([pending,halted]);
 }catch(error){
  if(limits.signal?.aborted)throw new ApiError(503,writeAttempted?'FILE_PROMOTION_OUTCOME_UNKNOWN':'FILE_PROMOTION_CANCELLED');
  if(expired)throw new ApiError(503,writeAttempted?'FILE_PROMOTION_OUTCOME_UNKNOWN':'FILE_PROMOTION_TIMEOUT');
  if(error instanceof ApiError&&['FILE_HASH_MISMATCH','FILE_SIZE_MISMATCH'].includes(error.code))throw new ApiError(409,writeAttempted?'FILE_PROMOTION_DESTINATION_MISMATCH':'FILE_PROMOTION_SOURCE_MISMATCH');
  throw new ApiError(503,writeAttempted?'FILE_PROMOTION_OUTCOME_UNKNOWN':'FILE_PROMOTION_UNAVAILABLE');
 }finally{clearTimeout(timer);limits.signal?.removeEventListener('abort',cancel);controller.abort();source.close();destination.close();client.destroy();}
}
