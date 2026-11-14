import {z} from 'zod';
import {ApiError} from '../core/policy.ts';
import {privateR2} from '../integrations/r2.ts';
import type {R2DownloadConnections} from '../integrations/r2-config.ts';
import type {S3ClientConfig} from '@aws-sdk/client-s3';
import {profileShareAlias} from './share-id.ts';

const uuid=z.string().uuid().transform(v=>v.toLowerCase()),digest=z.string().regex(/^[a-f0-9]{64}$/);
export const profileImageDeliverySchema=z.object({academyId:uuid,objectId:uuid,storageTargetId:digest,etag:z.string().min(3).max(202).regex(/^"[\x21\x23-\x7e]+"$/),bytes:z.number().int().positive().max(4194304),sha256:digest}).strict();
const caption=z.string().trim().min(1).max(300).refine(v=>v.isWellFormed()&&!/[\p{Cc}]/u.test(v));
export const profileImageSelectionSchema=z.object({version:z.string().regex(/^[1-9][0-9]{0,9}$/).transform(Number).pipe(z.number().int().positive().max(2147483647)),number:z.string().regex(/^(?:[1-9]|[1-9][0-9]|100)$/).transform(Number)}).strict();
export const privateProfileImageManifestSchema=z.object({id:uuid,releaseVersion:z.number().int().positive().max(2147483647),images:z.array(z.object({number:z.number().int().min(1).max(100),purpose:z.enum(['avatar','achievement']),alt:z.object({en:caption,fr:caption.optional(),'zh-CN':caption.optional()}).strict(),mime:z.literal('image/webp'),width:z.number().int().min(1).max(2048),height:z.number().int().min(1).max(2048),delivery:profileImageDeliverySchema}).strict().refine(v=>v.purpose!=='avatar'||v.width<=512&&v.height<=512&&v.delivery.bytes<=1048576)).min(1).max(100),mediaIncluded:z.literal(true),originalsIncluded:z.literal(false)}).strict().refine(v=>v.images.every((x,n)=>n===0||x.number>v.images[n-1].number));
export function profileImageIndex(manifest:z.infer<typeof privateProfileImageManifestSchema>,audience:'public'|'members'){
 const prefix=audience==='public'?'/api/public/v1/profiles/':'/api/v1/community/published-profiles/';
 return{id:manifest.id,releaseVersion:manifest.releaseVersion,images:manifest.images.map(({number,purpose,alt,mime,width,height})=>({number,purpose,alt,mime,width,height,downloadPath:prefix+profileShareAlias(manifest.id)+'/images/'+manifest.releaseVersion+'/'+number})),mediaIncluded:true as const,originalsIncluded:false as const};
}
const optionsSchema=z.object({timeoutMs:z.number().int().min(1).max(30000).default(10000),signal:z.instanceof(AbortSignal).optional()}).strict();
let active=0,reservedBytes=0;
// Internal exact-derivative delivery only. Caller obtains an approved current
// source,then MUST independently reauthorize after IO. No native decoding,
// original-file fallback,signed URL,write,public bucket or DB connection here.
export async function openProfileImageDelivery(raw:unknown,connections:R2DownloadConnections,reauthorize:()=>Promise<boolean>,rawOptions:z.input<typeof optionsSchema>={},handler?:S3ClientConfig['requestHandler']){
 const parsed=profileImageDeliverySchema.safeParse(raw),settings=optionsSchema.safeParse(rawOptions);
 if(!parsed.success||!settings.success||typeof reauthorize!=='function')throw new ApiError(400,'INVALID_PROFILE_IMAGE_DELIVERY');
 const source=Object.freeze(parsed.data),options=settings.data;if(options.signal?.aborted)throw new ApiError(503,'PROFILE_IMAGE_DELIVERY_CANCELLED');
 // ponytail: at most eight streams and8MiB total owned buffers/process. Small
 // avatars can load together without reserving4MiB each. Hold admission through
 // actual IO settlement AND client consumption/cancellation,not just headers.
 if(active>=8||reservedBytes+source.bytes>8388608)throw new ApiError(503,'PROFILE_IMAGE_DELIVERY_BUSY');active++;reservedBytes+=source.bytes;
 const abort=new AbortController(),resources=new Set<Promise<unknown>>();let storage:ReturnType<typeof privateR2>|undefined,bytes:Buffer|undefined,stream:ReadableStreamDefaultController<Uint8Array>|undefined,released=false,stop!:(e:Error)=>void;
 const halted=new Promise<never>((_,no)=>{stop=no;});void halted.catch(()=>{});
 const release=()=>{if(released)return;released=true;clearTimeout(timer);options.signal?.removeEventListener('abort',cancel);abort.abort();try{storage?.close();}catch{/* Cleanup diagnostics must never disclose private connection settings. */}void Promise.resolve().then(async()=>{while(resources.size)await Promise.allSettled([...resources]);bytes?.fill(0);active--;reservedBytes-=source.bytes;});};
 const cancel=()=>{abort.abort();const error=new ApiError(503,'PROFILE_IMAGE_DELIVERY_CANCELLED');stop(error);stream?.error(error);release();};
 const timer=setTimeout(cancel,options.timeoutMs);options.signal?.addEventListener('abort',cancel,{once:true});
 const observe=(p:Promise<unknown>)=>{const settled=p.then(()=>{},()=>{});resources.add(settled);void settled.then(()=>resources.delete(settled));};
 const operation=async()=>{
  if(options.signal?.aborted||abort.signal.aborted)throw new ApiError(503,'PROFILE_IMAGE_DELIVERY_CANCELLED');
  let configuration;try{configuration=connections(source.academyId,source.storageTargetId);}catch{throw new ApiError(503,'PROFILE_IMAGE_DELIVERY_NOT_CONFIGURED');}
  if(!configuration)throw new ApiError(503,'PROFILE_IMAGE_DELIVERY_NOT_CONFIGURED');storage=privateR2(configuration,source.academyId,handler);
  if(storage.storageTargetId!==source.storageTargetId||source.bytes>storage.maximumUploadBytes)throw new ApiError(503,'PROFILE_IMAGE_DELIVERY_NOT_CONFIGURED');
  bytes=Buffer.alloc(source.bytes);const owned=bytes;let used=0;
  await storage.inspectClean(source.objectId,{bytes:source.bytes,sha256:source.sha256,ifMatch:source.etag},async(input,signal)=>{for await(const chunk of input){if(signal.aborted||!Buffer.isBuffer(chunk)||used+chunk.length>owned.length)throw Error('INVALID_IMAGE_TRANSFER');used+=chunk.copy(owned,used);}if(used!==owned.length)throw Error('INCOMPLETE_IMAGE_TRANSFER');},options.timeoutMs,abort.signal,observe);
  if(abort.signal.aborted)throw new ApiError(503,'PROFILE_IMAGE_DELIVERY_CANCELLED');
  const authorization=Promise.resolve().then(reauthorize);observe(authorization);if(await authorization!==true)throw new ApiError(404,'NOT_FOUND');
  if(abort.signal.aborted)throw new ApiError(503,'PROFILE_IMAGE_DELIVERY_CANCELLED');let position=0;
  return new ReadableStream<Uint8Array>({start(controller){stream=controller;},pull(controller){if(released||abort.signal.aborted)return;const end=Math.min(position+65536,owned.length);controller.enqueue(Uint8Array.from(owned.subarray(position,end)));position=end;if(position===owned.length){controller.close();stream=undefined;release();}},cancel(){stream=undefined;release();}},{highWaterMark:0});
 };
 const pending=operation();observe(pending);
 try{return await Promise.race([pending,halted]);}
 catch(e){release();if(e instanceof ApiError&&['NOT_FOUND','RATE_LIMITED','PROFILE_IMAGE_DELIVERY_NOT_CONFIGURED','PROFILE_IMAGE_DELIVERY_CANCELLED'].includes(e.code))throw e;if(e instanceof ApiError&&['FILE_HASH_MISMATCH','FILE_SIZE_MISMATCH','FILE_ETAG_MISMATCH'].includes(e.code))throw new ApiError(409,'PROFILE_IMAGE_DELIVERY_SOURCE_MISMATCH');throw new ApiError(503,'PROFILE_IMAGE_DELIVERY_UNAVAILABLE');}
}
