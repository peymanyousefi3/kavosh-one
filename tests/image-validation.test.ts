import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import sharp from 'sharp';
import { validateImage,deriveProfileImage,imageValidationMatches,imageValidationSchema,profileImageValidationSchema,maximumImageInputBytes,maximumImagePixels } from '../src/files/image-validation.ts';

const sha=(v:Uint8Array)=>createHash('sha256').update(v).digest('hex');
const rgba=Buffer.from([255,0,0,255,0,255,0,255,0,0,255,255]);
async function still(format:'png'|'jpeg'|'webp'|'avif'|'gif'='png') {return sharp({create:{width:8,height:4,channels:3,background:'red'}}).toFormat(format).toBuffer();}
async function animated(format:'gif'|'webp'){return sharp(rgba,{raw:{width:1,height:3,channels:4,pageHeight:1}}).toFormat(format,{lossless:true}).toBuffer();}
test('profile image copies strip actual metadata apply phone orientation preserve aspect and never modify the original',async()=>{
 const original=await sharp({create:{width:1200,height:600,channels:3,background:'blue'}}).withMetadata({orientation:6}).withExif({IFD0:{Artist:'PRIVATE_ARTIST',Copyright:'PRIVATE_COPYRIGHT'},IFD2:{UserComment:'PRIVATE_CAMERA_NOTE'},IFD3:{GPSLatitudeRef:'N',GPSLatitude:'43/1 39/1 0/1',GPSLongitudeRef:'W',GPSLongitude:'79/1 23/1 0/1'}}).jpeg().toBuffer(),before=Buffer.from(original),sourceMeta=await sharp(original).metadata();assert.ok(sourceMeta.exif);assert.ok(sourceMeta.icc);assert.equal(sourceMeta.orientation,6);
 for(const purpose of ['avatar','achievement']){const r=await deriveProfileImage(original,'image/jpeg',purpose);assert.equal(r.outcome,'decoded',JSON.stringify(r));if(r.outcome!=='decoded')continue;const p=r.profileImage,bytes=Buffer.from(p.base64,'base64'),meta=await sharp(bytes).metadata();assert.equal('inputBytes'in p,false);assert.equal(r.inputSha256,sha(original));assert.equal(p.purpose,purpose);assert.equal(p.bytes,bytes.length);assert.equal(p.sha256,sha(bytes));assert.equal(meta.format,'webp');assert.equal(meta.width,p.width);assert.equal(meta.height,p.height);assert.deepEqual([p.width,p.height],purpose==='avatar'?[256,512]:[600,1200]);for(const field of ['exif','icc','xmp','iptc','orientation']as const)assert.equal(meta[field],undefined);assert.equal(bytes.includes(Buffer.from('PRIVATE_')),false);assert.equal(p.metadataPolicy,'stripped');assert.equal(p.framePolicy,'first_frame');assert.deepEqual(original,before);assert.equal(imageValidationSchema.safeParse(r).success,false,'Derivative bytes cannot masquerade as ordinary inspection evidence');assert.equal(profileImageValidationSchema.safeParse(r).success,true);assert.equal(imageValidationMatches(r,original.length,sha(original),'image/jpeg'),false);assert.equal(imageValidationMatches(r,original.length,sha(original),'image/jpeg',undefined,undefined,purpose as 'avatar'|'achievement'),true);}
});
test('profile copies drain every original animation frame but share only a static first-frame copy and never upscale tiny images',async()=>{
 for(const format of ['gif','webp']as const){const source=await animated(format),r=await deriveProfileImage(source,'image/'+format,'avatar');assert.equal(r.outcome,'decoded',JSON.stringify(r));if(r.outcome!=='decoded')continue;assert.equal(r.frames,3);const p=r.profileImage,meta=await sharp(Buffer.from(p.base64,'base64')).metadata();assert.equal(meta.pages??1,1);assert.equal(meta.width,1);assert.equal(meta.height,1);const pixel=await sharp(Buffer.from(p.base64,'base64')).removeAlpha().raw().toBuffer();assert.ok(pixel[0]>200&&pixel[1]<40&&pixel[2]<40);}
 const input=await still(),good=await deriveProfileImage(input,'image/png','achievement');assert.equal(good.outcome,'decoded');if(good.outcome==='decoded'){const r=structuredClone(good);r.profileImage.base64=Buffer.from('RIFFinvalidWEBP').toString('base64');assert.equal(imageValidationMatches(r,input.length,sha(input),'image/png',undefined,undefined,'achievement'),false);assert.equal(imageValidationMatches(good,input.length,sha(input),'image/png',undefined,undefined,'avatar'),false);}
});
test('profile-copy preparation rejects corrupt trailing or mismatched input invalid purposes budgets and cancellation without granting publication',async()=>{
 const b=await still();for(const candidate of [b.subarray(0,b.length-1),Buffer.concat([b,Buffer.from('PRIVATE_TRAILING')])])assert.equal((await deriveProfileImage(candidate,'image/png','avatar')).outcome,'rejected');assert.equal((await deriveProfileImage(b,'image/jpeg','avatar')).outcome,'rejected');assert.equal((await deriveProfileImage(b,'image/png','avatar',{maximumPixels:1})).outcome,'rejected');for(const purpose of ['public','../avatar','https://localhost',''])await assert.rejects(deriveProfileImage(b,'image/png',purpose),{code:'INVALID_PROFILE_IMAGE_PURPOSE'});const stop=new AbortController();stop.abort();await assert.rejects(deriveProfileImage(b,'image/png','avatar',{signal:stop.signal}),{code:'IMAGE_VALIDATION_CANCELLED'});await assert.rejects(deriveProfileImage(b,'image/png','avatar',{timeoutMs:1}),{code:'IMAGE_VALIDATION_TIMEOUT'});assert.equal((await validateImage(b,'image/png')).outcome,'decoded');
});
test('profile copies enforce larger-image output dimensions preserve alpha and share native capacity with ordinary validation',async()=>{
 const b=await sharp({create:{width:2304,height:1152,channels:4,background:{r:255,g:0,b:0,alpha:0.5}}}).png().toBuffer(),r=await deriveProfileImage(b,'image/png','achievement');assert.equal(r.outcome,'decoded',JSON.stringify(r));if(r.outcome==='decoded'){assert.deepEqual([r.profileImage.width,r.profileImage.height],[2048,1024]);const m=await sharp(Buffer.from(r.profileImage.base64,'base64')).metadata();assert.equal(m.hasAlpha,true);assert.ok(r.profileImage.bytes<=4194304);}
 const tiny=await still(),mixed=await Promise.allSettled([deriveProfileImage(tiny,'image/png','avatar'),validateImage(tiny,'image/png'),deriveProfileImage(tiny,'image/png','achievement')]);assert.deepEqual(mixed.map(r=>r.status),['fulfilled','fulfilled','rejected']);assert.equal(mixed[2].status==='rejected'?mixed[2].reason.code:null,'IMAGE_VALIDATOR_BUSY');const gif=await animated('gif');assert.equal((await deriveProfileImage(Buffer.concat([gif.subarray(0,gif.length-5),Buffer.from([0x3b])]),'image/gif','avatar')).outcome,'rejected');assert.equal((await deriveProfileImage(tiny,'image/png','avatar')).outcome,'decoded');
});

