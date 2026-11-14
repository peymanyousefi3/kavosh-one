import { fork } from 'node:child_process';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { ApiError } from '../core/policy.ts';

export const maximumImageInputBytes=33_554_432,maximumImagePixels=64_000_000;
export const imageMimeSchema=z.enum(['image/jpeg','image/png','image/webp','image/gif','image/avif']);
const mime=imageMimeSchema;
const digest=z.string().regex(/^[a-f0-9]{64}$/);
export const profileImagePurposeSchema=z.enum(['avatar','achievement']);
export type ProfileImagePurpose=z.infer<typeof profileImagePurposeSchema>;
const profileImage=z.object({purpose:profileImagePurposeSchema,mime:z.literal('image/webp'),width:z.number().int().positive().max(2048),height:z.number().int().positive().max(2048),bytes:z.number().int().positive().max(4194304),sha256:digest,base64:z.string().min(16).max(5592408).regex(/^[A-Za-z0-9+/]*={0,2}$/),framePolicy:z.literal('first_frame'),metadataPolicy:z.literal('stripped')}).strict().refine(v=>v.purpose!=='avatar'||v.width<=512&&v.height<=512&&v.bytes<=1048576);
const limits={maximumPixels:z.number().int().min(1).max(maximumImagePixels),maximumFrames:z.number().int().min(1).max(256)};
const base={validator:z.literal('sharp@0.35.5'),libvips:z.literal('8.18.7'),inputBytes:z.number().int().min(1).max(maximumImageInputBytes),inputSha256:digest,...limits,
 resources:z.object({peakRssKiB:z.number().int().positive(),userCpuMicros:z.number().int().nonnegative(),systemCpuMicros:z.number().int().nonnegative()}).strict()};
const decoded=z.object({...base,outcome:z.literal('decoded'),mime,width:z.number().int().positive().max(maximumImagePixels),height:z.number().int().positive().max(maximumImagePixels),frames:z.number().int().min(1).max(256),channels:z.number().int().min(1).max(4),decodedBytes:z.number().int().positive().max(maximumImagePixels*4),decodedSha256:digest}).strict();
const rejected=z.object({...base,outcome:z.literal('rejected'),reason:z.enum(['UNSUPPORTED_FORMAT','MIME_MISMATCH','PIXEL_LIMIT','FRAME_LIMIT','CONTAINER_REJECTED','DECODER_REJECTED'])}).strict();
export const imageValidationSchema=z.discriminatedUnion('outcome',[decoded,rejected]);
export const profileImageValidationSchema=z.discriminatedUnion('outcome',[decoded.extend({profileImage}),rejected]);
export type ImageValidation=z.infer<typeof imageValidationSchema>;
export type ProfileImageValidation=z.infer<typeof profileImageValidationSchema>;
export function imageValidationMatches(result:ImageValidation|ProfileImageValidation,bytes:number,sha256:string,claimedMimeType:string,maximumPixels=maximumImagePixels,maximumFrames=64,purpose?:ProfileImagePurpose) {
 if(result.outcome==='decoded'){
  const p='profileImage'in result?result.profileImage:undefined;if(purpose===undefined?p!==undefined:p?.purpose!==purpose)return false;
  if(p){const b=Buffer.from(p.base64,'base64');try{if(b.length!==p.bytes||b.toString('base64')!==p.base64||createHash('sha256').update(b).digest('hex')!==p.sha256||b.length<12||b.toString('ascii',0,4)!=='RIFF'||b.toString('ascii',8,12)!=='WEBP'||b.readUInt32LE(4)+8!==b.length)return false;}finally{b.fill(0);}}
 }
 return result.inputBytes===bytes&&result.inputSha256===sha256&&result.maximumPixels===maximumPixels&&result.maximumFrames===maximumFrames
  &&(result.outcome==='rejected'||(result.mime===claimedMimeType&&result.frames<=maximumFrames&&(result.mime!=='image/avif'||result.frames===1)
   &&result.width*result.height*result.frames<=maximumPixels&&result.decodedBytes===result.width*result.height*result.frames*result.channels));
}
const optionsSchema=z.object({maximumPixels:limits.maximumPixels.default(maximumImagePixels),maximumFrames:limits.maximumFrames.default(64),
 timeoutMs:z.number().int().min(1).max(30000).default(10000),signal:z.instanceof(AbortSignal).optional()}).strict();
let active=0;

