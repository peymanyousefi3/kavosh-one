import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { scanWithClamd } from '../src/integrations/clamav.ts';
import { privateR2 } from '../src/integrations/r2.ts';
import { clamdPeer as fixture } from './fixtures/clamd-peer.ts';

const content=Buffer.from('Synthetic transport fixture, NOT a malware scanner or EICAR detection test.');
async function withPeer(mode:string,run:(f:Awaited<ReturnType<typeof fixture>>)=>Promise<void>) {const f=await fixture(mode);try{await run(f);}finally{await f.close();}}
test('scanner streams exact length-prefixed bytes over a private local socket and binds the complete measured hash, not clean eligibility',async()=>{
  await withPeer('success',async f=>{
    const bytes=Buffer.alloc(150_000,97),sha256=createHash('sha256').update(bytes).digest('hex'),source=Readable.from([bytes]);
    const result=await scanWithClamd(f.config,source,{bytes:bytes.length,sha256:sha256.toUpperCase()});
    assert.deepEqual(result,{verdict:'no_detection',bytes:bytes.length,sha256,engine:'clamd'});assert.deepEqual(Buffer.concat(f.received),bytes);assert.ok(f.sizes.every(n=>n<=65536));assert.equal(f.sizes.length,3);assert.equal(source.destroyed,true);
  });
});
test('scanner parses fragmented replies and distinguishes a detection from transport or daemon errors',async()=>{
  for(const mode of ['fragment','detected'])await withPeer(mode,async f=>{const r=await scanWithClamd(f.config,Readable.from([content]),{bytes:content.length});assert.equal(r.verdict,mode==='detected'?'detected':'no_detection');});
});
test('scanner rejects daemon limits, unknown statuses, wrong stream names, duplicate frames, non-ASCII replies and unbounded output',async()=>{
  for(const mode of ['error','unknown','multiple','wrong','highbit','flood'])await withPeer(mode,async f=>{
    await assert.rejects(scanWithClamd(f.config,Readable.from([content]),{bytes:content.length}),{code:'SCANNER_INVALID_REPLY',status:503});
  });
});
test('scanner rejects truncated, oversized and hash-mismatched streams rather than accepting partial inspection',async()=>{
  for(const bytes of [content.length-1,content.length+1])await withPeer('success',async f=>{
    await assert.rejects(scanWithClamd(f.config,Readable.from([content]),{bytes}),{code:'FILE_SIZE_MISMATCH',status:409});
  });
  await withPeer('success',async f=>{await assert.rejects(scanWithClamd(f.config,Readable.from([content]),{bytes:content.length,sha256:'0'.repeat(64)}),{code:'FILE_HASH_MISMATCH',status:409});});
});
test('scanner reply before full input, missing terminator and timeout all fail closed and release the stream/socket',async()=>{
  await withPeer('early',async f=>{
    let sent=false;const source=new Readable({read(){if(!sent){sent=true;this.push(content.subarray(0,1));}}});
    await assert.rejects(scanWithClamd(f.config,source,{bytes:content.length}),{code:'SCANNER_INVALID_REPLY',status:503});assert.equal(source.destroyed,true);
  });
  for(const [mode,code] of [['close','SCANNER_INCOMPLETE_REPLY'],['stall','SCANNER_TIMEOUT']])await withPeer(mode,async f=>{
    const source=Readable.from([content]);await assert.rejects(scanWithClamd({...f.config,timeoutMs:100},source,{bytes:content.length}),{code,status:503});assert.equal(source.destroyed,true);
  });
});
test('scanner unavailable and source failures cannot leak private diagnostics or return successful evidence',async()=>{
  const source=Readable.from([content]);await assert.rejects(scanWithClamd({socketPath:'/tmp/ko-missing-scanner.sock',maximumBytes:1000,timeoutMs:500},source,{bytes:content.length}),{code:'SCANNER_UNAVAILABLE',status:503});assert.equal(source.destroyed,true);
  await withPeer('success',async f=>{
    const broken=new Readable({read(){this.destroy(new Error('Private synthetic storage error'));}});
    await assert.rejects(scanWithClamd(f.config,broken,{bytes:content.length}),{code:'SCANNER_STREAM_FAILED',status:503});assert.equal(broken.destroyed,true);
  });
});
test('invalid scanner configuration and claims cannot choose remote hosts, execute a command or expand the size budget',async()=>{
  await withPeer('success',async f=>{
    for(const patch of [{socketPath:'tcp://localhost:3310'},{socketPath:'../../private'},{socketPath:'/bad\nconfig'},{maximumBytes:0},{timeoutMs:0},{command:'execute'}])
      await assert.rejects(scanWithClamd({...f.config,...patch},Readable.from([content]),{bytes:content.length}),{code:'SCANNER_NOT_CONFIGURED',status:503});
    for(const claims of [{bytes:0},{bytes:1_000_001},{bytes:1.5},{bytes:1,sha256:'invalid'},{bytes:1,filename:'/etc/passwd'}])
      await assert.rejects(scanWithClamd(f.config,Readable.from([content]),claims),{code:'INVALID_SCAN_CLAIMS',status:400});
    assert.equal(f.connections(),0);
  });
});
test('simulated S3 object transport composes with actual local scanner-protocol I/O, preserving detection and failing closed on daemon error',async()=>{
  for(const mode of ['success','detected','error','stall'])await withPeer(mode,async f=>{
    const body=Readable.from([content.subarray(0,5),content.subarray(5)]),store=privateR2({accountId:'a'.repeat(32),jurisdiction:'default',bucket:'synthetic-private-files',accessKeyId:'synthetic-access-id',secretAccessKey:'synthetic-r2-secret-not-a-real-key',maximumUploadBytes:1000},'8fbe4060-32ec-46a9-a97d-78ea54fe50e6',{
      async handle(){return {response:{statusCode:200,headers:{'content-length':String(content.length),'content-type':'application/octet-stream',etag:'"synthetic-etag"'},body}};}
    });
    try {
      const operation=store.inspectQuarantine('73e6a708-ad23-484b-9b12-91db85854593',{bytes:content.length},(source,signal)=>scanWithClamd(f.config,source,{bytes:content.length},signal),mode==='stall'?100:5000);
      if(mode==='stall')await assert.rejects(operation,{code:'R2_INSPECTION_TIMEOUT',status:502});
      else if(mode==='error')await assert.rejects(operation,{code:'R2_INSPECTION_UNAVAILABLE',status:502});
      else {const result=await operation;assert.equal(result.inspection.verdict,mode==='detected'?'detected':'no_detection');assert.equal(result.sha256,result.inspection.sha256);assert.equal(result.bytes,result.inspection.bytes);assert.deepEqual(Buffer.concat(f.received),content);}
      assert.equal(body.destroyed,true);
    }finally{store.close();}
  });
});
