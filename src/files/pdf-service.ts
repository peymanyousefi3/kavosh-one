import { createServer,type IncomingMessage,type ServerResponse,request as httpRequest } from 'node:http';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { ApiError } from '../core/policy.ts';
import { pdfValidationSchema,pdfValidationMatches,maximumPdfInputBytes,validateUnsignedPdf,type PdfValidation } from './pdf-validation.ts';

const endpoint='/v1/validate-pdf',maximumReplyBytes=1_048_576;
const socketSchema=z.string().min(2).max(100).refine(v=>v.startsWith('/')&&Buffer.byteLength(v)<=100&&!/[\0\r\n]/.test(v)&&!v.split('/').some(p=>p==='.'||p==='..'));
export const pdfServiceConfiguration=z.object({socketPath:socketSchema}).strict();
const digest=/^[a-f0-9]{64}$/,lengthHeader=/^[1-9][0-9]{0,7}$/;
const allowedHeaders=new Set(['host','connection','content-length','content-type','x-content-sha256']);
function reply(res:ServerResponse,status:number,body:unknown) {
 if(res.destroyed||res.writableEnded)return;
 const bytes=Buffer.from(JSON.stringify(body));res.writeHead(status,{'content-type':'application/json','content-length':bytes.length,'cache-control':'no-store','x-content-type-options':'nosniff','connection':'close'});res.end(bytes);
}

// Private Unix-socket protocol, NEVER mounted in the public web router. Only
// bytes and their digest cross this boundary: no school,
// person, object key, URL, auth cookie, storage credential or output path.
// Production startup must independently enforce the isolated runtime contract.
export function createPdfValidationServer(options:{pythonPath:string}) {
 const pythonPath=options.pythonPath;
 let active=0;
 const server=createServer({maxHeaderSize:4096,requestTimeout:5000,headersTimeout:5000,connectionsCheckingInterval:1000},(req,res)=>{void handle(req,res);});
 server.maxConnections=16;server.maxRequestsPerSocket=1;server.keepAliveTimeout=1;server.setTimeout(6000,socket=>socket.destroy());
 server.on('checkContinue',(_req,res)=>reply(res,417,{error:'INVALID_PDF_REQUEST'}));
 server.on('checkExpectation',(_req,res)=>reply(res,417,{error:'INVALID_PDF_REQUEST'}));
 server.on('upgrade',(_req,socket)=>socket.destroy());server.on('connect',(_req,socket)=>socket.destroy());
 server.on('clientError',(_error,socket)=>socket.destroy());
 async function handle(req:IncomingMessage,res:ServerResponse) {
  const seen=new Set<string>();let invalid=false;
  for(let i=0;i<req.rawHeaders.length;i+=2){const key=req.rawHeaders[i].toLowerCase();if(seen.has(key)||!allowedHeaders.has(key))invalid=true;seen.add(key);}
  const rawLength=req.headers['content-length'],hash=req.headers['x-content-sha256'];
  if(invalid||req.method!=='POST'||req.url!==endpoint||req.headers['content-type']!=='application/octet-stream'
   ||typeof rawLength!=='string'||!lengthHeader.test(rawLength)||Number(rawLength)>maximumPdfInputBytes||typeof hash!=='string'||!digest.test(hash)) {
   reply(res,400,{error:'INVALID_PDF_REQUEST'});res.once('finish',()=>req.destroy());return;
  }
  // Admission is before allocation/body consumption, and remains held until a
  // cancelled/timed-out native child is actually reaped by validateUnsignedPdf.
  if(active>=2){reply(res,503,{error:'PDF_SERVICE_BUSY'});res.once('finish',()=>req.destroy());return;}
  active++;const stopping=new AbortController();let timedOut=false;
  const abort=()=>stopping.abort();req.once('aborted',abort);res.once('close',()=>{if(!res.writableFinished)abort();});
  let timer=setTimeout(()=>{timedOut=true;abort();req.destroy();},5000);
  try {
   const bytes=Buffer.alloc(Number(rawLength));let used=0;
   for await(const chunk of req){if(stopping.signal.aborted||used+chunk.length>bytes.length)throw new Error('INVALID_BODY');used+=chunk.copy(bytes,used);}
   clearTimeout(timer);req.socket.setTimeout(0);if(used!==bytes.length||createHash('sha256').update(bytes).digest('hex')!==hash)throw new ApiError(400,'INVALID_PDF_REQUEST');
   // The parser has its own fixed ten-second wall deadline. Network input
   // never chooses execution paths, limits or a replacement native binary.
   timer=setTimeout(()=>{timedOut=true;abort();},10000);
   const result=await validateUnsignedPdf(bytes,{pythonPath,signal:stopping.signal});
   if(stopping.signal.aborted)throw new Error('CANCELLED');reply(res,200,result);
  }catch(error){reply(res,error instanceof ApiError&&error.status===400?400:timedOut?504:503,{error:error instanceof ApiError&&error.status===400?'INVALID_PDF_REQUEST':'PDF_SERVICE_UNAVAILABLE'});}
  finally{clearTimeout(timer);req.removeListener('aborted',abort);stopping.abort();active--;}
 }
 return server;
}

