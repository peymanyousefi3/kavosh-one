import {randomUUID,createHash} from 'node:crypto';
import {mkdir,open,unlink,rmdir,statfs,rename} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {join,isAbsolute} from 'node:path';
import {z} from 'zod';
import type {S3ClientConfig} from '@aws-sdk/client-s3';
import {privateR2} from '../integrations/r2.ts';
import {r2Connection,r2TargetId} from '../integrations/r2-config.ts';
import {privateDirectory,encryptRecoveryStream,RecoveryError} from './database-backups.ts';
import {copyEncryptedBackupToDrive,driveBackupCredentials} from './drive-backups.ts';
import {mediaReferencePlanInput,openMediaReferencePlan,mediaReferenceKey} from './media-reference-plan.ts';

const path=z.string().min(1).max(4096).refine(v=>isAbsolute(v)&&!v.includes('\0'));
const input=z.object({configuration:r2Connection,academyId:z.string().uuid().transform(v=>v.toLowerCase()),fileId:z.string().uuid().transform(v=>v.toLowerCase()),stage:z.enum(['quarantine','clean']),
 storageTargetId:z.string().regex(/^[a-f0-9]{64}$/),bytes:z.number().int().positive().max(4294967296),etag:z.string().min(3).max(202).regex(/^"[\x21\x23-\x7e]+"$/),modifiedAt:z.iso.datetime(),
 age:path,recipient:z.string().regex(/^age1[023456789acdefghjklmnpqrstuvwxyz]{58}$/),workDirectory:path,timeoutMs:z.number().int().min(1000).max(600000).default(120000)}).strict();

// One immutable object archive,not an academy/bucket snapshot. A backup runner
// must persist the full inventory and reconcile concurrent changes separately.
export async function backupMediaObject(raw:unknown,signal?:AbortSignal,handler?:S3ClientConfig['requestHandler']){
 const parsed=input.safeParse(raw);if(!parsed.success)throw new RecoveryError('INVALID_MEDIA_BACKUP_CONFIGURATION');const i=parsed.data;
 if(i.storageTargetId!==r2TargetId(i.configuration)||i.bytes>i.configuration.maximumUploadBytes)throw new RecoveryError('MEDIA_BACKUP_TARGET_MISMATCH');
 if(signal?.aborted)throw new RecoveryError('RECOVERY_CANCELLED');
 await privateDirectory(i.workDirectory);
 const reader=privateR2(i.configuration,i.academyId,handler);
 try{return await archiveMediaObject(i,reader,signal);}finally{reader.close();}
}
async function archiveMediaObject(i:z.infer<typeof input>,reader:ReturnType<typeof privateR2>,signal?:AbortSignal){
 const id=randomUUID(),folder=join(i.workDirectory,'media-'+id),archive=join(folder,'media.bin.age'),metadata=join(folder,'manifest.json');
 let owned=false,archiveOwned=false,metadataOwned=false,success=false;
 const deadline=AbortSignal.timeout(i.timeoutMs),abort=signal?AbortSignal.any([signal,deadline]):deadline;
 try{
  await mkdir(folder,{mode:0o700});owned=true;
  const inspect=i.stage==='clean'?reader.inspectClean:reader.inspectQuarantine;
  const stored=await inspect(i.fileId,{bytes:i.bytes,ifMatch:i.etag},async source=>{const result=await encryptRecoveryStream({age:i.age,recipient:i.recipient,file:archive,maximumBytes:i.bytes+Math.ceil(i.bytes/65536)*16+65536},source,abort);archiveOwned=true;return result;},i.timeoutMs,abort);
  const manifest={format:'kavosh-media-object-backup-v1',id,createdAt:new Date().toISOString(),source:{academyId:i.academyId,fileId:i.fileId,stage:i.stage,storageTargetId:i.storageTargetId,bytes:stored.bytes,sha256:stored.sha256,etag:stored.provider.etag,modifiedAt:i.modifiedAt},archive:{filename:'media.bin.age',...stored.inspection},sourceDeleted:false,completeMediaBackup:false,independentCopyVerified:false,restoreVerified:false};
  const file=await open(metadata,'wx',0o600);metadataOwned=true;try{await file.writeFile(JSON.stringify(manifest)+'\n');await file.sync();}finally{await file.close();}
  for(const path of [folder,i.workDirectory]){const directory=await open(path,'r');try{await directory.sync();}finally{await directory.close();}}
  success=true;return{...manifest,archivePath:archive};
 }catch{throw new RecoveryError(abort.aborted?'MEDIA_BACKUP_CANCELLED':'MEDIA_BACKUP_FAILED');}
 finally{if(!success&&owned){let failed=false;const check=(error:unknown)=>{if((error as {code?:string}).code!=='ENOENT')failed=true;};if(metadataOwned)await unlink(metadata).catch(check);if(archiveOwned)await unlink(archive).catch(check);await rmdir(folder).catch(check);if(failed)throw new RecoveryError('MEDIA_BACKUP_CLEANUP_REQUIRED');}}
}

