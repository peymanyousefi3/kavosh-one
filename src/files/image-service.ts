import { createServer,type IncomingMessage,type ServerResponse,request as httpRequest } from 'node:http';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { ApiError } from '../core/policy.ts';
import { imageMimeSchema,imageValidationSchema,profileImageValidationSchema,profileImagePurposeSchema,imageValidationMatches,maximumImageInputBytes,validateImage,deriveProfileImage,type ImageValidation,type ProfileImageValidation,type ProfileImagePurpose } from './image-validation.ts';

const endpoint='/v1/validate-image',maximumReplyBytes=4096;
const profileEndpoint=(purpose:ProfileImagePurpose)=>'/v1/profile-image/'+purpose;
const socketSchema=z.string().min(2).max(100).refine(v=>v.startsWith('/')&&Buffer.byteLength(v)<=100&&!/[\0\r\n]/.test(v)&&!v.split('/').some(p=>p==='.'||p==='..'));
export const imageServiceConfiguration=z.object({socketPath:socketSchema}).strict();
const digest=/^[a-f0-9]{64}$/,lengthHeader=/^[1-9][0-9]{0,7}$/;
const allowedHeaders=new Set(['host','connection','content-length','content-type','x-image-type','x-content-sha256']);
function reply(res:ServerResponse,status:number,body:unknown) {
 if(res.destroyed||res.writableEnded)return;
 const bytes=Buffer.from(JSON.stringify(body));res.writeHead(status,{'content-type':'application/json','content-length':bytes.length,'cache-control':'no-store','x-content-type-options':'nosniff','connection':'close'});res.end(bytes);
}

// Private Unix-socket protocol, NEVER mounted in the public web router. Only
// bytes,their digest,an allowed MIME claim and a fixed preparation purpose
// cross this boundary: no school,
// person, object key, URL, auth cookie, storage credential or output path.
// Production startup must independently enforce the isolated runtime contract.
export function createImageValidationServer() {
 let active=0;
 const server=createServer({maxHeaderSize:4096,requestTimeout:5000,headersTimeout:5000,connectionsCheckingInterval:1000},(req,res)=>{void handle(req,res);});
 server.maxConnections=16;server.maxRequestsPerSocket=1;server.keepAliveTimeout=1;server.setTimeout(6000,socket=>socket.destroy());
 server.on('checkContinue',(_req,res)=>reply(res,417,{error:'INVALID_IMAGE_REQUEST'}));
 server.on('checkExpectation',(_req,res)=>reply(res,417,{error:'INVALID_IMAGE_REQUEST'}));
 server.on('upgrade',(_req,socket)=>socket.destroy());server.on('connect',(_req,socket)=>socket.destroy());
 server.on('clientError',(_error,socket)=>socket.destroy());
 async function handle(req:IncomingMessage,res:ServerResponse) {
  const seen=new Set<string>();let invalid=false;
  for(let i=0;i<req.rawHeaders.length;i+=2){const key=req.rawHeaders[i].toLowerCase();if(seen.has(key)||!allowedHeaders.has(key))invalid=true;seen.add(key);}
  const claimed=imageMimeSchema.safeParse(req.headers['x-image-type']),rawLength=req.headers['content-length'],hash=req.headers['x-content-sha256'];
  const purpose=req.url===profileEndpoint('avatar')?'avatar':req.url===profileEndpoint('achievement')?'achievement':undefined;
  if(invalid||req.method!=='POST'||(req.url!==endpoint&&!purpose)||req.headers['content-type']!=='application/octet-stream'||!claimed.success
   ||typeof rawLength!=='string'||!lengthHeader.test(rawLength)||Number(rawLength)>maximumImageInputBytes||typeof hash!=='string'||!digest.test(hash)) {
   reply(res,400,{error:'INVALID_IMAGE_REQUEST'});res.once('finish',()=>req.destroy());return;
  }
  // Admission is before allocation/body consumption, and remains held until a
  // cancelled/timed-out native child is actually reaped by validateImage.
  if(active>=2){reply(res,503,{error:'IMAGE_SERVICE_BUSY'});res.once('finish',()=>req.destroy());return;}
  active++;const stopping=new AbortController();let timedOut=false;
  const abort=()=>stopping.abort();req.once('aborted',abort);res.once('close',()=>{if(!res.writableFinished)abort();});
  let timer=setTimeout(()=>{timedOut=true;abort();req.destroy();},5000);
  try {
   const bytes=Buffer.alloc(Number(rawLength));let used=0;
   for await(const chunk of req){if(stopping.signal.aborted||used+chunk.length>bytes.length)throw new Error('INVALID_BODY');used+=chunk.copy(bytes,used);}
   clearTimeout(timer);req.socket.setTimeout(0);if(used!==bytes.length||createHash('sha256').update(bytes).digest('hex')!==hash)throw new ApiError(400,'INVALID_IMAGE_REQUEST');
   // The decode has its own fixed ten-second CPU/wall deadline. Network input
   // never chooses execution paths, limits or a replacement native binary.
   timer=setTimeout(()=>{timedOut=true;abort();},10000);
   const result=purpose?await deriveProfileImage(bytes,claimed.data,purpose,{signal:stopping.signal}):await validateImage(bytes,claimed.data,{signal:stopping.signal});
   if(stopping.signal.aborted)throw new Error('CANCELLED');reply(res,200,result);
  }catch(error){reply(res,error instanceof ApiError&&error.status===400?400:timedOut?504:503,{error:error instanceof ApiError&&error.status===400?'INVALID_IMAGE_REQUEST':'IMAGE_SERVICE_UNAVAILABLE'});}
  finally{clearTimeout(timer);req.removeListener('aborted',abort);stopping.abort();active--;}
 }
 return server;
}

