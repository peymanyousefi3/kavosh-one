import {createHash} from 'node:crypto';
import {Readable} from 'node:stream';
import {S3Client,PutObjectCommand,type S3ClientConfig} from '@aws-sdk/client-s3';
import {z} from 'zod';
import {ApiError} from '../core/policy.ts';
import {r2Connection,r2TargetId,type R2Connection} from '../integrations/r2-config.ts';
import {privateR2} from '../integrations/r2.ts';
import {profileImageValidationSchema,imageValidationMatches} from '../files/image-validation.ts';
import {profileImageSourceSchema} from './image-preparation.ts';

const digest=z.string().regex(/^[a-f0-9]{64}$/),version=z.number().int().positive().max(2147483647),hash=(b:Uint8Array|string)=>createHash('sha256').update(b).digest('hex');
export const reviewedImageSourceSchema=profileImageSourceSchema.extend({releaseVersion:version,releaseFingerprint:digest,imageNo:z.number().int().min(1).max(100)}).strict();
const options=z.object({targetId:digest,timeoutMs:z.number().int().min(1).max(30000).default(30000),signal:z.instanceof(AbortSignal).optional()}).strict();
let active=0;
function objectId(source:z.infer<typeof reviewedImageSourceSchema>,sha:string){
 const h=hash(JSON.stringify(['kavosh-profile-image-v1',source.academyId,source.profileId,source.releaseVersion,source.releaseFingerprint,source.imageNo,source.purpose,source.fileId,source.fileVersion,source.copyId,source.sha256,sha])).slice(0,32).split('');h[12]='8';h[16]=((parseInt(h[16],16)&3)|8).toString(16);const v=h.join('');return `${v.slice(0,8)}-${v.slice(8,12)}-${v.slice(12,16)}-${v.slice(16,20)}-${v.slice(20)}`;
}
// Internal worker IO only. Reviewed-source authority must be checked by the
// durable claim and again when recording/serving. No URL,public ACL,overwrite,
// deletion or browser-selected storage. Reuse the existing private clean-object
// namespace so the existing whole-bucket encrypted inventory includes copies.
export async function retainProfileImage(configuration:R2Connection,rawSource:unknown,rawValidation:unknown,rawOptions:z.input<typeof options>,handler?:S3ClientConfig['requestHandler']){
 const c=r2Connection.safeParse(configuration),s=reviewedImageSourceSchema.safeParse(rawSource),v=profileImageValidationSchema.safeParse(rawValidation),o=options.safeParse(rawOptions);
 if(!c.success||!s.success||!v.success||!o.success||v.data.outcome!=='decoded')throw new ApiError(400,'INVALID_PROFILE_IMAGE_RETENTION');
 const source=s.data,validation=v.data,settings=o.data,image=validation.profileImage;
 if(!imageValidationMatches(validation,source.bytes,source.sha256,source.mime,64000000,64,source.purpose)||image.bytes>c.data.maximumUploadBytes)throw new ApiError(400,'INVALID_PROFILE_IMAGE_RETENTION');
 if(r2TargetId(c.data)!==settings.targetId)throw new ApiError(400,'PROFILE_IMAGE_TARGET_MISMATCH');
 if(settings.signal?.aborted)throw new ApiError(503,'PROFILE_IMAGE_RETENTION_CANCELLED');
 // ponytail: two <=4MiB owned output buffers/process,held until physical IO
 // settles even when a transport ignores cancellation. Scale worker replicas.
 if(active>=2)throw new ApiError(503,'PROFILE_IMAGE_RETENTION_BUSY');
 const id=objectId(source,image.sha256);if(id===source.fileId)throw new ApiError(400,'PROFILE_IMAGE_TARGET_MISMATCH');
 const bytes=Buffer.from(image.base64,'base64'),reader=privateR2(c.data,source.academyId,handler),writer=new S3Client({endpoint:`https://${c.data.accountId}${c.data.jurisdiction==='eu'?'.eu':''}.r2.cloudflarestorage.com`,region:'auto',forcePathStyle:true,followRegionRedirects:false,maxAttempts:1,credentials:{accessKeyId:c.data.accessKeyId,secretAccessKey:c.data.secretAccessKey},requestChecksumCalculation:'WHEN_REQUIRED',responseChecksumValidation:'WHEN_REQUIRED',...(handler?{requestHandler:handler}:{})});
 // PUT has no useful response body. Close it BEFORE SDK XML parsing so an
 // unbounded provider error body cannot become memory or private diagnostics.
 const transport=writer.config.requestHandler,send=transport.handle.bind(transport);
 writer.config.requestHandler={...transport,async handle(request,opts){const r=await send(request,opts),body=r.response.body;if(body instanceof Readable){body.once('error',()=>{});const closed=body.closed?Promise.resolve():new Promise<void>(yes=>body.once('close',yes));body.destroy();await closed;}r.response.body=Readable.from([]);if(r.response.statusCode===412)throw Object.assign(Error('CREATE_ONCE_EXISTS'),{$metadata:{httpStatusCode:412}});if(r.response.statusCode!==200)throw Error('PRIVATE_WRITE_UNAVAILABLE');return r;},destroy(){transport.destroy?.();}};
 const abort=new AbortController(),resources:Promise<unknown>[]=[];let stop!:(e:Error)=>void,writeAttempted=false;
 const stopped=new Promise<never>((_,no)=>{stop=no;}),cancel=()=>{abort.abort();stop(Error('STOPPED'));};settings.signal?.addEventListener('abort',cancel,{once:true});const timer=setTimeout(cancel,settings.timeoutMs),deadline=Date.now()+settings.timeoutMs;active++;
 const run=async()=>{
  if(settings.signal?.aborted||abort.signal.aborted)throw Error('STOPPED');
  try{writeAttempted=true;await writer.send(new PutObjectCommand({Bucket:c.data.bucket,Key:`academies/${source.academyId}/clean/${id}`,Body:bytes,ContentLength:bytes.length,ContentType:'application/octet-stream',ContentDisposition:'attachment',CacheControl:'private, no-store',IfNoneMatch:'*'}),{abortSignal:abort.signal});}
  catch(e){if(!e||typeof e!=='object'||!('$metadata'in e)||(e.$metadata as {httpStatusCode?:number})?.httpStatusCode!==412)throw e;}
  if(abort.signal.aborted||Date.now()>=deadline)throw Error('STOPPED');
  const verified=await reader.inspectClean(id,{bytes:bytes.length,sha256:image.sha256},async stream=>{for await(const _chunk of stream){if(abort.signal.aborted)throw Error('STOPPED');}},Math.max(1,deadline-Date.now()),abort.signal,p=>resources.push(p));
  if(abort.signal.aborted||Date.now()>=deadline)throw Error('STOPPED');
  return{objectId:id,storageTargetId:settings.targetId,etag:verified.provider.etag,bytes:verified.bytes,sha256:verified.sha256,mime:image.mime,width:image.width,height:image.height,purpose:image.purpose,releaseVersion:source.releaseVersion,releaseFingerprint:source.releaseFingerprint,imageNo:source.imageNo,bytesReadBackVerified:true as const,published:false as const,originalModified:false as const};
 };
 const pending=run();void pending.then(()=>{},()=>{}).then(async()=>{await Promise.allSettled(resources);bytes.fill(0);active--;});
 try{if(settings.signal?.aborted)cancel();return await Promise.race([pending,stopped]);}
 catch(e){if(e instanceof ApiError&&['FILE_HASH_MISMATCH','FILE_SIZE_MISMATCH'].includes(e.code))throw new ApiError(409,'PROFILE_IMAGE_STORED_BYTES_MISMATCH');throw new ApiError(503,writeAttempted?'PROFILE_IMAGE_RETENTION_OUTCOME_UNKNOWN':'PROFILE_IMAGE_RETENTION_CANCELLED');}
 finally{clearTimeout(timer);settings.signal?.removeEventListener('abort',cancel);abort.abort();let failed=false;try{reader.close();}catch{failed=true;}try{writer.destroy();}catch{failed=true;}if(failed)throw new ApiError(503,'PROFILE_IMAGE_RETENTION_OUTCOME_UNKNOWN');}
}
