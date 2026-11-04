import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer,request as httpRequest,type Server } from 'node:http';
import { connect as connectSocket } from 'node:net';
import { mkdtemp,rmdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import sharp from 'sharp';
import { createImageValidationServer,validateImageViaService } from '../src/files/image-service.ts';
import { validateImage } from '../src/files/image-validation.ts';
import { assertPrivateImageSocket } from '../src/files/image-runtime.ts';

const sha=(b:Buffer)=>createHash('sha256').update(b).digest('hex');
const png=()=>sharp({create:{width:8,height:4,channels:3,background:'red'}}).png().toBuffer();
async function fixture(server:Server=createImageValidationServer()) {
 // Keep Unix socket paths short on both macOS and Linux runners.
 const directory=await mkdtemp('/tmp/kavosh-image-socket-'),socketPath=directory+'/service.sock';
 await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(socketPath,()=>{server.removeListener('error',reject);resolve();});});
 async function close(){await new Promise<void>((resolve,reject)=>{server.close(error=>error?reject(error):resolve());server.closeAllConnections();});await rmdir(directory);}
 const validate=(b:Buffer,type='image/png',signal?:AbortSignal)=>validateImageViaService(b,type,{socketPath,signal});
 async function raw(b:Buffer,headers:Record<string,string>={},method='POST',path='/v1/validate-image') {
  return new Promise<{status:number;body:string;headers:Record<string,unknown>}>((resolve,reject)=>{
   const req=httpRequest({socketPath,method,path,agent:false,headers:{host:'localhost',connection:'close','content-type':'application/octet-stream','content-length':b.length,'x-image-type':'image/png','x-content-sha256':sha(b),...headers}},res=>{
    let body='';res.setEncoding('utf8');res.on('data',chunk=>{body+=chunk;});res.once('end',()=>resolve({status:res.statusCode!,body,headers:res.headers}));res.once('error',reject);
   });req.once('error',reject);req.end(b);
  });
 }
 return {server,socketPath,validate,raw,close};
}
test('production service command refuses the real non-isolated test host without opening a socket or leaking diagnostics',()=>{
 const r=spawnSync(process.execPath,['--import','tsx','scripts/image-validator-service.ts'],{cwd:new URL('..',import.meta.url),env:{NODE_ENV:'production',TZ:'UTC',PATH:process.env.PATH},encoding:'utf8',timeout:5000});
 assert.equal(r.status,1);assert.equal(r.stdout,'');assert.equal(r.stderr.trim(),'Image validator refused startup; isolated runtime controls are required.');
});
test('production worker socket checks reject the real test socket with non-production ownership and permissions',async()=>{
 const f=await fixture();try{await assert.rejects(assertPrivateImageSocket(f.socketPath),/UNSAFE_IMAGE_SERVICE_SOCKET/);}finally{await f.close();}
});

