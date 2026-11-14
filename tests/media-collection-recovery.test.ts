import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,realpath,mkdir,readFile,readdir,rm,writeFile,rename} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {Readable} from 'node:stream';
import {createHash} from 'node:crypto';
import {backupMediaCollection} from '../src/operations/media-backups.ts';
import {recoverMediaCollection} from '../src/operations/media-collection-recovery.ts';
import {encryptRecoveryStream} from '../src/operations/database-backups.ts';

const run=promisify(execFile),academyId='aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa',fileId='bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb';
test('collection recovery rejects malformed input before file access',async()=>{await assert.rejects(recoverMediaCollection({}),{code:'INVALID_MEDIA_COLLECTION_RECOVERY'});});
test('real encrypted collection recovery validates all metadata before extraction and rejects scope,totals,truncation and object corruption',{
 skip:!process.env.AGE_BIN||!process.env.AGE_KEYGEN_BIN
},async()=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'kavosh-collection-recovery-test-'))),identity=join(root,'identity.txt'),backups=join(root,'backups'),recovery=join(root,'recovery'),source=Buffer.from('PRIVATE_COLLECTION_RECOVERY_MEDIA');
 try{
  await mkdir(backups,{mode:0o700});await mkdir(recovery,{mode:0o700});await run(process.env.AGE_KEYGEN_BIN!,['--output',identity]);const recipient=(await run(process.env.AGE_KEYGEN_BIN!,['-y',identity])).stdout.trim();
  const configuration={accountId:'a'.repeat(32),jurisdiction:'default',bucket:'synthetic-media-recovery',accessKeyId:'synthetic-reader',secretAccessKey:'synthetic-secret-not-real',maximumUploadBytes:4194304};
  const backup=await backupMediaCollection({academyId,age:process.env.AGE_BIN,recipient,workDirectory:backups,targets:[{stage:'quarantine',configuration},{stage:'clean',configuration}]},undefined,()=>({async handle(request:{query?:Record<string,unknown>;path:string}){
   if(request.query?.['list-type']==='2'){
    const prefix=String(request.query.prefix),body=`<ListBucketResult><Name>${configuration.bucket}</Name><Prefix>${prefix}</Prefix><KeyCount>1</KeyCount><IsTruncated>false</IsTruncated><Contents><Key>${prefix}${fileId}</Key><ETag>&quot;original&quot;</ETag><Size>${source.length}</Size><LastModified>2026-11-13T00:00:00Z</LastModified></Contents></ListBucketResult>`;return{response:{statusCode:200,headers:{},body:Readable.from([body])}};
   }
   return{response:{statusCode:200,headers:{'content-length':String(source.length),etag:'"original"','content-type':'application/octet-stream'},body:Readable.from([source])}};
  },destroy(){}}));
  const options={age:process.env.AGE_BIN,identityFile:identity,archive:backup.archivePath,archiveDirectory:backups,workDirectory:recovery,academyId,collectionId:backup.id,expectedSha256:backup.catalog.ciphertextSha256,expectedBytes:backup.catalog.encryptedBytes};
  await assert.rejects(recoverMediaCollection(options,AbortSignal.abort()),{code:'RECOVERY_CANCELLED'});
  const result=await recoverMediaCollection(options),journal=(await readFile(result.journal,'utf8')).trim().split('\n').map(line=>JSON.parse(line));assert.equal(result.recoveredObjects,2);assert.equal(result.sourceBytes,source.length*2);assert.equal(result.allCatalogObjectsRecovered,true);assert.equal(result.applicationActivationAllowed,false);assert.equal(result.completeMediaRestore,false);assert.equal(journal.at(-1).type,'complete');assert.doesNotMatch(JSON.stringify(journal),/PRIVATE_COLLECTION_RECOVERY_MEDIA|AGE-SECRET/);
  for(const entry of journal.filter(row=>row.type==='object')){assert.deepEqual(await readFile(entry.file),source);assert.equal(entry.source.academyId,academyId);assert.equal(entry.source.sha256,createHash('sha256').update(source).digest('hex'));}assert.ok(!(await readdir(dirname(result.journal))).includes('catalog.jsonl'));
  if(process.env.RECOVERY_COMPILED_CLI){const command=await run(process.execPath,[process.env.RECOVERY_COMPILED_CLI,'recover-media-collection',academyId,backup.id,backup.archivePath,options.expectedSha256,String(options.expectedBytes)],{env:{PATH:process.env.PATH,NODE_ENV:'test',AGE_BIN:process.env.AGE_BIN,RESTORE_AGE_IDENTITY_FILE:identity,RECOVERY_WORK_DIRECTORY:recovery,MEDIA_RECOVERY_ARCHIVE_DIRECTORY:backups},timeout:10000});assert.equal(command.stderr,'');const received=JSON.parse(command.stdout);assert.equal(received.allCatalogObjectsRecovered,true);assert.equal(received.recoveredObjects,2);assert.equal(received.applicationActivationAllowed,false);assert.doesNotMatch(command.stdout,/AGE-SECRET|PRIVATE_COLLECTION_RECOVERY_MEDIA/);}
  const catalog=(await run(process.env.AGE_BIN!,['--decrypt','--identity',identity,backup.archivePath])).stdout.trim().split('\n').map(line=>JSON.parse(line));
  for(const mode of ['legacy-order','empty']){
   let rows=structuredClone(catalog);
   if(mode==='legacy-order'){rows[0].targets.reverse();rows=[rows[0],...rows.slice(1,-1).reverse(),rows.at(-1)];rows.at(-1).inventories.reverse();}
   else{rows=[rows[0],{...rows.at(-1),objects:0,sourceBytes:0,inventories:rows.at(-1).inventories.map((t:Record<string,unknown>)=>({...t,objects:0,bytes:0,sha256:createHash('sha256').digest('hex')}))}];}
   const archive=join(root,mode+'.age'),encrypted=await encryptRecoveryStream({age:process.env.AGE_BIN,recipient,file:archive,maximumBytes:65536},Readable.from([rows.map(row=>JSON.stringify(row)+'\n').join('')]),AbortSignal.timeout(10000));
   const restored=await recoverMediaCollection({...options,archive,expectedBytes:encrypted.encryptedBytes,expectedSha256:encrypted.ciphertextSha256,...mode==='empty'?{maximumObjects:0}:{}});assert.equal(restored.recoveredObjects,mode==='empty'?0:2);assert.equal(restored.allCatalogObjectsRecovered,true);
  }
  const prior=await readdir(recovery);
  for(const mode of ['school','target','duplicate-target','duplicate','truncated','totals','inventory','trailing','limit','unsafe-filename']){
   const rows=structuredClone(catalog);
   if(mode==='school')rows[1].source.academyId='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
   if(mode==='target')rows[1].source.storageTargetId='0'.repeat(64);
   if(mode==='duplicate-target')rows[0].targets.push(rows[0].targets[0]);
   if(mode==='unsafe-filename')rows[1].archive.filename='../outside.age';
   if(mode==='duplicate')rows.splice(2,0,rows[1]);if(mode==='truncated')rows.pop();if(mode==='totals')rows.at(-1).sourceBytes++;if(mode==='inventory')rows.at(-1).inventories[0].sha256='0'.repeat(64);if(mode==='trailing')rows.push(rows.at(-1));
   const archive=join(root,mode+'.age'),encrypted=await encryptRecoveryStream({age:process.env.AGE_BIN,recipient,file:archive,maximumBytes:65536},Readable.from([rows.map(row=>JSON.stringify(row)+'\n').join('')]),AbortSignal.timeout(10000));
   await assert.rejects(recoverMediaCollection({...options,archive,expectedBytes:encrypted.encryptedBytes,expectedSha256:encrypted.ciphertextSha256,...mode==='limit'?{maximumObjects:1}:{}}));assert.deepEqual(await readdir(recovery),prior);
  }
  const last=catalog.at(-2),objectFile=join(backups,'media-'+last.id,'media.bin.age'),original=await readFile(objectFile);await writeFile(objectFile,Buffer.alloc(original.length));
  await assert.rejects(recoverMediaCollection(options),{code:'BACKUP_DIGEST_MISMATCH'});await writeFile(objectFile,original);
  const partial=(await readdir(recovery)).find(name=>!prior.includes(name))!;assert.ok(partial);const partialJournal=await readFile(join(recovery,partial,'recovered.jsonl'),'utf8');assert.equal(partialJournal.trim().split('\n').length,2);assert.ok(!partialJournal.includes('"type":"complete"'));const entry=JSON.parse(partialJournal.trim().split('\n')[1]);assert.deepEqual(await readFile(entry.file),source);
  const first=catalog[1],directory=join(backups,'media-'+first.id),saved=directory+'.saved';await rename(directory,saved);try{await assert.rejects(recoverMediaCollection(options),{code:'MEDIA_COLLECTION_RECOVERY_FAILED'});}finally{await rename(saved,directory);}assert.equal((await readdir(recovery)).length,prior.length+1);
 }finally{await rm(root,{recursive:true,force:true});}
});
