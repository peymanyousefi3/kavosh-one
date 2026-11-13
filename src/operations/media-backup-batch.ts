import {randomUUID,createHash} from 'node:crypto';
import {mkdir,open,unlink,rename} from 'node:fs/promises';
import {createReadStream,constants} from 'node:fs';
import {join,isAbsolute} from 'node:path';
import {z} from 'zod';
import type {S3ClientConfig} from '@aws-sdk/client-s3';
import {r2Connection,r2TargetId,r2ObjectStage} from '../integrations/r2-config.ts';
import {openMediaReferencePlan,mediaReferencePlanInput} from './media-reference-plan.ts';
import {backupMediaCollection} from './media-backups.ts';
import {encryptRecoveryStream,RecoveryError} from './database-backups.ts';
import {privateDirectory} from './recovery-files.ts';
import {copyEncryptedBackupToDrive,driveBackupCredentials} from './drive-backups.ts';

const path=z.string().min(1).max(4096).refine(v=>isAbsolute(v)&&!v.includes('\0'));
const input=z.object({age:path,recipient:z.string().regex(/^age1[023456789acdefghjklmnpqrstuvwxyz]{58}$/),workDirectory:path,referencePlan:mediaReferencePlanInput,
 targets:z.array(z.object({stage:r2ObjectStage,configuration:r2Connection}).strict()).min(1).max(128).refine(v=>new Set(v.map(t=>t.stage+':'+r2TargetId(t.configuration))).size===v.length),
 offsite:z.object({rclone:path,drive:driveBackupCredentials}).strict(),maximumAcademies:z.number().int().min(1).max(10000).default(1000),maximumObjects:z.number().int().positive().max(10000000).default(1000000),maximumSourceBytes:z.number().int().positive().max(1099511627776).default(1099511627776),timeoutMs:z.number().int().min(1000).max(86400000).default(21600000)}).strict();

