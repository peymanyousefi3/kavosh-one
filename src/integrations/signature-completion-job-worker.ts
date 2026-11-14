import { z } from 'zod';
import { ApiError } from '../core/policy.ts';
import { assertSchemaReady,type Database,type Connection } from '../core/database.ts';
import { assertSignatureCompletionRole } from './signature-completion-source.ts';
import { processEnrollmentCompletion,processWorkCompletion } from './completion-orchestrator.ts';

const uuid=z.string().uuid().transform(v=>v.toLowerCase());
const input=z.object({academyIds:z.array(uuid).min(1).max(1000),workerId:uuid,retrySeconds:z.number().int().min(60).max(86400).default(21600)}).strict();
const claim=z.object({academy_id:uuid,purpose:z.enum(['unified_enrollment','worker_services']),start_id:uuid,lease_token:uuid,source_fingerprint:z.string().regex(/^[a-f0-9]{64}$/),attempt_no:z.number().int().positive()}).strict();
type Services=Parameters<typeof processEnrollmentCompletion>[1];
// Connection exists only for the short native broker operation, not network IO.
async function broker<T>(database:Database,run:(c:Connection)=>Promise<T>){
 let c:Connection|undefined;
 try{c=await database.connect();await assertSignatureCompletionRole(c);await assertSchemaReady(c);return await run(c);}
 catch{throw new ApiError(503,'SIGNATURE_COMPLETION_QUEUE_UNAVAILABLE');}finally{c?.release();}
}
export async function processOneSignatureCompletion(raw:unknown,services:Services,options:{enabled?:boolean;signal?:AbortSignal}={}){
 const parsed=input.safeParse(raw);if(!parsed.success)throw new ApiError(400,'INVALID_SIGNATURE_COMPLETION_WORKER');
 if(options.enabled!==true)return {state:'disabled' as const};
 if(options.signal?.aborted)return {state:'interrupted' as const};
 const i=parsed.data;
 const job=await broker(services.database,async c=>{
  const rows=(await c.query('SELECT * FROM public.claim_signature_completion_job($1,$2,120)',[i.academyIds,i.workerId])).rows;
  if(rows.length>1)throw Error();if(!rows.length)return null;
  const task=claim.parse(rows[0]);if(!i.academyIds.includes(task.academy_id))throw Error();return task;
 });
 if(!job)return {state:'idle' as const};
 const signal=options.signal?AbortSignal.any([options.signal,AbortSignal.timeout(90000)]):AbortSignal.timeout(90000);
 let outcome:'recorded'|'not_completed'|'unavailable'='unavailable',evidenceId:string|null=null;
 try{
  const run=job.purpose==='worker_services'?processWorkCompletion:processEnrollmentCompletion;
  const result=await run({academyId:job.academy_id,startId:job.start_id},services,{enabled:true,signal,sourceFingerprint:job.source_fingerprint});
  if(result.evidenceRecorded&&'id'in result){outcome='recorded';evidenceId=uuid.parse(result.id);}
  else if(result.state==='not_completed')outcome='not_completed';
 }catch{/* Native retry history contains only the generic outcome, never signer data or credentials. */}
 const recorded=await broker(services.database,async c=>{
  const row=(await c.query<{recorded:boolean}>('SELECT public.finish_signature_completion_job($1,$2,$3,$4,$5,$6,$7) recorded',[job.academy_id,job.purpose,job.start_id,job.lease_token,outcome,evidenceId,i.retrySeconds])).rows[0];
  if(typeof row?.recorded!=='boolean')throw Error();return row.recorded;
 });
 return {state:recorded?outcome:'lease_lost' as const,admissionCleared:false,paymentCleared:false,providerMutationPerformed:false};
}
