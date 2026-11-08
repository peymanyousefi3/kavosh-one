import { createHash } from 'node:crypto';
import { S3Client,PutObjectCommand,type S3ClientConfig } from '@aws-sdk/client-s3';
import { z } from 'zod';
import { ApiError } from '../core/policy.ts';
import { r2Connection,r2TargetId,type R2Connection } from './r2-config.ts';
import { privateR2 } from './r2.ts';
import { signatureCompletionSourceSchema,workSignatureCompletionSourceSchema,type SignatureCompletionArtifacts } from './boldsign-completion.ts';

const kinds=['document','audit','properties'] as const,hash=(value:Uint8Array|string)=>createHash('sha256').update(value).digest('hex');
const options=z.object({targetId:z.string().regex(/^[a-f0-9]{64}$/),timeoutMs:z.number().int().min(1).max(30000).default(30000),signal:z.instanceof(AbortSignal).optional()}).strict();
let active=0;
function artifactId(purpose:'unified_enrollment'|'worker_services',academy:string,start:string,source:string,kind:string,sha256:string){
 const hex=hash(JSON.stringify([purpose==='worker_services'?'kavosh-work-signature-evidence-v1':'kavosh-signature-evidence-v1',academy,start,source,kind,sha256])).slice(0,32).split('');hex[12]='8';hex[16]=((Number.parseInt(hex[16],16)&3)|8).toString(16);const s=hex.join('');return `${s.slice(0,8)}-${s.slice(8,12)}-${s.slice(12,16)}-${s.slice(16,20)}-${s.slice(20)}`;
}
// Internal opt-in IO,not an authorization/admission/legal/malware boundary.
// Operator must provide a separately scoped NON-PUBLIC evidence bucket/key;
// real IAM/public-access/retention settings require deployment verification.
// Never infer this configuration from browser input or normal upload readers.
// Partial/unknown writes remain protected artifacts for recovery,not deletion.
async function retainEvidence(purpose:'unified_enrollment'|'worker_services',configuration:R2Connection,rawSource:unknown,evidence:SignatureCompletionArtifacts,rawOptions:z.input<typeof options>,handler?:S3ClientConfig['requestHandler']){
 const config=r2Connection.safeParse(configuration),source=(purpose==='worker_services'?workSignatureCompletionSourceSchema:signatureCompletionSourceSchema).safeParse(rawSource),settings=options.safeParse(rawOptions);
 if(!config.success||!source.success||!settings.success)throw new ApiError(400,'INVALID_SIGNATURE_EVIDENCE_STORAGE');
 const c=config.data,s=source.data,o=settings.data;if(r2TargetId(c)!==o.targetId)throw new ApiError(400,'SIGNATURE_EVIDENCE_TARGET_MISMATCH');
 if(o.signal?.aborted)throw new ApiError(503,'SIGNATURE_EVIDENCE_INTERRUPTED');if(active>=2)throw new ApiError(503,'SIGNATURE_EVIDENCE_BUSY');
 // ponytail: two retained bundles,each <=21MiB of owned snapshots per process.
 // Larger documents need separately bounded spool storage,not bigger queues.
 const artifacts:Partial<SignatureCompletionArtifacts>={};
 try{for(const kind of kinds){const a=evidence?.[kind],max=kind==='properties'?1048576:10485760;if(!a||!Buffer.isBuffer(a.bytes)||!Number.isInteger(a.sizeBytes)||a.sizeBytes<1||a.sizeBytes>max||a.sizeBytes>c.maximumUploadBytes||a.bytes.length!==a.sizeBytes||!/^[a-f0-9]{64}$/.test(a.sha256))throw Error();const bytes=Buffer.from(a.bytes);artifacts[kind]={bytes,sizeBytes:a.sizeBytes,sha256:a.sha256};if(hash(bytes)!==a.sha256)throw Error();}
  if(artifacts.document!.sha256===artifacts.audit!.sha256)throw Error();
 }catch{for(const a of Object.values(artifacts))a.bytes.fill(0);throw new ApiError(400,'INVALID_SIGNATURE_EVIDENCE_BYTES');}
 const snapshots=artifacts as SignatureCompletionArtifacts,reader=privateR2(c,s.academyId,handler),writer=new S3Client({endpoint:`https://${c.accountId}${c.jurisdiction==='eu'?'.eu':''}.r2.cloudflarestorage.com`,region:'auto',forcePathStyle:true,followRegionRedirects:false,maxAttempts:1,credentials:{accessKeyId:c.accessKeyId,secretAccessKey:c.secretAccessKey},requestChecksumCalculation:'WHEN_REQUIRED',responseChecksumValidation:'WHEN_REQUIRED',...(handler?{requestHandler:handler}:{})});
 const abort=new AbortController();let stop!:(reason:Error)=>void,writeAttempted=false;const stopped=new Promise<never>((_,reject)=>{stop=reject;}),resources:Promise<unknown>[]=[];
 const cancel=()=>{abort.abort();stop(new ApiError(503,writeAttempted?'SIGNATURE_EVIDENCE_OUTCOME_UNKNOWN':'SIGNATURE_EVIDENCE_INTERRUPTED'));};o.signal?.addEventListener('abort',cancel,{once:true});const timer=setTimeout(cancel,o.timeoutMs),deadline=Date.now()+o.timeoutMs;active++;
 const run=async()=>{
  const receipt={sourceFingerprint:s.sourceFingerprint} as {sourceFingerprint:string}&Record<typeof kinds[number],{id:string;sha256:string;sizeBytes:number}>,etags={} as Record<typeof kinds[number],string>;
  for(const kind of kinds){
   if(abort.signal.aborted)throw Error();const a=snapshots[kind],id=artifactId(purpose,s.academyId,s.startId,s.sourceFingerprint,kind,a.sha256);
   try{
    writeAttempted=true;
    // Atomic create-once,including concurrent recovery attempts. No overwrite,
    // delete,public ACL,URL,automatic bucket creation or blind write retry.
    // https://developers.cloudflare.com/r2/api/s3/extensions/
    await writer.send(new PutObjectCommand({Bucket:c.bucket,Key:`academies/${s.academyId}/signature-evidence/${id}`,Body:a.bytes,ContentLength:a.sizeBytes,ContentType:'application/octet-stream',ContentDisposition:'attachment',CacheControl:'private, no-store',IfNoneMatch:'*'}),{abortSignal:abort.signal});
   }catch(e){if(!e||typeof e!=='object'||!('$metadata' in e)||(e.$metadata as {httpStatusCode?:number})?.httpStatusCode!==412)throw e;}
   if(abort.signal.aborted||Date.now()>=deadline)throw Error();
   // PUT/412/ETag/custom checksum metadata alone cannot prove retention. Read
   // ALL actual stored bytes and verify length/hash using the existing meter.
   const read=await reader.inspectSignatureEvidence(id,{bytes:a.sizeBytes,sha256:a.sha256},async stream=>{for await(const _chunk of stream){if(abort.signal.aborted)throw Error();}return true;},Math.max(1,deadline-Date.now()),abort.signal,p=>resources.push(p));
   if(abort.signal.aborted||Date.now()>=deadline)throw Error();receipt[kind]={id,sha256:read.sha256,sizeBytes:read.bytes};etags[kind]=read.provider.etag;
  }
  return {receipt,storageTargetId:o.targetId,etags,bytesReadBackVerified:true as const,admissionCleared:false as const,malwareFreeVerified:false as const,legalValidityCertified:false as const};
 };
 const pending=run();
 // Timeout is not write finality. Hold snapshot memory/admission until actual
 // IO settles,including late read resources,then wipe only our owned copies.
 void pending.then(()=>{},()=>{}).then(async()=>{await Promise.allSettled(resources);for(const a of Object.values(snapshots))a.bytes.fill(0);active--;});
 try{if(o.signal?.aborted)cancel();return await Promise.race([pending,stopped]);}
 catch(e){if(e instanceof ApiError&&['FILE_HASH_MISMATCH','FILE_SIZE_MISMATCH'].includes(e.code))throw new ApiError(409,'SIGNATURE_EVIDENCE_STORED_BYTES_MISMATCH');throw new ApiError(503,writeAttempted?'SIGNATURE_EVIDENCE_OUTCOME_UNKNOWN':'SIGNATURE_EVIDENCE_INTERRUPTED');}
 finally{clearTimeout(timer);o.signal?.removeEventListener('abort',cancel);abort.abort();reader.close();writer.destroy();}
}
export const retainSignatureEvidence=(configuration:R2Connection,source:unknown,evidence:SignatureCompletionArtifacts,settings:z.input<typeof options>,handler?:S3ClientConfig['requestHandler'])=>retainEvidence('unified_enrollment',configuration,source,evidence,settings,handler);
export const retainWorkSignatureEvidence=(configuration:R2Connection,source:unknown,evidence:SignatureCompletionArtifacts,settings:z.input<typeof options>,handler?:S3ClientConfig['requestHandler'])=>retainEvidence('worker_services',configuration,source,evidence,settings,handler);
