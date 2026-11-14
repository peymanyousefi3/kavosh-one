import {createHash,randomUUID} from 'node:crypto';
import {constants} from 'node:fs';
import {mkdir,open,unlink,rmdir} from 'node:fs/promises';
import {isAbsolute,join} from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import {z} from 'zod';
import {RecoveryError,decryptRecoveryStream} from './database-backups.ts';
import {privateDirectory,nativeRecoveryIdentity,stageRecoveryArchive} from './recovery-files.ts';
import {recordedMediaReference,mediaReferenceCoverage} from './media-reference-plan.ts';
import {recoverMediaObject} from './media-recovery.ts';
import {authenticatedRecoveryRecords} from './recovery-json-records.ts';
import {r2ObjectStage} from '../integrations/r2-config.ts';

const path=z.string().min(1).max(4096).refine(v=>isAbsolute(v)&&!v.includes('\0')),sha=z.string().regex(/^[a-f0-9]{64}$/),uuid=z.string().uuid(),count=z.number().int().nonnegative().safe();
const input=z.object({age:path,identityFile:path,archive:path,archiveDirectory:path,workDirectory:path,academyId:uuid,collectionId:uuid,expectedSha256:sha,expectedBytes:z.number().int().min(22).max(1074070016),expectedReferenceCoverage:mediaReferenceCoverage.optional(),maximumCatalogBytes:z.number().int().min(1024).max(1073741824).default(268435456),maximumObjects:count.max(10000000).default(1000000),maximumSourceBytes:count.max(1099511627776).default(1099511627776),timeoutMs:z.number().int().min(1000).max(86400000).default(3600000)}).strict();
const target=z.object({stage:r2ObjectStage,storageTargetId:sha}).strict();
const header=z.object({type:z.literal('header'),format:z.literal('kavosh-media-catalog-v1'),id:uuid,academyId:uuid,startedAt:z.iso.datetime(),targets:z.array(target).min(1).max(128),referenceBinding:z.unknown().optional()}).strict();
const object=z.object({type:z.literal('object'),id:uuid,source:recordedMediaReference.extend({etag:z.string().min(3).max(202).regex(/^"[\x21\x23-\x7e]+"$/),modifiedAt:z.iso.datetime()}),archive:z.object({filename:z.literal('media.bin.age'),ciphertextSha256:sha,encryptedBytes:z.number().int().min(22).max(4296146944)}).strict(),offsite:z.unknown()}).strict();
const inventory=target.extend({objects:count,bytes:count,sha256:sha}).strict();
const footer=z.object({type:z.literal('complete'),objects:count,sourceBytes:count,inventories:z.array(inventory).max(128),matchingFinalInventory:z.literal(true),atomicStorageSnapshot:z.literal(false),databaseReferencesVerified:z.literal(false),recordedDatabaseReferencesVerified:z.boolean().optional(),referenceCoverage:z.unknown().optional()}).strict();

