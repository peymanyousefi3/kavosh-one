import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { createServer,request as httpRequest } from 'node:http';
import { test } from 'node:test';
import { promoteQuarantinedFile } from '../src/integrations/r2-promotion.ts';

const academy='8fbe4060-32ec-46a9-a97d-78ea54fe50e6',file='73e6a708-ad23-484b-9b12-91db85854593',content=Buffer.from('Synthetic transport bytes,not a real academy upload.');
const hash=(b:Buffer)=>createHash('sha256').update(b).digest('hex');
const source={accountId:'a'.repeat(32),jurisdiction:'default' as const,bucket:'synthetic-quarantine',accessKeyId:'synthetic-source-id',secretAccessKey:'synthetic-source-not-real-secret',maximumUploadBytes:1_000_000};
const destination={...source,bucket:'synthetic-clean',accessKeyId:'synthetic-clean-id',secretAccessKey:'synthetic-clean-not-real-secret'};
const target=(c:typeof source)=>hash(Buffer.from(JSON.stringify([c.accountId,c.jurisdiction,c.bucket])));
const input={academyId:academy,fileId:file,storageTargetId:target(source),bytes:content.length,sha256:hash(content)};
type Request={method:string;hostname:string;path:string;headers:Record<string,string>;body?:unknown};
type Mode='normal'|'existing'|'existing_mismatch'|'source_mismatch'|'destination_mismatch'|'put_failure'|'read_failure'|'read_missing'|'hang_source'|'hang_put'|'cancel_put';
function fixture(mode:Mode='normal',controller?:AbortController){
 let sourceReads=0,puts=0,cleanReads=0,putSeen!:()=>void,sourceSeen!:()=>void,finishPut!:(value:unknown)=>void,destroyed=0,stored:Buffer|undefined=mode==='existing'||mode==='existing_mismatch'?Buffer.from(content):undefined;
 if(mode==='existing_mismatch')stored![0]^=1;
 const pendingPut=new Promise<never>(resolve=>{finishPut=resolve as (value:unknown)=>void;});
 const observedPut=new Promise<void>(resolve=>{putSeen=resolve;}),observedSource=new Promise<void>(resolve=>{sourceSeen=resolve;});
 const body=(b:Buffer,etag='"opaque-etag-not-a-hash"')=>({response:{statusCode:200,headers:{'content-length':String(b.length),'content-type':'application/octet-stream',etag},body:Readable.from([b.subarray(0,7),b.subarray(7)])}});
 const failure=(statusCode:number)=>({response:{statusCode,headers:{'content-type':'application/xml'},body:Readable.from([Buffer.from('<Error><Code>'+ (statusCode===412?'PreconditionFailed':statusCode===404?'NoSuchKey':'InternalError')+'</Code><Message>PRIVATE provider diagnostic</Message></Error>')])}});
 const handlers={source:{destroy(){destroyed++;},async handle(req:Request){sourceReads++;sourceSeen();assert.equal(req.method,'GET');assert.equal(req.path,`/${source.bucket}/academies/${academy}/quarantine/${file}`);assert.equal(req.hostname,source.accountId+'.r2.cloudflarestorage.com');assert.match(req.headers.authorization,/Credential=synthetic-source-id\//);if(mode==='hang_source')return new Promise<never>(()=>{});const b=Buffer.from(content);if(mode==='source_mismatch')b[0]^=1;return body(b);}},
  destination:{destroy(){destroyed++;},async handle(req:Request){assert.equal(req.path,`/${destination.bucket}/academies/${academy}/clean/${file}`);assert.match(req.headers.authorization,/Credential=synthetic-clean-id\//);assert.equal(req.hostname,destination.accountId+'.r2.cloudflarestorage.com');
   if(req.method==='PUT'){puts++;putSeen();assert.equal(req.headers['if-none-match'],'*');assert.equal(req.headers['content-type'],'application/octet-stream');assert.equal(req.headers['content-disposition'],'attachment');assert.equal(req.headers['cache-control'],'private, no-store');assert.equal(req.headers['content-length'],String(content.length));assert.ok(Buffer.isBuffer(req.body));assert.deepEqual(req.body,content);
    if(mode==='hang_put')return pendingPut;if(mode==='cancel_put'){controller!.abort();return pendingPut;}if(mode==='put_failure')return failure(500);if(stored)return failure(412);stored=Buffer.from(req.body);return {response:{statusCode:200,headers:{etag:'"PUT-etag-is-not-content-proof"'},body:Readable.from([])}};
   }assert.equal(req.method,'GET');cleanReads++;if(mode==='read_failure')return failure(403);if(mode==='read_missing')return failure(404);assert.ok(stored);const b=Buffer.from(stored);if(mode==='destination_mismatch')b[0]^=1;return body(b);
  }}};
 return {handlers,observedPut,observedSource,releasePut:()=>finishPut({response:{statusCode:200,headers:{},body:Readable.from([])}}),counts:()=>({sourceReads,puts,cleanReads,destroyed}),stored:()=>stored,run:(options:Parameters<typeof promoteQuarantinedFile>[3]={})=>promoteQuarantinedFile(source,destination,input,options,handlers)};
}
test('verified promotion uses distinct explicit credentials,one original read,conditional first-write and an independently measured clean read',async()=>{
 const f=fixture(),r=await f.run();assert.deepEqual(r,{outcome:'written_verified',bytes:content.length,sha256:hash(content),source:{storageTargetId:target(source),etag:'"opaque-etag-not-a-hash"'},destination:{storageTargetId:target(destination),etag:'"opaque-etag-not-a-hash"'}});assert.deepEqual(f.stored(),content);assert.deepEqual(f.counts(),{sourceReads:1,puts:1,cleanReads:1,destroyed:3});for(const key of ['safeToServe','downloadUrl','signatureVerified','academyId','storageCredentials'])assert.equal(key in r,false);
});
test('an existing conditional-write destination is verified without overwriting or inventing a fresh write',async()=>{
 const f=fixture('existing'),r=await f.run();assert.equal(r.outcome,'existing_verified');assert.equal(f.counts().puts,1);assert.equal(f.counts().cleanReads,1);assert.deepEqual(f.stored(),content);
});
test('changed original bytes never reach PUT and changed stored bytes cannot pass using a matching ETag',async()=>{
 const sourceChanged=fixture('source_mismatch');await assert.rejects(sourceChanged.run(),{code:'FILE_PROMOTION_SOURCE_MISMATCH',status:409});assert.equal(sourceChanged.counts().puts,0);assert.equal(sourceChanged.counts().cleanReads,0);
 const destinationChanged=fixture('destination_mismatch');await assert.rejects(destinationChanged.run(),{code:'FILE_PROMOTION_DESTINATION_MISMATCH',status:409});assert.equal(destinationChanged.counts().puts,1);assert.equal(destinationChanged.counts().cleanReads,1);
 const existingChanged=fixture('existing_mismatch'),before=Buffer.from(existingChanged.stored()!);await assert.rejects(existingChanged.run(),{code:'FILE_PROMOTION_DESTINATION_MISMATCH',status:409});assert.deepEqual(existingChanged.stored(),before);assert.notDeepEqual(before,content);
});
test('PUT failure or failed verification is outcome-unknown with no automatic write retry or raw provider diagnostic',async()=>{
 for(const mode of ['put_failure','read_failure','read_missing'] as const){const f=fixture(mode);await assert.rejects(f.run(),e=>{assert.equal((e as {code:string}).code,'FILE_PROMOTION_OUTCOME_UNKNOWN');assert.doesNotMatch(String(e),/PRIVATE|synthetic-clean-not-real-secret|InternalError|NoSuchKey/);return true;});assert.equal(f.counts().puts,1);assert.equal(f.counts().cleanReads,mode==='put_failure'?0:1);}
});
test('promotion rejects same-target copies,wrong source identity,URL/path injection,oversize and unknown controls before IO',async()=>{
 const f=fixture();for(const i of [{...input,storageTargetId:'0'.repeat(64)},{...input,fileId:'../clean/secret'},{...input,academyId:'https://localhost'},{...input,sha256:'bad'},{...input,bytes:0},{...input,bytes:33_554_433},{...input,outputPath:'/PRIVATE'}])await assert.rejects(promoteQuarantinedFile(source,destination,i,{},f.handlers),e=>['INVALID_FILE_PROMOTION_CONFIGURATION','INVALID_FILE_PROMOTION_TARGET'].includes((e as {code:string}).code));
 await assert.rejects(promoteQuarantinedFile(source,{...source,accessKeyId:'different-credential'},input,{},f.handlers),{code:'INVALID_FILE_PROMOTION_TARGET'});
 await assert.rejects(promoteQuarantinedFile(source,{...destination,accessKeyId:source.accessKeyId},input,{},f.handlers),{code:'INVALID_FILE_PROMOTION_TARGET'});
 await assert.rejects(promoteQuarantinedFile(source,{...destination,bucket:source.bucket,jurisdiction:'eu'},input,{},f.handlers),{code:'INVALID_FILE_PROMOTION_TARGET'});
 for(const options of [{timeoutMs:0},{timeoutMs:600001},{timeoutMs:1.5},{url:'https://localhost'}])await assert.rejects(promoteQuarantinedFile(source,destination,input,options, f.handlers),{code:'INVALID_FILE_PROMOTION_CONFIGURATION'});assert.equal(f.counts().sourceReads,0);assert.equal(f.counts().puts,0);
});
test('pre-cancelled promotion never contacts storage and active source cancellation releases admission capacity',async()=>{
 const c=new AbortController();c.abort();const f=fixture();await assert.rejects(f.run({signal:c.signal}),{code:'FILE_PROMOTION_CANCELLED'});assert.equal(f.counts().sourceReads,0);
 const controller=new AbortController(),slow=fixture('hang_source'),pending=slow.run({signal:controller.signal});await slow.observedSource;controller.abort();await assert.rejects(pending,{code:'FILE_PROMOTION_CANCELLED'});assert.equal(slow.counts().puts,0);assert.equal((await fixture().run()).outcome,'written_verified');
});
test('cancellation after a PUT starts is explicitly outcome-unknown and never triggers a second write or follow-up read',async()=>{
 const c=new AbortController(),f=fixture('cancel_put',c);try{await assert.rejects(f.run({signal:c.signal}),{code:'FILE_PROMOTION_OUTCOME_UNKNOWN'});assert.equal(f.counts().puts,1);assert.equal(f.counts().cleanReads,0);}finally{f.releasePut();await new Promise<void>(resolve=>setImmediate(resolve));}
});
test('one whole-operation deadline covers a stalled source or PUT with phase-correct uncertainty and no long test wait',async t=>{
 for(const mode of ['hang_source','hang_put'] as const){t.mock.timers.enable({apis:['setTimeout']});const f=fixture(mode);try{const pending=f.run({timeoutMs:100});await(mode==='hang_source'?f.observedSource:f.observedPut);t.mock.timers.tick(100);await assert.rejects(pending,{code:mode==='hang_source'?'FILE_PROMOTION_TIMEOUT':'FILE_PROMOTION_OUTCOME_UNKNOWN'});assert.equal(f.counts().cleanReads,0);}finally{t.mock.timers.reset();f.releasePut();await new Promise<void>(resolve=>setImmediate(resolve));}}
 assert.equal((await fixture().run()).outcome,'written_verified');
});
test('tiny three-call admission permits only two bounded copy operations and recovers after cancellation',async()=>{
 const c=new AbortController(),first=fixture('hang_source'),second=fixture('hang_source'),a=first.run({signal:c.signal}),b=second.run({signal:c.signal});await Promise.all([first.observedSource,second.observedSource]);const third=fixture();await assert.rejects(third.run(),{code:'FILE_PROMOTION_BUSY'});assert.equal(third.counts().sourceReads,0);c.abort();for(const pending of [a,b])await assert.rejects(pending,{code:'FILE_PROMOTION_CANCELLED'});assert.equal((await fixture().run()).outcome,'written_verified');
});
test('uncertain cancelled PUTs retain both admission slots until their transport actually settles,then capacity recovers',async()=>{
 const c=new AbortController(),first=fixture('hang_put'),second=fixture('hang_put'),a=first.run({signal:c.signal}),b=second.run({signal:c.signal});await Promise.all([first.observedPut,second.observedPut]);c.abort();
 try{for(const pending of [a,b])await assert.rejects(pending,{code:'FILE_PROMOTION_OUTCOME_UNKNOWN'});await assert.rejects(fixture().run(),{code:'FILE_PROMOTION_BUSY'});assert.equal(first.counts().cleanReads,0);assert.equal(second.counts().cleanReads,0);}
 finally{first.releasePut();second.releasePut();await new Promise<void>(resolve=>setImmediate(resolve));}
 assert.equal((await fixture().run()).outcome,'written_verified');
});
test('actual loopback HTTP cancellation after stored bytes leaves an uncertain write that a conditional replay verifies without overwriting',async()=>{
 let stored:Buffer|undefined,puts=0,reads=0,notify!:()=>void;const observed=new Promise<void>(resolve=>{notify=resolve;});
 const server=createServer(async(req,res)=>{
  if(req.method==='GET'&&req.url===`/${source.bucket}/academies/${academy}/quarantine/${file}`){res.writeHead(200,{'content-length':content.length,'content-type':'application/octet-stream',etag:'"original"'});res.end(content);return;}
  assert.equal(req.url,`/${destination.bucket}/academies/${academy}/clean/${file}`);
  if(req.method==='PUT'){puts++;assert.equal(req.headers['if-none-match'],'*');const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(chunk);const b=Buffer.concat(chunks);assert.deepEqual(b,content);
   if(stored){res.writeHead(412,{'content-type':'application/xml'});res.end('<Error><Code>PreconditionFailed</Code></Error>');return;}stored=Buffer.from(b);notify();return; // Committed bytes,deliberately no response before client cancellation.
  }
  assert.equal(req.method,'GET');reads++;assert.ok(stored);res.writeHead(200,{'content-length':stored.length,'content-type':'application/octet-stream',etag:'"verified-copy"'});res.end(stored);
 });
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address();assert.ok(address&&typeof address!=='string');
 const handler={async handle(req:Request,options?:unknown){return new Promise<{response:{statusCode:number;headers:Record<string,string>;body:Readable}}>((resolve,reject)=>{
  const signal=(options as {abortSignal?:AbortSignal})?.abortSignal;
  const outgoing=httpRequest({hostname:'127.0.0.1',port:address.port,path:req.path,method:req.method,headers:req.headers,agent:false},res=>{const headers=Object.fromEntries(Object.entries(res.headers).filter(([,v])=>v!==undefined).map(([k,v])=>[k,Array.isArray(v)?v.join(','):String(v)]));resolve({response:{statusCode:res.statusCode!,headers,body:res}});});
  const abort=()=>outgoing.destroy(new Error('CANCELLED_TRANSPORT'));signal?.addEventListener('abort',abort,{once:true});outgoing.once('close',()=>signal?.removeEventListener('abort',abort));outgoing.once('error',reject);if(signal?.aborted)abort();else outgoing.end(req.body as Buffer|undefined);
 });}};
 try{
  const c=new AbortController(),pending=promoteQuarantinedFile(source,destination,input,{signal:c.signal},{source:handler,destination:handler});await observed;c.abort();await assert.rejects(pending,{code:'FILE_PROMOTION_OUTCOME_UNKNOWN'});await new Promise<void>(resolve=>setImmediate(resolve));assert.deepEqual(stored,content);assert.equal(reads,0);
  const recovered=await promoteQuarantinedFile(source,destination,input,{}, {source:handler,destination:handler});assert.equal(recovered.outcome,'existing_verified');assert.equal(recovered.sha256,hash(content));assert.equal(puts,2);assert.equal(reads,1);assert.deepEqual(stored,content);
 }finally{await new Promise<void>(resolve=>{server.close(()=>resolve());server.closeAllConnections();});}
});
