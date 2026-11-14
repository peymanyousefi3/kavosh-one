import { spawnSync } from 'node:child_process';
import { mkdir,chmod } from 'node:fs/promises';
import { isAbsolute,resolve,join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Disposable test encoder only,NEVER the product decoder or user-supplied IO.
// Every clip is two64x64solid-color frames with optional synthetic sine audio.
export const videoCodecCases=[
 {name:'h264',codec:'h264',encoder:'libx264',format:'mp4',mime:'video/mp4',args:['-preset','ultrafast']},
 {name:'h264-aac',codec:'h264',encoder:'libx264',audio:'aac',audioEncoder:'aac',format:'mp4',mime:'video/mp4',args:['-preset','ultrafast']},
 {name:'hevc',codec:'hevc',encoder:'libx265',format:'mp4',mime:'video/mp4',args:['-preset','ultrafast','-x265-params','pools=none:frame-threads=1:log-level=error']},
 {name:'vp8',codec:'vp8',encoder:'libvpx',format:'webm',mime:'video/webm',args:['-deadline','realtime','-cpu-used','8']},
 {name:'vp9',codec:'vp9',encoder:'libvpx-vp9',format:'webm',mime:'video/webm',args:['-deadline','realtime','-cpu-used','8']},
 {name:'av1',codec:'av1',encoder:'libaom-av1',format:'webm',mime:'video/webm',args:['-cpu-used','8','-row-mt','0']},
 {name:'vp9-opus',codec:'vp9',encoder:'libvpx-vp9',audio:'opus',audioEncoder:'libopus',format:'webm',mime:'video/webm',args:['-deadline','realtime','-cpu-used','8']},
 {name:'vp8-vorbis',codec:'vp8',encoder:'libvpx',audio:'vorbis',audioEncoder:'libvorbis',format:'webm',mime:'video/webm',args:['-deadline','realtime','-cpu-used','8']},
 {name:'quicktime-pcm',codec:'mpeg4',encoder:'mpeg4',audio:'pcm_s16le',audioEncoder:'pcm_s16le',format:'mov',mime:'video/quicktime',args:[]}
];
export async function generateVideoCodecFixtures(encoder,directory){
 if(typeof encoder!=='string'||!isAbsolute(encoder)||typeof directory!=='string'||!isAbsolute(directory)||resolve(directory)==='/')throw Error('INVALID_SYNTHETIC_VIDEO_CONFIGURATION');
 await mkdir(directory,{mode:0o755});await chmod(directory,0o755); // Public synthetic fixtures only,not private academy media.
 for(const item of videoCodecCases){
  const args=['-hide_banner','-loglevel','error','-f','lavfi','-i','color=c=red:s=64x64:r=4:d=0.5',...item.audio?['-f','lavfi','-i','sine=frequency=440:sample_rate=48000:duration=0.5']:[],'-c:v',item.encoder,'-threads','1','-pix_fmt','yuv420p',...item.args,...item.audio?['-c:a',item.audioEncoder,'-ac','1','-shortest']:['-an'],'-f',item.format,join(directory,item.name+'.'+item.format)],r=spawnSync(encoder,args,{env:{TZ:'UTC',MALLOC_ARENA_MAX:'2'},encoding:'utf8',timeout:10000,maxBuffer:65536});
  if(r.status!==0)throw Error('SYNTHETIC_VIDEO_ENCODING_FAILED:'+item.name+':'+r.status); // No raw encoder diagnostics.
  await chmod(join(directory,item.name+'.'+item.format),0o644);
 }
 console.log(JSON.stringify({measurement:'synthetic-video-codec-fixtures',clips:videoCodecCases.length,framesPerClip:2,externalMedia:0}));
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))await generateVideoCodecFixtures(process.env.TEST_VIDEO_FIXTURE_ENCODER,process.argv[2]);
