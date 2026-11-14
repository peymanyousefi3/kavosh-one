import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp,readFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const pythonPath=process.env.TEST_VIDEO_PYTHON_BINARY,ffmpegPath=process.env.TEST_FFMPEG_BINARY,ffprobePath=process.env.TEST_FFPROBE_BINARY;
if(process.env.VIDEO_VALIDATION_TEST_REQUIRED==='true'&&(!pythonPath||!ffmpegPath||!ffprobePath))throw Error('VIDEO_TEST_RUNTIME_REQUIRED');
export const videoRuntimeConfigured=Boolean(pythonPath&&ffmpegPath&&ffprobePath),videoRuntimeOptions={pythonPath:pythonPath!,ffmpegPath:ffmpegPath!,ffprobePath:ffprobePath!};
export async function videoFixture(audio=false,mov=false,extra:string[]=[]){const directory=await mkdtemp(join(tmpdir(),'kavosh-video-test-')),path=directory+'/clip.'+(mov?'mov':'mp4');try{const args=['-hide_banner','-loglevel','error','-f','lavfi','-i','color=c=red:s=64x48:r=4:d=0.5',...audio?['-f','lavfi','-i','sine=frequency=440:duration=0.5']:[],'-c:v','mpeg4',...audio?['-c:a','aac','-shortest']:['-an'],...extra,'-movflags','+faststart','-f',mov?'mov':'mp4',path],r=spawnSync(ffmpegPath!,args,{env:{NODE_ENV:'test',TZ:'UTC'},encoding:'utf8',timeout:10000,maxBuffer:65536});assert.equal(r.status,0,r.stderr);return await readFile(path);}finally{await rm(directory,{recursive:true,force:true});}}
