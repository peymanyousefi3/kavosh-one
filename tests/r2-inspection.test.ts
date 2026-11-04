import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { privateR2 } from '../src/integrations/r2.ts';

const academy='8fbe4060-32ec-46a9-a97d-78ea54fe50e6',file='73e6a708-ad23-484b-9b12-91db85854593';
const content=Buffer.from('Synthetic object transport, not an actual R2 file.');
const config={accountId:'a'.repeat(32),jurisdiction:'default' as const,bucket:'synthetic-private-files',accessKeyId:'synthetic-access-id',secretAccessKey:'synthetic-r2-secret-not-a-real-key',maximumUploadBytes:1_000_000};
function fixture(body:Readable=Readable.from([content]),headers:Record<string,string>={},statusCode=200) {
  let requests=0;const store=privateR2(config,academy,{async handle(request:{method:string;hostname:string;path:string;query?:Record<string,unknown>}){
    requests++;assert.equal(request.method,'GET');assert.equal(request.hostname,config.accountId+'.r2.cloudflarestorage.com');
    assert.equal(request.path,'/'+config.bucket+'/academies/'+academy+'/quarantine/'+file);assert.equal(request.query?.['response-content-disposition'],undefined);
    return {response:{statusCode,headers:{'content-length':String(content.length),'content-type':'application/octet-stream',etag:'"synthetic-opaque-etag"',...headers},body}};
  }});
  return {store,body,requests:()=>requests};
}
async function consume(source:Readable){let bytes=0;for await(const chunk of source)bytes+=chunk.length;return {consumedBytes:bytes};}
test('R2 inspection streams a complete academy-bound quarantine object and measures hash separately from provider metadata',async()=>{
  const f=fixture();try {
    const sha256=createHash('sha256').update(content).digest('hex'),result=await f.store.inspectQuarantine(file,{bytes:content.length,sha256},consume);
    assert.deepEqual(result,{bytes:content.length,sha256,provider:{etag:'"synthetic-opaque-etag"',contentType:'application/octet-stream'},inspection:{consumedBytes:content.length}});
    assert.equal(f.requests(),1);assert.equal(f.body.destroyed,true);assert.equal('clean' in result,false);
  }finally{f.store.close();}
});
test('R2 inspection rejects inconsistent object lengths, truncated content, oversized content and hash mismatches',async()=>{
  for(const [body,headers] of [[Readable.from([content]),{'content-length':String(content.length+1)}],[Readable.from([content.subarray(1)]),{}],[Readable.from([content,Buffer.from('extra')]),{}]] as const) {
    const f=fixture(body,headers);try{await assert.rejects(f.store.inspectQuarantine(file,{bytes:content.length},consume),{code:'FILE_SIZE_MISMATCH',status:409});assert.equal(body.destroyed,true);}finally{f.store.close();}
  }
  const f=fixture();try{await assert.rejects(f.store.inspectQuarantine(file,{bytes:content.length,sha256:'0'.repeat(64)},consume),{code:'FILE_HASH_MISMATCH',status:409});}finally{f.store.close();}
});
test('R2 incomplete inspection and consumer errors cannot create complete-byte evidence or expose private scanner diagnostics',async()=>{
  for(const [inspect,code] of [[async()=>({ignored:true}),'R2_INCOMPLETE_INSPECTION'],[async()=>{throw new Error('Private synthetic scanner diagnostic');},'R2_INSPECTION_UNAVAILABLE']] as const) {
    const f=fixture();try{await assert.rejects(f.store.inspectQuarantine(file,{bytes:content.length},inspect),{code,status:502});}finally{f.store.close();assert.equal(f.body.destroyed,true);}
  }
});
test('R2 invalid provider metadata and private HTTP failures fail closed without leaking the response body',async()=>{
  const variants:Record<string,string>[]=[{etag:''},{etag:'W/"weak"'},{'content-type':'bad\nheader'}];
  for(const headers of variants) {
    const f=fixture(Readable.from([content]),headers);try{await assert.rejects(f.store.inspectQuarantine(file,{bytes:content.length},consume),{code:'R2_INVALID_OBJECT',status:502});}finally{f.store.close();}
  }
  const f=fixture(Readable.from([Buffer.from('<Error><Code>AccessDenied</Code><Message>private synthetic error</Message></Error>')]),{},403);
  try{await assert.rejects(f.store.inspectQuarantine(file,{bytes:content.length},consume),{code:'R2_INSPECTION_UNAVAILABLE',status:502});}finally{f.store.close();}
});
test('R2 inspection deadline aborts a stalled stream, while source failures are sanitized',async()=>{
  for(const stall of [true,false]) {
    const body=new Readable({read(){if(!stall)this.destroy(new Error('Private synthetic object failure'));}}),f=fixture(body);
    try{await assert.rejects(f.store.inspectQuarantine(file,{bytes:content.length},consume,100),{code:stall?'R2_INSPECTION_TIMEOUT':'R2_INSPECTION_UNAVAILABLE',status:502});assert.equal(body.destroyed,true);}finally{f.store.close();}
  }
});
test('R2 absolute deadline also rejects an inspector stalled after the entire object was consumed', {timeout:2000},async()=>{
  const f=fixture();let signal:AbortSignal|undefined;
  try {
    await assert.rejects(f.store.inspectQuarantine(file,{bytes:content.length},async(source,cancel)=>{signal=cancel;await consume(source);return new Promise<never>(()=>{});},100),{code:'R2_INSPECTION_TIMEOUT',status:502});
    assert.equal(signal?.aborted,true);assert.equal(f.body.destroyed,true);
  }finally{f.store.close();}
});
test('R2 external cancellation rejects a post-EOF stalled inspector and pre-cancelled requests do not contact storage',{timeout:2000},async()=>{
  const f=fixture(),controller=new AbortController();try {
    await assert.rejects(f.store.inspectQuarantine(file,{bytes:content.length},async source=>{await consume(source);controller.abort();return new Promise<never>(()=>{});},5000,controller.signal),{code:'R2_INSPECTION_CANCELLED',status:502});assert.equal(f.body.destroyed,true);
  }finally{f.store.close();}
  const untouched=fixture();try{await assert.rejects(untouched.store.inspectQuarantine(file,{bytes:content.length},consume,5000,controller.signal),{code:'R2_INSPECTION_CANCELLED',status:502});assert.equal(untouched.requests(),0);}finally{untouched.store.close();untouched.body.destroy();}
});
test('R2 inspection rejects paths, invalid claims, timeouts and closed handles before making a storage request',async()=>{
  const f=fixture();try {
    for(const claims of [{bytes:0},{bytes:1_000_001},{bytes:content.length,sha256:'invalid'},{bytes:content.length,clean:true}])await assert.rejects(f.store.inspectQuarantine(file,claims,consume),{code:'INVALID_INSPECTION_CLAIMS',status:400});
    for(const timeout of [0,600001,Infinity,1.5])await assert.rejects(f.store.inspectQuarantine(file,{bytes:content.length},consume,timeout),{code:'INVALID_INSPECTION_TIMEOUT',status:400});
    await assert.rejects(f.store.inspectQuarantine('../clean/'+file,{bytes:content.length},consume),{code:'INVALID_FILE_ID',status:400});f.store.close();
    await assert.rejects(f.store.inspectQuarantine(file,{bytes:content.length},consume),{code:'R2_CONNECTION_CLOSED',status:503});assert.equal(f.requests(),0);
  }finally{f.store.close();f.body.destroy();}
});