// All metadata is authenticated and validated BEFORE extracting any object.
// Two bounded passes keep memory independent of the collection's file count.
// Only private local recovery files are written,never the original storage.
export async function recoverMediaCollection(raw:unknown,signal?:AbortSignal){
 const parsed=input.safeParse(raw);if(!parsed.success)throw new RecoveryError('INVALID_MEDIA_COLLECTION_RECOVERY');const i=parsed.data;
 if(signal?.aborted)throw new RecoveryError('RECOVERY_CANCELLED');const deadline=AbortSignal.timeout(i.timeoutMs),abort=signal?AbortSignal.any([signal,deadline]):deadline;
 const id=randomUUID(),folder=join(i.workDirectory,'media-collection-recovery-'+id),cipher=join(folder,'catalog.age'),clear=join(folder,'catalog.jsonl'),journal=join(folder,'recovered.jsonl');
 let owned=false,cipherOwned=false,clearOwned=false,journalOwned=false,success=false,recoveredObjects=0;
 let catalog:Awaited<ReturnType<typeof open>>|undefined,output:Awaited<ReturnType<typeof open>>|undefined;
 try{
  await privateDirectory(i.workDirectory);await privateDirectory(i.archiveDirectory);await nativeRecoveryIdentity(i.identityFile);await mkdir(folder,{mode:0o700});owned=true;
  await stageRecoveryArchive(i.archive,cipher,i.expectedBytes,i.expectedSha256,abort);cipherOwned=true;
  const encrypted=await open(cipher,constants.O_RDONLY|constants.O_NOFOLLOW);let catalogProof:Awaited<ReturnType<typeof decryptRecoveryStream>>;
  try{catalogProof=await decryptRecoveryStream({age:i.age,identityFile:i.identityFile,file:clear,maximumBytes:i.maximumCatalogBytes},encrypted.createReadStream({autoClose:true}),abort);clearOwned=true;}finally{await encrypted.close().catch(()=>{});}
  await unlink(cipher);cipherOwned=false;catalog=await open(clear,constants.O_RDONLY|constants.O_NOFOLLOW);const records=await authenticatedRecoveryRecords(catalog,catalogProof,i.maximumCatalogBytes,abort);
  let phase='header',objects=0,sourceBytes=0,last='',catalogHeader:z.infer<typeof header>|undefined;
  const totals=new Map<string,{stage:z.infer<typeof r2ObjectStage>;storageTargetId:string;objects:number;bytes:number;hash:ReturnType<typeof createHash>}>();
  for await(const row of records()){
   if(phase==='header'){
    catalogHeader=header.parse(row);if(catalogHeader.id!==i.collectionId||catalogHeader.academyId!==i.academyId)throw new RecoveryError('MEDIA_RECOVERY_SCOPE_MISMATCH');
    if(i.expectedReferenceCoverage&&!isDeepStrictEqual(catalogHeader.referenceBinding,i.expectedReferenceCoverage.binding))throw new RecoveryError('MEDIA_REFERENCE_BINDING_MISMATCH');
    if(i.expectedReferenceCoverage?.signedEvidenceIncluded===false&&catalogHeader.targets.some(t=>t.stage==='signature-evidence'))throw new RecoveryError('MEDIA_REFERENCE_BINDING_MISMATCH');
    for(const t of catalogHeader.targets){const key=t.stage+':'+t.storageTargetId;if(totals.has(key))throw new RecoveryError('INVALID_MEDIA_RECOVERY_CATALOG');totals.set(key,{...t,objects:0,bytes:0,hash:createHash('sha256')});}phase='objects';continue;
   }
   if(phase==='complete')throw new RecoveryError('INVALID_MEDIA_RECOVERY_CATALOG');
   if(row.type==='object'){
    const entry=object.parse(row),source=entry.source,key=Array.from(totals.keys()).indexOf(source.stage+':'+source.storageTargetId).toString().padStart(3,'0')+':'+source.fileId,total=totals.get(source.stage+':'+source.storageTargetId);
    if(source.academyId!==i.academyId||!total)throw new RecoveryError('MEDIA_RECOVERY_SCOPE_MISMATCH');if(key<=last)throw new RecoveryError('INVALID_MEDIA_RECOVERY_CATALOG');last=key;
    objects++;sourceBytes+=source.bytes;if(objects>i.maximumObjects||sourceBytes>i.maximumSourceBytes)throw new RecoveryError('MEDIA_RECOVERY_SIZE_LIMIT');total.objects++;total.bytes+=source.bytes;total.hash.update(JSON.stringify({fileId:source.fileId,bytes:source.bytes,etag:source.etag,modifiedAt:source.modifiedAt})+'\n');
   }else{
    const complete=footer.parse(row),expected=Array.from(totals.values(),t=>({storageTargetId:t.storageTargetId,stage:t.stage,objects:t.objects,bytes:t.bytes,sha256:t.hash.digest('hex')}));
    if(i.expectedReferenceCoverage&&(complete.recordedDatabaseReferencesVerified!==true||!isDeepStrictEqual(mediaReferenceCoverage.parse(complete.referenceCoverage),i.expectedReferenceCoverage)))throw new RecoveryError('MEDIA_REFERENCE_BINDING_MISMATCH');
    if(complete.objects!==objects||complete.sourceBytes!==sourceBytes||!isDeepStrictEqual(complete.inventories,expected))throw new RecoveryError('MEDIA_RECOVERY_TOTALS_MISMATCH');phase='complete';
   }
  }
  if(phase!=='complete')throw new RecoveryError('INVALID_MEDIA_RECOVERY_CATALOG');
  output=await open(journal,'wx',0o600);journalOwned=true;await output.writeFile(JSON.stringify({type:'header',collectionId:i.collectionId,academyId:i.academyId,catalogSha256:i.expectedSha256})+'\n');
  for await(const row of records())if(row.type==='object'){
   const entry=object.parse(row),directory=join(i.archiveDirectory,'media-'+entry.id);await privateDirectory(directory);
   const {etag:_etag,modifiedAt:_modifiedAt,...source}=entry.source;
   const recovered=await recoverMediaObject({age:i.age,identityFile:i.identityFile,archive:join(directory,'media.bin.age'),workDirectory:folder,source,expectedBytes:entry.archive.encryptedBytes,expectedSha256:entry.archive.ciphertextSha256},abort);recoveredObjects++;
   await output.writeFile(JSON.stringify({type:'object',archiveId:entry.id,...recovered})+'\n');await output.sync();
  }
  const result={format:'kavosh-media-collection-recovery-v1',id,academyId:i.academyId,collectionId:i.collectionId,catalogSha256:i.expectedSha256,recoveredObjects,sourceBytes,allCatalogObjectsRecovered:true,sourceOrRemoteObjectsModified:false,applicationActivationAllowed:false,completeMediaRestore:false};
  await output.writeFile(JSON.stringify({type:'complete',...result})+'\n');await output.sync();await output.close();output=undefined;await catalog.close();catalog=undefined;await unlink(clear);clearOwned=false;
  for(const directory of [folder,i.workDirectory]){const f=await open(directory,'r');try{await f.sync();}finally{await f.close();}}success=true;return{...result,journal};
 }catch(error){if(error instanceof RecoveryError)throw error;throw new RecoveryError(abort.aborted?'RECOVERY_CANCELLED':'MEDIA_COLLECTION_RECOVERY_FAILED');}
 finally{
  await catalog?.close().catch(()=>{});await output?.close().catch(()=>{});
  if(!success&&owned){let failed=false;const check=(error:unknown)=>{if((error as {code?:string}).code!=='ENOENT')failed=true;};if(cipherOwned)await unlink(cipher).catch(check);if(clearOwned)await unlink(clear).catch(check);
   // Already authenticated recovered objects and the incomplete journal remain
   // available for inspection/retry;no misleading complete footer is added.
   if(!recoveredObjects){if(journalOwned)await unlink(journal).catch(check);await rmdir(folder).catch(check);}if(failed)throw new RecoveryError('MEDIA_COLLECTION_RECOVERY_CLEANUP_REQUIRED');
  }
 }
}
