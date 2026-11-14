import { z } from 'zod';
import { assertSchemaReady,type Connection,type Database } from '../core/database.ts';
import { privateR2 } from '../integrations/r2.ts';
import type { R2UploadConnections } from '../integrations/r2-config.ts';
import { scanWithClamd,type ClamdConfiguration } from '../integrations/clamav.ts';
import { clamdDatabasePolicy,clamdDatabaseObservation,scanWithFreshClamd,type ClamdDatabasePolicy } from '../integrations/clamav-database.ts';
import { ApiError } from '../core/policy.ts';
import type { S3ClientConfig } from '@aws-sdk/client-s3';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { detectContentSignature,maximumSignatureSampleBytes,signatureSchema } from './content-signature.ts';
import { imageValidationSchema,imageMimeSchema,maximumImageInputBytes } from './image-validation.ts';
import { imageServiceConfiguration,validateImageViaService } from './image-service.ts';
import { pdfValidationSchema,pdfValidationMatches,maximumPdfInputBytes } from './pdf-validation.ts';
import { pdfServiceConfiguration,validatePdfViaService } from './pdf-service.ts';
import { videoValidationSchema,videoValidationMatches,videoMimeSchema,maximumVideoInputBytes } from './video-validation.ts';
import { videoServiceConfiguration,validateVideoViaService } from './video-service.ts';
import { textValidationSchema,validateText,textValidationMatches,maximumTextInputBytes } from './text-validation.ts';

const uuid=z.string().uuid().transform(v=>v.toLowerCase()),digest=z.string().regex(/^[a-f0-9]{64}$/);
const taskSchema=z.object({academyId:uuid,inspectionId:uuid,fileId:uuid,storageTargetId:digest,leaseToken:uuid,attemptNo:z.number().int().min(1).max(5),expectedBytes:z.number().int().min(1).max(4_294_967_296),expectedSha256:digest.nullable(),claimedMimeType:z.string().min(1).max(201)}).strict();
export type InspectionTask=z.infer<typeof taskSchema>;
const measured={bytes:z.number().int().min(1).max(4_294_967_296),sha256:digest,etag:z.string().min(3).max(202).regex(/^"[\x21\x23-\x7e]+"$/),providerContentType:z.string().min(1).max(200).regex(/^[\x20-\x7e]+$/),signature:signatureSchema.optional()};
const problem=z.enum(['STORAGE_UNAVAILABLE','SCANNER_UNAVAILABLE','INSPECTION_TIMEOUT','INSPECTOR_INVALID_RESULT','WORKER_STOPPED','TARGET_UNAVAILABLE']);
const resultSchema=z.discriminatedUnion('outcome',[
  z.object({outcome:z.literal('no_detection'),...measured,imageValidation:imageValidationSchema.optional(),databaseObservation:clamdDatabaseObservation.optional(),pdfValidation:pdfValidationSchema.optional(),textValidation:textValidationSchema.optional(),videoValidation:videoValidationSchema.optional()}).strict(),z.object({outcome:z.literal('detected'),...measured}).strict(),
  z.object({outcome:z.literal('content_mismatch')}).strict(),z.object({outcome:z.literal('unavailable'),reason:problem}).strict()
]);
export type InspectionResult=z.infer<typeof resultSchema>;

