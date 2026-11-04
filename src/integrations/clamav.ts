import { createConnection } from 'node:net';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { z } from 'zod';
import { ApiError } from '../core/policy.ts';

const configuration=z.object({socketPath:z.string().min(2).max(100).refine(v=>v.startsWith('/')&&!/[\0\r\n]/.test(v)&&!v.split('/').includes('..')),
  maximumBytes:z.number().int().min(1).max(4_294_967_296),timeoutMs:z.number().int().min(1).max(600_000)}).strict();
const claims=z.object({bytes:z.number().int().min(1).max(4_294_967_296),sha256:z.string().regex(/^[a-fA-F0-9]{64}$/).transform(v=>v.toLowerCase()).optional()}).strict();
export type ClamdConfiguration=z.input<typeof configuration>;

// Official ClamAV engine over its existing INSTREAM protocol; no custom malware
// detector. Private operator-configured Unix socket only, never a request URL.
// https://docs.clamav.net/manual/Usage/ClamdProtocol.html
// Avoid clamdscan's send_stream_fd_common(..., false), which can truncate at its
// client StreamMaxLength without proving the daemon scanned all supplied bytes:
// https://github.com/Cisco-Talos/clamav/blob/main/common/clamdcom.c
// No local files, shell, subprocess, network hostname or inherited credentials.
// no_detection is NOT clean eligibility: deployment configuration/signature
// freshness, content inspection and durable worker evidence are still required.
export async function scanWithClamd(config:ClamdConfiguration,source:Readable,expected:z.input<typeof claims>) {
  const parsed=configuration.safeParse(config),input=claims.safeParse(expected);
  if(!parsed.success)throw new ApiError(503,'SCANNER_NOT_CONFIGURED');
  if(!input.success||input.data.bytes>parsed.data.maximumBytes)throw new ApiError(400,'INVALID_SCAN_CLAIMS');
  const c=parsed.data,claim=input.data,hash=createHash('sha256'),socket=createConnection({path:c.socketPath});
  let bytes=0,reply=Buffer.alloc(0),finishedInput=false,failure:ApiError|undefined;
  function stop(code:string) {failure??=new ApiError(503,code);source.destroy();socket.destroy(failure);}
  const completion=new Promise<'no_detection'|'detected'>((resolve,reject)=>{
    let settled=false;
    socket.on('error',()=>{settled=true;reject(failure??new ApiError(503,'SCANNER_UNAVAILABLE'));});
    socket.once('close',()=>{if(!settled)reject(new ApiError(503,'SCANNER_INCOMPLETE_REPLY'));});
    socket.on('data',(chunk:Buffer)=>{
      if(settled)return;
      if(reply.length+chunk.length>4096){stop('SCANNER_INVALID_REPLY');return;}
      reply=Buffer.concat([reply,chunk]);const end=reply.indexOf(0);if(end===-1)return;
      if(reply.some(byte=>byte>127)){stop('SCANNER_INVALID_REPLY');return;}
      const text=reply.subarray(0,end).toString('ascii');
      if(!finishedInput||end!==reply.length-1||!(/^(?:stream: OK|stream: [\x20-\x7e]{1,500} FOUND)$/.test(text))){stop('SCANNER_INVALID_REPLY');return;}
      settled=true;resolve(text==='stream: OK'?'no_detection':'detected');
    });
  });
  const deadline=setTimeout(()=>stop('SCANNER_TIMEOUT'),c.timeoutMs);
  async function* frame(chunks:AsyncIterable<Buffer>) {
    yield Buffer.from('zINSTREAM\0');
    for await(const chunk of chunks) {
      bytes+=chunk.length;
      if(bytes>claim.bytes){failure=new ApiError(409,'FILE_SIZE_MISMATCH');throw failure;}
      hash.update(chunk);
      for(let offset=0;offset<chunk.length;offset+=65536) {
        const part=chunk.subarray(offset,offset+65536),length=Buffer.alloc(4);length.writeUInt32BE(part.length);yield length;yield part;
      }
    }
    if(bytes!==claim.bytes){failure=new ApiError(409,'FILE_SIZE_MISMATCH');throw failure;}
    finishedInput=true;yield Buffer.alloc(4);
  }
  try {
    const sending=pipeline(source,frame,socket,{end:false}).catch(()=>{stop('SCANNER_STREAM_FAILED');});
    const [verdict]=await Promise.all([completion,sending]);if(failure)throw failure;
    const sha256=hash.digest('hex');if(claim.sha256&&sha256!==claim.sha256)throw new ApiError(409,'FILE_HASH_MISMATCH');
    return {verdict,bytes,sha256,engine:'clamd' as const};
  } finally {clearTimeout(deadline);source.destroy();socket.destroy();}
}
