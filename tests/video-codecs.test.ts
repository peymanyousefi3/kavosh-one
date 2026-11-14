import assert from 'node:assert/strict';
import { createHash,randomUUID } from 'node:crypto';
import { readFile,stat } from 'node:fs/promises';
import { join,isAbsolute } from 'node:path';
import { test } from 'node:test';
import { videoCodecCases,generateVideoCodecFixtures } from '../scripts/video-codec-fixtures.mjs';
import { videoRuntimeConfigured,videoRuntimeOptions } from './video-fixture.ts';
import { validateVideo } from '../src/files/video-validation.ts';

const directory=process.env.TEST_VIDEO_CODEC_FIXTURES;
if(process.env.VIDEO_CODEC_TEST_REQUIRED==='true'&&(!directory||!isAbsolute(directory)||!videoRuntimeConfigured))throw Error('REAL_VIDEO_CODEC_FIXTURES_REQUIRED');
test('synthetic codec generator refuses missing or URL encoders and root/relative output paths before writing',async()=>{const untouched='/tmp/ko-codec-not-created-'+randomUUID();for(const [encoder,output]of [[undefined,untouched],['https://example.test/ffmpeg',untouched],['/usr/bin/ffmpeg','/'],['/usr/bin/ffmpeg','relative-output']])await assert.rejects(generateVideoCodecFixtures(encoder,output),/INVALID_SYNTHETIC_VIDEO_CONFIGURATION/);await assert.rejects(stat(untouched),{code:'ENOENT'});});
for(const item of videoCodecCases)test('real full-clip decoding of '+item.name+' under the actual pinned native runtime',{skip:!directory||!videoRuntimeConfigured},async()=>{
 const bytes=await readFile(join(directory!,item.name+'.'+item.format)),r=await validateVideo(bytes,item.mime,videoRuntimeOptions);assert.equal(r.outcome,'decoded',JSON.stringify(r));assert.equal(r.inputSha256,createHash('sha256').update(bytes).digest('hex'));assert.equal(r.inputBytes,bytes.length);
 if(r.outcome==='decoded'){assert.equal(r.codec,item.codec);assert.equal(r.width,64);assert.equal(r.height,64);assert.equal(r.videoFrames,2);assert.equal(r.audio?.codec??null,item.audio??null);assert.ok(item.audio?r.audioFrames>0:r.audioFrames===0);assert.ok(r.decodedBytes>=12288);}
});
