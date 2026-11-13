import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,realpath,readFile,writeFile,readdir,unlink,rmdir,lstat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {Readable} from 'node:stream';
import {createHash} from 'node:crypto';
import {backupMediaObject} from '../src/operations/media-backups.ts';
import {r2TargetId} from '../src/integrations/r2-config.ts';
import {encryptRecoveryStream} from '../src/operations/database-backups.ts';
import {copyEncryptedBackupToDrive} from '../src/operations/drive-backups.ts';
import {driveBackupFixture} from './drive-backup-fixture.ts';

const run=promisify(execFile),academyId='aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa',fileId='bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb';
const configuration={accountId:'a'.repeat(32),jurisdiction:'default' as const,bucket:'synthetic-private-media',accessKeyId:'synthetic-read-only',secretAccessKey:'synthetic-secret-not-real',maximumUploadBytes:4194304};
test('media backup rejects missing configuration,wrong targets and pre-cancellation before storage access',async()=>{
 await assert.rejects(backupMediaObject({configuration}),{code:'INVALID_MEDIA_BACKUP_CONFIGURATION'});
 const input={configuration,academyId,fileId,stage:'clean',storageTargetId:'0'.repeat(64),bytes:42,etag:'"original"',modifiedAt:'2026-11-13T00:00:00Z',age:'/private/synthetic/age',recipient:'age1'+'q'.repeat(58),workDirectory:'/private/synthetic'};
 await assert.rejects(backupMediaObject(input),{code:'MEDIA_BACKUP_TARGET_MISMATCH'});
 await assert.rejects(backupMediaObject({...input,storageTargetId:r2TargetId(configuration)},AbortSignal.abort()),{code:'RECOVERY_CANCELLED'});
 const prefix=process.env.RECOVERY_COMPILED_CLI?[process.env.RECOVERY_COMPILED_CLI]:['--import','tsx','scripts/database-recovery.ts'];
 await assert.rejects(run(process.execPath,[...prefix,'backup-media',academyId,'clean',fileId,'a'.repeat(64),'42','"original"','2026-11-13T00:00:00Z'],{env:{PATH:process.env.PATH,NODE_ENV:'test',MEDIA_BACKUP_CONNECTION_JSON:'PRIVATE_MALFORMED_CONFIGURATION'},timeout:5000}),error=>{const r=error as Error&{stdout:string;stderr:string};assert.equal(r.stdout,'');assert.equal(r.stderr.trim(),'INVALID_MEDIA_BACKUP_CONFIGURATION');return true;});
});
test('actual age streaming media archives decrypt to the exact conditional source and reject changed or incomplete objects',{
 skip:!process.env.AGE_BIN||!process.env.AGE_KEYGEN_BIN
},async()=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'kavosh-media-test-'))),identity=join(root,'identity.txt'),source=Buffer.from('PRIVATE_SYNTHETIC_MEDIA_'.repeat(100000));
 const retained:string[]=[],drive=await driveBackupFixture();
 try{
  await run(process.env.AGE_KEYGEN_BIN!,['--output',identity]);const recipient=(await run(process.env.AGE_KEYGEN_BIN!,['-y',identity])).stdout.trim();
  const input={configuration,academyId,fileId,stage:'clean',storageTargetId:r2TargetId(configuration),bytes:source.length,etag:'"original"',modifiedAt:'2026-11-13T00:00:00Z',age:process.env.AGE_BIN,recipient,workDirectory:root};
  for(const stage of ['clean','quarantine'] as const){
   let calls=0;const result=await backupMediaObject({...input,stage},undefined,{async handle(request:{method:string;path:string;headers:Record<string,string>}){calls++;assert.equal(request.method,'GET');assert.equal(request.path,`/${configuration.bucket}/academies/${academyId}/${stage}/${fileId}`);assert.equal(request.headers['if-match'],'"original"');return{response:{statusCode:200,headers:{'content-length':String(source.length),'content-type':'application/octet-stream',etag:'"original"'},body:Readable.from([source.subarray(0,65536),source.subarray(65536)])}};},destroy(){}});
   retained.push(result.archivePath,join(dirname(result.archivePath),'manifest.json'));assert.equal(calls,1);assert.equal(result.completeMediaBackup,false);assert.equal(result.restoreVerified,false);assert.equal(result.source.sha256,createHash('sha256').update(source).digest('hex'));assert.equal(result.source.bytes,source.length);
   const cipher=await readFile(result.archivePath);assert.equal(cipher.includes(source.subarray(0,32)),false);assert.equal(result.archive.ciphertextSha256,createHash('sha256').update(cipher).digest('hex'));assert.equal((await lstat(result.archivePath)).mode&0o777,0o600);assert.equal((await lstat(dirname(result.archivePath))).mode&0o777,0o700);
   const offsite=await copyEncryptedBackupToDrive({...drive.input,kind:'media',backupId:result.id,archive:result.archivePath,expectedSha256:result.archive.ciphertextSha256,expectedBytes:result.archive.encryptedBytes});assert.equal(offsite.independentCopyVerified,true);assert.equal(offsite.scope,'one_encrypted_media_object_archive');
   const restored=await run(process.env.AGE_BIN!,['--decrypt','--identity',identity,drive.remoteFile('kavosh_backup:backup-'+result.id+'/media.bin.age')],{encoding:'buffer',maxBuffer:source.length+1});assert.deepEqual(restored.stdout,source);
   assert.doesNotMatch(await readFile(join(dirname(result.archivePath),'manifest.json'),'utf8'),/synthetic-secret|synthetic-read-only|PRIVATE_SYNTHETIC_MEDIA/);
  }
  for(const failure of ['etag','short','error']){
   const before=await readdir(root);await assert.rejects(backupMediaObject(input,undefined,{async handle(){if(failure==='error')throw Error('PRIVATE_PROVIDER_DIAGNOSTIC');return{response:{statusCode:200,headers:{'content-length':String(source.length),'content-type':'application/octet-stream',etag:failure==='etag'?'"changed"':'"original"'},body:Readable.from([source.subarray(0,source.length-1)])}};},destroy(){}}),error=>{assert.equal((error as {code:string}).code,'MEDIA_BACKUP_FAILED');assert.doesNotMatch(String(error),/PRIVATE_PROVIDER|synthetic-secret/);return true;});assert.deepEqual(await readdir(root),before);
  }
  const limited=join(root,'limited.age');await assert.rejects(encryptRecoveryStream({age:process.env.AGE_BIN,recipient,file:limited,maximumBytes:22},Readable.from([source]),AbortSignal.timeout(5000)),{code:'RECOVERY_SIZE_LIMIT'});await assert.rejects(lstat(limited),{code:'ENOENT'});
  const before=new Set(await readdir(root));let conflict:string|undefined;
  try{
   await assert.rejects(backupMediaObject(input,undefined,{async handle(){const folder=(await readdir(root)).find(name=>name.startsWith('media-')&&!before.has(name))!;conflict=join(root,folder,'media.bin.age');await writeFile(conflict,'KEEP_EXISTING_FILE',{flag:'wx',mode:0o600});return{response:{statusCode:200,headers:{'content-length':String(source.length),'content-type':'application/octet-stream',etag:'"original"'},body:Readable.from([source])}};},destroy(){}}),{code:'MEDIA_BACKUP_CLEANUP_REQUIRED'});
   assert.equal(await readFile(conflict!,'utf8'),'KEEP_EXISTING_FILE');
  }finally{if(conflict){await unlink(conflict);await rmdir(dirname(conflict));}}
 }finally{for(const file of retained)await unlink(file);for(const folder of new Set(retained.map(dirname)))await rmdir(folder);await unlink(identity).catch(()=>{});await rmdir(root);await drive.close();}
});
