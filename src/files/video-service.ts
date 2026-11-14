import { createServer,type IncomingMessage,type ServerResponse,request as httpRequest } from 'node:http';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { ApiError } from '../core/policy.ts';
import { validateVideo,videoValidationSchema,videoValidationMatches,videoMimeSchema,maximumVideoInputBytes,type VideoValidation } from './video-validation.ts';

const endpoint='/v1/validate-video',maximumReplyBytes=16384;
const socketPath=z.string().min(2).max(100).refine(v=>v.startsWith('/')&&Buffer.byteLength(v)<=100&&!/[\0\r\n]/.test(v)&&!v.split('/').some(p=>p==='.'||p==='..'));
export const videoServiceConfiguration=z.object({socketPath}).strict();
const digest=/^[a-f0-9]{64}$/,lengthHeader=/^[1-9][0-9]{0,8}$/,allowedHeaders=new Set(['host','connection','content-length','content-type','x-content-sha256','x-video-mime']);
function reply(res:ServerResponse,status:number,body:unknown){if(res.destroyed||res.writableEnded)return;const bytes=Buffer.from(JSON.stringify(body));res.writeHead(status,{'content-type':'application/json','content-length':bytes.length,'cache-control':'no-store','x-content-type-options':'nosniff','connection':'close'});res.end(bytes);}
// Private Unix socket only. No school/person/URL/object-key/storage credential,
// user-selected binary,output path or processing-limit field crosses this API.
export function createVideoValidationServer(options:{pythonPath:string;ffmpegPath:string;ffprobePath:string}){
 let active=0;
 const server=createServer({maxHeaderSize:4096,requestTimeout:15000,headersTimeout:5000,connectionsCheckingInterval:1000},(req,res)=>{void handle(req,res);});
 server.maxConnections=16;server.maxRequestsPerSocket=1;server.keepAliveTimeout=1;server.setTimeout(16000,socket=>socket.destroy());
 server.on('checkContinue',(_req,res)=>reply(res,417,{error:'INVALID_VIDEO_REQUEST'}));server.on('checkExpectation',(_req,res)=>reply(res,417,{error:'INVALID_VIDEO_REQUEST'}));
 server.on('upgrade',(_req,socket)=>socket.destroy());server.on('connect',(_req,socket)=>socket.destroy());server.on('clientError',(_error,socket)=>socket.destroy());
 async function handle(req:IncomingMessage,res:ServerResponse){
  const seen=new Set<string>();let invalid=false;for(let n=0;n<req.rawHeaders.length;n+=2){const key=req.rawHeaders[n].toLowerCase();if(seen.has(key)||!allowedHeaders.has(key))invalid=true;seen.add(key);}
  const length=req.headers['content-length'],sha=req.headers['x-content-sha256'],mime=videoMimeSchema.safeParse(req.headers['x-video-mime']);
  if(invalid||req.method!=='POST'||req.url!==endpoint||req.headers['content-type']!=='application/octet-stream'||typeof length!=='string'||!lengthHeader.test(length)||Number(length)>maximumVideoInputBytes||typeof sha!=='string'||!digest.test(sha)||!mime.success){reply(res,400,{error:'INVALID_VIDEO_REQUEST'});res.once('finish',()=>req.destroy());return;}
  // Hold admission until a cancelled native process has actually exited and
  // its broker-owned private input has been removed,not just until abort fires.
  if(active>=1){reply(res,503,{error:'VIDEO_SERVICE_BUSY'});res.once('finish',()=>req.destroy());return;}
  active++;const stopping=new AbortController(),abort=()=>stopping.abort();let timedOut=false,bytes:Buffer|undefined;
  req.once('aborted',abort);res.once('close',()=>{if(!res.writableFinished)abort();});let timer=setTimeout(()=>{timedOut=true;abort();req.destroy();},15000);
  try{
   bytes=Buffer.alloc(Number(length));let used=0;for await(const chunk of req){if(stopping.signal.aborted||used+chunk.length>bytes.length)throw Error('INVALID_BODY');used+=chunk.copy(bytes,used);}
   clearTimeout(timer);req.socket.setTimeout(0);if(used!==bytes.length||createHash('sha256').update(bytes).digest('hex')!==sha)throw new ApiError(400,'INVALID_VIDEO_REQUEST');
   timer=setTimeout(()=>{timedOut=true;abort();},30000);const result=await validateVideo(bytes,mime.data,{...options,timeoutMs:30000,signal:stopping.signal});if(stopping.signal.aborted)throw Error('CANCELLED');reply(res,200,result);
  }catch(error){reply(res,error instanceof ApiError&&error.status===400?400:timedOut?504:503,{error:error instanceof ApiError&&error.status===400?'INVALID_VIDEO_REQUEST':'VIDEO_SERVICE_UNAVAILABLE'});}
  finally{clearTimeout(timer);req.removeListener('aborted',abort);stopping.abort();bytes?.fill(0);active--;}
 }
 return server;
}
let activeClients=0;
export async function validateVideoViaService(input:Uint8Array,mime:string,options:{socketPath:string;signal?:AbortSignal}):Promise<VideoValidation>{
 const parsed=z.object({socketPath,signal:z.instanceof(AbortSignal).optional()}).strict().safeParse(options),claimed=videoMimeSchema.safeParse(mime);if(!parsed.success)throw new ApiError(400,'INVALID_VIDEO_SERVICE_CONFIGURATION');if(!claimed.success)throw new ApiError(400,'UNSUPPORTED_VIDEO_VALIDATION_TYPE');
 if(!(input instanceof Uint8Array)||input.byteLength<1||input.byteLength>maximumVideoInputBytes)throw new ApiError(400,'INVALID_VIDEO_VALIDATION_BYTES');const c=parsed.data;if(c.signal?.aborted)throw new ApiError(503,'VIDEO_SERVICE_CANCELLED');if(activeClients>=1)throw new ApiError(503,'VIDEO_SERVICE_BUSY');
 const bytes=Buffer.from(input),sha=createHash('sha256').update(bytes).digest('hex');activeClients++;
 try{return await new Promise<VideoValidation>((resolve,reject)=>{
  let settled=false,response:IncomingMessage|undefined;const req=httpRequest({socketPath:c.socketPath,path:endpoint,method:'POST',agent:false,maxHeaderSize:4096,headers:{host:'localhost',connection:'close','content-type':'application/octet-stream','content-length':bytes.length,'x-content-sha256':sha,'x-video-mime':claimed.data}});
  const finish=(code?:string,value?:VideoValidation)=>{if(settled)return;settled=true;clearTimeout(timer);c.signal?.removeEventListener('abort',cancel);response?.destroy();req.destroy();if(code)reject(new ApiError(503,code));else resolve(value!);};
  const cancel=()=>finish('VIDEO_SERVICE_CANCELLED'),timer=setTimeout(()=>finish('VIDEO_SERVICE_TIMEOUT'),50000);req.once('error',()=>finish('VIDEO_SERVICE_UNAVAILABLE'));
  req.once('response',incoming=>{response=incoming;const length=incoming.headers['content-length'];if(incoming.statusCode!==200||incoming.headers['content-type']!=='application/json'||incoming.headers['content-encoding']||incoming.headers['transfer-encoding']||typeof length!=='string'||!lengthHeader.test(length)||Number(length)>maximumReplyBytes){finish('VIDEO_SERVICE_UNAVAILABLE');return;}
   const out=Buffer.alloc(Number(length));let used=0;incoming.on('data',(chunk:Buffer)=>{if(used+chunk.length>out.length){finish('VIDEO_SERVICE_UNAVAILABLE');return;}used+=chunk.copy(out,used);});incoming.once('error',()=>finish('VIDEO_SERVICE_UNAVAILABLE'));incoming.once('aborted',()=>finish('VIDEO_SERVICE_UNAVAILABLE'));
   incoming.once('end',()=>{if(settled)return;try{if(used!==out.length)throw Error('INCOMPLETE_REPLY');const r=videoValidationSchema.parse(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(out)));if(!videoValidationMatches(r,bytes.length,sha,claimed.data))throw Error('WRONG_RECEIPT');finish(undefined,r);}catch{finish('VIDEO_SERVICE_UNAVAILABLE');}});
  });
  c.signal?.addEventListener('abort',cancel,{once:true});if(c.signal?.aborted)cancel();else try{req.end(bytes);}catch{finish('VIDEO_SERVICE_UNAVAILABLE');}
 });}finally{bytes.fill(0);activeClients--;}
}
