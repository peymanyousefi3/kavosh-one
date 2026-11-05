import assert from 'node:assert/strict';
import { createServer,type Socket } from 'node:net';
import { mkdtemp,rm } from 'node:fs/promises';
import type { ClamdConfiguration } from '../../src/integrations/clamav.ts';
import { Temporal } from '@js-temporal/polyfill';

export function clamdVersionString(at=Date.now()-60000,zone='UTC',serial=30001,engine='1.5.4'){
  const d=Temporal.Instant.fromEpochMilliseconds(at).toZonedDateTimeISO(zone),pad=(n:number)=>String(n).padStart(2,'0');
  return 'ClamAV '+engine+'/'+serial+'/'+['Mon','Tue','Wed','Thu','Fri','Sat','Sun'][d.dayOfWeek-1]+' '+['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][d.month-1]+' '+String(d.day).padStart(2,' ')+' '+pad(d.hour)+':'+pad(d.minute)+':'+pad(d.second)+' '+d.year;
}

// Independent protocol peer, NOT an engine, signature database or malware test.
export async function clamdPeer(mode='success',versionReplies:ReadonlyArray<Buffer|null>=[]) {
  const dir=await mkdtemp('/private/tmp/ko-scan-').catch(()=>mkdtemp('/tmp/ko-scan-')),socketPath=dir+'/s';
  const peers=new Set<Socket>(),received:Buffer[]=[],sizes:number[]=[],commands:string[]=[];let connections=0,versionReads=0;
  const server=createServer(socket=>{
    connections++;peers.add(socket);socket.on('close',()=>peers.delete(socket));socket.on('error',()=>{});
    let buffer=Buffer.alloc(0),command=false,done=false;
    socket.on('data',(chunk:Buffer)=>{
      if(done)return;buffer=Buffer.concat([buffer,chunk]);
      if(!command){
        if(buffer.length>=9&&buffer.subarray(0,9).toString()==='zVERSION\0'){
          done=true;commands.push('VERSION');const configured=versionReplies[versionReads++],response=configured===undefined?Buffer.from('ClamAV 1.5.4\0'):configured;
          if(response!==null){
            if(mode==='fragment'){socket.write(response.subarray(0,3));setImmediate(()=>{if(!socket.destroyed)socket.end(response.subarray(3));});}
            else if(mode==='trailing-version'){socket.write(response);setImmediate(()=>{if(!socket.destroyed)socket.end('unexpected');});}
            else socket.end(response);
          }return;
        }
        if(buffer.length<10)return;assert.equal(buffer.subarray(0,10).toString(),'zINSTREAM\0');commands.push('INSTREAM');buffer=buffer.subarray(10);command=true;if(mode==='early'){socket.write('stream: OK\0');return;}
      }
      while(buffer.length>=4) {
        const length=buffer.readUInt32BE();if(buffer.length<4+length)return;const part=buffer.subarray(4,4+length);buffer=buffer.subarray(4+length);
        if(length){sizes.push(length);received.push(Buffer.from(part));continue;}done=true;
        if(mode==='stall')return;if(mode==='close'){socket.end('stream: OK');return;}
        const replies:Record<string,Buffer>={detected:Buffer.from('stream: Synthetic.Test.Marker FOUND\0'),error:Buffer.from('INSTREAM size limit exceeded. ERROR\0'),unknown:Buffer.from('stream: UNKNOWN\0'),multiple:Buffer.from('stream: OK\0stream: OK\0'),wrong:Buffer.from('other: OK\0'),flood:Buffer.alloc(8192,65),highbit:Buffer.from([0xf3,...Buffer.from('tream: OK\0')]),newline:Buffer.from('stream: OK\n\0'),carriage:Buffer.from('stream: OK\r\0'),detected_newline:Buffer.from('stream: Synthetic.Test.Marker FOUND\n\0')};
        const response=replies[mode]??Buffer.from('stream: OK\0');if(mode==='fragment'){socket.write(response.subarray(0,3));setImmediate(()=>{if(!socket.destroyed)socket.write(response.subarray(3));});}else socket.write(response);
      }
    });
  });
  try{await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(socketPath,resolve);});}catch(error){await rm(dir,{recursive:true,force:true});throw error;}
  const config:ClamdConfiguration={socketPath,maximumBytes:1_000_000,timeoutMs:1000};
  return {config,received,sizes,commands,server,connections:()=>connections,async close(){for(const s of peers)s.destroy();await new Promise<void>(resolve=>server.close(()=>resolve()));await rm(dir,{recursive:true,force:true});}};
}