export async function assertFileWorkerRole(db:Connection) {
  const result=await db.query<{safe:boolean}>(`SELECT NOT r.rolsuper AND NOT r.rolbypassrls
   AND pg_has_role(current_user,'kavosh_file_worker','member')
   AND NOT EXISTS(SELECT 1 FROM pg_roles b WHERE b.rolname IN ('kavosh_profile_image_worker','kavosh_signature_ingest','kavosh_signature_policy','kavosh_signature_result_worker','kavosh_signature_result_policy','kavosh_signature_completion_worker','kavosh_signature_completion_policy','kavosh_signature_evidence_worker','kavosh_signature_evidence_policy') AND pg_has_role(current_user,b.oid,'member'))
   AND NOT EXISTS(SELECT 1 FROM pg_roles blocked WHERE blocked.rolname IN ('kavosh_runtime','kavosh_identity','kavosh_delivery','kavosh_identity_policy','kavosh_file_policy') AND pg_has_role(current_user,blocked.oid,'member'))
   AND NOT has_schema_privilege(current_user,'auth_private','usage') AND NOT has_schema_privilege(current_user,'identity','usage') AND NOT has_schema_privilege(current_user,'public','create')
   AND NOT EXISTS(SELECT 1 FROM pg_namespace n WHERE n.nspname='platform_private' AND has_schema_privilege(current_user,n.oid,'usage'))
   AND NOT EXISTS(SELECT 1 FROM pg_database d WHERE d.datname=current_database() AND pg_has_role(current_user,d.datdba,'member'))
   AND NOT EXISTS(SELECT 1 FROM pg_namespace n WHERE n.nspname IN ('public','identity','auth_private') AND pg_has_role(current_user,n.nspowner,'member'))
   AND NOT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN ('public','identity','auth_private') AND pg_has_role(current_user,c.relowner,'member'))
   AND NOT EXISTS(SELECT 1 FROM pg_roles elevated WHERE (elevated.rolsuper OR elevated.rolbypassrls) AND pg_has_role(current_user,elevated.oid,'member')) AS safe
   FROM pg_roles r WHERE r.rolname=current_user`);
  if(!result.rows[0]?.safe)throw new Error('UNSAFE_FILE_WORKER_ROLE');
}

