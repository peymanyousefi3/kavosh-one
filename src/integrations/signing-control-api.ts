import { z } from 'zod';
import { ApiError } from '../core/policy.ts';
import { parseBearer } from '../core/tokens.ts';

const uuid=z.string().uuid().transform(v=>v.toLowerCase());
const config=z.object({origin:z.string().url(),academyId:uuid,token:z.string().refine(v=>Boolean(parseBearer('Bearer '+v))),timeoutMs:z.number().int().min(1000).max(30000).default(10000),purpose:z.enum(['unified_enrollment','worker_services']).default('unified_enrollment')}).strict();
function id(raw:string){const p=uuid.safeParse(raw);if(!p.success)throw new ApiError(400,'INVALID_SIGNING_CONTROL_REQUEST');return p.data;}
// Fixed-origin scoped bot client. It cannot request arbitrary paths,forward
// cookies/follow redirects,or send its bearer token to storage/the provider.
export function createSigningControlApi(raw:unknown,send:typeof fetch=fetch){
 const selected=config.safeParse(raw);if(!selected.success)throw new ApiError(503,'SIGNING_CONTROL_NOT_CONFIGURED');const c=selected.data,url=new URL(c.origin);
 if(url.protocol!=='https:'||url.username||url.password||url.pathname!=='/'||url.search||url.hash||c.origin.trim()!==c.origin)throw new ApiError(503,'SIGNING_CONTROL_NOT_CONFIGURED');
 const origin=url.origin;
 async function request(method:'GET'|'POST',path:string,input?:unknown,key?:string,signal?:AbortSignal){
  const body=input===undefined?undefined:JSON.stringify(input);if(body&&Buffer.byteLength(body)>65536)throw new ApiError(400,'INVALID_SIGNING_CONTROL_REQUEST');
  const controller=new AbortController(),cancel=()=>controller.abort(),unavailable=()=>new ApiError(503,'SIGNING_CONTROL_UNAVAILABLE');let reject!:(error:Error)=>void;
  const stopped=new Promise<never>((_,no)=>{reject=no;}),abort=()=>reject(unavailable());void stopped.catch(()=>{});
  controller.signal.addEventListener('abort',abort,{once:true});signal?.addEventListener('abort',cancel,{once:true});const timer=setTimeout(cancel,c.timeoutMs);
  let reader:ReadableStreamDefaultReader<Uint8Array>|undefined,response:Response|undefined,complete=false;
  const discard=(b:ReadableStream<Uint8Array>|null|undefined)=>{try{void b?.cancel().catch(()=>{});}catch{/* No upstream diagnostic disclosure. */}};
  try{
   if(signal?.aborted)throw unavailable();
   const pending=send(origin+'/api/v1/'+path,{method,headers:{authorization:'Bearer '+c.token,'x-academy-id':c.academyId,accept:'application/json',...body?{'content-type':'application/json'}:{},...key?{'idempotency-key':id(key)}:{}},...body?{body}:{},redirect:'error',credentials:'omit',cache:'no-store',signal:controller.signal});
   void pending.then(r=>{if(controller.signal.aborted)discard(r.body);},()=>{});response=await Promise.race([pending,stopped]);
   if(controller.signal.aborted||response.redirected||(response.headers.get('content-type')??'').split(';')[0].trim().toLowerCase()!=='application/json')throw unavailable();
   reader=response.body?.getReader();if(!reader)throw unavailable();const chunks:Uint8Array[]=[];let size=0;
   for(;;){const p=await Promise.race([reader.read(),stopped]);if(p.done){complete=true;break;}size+=p.value.byteLength;if(size>1_048_576)throw unavailable();chunks.push(p.value);}
   const value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks,size))) as unknown;
   if(!response.ok){const e=z.object({error:z.object({code:z.string()})}).safeParse(value),known=e.success&&['SIGNATURE_ATTEMPT_ALREADY_RESERVED','SIGNATURE_DISPATCH_ALREADY_STARTED','WORK_SIGNATURE_ATTEMPT_ALREADY_RESERVED','WORK_SIGNATURE_DISPATCH_ALREADY_STARTED','IDEMPOTENCY_CONFLICT'].includes(e.data.error.code);throw new ApiError(response.status>=400&&response.status<=599?response.status:503,known?e.data.error.code:'SIGNING_CONTROL_FAILED');}
   return value;
  }catch(error){controller.abort();if(error instanceof ApiError)throw error;throw unavailable();}
  finally{clearTimeout(timer);signal?.removeEventListener('abort',cancel);controller.signal.removeEventListener('abort',abort);if(!complete){if(reader){try{void reader.cancel().catch(()=>{});}catch{/* Do not block cancellation. */}}else discard(response?.body);}reader?.releaseLock();}
 }
 const base=(r:string)=>(c.purpose==='worker_services'?'payroll/work-signature-send-requests/':'signature-send-requests/')+id(r);
 return Object.freeze({academyId:c.academyId,purpose:c.purpose,
  intention:(r:string,signal?:AbortSignal)=>request('GET',base(r),undefined,undefined,signal),
  source:(r:string,copy:string,signal?:AbortSignal)=>request('GET',base(r)+'/dispatch-source?copyId='+id(copy),undefined,undefined,signal),
  attempts:(r:string,signal?:AbortSignal)=>request('GET',base(r)+'/attempts',undefined,undefined,signal),
  reserve:(r:string,input:unknown,key:string,signal?:AbortSignal)=>request('POST',base(r)+'/attempts',input,key,signal),
  start:(r:string,attempt:string,input:unknown,key:string,signal?:AbortSignal)=>request('POST',base(r)+'/attempts/'+id(attempt)+'/dispatch',input,key,signal)
 });
}
export type SigningControlApi=ReturnType<typeof createSigningControlApi>;
