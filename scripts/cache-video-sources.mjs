import { readFile,mkdir } from 'node:fs/promises';
import { isAbsolute,join,basename } from 'node:path';
import { cachedVideoSource } from './video-source-download.mjs';

// Public source bytes only,never a cached executable or unchecked compiler input.
const directory=process.argv[2];
if(!directory||!isAbsolute(directory)||directory==='/')throw Error('VIDEO_SOURCE_CACHE_DIRECTORY_REQUIRED');
const manifest=JSON.parse(await readFile(new URL('../workers/video-validator/ffmpeg-source.json',import.meta.url),'utf8'));
await mkdir(directory,{recursive:true,mode:0o700});
for(const [release,maximum]of [[manifest,33554432],[manifest.softwareAv1Decoder,2097152]])await cachedVideoSource(release,maximum,join(directory,basename(new URL(release.url).pathname)));
console.log(JSON.stringify({publicSourceArchivesVerified:true,compilationPerformed:false,cachedExecutablesUsed:false}));
