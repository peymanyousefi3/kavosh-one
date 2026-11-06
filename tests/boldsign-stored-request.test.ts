import assert from 'node:assert/strict';
import { createHash,randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { prepareStoredBoldSignRequest } from '../src/integrations/boldsign-stored-request.ts';
import { buildBoldSignSendRequest,buildBoldSignWorkSendRequest,type BoldSignSendDraft,type BoldSignWorkSendDraft } from '../src/integrations/boldsign-send-request.ts';
import { r2TargetId } from '../src/integrations/r2-config.ts';

// Synthetic original/transport only: no real PDF safety,cloud IAM,signature or
// legal clearance. This component measures bytes;it does NOT parse/scan them.
const bytes=Buffer.from('%PDF-1.7\nPRIVATE original fixture\n'),sha256=createHash('sha256').update(bytes).digest('hex');
const config={accountId:'a'.repeat(32),jurisdiction:'default' as const,bucket:'synthetic-signing-originals',accessKeyId:'synthetic-read-only-id',secretAccessKey:'synthetic-PRIVATE-not-a-real-key',maximumUploadBytes:10_485_760};
const source={academyId:randomUUID(),fileId:randomUUID(),fileVersion:1,copyId:randomUUID(),sourceFingerprint:'d'.repeat(64),storageTargetId:r2TargetId(config),bytes:bytes.length,sha256,etag:'"verified-original-etag"'};
const field={id:'Signature1',fieldType:'Signature',isRequired:true as const,pageNumber:1,bounds:{x:10,y:10,width:100,height:30}};
const signer={personId:randomUUID(),legalName:'PRIVATE Legal signer',email:'signer@example.test',phoneE164:'+16475550101',emailVerified:true as const,phoneVerified:true as const,contactFingerprint:'c'.repeat(64)};
const draft:BoldSignSendDraft={packageId:randomUUID(),attachmentId:randomUUID(),bindingId:randomUUID(),locale:'en',title:'PRIVATE Agreement',message:'PRIVATE review',expiryDays:30,document:{sha256,sizeBytes:bytes.length},signer,routing:{version:1,role:'legal_signer',fields:[field]}};
const work:BoldSignWorkSendDraft={preparationId:randomUUID(),bindingId:randomUUID(),locale:'fr',title:draft.title,message:draft.message,expiryDays:30,document:draft.document,worker:signer,academyRepresentative:{...signer,personId:randomUUID(),legalName:'PRIVATE Academy representative',email:'academy@example.test',phoneE164:'+12025550123'},routing:{version:1,parties:[{role:'worker',fields:[field]},{role:'academy_representative',fields:[{...field,id:'AcademySignature'}]}]}};
type Request={method:string;hostname:string;path:string;headers:Record<string,string>};
type Mode='normal'|'changed_bytes'|'changed_etag'|'short'|'overflow'|'wrong_length'|'missing_etag'|'denied'|'pending';
function fixture(mode:Mode='normal'){
 let calls=0,destroyed=0,started!:()=>void,release!:(value:unknown)=>void;const observed=new Promise<void>(resolve=>{started=resolve;}),pending=new Promise<never>(resolve=>{release=resolve as (value:unknown)=>void;});
 const response=()=>{
  if(mode==='denied')return {response:{statusCode:412,headers:{'content-type':'application/xml'},body:Readable.from([Buffer.from('<Error><Code>PreconditionFailed</Code><Message>PRIVATE provider secret</Message></Error>')])}};
  const content=Buffer.from(bytes);if(mode==='changed_bytes')content[12]^=1;
  const actual=mode==='short'?content.subarray(0,-1):mode==='overflow'?Buffer.concat([content,Buffer.from('!')]):content;
  return {response:{statusCode:200,headers:{'content-type':'application/octet-stream','content-length':String(mode==='wrong_length'?content.length+1:content.length),...mode==='missing_etag'?{}:{etag:mode==='changed_etag'?'"replacement"':source.etag}},body:Readable.from([actual.subarray(0,9),actual.subarray(9)])}};
 };
 const handler={destroy(){destroyed++;},async handle(req:Request){calls++;started();assert.equal(req.method,'GET');assert.equal(req.hostname,config.accountId+'.r2.cloudflarestorage.com');assert.equal(req.path,`/${config.bucket}/academies/${source.academyId}/clean/${source.fileId}`);assert.equal(req.headers['if-match'],source.etag);assert.match(req.headers.authorization,/SignedHeaders=[^,]*if-match/);assert.match(req.headers.authorization,/Credential=synthetic-read-only-id\//);return mode==='pending'?pending:response();}};
 return {handler,observed,release:()=>release(response()),counts:()=>({calls,destroyed}),run:(input:unknown={purpose:'unified_enrollment',draft},claims:unknown=source,options:Parameters<typeof prepareStoredBoldSignRequest>[3]={})=>prepareStoredBoldSignRequest(config,input,claims,options,handler)};
}
test('stored signing preparation reads one exact conditional clean object and builds both private request kinds without sending',async()=>{
 for(const purpose of ['unified_enrollment','worker_services'] as const){const f=fixture(),selected=purpose==='worker_services'?work:draft,result=await f.run({purpose,draft:selected}),expected=purpose==='worker_services'?buildBoldSignWorkSendRequest(work,bytes):buildBoldSignSendRequest(draft,bytes);assert.equal(result.body,expected.body);assert.deepEqual(result.receipt,expected.receipt);assert.deepEqual(result.original,source);assert.equal(result.originalBytesMeasured,true);assert.equal(result.storageReadPerformed,true);assert.equal(result.fileSafetyCleared,false);assert.equal(result.signingProviderRequestMade,false);assert.deepEqual(f.counts(),{calls:1,destroyed:1});assert.doesNotMatch(JSON.stringify(result.receipt),/PRIVATE|example.test|https:|accessKey|secretAccess/);}
});
test('wrong original bytes,length or ETag cannot pass using provider metadata or a matching claimed hash',async()=>{
 for(const mode of ['changed_bytes','changed_etag','short','overflow','wrong_length'] as const){const f=fixture(mode);await assert.rejects(f.run(),{code:'BOLDSIGN_ORIGINAL_IDENTITY_MISMATCH',status:409});assert.deepEqual(f.counts(),{calls:1,destroyed:1});}
 for(const mode of ['denied','missing_etag'] as const){const f=fixture(mode);await assert.rejects(f.run(),e=>{assert.equal((e as {code:string}).code,'BOLDSIGN_ORIGINAL_UNAVAILABLE');assert.doesNotMatch(String(e),/PRIVATE|PreconditionFailed|synthetic-read-only-id/);return true;});assert.equal(f.counts().calls,1);}
});
test('strict target,draft,document and budget controls reject before storage IO',async()=>{
 const f=fixture();
 for(const claims of [{...source,bytes:0},{...source,bytes:10_485_761},{...source,fileId:'../other'},{...source,etag:'*'},{...source,etag:'"bad\nheader"'},{...source,url:'https://localhost'}])await assert.rejects(f.run(undefined,claims),{code:'INVALID_BOLDSIGN_STORED_REQUEST'});
 await assert.rejects(f.run(undefined,{...source,storageTargetId:'f'.repeat(64)}),{code:'INVALID_BOLDSIGN_ORIGINAL_TARGET'});
 await assert.rejects(f.run(undefined,{...source,sha256:'b'.repeat(64)}),{code:'BOLDSIGN_ORIGINAL_IDENTITY_MISMATCH'});
 for(const input of [{purpose:'unknown',draft},{purpose:'unified_enrollment',draft,url:'https://localhost'},{purpose:'unified_enrollment',draft:{...draft,signer:{...signer,emailVerified:false}}}])await assert.rejects(f.run(input),{code:'INVALID_BOLDSIGN_STORED_REQUEST'});
 for(const options of [{timeoutMs:0},{timeoutMs:120001},{url:'https://localhost'}])await assert.rejects(f.run(undefined,undefined,options),{code:'INVALID_BOLDSIGN_STORED_REQUEST'});
 await assert.rejects(prepareStoredBoldSignRequest({...config,bucket:'another'}, {purpose:'unified_enrollment',draft},source,{},f.handler),{code:'INVALID_BOLDSIGN_ORIGINAL_TARGET'});
 assert.equal(f.counts().calls,0);
});
test('pre-cancellation does not read storage,and cancellation retains admission until ignored IO actually settles',async()=>{
 const early=new AbortController();early.abort();const untouched=fixture();await assert.rejects(untouched.run(undefined,undefined,{signal:early.signal}),{code:'BOLDSIGN_ORIGINAL_CANCELLED'});assert.equal(untouched.counts().calls,0);
 const controllers=[new AbortController(),new AbortController()],slow=[fixture('pending'),fixture('pending')];
 const requests=slow.map((f,i)=>f.run(undefined,undefined,{signal:controllers[i].signal}));await Promise.all(slow.map(f=>f.observed));controllers.forEach(c=>c.abort());await Promise.all(requests.map(p=>assert.rejects(p,{code:'BOLDSIGN_ORIGINAL_CANCELLED'})));
 const busy=fixture();await assert.rejects(busy.run(),{code:'BOLDSIGN_ORIGINAL_BUSY'});assert.equal(busy.counts().calls,0);
 slow.forEach(f=>f.release());await new Promise<void>(resolve=>setImmediate(resolve));assert.equal((await busy.run()).originalBytesMeasured,true);for(const f of slow)assert.deepEqual(f.counts(),{calls:1,destroyed:1});
});
test('absolute read deadline rejects promptly even if transport ignores cancellation,then releases only on real settlement',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});const f=fixture('pending'),pending=f.run(undefined,undefined,{timeoutMs:100});await f.observed;t.mock.timers.tick(100);await assert.rejects(pending,{code:'BOLDSIGN_ORIGINAL_TIMEOUT'});assert.equal(f.counts().calls,1);f.release();await new Promise<void>(resolve=>setImmediate(resolve));assert.equal((await fixture().run()).originalBytesMeasured,true);
});