// Internal decoder adapter, not publication or malware clearance. Bound bytes,
// aggregate pixels/frames, JS heap and lifetime. A killable child process keeps
// native codecs outside the caller; it is NOT an OS/container sandbox. Hardened
// worker runtime, network/filesystem isolation and cgroup limits remain required.
async function processImage(input:Uint8Array,claimedMimeType:string,options:z.input<typeof optionsSchema>,purpose?:ProfileImagePurpose):Promise<ImageValidation|ProfileImageValidation> {
 const parsed=optionsSchema.safeParse(options),claimed=mime.safeParse(claimedMimeType);
 if(!parsed.success)throw new ApiError(400,'INVALID_IMAGE_VALIDATION_OPTIONS');
 if(!(input instanceof Uint8Array)||input.byteLength<1||input.byteLength>maximumImageInputBytes)throw new ApiError(400,'INVALID_IMAGE_VALIDATION_BYTES');
 if(!claimed.success)throw new ApiError(400,'UNSUPPORTED_IMAGE_VALIDATION_TYPE');
 const config=parsed.data;if(config.signal?.aborted)throw new ApiError(503,'IMAGE_VALIDATION_CANCELLED');
 // ponytail: two native processes per caller process; scale through the durable
 // job queue and measured worker replicas, not an unbounded codec process fanout.
 if(active>=2)throw new ApiError(503,'IMAGE_VALIDATOR_BUSY');
 const copy=Buffer.from(input),inputBytes=copy.length,inputSha256=createHash('sha256').update(copy).digest('hex');active++;
 return new Promise((resolve,reject)=>{
  let child:ReturnType<typeof fork>;
  try {child=fork(new URL('./image-decoder.mjs',import.meta.url),[],{execArgv:['--max-old-space-size=64'],env:{NODE_ENV:'production',TZ:'UTC'},serialization:'advanced',stdio:['ignore','ignore','pipe','ipc']});}
  catch{copy.fill(0);active--;reject(new ApiError(503,'IMAGE_VALIDATION_UNAVAILABLE'));return;}
  child.stderr?.resume();let value:ImageValidation|ProfileImageValidation|undefined,error:ApiError|undefined;
  const stop=(code:string)=>{error??=new ApiError(503,code);child.kill('SIGKILL');};
  const cancel=()=>stop('IMAGE_VALIDATION_CANCELLED');
  const timer=setTimeout(()=>stop('IMAGE_VALIDATION_TIMEOUT'),config.timeoutMs);
  child.once('error',()=>stop('IMAGE_VALIDATION_UNAVAILABLE'));
  child.once('message',(message:unknown)=>{
   if(error)return;
   const envelope=z.object({pid:z.number().int().positive(),result:purpose?profileImageValidationSchema:imageValidationSchema}).strict().safeParse(message);
   if(!envelope.success||envelope.data.pid!==child.pid||envelope.data.pid===process.pid){stop('IMAGE_VALIDATION_UNAVAILABLE');return;}
   const result=envelope.data.result;
   if(!imageValidationMatches(result,inputBytes,inputSha256,claimed.data,config.maximumPixels,config.maximumFrames,purpose)){stop('IMAGE_VALIDATION_UNAVAILABLE');return;}
   value=result;child.kill('SIGKILL');
  });
  child.once('close',()=>{
   clearTimeout(timer);config.signal?.removeEventListener('abort',cancel);copy.fill(0);active--;
   // Resolve only after the process is gone, including successful decoding.
   if(error)reject(error);else if(value)resolve(value);else reject(new ApiError(503,'IMAGE_VALIDATION_UNAVAILABLE'));
  });
  config.signal?.addEventListener('abort',cancel,{once:true});
  if(config.signal?.aborted){cancel();return;}
  try{child.send({bytes:copy,claimedMimeType:claimed.data,maximumPixels:config.maximumPixels,maximumFrames:config.maximumFrames,...purpose?{profileImagePurpose:purpose}:{}},sendError=>{if(sendError)stop('IMAGE_VALIDATION_UNAVAILABLE');});}
  catch{stop('IMAGE_VALIDATION_UNAVAILABLE');}
 });
}
export const validateImage=(input:Uint8Array,claimedMimeType:string,options:z.input<typeof optionsSchema>={}):Promise<ImageValidation>=>processImage(input,claimedMimeType,options) as Promise<ImageValidation>;
// Preparation only: does not publish,write storage or grant consent. Original
// pixels/metadata stay in the original upload;only a new bounded copy is returned.
export async function deriveProfileImage(input:Uint8Array,claimedMimeType:string,purpose:string,options:z.input<typeof optionsSchema>={}):Promise<ProfileImageValidation>{
 const parsed=profileImagePurposeSchema.safeParse(purpose);if(!parsed.success)throw new ApiError(400,'INVALID_PROFILE_IMAGE_PURPOSE');return processImage(input,claimedMimeType,options,parsed.data) as Promise<ProfileImageValidation>;
}
