import { createHash } from 'node:crypto';
import { open,mkdir,writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

// Build-time public source download only. Every retry uses the SAME reviewed
// HTTPS URL/hash,one whole-download deadline and a fresh bounded buffer. Never
// retry hash/size/policy failures or switch to an unreviewed mirror/version.
export async function downloadVideoSource(release,maximum,options={}){
 const approved=new Map([
  ['https://ffmpeg.org/releases/ffmpeg-9.0.2.tar.xz',['8c3850283eb25fa026482078a04051e0be17347b09ef81a0849bec15a96e002e',33554432]],
  ['https://download.videolan.org/pub/videolan/dav1d/1.5.4/dav1d-1.5.4.tar.xz',['686616b7c69eb88d44459391ab25cac13b6647a3b288835c5784e71c1514a5c5',2097152]]
 ]),expected=approved.get(release?.url),timeout=options.timeoutMs??60000;
 if(!expected||release.sha256!==expected[0]||maximum!==expected[1]||!Number.isInteger(timeout)||timeout<1||timeout>60000||options.fetcher!==undefined&&typeof options.fetcher!=='function'||options.archivePath!==undefined&&(typeof options.archivePath!=='string'||!options.archivePath.startsWith('/')))throw Error('UNREVIEWED_VIDEO_SOURCE');
 // Optional operator-provided build archive:never trust the cache or fall
 // back to network on corruption. Recheck the same pin and size before use.
 if(options.archivePath!==undefined){
  const file=await open(options.archivePath,'r');try{
   if(!(await file.stat()).isFile())throw Error('UNREVIEWED_VIDEO_SOURCE');
   const chunks=[];let size=0;for await(const chunk of file.createReadStream()){size+=chunk.length;if(size>maximum)throw Error('VIDEO_SOURCE_TOO_LARGE');chunks.push(chunk);}
   const bytes=Buffer.concat(chunks,size);if(createHash('sha256').update(bytes).digest('hex')!==release.sha256)throw Error('VIDEO_SOURCE_HASH_MISMATCH');return bytes;
  }finally{await file.close();}
 }
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
// Cache only public reviewed source archives,not binaries or credentials.
// A cache hit has exactly the same hash/size checks as a fresh HTTPS fetch.
export async function cachedVideoSource(release,maximum,archivePath,options={}){
 if(typeof archivePath!=='string'||!archivePath.startsWith('/'))throw Error('UNREVIEWED_VIDEO_SOURCE');
 try{return await downloadVideoSource(release,maximum,{...options,archivePath});}
 catch(error){if(error?.code!=='ENOENT')throw error;}
 const bytes=await downloadVideoSource(release,maximum,options);await mkdir(dirname(archivePath),{recursive:true,mode:0o700});
 try{await writeFile(archivePath,bytes,{mode:0o600,flag:'wx'});}
 catch(error){if(error?.code!=='EEXIST')throw error;return downloadVideoSource(release,maximum,{...options,archivePath});}
 return bytes;
}
