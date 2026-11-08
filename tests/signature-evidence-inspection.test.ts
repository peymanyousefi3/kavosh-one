import assert from 'node:assert/strict';
import { randomUUID,createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtemp,rmdir } from 'node:fs/promises';
import { test } from 'node:test';
import { inspectSignatureEvidence } from '../src/integrations/signature-evidence-inspection.ts';
import { r2TargetId } from '../src/integrations/r2-config.ts';
import { createPdfValidationServer } from '../src/files/pdf-service.ts';
import { clamdPeer,clamdVersionString } from './fixtures/clamd-peer.ts';

const pythonPath=process.env.TEST_PDF_PYTHON_BINARY;
if(process.env.PDF_VALIDATION_TEST_REQUIRED==='true'&&!pythonPath)throw Error('PDF_TEST_INTERPRETER_REQUIRED');
const check=(name:string,run:()=>Promise<void>)=>test(name,{skip:!pythonPath},run),hash=(b:Buffer)=>createHash('sha256').update(b).digest('hex'),tick=()=>new Promise<void>(r=>setImmediate(r));let vectors:Record<string,Buffer>|undefined;
function bytes(name:string){if(!vectors){const r=spawnSync(pythonPath!,['-I','-B',fileURLToPath(new URL('./fixtures/pdf-fixtures.py',import.meta.url))],{encoding:'utf8',timeout:10000,maxBuffer:2097152});assert.equal(r.status,0,r.stderr);vectors=Object.fromEntries(Object.entries(JSON.parse(r.stdout) as Record<string,string>).map(([k,v])=>[k,Buffer.from(v,'base64')]));}return vectors[name];}
async function fixture(name='signature_layout',mode='success',versions?:Buffer[]){
 const reply=Buffer.from(clamdVersionString()+'\0'),peer=await clamdPeer(mode,versions??Array(8).fill(reply)),dir=await mkdtemp('/tmp/kavosh-evidence-pdf-'),socketPath=dir+'/p.sock',server=createPdfValidationServer({pythonPath:pythonPath!});let pdfCalls=0,reads=0;
 server.on('request',()=>{pdfCalls++;});await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(socketPath,()=>{server.removeListener('error',reject);resolve();});});
 const content=bytes(name),configuration={accountId:'a'.repeat(32),jurisdiction:'default' as const,bucket:'synthetic-private-evidence',accessKeyId:'synthetic-read-only-evidence-key',secretAccessKey:'PRIVATE-synthetic-reader-secret',maximumUploadBytes:10485760},task={academyId:randomUUID(),evidenceId:randomUUID(),sourceFingerprint:'b'.repeat(64),kind:'document' as const,artifactId:randomUUID(),storageTargetId:r2TargetId(configuration),bytes:content.length,sha256:hash(content),etag:'"retained-immutable"'},policy={timeZone:'UTC',maximumAgeSeconds:172800};
 const handler={destroy(){},async handle(req:{method:string;path:string;headers:Record<string,string>}){reads++;assert.equal(req.method,'GET');assert.equal(req.path,`/${configuration.bucket}/academies/${task.academyId}/signature-evidence/${task.artifactId}`);assert.equal(req.headers['if-match'],task.etag);return {response:{statusCode:200,headers:{'content-length':String(content.length),'content-type':'application/octet-stream',etag:task.etag},body:Readable.from([content.subarray(0,9),content.subarray(9)])}};}};
 return {task,configuration,content,peer,server,handler,policy,socketPath,counts:()=>({reads,pdfCalls}),run:(options:Parameters<typeof inspectSignatureEvidence>[5]={},selected=handler)=>inspectSignatureEvidence(configuration,task,peer.config,policy,{socketPath},options,selected),async close(){await peer.close();await new Promise<void>(resolve=>{server.close(()=>resolve());server.closeAllConnections();});await rmdir(dir);}};
}
check('archive inspection reads once,scans exact bytes with before/after metadata and uses the isolated signed profile without granting access',async()=>{
 const f=await fixture();try{const result=await f.run();assert.equal(result.outcome,'screened');assert.deepEqual(f.counts(),{reads:1,pdfCalls:1});assert.deepEqual(f.peer.commands,['VERSION','INSTREAM','VERSION']);assert.deepEqual(Buffer.concat(f.peer.received),f.content);assert.equal(result.safeToServe,false);assert.equal(result.admissionCleared,false);assert.equal(result.cryptographicValidityVerified,false);if(result.outcome==='screened'){assert.equal(result.sha256,f.task.sha256);assert.equal(result.etag,f.task.etag);assert.equal(result.databaseObservation.databaseVersion,30001);assert.equal(result.pdfValidation.profile,'signed-evidence');assert.equal(result.pdfValidation.policyVersion,2);}assert.doesNotMatch(JSON.stringify(result),/PRIVATE|socketPath|accessKey|downloadUrl|certificateSubject/);}finally{await f.close();}
});
check('a positive scanner detection is preserved without parsing and hostile signed PDFs remain structural rejection',async()=>{
 const detected=await fixture('signature_layout','detected');try{const result=await detected.run();assert.equal(result.outcome,'detected');assert.equal(detected.counts().pdfCalls,0);assert.deepEqual(detected.peer.commands,['VERSION','INSTREAM']);}finally{await detected.close();}
 const hostile=await fixture('signature_javascript');try{const result=await hostile.run();assert.equal(result.outcome,'rejected');if(result.outcome==='rejected'&&result.pdfValidation.outcome==='rejected')assert.equal(result.pdfValidation.reason,'ACTIVE_CONTENT');assert.equal(result.safeToServe,false);}finally{await hostile.close();}
});
check('stale or changing scanner metadata cannot become inspected archive eligibility',async()=>{
 const current=Buffer.from(clamdVersionString()+'\0'),stale=Buffer.from(clamdVersionString(Date.now()-173000000)+'\0'),changed=Buffer.from(clamdVersionString(Date.now()-60000,'UTC',30002)+'\0');
 for(const replies of [[stale],[current,changed]]){const f=await fixture('signature_layout','success',replies);try{const result=await f.run();assert.equal(result.outcome,'unavailable');if(result.outcome==='unavailable')assert.equal(result.reason,'SCANNER_UNAVAILABLE');assert.equal(f.counts().pdfCalls,0);assert.equal(result.safeToServe,false);}finally{await f.close();}}
});
check('changed archive bytes or ETags cannot be hidden behind a successful scanner response',async()=>{
 for(const kind of ['bytes','etag']){const f=await fixture();try{const handler={destroy(){},async handle(){const b=Buffer.from(f.content);if(kind==='bytes')b[b.length-1]^=1;return {response:{statusCode:200,headers:{'content-length':String(b.length),'content-type':'application/octet-stream',etag:kind==='etag'?'"other-object"':f.task.etag},body:Readable.from([b])}};}};assert.equal((await f.run({},handler)).outcome,'content_mismatch');assert.equal(f.counts().pdfCalls,0);}finally{await f.close();}}
});
check('invalid operator configuration and caller source overrides perform no storage scanner or parser IO',async()=>{
 const f=await fixture();try{for(const task of [{...f.task,artifactId:'../secret'},{...f.task,kind:'properties'},{...f.task,storageTargetId:'0'.repeat(64)},{...f.task,bytes:10485761},{...f.task,admissionCleared:true}])await assert.rejects(inspectSignatureEvidence(f.configuration,task,f.peer.config,f.policy,{socketPath:f.socketPath},{},f.handler),{code:'INVALID_SIGNATURE_EVIDENCE_INSPECTION'});await assert.rejects(inspectSignatureEvidence(f.configuration,f.task,f.peer.config,{...f.policy,timeZone:'guess'} ,{socketPath:f.socketPath},{},f.handler),{code:'INVALID_SIGNATURE_EVIDENCE_INSPECTION'});assert.deepEqual(f.counts(),{reads:0,pdfCalls:0});assert.equal(f.peer.connections(),0);assert.equal((await f.run({signal:AbortSignal.abort()})).outcome,'unavailable');assert.equal(f.counts().reads,0);}finally{await f.close();}
});
check('cancelled ignored storage reads retain both broker slots until real transport settlement then recover',async()=>{
 const f=await fixture(),controllers=[new AbortController(),new AbortController()],finish:((v:unknown)=>void)[]=[];let seen!:()=>void;const observed=new Promise<void>(r=>{seen=r;}),slow={destroy(){},async handle(){return new Promise<never>(resolve=>{finish.push(resolve as (v:unknown)=>void);if(finish.length===2)seen();});}};
 try{const pending=controllers.map(c=>f.run({signal:c.signal},slow));await observed;controllers.forEach(c=>c.abort());for(const p of pending){const r=await p;assert.equal(r.outcome,'unavailable');if(r.outcome==='unavailable')assert.equal(r.reason,'INTERRUPTED');}await assert.rejects(f.run(),{code:'SIGNATURE_EVIDENCE_INSPECTION_BUSY'});assert.equal(f.peer.connections(),0);finish.forEach(resolve=>resolve({response:{statusCode:200,headers:{'content-length':String(f.content.length),'content-type':'application/octet-stream',etag:f.task.etag},body:Readable.from([f.content])}}));await tick();await tick();assert.equal((await f.run()).outcome,'screened');}finally{await f.close();}
});
