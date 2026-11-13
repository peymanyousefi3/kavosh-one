import { backupDatabase,restoreDatabaseBackup,RecoveryError,privateDirectory,regularFile } from '../src/operations/database-backups.ts';
import {copyEncryptedBackupToDrive,driveBackupCredentials} from '../src/operations/drive-backups.ts';
import {backupVerification} from '../src/operations/database-verification.ts';
import {constants} from 'node:fs';
import {open} from 'node:fs/promises';
import {dirname,isAbsolute} from 'node:path';

// Deliberately offline operator tooling,not a web/admin/bot endpoint.
// Database credentials and the private decryption key never enter arguments.
const controller=new AbortController();
const cancel=()=>controller.abort();process.once('SIGTERM',cancel);process.once('SIGINT',cancel);
try{
 const [action,...args]=process.argv.slice(2);
 if(action==='--help'){
  console.log('backup: BACKUP_DATABASE_URL,BACKUP_AGE_RECIPIENT,RECOVERY_WORK_DIRECTORY,AGE_BIN,PG_DUMP_BIN');
  console.log('backup-proof: same settings;add a private bounded-memory row/ownership/function/RLS fingerprint baseline from the exact exported snapshot and a separate encrypted verification.json.age companion. Ordinary backup remains single-pass. Retain both archive hashes independently. Sequence values/global roles/media are not certified.');
  console.log('backup-drive: same backup settings plus RCLONE_BIN,BACKUP_DRIVE_CONNECTION_JSON;explicit opt-in encrypted database copy with full remote SHA256 verification.');
  console.log('backup-proof-drive: additionally encrypt and copy the exact-snapshot verification companion,with independent full readback of both archives. Ordinary nightly backups remain single-pass.');
  console.log('copy-drive BACKUP_ID ARCHIVE TRUSTED_SHA256 ENCRYPTED_BYTES: retry one existing encrypted archive using RCLONE_BIN,BACKUP_DRIVE_CONNECTION_JSON,RECOVERY_WORK_DIRECTORY.');
  console.log('copy-config BACKUP_ID ARCHIVE TRUSTED_SHA256 ENCRYPTED_BYTES: same guarded transport for an encrypted configuration archive;does not restore or apply credentials/roles.');
  console.log('copy-verification BACKUP_ID ARCHIVE TRUSTED_SHA256 ENCRYPTED_BYTES: retry only the encrypted verification companion to its fixed destination;never accepts plaintext proof or changes remote files.');
  console.log('Drive credentials must be injected from Keychain or a server secret manager,never command arguments or source. Only app-created file access;no Drive sync,delete,pruning or sharing changes. This does not schedule backups or verify a full restore/media recovery.');
  console.log('restore ARCHIVE TRUSTED_SHA256 EXPECTED_REVISION RESTORE:kavosh_recovery_NAME: RESTORE_DATABASE_URL,RESTORE_AGE_IDENTITY_FILE,RECOVERY_WORK_DIRECTORY,AGE_BIN,PG_RESTORE_BIN');
  console.log('Optional RESTORE_VERIFICATION_FILE: private600 backup-proof manifest/envelope in a private700 folder,maximum2MiB. Requires exact archive hash/revision and matching restored MVCC rows/ownership/functions/RLS before backupSnapshotVerified=true. Never compare against a later mutable live database.');
  console.log('TLS defaults to verify-full with RECOVERY_DATABASE_CA_FILE. Disable is allowed only for non-production loopback tests.');
  console.log('Backup login: direct database-scoped schema USAGE/table+sequence SELECT,BYPASSRLS and EXECUTE on public.schema_revision();no ownership,writes,role memberships or privileged-function access. Limit this login to the source database in server authentication rules.');
  console.log('Restore accepts only an empty isolated kavosh_recovery_ database. Preserve the trusted digest independently. Global role provisioning,media recovery,privacy/deletion and job/outbox reconciliation remain required before activation.');
  console.log('Restore requires an offline database superuser,refuses active ordinary clients,and leaves CONNECTION LIMIT 0 in place. It never reopens app or worker access.');
 }else{
  const common={age:process.env.AGE_BIN,workDirectory:process.env.RECOVERY_WORK_DIRECTORY,sslMode:process.env.RECOVERY_DATABASE_SSL_MODE??'verify-full',caFile:process.env.RECOVERY_DATABASE_CA_FILE};
  if((action==='backup'||action==='backup-proof')&&args.length===0)console.log(JSON.stringify(await backupDatabase({...common,databaseUrl:process.env.BACKUP_DATABASE_URL,pgDump:process.env.PG_DUMP_BIN,recipient:process.env.BACKUP_AGE_RECIPIENT,verificationSnapshot:action==='backup-proof'},controller.signal)));
  else if((['backup-drive','backup-proof-drive'].includes(action??'')&&args.length===0)||(['copy-drive','copy-config','copy-verification'].includes(action??'')&&args.length===4)){
   const connection=process.env.BACKUP_DRIVE_CONNECTION_JSON;if(!connection||Buffer.byteLength(connection)>65536)throw new RecoveryError('INVALID_DRIVE_BACKUP_CONFIGURATION');
   let drive:ReturnType<typeof driveBackupCredentials.parse>;try{drive=driveBackupCredentials.parse(JSON.parse(connection));}catch{throw new RecoveryError('INVALID_DRIVE_BACKUP_CONFIGURATION');}
   const transfer={rclone:process.env.RCLONE_BIN,workDirectory:common.workDirectory,drive};
   if(action==='backup-drive'||action==='backup-proof-drive'){
    const backup=await backupDatabase({...common,databaseUrl:process.env.BACKUP_DATABASE_URL,pgDump:process.env.PG_DUMP_BIN,recipient:process.env.BACKUP_AGE_RECIPIENT,verificationSnapshot:action==='backup-proof-drive'},controller.signal);
    const offsite=await copyEncryptedBackupToDrive({...transfer,archive:backup.archivePath,backupId:backup.id,expectedSha256:backup.ciphertextSha256,expectedBytes:backup.encryptedBytes},controller.signal);
    let verificationOffsite=null;
    if(action==='backup-proof-drive'){
     const proof=backup.verificationArchive;if(!proof)throw new RecoveryError('VERIFICATION_ARCHIVE_REQUIRED');
     verificationOffsite=await copyEncryptedBackupToDrive({...transfer,kind:'verification',archive:dirname(backup.archivePath)+'/'+proof.filename,backupId:backup.id,expectedSha256:proof.ciphertextSha256,expectedBytes:proof.encryptedBytes},controller.signal);
    }
    console.log(JSON.stringify({backup,offsite,verificationOffsite,recoveryBaselineOffsiteVerified:offsite.independentCopyVerified===true&&verificationOffsite?.independentCopyVerified===true}));
   }
   else console.log(JSON.stringify(await copyEncryptedBackupToDrive({...transfer,kind:action==='copy-config'?'configuration':action==='copy-verification'?'verification':'database',backupId:args[0],archive:args[1],expectedSha256:args[2],expectedBytes:Number(args[3])},controller.signal)));
  }
  else if(action==='restore'&&args.length===4){
   const file=process.env.RESTORE_VERIFICATION_FILE;let expectedVerification;
   if(process.env.RESTORE_VERIFICATION_JSON!==undefined)throw new RecoveryError('INVALID_RESTORE_VERIFICATION');
   if(file!==undefined){
    const bytes=Buffer.alloc(2097153);let handle;
    try{
     if(!isAbsolute(file))throw new Error();await privateDirectory(dirname(file));const before=await regularFile(file,true);if(before.size>2097152)throw new Error();
     handle=await open(file,constants.O_RDONLY|constants.O_NOFOLLOW);const actual=await handle.stat();if(actual.ino!==before.ino||actual.dev!==before.dev||actual.size!==before.size||actual.nlink!==1||(actual.mode&0o077)!==0||actual.uid!==process.getuid?.())throw new Error();
     const {bytesRead}=await handle.read(bytes,0,bytes.length,0);if(bytesRead!==before.size)throw new Error();const value=JSON.parse(bytes.subarray(0,bytesRead).toString('utf8'));
     expectedVerification=backupVerification.parse(value.format==='kavosh-database-backup-v1'?value.verification:value);
    }catch{throw new RecoveryError('INVALID_RESTORE_VERIFICATION');}finally{bytes.fill(0);await handle?.close();}
   }
   console.log(JSON.stringify(await restoreDatabaseBackup({...common,databaseUrl:process.env.RESTORE_DATABASE_URL,pgRestore:process.env.PG_RESTORE_BIN,identityFile:process.env.RESTORE_AGE_IDENTITY_FILE,archive:args[0],expectedSha256:args[1],expectedRevision:Number(args[2]),confirmation:args[3],expectedVerification},controller.signal)));
  }
  else throw new RecoveryError('INVALID_RECOVERY_COMMAND');
 }
}catch(e){console.error(e instanceof RecoveryError?e.code:'DATABASE_RECOVERY_FAILED');process.exitCode=1;}
finally{process.off('SIGTERM',cancel);process.off('SIGINT',cancel);}
