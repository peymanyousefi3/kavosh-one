import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

// Build-time public source download only. Every retry uses the SAME reviewed
// HTTPS URL/hash,one whole-download deadline and a fresh bounded buffer. Never
// retry hash/size/policy failures or switch to an unreviewed mirror/version.
export async function downloadVideoSource(release,maximum,options={}){
 const approved=new Map([
  ['https://ffmpeg.org/releases/ffmpeg-9.0.2.tar.xz',['8c3850283eb25fa026482078a04051e0be17347b09ef81a0849bec15a96e002e',33554432]],
  ['https://download.videolan.org/pub/videolan/dav1d/1.5.4/dav1d-1.5.4.tar.xz',['686616b7c69eb88d44459391ab25cac13b6647a3b288835c5784e71c1514a5c5',2097152]]
 ]),expected=approved.get(release?.url),timeout=options.timeoutMs??60000;
 if(!expected||release.sha256!==expected[0]||maximum!==expected[1]||!Number.isInteger(timeout)||timeout<1||timeout>60000||options.fetcher!==undefined&&typeof options.fetcher!=='function')throw Error('UNREVIEWED_VIDEO_SOURCE');
 const signal=AbortSignal.timeout(timeout),fetcher=options.fetcher??fetch,transient=new Set(['UND_ERR_CONNECT_TIMEOUT','UND_ERR_HEADERS_TIMEOUT','UND_ERR_SOCKET','ECONNRESET','ECONNREFUSED','ETIMEDOUT','EAI_AGAIN']);
 for(let attempt=0;attempt<3;attempt++){
  try{
   const response=await fetcher(release.url,{redirect:'error',signal});
   if(!response.ok||!response.body){await response.body?.cancel().catch(()=>{});if(response.status===408||response.status===429||response.status>=500&&response.status<=599)throw Object.assign(Error('VIDEO_SOURCE_UNAVAILABLE'),{retryable:true});throw Error('VIDEO_SOURCE_UNAVAILABLE');}
   const chunks=[];let size=0;for await(const chunk of response.body){size+=chunk.length;if(size>maximum)throw Error('VIDEO_SOURCE_TOO_LARGE');chunks.push(chunk);}
   if(signal.aborted)throw Error('VIDEO_SOURCE_UNAVAILABLE');const bytes=Buffer.concat(chunks,size);if(createHash('sha256').update(bytes).digest('hex')!==release.sha256)throw Error('VIDEO_SOURCE_HASH_MISMATCH');return bytes;
  }catch(error){
   if(signal.aborted)throw Error('VIDEO_SOURCE_UNAVAILABLE');
   if(error?.message==='VIDEO_SOURCE_HASH_MISMATCH'||error?.message==='VIDEO_SOURCE_TOO_LARGE')throw error;
   if(attempt===2||!(error?.retryable===true||transient.has(error?.cause?.code)||transient.has(error?.code)))throw Error('VIDEO_SOURCE_UNAVAILABLE');
   try{await delay(100*(attempt+1),undefined,{signal});}catch{throw Error('VIDEO_SOURCE_UNAVAILABLE');}
  }
 }
 throw Error('VIDEO_SOURCE_UNAVAILABLE');
}
