import {randomUUID} from 'node:crypto';
import {constants} from 'node:fs';
import {mkdir,open,unlink,rmdir} from 'node:fs/promises';
import {join,isAbsolute} from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import {z} from 'zod';
import {decryptRecoveryStream,RecoveryError} from './database-backups.ts';
import {nativeRecoveryIdentity,privateDirectory,stageRecoveryArchive} from './recovery-files.ts';
import {authenticatedRecoveryRecords} from './recovery-json-records.ts';
import {recoverMediaCollection} from './media-collection-recovery.ts';
import {mediaReferenceCoverage} from './media-reference-plan.ts';

const uuid=z.string().uuid(),sha=z.string().regex(/^[a-f0-9]{64}$/),count=z.number().int().nonnegative().safe(),path=z.string().min(1).max(4096).refine(v=>isAbsolute(v)&&!v.includes('\0'));
const binding=z.object({databaseBackupId:uuid,archiveSha256:sha,schemaRevision:z.number().int().positive(),plaintextSha256:sha}).strict();
const input=z.object({age:path,identityFile:path,archive:path,archiveDirectory:path,workDirectory:path,batchId:uuid,expectedDatabaseBackupId:uuid,expectedDatabaseSha256:sha,expectedSchemaRevision:z.number().int().positive(),expectedSha256:sha,expectedBytes:z.number().int().min(22).max(16777216),maximumAcademies:count.max(10000).default(1000),maximumObjects:count.max(10000000).default(1000000),maximumSourceBytes:count.max(1099511627776).default(1099511627776),timeoutMs:z.number().int().min(1000).max(86400000).default(21600000)}).strict();
const header=z.object({type:z.literal('header'),format:z.literal('kavosh-media-batch-v1'),id:uuid,referenceBinding:binding,expectedAcademies:count,signedEvidenceIncluded:z.boolean().default(false)}).strict();
const collection=z.object({type:z.literal('collection'),academyId:uuid,id:uuid,catalog:z.object({filename:z.literal('catalog.jsonl.age'),ciphertextSha256:sha,encryptedBytes:z.number().int().min(22).max(1074070016)}).strict(),offsite:z.object({independentCopyVerified:z.literal(true),scope:z.literal('one_encrypted_media_catalog'),backupId:uuid,ciphertextSha256:sha}).passthrough(),objects:count,sourceBytes:count,reusedObjects:count,referenceCoverage:mediaReferenceCoverage}).strict();
const footer=z.object({type:z.literal('complete'),format:z.literal('kavosh-media-batch-backup-v1'),id:uuid,referenceBinding:binding,academies:count,objects:count,sourceBytes:count,reusedObjects:count,recordedReferences:count,unconfirmedUploads:count,ordinaryRecordedMediaBackedUp:z.literal(true),signedEvidenceIncluded:z.boolean(),atomicStorageSnapshot:z.literal(false),completeMediaBackup:z.literal(false),restoreVerified:z.literal(false)}).strict();