let activeClients=0;
// Configuration is operator-only; socketPath cannot be an HTTP URL and there is
// no TCP/DNS fallback, redirect, cookie jar or credentials to forward.
async function processImageViaService(input:Uint8Array,claimedMimeType:string,options:{socketPath:string;signal?:AbortSignal},purpose?:ProfileImagePurpose):Promise<ImageValidation|ProfileImageValidation> {
 const config=z.object({socketPath:socketSchema,signal:z.instanceof(AbortSignal).optional()}).strict().safeParse(options),claimed=imageMimeSchema.safeParse(claimedMimeType);
 if(!config.success)throw new ApiError(400,'INVALID_IMAGE_SERVICE_CONFIGURATION');
 if(!claimed.success)throw new ApiError(400,'UNSUPPORTED_IMAGE_VALIDATION_TYPE');
 if(!(input instanceof Uint8Array)||!input.byteLength||input.byteLength>maximumImageInputBytes)throw new ApiError(400,'INVALID_IMAGE_VALIDATION_BYTES');
 if(config.data.signal?.aborted)throw new ApiError(503,'IMAGE_SERVICE_CANCELLED');
 if(activeClients>=2)throw new ApiError(503,'IMAGE_SERVICE_BUSY');
 const bytes=Buffer.from(input),hash=createHash('sha256').update(bytes).digest('hex');activeClients++;
 try{return await new Promise<ImageValidation|ProfileImageValidation>((resolve,reject)=>{
  let settled=false,response:IncomingMessage|undefined;
  const req=httpRequest({socketPath:config.data.socketPath,path:purpose?profileEndpoint(purpose):endpoint,method:'POST',agent:false,maxHeaderSize:4096,headers:{host:'localhost',connection:'close','content-type':'application/octet-stream','content-length':bytes.length,'x-image-type':claimed.data,'x-content-sha256':hash}});
  const finish=(code?:string,value?:ImageValidation|ProfileImageValidation)=>{
   if(settled)return;settled=true;clearTimeout(timer);config.data.signal?.removeEventListener('abort',cancel);response?.destroy();req.destroy();
   if(code)reject(new ApiError(503,code));else resolve(value!);
  };
  const cancel=()=>finish('IMAGE_SERVICE_CANCELLED');
  const timer=setTimeout(()=>finish('IMAGE_SERVICE_TIMEOUT'),15000);
  req.once('error',()=>finish('IMAGE_SERVICE_UNAVAILABLE'));
  req.once('response',incoming=>{
   response=incoming;const size=incoming.headers['content-length'];
   if(incoming.statusCode!==200||incoming.headers['content-type']!=='application/json'||incoming.headers['content-encoding']||incoming.headers['transfer-encoding']
    ||typeof size!=='string'||!lengthHeader.test(size)||Number(size)>(purpose==='avatar'?1402200:purpose?5596504:maximumReplyBytes)){finish('IMAGE_SERVICE_UNAVAILABLE');return;}
   const out=Buffer.alloc(Number(size));let used=0;
   incoming.on('data',(chunk:Buffer)=>{if(used+chunk.length>out.length){finish('IMAGE_SERVICE_UNAVAILABLE');return;}used+=chunk.copy(out,used);});
   incoming.once('error',()=>finish('IMAGE_SERVICE_UNAVAILABLE'));incoming.once('aborted',()=>finish('IMAGE_SERVICE_UNAVAILABLE'));
   incoming.once('end',()=>{
    if(settled)return;
    try{if(used!==out.length)throw new Error('INCOMPLETE_REPLY');const parsed=(purpose?profileImageValidationSchema:imageValidationSchema).parse(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(out)));
     if(!imageValidationMatches(parsed,bytes.length,hash,claimed.data,undefined,undefined,purpose))throw new Error('WRONG_RECEIPT');finish(undefined,parsed);
    }catch{finish('IMAGE_SERVICE_UNAVAILABLE');}
   });
  });
  config.data.signal?.addEventListener('abort',cancel,{once:true});if(config.data.signal?.aborted)cancel();else try{req.end(bytes);}catch{finish('IMAGE_SERVICE_UNAVAILABLE');}
 });}finally{bytes.fill(0);activeClients--;}
}
export const validateImageViaService=(input:Uint8Array,claimedMimeType:string,options:{socketPath:string;signal?:AbortSignal}):Promise<ImageValidation>=>processImageViaService(input,claimedMimeType,options) as Promise<ImageValidation>;
export async function deriveProfileImageViaService(input:Uint8Array,claimedMimeType:string,purpose:string,options:{socketPath:string;signal?:AbortSignal}):Promise<ProfileImageValidation>{const p=profileImagePurposeSchema.safeParse(purpose);if(!p.success)throw new ApiError(400,'INVALID_PROFILE_IMAGE_PURPOSE');return processImageViaService(input,claimedMimeType,options,p.data) as Promise<ProfileImageValidation>;}
