// Explicit read-only off-server recovery of a retained scheduled media batch.
// Cloud downloads are streamed and bounded;keys never leave this Mac.
import assert from 'node:assert/strict';
import {execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
import {mkdtemp,realpath,mkdir,open,rm} from 'node:fs/promises';
import {constants} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {Transform} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {decryptRecoveryStream} from '../.recovery-tool/src/operations/database-backups.js';
import {authenticatedRecoveryRecords} from '../.recovery-tool/src/operations/recovery-json-records.js';
import {recoverMediaBatch} from '../.recovery-tool/src/operations/media-batch-recovery.js';

const run=promisify(execFile),uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/,sha=/^[a-f0-9]{64}$/;
const signal=AbortSignal.timeout(3600000);let folder,key,stage='arguments',downloads=0,metadataNumber=0;
async function secret(service){const result=await run('/usr/bin/security',['find-generic-password','-a','kavosh-one','-s',service,'-w'],{encoding:'buffer',maxBuffer:65536});try{return JSON.parse(result.stdout.toString());}finally{result.stdout.fill(0);result.stderr.fill(0);}}
try{
 assert.equal(process.platform,'darwin');const [flag,id,...extra]=process.argv.slice(2);assert.equal(flag,'--execute');assert.equal(extra.length,0);assert.match(id,uuid);process.umask(0o077);
 stage='private retained receipt';const config=fileURLToPath(new URL('../.local-tools/ovh.ssh-config',import.meta.url)),response=await run('/usr/bin/ssh',['-F',config,'kavosh-one-production','sudo -u kavosh-one-backup cat /var/lib/kavosh-one-backups/backup-'+id+'/delivery-status.json'],{encoding:'buffer',maxBuffer:3145728,timeout:30000});let receipt;try{receipt=JSON.parse(response.stdout.toString());}finally{response.stdout.fill(0);response.stderr.fill(0);}
 const backup=receipt.localBackup,batch=receipt.mediaBatch;assert.equal(backup.id,id);assert.match(backup.ciphertextSha256,sha);assert.equal(receipt.offsiteCopy.independentCopyVerified,true);assert.equal(receipt.snapshotBaselineOffsiteVerified,true);assert.equal(receipt.mediaReferencePlanOffsiteVerified,true);assert.equal(receipt.ordinaryMediaOffsiteVerified,true);assert.match(batch.id,uuid);assert.equal(batch.signedEvidenceIncluded,false);assert.equal(batch.ordinaryRecordedMediaBackedUp,true);assert.equal(batch.offsite.independentCopyVerified,true);assert.equal(batch.offsite.scope,'one_encrypted_media_batch_catalog');assert.equal(batch.offsite.backupId,batch.id);assert.equal(batch.offsite.ciphertextSha256,batch.catalog.ciphertextSha256);assert.equal(batch.referenceBinding.databaseBackupId,id);assert.equal(batch.referenceBinding.archiveSha256,backup.ciphertextSha256);assert.equal(batch.referenceBinding.schemaRevision,backup.schemaRevision);
 stage='private connections';const drive=await secret('kavosh-one-drive-backup-connection');key=await secret('kavosh-one-production-backup-recovery');assert.equal(drive.token.scope,'https://www.googleapis.com/auth/drive.file');
 folder=await realpath(await mkdtemp('/private/tmp/kavosh-batch-recovery-proof-'));const identity=join(folder,'identity.txt'),archives=join(folder,'archives'),work=join(folder,'recovery');await mkdir(archives,{mode:0o700});await mkdir(work,{mode:0o700});const identityFile=await open(identity,'wx',0o600);try{await identityFile.writeFile(key.identity);}finally{await identityFile.close();}
 const env={PATH:process.env.PATH,RCLONE_CONFIG_KAVOSH_BACKUP_TYPE:'drive',RCLONE_CONFIG_KAVOSH_BACKUP_SCOPE:'drive.file',RCLONE_CONFIG_KAVOSH_BACKUP_ROOT_FOLDER_ID:drive.folderId,RCLONE_CONFIG_KAVOSH_BACKUP_CLIENT_ID:drive.clientId,RCLONE_CONFIG_KAVOSH_BACKUP_CLIENT_SECRET:drive.clientSecret,RCLONE_CONFIG_KAVOSH_BACKUP_TOKEN:JSON.stringify(drive.token)};
 async function download(id,filename,digest,bytes,target){
  assert.match(id,uuid);assert.ok(['collections.jsonl.age','catalog.jsonl.age','media.bin.age'].includes(filename));assert.match(digest,sha);assert.ok(Number.isSafeInteger(bytes)&&bytes>=22&&bytes<=4296146944);if(signal.aborted)throw Error();
  const output=await open(target,'wx',0o600),hash=createHash('sha256');let size=0,diagnostics=0,killTimer;
  const child=spawn('/opt/homebrew/bin/rclone',['cat','kavosh_backup:backup-'+id+'/'+filename,'--config','/dev/null','--log-level','ERROR','--stats','0','--retries','1','--low-level-retries','1','--bwlimit','4M'],{env,detached:true,stdio:['ignore','pipe','pipe']}),kill=kind=>{try{if(child.pid)process.kill(-child.pid,kind);}catch{}},stop=()=>{kill('SIGTERM');killTimer??=setTimeout(()=>kill('SIGKILL'),1000);};
  const ended=new Promise((yes,no)=>{child.once('error',no);child.once('close',code=>code===0&&diagnostics===0?yes():no(Error()));});void ended.catch(()=>{});child.stderr.on('data',chunk=>{diagnostics+=chunk.length;if(diagnostics>8192)stop();});signal.addEventListener('abort',stop,{once:true});const timer=setTimeout(stop,Math.max(60000,Math.ceil(bytes/4194304)*1000+120000));let transfer;
  try{transfer=pipeline(child.stdout,new Transform({transform(chunk,_encoding,done){size+=chunk.length;if(size>bytes)return done(Error());hash.update(chunk);done(null,chunk);}}),output.createWriteStream({autoClose:true}),{signal});await Promise.all([ended,transfer]);assert.ok(!signal.aborted);assert.equal(size,bytes);assert.equal(hash.digest('hex'),digest);downloads++;}
  finally{clearTimeout(timer);signal.removeEventListener('abort',stop);if(child.exitCode===null&&child.signalCode===null)stop();await Promise.allSettled([ended,...transfer?[transfer]:[]]);if(killTimer)clearTimeout(killTimer);await output.close().catch(()=>{});}
 }
 async function metadata(cipher,maximumBytes){
  const clear=join(folder,'metadata-'+(++metadataNumber)+'.jsonl'),encrypted=await open(cipher,constants.O_RDONLY|constants.O_NOFOLLOW);let proof;try{proof=await decryptRecoveryStream({age:'/opt/homebrew/bin/age',identityFile:identity,file:clear,maximumBytes},encrypted.createReadStream({autoClose:true}),signal);}finally{await encrypted.close().catch(()=>{});}const file=await open(clear,constants.O_RDONLY|constants.O_NOFOLLOW);try{return{records:await authenticatedRecoveryRecords(file,proof,maximumBytes,signal),close:()=>file.close()};}catch(error){await file.close();throw error;}
 }
 stage='independent batch index download';const archive=join(folder,'batch.age');assert.equal(batch.catalog.filename,'collections.jsonl.age');await download(batch.id,'collections.jsonl.age',batch.catalog.ciphertextSha256,batch.catalog.encryptedBytes,archive);
 const index=await metadata(archive,8388608);let schools=0,objects=0;
 try{for await(const row of index.records())if(row.type==='collection'){
  stage='independent child catalog download';assert.match(row.id,uuid);assert.match(row.academyId,uuid);assert.equal(row.catalog.filename,'catalog.jsonl.age');assert.ok(++schools<=batch.academies);const directory=join(archives,'media-collection-'+row.id);await mkdir(directory,{mode:0o700});const catalog=join(directory,'catalog.jsonl.age');await download(row.id,'catalog.jsonl.age',row.catalog.ciphertextSha256,row.catalog.encryptedBytes,catalog);
  const child=await metadata(catalog,268435456);try{for await(const entry of child.records())if(entry.type==='object'){
   stage='independent encrypted object download';assert.match(entry.id,uuid);assert.equal(entry.source.academyId,row.academyId);assert.equal(entry.archive.filename,'media.bin.age');assert.ok(++objects<=batch.objects);const target=join(archives,'media-'+entry.id);await mkdir(target,{mode:0o700});await download(entry.id,'media.bin.age',entry.archive.ciphertextSha256,entry.archive.encryptedBytes,join(target,'media.bin.age'));
  }}finally{await child.close();}
 }}finally{await index.close();}assert.equal(schools,batch.academies);assert.equal(objects,batch.objects);
 stage='whole batch recovery';const result=await recoverMediaBatch({age:'/opt/homebrew/bin/age',identityFile:identity,archive,archiveDirectory:archives,workDirectory:work,batchId:batch.id,expectedSha256:batch.catalog.ciphertextSha256,expectedBytes:batch.catalog.encryptedBytes,expectedDatabaseBackupId:id,expectedDatabaseSha256:backup.ciphertextSha256,expectedSchemaRevision:backup.schemaRevision},signal);assert.equal(result.allBatchCollectionsRecovered,true);assert.equal(result.ordinaryRecordedMediaRecovered,true);assert.equal(result.recoveredCollections,batch.academies);assert.equal(result.recoveredObjects,batch.objects);assert.equal(result.sourceBytes,batch.sourceBytes);assert.equal(result.applicationActivationAllowed,false);
 console.log(JSON.stringify({databaseBackupId:id,batchId:batch.id,independentDriveDownloads:downloads,authenticatedWholeBatchRecoveryVerified:true,recoveredCollections:result.recoveredCollections,recoveredObjects:result.recoveredObjects,recoveredSourceBytes:result.sourceBytes,originalDatabaseBindingVerified:true,recoveryKeyTransferredToVps:false,sourceOrRemoteObjectsModified:false,databaseRestorePerformed:false,applicationActivated:false}));
}catch{console.error('MEDIA_BATCH_ACCEPTANCE_FAILED: '+stage);process.exitCode=1;}
finally{if(key)key.identity='';if(folder)try{await rm(folder,{recursive:true,force:true});}catch{console.error('MEDIA_BATCH_ACCEPTANCE_CLEANUP_REQUIRED');process.exitCode=1;}}