// Offline only: authenticate/validate the complete batch before touching any
// child archive. Never republish media,restore SQL or activate application access.
export async function recoverMediaBatch(raw:unknown,signal?:AbortSignal){
 const parsed=input.safeParse(raw);if(!parsed.success)throw new RecoveryError('INVALID_MEDIA_BATCH_RECOVERY');const i=parsed.data;if(signal?.aborted)throw new RecoveryError('RECOVERY_CANCELLED');
 const deadline=AbortSignal.timeout(i.timeoutMs),abort=signal?AbortSignal.any([signal,deadline]):deadline,id=randomUUID(),folder=join(i.workDirectory,'media-batch-recovery-'+id),cipher=join(folder,'batch.age'),clear=join(folder,'batch.jsonl'),journal=join(folder,'recovered.jsonl');
 let owned=false,cipherOwned=false,clearOwned=false,journalOwned=false,success=false,attemptedChild=false,recoveredCollections=0,recoveredObjects=0;
 let source:Awaited<ReturnType<typeof open>>|undefined,output:Awaited<ReturnType<typeof open>>|undefined;
 try{
  await privateDirectory(i.workDirectory);await privateDirectory(i.archiveDirectory);await nativeRecoveryIdentity(i.identityFile);await mkdir(folder,{mode:0o700});owned=true;
  await stageRecoveryArchive(i.archive,cipher,i.expectedBytes,i.expectedSha256,abort);cipherOwned=true;const encrypted=await open(cipher,constants.O_RDONLY|constants.O_NOFOLLOW);let proof:Awaited<ReturnType<typeof decryptRecoveryStream>>;
  try{proof=await decryptRecoveryStream({age:i.age,identityFile:i.identityFile,file:clear,maximumBytes:8388608},encrypted.createReadStream({autoClose:true}),abort);clearOwned=true;}finally{await encrypted.close().catch(()=>{});}await unlink(cipher);cipherOwned=false;
  source=await open(clear,constants.O_RDONLY|constants.O_NOFOLLOW);const records=await authenticatedRecoveryRecords(source,proof,8388608,abort);
  let phase='header',root:z.infer<typeof header>|undefined,last='',academies=0,objects=0,bytes=0,reused=0,references=0,pending=0;
  const matches=(b:z.infer<typeof binding>)=>b.databaseBackupId===i.expectedDatabaseBackupId&&b.archiveSha256===i.expectedDatabaseSha256&&b.schemaRevision===i.expectedSchemaRevision;
  for await(const row of records()){
   if(phase==='header'){root=header.parse(row);if(root.id!==i.batchId||!matches(root.referenceBinding))throw new RecoveryError('MEDIA_BATCH_RECOVERY_BINDING_MISMATCH');if(root.expectedAcademies>i.maximumAcademies)throw new RecoveryError('MEDIA_RECOVERY_SIZE_LIMIT');phase='collections';continue;}
   if(phase==='complete')throw new RecoveryError('INVALID_MEDIA_BATCH_CATALOG');
   if(row.type==='collection'){
    const c=collection.parse(row);if(c.referenceCoverage.signedEvidenceIncluded!==root!.signedEvidenceIncluded||c.academyId<=last||!matches(c.referenceCoverage.binding)||c.offsite.backupId!==c.id||c.offsite.ciphertextSha256!==c.catalog.ciphertextSha256||c.reusedObjects>c.objects)throw new RecoveryError('INVALID_MEDIA_BATCH_CATALOG');last=c.academyId;academies++;objects+=c.objects;bytes+=c.sourceBytes;reused+=c.reusedObjects;references+=c.referenceCoverage.recordedReferences;pending+=c.referenceCoverage.unconfirmedUploads;
    if(academies>i.maximumAcademies||objects>i.maximumObjects||bytes>i.maximumSourceBytes||![objects,bytes,reused,references,pending].every(Number.isSafeInteger))throw new RecoveryError('MEDIA_RECOVERY_SIZE_LIMIT');
   }else{
    const f=footer.parse(row);if(f.signedEvidenceIncluded!==root!.signedEvidenceIncluded||f.id!==i.batchId||!isDeepStrictEqual(f.referenceBinding,root!.referenceBinding)||f.academies!==root!.expectedAcademies||f.academies!==academies||f.objects!==objects||f.sourceBytes!==bytes||f.reusedObjects!==reused||f.recordedReferences!==references||f.unconfirmedUploads!==pending)throw new RecoveryError('MEDIA_BATCH_RECOVERY_TOTALS_MISMATCH');phase='complete';
   }
  }
  if(phase!=='complete')throw new RecoveryError('INVALID_MEDIA_BATCH_CATALOG');
  output=await open(journal,'wx',0o600);journalOwned=true;await output.writeFile(JSON.stringify({type:'header',batchId:i.batchId,referenceBinding:root!.referenceBinding})+'\n');
  for await(const row of records())if(row.type==='collection'){
   const c=collection.parse(row),directory=join(i.archiveDirectory,'media-collection-'+c.id);await privateDirectory(directory);
   attemptedChild=true;const recovered=await recoverMediaCollection({age:i.age,identityFile:i.identityFile,archive:join(directory,'catalog.jsonl.age'),archiveDirectory:i.archiveDirectory,workDirectory:folder,academyId:c.academyId,collectionId:c.id,expectedSha256:c.catalog.ciphertextSha256,expectedBytes:c.catalog.encryptedBytes,expectedReferenceCoverage:c.referenceCoverage,maximumObjects:c.objects,maximumSourceBytes:c.sourceBytes,timeoutMs:i.timeoutMs},abort);
   if(recovered.recoveredObjects!==c.objects||recovered.sourceBytes!==c.sourceBytes)throw new RecoveryError('MEDIA_BATCH_RECOVERY_TOTALS_MISMATCH');recoveredCollections++;recoveredObjects+=recovered.recoveredObjects;await output.writeFile(JSON.stringify({type:'collection',...recovered})+'\n');await output.sync();
  }
  if(recoveredCollections!==academies||recoveredObjects!==objects)throw new RecoveryError('MEDIA_BATCH_RECOVERY_TOTALS_MISMATCH');
  const result={format:'kavosh-media-batch-recovery-v1',id,batchId:i.batchId,databaseBackupId:i.expectedDatabaseBackupId,databaseArchiveSha256:i.expectedDatabaseSha256,recoveredCollections,recoveredObjects,sourceBytes:bytes,allBatchCollectionsRecovered:true,ordinaryRecordedMediaRecovered:true,signedEvidenceIncluded:root!.signedEvidenceIncluded,sourceOrRemoteObjectsModified:false,applicationActivationAllowed:false,completeMediaRestore:false};
  await output.writeFile(JSON.stringify({type:'complete',...result})+'\n');await output.sync();await output.close();output=undefined;await source.close();source=undefined;await unlink(clear);clearOwned=false;for(const directory of [folder,i.workDirectory]){const f=await open(directory,'r');try{await f.sync();}finally{await f.close();}}success=true;return{...result,journal};
 }catch(error){if(error instanceof RecoveryError)throw error;throw new RecoveryError(abort.aborted?'RECOVERY_CANCELLED':'MEDIA_BATCH_RECOVERY_FAILED');}
 finally{
  await source?.close().catch(()=>{});await output?.close().catch(()=>{});if(!success&&owned){let failed=false;const check=(e:unknown)=>{if((e as {code?:string}).code!=='ENOENT')failed=true;};if(cipherOwned)await unlink(cipher).catch(check);if(clearOwned)await unlink(clear).catch(check);if(!attemptedChild){if(journalOwned)await unlink(journal).catch(check);await rmdir(folder).catch(check);}if(failed)throw new RecoveryError('MEDIA_BATCH_RECOVERY_CLEANUP_REQUIRED');}
 }
}
