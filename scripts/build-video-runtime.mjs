import { mkdtemp,readFile,writeFile,mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

// Operator/CI build tool only. No system install,no product credentials,no
// unchecked source execution. Source hash was independently verified against
// the official detached release signature and pinned release-key fingerprint.
const run=promisify(execFile),manifest=JSON.parse(await readFile(new URL('../workers/video-validator/ffmpeg-source.json',import.meta.url),'utf8'));
if(manifest.version!=='9.0.2'||manifest.url!=='https://ffmpeg.org/releases/ffmpeg-9.0.2.tar.xz'||manifest.sha256!=='8c3850283eb25fa026482078a04051e0be17347b09ef81a0849bec15a96e002e'||!Array.isArray(manifest.configureFlags)||!manifest.configureFlags.includes('--disable-network'))throw Error('UNREVIEWED_VIDEO_SOURCE');
const root=await mkdtemp(join(tmpdir(),'kavosh-video-build-')),archive=join(root,'source.tar.xz'),source=join(root,'source');
const response=await fetch(manifest.url,{redirect:'error',signal:AbortSignal.timeout(60000)});if(!response.ok||!response.body)throw Error('VIDEO_SOURCE_UNAVAILABLE');
const chunks=[];let size=0;for await(const chunk of response.body){size+=chunk.length;if(size>33554432){await response.body.cancel().catch(()=>{});throw Error('VIDEO_SOURCE_TOO_LARGE');}chunks.push(chunk);}
const bytes=Buffer.concat(chunks,size);if(createHash('sha256').update(bytes).digest('hex')!==manifest.sha256)throw Error('VIDEO_SOURCE_HASH_MISMATCH');await writeFile(archive,bytes,{mode:0o600,flag:'wx'});
const env={PATH:process.env.PATH??'/usr/bin:/bin',TZ:'UTC',LC_ALL:'C'},options={env,encoding:'utf8',maxBuffer:8388608,timeout:300000};
const list=await run('tar',['-tJf',archive],options);if(list.stdout.split('\n').filter(Boolean).some(p=>!p.startsWith('ffmpeg-'+manifest.version+'/')||p.split('/').includes('..')))throw Error('UNSAFE_VIDEO_SOURCE_ARCHIVE');
await mkdir(source,{mode:0o700});await run('tar',['-xJf',archive,'-C',source,'--strip-components=1'],options);
// FFmpeg's native hardened toolchain explicitly enables PIE,stack protection
// and immediate read-only relocations on Linux;do not rely on distro defaults.
const flags=[...manifest.configureFlags,...process.platform==='linux'?['--toolchain=hardened']:[]];
await run('./configure',flags,{...options,cwd:source});await run('make',['-j2'],{...options,cwd:source});
const ffmpegPath=join(source,'ffmpeg'),ffprobePath=join(source,'ffprobe');for(const [path,name]of [[ffmpegPath,'ffmpeg'],[ffprobePath,'ffprobe']]){const version=await run(path,['-version'],options);if(!version.stdout.startsWith(name+' version '+manifest.version+' ')||!version.stdout.includes('--disable-network'))throw Error('UNEXPECTED_VIDEO_BUILD');}
console.log(JSON.stringify({root,ffmpegPath,ffprobePath,version:manifest.version,sourceSha256:manifest.sha256,sourceHashVerified:true,networkDisabledAtBuild:true,productionContainerVerified:false}));
