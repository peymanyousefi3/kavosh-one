import {z} from 'zod';
import {ApiError} from '../core/policy.ts';
import {privateR2} from '../integrations/r2.ts';
import type {R2DownloadConnections} from '../integrations/r2-config.ts';
import type {S3ClientConfig} from '@aws-sdk/client-s3';
import {imageServiceConfiguration,deriveProfileImageViaService} from '../files/image-service.ts';
import {imageMimeSchema,profileImagePurposeSchema,maximumImageInputBytes} from '../files/image-validation.ts';

const uuid=z.string().uuid().transform(v=>v.toLowerCase()),version=z.number().int().positive().max(2147483647),digest=z.string().regex(/^[a-f0-9]{64}$/);
export const profileImageSourceSchema=z.object({academyId:uuid,profileId:uuid,profileVersion:version,purpose:profileImagePurposeSchema,fileId:uuid,fileVersion:version,copyId:uuid,destinationTargetId:digest,destinationEtag:z.string().min(3).max(202).regex(/^"[\x21\x23-\x7e]+"$/),bytes:z.number().int().positive().max(maximumImageInputBytes),sha256:digest,mime:imageMimeSchema}).strict();
const optionsSchema=imageServiceConfiguration.extend({timeoutMs:z.number().int().min(1).max(30000).default(30000),signal:z.instanceof(AbortSignal).optional()}).strict();
let active=0;
// Internal worker IO only. The caller must obtain this exact source from the
// current approved publication/consent gate,then recheck it before retention
// or serving. This helper never grants authority,publishes,writes or deletes.
// Never mount it as a browser-supplied source or return its private receipt.
export async function prepareProfileImage(raw:unknown,connections:R2DownloadConnections,rawOptions:z.input<typeof optionsSchema>,handler?:S3ClientConfig['requestHandler']){
 const parsed=profileImageSourceSchema.safeParse(raw),settings=optionsSchema.safeParse(rawOptions);
 if(!parsed.success)throw new ApiError(400,'INVALID_PROFILE_IMAGE_SOURCE');if(!settings.success)throw new ApiError(400,'INVALID_PROFILE_IMAGE_PREPARATION_OPTIONS');
 const source=Object.freeze(parsed.data),options=settings.data;if(options.signal?.aborted)throw new ApiError(503,'PROFILE_IMAGE_PREPARATION_CANCELLED');
 // ponytail: at most two32MiB source buffers/process. Durable worker replicas,
 // not anonymous on-demand decoding,are the upgrade path for larger volume.
 if(active>=2)throw new ApiError(503,'PROFILE_IMAGE_PREPARATION_BUSY');active++;
 const abort=new AbortController(),cancel=()=>abort.abort();options.signal?.addEventListener('abort',cancel,{once:true});if(options.signal?.aborted)cancel();const timer=setTimeout(cancel,options.timeoutMs);
 let storage:ReturnType<typeof privateR2>|undefined,bytes:Buffer|undefined;const resources=new Set<Promise<unknown>>();
 const observe=(p:Promise<unknown>)=>{const settled=p.then(()=>{},()=>{});resources.add(settled);void settled.then(()=>resources.delete(settled));};
 try{
  const configuration=connections(source.academyId,source.destinationTargetId);if(!configuration)throw new ApiError(503,'PROFILE_IMAGE_READER_NOT_CONFIGURED');storage=privateR2(configuration,source.academyId,handler);
  if(storage.storageTargetId!==source.destinationTargetId||source.bytes>storage.maximumUploadBytes)throw new ApiError(503,'PROFILE_IMAGE_READER_NOT_CONFIGURED');
  bytes=Buffer.alloc(source.bytes);const owned=bytes;let used=0;
  // The existing adapter independently checks exact ETag,length and SHA256.
  // No decoding starts merely because headers or a stored receipt look right.
  await storage.inspectClean(source.fileId,{bytes:source.bytes,sha256:source.sha256,ifMatch:source.destinationEtag},async(stream,signal)=>{for await(const chunk of stream){if(signal.aborted||!Buffer.isBuffer(chunk)||used+chunk.length>owned.length)throw Error();used+=chunk.copy(owned,used);}if(used!==owned.length)throw Error();},options.timeoutMs,abort.signal,observe);
  if(abort.signal.aborted)throw new ApiError(503,'PROFILE_IMAGE_PREPARATION_CANCELLED');
  const result=await deriveProfileImageViaService(owned,source.mime,source.purpose,{socketPath:options.socketPath,signal:abort.signal});
  if(result.outcome!=='decoded')throw new ApiError(409,'PROFILE_IMAGE_REJECTED');
  return{source,image:result.profileImage,sourceBytesIndependentlyVerified:true as const,originalModified:false as const,stored:false as const,published:false as const};
 }catch(e){
  if(abort.signal.aborted)throw new ApiError(503,'PROFILE_IMAGE_PREPARATION_CANCELLED');
  if(e instanceof ApiError&&['PROFILE_IMAGE_READER_NOT_CONFIGURED','PROFILE_IMAGE_REJECTED'].includes(e.code))throw e;
  if(e instanceof ApiError&&['FILE_HASH_MISMATCH','FILE_SIZE_MISMATCH','FILE_ETAG_MISMATCH'].includes(e.code))throw new ApiError(409,'PROFILE_IMAGE_SOURCE_MISMATCH');
  throw new ApiError(503,'PROFILE_IMAGE_PREPARATION_UNAVAILABLE');
 }finally{
  clearTimeout(timer);options.signal?.removeEventListener('abort',cancel);abort.abort();let closeFailed=false;try{storage?.close();}catch{closeFailed=true;}
  // A timeout is not IO finality. Keep memory/admission until the underlying
  // read and body actually settle,even if a transport ignores cancellation.
  const release=()=>{bytes?.fill(0);active--;};if(resources.size)void Promise.allSettled([...resources]).then(release);else release();if(closeFailed)throw new ApiError(503,'PROFILE_IMAGE_PREPARATION_UNAVAILABLE');
 }
}
