import assert from 'node:assert/strict';
import { createHash,randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { checkCopyDestination,type CopyCheckTask } from '../src/files/copy-check-worker.ts';

const bytes=Buffer.from('Synthetic private destination,never a real academy upload.'),hash=(b:Buffer)=>createHash('sha256').update(b).digest('hex');
const config={accountId:'a'.repeat(32),jurisdiction:'default' as const,bucket:'synthetic-read-only-destination',accessKeyId:'synthetic-read-only-key',secretAccessKey:'synthetic-not-real-read-only-secret',maximumUploadBytes:100000};
const task:CopyCheckTask={academyId:randomUUID(),copyId:randomUUID(),checkId:randomUUID(),fileId:randomUUID(),leaseToken:randomUUID(),attemptNo:1,sourceFingerprint:'b'.repeat(64),expectedBytes:bytes.length,expectedSha256:hash(bytes),destinationTargetId:hash(Buffer.from(JSON.stringify([config.accountId,config.jurisdiction,config.bucket])))};
function fixture(mode:'normal'|'hash'|'size'|'missing'|'denied'|'network'|'hang'='normal'){
 let reads=0,destroyed=0,observed!:(v:void)=>void;const seen=new Promise<void>(resolve=>{observed=resolve;});
 const handler={destroy(){destroyed++;},async handle(r:{method:string;hostname:string;path:string;headers:Record<string,string>}){
  reads++;observed();assert.equal(r.method,'GET','reconciliation must not send PUT,DELETE,HEAD or quarantine requests');assert.equal(r.hostname,config.accountId+'.r2.cloudflarestorage.com');assert.equal(r.path,`/${config.bucket}/academies/${task.academyId}/clean/${task.fileId}`);assert.match(r.headers.authorization,/Credential=synthetic-read-only-key\//);
  if(mode==='hang')return new Promise<never>(()=>{});if(mode==='network')throw Error('PRIVATE provider error');
  if(mode==='missing'||mode==='denied')return {response:{statusCode:mode==='missing'?404:403,headers:{'content-type':'application/xml'},body:Readable.from(['<Error><Code>NoSuchKey</Code><Message>PRIVATE diagnostic</Message></Error>'])}};
  const b=Buffer.from(bytes);if(mode==='hash')b[0]^=1;return {response:{statusCode:200,headers:{etag:'"same-opaque-etag-not-proof"','content-type':'application/octet-stream','content-length':String(mode==='size'?b.length+1:b.length)},body:Readable.from([b.subarray(0,7),b.subarray(7)])}};
 }};return {seen,counts:()=>({reads,destroyed}),run:(signal=new AbortController().signal,timeoutMs=10000)=>checkCopyDestination(task,config,signal,timeoutMs,handler),handler};
}
test('destination reconciliation uses exactly one GET and independently verifies complete bytes/hash without source credentials or a write',async()=>{
 const f=fixture(),r=await f.run();assert.deepEqual(r,{outcome:'verified',bytes:bytes.length,sha256:hash(bytes),destination:{storageTargetId:task.destinationTargetId,etag:'"same-opaque-etag-not-proof"'}});assert.deepEqual(f.counts(),{reads:1,destroyed:1});assert.doesNotMatch(JSON.stringify(r),/download|sourceTargetId|credentials|read-only-key|secret/i);
});
test('matching ETags cannot conceal changed destination bytes or incorrect length',async()=>{
 for(const mode of ['hash','size'] as const){const f=fixture(mode);assert.deepEqual(await f.run(),{outcome:'mismatch'});assert.equal(f.counts().reads,1);}
});
test('negative reads and network failure stay unavailable,never absence finality or a follow-up write',async()=>{
 for(const mode of ['missing','denied','network'] as const){const f=fixture(mode);assert.deepEqual(await f.run(),{outcome:'unavailable'});assert.equal(f.counts().reads,1);}
});
test('invalid target,claims,missing configuration and pre-cancelled requests make no provider call',async()=>{
 const f=fixture();for(const t of [{...task,destinationTargetId:'0'.repeat(64)},{...task,fileId:'../escape'},{...task,expectedBytes:33554433},{...task,downloadAuthorized:true}])assert.deepEqual(await checkCopyDestination(t,config,new AbortController().signal,10000,f.handler),{outcome:'unavailable'});
 assert.deepEqual(await checkCopyDestination(task,null,new AbortController().signal,10000,f.handler),{outcome:'unavailable'});const c=new AbortController();c.abort();assert.deepEqual(await f.run(c.signal),{outcome:'unavailable'});assert.equal(f.counts().reads,0);
});
test('a short actual cancellation aborts the read without treating interrupted IO as a successful or absent copy',async()=>{
 const c=new AbortController(),f=fixture('hang'),pending=f.run(c.signal);await f.seen;c.abort();assert.deepEqual(await pending,{outcome:'unavailable'});assert.deepEqual(f.counts(),{reads:1,destroyed:1});
});
