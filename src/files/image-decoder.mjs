import sharp from 'sharp';
import { fileTypeFromBuffer } from 'file-type';
import { createHash } from 'node:crypto';
import { Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

// Pin the actual native implementation too; a custom/global libvips build is
// not automatically equivalent to the reviewed prebuilt dependency.
if(sharp.versions.sharp!=='0.35.5'||sharp.versions.vips!=='8.18.7')process.exit(1);
sharp.cache(false);sharp.concurrency(1);
sharp.block({operation:['VipsForeignLoad']});
sharp.unblock({operation:['VipsForeignLoadJpegBuffer','VipsForeignLoadPngBuffer','VipsForeignLoadWebpBuffer','VipsForeignLoadNsgifBuffer','VipsForeignLoadHeifBuffer']});
const supported=new Set(['image/jpeg','image/png','image/webp','image/gif','image/avif']);
function sendResult(result) {
 const usage=process.resourceUsage();
 process.send({pid:process.pid,result:{...result,resources:{peakRssKiB:usage.maxRSS,userCpuMicros:usage.userCPUTime,systemCpuMicros:usage.systemCPUTime}}},()=>process.disconnect());
}

// Framing only; maintained native codecs still perform pixel decompression.
// In particular libnsgif can quietly accept truncated subblocks or drop a frame.
// https://www.w3.org/Graphics/GIF/spec-gif89a.txt
function containerFrames(b,mime) {
 const need=(p,n)=>{if(!Number.isSafeInteger(n)||n<0||p+n>b.length)throw new Error('INCOMPLETE_CONTAINER');};
 if(mime==='image/gif') {
  need(0,13);let p=13,frames=0;const width=b.readUInt16LE(6),height=b.readUInt16LE(8);
  if(!['GIF87a','GIF89a'].includes(b.toString('ascii',0,6))||!width||!height)throw new Error('INVALID_GIF');
  const palette=packed=>{if(packed&128){const n=3*2**((packed&7)+1);need(p,n);p+=n;}};
  palette(b[10]);
  const subblocks=()=>{let total=0;while(true){need(p,1);const n=b[p++];if(!n)return total;need(p,n);p+=n;total+=n;}};
  while(true) {
   need(p,1);const tag=b[p++];
   if(tag===0x3b){if(p!==b.length||frames===0)throw new Error('INVALID_GIF_END');return frames;}
   if(tag===0x21) {
    need(p,1);const label=b[p++];
    if(label===0xf9){need(p,6);if(b[p]!==4||b[p+5]!==0)throw new Error('INVALID_GIF_CONTROL');p+=6;}
    else if(label===0xff||label===0x01){const n=label===0xff?11:12;need(p,n+1);if(b[p++]!==n)throw new Error('INVALID_GIF_EXTENSION');p+=n;subblocks();}
    else if(label===0xfe)subblocks();else throw new Error('UNKNOWN_GIF_EXTENSION');
   }else if(tag===0x2c) {
    need(p,9);const left=b.readUInt16LE(p),top=b.readUInt16LE(p+2),w=b.readUInt16LE(p+4),h=b.readUInt16LE(p+6),packed=b[p+8];p+=9;
    if(!w||!h||left+w>width||top+h>height)throw new Error('INVALID_GIF_FRAME');palette(packed);
    need(p,1);const codeSize=b[p++];if(codeSize<2||codeSize>8||subblocks()===0)throw new Error('INVALID_GIF_DATA');
    if(++frames>256)throw new Error('GIF_FRAME_BUDGET');
   }else throw new Error('INVALID_GIF_BLOCK');
  }
 }
 if(mime==='image/png') {
  let p=8,first=true,data=false;need(0,8);
  while(p<b.length){need(p,12);const n=b.readUInt32BE(p),kind=b.toString('ascii',p+4,p+8);need(p,n+12);
   if(first&&(kind!=='IHDR'||n!==13))throw new Error('INVALID_PNG_HEADER');first=false;
   if(kind==='acTL')throw new Error('APNG_NOT_SUPPORTED');if(kind==='IDAT')data=true;p+=n+12;
   if(kind==='IEND'){if(n||p!==b.length||!data)throw new Error('INVALID_PNG_END');return 1;}
  }throw new Error('INCOMPLETE_PNG');
 }
 if(mime==='image/jpeg') {
  // T.81 Annex B: skip length-delimited metadata, distinguish stuffed entropy
  // bytes/restarts from markers, and require the FIRST actual EOI at EOF.
  // Checking only the last two bytes permits payload + a second EOI suffix.
  need(0,2);if(b[0]!==255||b[1]!==216)throw new Error('INVALID_JPEG_START');
  let p=2,entropy=false,scans=0;
  while(p<b.length) {
   if(entropy){while(p<b.length&&b[p]!==255)p++;}
   need(p,2);if(b[p++]!==255)throw new Error('INVALID_JPEG_MARKER');
   while(b[p]===255)p++;need(p,1);const marker=b[p++];
   if(entropy&&(marker===0||(marker>=0xd0&&marker<=0xd7)))continue;
   if(marker===1)continue; // TEM is standalone; it does not end entropy.
   entropy=false;
   if(marker===0xd9){if(!scans||p!==b.length)throw new Error('INVALID_JPEG_END');return 1;}
   if(marker<0xc0||marker===0xd8||(marker>=0xd0&&marker<=0xd7))throw new Error('INVALID_JPEG_MARKER');
   need(p,2);const n=b.readUInt16BE(p);if(n<2)throw new Error('INVALID_JPEG_SEGMENT');need(p,n);p+=n;
   if(marker===0xda){scans++;entropy=true;}
  }throw new Error('INCOMPLETE_JPEG');
 }
 if(mime==='image/webp') {
  need(0,12);if(b.toString('ascii',0,4)!=='RIFF'||b.toString('ascii',8,12)!=='WEBP'||b.readUInt32LE(4)+8!==b.length)throw new Error('INCOMPLETE_WEBP');
  let p=12,frames=0;while(p<b.length){need(p,8);const n=b.readUInt32LE(p+4),kind=b.toString('ascii',p,p+4);need(p,n+8+(n&1));p+=n+8+(n&1);if(kind==='ANMF')frames++;}
  return frames||1;
 }
 // Top-level ISO-BMFF bounds complement the AV1 decoder. No arbitrary box
 // payload is executed; metadata, malware and publication remain separate.
 let p=0,ftyp=false;
 while(p<b.length){need(p,8);let n=b.readUInt32BE(p);const kind=b.toString('ascii',p+4,p+8);let header=8;
  if(n===1){need(p,16);const wide=b.readBigUInt64BE(p+8);if(wide>BigInt(b.length))throw new Error('INVALID_BOX_SIZE');n=Number(wide);header=16;}
  else if(n===0)n=b.length-p;
  if(n<header)throw new Error('INVALID_BOX_SIZE');need(p,n);if(kind==='ftyp')ftyp=true;p+=n;
 }if(!ftyp)throw new Error('MISSING_FILE_TYPE');return 1;
}
process.once('message',async message=>{
 let result;
 try {
  if(!message||!Buffer.isBuffer(message.bytes)||message.bytes.length<1||message.bytes.length>33_554_432||!supported.has(message.claimedMimeType)
   ||!Number.isSafeInteger(message.maximumPixels)||message.maximumPixels<1||message.maximumPixels>64_000_000
   ||!Number.isSafeInteger(message.maximumFrames)||message.maximumFrames<1||message.maximumFrames>256
   ||message.profileImagePurpose!==undefined&&!['avatar','achievement'].includes(message.profileImagePurpose))throw new Error('INVALID_INPUT');
  const {bytes,claimedMimeType,maximumPixels,maximumFrames}=message;
  const base={validator:'sharp@0.35.5',libvips:sharp.versions.vips,inputBytes:bytes.length,inputSha256:createHash('sha256').update(bytes).digest('hex'),maximumPixels,maximumFrames};
  const rejected=reason=>({...base,outcome:'rejected',reason});
  const hint=await fileTypeFromBuffer(bytes);
  if(!hint||!supported.has(hint.mime))result=rejected('UNSUPPORTED_FORMAT');
  else if(hint.mime!==claimedMimeType)result=rejected('MIME_MISMATCH');
  else {
   let framed;
   try{framed=containerFrames(bytes,hint.mime);}catch{result=rejected('CONTAINER_REJECTED');}
   if(result){sendResult(result);return;}
   const image=sharp(bytes,{animated:true,failOn:'warning',unlimited:false,limitInputPixels:maximumPixels,limitInputChannels:5,sequentialRead:true});
   try {
    const meta=await image.metadata(),frames=meta.pages??1,height=meta.pageHeight??meta.height,width=meta.width;
    const decodedMime={jpeg:'image/jpeg',png:'image/png',webp:'image/webp',gif:'image/gif',heif:meta.compression==='av1'?'image/avif':null}[meta.format];
    if(decodedMime!==hint.mime)result=rejected('MIME_MISMATCH');
    else if(!Number.isSafeInteger(width)||width<1||!Number.isSafeInteger(height)||height<1||!Number.isSafeInteger(frames)||frames<1||frames!==framed||meta.height!==height*frames)result=rejected('DECODER_REJECTED');
    else if(frames>maximumFrames||(hint.mime==='image/avif'&&frames!==1))result=rejected('FRAME_LIMIT');
    else if(width*height*frames>maximumPixels)result=rejected('PIXEL_LIMIT');
    else {
     let info,decodedBytes=0;const hash=createHash('sha256');
     image.raw({depth:'uchar'}).once('info',value=>{info=value;});
     const sink=new Writable({highWaterMark:65536,write(chunk,_encoding,done){
      decodedBytes+=chunk.length;if(decodedBytes>maximumPixels*4){done(new Error('PIXEL_LIMIT'));return;}hash.update(chunk);done();
     }});
     // Draining the complete raw raster forces pixel decoding, not just header
     // inspection. All GIF/WebP frames are selected by animated:true above.
     await pipeline(image,sink);
     if(!info||info.width!==width||info.height!==height*frames||!Number.isInteger(info.channels)||info.channels<1||info.channels>4
      ||decodedBytes!==width*height*frames*info.channels)result=rejected('DECODER_REJECTED');
     else {
      result={...base,outcome:'decoded',mime:hint.mime,width,height,frames,channels:info.channels,decodedBytes,decodedSha256:hash.digest('hex')};
      if(message.profileImagePurpose){
       const purpose=message.profileImagePurpose,limit=purpose==='avatar'?512:2048,maximumBytes=purpose==='avatar'?1048576:4194304;
       // Decode ALL source frames above before selecting the first display
       // frame. Re-encoding without keepMetadata/withMetadata drops EXIF/GPS,
       // XMP,ICC and comments;auto-orient before resize preserves phone photos.
       // https://sharp.pixelplumbing.com/api-output/#keepmetadata
       const derivative=sharp(bytes,{page:0,pages:1,failOn:'warning',unlimited:false,limitInputPixels:maximumPixels,limitInputChannels:5,sequentialRead:true});
       try{const {data,info:out}=await derivative.autoOrient().resize({width:limit,height:limit,fit:'inside',withoutEnlargement:true}).webp({quality:90,effort:3}).toBuffer({resolveWithObject:true});
        if(out.format!=='webp'||out.width<1||out.height<1||out.width>limit||out.height>limit||data.length<12||data.length>maximumBytes)throw Error('PROFILE_IMAGE_LIMIT');
        result.profileImage={purpose,mime:'image/webp',width:out.width,height:out.height,bytes:data.length,sha256:createHash('sha256').update(data).digest('hex'),base64:data.toString('base64'),framePolicy:'first_frame',metadataPolicy:'stripped'};data.fill(0);
       }finally{derivative.destroy();}
      }
     }
    }
   }catch{result=rejected('DECODER_REJECTED');}
   finally{image.destroy();}
  }
 }catch{process.exitCode=1;process.disconnect();return;}
 sendResult(result);
});
