// Explicit off-server authentication of one retained database reference plan.
// No database restore,cloud write,source edit or recovery-key transfer to VPS.
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
import {mkdtemp,realpath,open,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {openMediaReferencePlan} from '../.recovery-tool/src/operations/media-reference-plan.js';

const run=promisify(execFile),sha=/^[a-f0-9]{64}$/,uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
let folder,key,stage='arguments';
async function secret(service){const result=await run('/usr/bin/security',['find-generic-password','-a','kavosh-one','-s',service,'-w'],{encoding:'buffer',maxBuffer:65536});try{return JSON.parse(result.stdout.toString());}finally{result.stdout.fill(0);result.stderr.fill(0);}}
async function save(path,bytes){const f=await open(path,'wx',0o600);try{await f.writeFile(bytes);}finally{await f.close();}}
try{
 assert.equal(process.platform,'darwin');const [flag,id,...extra]=process.argv.slice(2);assert.equal(flag,'--execute');assert.equal(extra.length,0);assert.match(id,uuid);process.umask(0o077);
 stage='retained private receipt';const config=fileURLToPath(new URL('../.local-tools/ovh.ssh-config',import.meta.url)),response=await run('/usr/bin/ssh',['-F',config,'kavosh-one-production','sudo -u kavosh-one-backup cat /var/lib/kavosh-one-backups/backup-'+id+'/delivery-status.json'],{encoding:'buffer',maxBuffer:3145728,timeout:30000});let receipt;try{receipt=JSON.parse(response.stdout.toString());}finally{response.stdout.fill(0);response.stderr.fill(0);}
 const backup=receipt.localBackup,plan=backup.mediaReferencePlan,archive=backup.mediaReferenceArchive;assert.equal(backup.id,id);assert.match(backup.ciphertextSha256,sha);assert.equal(receipt.mediaReferencePlanOffsiteVerified,true);assert.equal(receipt.mediaReferenceOffsiteCopy.independentCopyVerified,true);assert.equal(receipt.mediaReferenceOffsiteCopy.ciphertextSha256,archive.ciphertextSha256);
 assert.equal(plan.databaseBackupId,id);assert.equal(plan.archiveSha256,backup.ciphertextSha256);assert.equal(plan.schemaRevision,backup.schemaRevision);assert.equal(plan.format,'kavosh-media-reference-plan-v1');assert.equal(plan.scope,'recorded_ordinary_file_objects');assert.equal(plan.signedEvidenceIncluded,false);assert.equal(plan.filename,'media-references.jsonl');assert.equal(archive.filename,'media-references.jsonl.age');assert.match(plan.plaintextSha256,sha);assert.match(archive.ciphertextSha256,sha);
 assert.ok(Number.isSafeInteger(archive.encryptedBytes)&&archive.encryptedBytes>=22&&archive.encryptedBytes<=4194304);assert.ok(Number.isSafeInteger(plan.plaintextBytes)&&plan.plaintextBytes>0&&plan.plaintextBytes<=4194304);
 stage='private connections';const drive=await secret('kavosh-one-drive-backup-connection');key=await secret('kavosh-one-production-backup-recovery');assert.equal(drive.token.scope,'https://www.googleapis.com/auth/drive.file');folder=await realpath(await mkdtemp('/private/tmp/kavosh-reference-proof-'));const cipher=join(folder,'plan.age'),clear=join(folder,'plan.jsonl'),identity=join(folder,'identity.txt');await save(identity,key.identity);
 const env={PATH:process.env.PATH,RCLONE_CONFIG_KAVOSH_BACKUP_TYPE:'drive',RCLONE_CONFIG_KAVOSH_BACKUP_SCOPE:'drive.file',RCLONE_CONFIG_KAVOSH_BACKUP_ROOT_FOLDER_ID:drive.folderId,RCLONE_CONFIG_KAVOSH_BACKUP_CLIENT_ID:drive.clientId,RCLONE_CONFIG_KAVOSH_BACKUP_CLIENT_SECRET:drive.clientSecret,RCLONE_CONFIG_KAVOSH_BACKUP_TOKEN:JSON.stringify(drive.token)};
 stage='independent encrypted download';const downloaded=await run('/opt/homebrew/bin/rclone',['cat','kavosh_backup:backup-'+id+'/media-references.jsonl.age','--config','/dev/null','--log-level','ERROR','--stats','0','--retries','1','--low-level-retries','1'],{env,encoding:'buffer',maxBuffer:archive.encryptedBytes,timeout:30000});try{assert.equal(downloaded.stdout.length,archive.encryptedBytes);assert.equal(createHash('sha256').update(downloaded.stdout).digest('hex'),archive.ciphertextSha256);await save(cipher,downloaded.stdout);}finally{downloaded.stdout.fill(0);downloaded.stderr.fill(0);}
 stage='off-server authenticated decryption';const decoded=await run('/opt/homebrew/bin/age',['--decrypt','--identity',identity,cipher],{env:{PATH:process.env.PATH,LANG:'C'},encoding:'buffer',maxBuffer:plan.plaintextBytes,timeout:30000});try{assert.equal(decoded.stdout.length,plan.plaintextBytes);assert.equal(createHash('sha256').update(decoded.stdout).digest('hex'),plan.plaintextSha256);await save(clear,decoded.stdout);}finally{decoded.stdout.fill(0);decoded.stderr.fill(0);}
 stage='complete original database binding';const text=await readFile(clear,'utf8');assert.ok(text.endsWith('\n'));const rows=text.trim().split('\n').map(line=>{assert.ok(Buffer.byteLength(line)<=65536);return JSON.parse(line);}),schools=rows.filter(row=>row.type==='academy');assert.equal(schools.length,plan.academies);assert.ok(schools.length>0&&schools.length<=1000);let references=0,unconfirmedUploads=0;
 for(const school of schools){
  assert.match(school.academyId,uuid);const targets=new Set(rows.filter(row=>row.type==='reference'&&row.academyId===school.academyId).map(row=>row.stage+':'+row.storageTargetId));
  const reader=await openMediaReferencePlan({file:clear,databaseBackupId:id,archiveSha256:backup.ciphertextSha256,schemaRevision:backup.schemaRevision,plaintextSha256:plan.plaintextSha256,plaintextBytes:plan.plaintextBytes},school.academyId,targets,AbortSignal.timeout(30000));try{let actual=0;for await(const _ of reader.referencesForSchool)actual++;assert.equal(actual,reader.references);references+=actual;unconfirmedUploads+=reader.unconfirmedUploads;}finally{await reader.close();}
 }
 assert.equal(references,plan.references);assert.equal(unconfirmedUploads,plan.unconfirmedUploads);
 console.log(JSON.stringify({backupId:id,independentDriveDownload:true,offServerAuthenticatedReferencePlanVerified:true,originalDatabaseArchiveBindingVerified:true,academies:schools.length,recordedReferences:references,unconfirmedUploads,recoveryKeyTransferredToVps:false,sourceOrRemoteObjectsModified:false,mediaBytesRecovered:false}));
}catch{console.error('REFERENCE_PLAN_ACCEPTANCE_FAILED: '+stage);process.exitCode=1;}
finally{if(key)key.identity='';if(folder)try{await rm(folder,{recursive:true,force:true});}catch{console.error('REFERENCE_PLAN_CLEANUP_REQUIRED');process.exitCode=1;}}
