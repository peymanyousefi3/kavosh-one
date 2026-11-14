import { z } from 'zod';
import { assertSchemaReady,type Database } from '../core/database.ts';
import { ApiError } from '../core/policy.ts';
import { assertFileWorkerRole } from './inspection-worker.ts';
import { promoteQuarantinedFile } from '../integrations/r2-promotion.ts';
import { privateR2 } from '../integrations/r2.ts';
import type { R2Connection } from '../integrations/r2-config.ts';

const uuid=z.string().uuid().transform(v=>v.toLowerCase()),digest=z.string().regex(/^[a-f0-9]{64}$/);
const taskSchema=z.object({academyId:uuid,copyId:uuid,fileId:uuid,leaseToken:uuid,attemptNo:z.number().int().min(1).max(5),sourceFingerprint:digest,
 expectedBytes:z.number().int().min(1).max(134217728),expectedSha256:digest,sourceTargetId:digest,destinationTargetId:digest}).strict();
export type CopyTask=z.infer<typeof taskSchema>;
const endpoint=z.object({storageTargetId:digest,etag:z.string().min(3).max(202).regex(/^"[\x21\x23-\x7e]+"$/)}).strict();
export const copyResult=z.discriminatedUnion('outcome',[
 z.object({outcome:z.enum(['written_verified','existing_verified']),bytes:z.number().int().min(1).max(134217728),sha256:digest,source:endpoint,destination:endpoint}).strict(),
 z.object({outcome:z.enum(['unavailable','source_mismatch','destination_mismatch','outcome_unknown'])}).strict()
]);
export type CopyResult=z.infer<typeof copyResult>;
// Operator-injected exact target lookup only. No browser URLs,environment
// fallback,credentials in rows,daemon activation or download rights.
export async function copyStoredFile(task:CopyTask,connections:(academyId:string,targetId:string)=>R2Connection|null,signal:AbortSignal,timeoutMs=120000):Promise<CopyResult>{
 let source:R2Connection|null,destination:R2Connection|null;
 try{source=connections(task.academyId,task.sourceTargetId);destination=connections(task.academyId,task.destinationTargetId);}
 catch{return {outcome:'unavailable'};}
 if(!source||!destination)return {outcome:'unavailable'};
 let service:ReturnType<typeof privateR2>|undefined;
 try{
  service=privateR2(destination,task.academyId);if(service.storageTargetId!==task.destinationTargetId)return {outcome:'unavailable'};
  return await promoteQuarantinedFile(source,destination,{academyId:task.academyId,fileId:task.fileId,storageTargetId:task.sourceTargetId,bytes:task.expectedBytes,sha256:task.expectedSha256},{signal,timeoutMs});
 }catch(error){
  if(error instanceof ApiError){
   if(error.code==='FILE_PROMOTION_SOURCE_MISMATCH')return {outcome:'source_mismatch'};
   if(error.code==='FILE_PROMOTION_DESTINATION_MISMATCH')return {outcome:'destination_mismatch'};
   if(['INVALID_FILE_PROMOTION_CONFIGURATION','INVALID_FILE_PROMOTION_TARGET','FILE_PROMOTION_CANCELLED','FILE_PROMOTION_BUSY','FILE_PROMOTION_TIMEOUT','FILE_PROMOTION_UNAVAILABLE'].includes(error.code))return {outcome:'unavailable'};
  }
  return {outcome:'outcome_unknown'};
 }finally{service?.close();}
}
export async function processOneCopy(database:Database,academies:string[],workerId:string,copy:(task:CopyTask,signal:AbortSignal)=>Promise<CopyResult>,options:{timeoutMs?:number;signal?:AbortSignal}={}){
 const ids=z.array(uuid).min(1).max(1000).refine(v=>new Set(v).size===v.length).parse(academies),worker=uuid.parse(workerId),timeout=z.number().int().min(1).max(600000).parse(options.timeoutMs??120000);
 if(options.signal?.aborted)return {claimed:false,recorded:false};
 let raw:unknown;const claim=await database.connect();try{
  await assertFileWorkerRole(claim);await assertSchemaReady(claim);
  raw=(await claim.query('SELECT academy_id AS "academyId",copy_id AS "copyId",file_id AS "fileId",lease_token AS "leaseToken",attempt_no AS "attemptNo",source_fingerprint AS "sourceFingerprint",expected_bytes::float8 AS "expectedBytes",expected_sha256 AS "expectedSha256",source_target_id AS "sourceTargetId",destination_target_id AS "destinationTargetId" FROM public.claim_file_copy($1,$2,$3)',[ids,worker,Math.max(30,Math.ceil(timeout/1000)+30)])).rows[0];
 }finally{claim.release();}
 if(!raw)return {claimed:false,recorded:false};const task=taskSchema.parse(raw),controller=new AbortController();let rejectStop!:(error:Error)=>void,result:CopyResult;
 const stopped=new Promise<never>((_resolve,reject)=>{rejectStop=reject;}),cancel=()=>{controller.abort();rejectStop(new Error('COPY_STOPPED'));};
 options.signal?.addEventListener('abort',cancel,{once:true});const timer=setTimeout(cancel,timeout);if(options.signal?.aborted)cancel();
 try{
  result=copyResult.parse(await Promise.race([Promise.resolve().then(()=>{if(controller.signal.aborted)return {outcome:'unavailable' as const};return copy(task,controller.signal);}),stopped]));
  if('bytes' in result&&(result.bytes!==task.expectedBytes||result.sha256!==task.expectedSha256||result.source.storageTargetId!==task.sourceTargetId||result.destination.storageTargetId!==task.destinationTargetId))result={outcome:'outcome_unknown'};
 }catch{result={outcome:'outcome_unknown'};} // A malformed result/cancel cannot prove no physical write.
 finally{clearTimeout(timer);options.signal?.removeEventListener('abort',cancel);controller.abort();}
 const finish=await database.connect();try{
  await assertFileWorkerRole(finish);await assertSchemaReady(finish);
  const saved=await finish.query<{recorded:boolean}>('SELECT public.finish_file_copy($1,$2,$3,$4::jsonb) AS recorded',[task.academyId,task.copyId,task.leaseToken,JSON.stringify(result)]);
  return {claimed:true,recorded:saved.rows[0]?.recorded===true};
 }finally{finish.release();}
}