let activeClients=0;
// Configuration is operator-only; socketPath cannot be an HTTP URL and there is
// no TCP/DNS fallback, redirect, cookie jar or credentials to forward.
export async function validatePdfViaService(input:Uint8Array,options:{socketPath:string;signal?:AbortSignal}):Promise<PdfValidation> {
 const config=z.object({socketPath:socketSchema,signal:z.instanceof(AbortSignal).optional()}).strict().safeParse(options);
 if(!config.success)throw new ApiError(400,'INVALID_PDF_SERVICE_CONFIGURATION');
 if(!(input instanceof Uint8Array)||input.byteLength<9||input.byteLength>maximumPdfInputBytes)throw new ApiError(400,'INVALID_PDF_VALIDATION_BYTES');
 if(config.data.signal?.aborted)throw new ApiError(503,'PDF_SERVICE_CANCELLED');
 if(activeClients>=2)throw new ApiError(503,'PDF_SERVICE_BUSY');
 const bytes=Buffer.from(input),hash=createHash('sha256').update(bytes).digest('hex');activeClients++;
 try{return await new Promise<PdfValidation>((resolve,reject)=>{
  let settled=false,response:IncomingMessage|undefined;
  const req=httpRequest({socketPath:config.data.socketPath,path:endpoint,method:'POST',agent:false,maxHeaderSize:4096,headers:{host:'localhost',connection:'close','content-type':'application/octet-stream','content-length':bytes.length,'x-content-sha256':hash}});
  const finish=(code?:string,value?:PdfValidation)=>{
   if(settled)return;settled=true;clearTimeout(timer);config.data.signal?.removeEventListener('abort',cancel);response?.destroy();req.destroy();
   if(code)reject(new ApiError(503,code));else resolve(value!);
  };
  const cancel=()=>finish('PDF_SERVICE_CANCELLED');
  const timer=setTimeout(()=>finish('PDF_SERVICE_TIMEOUT'),15000);
  req.once('error',()=>finish('PDF_SERVICE_UNAVAILABLE'));
  req.once('response',incoming=>{
   response=incoming;const size=incoming.headers['content-length'];
   if(incoming.statusCode!==200||incoming.headers['content-type']!=='application/json'||incoming.headers['content-encoding']||incoming.headers['transfer-encoding']
    ||typeof size!=='string'||!lengthHeader.test(size)||Number(size)>maximumReplyBytes){finish('PDF_SERVICE_UNAVAILABLE');return;}
   const out=Buffer.alloc(Number(size));let used=0;
   incoming.on('data',(chunk:Buffer)=>{if(used+chunk.length>out.length){finish('PDF_SERVICE_UNAVAILABLE');return;}used+=chunk.copy(out,used);});
   incoming.once('error',()=>finish('PDF_SERVICE_UNAVAILABLE'));incoming.once('aborted',()=>finish('PDF_SERVICE_UNAVAILABLE'));
   incoming.once('end',()=>{
    if(settled)return;
    try{if(used!==out.length)throw new Error('INCOMPLETE_REPLY');const parsed=pdfValidationSchema.parse(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(out)));
     if(!pdfValidationMatches(parsed,bytes.length,hash))throw new Error('WRONG_RECEIPT');finish(undefined,parsed);
    }catch{finish('PDF_SERVICE_UNAVAILABLE');}
   });
  });
  config.data.signal?.addEventListener('abort',cancel,{once:true});if(config.data.signal?.aborted)cancel();else try{req.end(bytes);}catch{finish('PDF_SERVICE_UNAVAILABLE');}
 });}finally{activeClients--;}
}
