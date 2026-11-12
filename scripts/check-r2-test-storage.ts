import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {S3Client,PutObjectCommand,DeleteObjectCommand,HeadObjectCommand} from '@aws-sdk/client-s3';
import {z} from 'zod';
import {privateR2} from '../src/integrations/r2.ts';
import {promoteQuarantinedFile} from '../src/integrations/r2-promotion.ts';

// Explicit local-only live check. No real people,production bucket,DB or env
// credential activation. Keys stay in Keychain/process memory;never log errors
// from the SDK or fetch,which may contain signed URLs or provider diagnostics.
let phase='configuration',checks=0,cleanupFailed=false;
const clients:S3Client[]=[],adapters:ReturnType<typeof privateR2>[]=[],cleanup:Array<{client:S3Client;bucket:string;key:string}>=[];
let uploadExpiresAt=0;
try{
 assert.deepEqual(process.argv.slice(2),['--execute']);assert.equal(process.platform,'darwin');
 const accountId=z.string().regex(/^[a-f0-9]{32}$/).parse(process.env.KAVOSH_R2_TEST_ACCOUNT_ID);
 const credentials=z.object({accessKeyId:z.string().regex(/^[a-f0-9]{32}$/),secretAccessKey:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
 const load=(service:string)=>{const raw=execFileSync('/usr/bin/security',['find-generic-password','-a','kavosh-one','-s',service,'-w'],{stdio:['ignore','pipe','pipe'],timeout:15000});try{return credentials.parse(JSON.parse(raw.toString()));}finally{raw.fill(0);}};
 const source={accountId,jurisdiction:'default' as const,bucket:'kavosh-one-test-quarantine',...load('kavosh-one-r2-test-quarantine'),maximumUploadBytes:1048576};
 const destination={...source,bucket:'kavosh-one-test-clean',...load('kavosh-one-r2-test-clean-writer')};
 const reader={...destination,...load('kavosh-one-r2-test-clean-reader')};
 assert.equal(new Set([source.accessKeyId,destination.accessKeyId,reader.accessKeyId]).size,3);
 const sdk=(config:typeof source)=>{const client=new S3Client({endpoint:`https://${accountId}.r2.cloudflarestorage.com`,region:'auto',forcePathStyle:true,followRegionRedirects:false,maxAttempts:1,credentials:{accessKeyId:config.accessKeyId,secretAccessKey:config.secretAccessKey},requestChecksumCalculation:'WHEN_REQUIRED',responseChecksumValidation:'WHEN_REQUIRED'});clients.push(client);return client;};
 const quarantineClient=sdk(source),cleanClient=sdk(destination),readerClient=sdk(reader);
 const academyId=randomUUID(),fileId=randomUUID(),probeId=randomUUID(),quarantineKey=`academies/${academyId}/quarantine/${fileId}`,cleanKey=`academies/${academyId}/clean/${fileId}`,probeKey=`academies/${academyId}/clean/${probeId}`;
 const quarantine=privateR2(source,academyId),clean=privateR2(reader,academyId);adapters.push(quarantine,clean);
 const bytes=Buffer.from('Kavosh One synthetic storage verification only. No student,teacher,parent,contract or financial data.\n'.repeat(8)),sha256=createHash('sha256').update(bytes).digest('hex');
 const send=(client:S3Client,command:PutObjectCommand|DeleteObjectCommand|HeadObjectCommand)=>client.send(command as HeadObjectCommand,{abortSignal:AbortSignal.timeout(10000)});
 const denied=async(action:()=>Promise<unknown>)=>{let status:unknown;try{await action();}catch(error){status=(error as {$metadata?:{httpStatusCode?:number}}).$metadata?.httpStatusCode;}assert.equal(status,403);checks++;};
 const request=(url:string,init:RequestInit={})=>fetch(url,{...init,redirect:'error',signal:AbortSignal.timeout(10000)});
 phase='signed upload';
 const upload=await quarantine.quarantineUpload(fileId,{contentType:'application/octet-stream',bytes:bytes.length},15);uploadExpiresAt=Date.parse(upload.expiresAt);
 cleanup.push({client:quarantineClient,bucket:source.bucket,key:quarantineKey},{client:cleanClient,bucket:destination.bucket,key:cleanKey},{client:cleanClient,bucket:destination.bucket,key:probeKey});
 const put=await request(upload.url,{method:'PUT',headers:upload.headers,body:bytes});assert.equal(put.status,200);await put.body?.cancel();checks++;
 phase='conditional overwrite refusal';const overwrite=await request(upload.url,{method:'PUT',headers:upload.headers,body:bytes});assert.equal(overwrite.status,412);await overwrite.body?.cancel();checks++;
 phase='quarantine byte verification';const original=await quarantine.inspectQuarantine(fileId,{bytes:bytes.length,sha256},async stream=>{for await(const _ of stream){}return true;},10000);assert.equal(original.sha256,sha256);checks++;
 phase='cross-bucket permissions';await denied(()=>send(quarantineClient,new HeadObjectCommand({Bucket:destination.bucket,Key:cleanKey})));await denied(()=>send(cleanClient,new HeadObjectCommand({Bucket:source.bucket,Key:quarantineKey})));await denied(()=>send(readerClient,new PutObjectCommand({Bucket:destination.bucket,Key:probeKey,Body:bytes,IfNoneMatch:'*'})));
 phase='private promotion';const input={academyId,fileId,storageTargetId:quarantine.storageTargetId,bytes:bytes.length,sha256};const promoted=await promoteQuarantinedFile(source,destination,input,{timeoutMs:15000});assert.equal(promoted.outcome,'written_verified');checks++;
 phase='idempotent promotion';assert.equal((await promoteQuarantinedFile(source,destination,input,{timeoutMs:15000})).outcome,'existing_verified');checks++;
 phase='read-only exact range';const range=await clean.inspectCleanRange(fileId,{bytes:bytes.length,ifMatch:promoted.destination.etag},{start:5,end:24},async stream=>{const parts:Buffer[]=[];for await(const part of stream)parts.push(part);return Buffer.concat(parts);},10000);assert.deepEqual(range.inspection,bytes.subarray(5,25));checks++;
 phase='private attachment download';const download=await clean.cleanDownload(fileId,30,{ifMatch:promoted.destination.etag});const response=await request(download.url,{headers:download.headers});assert.equal(response.status,200);assert.equal(response.headers.get('content-disposition'),'attachment');assert.equal(response.headers.get('cache-control'),'private, no-store');assert.deepEqual(Buffer.from(await response.arrayBuffer()),bytes);checks++;
 phase='anonymous read refusal';const anonymous=new URL(download.url);anonymous.search='';const publicRead=await request(anonymous.toString());assert.equal(publicRead.status,400);const anonymousError=await publicRead.text();assert.ok(anonymousError.length<1024);assert.match(anonymousError,/<Code>InvalidArgument<\/Code>/);assert.ok(!anonymousError.includes(bytes.toString()));checks++;
 phase='expired link refusal';const expired=await clean.cleanDownload(fileId,1);await delay(Math.max(0,Date.parse(expired.expiresAt)-Date.now()+1100));const stale=await request(expired.url);assert.equal(stale.status,403);await stale.body?.cancel();checks++;
 console.log(JSON.stringify({storage:'live_cloudflare_r2',checks,passed:true,syntheticBytes:bytes.length,privateBuckets:true,realPersonalDataUsed:false,scope:'storage adapters and provider permissions only;not full media scanning,backup recovery or production acceptance'}));
}catch{console.error(`R2_TEST_FAILED: ${phase}`);process.exitCode=1;}
finally{
 // A live upload grant must expire before its exact generated object is removed.
 if(cleanup.length)await delay(Math.max(0,uploadExpiresAt-Date.now()+1100));
 for(const item of cleanup){try{await item.client.send(new DeleteObjectCommand({Bucket:item.bucket,Key:item.key}),{abortSignal:AbortSignal.timeout(10000)});}catch{cleanupFailed=true;}}
 for(const adapter of adapters)adapter.close();for(const client of clients)client.destroy();
 if(cleanupFailed){console.error('R2_TEST_CLEANUP_FAILED');process.exitCode=1;}else if(cleanup.length)console.log('Exact generated test objects removed;no bucket or existing object deleted.');
}