const collectionInput=z.object({academyId:input.shape.academyId,age:path,recipient:input.shape.recipient,workDirectory:path,
 targets:z.array(z.object({stage:input.shape.stage,configuration:r2Connection}).strict()).min(1).max(128).refine(targets=>new Set(targets.map(t=>t.stage+':'+r2TargetId(t.configuration))).size===targets.length),
 maximumObjects:z.number().int().min(1).max(10000000).default(1000000),maximumSourceBytes:z.number().int().min(1).max(1099511627776).default(1099511627776),
 maximumCatalogBytes:z.number().int().min(1024).max(1073741824).default(268435456),timeoutMs:z.number().int().min(1000).max(86400000).default(3600000),
 offsite:z.object({rclone:path,drive:driveBackupCredentials}).strict().optional(),referencePlan:mediaReferencePlanInput.optional()}).strict();

// Bounded metadata spool,never plaintext media. Keep already-created object
// archives on failure for recovery/retry;only this attempt's catalog is removed.
// A matching second inventory detects changes,not an atomic R2/DB snapshot.
export async function backupMediaCollection(raw:unknown,signal?:AbortSignal,handler?:(targetId:string)=>S3ClientConfig['requestHandler']){
 const parsed=collectionInput.safeParse(raw);if(!parsed.success)throw new RecoveryError('INVALID_MEDIA_COLLECTION_CONFIGURATION');const i=parsed.data;
 if(signal?.aborted)throw new RecoveryError('RECOVERY_CANCELLED');await privateDirectory(i.workDirectory);
 const id=randomUUID(),folder=join(i.workDirectory,'media-collection-'+id),spool=join(folder,'catalog.partial.jsonl'),archive=join(folder,'catalog.jsonl.age'),metadata=join(folder,'manifest.json');
 const deadline=AbortSignal.timeout(i.timeoutMs),abort=signal?AbortSignal.any([signal,deadline]):deadline;
 const targets:Array<z.infer<typeof collectionInput>['targets'][number]&{targetId:string;reader:ReturnType<typeof privateR2>}>=[];
 let referenceReader:Awaited<ReturnType<typeof openMediaReferencePlan>>|undefined,currentReference:Awaited<ReturnType<NonNullable<typeof referenceReader>['referencesForSchool']['next']>>|undefined,matchedReferences=0;
 let owned=false,spoolOwned=false,archiveOwned=false,metadataOwned=false,localComplete=false,success=false,objects=0,sourceBytes=0,catalogBytes=0,manifestTemp:string|undefined;
 const inventories:Array<{storageTargetId:string;stage:string;objects:number;bytes:number;sha256:string}>=[];
 let output:Awaited<ReturnType<typeof open>>|undefined;
 async function saveManifest(value:unknown){
  const target=metadataOwned?metadata+'.'+randomUUID()+'.next':metadata,file=await open(target,'wx',0o600);if(metadataOwned)manifestTemp=target;else metadataOwned=true;
  try{await file.writeFile(JSON.stringify(value)+'\n');await file.sync();}finally{await file.close();}
  if(manifestTemp){await rename(manifestTemp,metadata);manifestTemp=undefined;}
  for(const path of [folder,i.workDirectory]){const directory=await open(path,'r');try{await directory.sync();}finally{await directory.close();}}
 }
 async function record(value:unknown){const line=JSON.stringify(value)+'\n';catalogBytes+=Buffer.byteLength(line);if(catalogBytes>i.maximumCatalogBytes)throw new RecoveryError('MEDIA_CATALOG_SIZE_LIMIT');await output!.writeFile(line);}
 async function inventory(t:typeof targets[number],visit?:(object:{fileId:string;bytes:number;etag:string;modifiedAt:string})=>Promise<void>){
  const hash=createHash('sha256');let next:string|undefined,last='',count=0,bytes=0;
  do{
   if(abort.aborted)throw new RecoveryError('MEDIA_COLLECTION_CANCELLED');
   const page=await t.reader.mediaInventoryPage(t.stage,next,1000,abort);
   if(!page.objects.length&&page.nextContinuationToken)throw new RecoveryError('MEDIA_INVENTORY_NO_PROGRESS');
   for(const object of page.objects){if(object.fileId<=last)throw new RecoveryError('MEDIA_INVENTORY_ORDER_INVALID');last=object.fileId;count++;bytes+=object.bytes;if(count>i.maximumObjects||bytes>i.maximumSourceBytes)throw new RecoveryError('MEDIA_COLLECTION_SIZE_LIMIT');hash.update(JSON.stringify(object)+'\n');await visit?.(object);}
   next=page.nextContinuationToken??undefined;
  }while(next);
  return{storageTargetId:t.targetId,stage:t.stage,objects:count,bytes,sha256:hash.digest('hex')};
 }
 try{
  if(i.referencePlan){referenceReader=await openMediaReferencePlan(i.referencePlan,i.academyId,new Set(i.targets.map(t=>t.stage+':'+r2TargetId(t.configuration))),abort);currentReference=await referenceReader.referencesForSchool.next();}
  for(const target of i.targets){const targetId=r2TargetId(target.configuration),reader=privateR2(target.configuration,i.academyId,handler?.(targetId));targets.push({...target,targetId,reader});}
  targets.sort((a,b)=>{const left=a.stage+':'+a.targetId,right=b.stage+':'+b.targetId;return left<right?-1:left>right?1:0;});
  await mkdir(folder,{mode:0o700});owned=true;output=await open(spool,'wx',0o600);spoolOwned=true;
  await record({type:'header',format:'kavosh-media-catalog-v1',id,academyId:i.academyId,startedAt:new Date().toISOString(),targets:targets.map(t=>({stage:t.stage,storageTargetId:t.targetId})),referenceBinding:referenceReader?.binding??null});
  for(const t of targets)inventories.push(await inventory(t,async object=>{
   objects++;sourceBytes+=object.bytes;if(objects>i.maximumObjects||sourceBytes>i.maximumSourceBytes)throw new RecoveryError('MEDIA_COLLECTION_SIZE_LIMIT');
   const wanted=currentReference&&!currentReference.done?currentReference.value:null,key=mediaReferenceKey({stage:t.stage,storageTargetId:t.targetId,fileId:object.fileId});
   if(wanted&&mediaReferenceKey(wanted)<key)throw new RecoveryError('MEDIA_REFERENCE_OBJECT_MISSING');
   const required=wanted&&mediaReferenceKey(wanted)===key?wanted:null;if(required&&required.bytes!==object.bytes)throw new RecoveryError('MEDIA_REFERENCE_CONTENT_CHANGED');
   const disk=await statfs(i.workDirectory,{bigint:true});if(disk.bavail*disk.bsize<BigInt(object.bytes)+67108864n)throw new RecoveryError('MEDIA_BACKUP_DISK_CAPACITY_LOW');
   const media=await archiveMediaObject(input.parse({configuration:t.configuration,academyId:i.academyId,stage:t.stage,storageTargetId:t.targetId,...object,age:i.age,recipient:i.recipient,workDirectory:i.workDirectory}),t.reader,abort);
   if(required){if(media.source.sha256!==required.sha256)throw new RecoveryError('MEDIA_REFERENCE_CONTENT_CHANGED');matchedReferences++;currentReference=await referenceReader!.referencesForSchool.next();}
   const offsite=i.offsite?await copyEncryptedBackupToDrive({...i.offsite,workDirectory:i.workDirectory,kind:'media',backupId:media.id,archive:media.archivePath,expectedSha256:media.archive.ciphertextSha256,expectedBytes:media.archive.encryptedBytes},abort):null;
   await record({type:'object',id:media.id,source:media.source,archive:media.archive,offsite});
  }));
  if(currentReference&&!currentReference.done||referenceReader&&matchedReferences!==referenceReader.references)throw new RecoveryError('MEDIA_REFERENCE_OBJECT_MISSING');
  for(let n=0;n<targets.length;n++)if(JSON.stringify(await inventory(targets[n]))!==JSON.stringify(inventories[n]))throw new RecoveryError('MEDIA_COLLECTION_SOURCE_CHANGED');
  const referenceCoverage=referenceReader?{binding:referenceReader.binding,recordedReferences:matchedReferences,unconfirmedUploads:referenceReader.unconfirmedUploads,signedEvidenceIncluded:false}:null;
  await record({type:'complete',objects,sourceBytes,inventories,matchingFinalInventory:true,atomicStorageSnapshot:false,recordedDatabaseReferencesVerified:referenceReader!==undefined,referenceCoverage,databaseReferencesVerified:false});await output.sync();await output.close();output=undefined;
  const encrypted=await encryptRecoveryStream({age:i.age,recipient:i.recipient,file:archive,maximumBytes:i.maximumCatalogBytes+Math.ceil(i.maximumCatalogBytes/65536)*16+65536},createReadStream(spool),abort);archiveOwned=true;
  await unlink(spool);spoolOwned=false;
  const manifest={format:'kavosh-media-collection-backup-v1',id,academyId:i.academyId,finishedAt:new Date().toISOString(),coverage:'configured_academy_storage_targets',objects,sourceBytes,inventories,catalog:{filename:'catalog.jsonl.age',...encrypted},offsite:null as Awaited<ReturnType<typeof copyEncryptedBackupToDrive>>|null,allInventoriedObjectsArchived:true,matchingFinalInventory:true,allArchivesIndependentlyCopied:false,atomicStorageSnapshot:false,recordedDatabaseReferencesVerified:referenceReader!==undefined,referenceCoverage,databaseReferencesVerified:false,completeMediaBackup:false,restoreVerified:false};
  await saveManifest(manifest);localComplete=true;
  if(i.offsite){manifest.offsite=await copyEncryptedBackupToDrive({...i.offsite,workDirectory:i.workDirectory,kind:'media-catalog',backupId:id,archive,expectedSha256:encrypted.ciphertextSha256,expectedBytes:encrypted.encryptedBytes},abort);manifest.allArchivesIndependentlyCopied=manifest.offsite.independentCopyVerified===true;await saveManifest(manifest);}
  success=true;return{...manifest,archivePath:archive};
 }catch(error){if(error instanceof RecoveryError)throw error;throw new RecoveryError(abort.aborted?'MEDIA_COLLECTION_CANCELLED':'MEDIA_COLLECTION_FAILED');}
 finally{for(const t of targets)t.reader.close();let failed=false;const check=(error:unknown)=>{if((error as {code?:string}).code!=='ENOENT')failed=true;};await referenceReader?.close().catch(check);await output?.close().catch(check);if(spoolOwned)await unlink(spool).catch(check);if(manifestTemp)await unlink(manifestTemp).catch(check);if(!success&&owned&&!localComplete){if(metadataOwned)await unlink(metadata).catch(check);if(archiveOwned)await unlink(archive).catch(check);await rmdir(folder).catch(check);}if(failed)throw new RecoveryError('MEDIA_COLLECTION_CLEANUP_REQUIRED');}
}
