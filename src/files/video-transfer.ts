import { Readable } from 'node:stream';
import type { S3ClientConfig } from '@aws-sdk/client-s3';
import { z } from 'zod';
import { ApiError } from '../core/policy.ts';
import { privateR2 } from '../integrations/r2.ts';
import { r2Connection,r2TargetId,type R2Connection } from '../integrations/r2-config.ts';
import { videoRangeSchema,type VideoRange } from './video-range.ts';

const uuid=z.string().uuid().transform(v=>v.toLowerCase()),digest=z.string().regex(/^[a-f0-9]{64}$/);
const sourceSchema=z.object({academyId:uuid,actorId:uuid,fileId:uuid,targetId:digest,bytes:z.number().int().min(1).max(134217728),sha256:digest,etag:z.string().min(3).max(202).regex(/^"[\x21\x23-\x7e]+"$/)}).strict();
let active=0;const actors=new Map<string,number>();
// ponytail:32live reads/process,4/verified actor;replicate bounded web workers
// for more throughput. No128MiB buffering or per-user permanent map entries.
// IO only,NOT authorization. Caller must first prove the current scoped native
// source and commit/release its DB transaction BEFORE opening this transfer.
export async function openVideoTransfer(configuration:R2Connection,source:z.input<typeof sourceSchema>,selection:VideoRange,options:{signal?:AbortSignal;head?:boolean;timeoutMs?:number;handler?:S3ClientConfig['requestHandler']}={}):Promise<ReadableStream<Uint8Array>|null>{
 const parsed=sourceSchema.safeParse(source),range=videoRangeSchema.safeParse(selection),config=r2Connection.safeParse(configuration),timeout=options.timeoutMs??600000;
 if(!parsed.success||!range.success||!config.success||!Number.isInteger(timeout)||timeout<1||timeout>600000||options.signal!==undefined&&!(options.signal instanceof AbortSignal)||options.head!==undefined&&typeof options.head!=='boolean')throw new ApiError(503,'INVALID_VIDEO_TRANSFER_CONFIGURATION');
 const s=parsed.data,r=range.data;
 if(r.status===416||r.total!==s.bytes||r.etag!=='"sha256-'+s.sha256+'"'||r2TargetId(config.data)!==s.targetId||s.bytes>config.data.maximumUploadBytes)throw new ApiError(503,'INVALID_VIDEO_TRANSFER_SOURCE');
 if(options.signal?.aborted)throw new ApiError(503,'VIDEO_TRANSFER_CANCELLED');const actor=s.academyId+':'+s.actorId;
 if(active>=32||(actors.get(actor)??0)>=4)throw new ApiError(503,'VIDEO_TRANSFER_BUSY');active++;actors.set(actor,(actors.get(actor)??0)+1);
 let storage:ReturnType<typeof privateR2>;try{storage=privateR2(config.data,s.academyId,options.handler);}catch{active--;const count=actors.get(actor)!-1;if(count)actors.set(actor,count);else actors.delete(actor);throw new ApiError(503,'VIDEO_TRANSFER_UNAVAILABLE');}
 const controller=new AbortController(),abort=()=>controller.abort();options.signal?.addEventListener('abort',abort,{once:true});
 let ioObserved=false,ioSettled=false,consumerSettled=false,released=false,stopped=false,web:ReadableStreamDefaultController<Uint8Array>|undefined;
 const release=()=>{if(released||!ioSettled||!consumerSettled)return;released=true;active--;const count=actors.get(actor)!-1;if(count)actors.set(actor,count);else actors.delete(actor);options.signal?.removeEventListener('abort',abort);storage.close();};
 const observe=(settled:Promise<unknown>)=>{ioObserved=true;void settled.then(()=>{ioSettled=true;release();},()=>{ioSettled=true;release();});};
 const safeError=()=>new Error('PRIVATE_VIDEO_TRANSFER_UNAVAILABLE'),fail=()=>{if(stopped)return;stopped=true;consumerSettled=true;abort();web?.error(safeError());release();};
 let ready!:(value:Readable)=>void;const available=new Promise<Readable>(resolve=>ready=resolve);
 const consume=async(source:Readable)=>{ready(source);await new Promise<void>((resolve,reject)=>{source.once('end',resolve);source.once('error',()=>reject(safeError()));source.once('close',()=>{if(!source.readableEnded)reject(safeError());});});return true;};
 const partial=options.head?{start:0,end:0}:r.status===206?{start:r.start,end:r.end}:null;
 const pending=(partial?storage.inspectCleanRange(s.fileId,{bytes:s.bytes,ifMatch:s.etag},partial,consume,timeout,controller.signal,observe):storage.inspectClean(s.fileId,{bytes:s.bytes,sha256:s.sha256,ifMatch:s.etag},consume,timeout,controller.signal,observe)).then(result=>{if(!options.head&&r.length===s.bytes&&result.sha256!==s.sha256)throw safeError();return result;});
 void pending.catch(()=>{if(!ioObserved)ioSettled=true;fail();});
 try{
  const source=await Promise.race([available,pending.then(()=>{throw safeError();})]);
  if(options.head){for await(const _chunk of source){if(controller.signal.aborted)throw safeError();}await pending;consumerSettled=true;stopped=true;release();return null;}
  const iterator=source[Symbol.asyncIterator]();
  return new ReadableStream<Uint8Array>({
   start(value){web=value;if(stopped)value.error(safeError());},
   async pull(value){try{const item=await iterator.next();if(stopped)return;if(item.done){await pending;if(stopped)return;stopped=true;consumerSettled=true;value.close();release();return;}if(!(item.value instanceof Uint8Array)||item.value.byteLength>1048576)throw safeError();value.enqueue(item.value);}catch{fail();}},
   cancel(){stopped=true;consumerSettled=true;abort();void iterator.return?.().catch(()=>{});release();}
  },new ByteLengthQueuingStrategy({highWaterMark:65536}));
 }catch{consumerSettled=true;fail();release();throw new ApiError(503,'VIDEO_TRANSFER_UNAVAILABLE');}
}
