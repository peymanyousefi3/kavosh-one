import {randomUUID} from 'node:crypto';
import {mkdir,open,unlink,rmdir} from 'node:fs/promises';
import {join,isAbsolute} from 'node:path';
import {z} from 'zod';
import type {S3ClientConfig} from '@aws-sdk/client-s3';
import {privateR2} from '../integrations/r2.ts';
import {r2Connection,r2TargetId} from '../integrations/r2-config.ts';
import {privateDirectory,encryptRecoveryStream,RecoveryError} from './database-backups.ts';

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
 const id=randomUUID(),folder=join(i.workDirectory,'media-'+id),archive=join(folder,'media.bin.age'),metadata=join(folder,'manifest.json');
 let owned=false,archiveOwned=false,metadataOwned=false,success=false;const reader=privateR2(i.configuration,i.academyId,handler);
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
 finally{reader.close();if(!success&&owned){let failed=false;const check=(error:unknown)=>{if((error as {code?:string}).code!=='ENOENT')failed=true;};if(metadataOwned)await unlink(metadata).catch(check);if(archiveOwned)await unlink(archive).catch(check);await rmdir(folder).catch(check);if(failed)throw new RecoveryError('MEDIA_BACKUP_CLEANUP_REQUIRED');}}
}
