import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,realpath,readFile,readdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {Readable} from 'node:stream';
import {createHash} from 'node:crypto';
import {backupMediaCollection} from '../src/operations/media-backups.ts';
import {recoverMediaCollection} from '../src/operations/media-collection-recovery.ts';
import {driveBackupFixture} from './drive-backup-fixture.ts';
import {r2TargetId} from '../src/integrations/r2-config.ts';

const run=promisify(execFile),academyId='aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa',fileId='bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb';
test('incremental media collections reuse only exact private versions and recipients,rehash ciphertext and reverify offsite copies',{
 skip:!process.env.AGE_BIN||!process.env.AGE_KEYGEN_BIN
},async()=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'kavosh-media-reuse-test-'))),identity=join(root,'identity.txt'),secondKey=join(root,'second.txt'),drive=await driveBackupFixture(),badDrive=await driveBackupFixture('short');let downloads=0,revision=1;
 try{
  await run(process.env.AGE_KEYGEN_BIN!,['--output',identity]);await run(process.env.AGE_KEYGEN_BIN!,['--output',secondKey]);const recipient=(await run(process.env.AGE_KEYGEN_BIN!,['-y',identity])).stdout.trim(),otherRecipient=(await run(process.env.AGE_KEYGEN_BIN!,['-y',secondKey])).stdout.trim();
  const configuration={accountId:'a'.repeat(32),jurisdiction:'default',bucket:'synthetic-private-reuse',accessKeyId:'synthetic-reader',secretAccessKey:'synthetic-secret-not-real',maximumUploadBytes:4194304};
  const options={academyId,age:process.env.AGE_BIN,recipient,workDirectory:root,reuseExistingArchives:true,targets:[{stage:'clean',configuration},{stage:'quarantine',configuration}]};
  const handler=()=>({async handle(request:{query?:Record<string,unknown>;headers:Record<string,string>}){
   const bytes=Buffer.from('PRIVATE_MEDIA_VERSION_'+revision),etag='"version-'+revision+'"';
   if(request.query?.['list-type']==='2'){const prefix=String(request.query.prefix);return{response:{statusCode:200,headers:{},body:Readable.from([`<ListBucketResult><Name>${configuration.bucket}</Name><Prefix>${prefix}</Prefix><KeyCount>1</KeyCount><IsTruncated>false</IsTruncated><Contents><Key>${prefix}${fileId}</Key><ETag>&quot;version-${revision}&quot;</ETag><Size>${bytes.length}</Size><LastModified>2026-11-13T00:00:00Z</LastModified></Contents></ListBucketResult>`])}};}
   downloads++;assert.equal(request.headers['if-match'],etag);return{response:{statusCode:200,headers:{etag,'content-length':String(bytes.length),'content-type':'application/octet-stream'},body:Readable.from([bytes])}};
  },destroy(){}});
  const first=await backupMediaCollection(options,undefined,handler);assert.equal(first.reusedObjects,0);assert.equal(first.newObjectArchives,2);assert.equal(downloads,2);
  const second=await backupMediaCollection({...options,offsite:{rclone:drive.input.rclone,drive:drive.input.drive}},undefined,handler);assert.equal(second.reusedObjects,2);assert.equal(second.newObjectArchives,0);assert.equal(downloads,2);assert.equal(second.allArchivesIndependentlyCopied,true);assert.equal((await drive.calls()).length,6);assert.equal(second.completeMediaBackup,false);
  const catalog=async(path:string)=>(await run(process.env.AGE_BIN!,['--decrypt','--identity',identity,path])).stdout.trim().split('\n').map(line=>JSON.parse(line));
  const firstRows=await catalog(first.archivePath),secondRows=await catalog(second.archivePath);assert.deepEqual(secondRows.filter(row=>row.type==='object').map(row=>row.id),firstRows.filter(row=>row.type==='object').map(row=>row.id));
  const recovered=await recoverMediaCollection({age:process.env.AGE_BIN,identityFile:identity,archive:second.archivePath,archiveDirectory:root,workDirectory:root,academyId,collectionId:second.id,expectedSha256:second.catalog.ciphertextSha256,expectedBytes:second.catalog.encryptedBytes});assert.equal(recovered.recoveredObjects,2);
  revision=2;const changed=await backupMediaCollection(options,undefined,handler);assert.equal(changed.reusedObjects,0);assert.equal(downloads,4);
  const rotated=await backupMediaCollection({...options,recipient:otherRecipient},undefined,handler);assert.equal(rotated.reusedObjects,0);assert.equal(downloads,6);const rotatedRows=(await run(process.env.AGE_BIN!,['--decrypt','--identity',secondKey,rotated.archivePath])).stdout;assert.ok(rotatedRows.includes('"type":"complete"'));
  const foreign=await backupMediaCollection({...options,academyId:'cccccccc-cccc-4ccc-8ccc-cccccccccccc'},undefined,handler);assert.equal(foreign.reusedObjects,0);assert.equal(downloads,8);
  const differentTarget=await backupMediaCollection({...options,targets:options.targets.map(t=>({...t,configuration:{...configuration,accountId:'b'.repeat(32)}}))},undefined,handler);assert.equal(differentTarget.reusedObjects,0);assert.equal(downloads,10);
  const disabled=await backupMediaCollection({...options,reuseExistingArchives:false},undefined,handler);assert.equal(disabled.reusedObjects,0);assert.equal(downloads,12);
  await assert.rejects(backupMediaCollection({...options,offsite:{rclone:badDrive.input.rclone,drive:badDrive.input.drive}},undefined,handler),{code:'DRIVE_BACKUP_REMOTE_DIGEST_MISMATCH'});assert.equal(downloads,12);
  const binding={databaseBackupId:academyId,archiveSha256:'e'.repeat(64),schemaRevision:396},plan=join(root,'references.jsonl'),text=[{type:'header',format:'kavosh-media-reference-plan-v1',...binding,scope:'recorded_ordinary_file_objects',signedEvidenceIncluded:false},{type:'academy',academyId,unconfirmedUploads:0},{type:'reference',academyId,fileId,stage:'clean',storageTargetId:r2TargetId({...configuration,jurisdiction:'default'}),bytes:Buffer.byteLength('PRIVATE_MEDIA_VERSION_2'),sha256:'0'.repeat(64)},{type:'complete',academies:1,references:1,unconfirmedUploads:0}].map(row=>JSON.stringify(row)+'\n').join('');await writeFile(plan,text,{mode:0o600});
  await assert.rejects(backupMediaCollection({...options,referencePlan:{...binding,file:plan,plaintextSha256:createHash('sha256').update(text).digest('hex'),plaintextBytes:Buffer.byteLength(text)}},undefined,handler),{code:'MEDIA_REFERENCE_CONTENT_CHANGED'});assert.equal(downloads,12);
  const entry=(await catalog(changed.archivePath)).find(row=>row.type==='object'),archive=join(root,'media-'+entry.id,'media.bin.age'),original=await readFile(archive),corrupt=Buffer.from(original);corrupt[corrupt.length-1]^=1;await writeFile(archive,corrupt);
  await assert.rejects(backupMediaCollection(options,undefined,handler),{code:'MEDIA_ARCHIVE_REUSE_INVALID'});assert.equal(downloads,12);assert.deepEqual(await readFile(archive),corrupt);await writeFile(archive,original);
  const index=join(root,'media-reuse-index');let selected:string|undefined;
  for(const file of await readdir(index)){const value=JSON.parse(await readFile(join(index,file),'utf8'));if(value.archiveId===entry.id)selected=join(index,file);}
  assert.ok(selected);await writeFile(selected!,JSON.stringify({format:'kavosh-media-reuse-pointer-v1',archiveId:'../../outside',version:'a'.repeat(64),recipient}));await assert.rejects(backupMediaCollection(options,undefined,handler),{code:'MEDIA_ARCHIVE_REUSE_INVALID'});assert.equal(downloads,12);
 }finally{await drive.close();await badDrive.close();await rm(root,{recursive:true,force:true});}
});
