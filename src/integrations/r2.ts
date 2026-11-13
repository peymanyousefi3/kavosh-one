import { S3Client,PutObjectCommand,GetObjectCommand,ListObjectsV2Command,type S3ClientConfig } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { Readable,Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { ApiError } from '../core/policy.ts';
import { r2Connection as connection,type R2Connection } from './r2-config.ts';

const uuid=z.string().uuid().transform(v=>v.toLowerCase());
const uploadMetadata=z.object({contentType:z.string().regex(/^[a-z0-9][a-z0-9.+-]{0,99}\/[a-z0-9][a-z0-9.+-]{0,99}$/),bytes:z.number().int().positive().safe()}).strict();
const inspectionClaims=z.object({bytes:z.number().int().min(1).max(4_294_967_296),sha256:z.string().regex(/^[a-fA-F0-9]{64}$/).transform(v=>v.toLowerCase()).optional(),ifMatch:z.string().min(3).max(202).regex(/^"[\x21\x23-\x7e]+"$/).optional()}).strict();
const byteRange=z.object({start:z.number().int().nonnegative().safe(),end:z.number().int().nonnegative().safe()}).strict();

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
  const bodyClosed=(source:Readable)=>source.closed?Promise.resolve():new Promise<void>(resolve=>source.once('close',resolve));
  // The SDK deserializes error XML BEFORE inspectStored receives a response.
  // Reject non-object responses at the transport boundary so an error body
  // cannot bypass our byte meter or enter private diagnostics. Preserve actual
  // close settlement even when a transport ignores cancellation.
  const transport=client.config.requestHandler,send=transport.handle.bind(transport);
  client.config.requestHandler={...transport,async handle(request,options){const result=await send(request,options);if(![200,206].includes(result.response.statusCode)){const source=result.response.body;if(source instanceof Readable){source.once('error',()=>{});const ended=bodyClosed(source);source.destroy();await ended;}throw new ApiError(502,'R2_INSPECTION_UNAVAILABLE');}
   // Inventory XML is buffered by the SDK parser. Bound it before parsing,
   // including chunked responses without a trustworthy Content-Length.
   if(request.query?.['list-type']==='2'){
    const source=result.response.body;if(!(source instanceof Readable))throw new ApiError(502,'R2_INVALID_INVENTORY');
    let bytes=0;const meter=new Transform({transform(chunk:Buffer,_encoding,done){bytes+=chunk.length;if(bytes>2097152){done(new ApiError(502,'R2_INVALID_INVENTORY'));return;}done(null,chunk);}});
    void pipeline(source,meter).catch(()=>{});result.response.body=meter;
   }
   return result;},destroy(){transport.destroy?.();},...('updateHttpClientConfig'in transport&&typeof transport.updateHttpClientConfig==='function'?{updateHttpClientConfig:transport.updateHttpClientConfig.bind(transport)}:{}),...('httpHandlerConfigs'in transport&&typeof transport.httpHandlerConfigs==='function'?{httpHandlerConfigs:transport.httpHandlerConfigs.bind(transport)}:{})};
  function key(stage:'quarantine'|'clean'|'signature-evidence',fileId:string) {
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
  async function inspectStored<T>(stage:'quarantine'|'clean'|'signature-evidence',fileId:string,claims:z.input<typeof inspectionClaims>,inspect:(source:Readable,signal:AbortSignal)=>Promise<T>,timeoutMs=120000,signal?:AbortSignal,observeResources?:(settled:Promise<unknown>)=>void,selection?:z.infer<typeof byteRange>) {
      const objectKey=key(stage,fileId),input=inspectionClaims.safeParse(claims);
      if(!input.success||input.data.bytes>c.maximumUploadBytes)throw new ApiError(400,'INVALID_INSPECTION_CLAIMS');
      if(selection&&(!byteRange.safeParse(selection).success||stage!=='clean'||!input.data.ifMatch||input.data.sha256!==undefined||selection.end<selection.start||selection.end>=input.data.bytes))throw new ApiError(400,'INVALID_PRIVATE_BYTE_RANGE');
      if(!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>600000)throw new ApiError(400,'INVALID_INSPECTION_TIMEOUT');
      if(signal?.aborted)throw new ApiError(502,'R2_INSPECTION_CANCELLED');
      const expected=input.data,transferBytes=selection?selection.end-selection.start+1:expected.bytes,controller=new AbortController();let body:Readable|undefined,meter:Transform|undefined,timedOut=false;const pendingOperations:Promise<unknown>[]=[];
      let expire!:(reason:ApiError)=>void;const expired=new Promise<never>((_resolve,reject)=>{expire=reject;});
      const cancel=()=>{controller.abort();body?.destroy();meter?.destroy();expire(new ApiError(502,'R2_INSPECTION_CANCELLED'));};signal?.addEventListener('abort',cancel,{once:true});
      const deadline=setTimeout(()=>{timedOut=true;controller.abort();body?.destroy();meter?.destroy();expire(new ApiError(502,'R2_INSPECTION_TIMEOUT'));},timeoutMs);
      try {
        const request=client.send(new GetObjectCommand({Bucket:c.bucket,Key:objectKey,...expected.ifMatch?{IfMatch:expected.ifMatch}:{},...selection?{Range:`bytes=${selection.start}-${selection.end}`}:{}}),{abortSignal:controller.signal}).then(async response=>{if(controller.signal.aborted&&response.Body instanceof Readable){response.Body.once('error',()=>{});const ended=bodyClosed(response.Body);response.Body.destroy();await ended;}return response;});
        pendingOperations.push(request);
        const response=await Promise.race([request,expired]);
        if(!(response.Body instanceof Readable))throw new ApiError(502,'R2_INVALID_OBJECT');body=response.Body;body.once('error',()=>{});pendingOperations.push(bodyClosed(body));
        if(!Number.isSafeInteger(response.ContentLength)||response.ContentLength!==transferBytes)throw new ApiError(409,'FILE_SIZE_MISMATCH');
        if(selection&&(response.$metadata.httpStatusCode!==206||response.ContentRange!==`bytes ${selection.start}-${selection.end}/${expected.bytes}`||response.ContentEncoding))throw new ApiError(502,'R2_INVALID_OBJECT');
        // Provider ContentType and ETag are metadata, not detected MIME or an
        // independently verified hash. No complete content buffer is retained.
        const provider=z.object({etag:z.string().min(3).max(202).regex(/^"[\x21\x23-\x7e]+"$/),contentType:z.string().min(1).max(200).regex(/^[\x20-\x7e]+$/)}).safeParse({etag:response.ETag,contentType:response.ContentType});
        if(!provider.success)throw new ApiError(502,'R2_INVALID_OBJECT');
        if(expected.ifMatch&&provider.data.etag!==expected.ifMatch)throw new ApiError(409,'FILE_ETAG_MISMATCH');
        const hash=createHash('sha256');let bytes=0,ended=false;
        meter=new Transform({highWaterMark:65536,transform(chunk:Buffer,_encoding,callback){bytes+=chunk.length;if(bytes>transferBytes){callback(new ApiError(409,'FILE_SIZE_MISMATCH'));return;}hash.update(chunk);callback(null,chunk);}});
        meter.once('end',()=>{ended=true;});const source=meter;
        const transfer=pipeline(body,meter),inspection=(async()=>{const result=await inspect(source,controller.signal);if(!ended)throw new ApiError(502,'R2_INCOMPLETE_INSPECTION');return result;})();
        pendingOperations.push(transfer,inspection);
        const [,result]=await Promise.race([Promise.all([transfer,inspection]),expired]);
        if(bytes!==transferBytes)throw new ApiError(409,'FILE_SIZE_MISMATCH');
        const sha256=hash.digest('hex');if(expected.sha256&&sha256!==expected.sha256)throw new ApiError(409,'FILE_HASH_MISMATCH');
        return {bytes,sha256,provider:provider.data,inspection:result};
      }catch(error){
        if(signal?.aborted)throw new ApiError(502,'R2_INSPECTION_CANCELLED');
        if(timedOut)throw new ApiError(502,'R2_INSPECTION_TIMEOUT');
        if(error instanceof ApiError&&['FILE_SIZE_MISMATCH','FILE_HASH_MISMATCH','FILE_ETAG_MISMATCH','R2_INVALID_OBJECT','R2_INCOMPLETE_INSPECTION'].includes(error.code))throw error;
        throw new ApiError(502,'R2_INSPECTION_UNAVAILABLE');
      }finally{clearTimeout(deadline);signal?.removeEventListener('abort',cancel);controller.abort();body?.destroy();meter?.destroy();observeResources?.(Promise.allSettled(pendingOperations));}
  }
  return {
    storageTargetId:createHash('sha256').update(JSON.stringify([c.accountId,c.jurisdiction,c.bucket])).digest('hex'),
    maximumUploadBytes:c.maximumUploadBytes,
    // Operator backup building block only;not an API authorization boundary or
    // a complete backup. Stream pages instead of buffering a whole academy.
    async mediaInventoryPage(stage:'quarantine'|'clean',continuationToken?:string,limit=1000,signal?:AbortSignal){
     if(closed)throw new ApiError(503,'R2_CONNECTION_CLOSED');
     const input=z.object({stage:z.enum(['quarantine','clean']),continuationToken:z.string().min(1).max(4096).optional(),limit:z.number().int().min(1).max(1000)}).safeParse({stage,continuationToken,limit});
     if(!input.success)throw new ApiError(400,'INVALID_MEDIA_INVENTORY_REQUEST');
     if(signal?.aborted)throw new ApiError(502,'R2_INVENTORY_CANCELLED');
     const prefix=`academies/${academy.data}/${stage}/`;
     try{
      const response=await client.send(new ListObjectsV2Command({Bucket:c.bucket,Prefix:prefix,MaxKeys:limit,...continuationToken?{ContinuationToken:continuationToken}:{}}),{abortSignal:signal?AbortSignal.any([signal,AbortSignal.timeout(30000)]):AbortSignal.timeout(30000)});
      if(response.Name!==c.bucket||response.Prefix!==prefix||typeof response.IsTruncated!=='boolean'||(response.Contents?.length??0)>limit)throw new Error();
      const objects=(response.Contents??[]).map(object=>{
       if(!object.Key?.startsWith(prefix))throw new Error();
       const fileId=uuid.parse(object.Key.slice(prefix.length));if(object.Key!==prefix+fileId)throw new Error();
       const metadata=z.object({fileId:uuid,bytes:z.number().int().positive().max(4294967296),etag:z.string().min(3).max(202).regex(/^"[\x21\x23-\x7e]+"$/),modifiedAt:z.iso.datetime()}).parse({fileId,bytes:object.Size,etag:object.ETag,modifiedAt:object.LastModified?.toISOString()});
       return metadata;
      });
      if(new Set(objects.map(object=>object.fileId)).size!==objects.length||response.KeyCount!==undefined&&response.KeyCount!==objects.length)throw new Error();
      const next=response.IsTruncated?z.string().min(1).max(4096).parse(response.NextContinuationToken):null;
      if(next===continuationToken||!response.IsTruncated&&response.NextContinuationToken!==undefined)throw new Error();
      return{academyId:academy.data,storageTargetId:createHash('sha256').update(JSON.stringify([c.accountId,c.jurisdiction,c.bucket])).digest('hex'),stage,objects,nextContinuationToken:next,completeBackup:false as const};
     }catch{throw new ApiError(502,signal?.aborted?'R2_INVENTORY_CANCELLED':'R2_INVENTORY_UNAVAILABLE');}
    },
    inspectQuarantine<T>(fileId:string,claims:z.input<typeof inspectionClaims>,inspect:(source:Readable,signal:AbortSignal)=>Promise<T>,timeoutMs=120000,signal?:AbortSignal){return inspectStored('quarantine',fileId,claims,inspect,timeoutMs,signal);},
    // Optional lifecycle observer lets buffering callers retain admission until
    // actual IO/inspection settlement,not merely a timeout's early rejection.
    inspectClean<T>(fileId:string,claims:z.input<typeof inspectionClaims>,inspect:(source:Readable,signal:AbortSignal)=>Promise<T>,timeoutMs=120000,signal?:AbortSignal,observeResources?:(settled:Promise<unknown>)=>void){return inspectStored('clean',fileId,claims,inspect,timeoutMs,signal,observeResources);},
    // Exact conditional single-range read of a verified clean object only.
    // Returned hash/bytes describe THIS RANGE,never the full file or a scan.
    async inspectCleanRange<T>(fileId:string,claims:{bytes:number;ifMatch:string},range:z.infer<typeof byteRange>,inspect:(source:Readable,signal:AbortSignal)=>Promise<T>,timeoutMs=120000,signal?:AbortSignal,observeResources?:(settled:Promise<unknown>)=>void){
      const checked=z.object({bytes:z.number().int().min(1).max(134217728),ifMatch:z.string().min(3).max(202).regex(/^"[\x21\x23-\x7e]+"$/)}).strict().safeParse(claims),selected=byteRange.safeParse(range);if(!checked.success||!selected.success)throw new ApiError(400,'INVALID_PRIVATE_BYTE_RANGE');
      return inspectStored('clean',fileId,checked.data,inspect,timeoutMs,signal,observeResources,selected.data);
    },
    // Worker-only full-byte inspection. Attachment signing below is separate
    // and requires its own native audited grant and explicit reviewed policy.
    inspectSignatureEvidence<T>(fileId:string,claims:z.input<typeof inspectionClaims>,inspect:(source:Readable,signal:AbortSignal)=>Promise<T>,timeoutMs=30000,signal?:AbortSignal,observeResources?:(settled:Promise<unknown>)=>void){return inspectStored('signature-evidence',fileId,claims,inspect,timeoutMs,signal,observeResources);},
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
    cleanDownload(fileId:string,expiresSeconds=60,conditions:{issuedAt?:string;ifMatch?:string}={}) {return attachmentDownload('clean',fileId,expiresSeconds,conditions);},
    signatureEvidenceDownload(fileId:string,expiresSeconds:number,conditions:{issuedAt:string;ifMatch:string}) {return attachmentDownload('signature-evidence',fileId,expiresSeconds,conditions);},
    close(){if(!closed){closed=true;client.destroy();}}
  };
  async function attachmentDownload(stage:'clean'|'signature-evidence',fileId:string,expiresSeconds:number,conditions:{issuedAt?:string;ifMatch?:string}) {
      const valid=z.object({issuedAt:z.iso.datetime().optional(),ifMatch:z.string().min(3).max(202).regex(/^"[\x21\x23-\x7e]+"$/).optional()}).strict().safeParse(conditions);
      if(!valid.success)throw new ApiError(400,'INVALID_FILE_DOWNLOAD_CONDITION');
      if(stage==='signature-evidence'&&(!valid.data.issuedAt||!valid.data.ifMatch))throw new ApiError(400,'INVALID_FILE_DOWNLOAD_CONDITION');
      const objectKey=key(stage,fileId),time=expiry(expiresSeconds,60,valid.data.issuedAt);
      try {
        const url=await getSignedUrl(client,new GetObjectCommand({Bucket:c.bucket,Key:objectKey,ResponseContentType:'application/octet-stream',ResponseContentDisposition:'attachment',ResponseCacheControl:'private, no-store',...(valid.data.ifMatch?{IfMatch:valid.data.ifMatch}:{})}),{expiresIn:time.expiresIn,signingDate:time.signingDate,...(valid.data.ifMatch?{signableHeaders:new Set(['if-match'])}:{})});
        return {url,method:'GET' as const,expiresAt:time.expiresAt,...(valid.data.ifMatch?{headers:{'if-match':valid.data.ifMatch}}:{})};
      }catch{throw new ApiError(502,'R2_LINK_UNAVAILABLE');}
    }
}
