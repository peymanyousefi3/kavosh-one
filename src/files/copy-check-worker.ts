import { z } from 'zod';
import { assertSchemaReady,type Database } from '../core/database.ts';
import { ApiError } from '../core/policy.ts';
import { assertFileWorkerRole } from './inspection-worker.ts';
import { privateR2 } from '../integrations/r2.ts';
import type { R2Connection } from '../integrations/r2-config.ts';
import type { S3ClientConfig } from '@aws-sdk/client-s3';

const uuid=z.string().uuid().transform(v=>v.toLowerCase()),digest=z.string().regex(/^[a-f0-9]{64}$/);
const taskSchema=z.object({academyId:uuid,checkId:uuid,copyId:uuid,fileId:uuid,leaseToken:uuid,attemptNo:z.number().int().min(1).max(5),sourceFingerprint:digest,
 expectedBytes:z.number().int().min(1).max(33554432),expectedSha256:digest,destinationTargetId:digest}).strict();
export type CopyCheckTask=z.infer<typeof taskSchema>;
export const copyCheckResult=z.discriminatedUnion('outcome',[
 z.object({outcome:z.literal('verified'),bytes:z.number().int().min(1).max(33554432),sha256:digest,destination:z.object({storageTargetId:digest,etag:z.string().min(3).max(202).regex(/^"[\x21\x23-\x7e]+"$/)}).strict()}).strict(),
 z.object({outcome:z.enum(['unavailable','mismatch'])}).strict()
]);
export type CopyCheckResult=z.infer<typeof copyCheckResult>;
let active=0;
// GET only. The operator supplies destination-read-only credentials;real IAM
// scope still needs verification. No quarantine access,PUT,delete or public URL.
export async function checkCopyDestination(task:CopyCheckTask,configuration:R2Connection|null,signal:AbortSignal,timeoutMs=120000,handler?:S3ClientConfig['requestHandler']):Promise<CopyCheckResult>{
 const parsed=taskSchema.safeParse(task);if(!parsed.success||!configuration||signal.aborted||active>=2)return {outcome:'unavailable'};
 let storage:ReturnType<typeof privateR2>|undefined;active++;
 try{
  storage=privateR2(configuration,task.academyId,handler);if(storage.storageTargetId!==task.destinationTargetId)return {outcome:'unavailable'};
  const measured=await storage.inspectClean(task.fileId,{bytes:task.expectedBytes,sha256:task.expectedSha256},async(stream,storageSignal)=>{for await(const _chunk of stream){if(signal.aborted||storageSignal.aborted)throw Error('COPY_CHECK_STOPPED');}return true;},timeoutMs,signal);
  return {outcome:'verified',bytes:measured.bytes,sha256:measured.sha256,destination:{storageTargetId:storage.storageTargetId,etag:measured.provider.etag}};
 }catch(error){return {outcome:error instanceof ApiError&&['FILE_SIZE_MISMATCH','FILE_HASH_MISMATCH'].includes(error.code)?'mismatch':'unavailable'};}
 finally{active--;storage?.close();}
}
export async function processOneCopyCheck(database:Database,academies:string[],workerId:string,check:(task:CopyCheckTask,signal:AbortSignal)=>Promise<CopyCheckResult>,options:{timeoutMs?:number;signal?:AbortSignal}={}){
 const ids=z.array(uuid).min(1).max(1000).refine(v=>new Set(v).size===v.length).parse(academies),worker=uuid.parse(workerId),timeout=z.number().int().min(1).max(600000).parse(options.timeoutMs??120000);
 if(options.signal?.aborted)return {claimed:false,recorded:false};let raw:unknown;const claim=await database.connect();try{
  await assertFileWorkerRole(claim);await assertSchemaReady(claim);
  raw=(await claim.query('SELECT academy_id AS "academyId",check_id AS "checkId",copy_id AS "copyId",file_id AS "fileId",lease_token AS "leaseToken",attempt_no AS "attemptNo",source_fingerprint AS "sourceFingerprint",expected_bytes::float8 AS "expectedBytes",expected_sha256 AS "expectedSha256",destination_target_id AS "destinationTargetId" FROM public.claim_file_copy_check($1,$2,$3)',[ids,worker,Math.max(30,Math.ceil(timeout/1000)+30)])).rows[0];
 }finally{claim.release();}
 if(!raw)return {claimed:false,recorded:false};const task=taskSchema.parse(raw),controller=new AbortController();let rejectStop!:(error:Error)=>void,result:CopyCheckResult;
 const stopped=new Promise<never>((_resolve,reject)=>{rejectStop=reject;}),cancel=()=>{controller.abort();rejectStop(new Error('COPY_CHECK_STOPPED'));};
 options.signal?.addEventListener('abort',cancel,{once:true});const timer=setTimeout(cancel,timeout);if(options.signal?.aborted)cancel();
 try{
  result=copyCheckResult.parse(await Promise.race([Promise.resolve().then(()=>{if(controller.signal.aborted)return {outcome:'unavailable' as const};return check(task,controller.signal);}),stopped]));
  if(result.outcome==='verified'&&(result.bytes!==task.expectedBytes||result.sha256!==task.expectedSha256||result.destination.storageTargetId!==task.destinationTargetId))result={outcome:'unavailable'};
 }catch{result={outcome:'unavailable'};} // Read failure never proves write absence.
 finally{clearTimeout(timer);options.signal?.removeEventListener('abort',cancel);controller.abort();}
 const finish=await database.connect();try{
  await assertFileWorkerRole(finish);await assertSchemaReady(finish);const r=await finish.query<{recorded:boolean}>('SELECT public.finish_file_copy_check($1,$2,$3,$4::jsonb) AS recorded',[task.academyId,task.checkId,task.leaseToken,JSON.stringify(result)]);return {claimed:true,recorded:r.rows[0]?.recorded===true};
 }finally{finish.release();}
}
