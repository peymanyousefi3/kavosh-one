import { z } from 'zod';
import { assertSchemaReady,type Connection,type Database } from '../core/database.ts';
import { privateR2 } from '../integrations/r2.ts';
import type { R2UploadConnections } from '../integrations/r2-config.ts';
import { scanWithClamd,type ClamdConfiguration } from '../integrations/clamav.ts';
import { ApiError } from '../core/policy.ts';
import type { S3ClientConfig } from '@aws-sdk/client-s3';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { detectContentSignature,maximumSignatureSampleBytes,signatureSchema } from './content-signature.ts';
import { imageValidationSchema } from './image-validation.ts';

const uuid=z.string().uuid().transform(v=>v.toLowerCase()),digest=z.string().regex(/^[a-f0-9]{64}$/);
const taskSchema=z.object({academyId:uuid,inspectionId:uuid,fileId:uuid,storageTargetId:digest,leaseToken:uuid,attemptNo:z.number().int().min(1).max(5),expectedBytes:z.number().int().min(1).max(4_294_967_296),expectedSha256:digest.nullable(),claimedMimeType:z.string().min(1).max(201)}).strict();
export type InspectionTask=z.infer<typeof taskSchema>;
const measured={bytes:z.number().int().min(1).max(4_294_967_296),sha256:digest,etag:z.string().min(3).max(202).regex(/^"[\x21\x23-\x7e]+"$/),providerContentType:z.string().min(1).max(200).regex(/^[\x20-\x7e]+$/),signature:signatureSchema.optional()};
const problem=z.enum(['STORAGE_UNAVAILABLE','SCANNER_UNAVAILABLE','INSPECTION_TIMEOUT','INSPECTOR_INVALID_RESULT','WORKER_STOPPED','TARGET_UNAVAILABLE']);
const resultSchema=z.discriminatedUnion('outcome',[
  z.object({outcome:z.literal('no_detection'),...measured,imageValidation:imageValidationSchema.optional()}).strict(),z.object({outcome:z.literal('detected'),...measured}).strict(),
  z.object({outcome:z.literal('content_mismatch')}).strict(),z.object({outcome:z.literal('unavailable'),reason:problem}).strict()
]);
export type InspectionResult=z.infer<typeof resultSchema>;

export async function assertFileWorkerRole(db:Connection) {
  const result=await db.query<{safe:boolean}>(`SELECT NOT r.rolsuper AND NOT r.rolbypassrls
   AND pg_has_role(current_user,'kavosh_file_worker','member')
   AND NOT EXISTS(SELECT 1 FROM pg_roles b WHERE b.rolname IN ('kavosh_signature_ingest','kavosh_signature_policy') AND pg_has_role(current_user,b.oid,'member'))
   AND NOT EXISTS(SELECT 1 FROM pg_roles blocked WHERE blocked.rolname IN ('kavosh_runtime','kavosh_identity','kavosh_delivery','kavosh_identity_policy','kavosh_file_policy') AND pg_has_role(current_user,blocked.oid,'member'))
   AND NOT has_schema_privilege(current_user,'auth_private','usage') AND NOT has_schema_privilege(current_user,'identity','usage') AND NOT has_schema_privilege(current_user,'public','create')
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
export async function inspectStoredFile(task:InspectionTask,connections:R2UploadConnections,scanner:ClamdConfiguration,signal:AbortSignal,timeoutMs=120000,handler?:S3ClientConfig['requestHandler']):Promise<InspectionResult> {
  let service:ReturnType<typeof privateR2>|undefined,scannerFailed=false;
  try {
    if(signal.aborted)return {outcome:'unavailable',reason:'WORKER_STOPPED'};
    if(task.expectedBytes>scanner.maximumBytes)return {outcome:'unavailable',reason:'TARGET_UNAVAILABLE'};
    const connection=connections(task.academyId);if(!connection)return {outcome:'unavailable',reason:'TARGET_UNAVAILABLE'};
    service=privateR2(connection,task.academyId,handler);if(service.storageTargetId!==task.storageTargetId)return {outcome:'unavailable',reason:'TARGET_UNAVAILABLE'};
    const claims={bytes:task.expectedBytes,...(task.expectedSha256?{sha256:task.expectedSha256}:{})};
    const result=await service.inspectQuarantine(task.fileId,claims,async(source,storageSignal)=>{
      const combined=AbortSignal.any([signal,storageSignal]),prefix=Buffer.alloc(Math.min(task.expectedBytes,maximumSignatureSampleBytes));let used=0;
      const sampled=new Transform({highWaterMark:65536,transform(chunk:Buffer,_encoding,callback){used+=chunk.copy(prefix,used,0,prefix.length-used);callback(null,chunk);}});
      try {
        const [,scan]=await Promise.all([pipeline(source,sampled),scanWithClamd(scanner,sampled,claims,combined).catch(error=>{scannerFailed=true;throw error;})]);
        const signature=await detectContentSignature(prefix.subarray(0,used),{signal:combined});return {...scan,signature};
      }finally{sampled.destroy();}
    },timeoutMs,signal);
    if(result.sha256!==result.inspection.sha256||result.bytes!==result.inspection.bytes)return {outcome:'content_mismatch'};
    return {outcome:result.inspection.verdict,bytes:result.bytes,sha256:result.sha256,etag:result.provider.etag,providerContentType:result.provider.contentType,signature:result.inspection.signature};
  }catch(error){
    if(error instanceof ApiError&&['FILE_SIZE_MISMATCH','FILE_HASH_MISMATCH'].includes(error.code))return {outcome:'content_mismatch'};
    if(error instanceof ApiError&&error.code==='R2_INSPECTION_TIMEOUT')return {outcome:'unavailable',reason:'INSPECTION_TIMEOUT'};
    if(error instanceof ApiError&&error.code.startsWith('CONTENT_SIGNATURE_'))return {outcome:'unavailable',reason:error.code==='CONTENT_SIGNATURE_TIMEOUT'?'INSPECTION_TIMEOUT':'INSPECTOR_INVALID_RESULT'};
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
  }catch{result={outcome:'unavailable',reason:options.signal?.aborted?'WORKER_STOPPED':timedOut?'INSPECTION_TIMEOUT':'INSPECTOR_INVALID_RESULT'};}
  finally{clearTimeout(deadline);options.signal?.removeEventListener('abort',cancel);controller.abort();}
  const measuredResult=result.outcome==='no_detection'||result.outcome==='detected'?result:null;
  const imageEvidence=result.outcome==='no_detection'?result.imageValidation:undefined;
  const reason=result.outcome==='no_detection'?'MEASURED_NO_DETECTION':result.outcome==='detected'?'MEASURED_DETECTION':result.outcome==='content_mismatch'?'CONTENT_MISMATCH':result.reason;
  // No connection/transaction is held during object IO or scanning. A fencing
  // token and DB clock reject late workers; stale success never overwrites work.
  const finish=await database.connect();try {
    await assertFileWorkerRole(finish);await assertSchemaReady(finish);
    const response=await finish.query<{recorded:boolean}>('SELECT public.finish_file_inspection($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb) AS recorded',[task.academyId,task.inspectionId,task.leaseToken,result.outcome,reason,measuredResult?.bytes??null,measuredResult?.sha256??null,measuredResult?.etag??null,measuredResult?.providerContentType??null,measuredResult?.signature?JSON.stringify(measuredResult.signature):null,imageEvidence?JSON.stringify(imageEvidence):null]);
    return {claimed:true,recorded:response.rows[0]?.recorded===true};
  }finally{finish.release();}
}