// Internal IO handler: no user-selected destination and no clean promotion.
// A daemon response is recorded evidence, not MIME/configuration/freshness
// attestation. Nothing in this worker may issue downloads or declare safe files.
export async function inspectStoredFile(task:InspectionTask,connections:R2UploadConnections,scanner:ClamdConfiguration,signal:AbortSignal,timeoutMs=120000,handler?:S3ClientConfig['requestHandler'],imageService?:z.infer<typeof imageServiceConfiguration>,databasePolicy?:ClamdDatabasePolicy,pdfService?:z.infer<typeof pdfServiceConfiguration>,videoService?:z.infer<typeof videoServiceConfiguration>):Promise<InspectionResult> {
  let service:ReturnType<typeof privateR2>|undefined,scannerFailed=false,inspectionFailure:z.infer<typeof problem>|undefined;
  try {
    if(signal.aborted)return {outcome:'unavailable',reason:'WORKER_STOPPED'};
    if(imageService&&!imageServiceConfiguration.safeParse(imageService).success)return {outcome:'unavailable',reason:'TARGET_UNAVAILABLE'};
    if(pdfService&&!pdfServiceConfiguration.safeParse(pdfService).success)return {outcome:'unavailable',reason:'TARGET_UNAVAILABLE'};
    if(videoService&&!videoServiceConfiguration.safeParse(videoService).success)return {outcome:'unavailable',reason:'TARGET_UNAVAILABLE'};
    const selectedDatabasePolicy=databasePolicy===undefined?undefined:clamdDatabasePolicy.safeParse(databasePolicy);
    if(selectedDatabasePolicy&&!selectedDatabasePolicy.success)return {outcome:'unavailable',reason:'TARGET_UNAVAILABLE'};
    const database=selectedDatabasePolicy?.success?selectedDatabasePolicy.data:undefined;
    const decodeImage=Boolean(imageService&&imageMimeSchema.safeParse(task.claimedMimeType).success),decodeVideo=Boolean(videoService&&videoMimeSchema.safeParse(task.claimedMimeType).success);
    if(decodeVideo&&task.expectedBytes>maximumVideoInputBytes)return {outcome:'unavailable',reason:'TARGET_UNAVAILABLE'};
    const screenPdf=Boolean(pdfService&&task.claimedMimeType==='application/pdf'),screenText=task.claimedMimeType==='text/plain';
    if(screenText&&task.expectedBytes>maximumTextInputBytes)return {outcome:'unavailable',reason:'TARGET_UNAVAILABLE'};
    if(decodeImage&&task.expectedBytes>maximumImageInputBytes)return {outcome:'unavailable',reason:'TARGET_UNAVAILABLE'};
    if(screenPdf&&(task.expectedBytes<9||task.expectedBytes>maximumPdfInputBytes))return {outcome:'unavailable',reason:'TARGET_UNAVAILABLE'};
    if(task.expectedBytes>scanner.maximumBytes)return {outcome:'unavailable',reason:'TARGET_UNAVAILABLE'};
    const connection=connections(task.academyId);if(!connection)return {outcome:'unavailable',reason:'TARGET_UNAVAILABLE'};
    service=privateR2(connection,task.academyId,handler);if(service.storageTargetId!==task.storageTargetId)return {outcome:'unavailable',reason:'TARGET_UNAVAILABLE'};
    const claims={bytes:task.expectedBytes,...(task.expectedSha256?{sha256:task.expectedSha256}:{})};
    const result=await service.inspectQuarantine(task.fileId,claims,async(source,storageSignal)=>{
      const combined=AbortSignal.any([signal,storageSignal]),prefix=Buffer.alloc(Math.min(task.expectedBytes,maximumSignatureSampleBytes)),formatBytes=decodeImage||screenPdf||screenText||decodeVideo?Buffer.alloc(task.expectedBytes):null;let used=0,collected=0;
      const sampled=new Transform({highWaterMark:65536,transform(chunk:Buffer,_encoding,callback){
        if(formatBytes){if(collected+chunk.length>formatBytes.length){callback(new ApiError(400,'FILE_SIZE_MISMATCH'));return;}collected+=chunk.copy(formatBytes,collected);}
        used+=chunk.copy(prefix,used,0,prefix.length-used);callback(null,chunk);
      }});
      try {
        const scanning=database?scanWithFreshClamd(scanner,database,sampled,claims,combined):scanWithClamd(scanner,sampled,claims,combined).then(scan=>({...scan,database:null}));
        const [,scan]=await Promise.all([pipeline(source,sampled),scanning.catch(error=>{scannerFailed=true;throw error;})]);
        // Detection already rejects the file. Do not parse rejected content or
        // let an unrelated format/decoder failure erase the critical receipt.
        if(scan.verdict==='detected')return {...scan,signature:undefined,imageValidation:undefined,pdfValidation:undefined,textValidation:undefined,videoValidation:undefined};
        // R2 deliberately sanitizes callback exceptions. Preserve only the
        // bounded stage classification here, never raw provider diagnostics.
        const signature=await detectContentSignature(prefix.subarray(0,used),{signal:combined}).catch(error=>{inspectionFailure=error instanceof ApiError&&error.code==='CONTENT_SIGNATURE_TIMEOUT'?'INSPECTION_TIMEOUT':'INSPECTOR_INVALID_RESULT';throw error;});
        // Decode only the complete bytes already streamed through the scanner;
        // never perform a second mutable object read or decode detected malware.
        const imageValidation=decodeImage?await validateImageViaService(formatBytes!,task.claimedMimeType,{...imageService!,signal:combined}).catch(error=>{inspectionFailure=error instanceof ApiError&&error.code==='IMAGE_SERVICE_TIMEOUT'?'INSPECTION_TIMEOUT':'TARGET_UNAVAILABLE';throw error;}):undefined;
        // Same already-scanned bytes,never another mutable object read. This
        // profile preserves unsigned sources and does not verify signed PDFs.
        const pdfValidation=screenPdf?await validatePdfViaService(formatBytes!,{...pdfService!,signal:combined}).catch(error=>{inspectionFailure=error instanceof ApiError&&error.code==='PDF_SERVICE_TIMEOUT'?'INSPECTION_TIMEOUT':'TARGET_UNAVAILABLE';throw error;}):undefined;
        const videoValidation=decodeVideo?await validateVideoViaService(formatBytes!,task.claimedMimeType,{...videoService!,signal:combined}).catch(error=>{inspectionFailure=error instanceof ApiError&&error.code==='VIDEO_SERVICE_TIMEOUT'?'INSPECTION_TIMEOUT':'TARGET_UNAVAILABLE';throw error;}):undefined;
        if(videoValidation?.outcome==='rejected'&&videoValidation.stage==='runtime'){inspectionFailure='TARGET_UNAVAILABLE';throw Error('VIDEO_RUNTIME_UNAVAILABLE');}
        return {...scan,signature,imageValidation,pdfValidation,videoValidation,textValidation:screenText?validateText(formatBytes!):undefined};
      }finally{sampled.destroy();formatBytes?.fill(0);}
    },timeoutMs,signal);
    if(result.sha256!==result.inspection.sha256||result.bytes!==result.inspection.bytes)return {outcome:'content_mismatch'};
    const measured={bytes:result.bytes,sha256:result.sha256,etag:result.provider.etag,providerContentType:result.provider.contentType,signature:result.inspection.signature};
    return result.inspection.verdict==='no_detection'?{outcome:'no_detection',...measured,...(result.inspection.imageValidation?{imageValidation:result.inspection.imageValidation}:{}),
      ...(result.inspection.pdfValidation?{pdfValidation:result.inspection.pdfValidation}:{}),
      ...(result.inspection.textValidation?{textValidation:result.inspection.textValidation}:{}),
      ...(result.inspection.videoValidation?{videoValidation:result.inspection.videoValidation}:{}),
      ...(result.inspection.database?{databaseObservation:result.inspection.database}:{})}:{outcome:'detected',...measured};
  }catch(error){
    if(signal.aborted)return {outcome:'unavailable',reason:'WORKER_STOPPED'};
    if(error instanceof ApiError&&['FILE_SIZE_MISMATCH','FILE_HASH_MISMATCH'].includes(error.code))return {outcome:'content_mismatch'};
    if(error instanceof ApiError&&error.code==='R2_INSPECTION_TIMEOUT')return {outcome:'unavailable',reason:'INSPECTION_TIMEOUT'};
    if(inspectionFailure)return {outcome:'unavailable',reason:inspectionFailure};
    return {outcome:'unavailable',reason:scannerFailed?'SCANNER_UNAVAILABLE':'STORAGE_UNAVAILABLE'};
  }finally{service?.close();}
}

