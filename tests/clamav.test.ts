import assert from 'node:assert/strict';
import { createServer,type Socket } from 'node:net';
import { mkdtemp,rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { scanWithClamd,type ClamdConfiguration } from '../src/integrations/clamav.ts';

const content=Buffer.from('Synthetic transport fixture, NOT a malware scanner or EICAR detection test.');
// Independent local protocol peer exercises actual Unix socket I/O. It never
// detects malware, loads signatures or impersonates production scan evidence.
async function fixture(mode='success') {
  const dir=await mkdtemp('/private/tmp/ko-scan-').catch(()=>mkdtemp('/tmp/ko-scan-')),socketPath=dir+'/s';
  const peers=new Set<Socket>(),received:Buffer[]=[],sizes:number[]=[];let connections=0;
  const server=createServer(socket=>{
    connections++;peers.add(socket);socket.on('close',()=>peers.delete(socket));socket.on('error',()=>{});
    let buffer=Buffer.alloc(0),command=false,done=false;
    socket.on('data',(chunk:Buffer)=>{
      if(done)return;buffer=Buffer.concat([buffer,chunk]);
      if(!command){if(buffer.length<10)return;assert.equal(buffer.subarray(0,10).toString(),'zINSTREAM\0');buffer=buffer.subarray(10);command=true;
        if(mode==='early'){socket.write('stream: OK\0');return;}}
      while(buffer.length>=4) {
        const length=buffer.readUInt32BE();if(buffer.length<4+length)return;
        const part=buffer.subarray(4,4+length);buffer=buffer.subarray(4+length);
        if(length){sizes.push(length);received.push(Buffer.from(part));continue;}
        done=true;
        if(mode==='stall')return;
        if(mode==='close'){socket.end('stream: OK');return;}
        const replies:Record<string,Buffer>={detected:Buffer.from('stream: Synthetic.Test.Marker FOUND\0'),error:Buffer.from('INSTREAM size limit exceeded. ERROR\0'),
          unknown:Buffer.from('stream: UNKNOWN\0'),multiple:Buffer.from('stream: OK\0stream: OK\0'),wrong:Buffer.from('other: OK\0'),
          flood:Buffer.alloc(8192,65),highbit:Buffer.from([0xf3,...Buffer.from('tream: OK\0')])};
        const response=replies[mode]??Buffer.from('stream: OK\0');
        if(mode==='fragment'){socket.write(response.subarray(0,3));setImmediate(()=>{if(!socket.destroyed)socket.write(response.subarray(3));});}
        else socket.write(response);
      }
    });
  });
  try{await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(socketPath,resolve);});}
  catch(error){await rm(dir,{recursive:true,force:true});throw error;}
  const config:ClamdConfiguration={socketPath,maximumBytes:1_000_000,timeoutMs:1000};
  return {config,received,sizes,connections:()=>connections,async close(){for(const s of peers)s.destroy();await new Promise<void>(resolve=>server.close(()=>resolve()));await rm(dir,{recursive:true,force:true});}};
}
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
