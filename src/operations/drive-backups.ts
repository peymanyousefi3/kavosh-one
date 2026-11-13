import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {constants} from 'node:fs';
import {open,realpath,mkdtemp,unlink,rmdir,lstat} from 'node:fs/promises';
import {dirname,isAbsolute,join} from 'node:path';
import {Transform,Writable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {z} from 'zod';
import {privateDirectory,regularFile,RecoveryError} from './database-backups.ts';

const path=z.string().min(1).max(4096).refine(v=>isAbsolute(v)&&!v.includes('\0'));
const secret=z.string().min(1).max(16384).regex(/^[\x21-\x7e]+$/);
export const driveBackupCredentials=z.object({clientId:z.string().regex(/^[A-Za-z0-9._-]{1,200}\.apps\.googleusercontent\.com$/),clientSecret:secret,
 folderId:z.string().regex(/^[A-Za-z0-9_-]{10,200}$/),token:z.object({access_token:secret,refresh_token:secret,token_type:z.literal('Bearer'),expiry:z.iso.datetime(),scope:z.literal('https://www.googleapis.com/auth/drive.file')}).strict()}).strict();
const input=z.object({rclone:path,archive:path,workDirectory:path,backupId:z.string().uuid().transform(v=>v.toLowerCase()),kind:z.enum(['database','configuration','verification','media']).default('database'),
 expectedSha256:z.string().regex(/^[a-f0-9]{64}$/),expectedBytes:z.number().int().min(22).max(1_099_511_627_776),drive:driveBackupCredentials,
 timeoutMs:z.number().int().min(1000).max(3_600_000).default(900000),bandwidthMiBPerSecond:z.number().int().min(1).max(64).default(4)}).strict();
let active=false;

// Offline operator-only integration;no web route,bot endpoint or env activation.
// rclone implements Drive OAuth/resumable transfers. Never run sync,move,purge,
// delete or credential config commands. Secrets enter its private environment,
// not argv/config files/logs. Only an independently hashed age archive is copied.
// https://rclone.org/drive/ https://rclone.org/commands/rclone_copyto/
// https://rclone.org/docs/#immutable https://rclone.org/commands/rclone_cat/
export async function copyEncryptedBackupToDrive(raw:unknown,externalSignal?:AbortSignal){
 const parsed=input.safeParse(raw);if(!parsed.success)throw new RecoveryError('INVALID_DRIVE_BACKUP_CONFIGURATION');const i=parsed.data;
 if(externalSignal?.aborted)throw new RecoveryError('RECOVERY_CANCELLED');
 // ponytail: one copy per operator process. A host scheduler must also prevent
 // overlapping processes;cross-host scheduling is not claimed by this adapter.
 if(active)throw new RecoveryError('DRIVE_BACKUP_BUSY');active=true;
 const controller=new AbortController(),cancel=()=>controller.abort(),timer=setTimeout(cancel,i.timeoutMs);externalSignal?.addEventListener('abort',cancel,{once:true});
 let folder:string|undefined,staged:string|undefined,owned=false,attempted=false;
 try{
  await privateDirectory(i.workDirectory);await privateDirectory(dirname(i.archive));const before=await regularFile(i.archive,true);
  if(before.size!==i.expectedBytes||await realpath(i.archive)!==i.archive)throw new RecoveryError('BACKUP_SOURCE_CHANGED');
  const binary=await realpath(i.rclone),binaryInfo=await lstat(binary);
  if(!binaryInfo.isFile()||(binaryInfo.mode&0o022)!==0||(binaryInfo.mode&0o111)===0||![0,process.getuid?.()].includes(binaryInfo.uid))throw new RecoveryError('UNSAFE_BACKUP_TRANSPORT');
  folder=await mkdtemp(join(i.workDirectory,'drive-copy-'));staged=join(folder,'database.dump.age');
  const source=await open(i.archive,constants.O_RDONLY|constants.O_NOFOLLOW);let output:Awaited<ReturnType<typeof open>>|undefined;
  const hash=createHash('sha256');let bytes=0,header=Buffer.alloc(0);
  try{
   const actual=await source.stat();if(actual.ino!==before.ino||actual.dev!==before.dev||actual.size!==before.size||actual.nlink!==1||actual.uid!==process.getuid?.()||(actual.mode&0o077)!==0)throw new RecoveryError('BACKUP_SOURCE_CHANGED');
   output=await open(staged,'wx',0o600);owned=true;
   const meter=new Transform({transform(chunk:Buffer,_encoding,done){bytes+=chunk.length;if(bytes>i.expectedBytes)return done(new RecoveryError('BACKUP_SOURCE_CHANGED'));if(header.length<22)header=Buffer.concat([header,chunk.subarray(0,22-header.length)]);hash.update(chunk);done(null,chunk);}});
   await pipeline(source.createReadStream({autoClose:true}),meter,output.createWriteStream({autoClose:true}),{signal:controller.signal});
  }finally{await source.close().catch(()=>{});await output?.close().catch(()=>{});}
  if(bytes!==i.expectedBytes||hash.digest('hex')!==i.expectedSha256)throw new RecoveryError('BACKUP_DIGEST_MISMATCH');
  if(header.toString()!=='age-encryption.org/v1\n')throw new RecoveryError('ENCRYPTED_BACKUP_REQUIRED');
  const sync=await open(staged,constants.O_RDWR|constants.O_NOFOLLOW);try{await sync.sync();}finally{await sync.close();}
  const environment:NodeJS.ProcessEnv={PATH:process.env.PATH,NODE_ENV:process.env.NODE_ENV??'production',LANG:'C',TZ:'UTC',
   RCLONE_CONFIG_KAVOSH_BACKUP_TYPE:'drive',RCLONE_CONFIG_KAVOSH_BACKUP_SCOPE:'drive.file',RCLONE_CONFIG_KAVOSH_BACKUP_ROOT_FOLDER_ID:i.drive.folderId,
   RCLONE_CONFIG_KAVOSH_BACKUP_CLIENT_ID:i.drive.clientId,RCLONE_CONFIG_KAVOSH_BACKUP_CLIENT_SECRET:i.drive.clientSecret,RCLONE_CONFIG_KAVOSH_BACKUP_TOKEN:JSON.stringify(i.drive.token)};
  const flags=['--config','/dev/null','--log-level','ERROR','--stats','0','--retries','1','--low-level-retries','1','--checkers','1','--transfers','1','--multi-thread-streams','0','--buffer-size','1M','--drive-chunk-size','8M','--bwlimit',i.bandwidthMiBPerSecond+'M','--contimeout','10s','--timeout','30s'];
  const filename={configuration:'configuration.tar.age',verification:'verification.json.age',database:'database.dump.age',media:'media.bin.age'}[i.kind];
  const remote='kavosh_backup:backup-'+i.backupId+'/'+filename;
  async function command(args:string[],verify=false){
   if(controller.signal.aborted)throw new RecoveryError('RECOVERY_CANCELLED');
   const child=spawn(binary,[...args,...flags],{env:environment,detached:process.platform!=='win32'});child.stdin.end();
   let failed=false,diagnosticBytes=0,outputBytes=0,remoteBytes=0,remoteMismatch=false,killTimer:ReturnType<typeof setTimeout>|undefined;const digest=createHash('sha256');
   const kill=(signal:NodeJS.Signals)=>{try{if(process.platform==='win32')child.kill(signal);else if(child.pid)process.kill(-child.pid,signal);}catch{}};
   const stop=()=>{kill('SIGTERM');killTimer??=setTimeout(()=>kill('SIGKILL'),1000);};
   child.on('error',()=>{failed=true;});child.stderr.on('data',(chunk:Buffer)=>{diagnosticBytes+=chunk.length;if(diagnosticBytes>8192)stop();});
   const ended=new Promise<void>((yes,no)=>child.once('close',code=>code===0&&!failed&&diagnosticBytes===0?yes():no(new RecoveryError('DRIVE_BACKUP_COPY_UNVERIFIED'))));
   // Attach handlers immediately:an early process error must not escape while
   // a pipe is still settling. Keep admission until the actual child closes.
   void ended.catch(()=>{});controller.signal.addEventListener('abort',stop,{once:true});
   if(!verify)child.stdout.on('data',(chunk:Buffer)=>{outputBytes+=chunk.length;if(outputBytes>8192)stop();});
   let transfer:Promise<void>|undefined;
   try{
    if(controller.signal.aborted)stop();
    if(verify){const meter=new Transform({transform(chunk:Buffer,_encoding,done){remoteBytes+=chunk.length;if(remoteBytes>i.expectedBytes){remoteMismatch=true;return done(new RecoveryError('DRIVE_BACKUP_REMOTE_DIGEST_MISMATCH'));}digest.update(chunk);done(null,chunk);}});transfer=pipeline(child.stdout,meter,new Writable({write(_chunk,_encoding,done){done();}}));await Promise.all([transfer,ended]);}
    else await ended;
    if(controller.signal.aborted)throw new RecoveryError('RECOVERY_CANCELLED');
    if(verify&&(remoteBytes!==i.expectedBytes||digest.digest('hex')!==i.expectedSha256))throw new RecoveryError('DRIVE_BACKUP_REMOTE_DIGEST_MISMATCH');
   }catch(error){if(remoteMismatch)throw new RecoveryError('DRIVE_BACKUP_REMOTE_DIGEST_MISMATCH');throw error;}
   finally{controller.signal.removeEventListener('abort',stop);if(child.exitCode===null&&child.signalCode===null)stop();await Promise.allSettled([ended,...transfer?[transfer]:[]]);if(killTimer)clearTimeout(killTimer);}
  }
  attempted=true;await command(['copyto',staged,remote,'--immutable','--checksum','--no-update-modtime']);await command(['cat',remote],true);
  return {backupId:i.backupId,ciphertextSha256:i.expectedSha256,encryptedBytes:i.expectedBytes,provider:'google_drive',scope:{configuration:'one_encrypted_configuration_archive',verification:'one_encrypted_verification_archive',database:'one_encrypted_database_archive',media:'one_encrypted_media_object_archive'}[i.kind],independentCopyVerified:true,verifiedAt:new Date().toISOString(),verification:'full_download_sha256_and_exact_length',sourceDeleted:false,remoteDeletionPerformed:false,remoteWormRetentionVerified:false,restoreVerified:false,mediaIncluded:i.kind==='media'};
 }catch(error){if(controller.signal.aborted)throw new RecoveryError(attempted?'DRIVE_BACKUP_COPY_UNVERIFIED':'RECOVERY_CANCELLED');if(error instanceof RecoveryError)throw error;throw new RecoveryError(attempted?'DRIVE_BACKUP_COPY_UNVERIFIED':'DRIVE_BACKUP_PREPARATION_FAILED');}
 finally{clearTimeout(timer);externalSignal?.removeEventListener('abort',cancel);controller.abort();let cleanupFailed=false;const cleanup=(error:unknown)=>{if((error as {code?:string})?.code!=='ENOENT')cleanupFailed=true;};if(owned&&staged)await unlink(staged).catch(cleanup);if(folder)await rmdir(folder).catch(cleanup);active=false;if(cleanupFailed)throw new RecoveryError('DRIVE_BACKUP_LOCAL_CLEANUP_FAILED');}
}
