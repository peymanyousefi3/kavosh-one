import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp,writeFile,open,rm,readFile,stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { downloadVideoSource,cachedVideoSource } from '../scripts/video-source-download.mjs';
const source={url:'https://ffmpeg.org/releases/ffmpeg-9.0.2.tar.xz',sha256:'8c3850283eb25fa026482078a04051e0be17347b09ef81a0849bec15a96e002e'},maximum=33554432;
test('public source archives use a read-only named build context rather than Docker secret-size-limited inputs',async()=>{
 const docker=await readFile(new URL('../Dockerfile.video-service',import.meta.url),'utf8'),workflow=await readFile(new URL('../.github/workflows/backend.yml',import.meta.url),'utf8');assert.match(docker,/FROM scratch AS video-sources/);assert.match(docker,/--mount=type=bind,from=video-sources,target=\/run\/kavosh-video-sources,readonly/);assert.doesNotMatch(docker,/--mount=type=secret/);assert.match(workflow,/--build-context "video-sources=\$RUNNER_TEMP\/kavosh-video-sources"/);assert.doesNotMatch(workflow,/--secret "id=(?:ffmpeg|dav1d)-source/);assert.match(workflow,/actions\/cache@caa296126883cff596d87d8935842f9db880ef25/);
});
test('public source cache never refreshes corruption or publishes failed and unreviewed downloads',async()=>{
 const root=await mkdtemp(join(tmpdir(),'kavosh-source-cache-')),archivePath=join(root,'source.tar.xz');let calls=0;
 const options={async fetcher(){calls++;return new Response('synthetic bad source');}};
 try{
  await assert.rejects(cachedVideoSource(source,maximum,archivePath,options),/VIDEO_SOURCE_HASH_MISMATCH/);assert.equal(calls,1);await assert.rejects(stat(archivePath),{code:'ENOENT'});
  await writeFile(archivePath,'retained corrupt cache');calls=0;await assert.rejects(cachedVideoSource(source,maximum,archivePath,options),/VIDEO_SOURCE_HASH_MISMATCH/);assert.equal(calls,0);assert.equal(await readFile(archivePath,'utf8'),'retained corrupt cache');
  await assert.rejects(cachedVideoSource({...source,sha256:'0'.repeat(64)},maximum,archivePath,options),/UNREVIEWED_VIDEO_SOURCE/);await assert.rejects(cachedVideoSource(source,maximum,'relative-cache',options),/UNREVIEWED_VIDEO_SOURCE/);assert.equal(calls,0);
 }finally{await rm(root,{recursive:true,force:true});}
});
test('reused build archives keep exact source pins,size ceilings and fail closed without network fallback',async()=>{
 const root=await mkdtemp(join(tmpdir(),'kavosh-source-check-'));let calls=0;const options={async fetcher(){calls++;throw Error('NETWORK_MUST_NOT_RUN');}};
 try{
  const archivePath=join(root,'archive.tar.xz');await writeFile(archivePath,'synthetic corrupt archive');
  await assert.rejects(downloadVideoSource(source,maximum,{...options,archivePath}),/VIDEO_SOURCE_HASH_MISMATCH/);
  await assert.rejects(downloadVideoSource({...source,sha256:'0'.repeat(64)},maximum,{...options,archivePath}),/UNREVIEWED_VIDEO_SOURCE/);
  await assert.rejects(downloadVideoSource(source,maximum,{...options,archivePath:root}),/UNREVIEWED_VIDEO_SOURCE/);
  await assert.rejects(downloadVideoSource(source,maximum,{...options,archivePath:'relative.tar.xz'}),/UNREVIEWED_VIDEO_SOURCE/);
  await assert.rejects(downloadVideoSource(source,maximum,{...options,archivePath:join(root,'missing')}),{code:'ENOENT'});
  const av1={url:'https://download.videolan.org/pub/videolan/dav1d/1.5.4/dav1d-1.5.4.tar.xz',sha256:'686616b7c69eb88d44459391ab25cac13b6647a3b288835c5784e71c1514a5c5'},file=await open(archivePath,'w');try{await file.truncate(2097153);}finally{await file.close();}
  await assert.rejects(downloadVideoSource(av1,2097152,{...options,archivePath}),/VIDEO_SOURCE_TOO_LARGE/);assert.equal(calls,0);
 }finally{await rm(root,{recursive:true,force:true});}
});
test('pinned build source download rejects changed versions,hashes,URLs and ceilings before any network call',async()=>{let calls=0;const options={async fetcher(){calls++;return new Response();}};for(const release of [{...source,url:'http://ffmpeg.org/releases/ffmpeg-9.0.2.tar.xz'},{...source,url:source.url+'?mirror=other'},{...source,sha256:'0'.repeat(64)},{...source,url:'https://example.test/source'}])await assert.rejects(downloadVideoSource(release,maximum,options),/UNREVIEWED_VIDEO_SOURCE/);await assert.rejects(downloadVideoSource(source,maximum+1,options),/UNREVIEWED_VIDEO_SOURCE/);assert.equal(calls,0);});
test('transient build-source connection timeout and5xx retry at most3times against the identical pinned target',async()=>{const seen:string[]=[];await assert.rejects(downloadVideoSource(source,maximum,{async fetcher(url:string,options:{redirect:string;signal:AbortSignal}){seen.push(url);assert.equal(options.redirect,'error');assert.ok(options.signal instanceof AbortSignal);if(seen.length===1)throw Object.assign(new TypeError('fetch failed'),{cause:{code:'UND_ERR_CONNECT_TIMEOUT'}});if(seen.length===2)return new Response(null,{status:503});return new Response('Not the verified archive');}}),/VIDEO_SOURCE_HASH_MISMATCH/);assert.deepEqual(seen,[source.url,source.url,source.url]);});
test('permanent HTTP,redirect and hash failures do not retry or accept fallback bytes',async()=>{for(const mode of ['404','redirect','hash']){let calls=0;await assert.rejects(downloadVideoSource(source,maximum,{async fetcher(){calls++;if(mode==='redirect')throw new TypeError('redirect rejected');return mode==='hash'?new Response('synthetic wrong hash'):new Response(null,{status:404});}}),mode==='hash'?/VIDEO_SOURCE_HASH_MISMATCH/:/VIDEO_SOURCE_UNAVAILABLE/);assert.equal(calls,1);}});
test('source retries and body reads share one whole-operation deadline and oversized bodies are never accepted',async()=>{let calls=0;await assert.rejects(downloadVideoSource(source,maximum,{timeoutMs:10,async fetcher(){calls++;return new Response(null,{status:503});}}),/VIDEO_SOURCE_UNAVAILABLE/);assert.equal(calls,1);let chunks=0,cancelled=false;const body=new ReadableStream({pull(c){chunks++;c.enqueue(new Uint8Array(1048576));},cancel(){cancelled=true;}});await assert.rejects(downloadVideoSource(source,maximum,{async fetcher(){return new Response(body);}}),/VIDEO_SOURCE_TOO_LARGE/);assert.equal(cancelled,true);assert.ok(chunks<=34);});
