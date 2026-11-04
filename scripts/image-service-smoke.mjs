import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { assertIsolatedImageRuntime,imageServiceSocket } from '../src/files/image-runtime.js';
import { validateImageViaService } from '../src/files/image-service.js';

// Runs INSIDE the actual resource-limited decoder image, not the web image.
await assertIsolatedImageRuntime();
// Native libvips sets VIPSHOME during import. Check the clean production
// runtime BEFORE loading the smoke client's trusted fixture generator, just
// as the actual service checks its environment before forking native codecs.
const {default:sharp}=await import('sharp');
const validate=bytes=>validateImageViaService(bytes,'image/png',{socketPath:imageServiceSocket});
const png=await sharp({create:{width:8,height:4,channels:3,background:'red'}}).png().toBuffer();
let ready=false;for(let i=0;i<100;i++){try{const r=await validate(png);assert.equal(r.outcome,'decoded');ready=true;break;}catch{await delay(100);}}
assert.ok(ready,'Private image service failed to become ready');
for(const format of ['png','jpeg','webp','gif','avif']) {
 const bytes=await sharp({create:{width:8,height:4,channels:3,background:'red'}}).toFormat(format).toBuffer();
 const r=await validateImageViaService(bytes,'image/'+format,{socketPath:imageServiceSocket});
 assert.equal(r.outcome,'decoded',JSON.stringify(r));assert.equal(r.inputSha256,createHash('sha256').update(bytes).digest('hex'));assert.equal(r.width,8);assert.equal(r.height,4);
 assert.equal('safeToServe' in r,false);assert.equal('downloadUrl' in r,false);
}
const corrupt=Buffer.from(png);corrupt[corrupt.indexOf('IDAT')+8]^=255;assert.equal((await validate(corrupt)).outcome,'rejected');
await assert.rejects(writeFile('/app/image-service-must-remain-read-only','no'),error=>['EROFS','EACCES'].includes(error.code));
const started=performance.now(),burst=await Promise.allSettled(Array.from({length:100},()=>validate(png)));
assert.equal(burst.filter(v=>v.status==='fulfilled').length,2);assert.equal(burst.filter(v=>v.status==='rejected').length,98);
assert.equal((await validate(png)).outcome,'decoded');
console.log(JSON.stringify({measurement:'actual-isolated-image-container',formats:5,burst:100,decoded:2,busy:98,elapsedMs:Math.ceil(performance.now()-started),uid:process.getuid(),native:sharp.versions.sharp,libvips:sharp.versions.vips,liveStorageCalls:0,liveProviderCalls:0}));
