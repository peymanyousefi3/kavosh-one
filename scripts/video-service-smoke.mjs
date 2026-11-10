import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp,readFile,rm,writeFile,readdir } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { assertIsolatedVideoRuntime,assertPrivateVideoSocket,videoServiceSocket,videoServiceFfmpeg } from '../src/files/video-runtime.js';
import { validateVideoViaService } from '../src/files/video-service.js';

await assertIsolatedVideoRuntime();const directory=await mkdtemp('/tmp/ko-video-smoke-'),path=directory+'/clip.mp4';let bytes;
try{const generated=spawnSync(videoServiceFfmpeg,['-hide_banner','-loglevel','error','-f','lavfi','-i','color=c=red:s=64x48:r=4:d=0.5','-c:v','mpeg4','-an','-movflags','+faststart','-f','mp4',path],{env:{NODE_ENV:'test',TZ:'UTC'},encoding:'utf8',timeout:10000,maxBuffer:65536});assert.equal(generated.status,0);bytes=await readFile(path);}finally{await rm(directory,{recursive:true,force:true});}
const validate=()=>validateVideoViaService(bytes,'video/mp4',{socketPath:videoServiceSocket});let ready=false;
for(let n=0;n<100;n++){try{assert.equal((await validate()).outcome,'decoded');ready=true;break;}catch{await delay(100);}}
assert.ok(ready,'Private video service failed to become ready');await assertPrivateVideoSocket(videoServiceSocket);const result=await validate();assert.equal(result.inputSha256,createHash('sha256').update(bytes).digest('hex'));assert.equal(result.outcome,'decoded');assert.equal(result.videoFrames,2);assert.equal(result.validator,'ffmpeg@9.0.2');assert.equal('safeToServe'in result,false);
await assert.rejects(writeFile('/app/video-service-read-only-probe','no'),e=>['EROFS','EACCES'].includes(e.code));const outcomes=await Promise.allSettled([validate(),validate()]);assert.equal(outcomes.filter(r=>r.status==='fulfilled').length,1);assert.equal(outcomes.filter(r=>r.status==='rejected').length,1);assert.equal((await validate()).outcome,'decoded');assert.equal((await readdir('/tmp')).filter(p=>p.startsWith('kavosh-video-input-')).length,0);
console.log(JSON.stringify({measurement:'actual-isolated-video-container',uid:process.getuid(),decoder:result.validator,videoFrames:result.videoFrames,privateInputCleanupVerified:true,requests:2,admitted:1,busy:1,peakRssKiB:result.resources.peakRssKiB,liveStorageCalls:0,liveProviderCalls:0,playbackVerified:false}));
