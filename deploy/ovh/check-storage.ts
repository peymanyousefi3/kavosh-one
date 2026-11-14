import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {mkdtemp,realpath,readdir,lstat,unlink,rmdir} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {S3Client,HeadObjectCommand,PutObjectCommand,DeleteObjectCommand} from '@aws-sdk/client-s3';
import {r2Connection} from '../../src/integrations/r2-config.ts';
import {privateR2} from '../../src/integrations/r2.ts';
import {promoteQuarantinedFile} from '../../src/integrations/r2-promotion.ts';
import {backupMediaCollection} from '../../src/operations/media-backups.ts';

// Explicit VPS-only check of the four production storage credentials. Uses
// tiny synthetic objects in a newly generated namespace,never academy records.
let phase='configuration',checks=0,uploadExpiry=0,cleanupFailed=false;
let mediaWork:string|undefined,mediaProof:{id:string;ciphertextSha256:string;encryptedBytes:number;objects:number;allArchivesIndependentlyCopied:boolean;reusedObjects:number;newObjectArchives:number}|null=null;
const clients:S3Client[]=[],adapters:ReturnType<typeof privateR2>[]=[],owned:Array<{client:S3Client;bucket:string;key:string}>=[];
try{
 const args=process.argv.slice(2),incremental=args.length===2&&args[1]==='--media-incremental',withMedia=incremental||args.length===2&&args[1]==='--media-backup';assert.deepEqual(args,withMedia?['--execute',incremental?'--media-incremental':'--media-backup']:['--execute']);assert.equal(process.getuid?.(),0);assert.notEqual(process.env.NODE_TLS_REJECT_UNAUTHORIZED,'0');
 const load=(role:string)=>r2Connection.parse(JSON.parse(readFileSync('/etc/kavosh-one/r2-'+role+'.json','utf8')));
 const upload=load('upload'),scan=load('scan'),writer=load('promote'),download=load('download');
 assert.equal(new Set([upload,scan,writer,download].map(x=>x.accessKeyId)).size,4);
 for(const c of [upload,scan,writer,download])assert.equal(c.accountId,'e7bedfa4c49de9507c44d118e5b20dc9');
 for(const c of [upload,scan])assert.equal(c.bucket,'kavosh-one-production-quarantine');for(const c of [writer,download])assert.equal(c.bucket,'kavosh-one-production-clean');
 const sdk=(c:typeof upload)=>{const client=new S3Client({endpoint:'https://'+c.accountId+'.r2.cloudflarestorage.com',region:'auto',forcePathStyle:true,followRegionRedirects:false,maxAttempts:1,credentials:{accessKeyId:c.accessKeyId,secretAccessKey:c.secretAccessKey},requestChecksumCalculation:'WHEN_REQUIRED',responseChecksumValidation:'WHEN_REQUIRED'});clients.push(client);return client;};
 const uploader=sdk(upload),scanner=sdk(scan),promoter=sdk(writer),reader=sdk(download);
 const academy=randomUUID(),file=randomUUID(),probe=randomUUID(),quarantineKey=`academies/${academy}/quarantine/${file}`,cleanKey=`academies/${academy}/clean/${file}`,quarantineProbe=`academies/${academy}/quarantine/${probe}`,cleanProbe=`academies/${academy}/clean/${probe}`;
 const source=privateR2(upload,academy),inspection=privateR2(scan,academy),clean=privateR2(download,academy);adapters.push(source,inspection,clean);
 const bytes=Buffer.from('Kavosh One production storage verification. Synthetic bytes only;no personal or financial data.\n'.repeat(8)),sha256=createHash('sha256').update(bytes).digest('hex');
 const send=(client:S3Client,command:HeadObjectCommand|PutObjectCommand|DeleteObjectCommand)=>client.send(command as HeadObjectCommand,{abortSignal:AbortSignal.timeout(10000)});
 const denied=async(action:()=>Promise<unknown>,unexpectedWrite?:{client:S3Client;bucket:string;key:string})=>{let status:unknown;try{await action();if(unexpectedWrite)owned.push(unexpectedWrite);}catch(error){status=(error as {$metadata?:{httpStatusCode?:number}}).$metadata?.httpStatusCode;}assert.equal(status,403);checks++;};
 const request=(url:string,init:RequestInit={})=>fetch(url,{...init,redirect:'error',signal:AbortSignal.timeout(10000)});
 phase='signed conditional upload';const grant=await source.quarantineUpload(file,{contentType:'application/octet-stream',bytes:bytes.length},10);uploadExpiry=Date.parse(grant.expiresAt);
 const first=await request(grant.url,{method:'PUT',headers:grant.headers,body:bytes});assert.equal(first.status,200);await first.body?.cancel();owned.push({client:uploader,bucket:upload.bucket,key:quarantineKey});checks++;
 phase='overwrite refusal';const again=await request(grant.url,{method:'PUT',headers:grant.headers,body:bytes});assert.equal(again.status,412);await again.body?.cancel();checks++;
 phase='read-only scanner exact source bytes';assert.equal((await inspection.inspectQuarantine(file,{bytes:bytes.length,sha256},async stream=>{for await(const _ of stream){}return true;},10000)).sha256,sha256);checks++;
 phase='scanner write denial';await denied(()=>send(scanner,new PutObjectCommand({Bucket:scan.bucket,Key:quarantineProbe,Body:bytes,IfNoneMatch:'*'})),{client:uploader,bucket:upload.bucket,key:quarantineProbe});
 phase='bucket separation';await denied(()=>send(uploader,new HeadObjectCommand({Bucket:writer.bucket,Key:cleanKey})));await denied(()=>send(promoter,new HeadObjectCommand({Bucket:scan.bucket,Key:quarantineKey})));await denied(()=>send(reader,new HeadObjectCommand({Bucket:scan.bucket,Key:quarantineKey})));
 phase='verified private promotion';const input={academyId:academy,fileId:file,storageTargetId:source.storageTargetId,bytes:bytes.length,sha256},promoted=await promoteQuarantinedFile(scan,writer,input,{timeoutMs:15000});assert.equal(promoted.outcome,'written_verified');owned.push({client:promoter,bucket:writer.bucket,key:cleanKey});checks++;
 phase='idempotent promotion';assert.equal((await promoteQuarantinedFile(scan,writer,input,{timeoutMs:15000})).outcome,'existing_verified');checks++;
 phase='read-only backup inventory';
 for(const [adapter,stage,etag]of [[inspection,'quarantine',promoted.source.etag],[clean,'clean',promoted.destination.etag]] as const){
  const inventory=await adapter.mediaInventoryPage(stage,undefined,1);assert.equal(inventory.nextContinuationToken,null);assert.equal(inventory.completeBackup,false);assert.equal(inventory.objects.length,1);assert.equal(inventory.objects[0].fileId,file);assert.equal(inventory.objects[0].bytes,bytes.length);assert.equal(inventory.objects[0].etag,etag);checks++;
 }
 phase='download write denial';await denied(()=>send(reader,new PutObjectCommand({Bucket:download.bucket,Key:cleanProbe,Body:bytes,IfNoneMatch:'*'})),{client:promoter,bucket:writer.bucket,key:cleanProbe});
 phase='conditional byte range';const range=await clean.inspectCleanRange(file,{bytes:bytes.length,ifMatch:promoted.destination.etag},{start:5,end:24},async stream=>{const chunks:Buffer[]=[];for await(const chunk of stream)chunks.push(chunk);return Buffer.concat(chunks);},10000);assert.deepEqual(range.inspection,bytes.subarray(5,25));checks++;
 phase='private download';const link=await clean.cleanDownload(file,15,{ifMatch:promoted.destination.etag}),response=await request(link.url,{headers:link.headers});assert.equal(response.status,200);assert.equal(response.headers.get('content-disposition'),'attachment');assert.equal(response.headers.get('cache-control'),'private, no-store');assert.deepEqual(Buffer.from(await response.arrayBuffer()),bytes);checks++;
 phase='anonymous denial';const anonymous=new URL(link.url);anonymous.search='';const unsigned=await request(anonymous.toString());assert.equal(unsigned.status,400);assert.match(await unsigned.text(),/<Code>InvalidArgument<\/Code>/);checks++;
 phase='expired link denial';const short=await clean.cleanDownload(file,1);await delay(Math.max(0,Date.parse(short.expiresAt)-Date.now()+1100));const expired=await request(short.url);assert.equal(expired.status,403);await expired.body?.cancel();checks++;
 if(withMedia){
  phase='synthetic encrypted media collection and Drive readbacks';assert.ok(process.env.CREDENTIALS_DIRECTORY);const connection=readFileSync(join(process.env.CREDENTIALS_DIRECTORY,'drive.json'),'utf8');assert.ok(Buffer.byteLength(connection)<=65536);mediaWork=await realpath(await mkdtemp('/tmp/kavosh-media-storage-probe-'));
  const options={academyId:academy,targets:[{stage:'quarantine',configuration:scan},{stage:'clean',configuration:download}],age:process.env.AGE_BIN,recipient:process.env.BACKUP_AGE_RECIPIENT,workDirectory:mediaWork,timeoutMs:120000,reuseExistingArchives:incremental,offsite:{rclone:process.env.RCLONE_BIN,drive:JSON.parse(connection)}};
  let collection=await backupMediaCollection(options);
  assert.equal(collection.objects,2);assert.equal(collection.sourceBytes,bytes.length*2);assert.equal(collection.matchingFinalInventory,true);assert.equal(collection.allArchivesIndependentlyCopied,true);assert.equal(collection.databaseReferencesVerified,false);assert.equal(collection.completeMediaBackup,false);
  if(incremental){
   assert.equal(collection.reusedObjects,0);assert.equal(collection.newObjectArchives,2);phase='second collection verified incremental reuse and Drive readbacks';collection=await backupMediaCollection(options);
   assert.equal(collection.objects,2);assert.equal(collection.sourceBytes,bytes.length*2);assert.equal(collection.reusedObjects,2);assert.equal(collection.newObjectArchives,0);assert.equal(collection.allArchivesIndependentlyCopied,true);assert.equal(collection.matchingFinalInventory,true);assert.equal(collection.databaseReferencesVerified,false);assert.equal(collection.completeMediaBackup,false);checks++;
  }
  mediaProof={id:collection.id,ciphertextSha256:collection.catalog.ciphertextSha256,encryptedBytes:collection.catalog.encryptedBytes,objects:collection.objects,allArchivesIndependentlyCopied:collection.allArchivesIndependentlyCopied,reusedObjects:collection.reusedObjects,newObjectArchives:collection.newObjectArchives};checks++;
 }
 console.log(JSON.stringify({executedOnVps:true,liveProviderChecks:checks,passed:true,syntheticBytes:bytes.length,separateCredentials:4,scannerReadOnlyVerified:true,downloadReadOnlyVerified:true,bucketIsolationVerified:true,privateConditionalUploadAndPromotionVerified:true,quarantineAndCleanReadOnlyInventoryVerified:true,syntheticMediaCollection:mediaProof,mediaBackupVerified:false,realPersonalDataUsed:false,antivirusEngineVerified:false,browserCorsVerified:false,applicationMediaWorkflowActivated:false}));
}catch{console.error('PRODUCTION_STORAGE_CHECK_FAILED: '+phase);process.exitCode=1;}
finally{
 if(owned.length)await delay(Math.max(0,uploadExpiry-Date.now()+1100));
 for(const x of owned)try{await x.client.send(new DeleteObjectCommand({Bucket:x.bucket,Key:x.key}),{abortSignal:AbortSignal.timeout(10000)});}catch{cleanupFailed=true;}
 for(const a of adapters)a.close();for(const c of clients)c.destroy();
 if(mediaWork)try{for(const name of await readdir(mediaWork)){assert.ok(name==='media-reuse-index'||/^media-(?:collection-)?[a-f0-9-]{36}$/.test(name));const folder=join(mediaWork,name),stat=await lstat(folder);assert.ok(stat.isDirectory()&&!stat.isSymbolicLink()&&stat.uid===process.getuid?.());for(const file of await readdir(folder)){assert.ok(name==='media-reuse-index'?/^[a-f0-9]{64}\.json$/.test(file):['manifest.json','media.bin.age','catalog.jsonl.age'].includes(file));const path=join(folder,file),s=await lstat(path);assert.ok(s.isFile()&&!s.isSymbolicLink()&&s.nlink===1&&s.uid===process.getuid?.());await unlink(path);}await rmdir(folder);}await rmdir(mediaWork);}catch{cleanupFailed=true;}
 if(cleanupFailed){console.error('SYNTHETIC_STORAGE_CLEANUP_REQUIRED');process.exitCode=1;}else if(owned.length)console.log('Exact generated synthetic objects removed;no existing file or bucket deleted.');
}
