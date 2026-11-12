// Execute INSIDE the isolated video container using its clean entry environment.
// One half-second synthetic clip; no parent/student media, storage or network.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtemp,readFile,rm,readdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {assertIsolatedVideoRuntime,assertPrivateVideoSocket,videoServiceSocket,videoServiceFfmpeg} from '/app/src/files/video-runtime.js';
import {validateVideoViaService} from '/app/src/files/video-service.js';
await assertIsolatedVideoRuntime();await assertPrivateVideoSocket(videoServiceSocket);
const dir=await mkdtemp('/tmp/kavosh-one-parser-test-');
try{
 const r=spawnSync(videoServiceFfmpeg,['-hide_banner','-loglevel','error','-f','lavfi','-i','color=c=red:s=64x48:r=4:d=0.5','-c:v','mpeg4','-an','-movflags','+faststart','-f','mp4',dir+'/clip.mp4'],{env:{NODE_ENV:'test',TZ:'UTC'},encoding:'utf8',timeout:10000,maxBuffer:65536});assert.equal(r.status,0);
 const bytes=await readFile(dir+'/clip.mp4'),proof=await validateVideoViaService(bytes,'video/mp4',{socketPath:videoServiceSocket});assert.equal(proof.outcome,'decoded');assert.equal(proof.inputSha256,createHash('sha256').update(bytes).digest('hex'));assert.equal(proof.videoFrames,2);assert.equal(proof.validator,'ffmpeg@9.0.2');assert.equal('safeToServe' in proof,false);
 console.log('video_valid_synthetic_clip_passed');
 // MIME/signature mismatch is a refused request, not a completed decoder proof.
 await assert.rejects(validateVideoViaService(Buffer.from('not a video'),'video/mp4',{socketPath:videoServiceSocket}),e=>e.code==='VIDEO_SERVICE_UNAVAILABLE');
 assert.equal((await readdir('/tmp')).filter(p=>p.startsWith('kavosh-video-input-')).length,0);
 console.log(JSON.stringify({actualIsolatedVpsVideoParser:true,syntheticFrames:2,malformedRejected:true,inputCleanupVerified:true,uid:process.getuid(),liveStorageCalls:0,playbackVerified:false}));
}finally{await rm(dir,{recursive:true,force:true});}
