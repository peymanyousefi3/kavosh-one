import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer,request,type Server } from 'node:http';
import { connect } from 'node:net';
import { mkdtemp,rmdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createPdfValidationServer,validatePdfViaService,validateSignedEvidencePdfViaService } from '../src/files/pdf-service.ts';
import { validateUnsignedPdf,validateSignedEvidencePdf } from '../src/files/pdf-validation.ts';
import { assertPrivatePdfSocket } from '../src/files/pdf-runtime.ts';

const pythonPath=process.env.TEST_PDF_PYTHON_BINARY;
if(process.env.PDF_VALIDATION_TEST_REQUIRED==='true'&&!pythonPath)throw new Error('PDF_TEST_INTERPRETER_REQUIRED');
const check=(name:string,run:()=>Promise<void>)=>test(name,{skip:!pythonPath},run);
const hash=(b:Buffer)=>createHash('sha256').update(b).digest('hex');
let vectors:Record<string,Buffer>|undefined;
function bytes(name='ordinary'){
 if(!vectors){assert.ok(pythonPath);const r=spawnSync(pythonPath,['-I','-B',fileURLToPath(new URL('./fixtures/pdf-fixtures.py',import.meta.url))],{env:{NODE_ENV:'test',TZ:'UTC'},encoding:'utf8',timeout:10000,maxBuffer:2_097_152});assert.equal(r.status,0,r.stderr);vectors=Object.fromEntries(Object.entries(JSON.parse(r.stdout) as Record<string,string>).map(([k,v])=>[k,Buffer.from(v,'base64')]));}
 return vectors[name];
}
async function fixture(server:Server=createPdfValidationServer({pythonPath:pythonPath??'/missing/interpreter'})){
 const directory=await mkdtemp('/tmp/kavosh-pdf-sock-'),socketPath=directory+'/service.sock';
 await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(socketPath,()=>{server.removeListener('error',reject);resolve();});});
 async function close(){await new Promise<void>((resolve,reject)=>{server.close(e=>e?reject(e):resolve());server.closeAllConnections();});await rmdir(directory);}
 const validate=(b:Buffer,signal?:AbortSignal)=>validatePdfViaService(b,{socketPath,signal});
 const validateSigned=(b:Buffer,signal?:AbortSignal)=>validateSignedEvidencePdfViaService(b,{socketPath,signal});
 async function raw(b:Buffer,headers:Record<string,string>={},method='POST',path='/v1/validate-pdf'){
  return new Promise<{status:number;body:string;headers:Record<string,unknown>}>((resolve,reject)=>{
   const req=request({socketPath,method,path,agent:false,headers:{host:'localhost',connection:'close','content-type':'application/octet-stream','content-length':b.length,'x-content-sha256':hash(b),...headers}},res=>{
    let body='';res.setEncoding('utf8');res.on('data',c=>{body+=c;});res.once('end',()=>resolve({status:res.statusCode!,body,headers:res.headers}));res.once('error',reject);
   });req.once('error',reject);req.end(b);
  });
 }
 return {server,socketPath,close,validate,validateSigned,raw};
}
check('private signed-evidence channel preserves the original unsigned rejection and never reports cryptographic validity',async()=>{
 const f=await fixture(),b=bytes('signature_layout');try{const signed=await f.validateSigned(b),unsigned=await f.validate(b);assert.equal(signed.outcome,'screened');assert.equal(signed.policyVersion,2);assert.equal(signed.profile,'signed-evidence');assert.equal(signed.cryptographicValidityVerified,false);assert.equal(signed.inputSha256,hash(b));if(signed.outcome==='screened')assert.equal(signed.signatureCount,1);assert.equal(unsigned.outcome,'rejected');if(unsigned.outcome==='rejected')assert.equal(unsigned.reason,'EXISTING_SIGNATURE');assert.equal((await f.raw(b,{'x-profile':'signed-evidence'})).status,400);assert.equal((await f.raw(b,{},'POST','/v1/validate-signed-evidence-pdf?profile=unsigned')).status,400);}finally{await f.close();}
});
check('signed and unsigned Unix clients reject valid receipts from the other profile instead of weakening policy identity',async()=>{
 const b=bytes(),unsigned=await validateUnsignedPdf(b,{pythonPath:pythonPath!}),signed=await validateSignedEvidencePdf(b,{pythonPath:pythonPath!});
 for(const [receipt,wantSigned] of [[unsigned,true],[signed,false]] as const){const raw=Buffer.from(JSON.stringify(receipt)),f=await fixture(createServer((_req,res)=>{res.writeHead(200,{'content-type':'application/json','content-length':raw.length,connection:'close'});res.end(raw);}));try{await assert.rejects(wantSigned?f.validateSigned(b):f.validate(b),{code:'PDF_SERVICE_UNAVAILABLE'});}finally{await f.close();}}
});
check('signed and unsigned Unix requests share the same bounded native and client admission',async()=>{
 const f=await fixture();try{const first=f.validateSigned(bytes('signature_layout')),second=f.validate(bytes());await assert.rejects(f.validateSigned(bytes()),{code:'PDF_SERVICE_BUSY'});assert.equal((await first).outcome,'screened');assert.equal((await second).outcome,'screened');assert.equal((await f.validateSigned(bytes())).outcome,'screened');}finally{await f.close();}
});
test('production PDF command refuses the non-isolated host before opening its socket with secret-free failure',()=>{
 const r=spawnSync(process.execPath,['--import','tsx','scripts/pdf-validator-service.ts'],{cwd:new URL('..',import.meta.url),env:{NODE_ENV:'production',TZ:'UTC',PATH:process.env.PATH},encoding:'utf8',timeout:5000});
 assert.equal(r.status,1);assert.equal(r.stdout,'');assert.equal(r.stderr.trim(),'PDF validator refused startup; isolated runtime controls are required.');
});
test('PDF socket ownership guard refuses a real ordinary test socket',async()=>{
 const f=await fixture();try{await assert.rejects(assertPrivatePdfSocket(f.socketPath),/UNSAFE_PDF_SERVICE_SOCKET/);}finally{await f.close();}
});
check('real Unix PDF service returns exact-byte native receipts and explicit policy rejections without private document data',async()=>{
 const f=await fixture();try{
  for(const name of ['ordinary','object_streams','rotated','interactive','javascript','embedded','existing_signature']){
   const b=bytes(name),before=Buffer.from(b),r=await f.validate(b);assert.equal(r.outcome,['javascript','embedded','existing_signature'].includes(name)?'rejected':'screened',name);assert.equal(r.inputSha256,hash(b));assert.equal(r.inputBytes,b.length);assert.deepEqual(b,before);assert.doesNotMatch(JSON.stringify(r),/PRIVATE|downloadUrl|safeToServe|academyId|storageTargetId/);
  }
  const r=await f.raw(bytes());assert.equal(r.status,200);assert.equal(r.headers['cache-control'],'no-store');assert.equal(r.headers['x-content-type-options'],'nosniff');
 }finally{await f.close();}
});
check('PDF server refuses caller credentials,destinations,binary overrides,bad hashes and unknown protocols before parsing',async()=>{
 const f=await fixture(),b=bytes();try{
  for(const headers of [{cookie:'PRIVATE'},{authorization:'Bearer PRIVATE'},{origin:'https://example.test'},{'x-python-path':'/PRIVATE/binary'},{'x-output-path':'/PRIVATE/path'},{'content-encoding':'gzip'},{'content-length':'10485761'},{'x-content-sha256':'0'.repeat(64)},{'content-type':'application/pdf'}] as Record<string,string>[]){const r=await f.raw(b,headers);assert.equal(r.status,400);assert.doesNotMatch(r.body,/PRIVATE|stack|Bearer/);}
  for(const [method,path]of [['GET','/v1/validate-pdf'],['POST','/other'],['POST','/v1/validate-pdf?url=file:///PRIVATE']])assert.equal((await f.raw(b,{},method,path)).status,400);
  assert.equal((await f.validate(b)).outcome,'screened');
 }finally{await f.close();}
});
check('PDF server captures its interpreter configuration before listening and refuses duplicate headers and Expect handshakes',async()=>{
 const configuration={pythonPath:pythonPath!},f=await fixture(createPdfValidationServer(configuration)),b=bytes();configuration.pythonPath='/PRIVATE/replacement';
 try{
  assert.equal((await f.validate(b)).outcome,'screened');assert.equal((await f.raw(b,{expect:'100-continue'})).status,417);
  const reply=await new Promise<string>((resolve,reject)=>{
   const s=connect(f.socketPath);let result='';s.setEncoding('utf8');s.on('data',c=>{result+=c;});s.once('error',reject);s.once('end',()=>resolve(result));s.once('connect',()=>s.end('POST /v1/validate-pdf HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/octet-stream\r\nContent-Length: '+b.length+'\r\nX-Content-Sha256: '+hash(b)+'\r\nx-content-sha256: '+hash(b)+'\r\n\r\n'+b.toString('latin1'),'latin1'));
  });assert.match(reply,/^HTTP\/1\.1 400 /);assert.doesNotMatch(reply,/PRIVATE/);assert.equal((await f.validate(b)).outcome,'screened');
 }finally{await f.close();}
});
check('PDF client copies selected bytes and rejects arbitrary destinations and input/configuration ambiguity',async()=>{
 const f=await fixture(),b=bytes();try{
  const backing=Buffer.concat([b,Buffer.from('PRIVATE backing')]),selected=backing.subarray(0,b.length),pending=f.validate(selected);selected.fill(0);const r=await pending;assert.equal(r.inputSha256,hash(b));assert.equal(r.inputBytes,b.length);
  for(const socketPath of ['https://localhost','relative','/tmp/../secret','/tmp/./secret','/tmp/x\0','/'+ 'a'.repeat(100)])await assert.rejects(validatePdfViaService(b,{socketPath}),{code:'INVALID_PDF_SERVICE_CONFIGURATION'});
  for(const input of [null,{},Buffer.alloc(0),Buffer.alloc(10_485_761),'file:///PRIVATE'])await assert.rejects(f.validate(input as Buffer),{code:'INVALID_PDF_VALIDATION_BYTES'});
  await assert.rejects(validatePdfViaService(b,{socketPath:f.socketPath,pythonPath:'/PRIVATE'} as {socketPath:string}),{code:'INVALID_PDF_SERVICE_CONFIGURATION'});
 }finally{await f.close();}
});
check('PDF client refuses forged,incomplete,redirected,oversized,nonUTF8 and private diagnostic responses',async()=>{
 const b=bytes(),actual=await validateUnsignedPdf(b,{pythonPath:pythonPath!});
 const cases:Array<{status?:number;body:Buffer;size?:number;headers?:Record<string,string>}>= [
  {body:Buffer.from(JSON.stringify({...actual,inputSha256:'0'.repeat(64)}))},{body:Buffer.from(JSON.stringify({...actual,inputBytes:b.length+1}))},
  {body:Buffer.from(JSON.stringify({...actual,safeToServe:true}))},{body:Buffer.from(JSON.stringify({...actual,qpdf:'untrusted'}))},
  {body:Buffer.from('PRIVATE')},{body:Buffer.from([0xff])},{body:Buffer.from('{}'),size:1_048_577},{body:Buffer.from('{}'),size:10},
  {body:Buffer.from('{}'),status:307,headers:{location:'https://example.test/PRIVATE'}},{body:Buffer.from('{}'),headers:{'content-encoding':'gzip'}},{body:Buffer.from('{}'),headers:{'content-type':'text/html'}}
 ];
 for(const c of cases){const f=await fixture(createServer((_req,res)=>{res.writeHead(c.status??200,{'content-type':'application/json','content-length':c.size??c.body.length,connection:'close',...c.headers});res.end(c.body);}));try{await assert.rejects(f.validate(b),{code:'PDF_SERVICE_UNAVAILABLE'});}finally{await f.close();}}
});
check('three concurrent PDF clients admit only two native jobs and recover without a large stress test',async()=>{
 const f=await fixture(),b=bytes();try{const results=await Promise.allSettled([f.validate(b),f.validate(b),f.validate(b)]);assert.equal(results.filter(r=>r.status==='fulfilled').length,2);assert.deepEqual(results.filter(r=>r.status==='rejected').map(r=>r.status==='rejected'?r.reason.code:null),['PDF_SERVICE_BUSY']);assert.equal((await f.validate(b)).outcome,'screened');}finally{await f.close();}
});
check('PDF pre-cancellation and active cancellation close the socket and release client capacity',async()=>{
 const b=bytes(),pre=new AbortController();pre.abort();await assert.rejects(validatePdfViaService(b,{socketPath:'/tmp/not-contacted.sock',signal:pre.signal}),{code:'PDF_SERVICE_CANCELLED'});
 let seen!:()=>void;const observed=new Promise<void>(resolve=>{seen=resolve;}),f=await fixture(createServer(()=>{seen();}));try{const c=new AbortController(),pending=f.validate(b,c.signal);await observed;c.abort();await assert.rejects(pending,{code:'PDF_SERVICE_CANCELLED'});}finally{await f.close();}
 const good=await fixture();try{assert.equal((await good.validate(b)).outcome,'screened');}finally{await good.close();}
});
test('mocked fixed PDF client deadline closes a real nonresponding peer without waiting fifteen seconds',async t=>{
 let seen!:()=>void;const observed=new Promise<void>(resolve=>{seen=resolve;}),f=await fixture(createServer(()=>{seen();}));
 try{t.mock.timers.enable({apis:['setTimeout']});const pending=f.validate(Buffer.from('%PDF-1.7\ntransport-only'));await observed;t.mock.timers.tick(15000);await assert.rejects(pending,{code:'PDF_SERVICE_TIMEOUT'});}finally{t.mock.timers.reset();await f.close();}
});
check('two partial PDF bodies occupy only two server slots then timeout and release without invoking the parser',async()=>{
 const f=await fixture(),peers:ReturnType<typeof connect>[]= [];let requests=0,seen!:()=>void;const observed=new Promise<void>(resolve=>{seen=resolve;});f.server.on('request',()=>{if(++requests===2)seen();});
 try{
  for(let i=0;i<2;i++){const s=connect(f.socketPath);s.on('error',()=>{});await new Promise<void>(resolve=>s.once('connect',resolve));s.write('POST /v1/validate-pdf HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/octet-stream\r\nContent-Length: 20\r\nX-Content-Sha256: '+'0'.repeat(64)+'\r\n\r\nx');peers.push(s);}
  await observed;assert.equal((await f.raw(bytes())).status,503);await Promise.all(peers.map(s=>new Promise<void>(resolve=>s.destroyed?resolve():s.once('close',()=>resolve()))));assert.equal((await f.validate(bytes())).outcome,'screened');
 }finally{peers.forEach(s=>s.destroy());await f.close();}
});
