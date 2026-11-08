import assert from 'node:assert/strict';
import { createHash,randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { retainSignatureEvidence } from '../src/integrations/signature-evidence-storage.ts';
import { r2TargetId } from '../src/integrations/r2-config.ts';
import { reconcileEnrollmentCompletion } from '../src/integrations/boldsign-completion.ts';

const config={accountId:'a'.repeat(32),jurisdiction:'default' as const,bucket:'synthetic-private-signature-evidence',accessKeyId:'synthetic-evidence-writer',secretAccessKey:'PRIVATE-synthetic-evidence-key',maximumUploadBytes:10485760};
const hash=(b:Uint8Array)=>createHash('sha256').update(b).digest('hex'),tick=()=>new Promise<void>(r=>setImmediate(r));
type Request={method:string;hostname:string;path:string;headers:Record<string,string>;body?:unknown};
function fixture(mode='normal'){
 const source={academyId:randomUUID(),startId:randomUUID(),signerId:randomUUID(),documentId:randomUUID(),packageId:randomUUID(),attachmentId:randomUUID(),bindingId:randomUUID(),documentSha256:'a'.repeat(64),sourceFingerprint:'b'.repeat(64),region:'CA' as const,signatureFields:[{id:'Signature1',pageNumber:1,bounds:{x:20,y:40,width:180,height:35}}]};
 const artifact=(text:string)=>{const bytes=Buffer.from(text);return {bytes,sha256:hash(bytes),sizeBytes:bytes.length};},evidence={document:artifact('%PDF-1.7\nPRIVATE synthetic signed agreement'),audit:artifact('%PDF-1.7\nPRIVATE synthetic provider audit'),properties:artifact('{"PRIVATE":"synthetic provider properties"}')};
 const objects=new Map<string,Buffer>(),calls:Request[]=[],putBuffers:Buffer[]=[];let release!:(value:unknown)=>void,reached!:()=>void;const observed=new Promise<void>(r=>{reached=r;}),pending=new Promise<never>(r=>{release=r as (value:unknown)=>void;});
 const failure=(status:number)=>({response:{statusCode:status,headers:{'content-type':'application/xml'},body:Readable.from([`<Error><Code>${status===412?'PreconditionFailed':'AccessDenied'}</Code><Message>PRIVATE provider diagnostic</Message></Error>`])}});
 const handler={destroy(){},async handle(req:Request){
  calls.push(req);assert.equal(req.hostname,config.accountId+'.r2.cloudflarestorage.com');assert.match(req.headers.authorization,/Credential=synthetic-evidence-writer\//);assert.match(req.path,new RegExp(`^/${config.bucket}/academies/${source.academyId}/signature-evidence/[0-9a-f-]{36}$`));
  if(req.method==='PUT'){
   assert.equal(req.headers['if-none-match'],'*');assert.equal(req.headers['cache-control'],'private, no-store');assert.equal(req.headers['content-disposition'],'attachment');assert.equal(req.headers['content-type'],'application/octet-stream');assert.equal(req.headers['x-amz-acl'],undefined);assert.ok(Buffer.isBuffer(req.body));putBuffers.push(req.body);assert.equal(req.headers['content-length'],String(req.body.length));reached();
   if(mode==='hang_put')return pending;if(mode==='put_failure')return failure(403);if(objects.has(req.path))return failure(412);objects.set(req.path,Buffer.from(req.body));return {response:{statusCode:200,headers:{etag:'"PUT-only-not-proof"'},body:Readable.from([])}};
  }
  assert.equal(req.method,'GET');if(mode==='read_failure')return failure(403);const bytes=Buffer.from(objects.get(req.path)!);if(mode==='changed_bytes')bytes[0]^=1;return {response:{statusCode:200,headers:{'content-length':String(bytes.length),'content-type':'application/octet-stream',etag:'"opaque-readback-etag"'},body:Readable.from([bytes.subarray(0,4),bytes.subarray(4)])}};
 }};
 return {source,evidence,objects,calls,putBuffers,observed,release:()=>release({response:{statusCode:200,headers:{},body:Readable.from([])}}),run:(options:Partial<Parameters<typeof retainSignatureEvidence>[3]>={})=>retainSignatureEvidence(config,source,evidence,{targetId:r2TargetId(config),...options},handler),handler};
}
test('evidence retention conditionally stores and independently reads all three exact artifacts without exposing content or granting admission',async()=>{
 const f=fixture(),r=await f.run();assert.deepEqual(f.calls.map(c=>c.method),['PUT','GET','PUT','GET','PUT','GET']);assert.equal(f.objects.size,3);assert.equal(r.storageTargetId,r2TargetId(config));assert.equal(r.bytesReadBackVerified,true);assert.equal(r.admissionCleared,false);assert.equal(r.malwareFreeVerified,false);assert.equal(r.legalValidityCertified,false);
 assert.equal(r.receipt.sourceFingerprint,f.source.sourceFingerprint);assert.equal(new Set([r.receipt.document.id,r.receipt.audit.id,r.receipt.properties.id]).size,3);for(const k of ['document','audit','properties'] as const){assert.equal(r.receipt[k].sha256,f.evidence[k].sha256);assert.equal(r.receipt[k].sizeBytes,f.evidence[k].sizeBytes);assert.equal(r.etags[k],'"opaque-readback-etag"');}
 assert.doesNotMatch(JSON.stringify(r),/PRIVATE|https:|accessKey|secretAccessKey|synthetic provider/);await tick();assert.ok(f.putBuffers.every(b=>b.every(v=>v===0)));assert.ok(Object.values(f.evidence).every(a=>a.bytes.some(v=>v!==0)),'caller buffers are not owned by this adapter');
 const repeated=await f.run();assert.deepEqual(repeated,r);assert.equal(f.objects.size,3);assert.equal(f.calls.length,12,'each existing object is independently read after atomic412,never overwritten');
});
test('identical bytes from another original start have different evidence identities',async()=>{
 const f=fixture(),first=await f.run();f.source.startId=randomUUID();const second=await f.run();assert.notEqual(second.receipt.document.id,first.receipt.document.id);assert.notEqual(second.receipt.audit.id,first.receipt.audit.id);assert.notEqual(second.receipt.properties.id,first.receipt.properties.id);assert.equal(f.objects.size,6);
});
test('completion checker composes with measured evidence retention without treating an archived bundle as admission or legal proof',async()=>{
 const f=fixture(),s=f.source,p={documentId:s.documentId,status:'Completed',isDeleted:false,enablePrintAndSign:false,enableReassign:false,metaData:{kavoshPackageId:s.packageId,kavoshContentAttachmentId:s.attachmentId,kavoshContentBindingId:s.bindingId,kavoshDocumentSha256:s.documentSha256},signerDetails:[{id:randomUUID(),signerName:'PRIVATE Guardian',signerEmail:'private@example.test',phoneNumber:'+16475550003',status:'Completed',signerType:'Signer',signType:'Single',authenticationType:'SMSOTP',enableEmailOTP:true,isReassigned:false,isAuthenticationFailed:false,formFields:[{id:'Signature1',type:'signature',pageNumber:1,bounds:s.signatureFields[0].bounds}]}]};
 const json=JSON.stringify(p);let reads=0;
 const result=await reconcileEnrollmentCompletion({region:'CA',apiKey:'PRIVATE-synthetic-provider-key'},s,{
  fetch:async(input,options)=>{reads++;assert.equal(options?.method,'GET');if(String(input).includes('/properties'))return new Response(json,{headers:{'content-type':'application/json'}});return new Response(String(input).includes('downloadAuditLog')?f.evidence.audit.bytes:f.evidence.document.bytes,{headers:{'content-type':'application/pdf'}});},
  // Synthetic identity adapter here;native historical authority is tested by
  // the separate original-flow test,not established by this offline stub.
  matchSigner:async()=>({nameMatches:true,emailMatches:true,phoneMatches:true}),
  retain:async(source,evidence,signal)=>(await retainSignatureEvidence(config,source,evidence,{targetId:r2TargetId(config),signal},f.handler)).receipt
 });
 assert.equal(reads,4);assert.equal(result.state,'evidence_recorded');assert.equal(result.evidenceRetained,true);assert.equal(result.admissionCleared,false);assert.equal(result.legalValidityCertified,false);assert.ok(result.evidence);assert.equal(f.objects.get(`/${config.bucket}/academies/${s.academyId}/signature-evidence/${result.evidence.properties.id}`)?.toString(),json);assert.doesNotMatch(JSON.stringify(result),/private@example|PRIVATE|https:/);
});
test('stored-byte corruption is rejected even with an opaque matching-looking ETag',async()=>{
 const f=fixture('changed_bytes');await assert.rejects(f.run(),{code:'SIGNATURE_EVIDENCE_STORED_BYTES_MISMATCH'});assert.equal(f.calls.length,2);assert.equal(f.objects.size,1);assert.deepEqual(f.calls.map(c=>c.method),['PUT','GET']);
});
test('write or read failure remains outcome-unknown without retry delete or diagnostic leakage',async()=>{
 for(const mode of ['put_failure','read_failure']){const f=fixture(mode);await assert.rejects(f.run(),e=>{assert.equal((e as {code:string}).code,'SIGNATURE_EVIDENCE_OUTCOME_UNKNOWN');assert.doesNotMatch(String(e),/PRIVATE|AccessDenied|synthetic-evidence-key/);return true;});assert.equal(f.calls.filter(c=>c.method==='PUT').length,1);assert.ok(f.calls.every(c=>c.method==='PUT'||c.method==='GET'));}
});
test('wrong targets malformed bytes unknown source fields and pre-cancellation perform no storage operations',async()=>{
 const f=fixture();await assert.rejects(f.run({targetId:'0'.repeat(64)}),{code:'SIGNATURE_EVIDENCE_TARGET_MISMATCH'});await assert.rejects(f.run({signal:AbortSignal.abort()}),{code:'SIGNATURE_EVIDENCE_INTERRUPTED'});await assert.rejects(retainSignatureEvidence(config,{...f.source,url:'https://bad.example'},f.evidence,{targetId:r2TargetId(config)},f.handler),{code:'INVALID_SIGNATURE_EVIDENCE_STORAGE'});
 for(const value of [{...f.evidence,document:{...f.evidence.document,sha256:'0'.repeat(64)}},{...f.evidence,document:{...f.evidence.document,sizeBytes:10485761}},{...f.evidence,audit:f.evidence.document}])await assert.rejects(retainSignatureEvidence(config,f.source,value,{targetId:r2TargetId(config)},f.handler),{code:'INVALID_SIGNATURE_EVIDENCE_BYTES'});assert.equal(f.calls.length,0);
});
test('unknown timed-out writes retain two admission slots and snapshot buffers until actual transport settlement',async()=>{
 const first=fixture('hang_put'),second=fixture('hang_put'),a=first.run({timeoutMs:50}),b=second.run({timeoutMs:50});await Promise.all([first.observed,second.observed]);
 try{for(const p of [a,b])await assert.rejects(p,{code:'SIGNATURE_EVIDENCE_OUTCOME_UNKNOWN'});await assert.rejects(fixture().run(),{code:'SIGNATURE_EVIDENCE_BUSY'});assert.ok([...first.putBuffers,...second.putBuffers].every(bytes=>bytes.some(v=>v!==0)));assert.equal(first.calls.length,1);assert.equal(second.calls.length,1);}
 finally{first.release();second.release();await tick();await tick();}
 assert.ok([...first.putBuffers,...second.putBuffers].every(bytes=>bytes.every(v=>v===0)));assert.equal((await fixture().run()).bytesReadBackVerified,true);
});