export async function processOneInspection(database:Database,academies:string[],workerId:string,inspect:(task:InspectionTask,signal:AbortSignal)=>Promise<InspectionResult>,options:{timeoutMs?:number;signal?:AbortSignal}={}) {
  const ids=z.array(uuid).min(1).max(1000).refine(v=>new Set(v).size===v.length).parse(academies),worker=uuid.parse(workerId),timeout=z.number().int().min(1).max(600000).parse(options.timeoutMs??120000);
  if(options.signal?.aborted)return {claimed:false,recorded:false};
  let raw:unknown;const claim=await database.connect();
  try {
    await assertFileWorkerRole(claim);await assertSchemaReady(claim);
    raw=(await claim.query(`SELECT academy_id AS "academyId",inspection_id AS "inspectionId",file_id AS "fileId",storage_target_id AS "storageTargetId",lease_token AS "leaseToken",attempt_no AS "attemptNo",expected_bytes::float8 AS "expectedBytes",expected_sha256 AS "expectedSha256",claimed_mime_type AS "claimedMimeType"
      FROM public.claim_file_inspection($1,$2,$3)`,[ids,worker,Math.max(30,Math.ceil(timeout/1000)+30)])).rows[0];
  }finally{claim.release();}
  if(!raw)return {claimed:false,recorded:false};const task=taskSchema.parse(raw);
  const controller=new AbortController();let timedOut=false,rejectStop!:(error:Error)=>void,result:InspectionResult;
  const stopped=new Promise<never>((_resolve,reject)=>{rejectStop=reject;});
  const cancel=()=>{controller.abort();rejectStop(new Error('INSPECTION_STOPPED'));};
  options.signal?.addEventListener('abort',cancel,{once:true});const deadline=setTimeout(()=>{timedOut=true;cancel();},timeout);
  if(options.signal?.aborted)cancel();
  try {
    result=resultSchema.parse(await Promise.race([Promise.resolve().then(()=>{if(controller.signal.aborted)throw new Error('INSPECTION_STOPPED');return inspect(task,controller.signal);}),stopped]));
    if((result.outcome==='no_detection'||result.outcome==='detected')&&(result.bytes!==task.expectedBytes||(task.expectedSha256&&result.sha256!==task.expectedSha256)))result={outcome:'content_mismatch'};
    if(result.outcome==='no_detection'&&result.imageValidation&&(!['image/jpeg','image/png','image/webp','image/gif','image/avif'].includes(task.claimedMimeType)||result.imageValidation.inputBytes!==result.bytes||result.imageValidation.inputSha256!==result.sha256
      ||(result.imageValidation.outcome==='decoded'&&(result.imageValidation.mime!==task.claimedMimeType||result.signature?.mime!==task.claimedMimeType))))result={outcome:'unavailable',reason:'INSPECTOR_INVALID_RESULT'};
    if(result.outcome==='no_detection'&&result.videoValidation&&(!videoMimeSchema.safeParse(task.claimedMimeType).success||!videoValidationMatches(result.videoValidation,result.bytes,result.sha256,task.claimedMimeType)||(result.videoValidation.outcome==='decoded'?result.signature?.mime!==task.claimedMimeType:result.videoValidation.stage==='runtime')))result={outcome:'unavailable',reason:'INSPECTOR_INVALID_RESULT'};
    if(result.outcome==='no_detection'&&result.textValidation&&(task.claimedMimeType!=='text/plain'||!textValidationMatches(result.textValidation,result.bytes,result.sha256)))result={outcome:'unavailable',reason:'INSPECTOR_INVALID_RESULT'};
    if(result.outcome==='no_detection'&&result.pdfValidation&&(task.claimedMimeType!=='application/pdf'||!pdfValidationMatches(result.pdfValidation,result.bytes,result.sha256)
      ||(result.pdfValidation.outcome==='screened'&&result.signature?.mime!=='application/pdf')))result={outcome:'unavailable',reason:'INSPECTOR_INVALID_RESULT'};
  }catch{result={outcome:'unavailable',reason:options.signal?.aborted?'WORKER_STOPPED':timedOut?'INSPECTION_TIMEOUT':'INSPECTOR_INVALID_RESULT'};}
  finally{clearTimeout(deadline);options.signal?.removeEventListener('abort',cancel);controller.abort();}
  const measuredResult=result.outcome==='no_detection'||result.outcome==='detected'?result:null;
  const imageEvidence=result.outcome==='no_detection'?result.imageValidation:undefined;
  const databaseObservation=result.outcome==='no_detection'?result.databaseObservation:undefined;
  const pdfEvidence=result.outcome==='no_detection'?result.pdfValidation:undefined,textEvidence=result.outcome==='no_detection'?result.textValidation:undefined,videoEvidence=result.outcome==='no_detection'?result.videoValidation:undefined;
  const reason=result.outcome==='no_detection'?'MEASURED_NO_DETECTION':result.outcome==='detected'?'MEASURED_DETECTION':result.outcome==='content_mismatch'?'CONTENT_MISMATCH':result.reason;
  // No connection/transaction is held during object IO or scanning. A fencing
  // token and DB clock reject late workers; stale success never overwrites work.
  const finish=await database.connect();try {
    await assertFileWorkerRole(finish);await assertSchemaReady(finish);
    const response=await finish.query<{recorded:boolean}>('SELECT public.finish_file_inspection($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12::jsonb,$13::jsonb,$14::jsonb,$15::jsonb) AS recorded',[task.academyId,task.inspectionId,task.leaseToken,result.outcome,reason,measuredResult?.bytes??null,measuredResult?.sha256??null,measuredResult?.etag??null,measuredResult?.providerContentType??null,measuredResult?.signature?JSON.stringify(measuredResult.signature):null,imageEvidence?JSON.stringify(imageEvidence):null,databaseObservation?JSON.stringify(databaseObservation):null,pdfEvidence?JSON.stringify(pdfEvidence):null,textEvidence?JSON.stringify(textEvidence):null,videoEvidence?JSON.stringify(videoEvidence):null]);
    return {claimed:true,recorded:response.rows[0]?.recorded===true};
  }finally{finish.release();}
}
