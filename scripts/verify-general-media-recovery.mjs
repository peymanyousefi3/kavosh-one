// Explicit read-only acceptance using the existing TWO synthetic cloud objects.
// Recovery keys and decrypted files stay in an owned private Mac temp folder.
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
import {mkdtemp,realpath,mkdir,open,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {recoverMediaCollection} from '../.recovery-tool/src/operations/media-collection-recovery.js';

const run=promisify(execFile),hash=bytes=>createHash('sha256').update(bytes).digest('hex'),uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
let folder,key,stage='arguments';
async function secret(service){const result=await run('/usr/bin/security',['find-generic-password','-a','kavosh-one','-s',service,'-w'],{encoding:'buffer',maxBuffer:65536});try{return JSON.parse(result.stdout.toString());}finally{result.stdout.fill(0);result.stderr.fill(0);}}
async function privateFile(path,bytes){const output=await open(path,'wx',0o600);try{await output.writeFile(bytes);}finally{await output.close();}}
try{
 assert.equal(process.platform,'darwin');const args=process.argv.slice(2),incremental=args.length===2&&args[1]==='--incremental';assert.deepEqual(args,incremental?['--execute','--incremental']:['--execute']);process.umask(0o077);
 const receipt=JSON.parse(await readFile(new URL(incremental?'../deploy/ovh/media-incremental-acceptance-2026-11-13.json':'../deploy/ovh/media-collection-acceptance-2026-11-13.json',import.meta.url),'utf8'));assert.equal(receipt.realPersonalDataUsed,false);assert.equal(receipt.syntheticObjects,2);assert.equal(receipt.syntheticBytesEach,768);assert.match(receipt.collectionId,uuid);if(incremental){assert.equal(receipt.reusedObjects,2);assert.equal(receipt.newObjectArchives,0);}
 stage='private connections';const drive=await secret('kavosh-one-drive-backup-connection');key=await secret('kavosh-one-production-backup-recovery');assert.equal(drive.token.scope,'https://www.googleapis.com/auth/drive.file');
 folder=await realpath(await mkdtemp('/private/tmp/kavosh-general-media-proof-'));const identity=join(folder,'identity.txt'),archives=join(folder,'archives'),work=join(folder,'recovery');await mkdir(archives,{mode:0o700});await mkdir(work,{mode:0o700});await privateFile(identity,key.identity);
 const env={PATH:process.env.PATH,RCLONE_CONFIG_KAVOSH_BACKUP_TYPE:'drive',RCLONE_CONFIG_KAVOSH_BACKUP_SCOPE:'drive.file',RCLONE_CONFIG_KAVOSH_BACKUP_ROOT_FOLDER_ID:drive.folderId,RCLONE_CONFIG_KAVOSH_BACKUP_CLIENT_ID:drive.clientId,RCLONE_CONFIG_KAVOSH_BACKUP_CLIENT_SECRET:drive.clientSecret,RCLONE_CONFIG_KAVOSH_BACKUP_TOKEN:JSON.stringify(drive.token)};
 async function download(id,filename,sha,bytes,path){
  assert.match(id,uuid);assert.ok(['catalog.jsonl.age','media.bin.age'].includes(filename));assert.match(sha,/^[a-f0-9]{64}$/);assert.ok(Number.isSafeInteger(bytes)&&bytes>=22&&bytes<=65536);
  const response=await run('/opt/homebrew/bin/rclone',['cat','kavosh_backup:backup-'+id+'/'+filename,'--config','/dev/null','--log-level','ERROR','--stats','0','--retries','1','--low-level-retries','1'],{env,encoding:'buffer',maxBuffer:bytes,timeout:30000});
  try{assert.equal(response.stdout.length,bytes);assert.equal(hash(response.stdout),sha);await privateFile(path,response.stdout);}finally{response.stdout.fill(0);response.stderr.fill(0);}
 }
 stage='independent catalog download';const archive=join(folder,'catalog.age');await download(receipt.collectionId,'catalog.jsonl.age',receipt.catalogCiphertextSha256,receipt.catalogEncryptedBytes,archive);
 const decoded=await run('/opt/homebrew/bin/age',['--decrypt','--identity',identity,archive],{encoding:'buffer',maxBuffer:65536,timeout:10000});let rows;try{rows=decoded.stdout.toString().trim().split('\n').map(line=>JSON.parse(line));}finally{decoded.stdout.fill(0);decoded.stderr.fill(0);}
 assert.equal(rows.length,4);assert.equal(rows[0].id,receipt.collectionId);assert.match(rows[0].academyId,uuid);const expected=Buffer.from('Kavosh One production storage verification. Synthetic bytes only;no personal or financial data.\n'.repeat(8));
 stage='independent synthetic object downloads';for(const entry of rows.slice(1,-1)){
  assert.equal(entry.type,'object');assert.match(entry.id,uuid);assert.equal(entry.source.bytes,expected.length);assert.equal(entry.source.sha256,hash(expected));assert.equal(entry.source.academyId,rows[0].academyId);
  const target=join(archives,'media-'+entry.id);await mkdir(target,{mode:0o700});await download(entry.id,'media.bin.age',entry.archive.ciphertextSha256,entry.archive.encryptedBytes,join(target,'media.bin.age'));
 }
 stage='general collection recovery';const result=await recoverMediaCollection({age:'/opt/homebrew/bin/age',identityFile:identity,archive,archiveDirectory:archives,workDirectory:work,academyId:rows[0].academyId,collectionId:receipt.collectionId,expectedSha256:receipt.catalogCiphertextSha256,expectedBytes:receipt.catalogEncryptedBytes,maximumObjects:2,maximumSourceBytes:1536,maximumCatalogBytes:65536},AbortSignal.timeout(60000));
 assert.equal(result.allCatalogObjectsRecovered,true);assert.equal(result.recoveredObjects,2);assert.equal(result.sourceBytes,1536);assert.equal(result.applicationActivationAllowed,false);
 const journal=(await readFile(result.journal,'utf8')).trim().split('\n').map(line=>JSON.parse(line));assert.equal(journal.at(-1).type,'complete');for(const entry of journal.filter(row=>row.type==='object'))assert.deepEqual(await readFile(entry.file),expected);
 console.log(JSON.stringify({collectionId:receipt.collectionId,actualDriveDownloads:3,generalCollectionRecoveryToolVerified:true,incrementalCatalogRecovered:incremental,exactSyntheticObjectsRecovered:2,exactSyntheticBytesRecovered:1536,recoveryKeyTransferredToVps:false,sourceOrRemoteObjectsModified:false,productionMediaRestoreVerified:false}));
}catch{console.error('GENERAL_MEDIA_RECOVERY_PROOF_FAILED: '+stage);process.exitCode=1;}
finally{if(key)key.identity='';if(folder)try{await rm(folder,{recursive:true,force:true});}catch{console.error('GENERAL_MEDIA_RECOVERY_CLEANUP_REQUIRED');process.exitCode=1;}}
