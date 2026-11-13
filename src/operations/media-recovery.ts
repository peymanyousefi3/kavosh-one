import {createHash,randomUUID} from 'node:crypto';
import {constants} from 'node:fs';
import {open,mkdir,unlink,rmdir,statfs} from 'node:fs/promises';
import {join,isAbsolute} from 'node:path';
import {Transform} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {z} from 'zod';
import {RecoveryError,decryptRecoveryStream} from './database-backups.ts';
import {privateDirectory,regularFile,nativeRecoveryIdentity} from './recovery-files.ts';
import {recordedMediaReference} from './media-reference-plan.ts';

const path=z.string().min(1).max(4096).refine(v=>isAbsolute(v)&&!v.includes('\0'));
const input=z.object({age:path,identityFile:path,archive:path,workDirectory:path,source:recordedMediaReference,
 expectedSha256:z.string().regex(/^[a-f0-9]{64}$/),expectedBytes:z.number().int().min(22).max(4296146944),timeoutMs:z.number().int().min(1000).max(600000).default(120000)}).strict();

// Offline extraction only. The trusted hashes come from an independently
// retained catalog,not an adjacent untrusted manifest. No database/cloud writer.
export async function recoverMediaObject(raw:unknown,signal?:AbortSignal){
 const parsed=input.safeParse(raw);if(!parsed.success)throw new RecoveryError('INVALID_MEDIA_RECOVERY_CONFIGURATION');const i=parsed.data;
 if(signal?.aborted)throw new RecoveryError('RECOVERY_CANCELLED');
 const deadline=AbortSignal.timeout(i.timeoutMs),abort=signal?AbortSignal.any([signal,deadline]):deadline,id=randomUUID(),folder=join(i.workDirectory,'media-recovery-'+id),cipher=join(folder,'source.age'),clear=join(folder,'media.bin'),manifest=join(folder,'manifest.json');
 let owned=false,cipherOwned=false,clearOwned=false,manifestOwned=false,success=false;
 try{
  await privateDirectory(i.workDirectory);await nativeRecoveryIdentity(i.identityFile);const before=await regularFile(i.archive);if(before.size!==i.expectedBytes)throw new RecoveryError('BACKUP_DIGEST_MISMATCH');
  const disk=await statfs(i.workDirectory,{bigint:true});if(disk.bavail*disk.bsize<BigInt(i.expectedBytes)+BigInt(i.source.bytes)+67108864n)throw new RecoveryError('MEDIA_RECOVERY_DISK_CAPACITY_LOW');
  await mkdir(folder,{mode:0o700});owned=true;
  const source=await open(i.archive,constants.O_RDONLY|constants.O_NOFOLLOW),hash=createHash('sha256');let bytes=0;
  try{
   const current=await source.stat();if(current.ino!==before.ino||current.dev!==before.dev||current.size!==before.size||current.nlink!==1)throw new RecoveryError('UNSAFE_RECOVERY_FILE');
   const target=await open(cipher,'wx',0o600);cipherOwned=true;
   try{await pipeline(source.createReadStream({autoClose:true}),new Transform({transform(chunk:Buffer,_encoding,done){bytes+=chunk.length;if(bytes>i.expectedBytes)return done(new RecoveryError('BACKUP_DIGEST_MISMATCH'));hash.update(chunk);done(null,chunk);}}),target.createWriteStream({autoClose:true}),{signal:abort});}finally{await target.close().catch(()=>{});}
  }finally{await source.close().catch(()=>{});}
  if(bytes!==i.expectedBytes||hash.digest('hex')!==i.expectedSha256)throw new RecoveryError('BACKUP_DIGEST_MISMATCH');
  const encrypted=await open(cipher,constants.O_RDONLY|constants.O_NOFOLLOW);
  try{await decryptRecoveryStream({age:i.age,identityFile:i.identityFile,file:clear,expectedBytes:i.source.bytes,expectedSha256:i.source.sha256},encrypted.createReadStream({autoClose:true}),abort);clearOwned=true;}finally{await encrypted.close().catch(()=>{});}
  const result={format:'kavosh-media-object-recovery-v1',id,source:i.source,ciphertextSha256:i.expectedSha256,encryptedBytes:i.expectedBytes,authenticatedDecryption:true,exactContentVerified:true,recoveredAt:new Date().toISOString(),sourceOrRemoteObjectsModified:false,applicationActivationAllowed:false,completeMediaRestore:false};
  const receipt=await open(manifest,'wx',0o600);manifestOwned=true;try{await receipt.writeFile(JSON.stringify(result)+'\n');await receipt.sync();}finally{await receipt.close();}
  await unlink(cipher);cipherOwned=false;for(const directory of [folder,i.workDirectory]){const f=await open(directory,'r');try{await f.sync();}finally{await f.close();}}
  success=true;return{...result,file:clear,manifest};
 }catch(error){if(error instanceof RecoveryError)throw error;throw new RecoveryError(abort.aborted?'RECOVERY_CANCELLED':'MEDIA_RECOVERY_FAILED');}
 finally{if(!success&&owned){let failed=false;const check=(error:unknown)=>{if((error as {code?:string}).code!=='ENOENT')failed=true;};if(cipherOwned)await unlink(cipher).catch(check);if(clearOwned)await unlink(clear).catch(check);if(manifestOwned)await unlink(manifest).catch(check);await rmdir(folder).catch(check);if(failed)throw new RecoveryError('MEDIA_RECOVERY_CLEANUP_REQUIRED');}}
}
