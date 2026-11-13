import {createHash} from 'node:crypto';
import type {FileHandle} from 'node:fs/promises';
import type pg from 'pg';
import {z} from 'zod';
import {RecoveryError} from './recovery-error.ts';

const uuid=z.string().uuid(),sha=z.string().regex(/^[a-f0-9]{64}$/);
export const recordedMediaReference=z.object({academyId:uuid,stage:z.enum(['quarantine','clean']),storageTargetId:sha,fileId:uuid,bytes:z.coerce.number().int().positive().max(4294967296),sha256:sha}).strict();
const bindingInput=z.object({databaseBackupId:uuid,archiveSha256:sha,schemaRevision:z.number().int().positive()}).strict();
// Historical physical observations only. Pending grants are not fabricated
// uploads;archived files and superseded routes still require their old bytes.
const references=`SELECT * FROM(SELECT DISTINCT "academyId",stage,"storageTargetId","fileId",bytes,sha256 FROM(
 SELECT q.academy_id "academyId",'quarantine'::text stage,q.storage_target_id "storageTargetId",q.file_id "fileId",a.measured_bytes bytes,a.sha256
 FROM public.file_inspection_requests q JOIN public.file_inspection_attempts a ON a.academy_id=q.academy_id AND a.inspection_id=q.id WHERE a.outcome IN('no_detection','detected')
 UNION ALL
 SELECT r.academy_id,'clean',a.destination_target_id,r.file_id,a.measured_bytes,a.sha256 FROM public.file_copy_requests r JOIN public.file_copy_attempts a ON a.academy_id=r.academy_id AND a.copy_id=r.id WHERE a.outcome IN('written_verified','existing_verified')
 UNION ALL
 SELECT r.academy_id,'clean',a.destination_target_id,r.file_id,a.measured_bytes,a.sha256 FROM public.file_copy_requests r JOIN public.file_copy_checks c ON c.academy_id=r.academy_id AND c.copy_id=r.id JOIN public.file_copy_check_attempts a ON a.academy_id=c.academy_id AND a.check_id=c.id WHERE a.outcome='verified'
 ) observed) refs ORDER BY "academyId",stage COLLATE "C","storageTargetId" COLLATE "C","fileId",bytes,sha256 COLLATE "C"`;
const academies=`SELECT a.id "academyId",coalesce(g.pending,0) "unconfirmedUploads" FROM public.academies a LEFT JOIN(
 SELECT g.academy_id,count(DISTINCT(g.file_id,g.storage_target_id)) pending FROM public.file_upload_grants g
 WHERE NOT EXISTS(SELECT 1 FROM public.file_inspection_requests q JOIN public.file_inspection_attempts e ON e.academy_id=q.academy_id AND e.inspection_id=q.id WHERE q.academy_id=g.academy_id AND q.file_id=g.file_id AND q.storage_target_id=g.storage_target_id AND e.outcome IN('no_detection','detected')) GROUP BY g.academy_id
 ) g ON g.academy_id=a.id ORDER BY a.id`;

// Caller supplies an exclusively created private metadata file and the SAME
// read-only snapshot used by pg_dump. FETCH bounds memory,not a giant rows array.
// No R2 IO,privileged broker call,grant change or private user value is needed.
export async function captureMediaReferencePlan(client:pg.Client,output:FileHandle,rawBinding:unknown,signal?:AbortSignal){
 const parsed=bindingInput.safeParse(rawBinding);if(!parsed.success)throw new RecoveryError('INVALID_MEDIA_REFERENCE_BINDING');const binding=parsed.data;
 const hash=createHash('sha256');let bytes=0,schools=0,rows=0,unconfirmedUploads=0,cursor:string|undefined,lastIdentity='';
 async function write(values:unknown[]){if(signal?.aborted)throw new RecoveryError('RECOVERY_CANCELLED');const text=values.map(value=>JSON.stringify(value)+'\n').join('');bytes+=Buffer.byteLength(text);if(bytes>4294967296)throw new RecoveryError('MEDIA_REFERENCE_PLAN_SIZE_LIMIT');hash.update(text);await output.writeFile(text);}
 try{
  if(signal?.aborted)throw new RecoveryError('RECOVERY_CANCELLED');
  const state=(await client.query<{isolation:string;readOnly:string;unfiltered:boolean;revision:number}>(`SELECT current_setting('transaction_isolation') isolation,current_setting('transaction_read_only') "readOnly",(SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname=current_user) unfiltered,public.schema_revision() revision`)).rows[0];
  if(state?.isolation!=='repeatable read'||state.readOnly!=='on'||state.unfiltered!==true||state.revision!==binding.schemaRevision)throw new RecoveryError('MEDIA_REFERENCE_SNAPSHOT_REQUIRED');
  await client.query("SET LOCAL work_mem='4MB'");await client.query("SET LOCAL statement_timeout='60s'");
  await write([{type:'header',format:'kavosh-media-reference-plan-v1',...binding,scope:'recorded_ordinary_file_objects',signedEvidenceIncluded:false}]);
  for(const [name,sql]of [['media_backup_academies',academies],['media_backup_references',references]] as const){
   await client.query('DECLARE '+name+' NO SCROLL CURSOR FOR '+sql);cursor=name;
   while(true){
    if(signal?.aborted)throw new RecoveryError('RECOVERY_CANCELLED');
    const page=(await client.query('FETCH FORWARD 1000 FROM '+name)).rows;if(!page.length)break;
    const records=page.map(row=>{
     if(name==='media_backup_academies'){const school=z.object({academyId:uuid,unconfirmedUploads:z.coerce.number().int().nonnegative().safe()}).strict().parse(row);schools++;unconfirmedUploads+=school.unconfirmedUploads;if(schools>1000000||!Number.isSafeInteger(unconfirmedUploads))throw new RecoveryError('MEDIA_REFERENCE_PLAN_SIZE_LIMIT');return{type:'academy',...school};}
     const reference=recordedMediaReference.parse(row),identity=[reference.academyId,reference.stage,reference.storageTargetId,reference.fileId].join(':');
     if(identity===lastIdentity)throw new RecoveryError('MEDIA_REFERENCE_CONTENT_CONFLICT');lastIdentity=identity;rows++;if(rows>10000000)throw new RecoveryError('MEDIA_REFERENCE_PLAN_SIZE_LIMIT');return{type:'reference',...reference};
    });await write(records);
   }
   await client.query('CLOSE '+name);cursor=undefined;
  }
  await write([{type:'complete',academies:schools,references:rows,unconfirmedUploads}]);await output.sync();
  return{format:'kavosh-media-reference-plan-v1',...binding,plaintextSha256:hash.digest('hex'),plaintextBytes:bytes,academies:schools,references:rows,unconfirmedUploads,scope:'recorded_ordinary_file_objects',signedEvidenceIncluded:false};
 }catch(error){if(error instanceof RecoveryError)throw error;throw new RecoveryError('MEDIA_REFERENCE_PLAN_FAILED');}
 finally{if(cursor)await client.query('CLOSE '+cursor).catch(()=>{});}
}
