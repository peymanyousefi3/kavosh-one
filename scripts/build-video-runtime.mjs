import { mkdtemp,readFile,writeFile,mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { downloadVideoSource,cachedVideoSource } from './video-source-download.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

// Operator/CI build tool only. No system install,no product credentials,no
// unchecked source execution. FFmpeg's hash was verified against its detached
// signature;dav1d's exact hash matches the vendor's published HTTPS checksum.
const run=promisify(execFile),manifest=JSON.parse(await readFile(new URL('../workers/video-validator/ffmpeg-source.json',import.meta.url),'utf8'));
if(manifest.version!=='9.0.2'||manifest.url!=='https://ffmpeg.org/releases/ffmpeg-9.0.2.tar.xz'||manifest.sha256!=='8c3850283eb25fa026482078a04051e0be17347b09ef81a0849bec15a96e002e'||!Array.isArray(manifest.configureFlags)||!manifest.configureFlags.includes('--disable-network'))throw Error('UNREVIEWED_VIDEO_SOURCE');
const av1=manifest.softwareAv1Decoder;if(av1?.name!=='dav1d'||av1.version!=='1.5.4'||av1.url!=='https://download.videolan.org/pub/videolan/dav1d/1.5.4/dav1d-1.5.4.tar.xz'||av1.sha256!=='686616b7c69eb88d44459391ab25cac13b6647a3b288835c5784e71c1514a5c5'||!manifest.configureFlags.includes('--enable-libdav1d'))throw Error('UNREVIEWED_AV1_SOURCE');
const root=await mkdtemp(join(tmpdir(),'kavosh-video-build-')),source=join(root,'source');
const env={PATH:process.env.PATH??'/usr/bin:/bin',TZ:'UTC',LC_ALL:'C'},options={env,encoding:'utf8',maxBuffer:8388608,timeout:300000};
async function extractPinnedRelease(release,prefix,directory,maximum){
 const fileName=prefix+'.tar.xz',archivePath=process.env.VIDEO_BUILD_SOURCE_DIRECTORY?join(process.env.VIDEO_BUILD_SOURCE_DIRECTORY,fileName):undefined,bytes=archivePath?await downloadVideoSource(release,maximum,{archivePath}):process.env.VIDEO_BUILD_SOURCE_CACHE?await cachedVideoSource(release,maximum,join(process.env.VIDEO_BUILD_SOURCE_CACHE,fileName)):await downloadVideoSource(release,maximum),archive=directory+'.tar.xz';await writeFile(archive,bytes,{mode:0o600,flag:'wx'});
 const list=await run('tar',['-tJf',archive],options);if(list.stdout.split('\n').filter(Boolean).some(p=>!p.startsWith(prefix+'/')||p.split('/').includes('..')))throw Error('UNSAFE_VIDEO_SOURCE_ARCHIVE');await mkdir(directory,{mode:0o700});await run('tar',['-xJf',archive,'-C',directory,'--strip-components=1'],options);
}
const av1Source=join(root,'dav1d-source'),av1Build=join(root,'dav1d-build'),av1Prefix=join(root,'dav1d-install');
await extractPinnedRelease(av1,'dav1d-'+av1.version,av1Source,2097152);
const av1Options={...options,env:{...env,...process.platform==='linux'?{CFLAGS:'-fstack-protector-strong -fno-strict-overflow -D_FORTIFY_SOURCE=2'}:{}}};
await run('meson',['setup',av1Build,av1Source,'--prefix='+av1Prefix,'--libdir=lib','--buildtype=release','--default-library=static','-Db_staticpic=true','-Denable_tools=false','-Denable_tests=false'],av1Options);
await run('meson',['compile','-C',av1Build,'-j2'],options);await run('meson',['install','-C',av1Build,'--no-rebuild'],options);
const codecOptions={...options,env:{...env,PKG_CONFIG_PATH:join(av1Prefix,'lib/pkgconfig')}};
if((await run('pkg-config',['--modversion','dav1d'],codecOptions)).stdout.trim()!==av1.version)throw Error('UNEXPECTED_AV1_LIBRARY');
await extractPinnedRelease(manifest,'ffmpeg-'+manifest.version,source,33554432);
// FFmpeg's native hardened toolchain explicitly enables PIE,stack protection
// and immediate read-only relocations on Linux;do not rely on distro defaults.
const flags=[...manifest.configureFlags,...process.platform==='linux'?['--toolchain=hardened']:[]];
await run('./configure',flags,{...codecOptions,cwd:source});await run('make',['-j2'],{...codecOptions,cwd:source});
const ffmpegPath=join(source,'ffmpeg'),ffprobePath=join(source,'ffprobe');for(const [path,name]of [[ffmpegPath,'ffmpeg'],[ffprobePath,'ffprobe']]){const version=await run(path,['-version'],options);if(!version.stdout.startsWith(name+' version '+manifest.version+' ')||!version.stdout.includes('--disable-network'))throw Error('UNEXPECTED_VIDEO_BUILD');}
if(!/\blibdav1d\b/.test((await run(ffmpegPath,['-hide_banner','-decoders'],options)).stdout))throw Error('MISSING_SOFTWARE_AV1_DECODER');
console.log(JSON.stringify({root,ffmpegSourceArchivePath:source+'.tar.xz',av1SourceArchivePath:av1Source+'.tar.xz',ffmpegPath,ffprobePath,version:manifest.version,sourceSha256:manifest.sha256,sourceHashVerified:true,av1Version:av1.version,av1SourceSha256:av1.sha256,av1LicensePath:join(av1Source,'COPYING'),networkDisabledAtBuild:true,productionContainerVerified:false}));
