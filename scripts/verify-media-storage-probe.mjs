// Explicit acceptance for check-storage --media-backup's TWO synthetic objects.
// Not a production collection restorer. No SSH,source writes or remote deletion.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdtempSync,openSync,closeSync,writeFileSync,readFileSync,unlinkSync,rmdirSync} from 'node:fs';
import {join} from 'node:path';
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const digest=value=>createHash('sha256').update(value).digest('hex');
let stage='arguments',directory,recovery;const owned=[];
function get(service){const bytes=execFileSync('/usr/bin/security',['find-generic-password','-a','kavosh-one','-s',service,'-w'],{stdio:['ignore','pipe','pipe']});try{return JSON.parse(bytes.toString());}finally{bytes.fill(0);}}
try{
 assert.equal(process.platform,'darwin');const [flag,id,sha,size,...extra]=process.argv.slice(2);assert.equal(flag,'--execute');assert.equal(extra.length,0);assert.match(id,uuid);assert.match(sha,/^[a-f0-9]{64}$/);const bytes=Number(size);assert.ok(Number.isSafeInteger(bytes)&&bytes>=22&&bytes<=65536);process.umask(0o077);
 stage='private connection';const drive=get('kavosh-one-drive-backup-connection');recovery=get('kavosh-one-production-backup-recovery');assert.equal(drive.token.scope,'https://www.googleapis.com/auth/drive.file');
 directory=mkdtempSync('/private/tmp/kavosh-media-cloud-proof-');
 const environment={PATH:process.env.PATH,RCLONE_CONFIG_KAVOSH_BACKUP_TYPE:'drive',RCLONE_CONFIG_KAVOSH_BACKUP_SCOPE:'drive.file',RCLONE_CONFIG_KAVOSH_BACKUP_ROOT_FOLDER_ID:drive.folderId,RCLONE_CONFIG_KAVOSH_BACKUP_CLIENT_ID:drive.clientId,RCLONE_CONFIG_KAVOSH_BACKUP_CLIENT_SECRET:drive.clientSecret,RCLONE_CONFIG_KAVOSH_BACKUP_TOKEN:JSON.stringify(drive.token)};
 function download(backupId,filename,expectedHash,expectedBytes,label){
  assert.match(backupId,uuid);assert.ok(['media.bin.age','catalog.jsonl.age'].includes(filename));assert.match(expectedHash,/^[a-f0-9]{64}$/);assert.ok(Number.isSafeInteger(expectedBytes)&&expectedBytes>=22&&expectedBytes<=65536);
  const content=execFileSync('/opt/homebrew/bin/rclone',['cat','kavosh_backup:backup-'+backupId+'/'+filename,'--config','/dev/null','--log-level','ERROR','--stats','0','--retries','1','--low-level-retries','1'],{env:environment,stdio:['ignore','pipe','pipe'],timeout:30000,maxBuffer:expectedBytes});
  const file=join(directory,label+'.age');try{assert.equal(content.length,expectedBytes);assert.equal(digest(content),expectedHash);const fd=openSync(file,'wx',0o600);owned.push(file);try{writeFileSync(fd,content);}finally{closeSync(fd);}}finally{content.fill(0);}
  const clear=join(directory,label+'.clear'),output=openSync(clear,'wx',0o600);owned.push(clear);try{execFileSync('/opt/homebrew/bin/age',['--decrypt','--identity','-',file],{input:recovery.identity,env:{PATH:process.env.PATH,LANG:'C'},stdio:['pipe',output,'pipe'],timeout:10000});}finally{closeSync(output);}return clear;
 }
 stage='independent catalog download and authenticated decryption';const catalog=download(id,'catalog.jsonl.age',sha,bytes,'catalog'),lines=readFileSync(catalog,'utf8').trim().split('\n').map(line=>JSON.parse(line));
 assert.equal(lines.length,4);const [header,first,second,complete]=lines;assert.equal(header.type,'header');assert.equal(header.format,'kavosh-media-catalog-v1');assert.equal(header.id,id);assert.match(header.academyId,uuid);assert.equal(header.targets.length,2);assert.deepEqual(header.targets.map(t=>t.stage).sort(),['clean','quarantine']);assert.equal(complete.type,'complete');assert.equal(complete.objects,2);assert.equal(complete.matchingFinalInventory,true);assert.equal(complete.atomicStorageSnapshot,false);
 const expected=Buffer.from('Kavosh One production storage verification. Synthetic bytes only;no personal or financial data.\n'.repeat(8)),entries=[first,second];assert.equal(complete.sourceBytes,expected.length*2);assert.equal(first.source.fileId,second.source.fileId);assert.deepEqual(entries.map(e=>e.source.stage).sort(),['clean','quarantine']);
 for(let index=0;index<entries.length;index++){
  stage='independent synthetic object download and authenticated decryption';const e=entries[index];assert.equal(e.type,'object');assert.match(e.id,uuid);assert.match(e.source.fileId,uuid);assert.equal(e.source.academyId,header.academyId);assert.ok(header.targets.some(t=>t.stage===e.source.stage&&t.storageTargetId===e.source.storageTargetId));assert.equal(e.source.bytes,expected.length);assert.equal(e.source.sha256,digest(expected));assert.equal(e.archive.filename,'media.bin.age');assert.equal(e.offsite.independentCopyVerified,true);
  const clear=download(e.id,'media.bin.age',e.archive.ciphertextSha256,e.archive.encryptedBytes,'object-'+index);assert.deepEqual(readFileSync(clear),expected);
 }
 console.log(JSON.stringify({collectionId:id,independentRealDriveDownloads:3,authenticatedCatalogAndMediaDecryption:true,syntheticObjectsVerified:2,syntheticSourceBytesVerified:expected.length*2,recoveryKeyTransferredToVps:false,sourceOrRemoteObjectsModified:false,productionMediaRestoreVerified:false}));
}catch{console.error('SYNTHETIC_MEDIA_RECOVERY_PROOF_FAILED: '+stage);process.exitCode=1;}
finally{
 if(recovery)recovery.identity='';let failed=false;for(const file of owned)try{unlinkSync(file);}catch{failed=true;}if(directory)try{rmdirSync(directory);}catch{failed=true;}if(failed){console.error('SYNTHETIC_MEDIA_RECOVERY_CLEANUP_REQUIRED');process.exitCode=1;}
}
