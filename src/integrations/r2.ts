import { S3Client,PutObjectCommand,GetObjectCommand,type S3ClientConfig } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { z } from 'zod';
import { ApiError } from '../core/policy.ts';

const uuid=z.string().uuid().transform(v=>v.toLowerCase());
const connection=z.object({accountId:z.string().regex(/^[a-fA-F0-9]{32}$/).transform(v=>v.toLowerCase()),
  jurisdiction:z.enum(['default','eu']),bucket:z.string().regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/).refine(v=>!v.includes('..')),
  accessKeyId:z.string().min(1).max(200).regex(/^[\x21-\x7e]+$/),secretAccessKey:z.string().min(16).max(4096).regex(/^[\x21-\x7e]+$/),
  maximumUploadBytes:z.number().int().min(1).max(4_294_967_296)
}).strict();
export type R2Connection=z.input<typeof connection>;
const uploadMetadata=z.object({contentType:z.string().regex(/^[a-z0-9][a-z0-9.+-]{0,99}\/[a-z0-9][a-z0-9.+-]{0,99}$/),bytes:z.number().int().positive().safe()}).strict();

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
  function expiry(value:number,maximum:number) {
    if(!Number.isInteger(value)||value<1||value>maximum)throw new ApiError(400,'INVALID_FILE_LINK_EXPIRY');
    const signingDate=new Date(Math.floor(Date.now()/1000)*1000);return {expiresIn:value,signingDate,expiresAt:new Date(signingDate.getTime()+value*1000).toISOString()};
  }
  return {
    async quarantineUpload(fileId:string,metadata:z.input<typeof uploadMetadata>,expiresSeconds=300) {
      const objectKey=key('quarantine',fileId),input=uploadMetadata.safeParse(metadata),time=expiry(expiresSeconds,300);
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
