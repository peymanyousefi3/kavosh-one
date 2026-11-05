import { S3Client,PutObjectCommand,GetObjectCommand,type S3ClientConfig } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { Readable,Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { ApiError } from '../core/policy.ts';
import { r2Connection as connection,type R2Connection } from './r2-config.ts';

const uuid=z.string().uuid().transform(v=>v.toLowerCase());
const uploadMetadata=z.object({contentType:z.string().regex(/^[a-z0-9][a-z0-9.+-]{0,99}\/[a-z0-9][a-z0-9.+-]{0,99}$/),bytes:z.number().int().positive().safe()}).strict();
const inspectionClaims=z.object({bytes:z.number().int().min(1).max(4_294_967_296),sha256:z.string().regex(/^[a-fA-F0-9]{64}$/).transform(v=>v.toLowerCase()).optional()}).strict();

// Official SDK, fixed R2 endpoint, explicit credentials (no metadata-service or
// environment credential fallback). No network is needed to sign a link.
// https://developers.cloudflare.com/r2/examples/aws/aws-sdk-js-v3/
// https://developers.cloudflare.com/r2/api/s3/presigned-urls/
// A service adapter, NOT an authorization boundary or proof of a clean upload.
// Callers must validate the file row, tenant scope, current access and scan state.
export function privateR2(config:R2Connection,academyId:string,handler?:S3ClientConfig['requestHandler']) {
  const parsed=connection.safeParse(config),academy=uuid.safeParse(academyId);
  if(!parsed.success||!academy.success)throw new ApiError(503,'R2_NOT_CONFIGURED');
  const c=parsed.data,endpoint=`https://${c.accountId}${c.jurisdiction==='eu'?'.eu':''}.r2.cloudflarestorage.com`;
  const client=new S3Client({endpoint,region:'auto',forcePathStyle:true,followRegionRedirects:false,maxAttempts:1,
    credentials:{accessKeyId:c.accessKeyId,secretAccessKey:c.secretAccessKey},requestChecksumCalculation:'WHEN_REQUIRED',responseChecksumValidation:'WHEN_REQUIRED',
    ...(handler?{requestHandler:handler}:{})});
  let closed=false;
  function key(stage:'quarantine'|'clean',fileId:string) {
    if(closed)throw new ApiError(503,'R2_CONNECTION_CLOSED');
    const id=uuid.safeParse(fileId);if(!id.success)throw new ApiError(400,'INVALID_FILE_ID');
    return `academies/${academy.data}/${stage}/${id.data}`;
  }
  function expiry(value:number,maximum:number,issuedAt?:string) {
    if(!Number.isInteger(value)||value<1||value>maximum)throw new ApiError(400,'INVALID_FILE_LINK_EXPIRY');
    const parsed=issuedAt===undefined?null:z.iso.datetime().safeParse(issuedAt);
    if(parsed&&!parsed.success)throw new ApiError(400,'INVALID_FILE_LINK_EXPIRY');
    const signingDate=new Date(parsed?.success?parsed.data:Math.floor(Date.now()/1000)*1000),end=signingDate.getTime()+value*1000;
    if(signingDate.getTime()%1000!==0||signingDate.getTime()>Date.now()+5000)throw new ApiError(400,'INVALID_FILE_LINK_EXPIRY');
    if(end<=Date.now())throw new ApiError(410,'FILE_LINK_EXPIRED');
    return {expiresIn:value,signingDate,expiresAt:new Date(end).toISOString()};
  }
  async function inspectStored<T>(stage:'quarantine'|'clean',fileId:string,claims:z.input<typeof inspectionClaims>,inspect:(source:Readable,signal:AbortSignal)=>Promise<T>,timeoutMs=120000,signal?:AbortSignal) {
      const objectKey=key(stage,fileId),input=inspectionClaims.safeParse(claims);
      if(!input.success||input.data.bytes>c.maximumUploadBytes)throw new ApiError(400,'INVALID_INSPECTION_CLAIMS');
      if(!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>600000)throw new ApiError(400,'INVALID_INSPECTION_TIMEOUT');
      if(signal?.aborted)throw new ApiError(502,'R2_INSPECTION_CANCELLED');
      const expected=input.data,controller=new AbortController();let body:Readable|undefined,meter:Transform|undefined,timedOut=false;
      let expire!:(reason:ApiError)=>void;const expired=new Promise<never>((_resolve,reject)=>{expire=reject;});
      const cancel=()=>{controller.abort();body?.destroy();meter?.destroy();expire(new ApiError(502,'R2_INSPECTION_CANCELLED'));};signal?.addEventListener('abort',cancel,{once:true});
      const deadline=setTimeout(()=>{timedOut=true;controller.abort();body?.destroy();meter?.destroy();expire(new ApiError(502,'R2_INSPECTION_TIMEOUT'));},timeoutMs);
      try {
        const request=client.send(new GetObjectCommand({Bucket:c.bucket,Key:objectKey}),{abortSignal:controller.signal}).then(response=>{if(controller.signal.aborted&&response.Body instanceof Readable)response.Body.destroy();return response;});
        const response=await Promise.race([request,expired]);
        if(!(response.Body instanceof Readable))throw new ApiError(502,'R2_INVALID_OBJECT');body=response.Body;
        if(!Number.isSafeInteger(response.ContentLength)||response.ContentLength!==expected.bytes)throw new ApiError(409,'FILE_SIZE_MISMATCH');
        // Provider ContentType and ETag are metadata, not detected MIME or an
        // independently verified hash. No complete content buffer is retained.
        const provider=z.object({etag:z.string().min(3).max(202).regex(/^"[\x21\x23-\x7e]+"$/),contentType:z.string().min(1).max(200).regex(/^[\x20-\x7e]+$/)}).safeParse({etag:response.ETag,contentType:response.ContentType});
        if(!provider.success)throw new ApiError(502,'R2_INVALID_OBJECT');
        const hash=createHash('sha256');let bytes=0,ended=false;
        meter=new Transform({highWaterMark:65536,transform(chunk:Buffer,_encoding,callback){bytes+=chunk.length;if(bytes>expected.bytes){callback(new ApiError(409,'FILE_SIZE_MISMATCH'));return;}hash.update(chunk);callback(null,chunk);}});
        meter.once('end',()=>{ended=true;});const source=meter;
        const transfer=pipeline(body,meter),inspection=(async()=>{const result=await inspect(source,controller.signal);if(!ended)throw new ApiError(502,'R2_INCOMPLETE_INSPECTION');return result;})();
        const [,result]=await Promise.race([Promise.all([transfer,inspection]),expired]);
        if(bytes!==expected.bytes)throw new ApiError(409,'FILE_SIZE_MISMATCH');
        const sha256=hash.digest('hex');if(expected.sha256&&sha256!==expected.sha256)throw new ApiError(409,'FILE_HASH_MISMATCH');
        return {bytes,sha256,provider:provider.data,inspection:result};
      }catch(error){
        if(signal?.aborted)throw new ApiError(502,'R2_INSPECTION_CANCELLED');
        if(timedOut)throw new ApiError(502,'R2_INSPECTION_TIMEOUT');
        if(error instanceof ApiError&&['FILE_SIZE_MISMATCH','FILE_HASH_MISMATCH','R2_INVALID_OBJECT','R2_INCOMPLETE_INSPECTION'].includes(error.code))throw error;
        throw new ApiError(502,'R2_INSPECTION_UNAVAILABLE');
      }finally{clearTimeout(deadline);signal?.removeEventListener('abort',cancel);controller.abort();body?.destroy();meter?.destroy();}
  }
  return {
    storageTargetId:createHash('sha256').update(JSON.stringify([c.accountId,c.jurisdiction,c.bucket])).digest('hex'),
    maximumUploadBytes:c.maximumUploadBytes,
    inspectQuarantine<T>(fileId:string,claims:z.input<typeof inspectionClaims>,inspect:(source:Readable,signal:AbortSignal)=>Promise<T>,timeoutMs=120000,signal?:AbortSignal){return inspectStored('quarantine',fileId,claims,inspect,timeoutMs,signal);},
    inspectClean<T>(fileId:string,claims:z.input<typeof inspectionClaims>,inspect:(source:Readable,signal:AbortSignal)=>Promise<T>,timeoutMs=120000,signal?:AbortSignal){return inspectStored('clean',fileId,claims,inspect,timeoutMs,signal);},
    async quarantineUpload(fileId:string,metadata:z.input<typeof uploadMetadata>,expiresSeconds=300,issuedAt?:string) {
      const objectKey=key('quarantine',fileId),input=uploadMetadata.safeParse(metadata),time=expiry(expiresSeconds,300,issuedAt);
      if(!input.success||input.data.bytes>c.maximumUploadBytes)throw new ApiError(400,'INVALID_UPLOAD_METADATA');
      // Signed If-None-Match prevents a still-valid grant overwriting the same
      // object after scan. Never delete quarantine before its grant expires.
      // https://developers.cloudflare.com/r2/api/s3/api/#object-level-operations
      const command=new PutObjectCommand({Bucket:c.bucket,Key:objectKey,ContentType:input.data.contentType,ContentLength:input.data.bytes,IfNoneMatch:'*'});
      try {
        const url=await getSignedUrl(client,command,{expiresIn:time.expiresIn,signingDate:time.signingDate,signableHeaders:new Set(['content-type','content-length','if-none-match'])});
        return {url,method:'PUT' as const,headers:{'content-type':input.data.contentType,'content-length':String(input.data.bytes),'if-none-match':'*'},expiresAt:time.expiresAt};
      }catch{throw new ApiError(502,'R2_LINK_UNAVAILABLE');}
    },
    async cleanDownload(fileId:string,expiresSeconds=60) {
      const objectKey=key('clean',fileId),time=expiry(expiresSeconds,60);
      try {
        const url=await getSignedUrl(client,new GetObjectCommand({Bucket:c.bucket,Key:objectKey,ResponseContentType:'application/octet-stream',ResponseContentDisposition:'attachment',ResponseCacheControl:'private, no-store'}),{expiresIn:time.expiresIn,signingDate:time.signingDate});
        return {url,method:'GET' as const,expiresAt:time.expiresAt};
      }catch{throw new ApiError(502,'R2_LINK_UNAVAILABLE');}
    },
    close(){if(!closed){closed=true;client.destroy();}}
  };
}