test('actual child decoder drains complete pixels for JPEG PNG WebP AVIF and GIF without returning metadata, content or a safety flag',async()=>{
 for(const format of ['jpeg','png','webp','avif','gif'] as const) {
  const bytes=await still(format),r=await validateImage(bytes,'image/'+format);assert.equal(r.outcome,'decoded',JSON.stringify(r));if(r.outcome!=='decoded')continue;
  assert.equal(r.validator,'sharp@0.35.5');assert.equal(r.libvips,'8.18.7');assert.equal(r.inputBytes,bytes.length);assert.equal(r.inputSha256,sha(bytes));
  assert.equal(r.width,8);assert.equal(r.height,4);assert.equal(r.frames,1);assert.equal(r.decodedBytes,8*4*r.channels);assert.match(r.decodedSha256,/^[a-f0-9]{64}$/);
  assert.ok(r.resources.peakRssKiB>0);assert.ok(r.resources.userCpuMicros+r.resources.systemCpuMicros>0);
  for(const forbidden of ['safeToServe','malwareFree','downloadUrl','pixels','exif','icc','pid'])assert.equal(forbidden in r,false);
 }
});
test('lossless decoded pixels match independent raw input hashes, including all three animated frames',async()=>{
 const png=await sharp(rgba,{raw:{width:1,height:3,channels:4}}).png().toBuffer(),plain=await validateImage(png,'image/png');assert.equal(plain.outcome,'decoded');if(plain.outcome==='decoded')assert.equal(plain.decodedSha256,sha(rgba));
 const gif=await validateImage(await animated('gif'),'image/gif');assert.equal(gif.outcome,'decoded',JSON.stringify(gif));if(gif.outcome==='decoded'){assert.equal(gif.frames,3);assert.equal(gif.height,1);assert.equal(gif.decodedBytes,12);assert.equal(gif.decodedSha256,sha(rgba));}
 const webp=await validateImage(await animated('webp'),'image/webp');assert.equal(webp.outcome,'decoded');if(webp.outcome==='decoded'){assert.equal(webp.frames,3);assert.equal(webp.decodedBytes,9);assert.equal(webp.decodedSha256,sha(Buffer.from([255,0,0,0,255,0,0,0,255])));}
});
test('corrupt pixels can pass header metadata but must fail full decoding',async()=>{
 const png=await still('png'),corrupt=Buffer.from(png);corrupt[corrupt.indexOf('IDAT')+8]^=255;
 assert.equal((await sharp(corrupt).metadata()).width,8,'prove metadata alone is insufficient');
 const r=await validateImage(corrupt,'image/png');assert.equal(r.outcome,'rejected');assert.equal(r.outcome==='rejected'?r.reason:null,'DECODER_REJECTED');
});
test('all supported containers reject truncation and appended payloads, including GIFs native codecs previously accepted',async()=>{
 for(const format of ['jpeg','png','webp','avif','gif'] as const) {
  const bytes=format==='gif'||format==='webp'?await animated(format):await still(format);
  for(const candidate of [bytes.subarray(0,bytes.length-1),bytes.subarray(0,bytes.length-3),bytes.subarray(0,bytes.length-10),Buffer.concat([bytes,Buffer.from('<script>not-image-data</script>')])]) {
   const r=await validateImage(candidate,'image/'+format);assert.equal(r.outcome,'rejected',format+': '+JSON.stringify(r));
  }
 }
});
test('a partial last GIF frame cannot be hidden by appending a new trailer or declaring oversized frame bounds',async()=>{
 const bytes=await animated('gif');
 for(const cut of [3,5,10]) {
  const r=await validateImage(Buffer.concat([bytes.subarray(0,bytes.length-cut),Buffer.from([0x3b])]),'image/gif');assert.equal(r.outcome,'rejected');
 }
 const bad=Buffer.from(bytes),descriptor=bad.indexOf(Buffer.from([0x2c]));assert.ok(descriptor>12);bad.writeUInt16LE(65535,descriptor+5);
 assert.equal((await validateImage(bad,'image/gif')).outcome,'rejected');
});
test('JPEG cannot hide trailing content behind a second end marker or a concatenated image',async()=>{
 const bytes=await still('jpeg');
 for(const extra of [Buffer.from('hidden payload'),bytes,Buffer.from([0xff,0xd9])]) {
  const candidate=Buffer.concat([bytes,extra,Buffer.from([0xff,0xd9])]);
  // The native codec alone accepts trailing bytes: the framing guard must not.
  assert.equal((await sharp(candidate,{failOn:'warning'}).raw().toBuffer()).length,8*4*3);
  const r=await validateImage(candidate,'image/jpeg');assert.equal(r.outcome,'rejected');assert.equal(r.outcome==='rejected'?r.reason:null,'CONTAINER_REJECTED');
 }
});
test('JPEG framing preserves progressive scans and length-delimited comments containing marker-like bytes',async()=>{
 const payload=Buffer.concat([Buffer.from('PRIVATE_COMMENT'),Buffer.from([0xff,0xd9,0xff,0xda,0xff,0x00])]);
 const comment=Buffer.alloc(payload.length+4);comment[0]=255;comment[1]=0xfe;comment.writeUInt16BE(payload.length+2,2);payload.copy(comment,4);
 for(const progressive of [false,true]) {
  const bytes=await sharp({create:{width:16,height:16,channels:3,background:'blue'}}).jpeg({progressive}).toBuffer();
  const original=await validateImage(bytes,'image/jpeg'),withComment=await validateImage(Buffer.concat([bytes.subarray(0,2),comment,bytes.subarray(2)]),'image/jpeg');
  assert.equal(original.outcome,'decoded');assert.equal(withComment.outcome,'decoded',JSON.stringify(withComment));
  if(original.outcome==='decoded'&&withComment.outcome==='decoded')assert.equal(original.decodedSha256,withComment.decodedSha256);
  assert.equal(JSON.stringify(withComment).includes('PRIVATE_COMMENT'),false);
 }
});
test('JPEG length overflow, invalid standalone markers and missing scan are rejected before decoding',async()=>{
 const bytes=await still('jpeg');
 for(const segment of [Buffer.from([255,254,0,1]),Buffer.from([255,254,255,255]),Buffer.from([255,0]),Buffer.from([255,208]),Buffer.from([255,216])]) {
  const r=await validateImage(Buffer.concat([bytes.subarray(0,2),segment,bytes.subarray(2)]),'image/jpeg');assert.equal(r.outcome,'rejected');
 }
 assert.equal((await validateImage(Buffer.from([255,216,255,217]),'image/jpeg')).outcome,'rejected');
});
test('pixel and aggregate frame budgets reject oversized work and recover without leaking process slots',async()=>{
 const png=await still();assert.equal((await validateImage(png,'image/png',{maximumPixels:31})).outcome,'rejected');
 const gif=await animated('gif');const frames=await validateImage(gif,'image/gif',{maximumFrames:2});assert.equal(frames.outcome,'rejected');assert.equal(frames.outcome==='rejected'?frames.reason:null,'FRAME_LIMIT');
 assert.equal((await validateImage(gif,'image/gif',{maximumPixels:2})).outcome,'rejected');
 assert.equal((await validateImage(gif,'image/gif',{maximumPixels:3,maximumFrames:3})).outcome,'decoded');
});
test('claimed image formats cannot enable SVG PDF TIFF or executable parsing and MIME mismatch is rejected',async()=>{
 const bytes=await still();assert.equal((await validateImage(bytes,'image/jpeg')).outcome,'rejected');
 for(const sample of [Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>'),Buffer.from('%PDF-1.7\n'),Buffer.from('MZ executable'),Buffer.alloc(24)]) {
  const r=await validateImage(sample,'image/png');assert.equal(r.outcome,'rejected');
 }
 for(const type of ['image/svg+xml','image/heic','image/heif','image/tiff','application/pdf','https://localhost'])await assert.rejects(validateImage(bytes,type),{code:'UNSUPPORTED_IMAGE_VALIDATION_TYPE',status:400});
});
test('input bounds, strict options and selected buffer slices cannot expose unrelated backing bytes',async()=>{
 const png=await still(),backing=Buffer.concat([png,Buffer.from('PRIVATE_BACKING_BYTES')]),selected=backing.subarray(0,png.length),r=await validateImage(selected,'image/png');
 assert.equal(r.inputBytes,png.length);assert.equal(r.inputSha256,sha(png));assert.ok(!JSON.stringify(r).includes('PRIVATE'));
 for(const value of [Buffer.alloc(0),Buffer.alloc(maximumImageInputBytes+1),'file://private/image.png' as unknown as Uint8Array])await assert.rejects(validateImage(value,'image/png'),{code:'INVALID_IMAGE_VALIDATION_BYTES',status:400});
 for(const options of [{maximumPixels:0},{maximumPixels:maximumImagePixels+1},{maximumFrames:257},{timeoutMs:0},{timeoutMs:30001},{decoderUrl:'https://localhost'}])await assert.rejects(validateImage(png,'image/png',options),{code:'INVALID_IMAGE_VALIDATION_OPTIONS',status:400});
});
test('pre-cancellation, active cancellation and actual decoder timeout kill/reap the child before capacity is reused',{timeout:5000},async()=>{
 const png=await still(),pre=new AbortController();pre.abort();await assert.rejects(validateImage(png,'image/png',{signal:pre.signal}),{code:'IMAGE_VALIDATION_CANCELLED',status:503});
 const controller=new AbortController(),pending=validateImage(png,'image/png',{signal:controller.signal});controller.abort();await assert.rejects(pending,{code:'IMAGE_VALIDATION_CANCELLED',status:503});
 await assert.rejects(validateImage(png,'image/png',{timeoutMs:1}),{code:'IMAGE_VALIDATION_TIMEOUT',status:503});
 assert.equal((await validateImage(png,'image/png')).outcome,'decoded');
});
test('a burst creates only two simultaneous native decoders and caller overload never becomes corrupt-file evidence',async()=>{
 const png=await still(),started=performance.now();
 const results=await Promise.allSettled(Array.from({length:100},()=>validateImage(png,'image/png')));
 const decoded=results.filter(r=>r.status==='fulfilled'),busy=results.filter(r=>r.status==='rejected');assert.equal(decoded.length,2);assert.equal(busy.length,98);
 for(const r of decoded)if(r.status==='fulfilled')assert.equal(r.value.outcome,'decoded');
 for(const r of busy)if(r.status==='rejected')assert.equal(r.reason.code,'IMAGE_VALIDATOR_BUSY');
 assert.equal((await validateImage(png,'image/png')).outcome,'decoded');
 console.log(JSON.stringify({measurement:'synthetic-image-validator-burst',requests:100,decoded:2,busy:98,maximumChildren:2,elapsedMs:Math.ceil(performance.now()-started),liveStorageRequests:0}));
});
test('native decoder policies are process-isolated rather than sharing the parent native-library globals',async()=>{
 const png=await still();sharp.block({operation:['VipsForeignLoad']});
 try{assert.equal((await validateImage(png,'image/png')).outcome,'decoded');}
 finally{sharp.unblock({operation:['VipsForeignLoad']});}
});
test('one-megapixel full decode reports actual child memory/CPU and preserves exact pixels without materializing raster in the parent',async()=>{
 const raw=Buffer.alloc(1024*1024*3,127),png=await sharp(raw,{raw:{width:1024,height:1024,channels:3}}).png().toBuffer(),started=performance.now();
 const r=await validateImage(png,'image/png');assert.equal(r.outcome,'decoded');if(r.outcome!=='decoded')return;
 assert.equal(r.decodedBytes,raw.length);assert.equal(r.decodedSha256,sha(raw));
 console.log(JSON.stringify({measurement:'synthetic-image-full-decode',width:r.width,height:r.height,frames:r.frames,inputBytes:r.inputBytes,decodedBytes:r.decodedBytes,elapsedMs:Math.ceil(performance.now()-started),...r.resources,liveStorageRequests:0}));
});
