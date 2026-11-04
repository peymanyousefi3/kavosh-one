import { fork } from 'node:child_process';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { ApiError } from '../core/policy.ts';

export const maximumImageInputBytes=33_554_432,maximumImagePixels=64_000_000;
const mime=z.enum(['image/jpeg','image/png','image/webp','image/gif','image/avif']);
const digest=z.string().regex(/^[a-f0-9]{64}$/);
const limits={maximumPixels:z.number().int().min(1).max(maximumImagePixels),maximumFrames:z.number().int().min(1).max(256)};
const base={validator:z.literal('sharp@0.35.5'),libvips:z.literal('8.18.7'),inputBytes:z.number().int().min(1).max(maximumImageInputBytes),inputSha256:digest,...limits,
 resources:z.object({peakRssKiB:z.number().int().positive(),userCpuMicros:z.number().int().nonnegative(),systemCpuMicros:z.number().int().nonnegative()}).strict()};
export const imageValidationSchema=z.discriminatedUnion('outcome',[
 z.object({...base,outcome:z.literal('decoded'),mime,width:z.number().int().positive().max(maximumImagePixels),height:z.number().int().positive().max(maximumImagePixels),
  frames:z.number().int().min(1).max(256),channels:z.number().int().min(1).max(4),decodedBytes:z.number().int().positive().max(maximumImagePixels*4),decodedSha256:digest}).strict(),
 z.object({...base,outcome:z.literal('rejected'),reason:z.enum(['UNSUPPORTED_FORMAT','MIME_MISMATCH','PIXEL_LIMIT','FRAME_LIMIT','CONTAINER_REJECTED','DECODER_REJECTED'])}).strict()
]);
export type ImageValidation=z.infer<typeof imageValidationSchema>;
const optionsSchema=z.object({maximumPixels:limits.maximumPixels.default(maximumImagePixels),maximumFrames:limits.maximumFrames.default(64),
 timeoutMs:z.number().int().min(1).max(30000).default(10000),signal:z.instanceof(AbortSignal).optional()}).strict();
let active=0;

// Internal decoder adapter, not publication or malware clearance. Bound bytes,
// aggregate pixels/frames, JS heap and lifetime. A killable child process keeps
// native codecs outside the caller; it is NOT an OS/container sandbox. Hardened
// worker runtime, network/filesystem isolation and cgroup limits remain required.
export async function validateImage(input:Uint8Array,claimedMimeType:string,options:z.input<typeof optionsSchema>={}):Promise<ImageValidation> {
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
  catch{active--;reject(new ApiError(503,'IMAGE_VALIDATION_UNAVAILABLE'));return;}
  child.stderr?.resume();let value:ImageValidation|undefined,error:ApiError|undefined;
  const stop=(code:string)=>{error??=new ApiError(503,code);child.kill('SIGKILL');};
  const cancel=()=>stop('IMAGE_VALIDATION_CANCELLED');
  const timer=setTimeout(()=>stop('IMAGE_VALIDATION_TIMEOUT'),config.timeoutMs);
  child.once('error',()=>stop('IMAGE_VALIDATION_UNAVAILABLE'));
  child.once('message',(message:unknown)=>{
   if(error)return;
   const envelope=z.object({pid:z.number().int().positive(),result:imageValidationSchema}).strict().safeParse(message);
   if(!envelope.success||envelope.data.pid!==child.pid||envelope.data.pid===process.pid){stop('IMAGE_VALIDATION_UNAVAILABLE');return;}
   const result=envelope.data.result;
   if(result.inputBytes!==inputBytes||result.inputSha256!==inputSha256||result.maximumPixels!==config.maximumPixels||result.maximumFrames!==config.maximumFrames
    ||(result.outcome==='decoded'&&(result.mime!==claimed.data||result.frames>config.maximumFrames||result.width*result.height*result.frames>config.maximumPixels
      ||result.decodedBytes!==result.width*result.height*result.frames*result.channels))){stop('IMAGE_VALIDATION_UNAVAILABLE');return;}
   value=result;child.kill('SIGKILL');
  });
  child.once('close',()=>{
   clearTimeout(timer);config.signal?.removeEventListener('abort',cancel);active--;
   // Resolve only after the process is gone, including successful decoding.
   if(error)reject(error);else if(value)resolve(value);else reject(new ApiError(503,'IMAGE_VALIDATION_UNAVAILABLE'));
  });
  config.signal?.addEventListener('abort',cancel,{once:true});
  if(config.signal?.aborted){cancel();return;}
  child.send({bytes:copy,claimedMimeType:claimed.data,maximumPixels:config.maximumPixels,maximumFrames:config.maximumFrames},sendError=>{if(sendError)stop('IMAGE_VALIDATION_UNAVAILABLE');});
 });
}
