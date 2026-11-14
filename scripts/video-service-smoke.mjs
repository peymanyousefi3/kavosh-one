import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp,readFile,rm,writeFile,readdir } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { assertIsolatedVideoRuntime,assertPrivateVideoSocket,videoServiceSocket,videoServiceFfmpeg,videoServicePython,videoServiceFfprobe } from '../src/files/video-runtime.js';
import { validateVideoViaService } from '../src/files/video-service.js';
import { validateVideo,videoValidationSchema } from '../src/files/video-validation.js';
import { detectContentSignature } from '../src/files/content-signature.js';
import { videoCodecCases } from './video-codec-fixtures.mjs';

await assertIsolatedVideoRuntime();const directory=await mkdtemp('/tmp/ko-video-smoke-'),path=directory+'/clip.mp4';let bytes;
try{const generated=spawnSync(videoServiceFfmpeg,['-hide_banner','-loglevel','error','-f','lavfi','-i','color=c=red:s=64x48:r=4:d=0.5','-c:v','mpeg4','-an','-movflags','+faststart','-f','mp4',path],{env:{NODE_ENV:'test',TZ:'UTC'},encoding:'utf8',timeout:10000,maxBuffer:65536});assert.equal(generated.status,0);bytes=await readFile(path);}finally{await rm(directory,{recursive:true,force:true});}
// Wait only for actual socket startup,not repeated opaque decoder failures.
// Probe each real layer separately;all diagnostic input is the tiny synthetic
// clip above,and only bounded proof/error categories enter the CI log.
let ready=false;for(let n=0;n<100;n++){try{await assertPrivateVideoSocket(videoServiceSocket);ready=true;break;}catch{await delay(100);}}
assert.ok(ready,'Private video socket failed to become ready');
const signature=await detectContentSignature(bytes);assert.equal(signature.mime,'video/mp4');console.log('video_container_signature_passed');
const nativeDirectory=await mkdtemp('/tmp/ko-video-native-smoke-');
try{const native=spawnSync(videoServicePython,['-I','-B','/app/src/files/video-inspector.py',videoServiceFfmpeg,videoServiceFfprobe,'video/mp4',nativeDirectory],{input:bytes,env:{NODE_ENV:'production',TZ:'UTC'},encoding:'utf8',timeout:10000,maxBuffer:16384}),category=/^video_inspector_error:([A-Za-z_]+)$/.exec(native.stderr?.trim()??'')?.[1]??'unclassified';assert.equal(native.status,0,JSON.stringify({layer:'native-python',status:native.status,signal:native.signal,category}));const proof=videoValidationSchema.parse(JSON.parse(native.stdout));assert.equal(proof.outcome,'decoded',JSON.stringify(proof));console.log('video_container_native_decode_passed');}finally{await rm(nativeDirectory,{recursive:true,force:true});}
const direct=await validateVideo(bytes,'video/mp4',{pythonPath:videoServicePython,ffmpegPath:videoServiceFfmpeg,ffprobePath:videoServiceFfprobe});assert.equal(direct.outcome,'decoded',JSON.stringify(direct));console.log('video_container_broker_passed');
const validate=()=>validateVideoViaService(bytes,'video/mp4',{socketPath:videoServiceSocket}),result=await validate();assert.equal(result.inputSha256,createHash('sha256').update(bytes).digest('hex'));assert.equal(result.outcome,'decoded',JSON.stringify(result));assert.equal(result.videoFrames,2);assert.equal(result.validator,'ffmpeg@9.0.2');assert.equal('safeToServe'in result,false);
for(const item of videoCodecCases){const sample=await readFile('/fixtures/'+item.name+'.'+item.format),proof=await validateVideoViaService(sample,item.mime,{socketPath:videoServiceSocket});assert.equal(proof.outcome,'decoded',JSON.stringify(proof));assert.equal(proof.codec,item.codec);assert.equal(proof.videoFrames,2);assert.equal(proof.inputSha256,createHash('sha256').update(sample).digest('hex'));assert.equal(proof.audio?.codec??null,item.audio??null);}
await assert.rejects(writeFile('/app/video-service-read-only-probe','no'),e=>['EROFS','EACCES'].includes(e.code));const outcomes=await Promise.allSettled([validate(),validate()]);assert.equal(outcomes.filter(r=>r.status==='fulfilled').length,1);assert.equal(outcomes.filter(r=>r.status==='rejected').length,1);assert.equal((await validate()).outcome,'decoded');assert.equal((await readdir('/tmp')).filter(p=>p.startsWith('kavosh-video-input-')).length,0);
console.log(JSON.stringify({measurement:'actual-isolated-video-container',uid:process.getuid(),decoder:result.validator,videoFrames:result.videoFrames,codecFixtures:videoCodecCases.length,privateInputCleanupVerified:true,requests:2,admitted:1,busy:1,peakRssKiB:result.resources.peakRssKiB,liveStorageCalls:0,liveProviderCalls:0,playbackVerified:false}));
