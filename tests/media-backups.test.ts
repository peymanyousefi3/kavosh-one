import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,mkdir,realpath,readFile,writeFile,readdir,unlink,rmdir,lstat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {Readable} from 'node:stream';
import {createHash} from 'node:crypto';
import {backupMediaObject,backupMediaCollection} from '../src/operations/media-backups.ts';
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
 await assert.rejects(run(process.execPath,[...prefix,'backup-media-collection',academyId],{env:{PATH:process.env.PATH,NODE_ENV:'test',MEDIA_BACKUP_TARGETS_JSON:'PRIVATE_MALFORMED_CONFIGURATION'},timeout:5000}),error=>{const r=error as Error&{stdout:string;stderr:string};assert.equal(r.stdout,'');assert.equal(r.stderr.trim(),'INVALID_MEDIA_COLLECTION_CONFIGURATION');return true;});
 const collection={academyId,age:input.age,recipient:input.recipient,workDirectory:input.workDirectory,targets:[{stage:'clean',configuration}]};
 await assert.rejects(backupMediaCollection({...collection,targets:[...collection.targets,...collection.targets]}),{code:'INVALID_MEDIA_COLLECTION_CONFIGURATION'});await assert.rejects(backupMediaCollection(collection,AbortSignal.abort()),{code:'RECOVERY_CANCELLED'});
 const work=await realpath(await mkdtemp(join(tmpdir(),'kavosh-collection-setup-test-')));let created=0,closed=0;
 try{await assert.rejects(backupMediaCollection({...collection,workDirectory:work,targets:[...collection.targets,{stage:'quarantine',configuration}]},undefined,()=>{if(created++)throw Error('PRIVATE_CONFIGURATION_FAILURE');return{async handle(){assert.fail('NO_STORAGE_ACCESS');},destroy(){closed++;}};}),{code:'MEDIA_COLLECTION_FAILED'});assert.equal(closed,1);assert.deepEqual(await readdir(work),[]);}finally{await rmdir(work);}
});
test('encrypted collection catalogs stream paginated targets,verify copied objects and reject concurrent inventory changes',{
 skip:!process.env.AGE_BIN||!process.env.AGE_KEYGEN_BIN
},async()=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'kavosh-collection-test-'))),identity=join(root,'identity.txt'),drive=await driveBackupFixture(),secondId='cccccccc-cccc-4ccc-8ccc-cccccccccccc',extraId='dddddddd-dddd-4ddd-8ddd-dddddddddddd',bytes=Buffer.from('PRIVATE_COLLECTION_MEDIA');
 const workspaces:string[]=[],failedDrive=await driveBackupFixture('catalog-error');
 async function cleanWork(path:string){for(const name of await readdir(path)){assert.match(name,/^media-(?:collection-)?[a-f0-9-]{36}$/);const folder=join(path,name);for(const file of await readdir(folder)){assert.ok(['manifest.json','media.bin.age','catalog.jsonl.age'].includes(file));await unlink(join(folder,file));}await rmdir(folder);}await rmdir(path);}
 try{
  await run(process.env.AGE_KEYGEN_BIN!,['--output',identity]);const recipient=(await run(process.env.AGE_KEYGEN_BIN!,['-y',identity])).stdout.trim();
  const targets=[{stage:'clean' as const,configuration},{stage:'quarantine' as const,configuration:{...configuration,bucket:'synthetic-private-intake'}}];
  for(const scenario of ['normal','empty','added','removed','changed','duplicate-page','catalog-limit','catalog-offsite-error']){
   const work=join(root,scenario);await mkdir(work,{mode:0o700});workspaces.push(work);
   const scans=new Map<string,number>();let clients=0,closed=0;
   const selectedDrive=scenario==='catalog-offsite-error'?failedDrive:drive;
   const pending=backupMediaCollection({academyId,age:process.env.AGE_BIN,recipient,workDirectory:work,targets:scenario==='normal'?targets:targets.slice(0,1),...['normal','catalog-offsite-error'].includes(scenario)?{offsite:{rclone:selectedDrive.input.rclone,drive:selectedDrive.input.drive}}:{},...(scenario==='catalog-limit'?{maximumCatalogBytes:1024}:{})},undefined,targetId=>{
    clients++;const target=targets.find(t=>r2TargetId(t.configuration)===targetId)!;
    return{async handle(request:{method:string;path:string;query?:Record<string,unknown>;headers:Record<string,string>}){
     assert.equal(request.method,'GET');const prefix=`academies/${academyId}/${target.stage}/`;
     if(request.query?.['list-type']==='2'){
      const scan=scans.get(targetId)??0;if(!request.query?.['continuation-token'])scans.set(targetId,scan+1);
      const final=(scans.get(targetId)??0)>1,pageTwo=request.query?.['continuation-token']!==undefined;
      const ids=scenario==='empty'?[]:pageTwo?(scenario==='removed'&&final?[]:[scenario==='duplicate-page'?fileId:secondId,...scenario==='added'&&final?[extraId]:[]]):[fileId],truncated=scenario!=='empty'&&!pageTwo;
      const body=`<ListBucketResult><Name>${target.configuration.bucket}</Name><Prefix>${prefix}</Prefix><KeyCount>${ids.length}</KeyCount><IsTruncated>${truncated}</IsTruncated>${truncated?'<NextContinuationToken>page-two</NextContinuationToken>':''}${ids.map(id=>`<Contents><Key>${prefix}${id}</Key><ETag>&quot;${scenario==='changed'&&final?'changed':'original'}&quot;</ETag><Size>${bytes.length}</Size><LastModified>2026-11-13T00:00:00Z</LastModified></Contents>`).join('')}</ListBucketResult>`;
      return{response:{statusCode:200,headers:{},body:Readable.from([body])}};
     }
     assert.equal(request.headers['if-match'],'"original"');assert.ok(request.path.endsWith(fileId)||request.path.endsWith(secondId));return{response:{statusCode:200,headers:{'content-length':String(bytes.length),'content-type':'application/octet-stream',etag:'"original"'},body:Readable.from([bytes])}};
    },destroy(){closed++;}};
   });
   if(scenario==='normal'||scenario==='empty'){
    const count=scenario==='empty'?0:4,result=await pending;assert.equal(result.objects,count);assert.equal(result.sourceBytes,bytes.length*count);assert.equal(result.allArchivesIndependentlyCopied,scenario==='normal');assert.equal(result.completeMediaBackup,false);assert.equal(result.databaseReferencesVerified,false);assert.equal(result.atomicStorageSnapshot,false);
    const remote=scenario==='empty'?result.archivePath:drive.remoteFile('kavosh_backup:backup-'+result.id+'/catalog.jsonl.age'),clear=(await run(process.env.AGE_BIN!,['--decrypt','--identity',identity,remote])).stdout,lines=clear.trim().split('\n').map(line=>JSON.parse(line));
    assert.equal(lines[0].type,'header');assert.equal(lines.at(-1).type,'complete');assert.equal(lines.at(-1).matchingFinalInventory,true);assert.equal(lines.filter(line=>line.type==='object').length,count);assert.doesNotMatch(clear,/synthetic-secret|synthetic-read-only|PRIVATE_COLLECTION_MEDIA/);
    for(const entry of lines.filter(line=>line.type==='object')){assert.equal(entry.offsite.independentCopyVerified,true);const restored=await run(process.env.AGE_BIN!,['--decrypt','--identity',identity,drive.remoteFile('kavosh_backup:backup-'+entry.id+'/media.bin.age')],{encoding:'buffer'});assert.deepEqual(restored.stdout,bytes);assert.equal(entry.source.sha256,createHash('sha256').update(bytes).digest('hex'));}
    assert.ok(!(await readdir(dirname(result.archivePath))).includes('catalog.partial.jsonl'));assert.equal(clients,scenario==='normal'?2:1);
   }else if(scenario==='catalog-offsite-error'){
    await assert.rejects(pending,{code:'DRIVE_BACKUP_COPY_UNVERIFIED'});const retained=(await readdir(work)).find(name=>name.startsWith('media-collection-'))!;assert.ok(retained);const manifest=JSON.parse(await readFile(join(work,retained,'manifest.json'),'utf8'));assert.equal(manifest.allInventoriedObjectsArchived,true);assert.equal(manifest.allArchivesIndependentlyCopied,false);assert.equal(manifest.offsite,null);assert.equal(manifest.restoreVerified,false);assert.equal((await readFile(join(work,retained,'catalog.jsonl.age'))).subarray(0,22).toString(),'age-encryption.org/v1\n');assert.ok(!(await readdir(join(work,retained))).includes('catalog.partial.jsonl'));
   }else{
    await assert.rejects(pending,error=>{const code=(error as {code:string}).code;assert.equal(code,scenario==='duplicate-page'?'MEDIA_INVENTORY_ORDER_INVALID':scenario==='catalog-limit'?'MEDIA_CATALOG_SIZE_LIMIT':'MEDIA_COLLECTION_SOURCE_CHANGED');assert.doesNotMatch(String(error),/PRIVATE_COLLECTION|synthetic-secret/);return true;});assert.ok((await readdir(work)).every(name=>!name.startsWith('media-collection-')));
   }
   assert.equal(closed,clients);
  }
 }finally{for(const work of workspaces)await cleanWork(work);await unlink(identity).catch(()=>{});await rmdir(root);await drive.close();await failedDrive.close();}
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