test('actual private Unix service decodes all five image formats without URLs, credentials or public safety flags',async()=>{
 const f=await fixture();try {
  for(const format of ['png','jpeg','webp','gif','avif'] as const) {
   const bytes=await sharp({create:{width:8,height:4,channels:3,background:'red'}}).toFormat(format).toBuffer(),r=await f.validate(bytes,'image/'+format);
   assert.equal(r.outcome,'decoded',JSON.stringify(r));assert.equal(r.inputSha256,sha(bytes));assert.equal(r.inputBytes,bytes.length);
   for(const forbidden of ['safeToServe','downloadUrl','pixels','exif','storageTargetId','academyId','pid'])assert.equal(forbidden in r,false);
  }
 }finally{await f.close();}
});
test('Unix service validates actual bytes and never mistakes a decoder rejection for service failure',async()=>{
 const f=await fixture();try {
  const bytes=await png(),bad=Buffer.from(bytes);bad[bad.indexOf('IDAT')+8]^=255;
  const r=await f.validate(bad);assert.equal(r.outcome,'rejected');assert.equal(r.outcome==='rejected'?r.reason:null,'DECODER_REJECTED');
  const mismatch=await f.validate(bytes,'image/jpeg');assert.equal(mismatch.outcome,'rejected');assert.equal(mismatch.outcome==='rejected'?mismatch.reason:null,'MIME_MISMATCH');
  assert.equal((await f.raw(bytes,{'x-content-sha256':'0'.repeat(64)})).status,400);
  const v=await f.raw(bytes);assert.equal(v.status,200);assert.equal(v.headers['cache-control'],'no-store');assert.equal(v.headers['x-content-type-options'],'nosniff');
 }finally{await f.close();}
});
test('private service rejects credentials, browser origins, custom destinations, oversized declarations, unknown routes and MIME claims',async()=>{
 const f=await fixture(),b=await png();try {
  for(const headers of [{cookie:'private-cookie'},{authorization:'Bearer private'},{origin:'https://academy.example'},{'x-output-path':'/private/secret'},{'content-encoding':'gzip'},
   {'x-image-type':'image/svg+xml'},{'content-type':'text/html'},{'content-length':'33554433'},{'x-content-sha256':'invalid'}] as Record<string,string>[]) {
   const r=await f.raw(b,headers);assert.equal(r.status,400);assert.doesNotMatch(r.body,/cookie|Bearer|secret|stack/);
  }
  for(const [method,path] of [['GET','/v1/validate-image'],['POST','/elsewhere'],['POST','/v1/validate-image?url=https://localhost']])assert.equal((await f.raw(b,{},method,path)).status,400);
  assert.equal((await f.validate(b)).outcome,'decoded');
 }finally{await f.close();}
});
test('service client copies only the selected bytes and rejects URL/configuration/input ambiguity before socket IO',async()=>{
 const f=await fixture(),b=await png();try {
  const backing=Buffer.concat([b,Buffer.from('PRIVATE_BACKING')]),selected=backing.subarray(0,b.length),pending=f.validate(selected);selected.fill(0);
  const r=await pending;assert.equal(r.outcome,'decoded');assert.equal(r.inputSha256,sha(b));assert.equal(r.inputBytes,b.length);
  for(const socketPath of ['https://localhost','relative.sock','/tmp/../secret.sock','/tmp/./service.sock','/tmp/x\0.sock','/'+ 'a'.repeat(100)])await assert.rejects(validateImageViaService(b,'image/png',{socketPath}),{code:'INVALID_IMAGE_SERVICE_CONFIGURATION'});
  await assert.rejects(f.validate(b,'image/svg+xml'),{code:'UNSUPPORTED_IMAGE_VALIDATION_TYPE'});
  for(const bad of [Buffer.alloc(0),Buffer.alloc(33_554_433),'file:///private' as unknown as Buffer])await assert.rejects(f.validate(bad),{code:'INVALID_IMAGE_VALIDATION_BYTES'});
 }finally{await f.close();}
});
test('strict service client rejects forged, wrong-content, oversized, redirected, malformed and incomplete replies without exposing diagnostics',async()=>{
 const b=await png(),actual=await validateImage(b,'image/png');assert.equal(actual.outcome,'decoded');
 const responses:Array<{status?:number;headers?:Record<string,string>;body:Buffer;declared?:number}>=[
  {body:Buffer.from(JSON.stringify({...actual,inputSha256:'0'.repeat(64)}))},{body:Buffer.from(JSON.stringify({...actual,decodedBytes:1}))},
  {body:Buffer.from(JSON.stringify({...actual,safeToServe:true}))},{body:Buffer.from(JSON.stringify({...actual,validator:'untrusted'}))},
  {body:Buffer.from('PRIVATE_DIAGNOSTIC')},{body:Buffer.from([0xff])},{body:Buffer.from('{}'),declared:4097},
  {body:Buffer.from('{}'),status:307,headers:{location:'https://localhost/secret'}},{body:Buffer.from('{}'),headers:{'content-type':'text/html'}},
  {body:Buffer.from('{}'),declared:10},{body:Buffer.from('{}'),headers:{'content-encoding':'gzip'}}
 ];
 for(const v of responses) {
  const server=createServer((_req,res)=>{res.writeHead(v.status??200,{'content-type':'application/json','content-length':v.declared??v.body.length,connection:'close',...v.headers});res.end(v.body);});
  const f=await fixture(server);try{await assert.rejects(f.validate(b),{code:'IMAGE_SERVICE_UNAVAILABLE'});}finally{await f.close();}
 }
 const good=await fixture();try{assert.equal((await good.validate(b)).outcome,'decoded');}finally{await good.close();}
});
test('pre-cancellation and active cancellation dispose of the socket and release client capacity',async()=>{
 const b=await png(),pre=new AbortController();pre.abort();await assert.rejects(validateImageViaService(b,'image/png',{socketPath:'/private/tmp/not-contacted.sock',signal:pre.signal}),{code:'IMAGE_SERVICE_CANCELLED'});
 let seen!:()=>void;const observed=new Promise<void>(resolve=>{seen=resolve;}),server=createServer(()=>{seen();}),f=await fixture(server);
 try{const stopping=new AbortController(),pending=f.validate(b,'image/png',stopping.signal);await observed;stopping.abort();await assert.rejects(pending,{code:'IMAGE_SERVICE_CANCELLED'});}
 finally{await f.close();}
 const good=await fixture();try{assert.equal((await good.validate(b)).outcome,'decoded');}finally{await good.close();}
});
test('unchanged service-client deadline covers a peer that accepts input but never responds',{timeout:20000},async()=>{
 const b=await png(),f=await fixture(createServer(()=>{})),started=performance.now();
 try{await assert.rejects(f.validate(b),{code:'IMAGE_SERVICE_TIMEOUT'});assert.ok(performance.now()-started>=14000);}
 finally{await f.close();}
});
test('one hundred simultaneous callers allocate only two client/native jobs and recover after overload',async()=>{
 const f=await fixture(),b=await png(),started=performance.now();try {
  const r=await Promise.allSettled(Array.from({length:100},()=>f.validate(b))),success=r.filter(v=>v.status==='fulfilled'),busy=r.filter(v=>v.status==='rejected');
  assert.equal(success.length,2);assert.equal(busy.length,98);for(const v of busy)if(v.status==='rejected')assert.equal(v.reason.code,'IMAGE_SERVICE_BUSY');
  assert.equal((await f.validate(b)).outcome,'decoded');console.log(JSON.stringify({measurement:'synthetic-image-service-burst',requests:100,decoded:2,busy:98,elapsedMs:Math.ceil(performance.now()-started),liveStorageCalls:0}));
 }finally{await f.close();}
});
test('partial uploads consume at most two service slots and actual body timeout releases them without decoding',{timeout:10000},async()=>{
 const f=await fixture(),peers=[];let requests=0,observed!:()=>void;const both=new Promise<void>(resolve=>{observed=resolve;});
 f.server.on('request',()=>{if(++requests===2)observed();});try {
  for(let i=0;i<2;i++) {
   const socket=connectSocket(f.socketPath);socket.on('error',()=>{});await new Promise<void>(resolve=>socket.once('connect',resolve));
   socket.write('POST /v1/validate-image HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/octet-stream\r\nContent-Length: 2\r\nX-Image-Type: image/png\r\nX-Content-Sha256: '+'0'.repeat(64)+'\r\n\r\nx');peers.push(socket);
  }
  await both;assert.equal((await f.raw(await png())).status,503);
  await Promise.all(peers.map(socket=>new Promise<void>(resolve=>socket.destroyed?resolve():socket.once('close',()=>resolve()))));
  assert.equal((await f.validate(await png())).outcome,'decoded');
 }finally{for(const socket of peers)socket.destroy();await f.close();}
});
