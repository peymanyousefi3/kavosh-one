import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { mkdtemp,realpath,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { ApiError } from '../core/policy.ts';
import { detectContentSignature,maximumSignatureSampleBytes } from './content-signature.ts';

export const maximumVideoInputBytes=134217728,videoMimeSchema=z.enum(['video/mp4','video/quicktime','video/webm']);
const digest=z.string().regex(/^[a-f0-9]{64}$/),resources=z.object({peakRssKiB:z.number().int().positive(),userCpuMicros:z.number().int().nonnegative(),systemCpuMicros:z.number().int().nonnegative()}).strict();
const base={validator:z.literal('ffmpeg@9.0.2'),policyVersion:z.literal(1),inputBytes:z.number().int().min(1).max(maximumVideoInputBytes),inputSha256:digest,maximumInputBytes:z.literal(maximumVideoInputBytes),maximumDurationSeconds:z.literal(300),maximumVideoFrames:z.literal(18000),maximumVideoPixels:z.literal(12000000000),resources};
export const videoValidationSchema=z.discriminatedUnion('outcome',[
 z.object({...base,outcome:z.literal('decoded'),mime:videoMimeSchema,container:z.enum(['mov','matroska']),codec:z.enum(['h264','hevc','mpeg4','vp8','vp9','av1']),width:z.number().int().min(1).max(3840),height:z.number().int().min(1).max(3840),durationMs:z.number().int().min(1).max(300000),videoFrames:z.number().int().min(1).max(18000),audioFrames:z.number().int().min(0).max(100000),audio:z.object({codec:z.enum(['aac','opus','vorbis','pcm_s16le']),channels:z.number().int().min(1).max(2),sampleRate:z.number().int().min(8000).max(192000)}).strict().nullable(),decodedBytes:z.number().int().positive().max(24000000000),frameHashSha256:digest}).strict().refine(v=>v.width*v.height<=8294400&&v.width*v.height*v.videoFrames<=12000000000&&v.decodedBytes>=v.videoFrames*(v.width*v.height+2*Math.ceil(v.width/2)*Math.ceil(v.height/2))&&(v.audio===null?v.audioFrames===0:v.audioFrames>0)&&((v.mime==='video/webm')===(v.container==='matroska'))),
 z.object({...base,outcome:z.literal('rejected'),reason:z.enum(['RESOURCE_LIMIT','STREAM_POLICY','METADATA_REJECTED','DECODER_REJECTED']),stage:z.enum(['runtime','probe','stream_policy','decode','frame_evidence']),nativeExitCode:z.number().int().min(-255).max(255).optional()}).strict().refine(v=>v.nativeExitCode===undefined||v.reason==='DECODER_REJECTED'&&v.nativeExitCode!==0)
]);
export type VideoValidation=z.infer<typeof videoValidationSchema>;
const path=z.string().min(2).max(512).refine(v=>v.startsWith('/')&&!/[\0\r\n]/.test(v)&&!v.split('/').some(p=>p==='.'||p==='..'));
const configuration=z.object({pythonPath:path,ffmpegPath:path,ffprobePath:path,timeoutMs:z.number().int().min(1).max(120000).default(30000),signal:z.instanceof(AbortSignal).optional()}).strict();
export function videoValidationMatches(r:VideoValidation,bytes:number,sha:string,mime:string){return r.inputBytes===bytes&&r.inputSha256===sha&&(r.outcome!=='decoded'||r.mime===mime);}
let active=0;
// Internal killable decoder only,not a web endpoint or production isolation.
// Production needs a separate credential-free,network-free,resource-bounded
// service. Whole clip decode does NOT prove malware-free content or playback.
export async function validateVideo(input:Uint8Array,mime:string,options:z.input<typeof configuration>):Promise<VideoValidation>{
 const parsed=configuration.safeParse(options),claimed=videoMimeSchema.safeParse(mime);if(!parsed.success)throw new ApiError(400,'INVALID_VIDEO_VALIDATION_CONFIGURATION');if(!claimed.success)throw new ApiError(400,'UNSUPPORTED_VIDEO_VALIDATION_TYPE');
 if(!(input instanceof Uint8Array)||input.byteLength<1||input.byteLength>maximumVideoInputBytes)throw new ApiError(400,'INVALID_VIDEO_VALIDATION_BYTES');if(process.platform==='win32')throw new ApiError(503,'VIDEO_VALIDATION_UNAVAILABLE');const c=parsed.data;if(c.signal?.aborted)throw new ApiError(503,'VIDEO_VALIDATION_CANCELLED');
 // ponytail: one native video at a time per broker;queue/replicate isolated
 // workers rather than multiplying128MiB input copies and native decoder heaps.
 if(active>=1)throw new ApiError(503,'VIDEO_VALIDATOR_BUSY');const bytes=Buffer.from(input),sha=createHash('sha256').update(bytes).digest('hex'),started=Date.now();active++;
 try{const signature=await detectContentSignature(bytes.subarray(0,maximumSignatureSampleBytes),{timeoutMs:Math.min(c.timeoutMs,1000),signal:c.signal});if(signature.mime!==claimed.data)throw new ApiError(400,'VIDEO_VALIDATION_MIME_MISMATCH');}
 catch(error){bytes.fill(0);active--;if(c.signal?.aborted)throw new ApiError(503,'VIDEO_VALIDATION_CANCELLED');if(error instanceof ApiError&&error.code==='CONTENT_SIGNATURE_TIMEOUT')throw new ApiError(503,'VIDEO_VALIDATION_TIMEOUT');if(error instanceof ApiError&&error.code==='VIDEO_VALIDATION_MIME_MISMATCH')throw error;throw new ApiError(503,'VIDEO_VALIDATION_UNAVAILABLE');}
 if(Date.now()-started>=c.timeoutMs){bytes.fill(0);active--;throw new ApiError(503,'VIDEO_VALIDATION_TIMEOUT');}
 let directory='';try{directory=await mkdtemp(join(tmpdir(),'kavosh-video-input-'));directory=await realpath(directory);}catch{if(directory)await rm(directory,{recursive:true,force:true}).catch(()=>{});bytes.fill(0);active--;throw new ApiError(503,'VIDEO_VALIDATION_UNAVAILABLE');}
 return new Promise((resolve,reject)=>{
  let child:ReturnType<typeof spawn>;try{child=spawn(c.pythonPath,['-I','-B',fileURLToPath(new URL('./video-inspector.py',import.meta.url)),c.ffmpegPath,c.ffprobePath,claimed.data,directory],{detached:true,env:{NODE_ENV:'production',TZ:'UTC'},stdio:['pipe','pipe','pipe']});}catch{bytes.fill(0);void rm(directory,{recursive:true,force:true}).then(()=>{active--;reject(new ApiError(503,'VIDEO_VALIDATION_UNAVAILABLE'));},()=>{active--;reject(new ApiError(503,'VIDEO_VALIDATION_CLEANUP_FAILED'));});return;}
  let failure:ApiError|undefined,size=0;const chunks:Buffer[]=[];
  const stop=(code:string)=>{if(failure)return;failure=new ApiError(503,code);try{if(child.pid)process.kill(-child.pid,'SIGKILL');else child.kill('SIGKILL');}catch{/* already stopped */}};
  const cancel=()=>stop('VIDEO_VALIDATION_CANCELLED'),timer=setTimeout(()=>stop('VIDEO_VALIDATION_TIMEOUT'),Math.max(1,c.timeoutMs-(Date.now()-started)));child.stderr?.resume();child.once('error',()=>stop('VIDEO_VALIDATION_UNAVAILABLE'));
  child.stdout?.on('data',(chunk:Buffer)=>{size+=chunk.length;if(size>16384){stop('VIDEO_VALIDATION_UNAVAILABLE');return;}chunks.push(chunk);});child.stdout?.once('error',()=>stop('VIDEO_VALIDATION_UNAVAILABLE'));child.stdin?.once('error',()=>stop('VIDEO_VALIDATION_UNAVAILABLE'));
  child.once('close',async code=>{clearTimeout(timer);c.signal?.removeEventListener('abort',cancel);bytes.fill(0);try{await rm(directory,{recursive:true,force:true});}catch{failure??=new ApiError(503,'VIDEO_VALIDATION_CLEANUP_FAILED');}active--;if(failure){reject(failure);return;}try{if(code!==0)throw Error('INCOMPLETE_VIDEO_CHILD');const r=videoValidationSchema.parse(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks,size))));if(!videoValidationMatches(r,bytes.length,sha,claimed.data))throw Error('WRONG_VIDEO_CONTENT');resolve(r);}catch{reject(new ApiError(503,'VIDEO_VALIDATION_UNAVAILABLE'));}});
  c.signal?.addEventListener('abort',cancel,{once:true});if(c.signal?.aborted){cancel();return;}try{child.stdin?.end(bytes);}catch{stop('VIDEO_VALIDATION_UNAVAILABLE');}
 });
}