// One host-level lock must cover database+media. School membership comes from
// the original authenticated snapshot,never a later mutable database query.
export async function backupMediaBatch(raw:unknown,signal?:AbortSignal,handler?:(targetId:string)=>S3ClientConfig['requestHandler']){
 const parsed=input.safeParse(raw);if(!parsed.success)throw new RecoveryError('INVALID_MEDIA_BATCH_CONFIGURATION');const i=parsed.data;
 if(signal?.aborted)throw new RecoveryError('RECOVERY_CANCELLED');await privateDirectory(i.workDirectory);
 const deadline=AbortSignal.timeout(i.timeoutMs),abort=signal?AbortSignal.any([signal,deadline]):deadline,plan=await openMediaReferencePlan(i.referencePlan,null,new Set(i.targets.map(t=>t.stage+':'+r2TargetId(t.configuration))),abort);
 const id=randomUUID(),folder=join(i.workDirectory,'media-batch-'+id),spool=join(folder,'collections.partial.jsonl'),archive=join(folder,'collections.jsonl.age'),metadata=join(folder,'manifest.json');let output:Awaited<ReturnType<typeof open>>|undefined,academies=0,objects=0,sourceBytes=0,reusedObjects=0,references=0,unconfirmed=0,journalBytes=0;
 try{
  if(plan.academies>i.maximumAcademies)throw new RecoveryError('MEDIA_BATCH_SIZE_LIMIT');await mkdir(folder,{mode:0o700});output=await open(spool,'wx',0o600);
  const record=async(value:unknown)=>{const line=JSON.stringify(value)+'\n';journalBytes+=Buffer.byteLength(line);if(journalBytes>8388608)throw new RecoveryError('MEDIA_BATCH_SIZE_LIMIT');await output!.writeFile(line);await output!.sync();};
  await record({type:'header',format:'kavosh-media-batch-v1',id,referenceBinding:plan.binding,expectedAcademies:plan.academies,...plan.signedEvidenceIncluded?{signedEvidenceIncluded:true}:{}});
  // Split in linear passes before storage IO: only bounded school metadata is
  // retained,not all file references or a repeated global scan for each school.
  const plans=join(folder,'reference-plans');await mkdir(plans,{mode:0o700});
  const schools=new Map<string,{file:string;hash:ReturnType<typeof createHash>;bytes:number;references:number;unconfirmedUploads:number;plaintextSha256?:string}>();
  for await(const school of plan.academiesForBackup){
   const file=join(plans,school.academyId+'.jsonl'),text=JSON.stringify({type:'header',format:'kavosh-media-reference-plan-v1',databaseBackupId:plan.binding.databaseBackupId,archiveSha256:plan.binding.archiveSha256,schemaRevision:plan.binding.schemaRevision,scope:plan.signedEvidenceIncluded?'recorded_ordinary_and_signed_evidence_objects':'recorded_ordinary_file_objects',signedEvidenceIncluded:plan.signedEvidenceIncluded})+'\n'+JSON.stringify(school)+'\n',f=await open(file,'wx',0o600);try{await f.writeFile(text);}finally{await f.close();}
   schools.set(school.academyId,{file,hash:createHash('sha256').update(text),bytes:Buffer.byteLength(text),references:0,unconfirmedUploads:school.unconfirmedUploads});
  }
  let writer:Awaited<ReturnType<typeof open>>|undefined,current='',pending='';
  const flush=async()=>{if(pending){await writer!.writeFile(pending);pending='';}};
  try{for await(const reference of plan.referencesForSchool){
   const school=schools.get(reference.academyId);if(!school)throw new RecoveryError('MEDIA_BATCH_INCOMPLETE');
   if(current!==reference.academyId){await flush();await writer?.close();writer=await open(school.file,constants.O_WRONLY|constants.O_APPEND|constants.O_NOFOLLOW);current=reference.academyId;}
   const line=JSON.stringify(reference)+'\n';school.hash.update(line);school.bytes+=Buffer.byteLength(line);school.references++;pending+=line;if(Buffer.byteLength(pending)>=65536)await flush();
  }await flush();}finally{await writer?.close();}
  for(const school of schools.values()){
   const footer=JSON.stringify({type:'complete',academies:1,references:school.references,unconfirmedUploads:school.unconfirmedUploads})+'\n',f=await open(school.file,constants.O_WRONLY|constants.O_APPEND|constants.O_NOFOLLOW);try{await f.writeFile(footer);await f.sync();}finally{await f.close();}school.hash.update(footer);school.bytes+=Buffer.byteLength(footer);school.plaintextSha256=school.hash.digest('hex');
  }
  for(const [academyId,school]of schools){
   const referencePlan={file:school.file,databaseBackupId:plan.binding.databaseBackupId,archiveSha256:plan.binding.archiveSha256,schemaRevision:plan.binding.schemaRevision,plaintextBytes:school.bytes,plaintextSha256:school.plaintextSha256};
   const collection=await backupMediaCollection({academyId,age:i.age,recipient:i.recipient,workDirectory:i.workDirectory,targets:i.targets,offsite:i.offsite,referencePlan,reuseExistingArchives:true,maximumObjects:Math.max(1,i.maximumObjects-objects),maximumSourceBytes:Math.max(1,i.maximumSourceBytes-sourceBytes),timeoutMs:i.timeoutMs},abort,handler);
   academies++;objects+=collection.objects;sourceBytes+=collection.sourceBytes;reusedObjects+=collection.reusedObjects;references+=collection.referenceCoverage!.recordedReferences;unconfirmed+=collection.referenceCoverage!.unconfirmedUploads;
   if(objects>i.maximumObjects||sourceBytes>i.maximumSourceBytes||!collection.recordedDatabaseReferencesVerified||!collection.allArchivesIndependentlyCopied)throw new RecoveryError('MEDIA_BATCH_INCOMPLETE');
   await record({type:'collection',academyId,id:collection.id,catalog:collection.catalog,offsite:collection.offsite,objects:collection.objects,sourceBytes:collection.sourceBytes,reusedObjects:collection.reusedObjects,referenceCoverage:collection.referenceCoverage});
  }
  if(academies!==plan.academies||references!==plan.references||unconfirmed!==plan.unconfirmedUploads)throw new RecoveryError('MEDIA_BATCH_INCOMPLETE');
  const result={format:'kavosh-media-batch-backup-v1',id,referenceBinding:plan.binding,academies,objects,sourceBytes,reusedObjects,recordedReferences:references,unconfirmedUploads:unconfirmed,ordinaryRecordedMediaBackedUp:true,signedEvidenceIncluded:plan.signedEvidenceIncluded,atomicStorageSnapshot:false,completeMediaBackup:false,restoreVerified:false};
  await record({type:'complete',...result});await output.close();output=undefined;
  const encrypted=await encryptRecoveryStream({age:i.age,recipient:i.recipient,file:archive,maximumBytes:16777216},createReadStream(spool),abort);await unlink(spool);
  const manifest={...result,catalog:{filename:'collections.jsonl.age',...encrypted},offsite:null as Awaited<ReturnType<typeof copyEncryptedBackupToDrive>>|null};
  async function save(target:string){const f=await open(target,'wx',0o600);try{await f.writeFile(JSON.stringify(manifest)+'\n');await f.sync();}finally{await f.close();}}
  await save(metadata);manifest.offsite=await copyEncryptedBackupToDrive({...i.offsite,workDirectory:i.workDirectory,kind:'media-batch',backupId:id,archive,expectedSha256:encrypted.ciphertextSha256,expectedBytes:encrypted.encryptedBytes},abort);await save(metadata+'.next');await rename(metadata+'.next',metadata);
  for(const directory of [folder,i.workDirectory]){const f=await open(directory,'r');try{await f.sync();}finally{await f.close();}}return{...manifest,archivePath:archive};
 }catch(error){if(error instanceof RecoveryError)throw error;throw new RecoveryError(abort.aborted?'RECOVERY_CANCELLED':'MEDIA_BATCH_FAILED');}
 finally{await output?.close();await plan.close();}
}
