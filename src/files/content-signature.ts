import { Worker } from 'node:worker_threads';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { ApiError } from '../core/policy.ts';

export const maximumSignatureSampleBytes=16384;
const mime=z.string().regex(/^[a-z0-9][a-z0-9.+-]{0,99}\/[a-z0-9][a-z0-9.+-]{0,99}$/),ext=z.string().regex(/^[a-z0-9]{1,20}$/);
export const signatureSchema=z.object({detector:z.literal('file-type@22.3.0'),sampleBytes:z.number().int().min(1).max(maximumSignatureSampleBytes),sampleSha256:z.string().regex(/^[a-f0-9]{64}$/),mime:mime.nullable(),extension:ext.nullable()}).strict().refine(v=>(v.mime===null)===(v.extension===null));
export type ContentSignature=z.infer<typeof signatureSchema>;

// The package explicitly describes detection as best-effort, not validation:
// https://github.com/sindresorhus/file-type#readme
// Bound the sample, CPU time and JS heap off the worker's event loop. Native
// allocations still require the process/container memory limits at deployment.
export async function detectContentSignature(sample:Uint8Array,options:{signal?:AbortSignal;timeoutMs?:number}={}):Promise<ContentSignature> {
  if(!(sample instanceof Uint8Array)||sample.byteLength<1||sample.byteLength>maximumSignatureSampleBytes)throw new ApiError(400,'INVALID_CONTENT_SAMPLE');
  const timeout=options.timeoutMs??2000;if(!Number.isInteger(timeout)||timeout<1||timeout>5000)throw new ApiError(400,'INVALID_CONTENT_DETECTION_TIMEOUT');
  if(options.signal?.aborted)throw new ApiError(503,'CONTENT_SIGNATURE_CANCELLED');
  const copy=Uint8Array.from(sample),sampleBytes=copy.byteLength,sampleSha256=createHash('sha256').update(copy).digest('hex');
  const worker=new Worker(new URL('./signature-detector.mjs',import.meta.url),{workerData:copy,transferList:[copy.buffer],env:{},execArgv:[],stdout:true,stderr:true,resourceLimits:{maxOldGenerationSizeMb:32,maxYoungGenerationSizeMb:8,stackSizeMb:2}});
  worker.stdout.resume();worker.stderr.resume();
  return new Promise((resolve,reject)=>{
    let settled=false;
    const finish=(error:ApiError|null,value?:ContentSignature)=>{
      if(settled)return;settled=true;clearTimeout(deadline);options.signal?.removeEventListener('abort',cancel);
      // Do not return while a timed-out/malformed detector is still running.
      worker.terminate().then(()=>error?reject(error):resolve(value!),()=>reject(new ApiError(503,'CONTENT_SIGNATURE_UNAVAILABLE')));
    };
    const cancel=()=>finish(new ApiError(503,'CONTENT_SIGNATURE_CANCELLED'));
    const deadline=setTimeout(()=>finish(new ApiError(503,'CONTENT_SIGNATURE_TIMEOUT')),timeout);
    worker.once('error',()=>finish(new ApiError(503,'CONTENT_SIGNATURE_UNAVAILABLE')));
    worker.once('exit',()=>finish(new ApiError(503,'CONTENT_SIGNATURE_UNAVAILABLE')));
    worker.once('message',(message:unknown)=>{
      const parsed=z.object({mime,ext}).strict().nullable().safeParse(message);
      if(!parsed.success){finish(new ApiError(503,'CONTENT_SIGNATURE_UNAVAILABLE'));return;}
      finish(null,{detector:'file-type@22.3.0',sampleBytes,sampleSha256,mime:parsed.data?.mime??null,extension:parsed.data?.ext??null});
    });
    options.signal?.addEventListener('abort',cancel,{once:true});if(options.signal?.aborted)cancel();
  });
}
