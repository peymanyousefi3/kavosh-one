import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { createServer,request } from 'node:http';
import { test } from 'node:test';
import { videoRange } from '../src/files/video-range.ts';
import { privateR2 } from '../src/integrations/r2.ts';

const sha='a'.repeat(64),config={accountId:'a'.repeat(32),jurisdiction:'default'as const,bucket:'synthetic-video-ranges',accessKeyId:'synthetic-range-reader',secretAccessKey:'synthetic-not-real-range-secret',maximumUploadBytes:10000},academy='8fbe4060-32ec-46a9-a97d-78ea54fe50e6',file='73e6a708-ad23-484b-9b12-91db85854593',bytes=Buffer.from('synthetic range bytes,not real academy media'),etag='"measured-private-video"',hash=(b:Buffer)=>createHash('sha256').update(b).digest('hex');
async function consume(source:Readable){const chunks:Buffer[]=[];for await(const chunk of source)chunks.push(chunk);return Buffer.concat(chunks);}
test('single byte ranges include browser probes,suffixes,open ends and exact clamping without integer loss',()=>{
 for(const [input,start,end]of [['bytes=0-1',0,1],['bytes=4-',4,9],['bytes=-3',7,9],['bytes=-999999999999999999',0,9],['bytes=2-999999999999999999',2,9],['BYTES=0-0',0,0]]as const){const r=videoRange(10,sha,input);assert.equal(r.status,206);assert.equal(r.start,start);assert.equal(r.end,end);assert.equal(r.length,end-start+1);assert.equal(r.total,10);}
 for(const input of ['bytes=10-','bytes=8-2','bytes=-0','bytes=999999999999999999-'])assert.equal(videoRange(10,sha,input).status,416);
 for(const input of ['bytes=-','bytes=0-1,4-8','items=0-1','bytes= 0-1','bytes=0-1000000000000000000','bytes=NaN-1','bytes=0-1\r\n'])assert.throws(()=>videoRange(10,sha,input),{code:'INVALID_VIDEO_RANGE'});
 assert.equal(videoRange(10,sha,null).status,200);assert.equal(videoRange(10,sha,'bytes=0-1','"sha256-'+sha+'"').status,206);for(const value of ['"different"','W/"sha256-'+sha+'"','Mon, 01 Jan 2024 00:00:00 GMT'])assert.equal(videoRange(10,sha,'bytes=0-1',value).status,200);assert.equal(videoRange(10,sha,'not-a-range',null,true).status,200);
 for(const total of [0,134217729,NaN,1.5])assert.throws(()=>videoRange(total,sha,null),{code:'INVALID_VIDEO_SOURCE'});assert.throws(()=>videoRange(10,'bad',null),{code:'INVALID_VIDEO_SOURCE'});
});
test('conditional range transport binds only a clean object and reports a partial hash,never whole-file proof',async()=>{
 let calls=0;const part=bytes.subarray(2,7),store=privateR2(config,academy,{async handle(req:{method:string;path:string;headers:Record<string,string>}){calls++;assert.equal(req.method,'GET');assert.equal(req.path,'/'+config.bucket+'/academies/'+academy+'/clean/'+file);assert.equal(req.headers.range,'bytes=2-6');assert.equal(req.headers['if-match'],etag);return{response:{statusCode:206,headers:{'content-length':String(part.length),'content-range':'bytes 2-6/'+bytes.length,'content-type':'application/octet-stream',etag},body:Readable.from([part])}};}});
 try{const result=await store.inspectCleanRange(file,{bytes:bytes.length,ifMatch:etag},{start:2,end:6},consume);assert.deepEqual(result.inspection,part);assert.equal(result.bytes,5);assert.equal(result.sha256,hash(part));assert.notEqual(result.sha256,hash(bytes));assert.equal(calls,1);}finally{store.close();}
});
test('range metadata,status,ETag,encoding and complete byte count are checked instead of trusting a partial content label',async()=>{
 const part=bytes.subarray(2,7);for(const patch of [{statusCode:200},{headers:{'content-range':'bytes 2-6/999'}},{headers:{etag:'"changed"'}},{headers:{'content-encoding':'gzip'}},{headers:{'content-length':'4'}},{body:part.subarray(0,4)},{body:Buffer.concat([part,Buffer.from('x')])}]){
  const store=privateR2(config,academy,{async handle(){return{response:{statusCode:206,...patch,headers:{'content-length':'5','content-range':'bytes 2-6/'+bytes.length,'content-type':'application/octet-stream',etag,...'headers'in patch?patch.headers:{}},body:Readable.from(['body'in patch?patch.body:part])}};}});
  try{await assert.rejects(store.inspectCleanRange(file,{bytes:bytes.length,ifMatch:etag},{start:2,end:6},consume),error=>['R2_INVALID_OBJECT','FILE_SIZE_MISMATCH','FILE_ETAG_MISMATCH'].includes((error as{code:string}).code));}finally{store.close();}
 }
});
test('invalid range claims and mutable selectors cannot add a whole-file checksum,destination or changed byte interval',async()=>{
 let calls=0,release!:(value:unknown)=>void,seen!:()=>void;const started=new Promise<void>(r=>seen=r),pending=new Promise<any>(r=>release=r),store=privateR2(config,academy,{async handle(){calls++;seen();return pending;}});
 try{for(const range of [undefined,null,{start:-1,end:2},{start:2,end:1},{start:0,end:bytes.length},{start:0,end:1,url:'https://example.test/'}])await assert.rejects(store.inspectCleanRange(file,{bytes:bytes.length,ifMatch:etag},range as any,consume));for(const claims of [{bytes:bytes.length,ifMatch:'*'},{bytes:bytes.length,ifMatch:etag,sha256:hash(bytes)},{bytes:134217729,ifMatch:etag}])await assert.rejects(store.inspectCleanRange(file,claims,{start:0,end:1},consume));assert.equal(calls,0);
  const range={start:0,end:1},result=store.inspectCleanRange(file,{bytes:bytes.length,ifMatch:etag},range,consume);await started;range.end=9;release({response:{statusCode:206,headers:{'content-length':'2','content-range':'bytes 0-1/'+bytes.length,'content-type':'application/octet-stream',etag},body:Readable.from([bytes.subarray(0,2)])}});assert.deepEqual((await result).inspection,bytes.subarray(0,2));assert.equal(calls,1);
 }finally{store.close();}
});
test('actual loopback HTTP carries the conditional browser-probe range through the official SDK without live provider calls',async()=>{
 let requests=0;const server=createServer((req,res)=>{requests++;assert.equal(req.headers.range,'bytes=0-1');assert.equal(req.headers['if-match'],etag);res.writeHead(206,{'content-length':2,'content-range':'bytes 0-1/'+bytes.length,'content-type':'application/octet-stream',etag});res.end(bytes.subarray(0,2));});await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address();assert.ok(address&&typeof address!=='string');
 const store=privateR2(config,academy,{async handle(req:{path:string;method:string;headers:Record<string,string>}){return new Promise<any>((resolve,reject)=>{const outgoing=request({host:'127.0.0.1',port:address.port,method:req.method,path:req.path,headers:req.headers,agent:false},res=>resolve({response:{statusCode:res.statusCode,headers:res.headers,body:res}}));outgoing.on('error',reject);outgoing.end();});}});
 try{const r=await store.inspectCleanRange(file,{bytes:bytes.length,ifMatch:etag},{start:0,end:1},consume);assert.deepEqual(r.inspection,bytes.subarray(0,2));assert.equal(requests,1);}finally{store.close();await new Promise<void>(resolve=>{server.close(()=>resolve());server.closeAllConnections();});}
});
