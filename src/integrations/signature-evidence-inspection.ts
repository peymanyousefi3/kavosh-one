import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { z } from 'zod';
import type { S3ClientConfig } from '@aws-sdk/client-s3';
import { ApiError } from '../core/policy.ts';
import { privateR2 } from './r2.ts';
import { r2Connection,r2TargetId,type R2Connection } from './r2-config.ts';
import { clamdConfiguration,type ClamdConfiguration } from './clamav.ts';
import { clamdDatabasePolicy,scanWithFreshClamd,type ClamdDatabasePolicy } from './clamav-database.ts';
import { pdfServiceConfiguration,validateSignedEvidencePdfViaService } from '../files/pdf-service.ts';
import { pdfValidationMatches } from '../files/pdf-validation.ts';

const uuid=z.string().uuid().transform(v=>v.toLowerCase()),hash=z.string().regex(/^[a-f0-9]{64}$/);
export const signatureEvidenceInspectionTaskSchema=z.object({academyId:uuid,evidenceId:uuid,sourceFingerprint:hash,kind:z.enum(['document','audit']),artifactId:uuid,storageTargetId:hash,bytes:z.number().int().min(9).max(10485760),sha256:hash,etag:z.string().min(3).max(202).regex(/^"[\x21\x23-\x7e]+"$/)}).strict();
const settings=z.object({timeoutMs:z.number().int().min(1).max(120000).default(30000),signal:z.instanceof(AbortSignal).optional()}).strict();
const markers={safeToServe:false,admissionCleared:false,cryptographicValidityVerified:false} as const;
let active=0;
// Internal IO only. A future durable controller must derive this exact task
// from the ORIGINAL retained evidence row,not browser IDs or caller booleans.
// Explicit separate read-only evidence credentials and isolated local services
// are operator requirements;no URL,write,provider call,daemon or auto-enable.
export async function inspectSignatureEvidence(configuration:R2Connection,raw:unknown,scanner:ClamdConfiguration,databasePolicy:ClamdDatabasePolicy,pdfService:z.infer<typeof pdfServiceConfiguration>,options:z.input<typeof settings>={},handler?:S3ClientConfig['requestHandler']){
 const config=r2Connection.safeParse(configuration),task=signatureEvidenceInspectionTaskSchema.safeParse(raw),av=clamdConfiguration.safeParse(scanner),policy=clamdDatabasePolicy.safeParse(databasePolicy),pdf=pdfServiceConfiguration.safeParse(pdfService),limits=settings.safeParse(options);
 if(!config.success||!task.success||!av.success||!policy.success||!pdf.success||!limits.success)throw new ApiError(400,'INVALID_SIGNATURE_EVIDENCE_INSPECTION');
 const t=task.data,o=limits.data;if(r2TargetId(config.data)!==t.storageTargetId||t.bytes>config.data.maximumUploadBytes||t.bytes>av.data.maximumBytes)throw new ApiError(400,'INVALID_SIGNATURE_EVIDENCE_INSPECTION');
 if(o.signal?.aborted)return {outcome:'unavailable' as const,reason:'INTERRUPTED' as const,...markers};
 // ponytail: two sequential <=10MiB PDF buffers per broker process. The
 // credential-free native service independently shares its own two-child cap.
 if(active>=2)throw new ApiError(503,'SIGNATURE_EVIDENCE_INSPECTION_BUSY');
 const storage=privateR2(config.data,t.academyId,handler);let resources:Promise<unknown>|undefined,scannerFailed=false,pdfFailed=false,contentMismatch=false;active++;
 try{
  const read=await storage.inspectSignatureEvidence(t.artifactId,{bytes:t.bytes,sha256:t.sha256,ifMatch:t.etag},async(source,storageSignal)=>{
   const stage=new AbortController(),signal=AbortSignal.any([stage.signal,storageSignal,...(o.signal?[o.signal]:[])]),buffer=Buffer.alloc(t.bytes);let used=0;
   const meter=new Transform({highWaterMark:65536,transform(chunk:Buffer,_encoding,done){if(used+chunk.length>buffer.length){contentMismatch=true;done(new Error('CONTENT_CHANGED'));return;}used+=chunk.copy(buffer,used);done(null,chunk);}});
   const transfer=pipeline(source,meter,{signal}),scanning=scanWithFreshClamd(av.data,policy.data,meter,{bytes:t.bytes,sha256:t.sha256},signal).catch(error=>{scannerFailed=true;if(error instanceof ApiError&&['FILE_HASH_MISMATCH','FILE_SIZE_MISMATCH'].includes(error.code))contentMismatch=true;throw error;});
   try{
    const [,scan]=await Promise.all([transfer,scanning]);if(scan.verdict==='detected')return {scan,pdfValidation:null};
    if(used!==buffer.length){contentMismatch=true;throw Error();}
    // SAME complete already-scanned bytes,not a second mutable object read.
    const validation=await validateSignedEvidencePdfViaService(buffer,{...pdf.data,signal}).catch(error=>{pdfFailed=true;throw error;});
    if(!pdfValidationMatches(validation,scan.bytes,scan.sha256)){contentMismatch=true;throw Error();}
    return {scan,pdfValidation:validation};
   }finally{stage.abort();meter.destroy();await Promise.allSettled([transfer,scanning]);buffer.fill(0);}
  },o.timeoutMs,o.signal,p=>{resources=p;});
  const {scan,pdfValidation}=read.inspection;if(read.bytes!==scan.bytes||read.sha256!==scan.sha256)return {outcome:'content_mismatch' as const,...markers};
  const measured={bytes:read.bytes,sha256:read.sha256,etag:read.provider.etag};
  if(scan.verdict==='detected')return {outcome:'detected' as const,...measured,...markers};
  if(!pdfValidation||!scan.database)throw Error();
  return {outcome:pdfValidation.outcome==='screened'?'screened' as const:'rejected' as const,...measured,databaseObservation:scan.database,pdfValidation,...markers};
 }catch(error){
  if(o.signal?.aborted)return {outcome:'unavailable' as const,reason:'INTERRUPTED' as const,...markers};
  if(contentMismatch||error instanceof ApiError&&['FILE_HASH_MISMATCH','FILE_SIZE_MISMATCH','FILE_ETAG_MISMATCH'].includes(error.code))return {outcome:'content_mismatch' as const,...markers};
  return {outcome:'unavailable' as const,reason:error instanceof ApiError&&error.code==='R2_INSPECTION_TIMEOUT'?'TIMEOUT' as const:scannerFailed?'SCANNER_UNAVAILABLE' as const:pdfFailed?'PDF_SERVICE_UNAVAILABLE' as const:'STORAGE_UNAVAILABLE' as const,...markers};
 }finally{storage.close();if(resources)void resources.then(()=>{active--;},()=>{active--;});else active--;}
}
