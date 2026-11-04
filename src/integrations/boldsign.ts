import { createHmac,timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { ApiError } from '../core/policy.ts';

// https://developers.boldsign.com/webhooks/verify-webhook-events/
// Authenticate original bytes before parsing JSON. This alone does not deduplicate
// events, establish tenant/document ownership or authorize admission completion.
export function verifyBoldSignSignature(body:Uint8Array,header:string|null,secrets:readonly string[],nowSeconds=Math.floor(Date.now()/1000)) {
  if(!secrets.length||secrets.length>2||secrets.some(s=>typeof s!=='string'||!s.length||s.length>4096)||!Number.isSafeInteger(nowSeconds)||nowSeconds<0)
    throw new ApiError(503,'BOLDSIGN_VERIFICATION_NOT_CONFIGURED');
  const invalid=()=>new ApiError(401,'INVALID_BOLDSIGN_SIGNATURE');
  if(!header||header.length>1024)throw invalid();
  const parts=new Map<string,string>();
  for(const item of header.split(',')) {
    const pair=/^(t|s0|s1)=([^\s,=]+)$/.exec(item.trim());
    if(!pair||parts.has(pair[1]))throw invalid();parts.set(pair[1],pair[2]);
  }
  const timestamp=parts.get('t')??'',current=parts.get('s0');
  if(!/^[1-9]\d{0,11}$/.test(timestamp)||!current)throw invalid();
  const seconds=Number(timestamp);
  if(Math.abs(nowSeconds-seconds)>300)throw invalid();
  const signatures=[current,...parts.has('s1')?[parts.get('s1')!]:[]];
  if(signatures.some(s=>! /^[a-fA-F0-9]{64}$/.test(s)))throw invalid();
  let matched=0;
  for(const secret of secrets) {
    const expected=createHmac('sha256',secret).update(timestamp+'.').update(body).digest();
    for(const signature of signatures)matched|=Number(timingSafeEqual(expected,Buffer.from(signature,'hex')));
  }
  if(!matched)throw invalid();return seconds;
}

const endpoints={US:'https://api.boldsign.com',CA:'https://api-ca.boldsign.com',EU:'https://api-eu.boldsign.com',AU:'https://api-au.boldsign.com'} as const;
const connection=z.object({region:z.enum(['US','CA','EU','AU']),apiKey:z.string().min(1).max(4096).regex(/^[\x21-\x7e]+$/)}).strict();
export type BoldSignConnection=z.infer<typeof connection>;
const uuid=z.string().uuid().transform(s=>s.toLowerCase()),status=z.string().min(1).max(80);
const properties=z.object({documentId:uuid,status,signerDetails:z.array(z.object({
  id:uuid,signerEmail:z.string().email().max(254),status,signerType:z.string().max(80).optional(),
  authenticationType:z.string().max(100).nullable().optional(),enableEmailOTP:z.boolean().optional(),
  isAuthenticationFailed:z.boolean().nullable().optional(),isReassigned:z.boolean().optional()
})).max(100)});
const templateProperties=z.object({templateId:uuid,title:z.string().max(1000),roles:z.array(z.object({
  name:z.string().max(200),index:z.number().int().nonnegative(),signerType:z.string().min(1).max(80),
  formFields:z.array(z.object({id:z.string().min(1).max(200),fieldType:z.string().min(1).max(80),isRequired:z.boolean(),isReadOnly:z.boolean().optional()})).max(1000)
})).max(100)});

// Shared bounded read-only transport. The fixed resource union cannot become
// an arbitrary URL or mutation method. The absolute deadline also covers a
// transport/stream implementation that fails to honor its AbortSignal.
async function readBoldSignJson(config:BoldSignConnection,id:string,resource:'document'|'template',send:typeof fetch,externalSignal?:AbortSignal) {
 const configured=connection.safeParse(config),upper=resource.toUpperCase();
 if(!configured.success)throw new ApiError(503,'BOLDSIGN_CONNECTION_NOT_CONFIGURED');
 const selected=uuid.safeParse(id);if(!selected.success)throw new ApiError(400,'INVALID_BOLDSIGN_'+upper+'_ID');
 const unavailable=()=>new ApiError(502,'BOLDSIGN_'+(resource==='document'?'STATUS':'TEMPLATE')+'_UNAVAILABLE');
 const abort=new AbortController(),cancel=()=>abort.abort(),timer=setTimeout(cancel,10000);
 let rejectAbort:(error:Error)=>void=()=>{};
 const interrupted=new Promise<never>((_,reject)=>{rejectAbort=reject;});
 void interrupted.catch(()=>{});
 const onAbort=()=>rejectAbort(unavailable());abort.signal.addEventListener('abort',onAbort,{once:true});
 externalSignal?.addEventListener('abort',cancel,{once:true});
 let reader:ReadableStreamDefaultReader<Uint8Array>|undefined,response:Response|undefined;
 const discard=(body:ReadableStream<Uint8Array>|null|undefined)=>{try{void body?.cancel().catch(()=>{});}catch{/* Never expose upstream cancellation errors. */}};
 try {
  if(externalSignal?.aborted)throw unavailable();
  const request=send(endpoints[configured.data.region]+'/v1/'+resource+'/properties?'+new URLSearchParams({[resource+'Id']:selected.data}),{
   method:'GET',headers:{'X-API-KEY':configured.data.apiKey,accept:'application/json'},redirect:'error',cache:'no-store',credentials:'omit',signal:abort.signal
  });
  // A non-cooperative transport may settle after cancellation. Dispose of its
  // late response without waiting or retaining the body in the worker.
  void request.then(value=>{if(abort.signal.aborted)discard(value.body);},()=>{});
  response=await Promise.race([request,interrupted]);
  if(abort.signal.aborted)throw unavailable();
  if(!response.ok||response.redirected||!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type')??''))throw unavailable();
  reader=response.body?.getReader();if(!reader)throw unavailable();
  const chunks:Uint8Array[]=[];let size=0;
  while(true) {
   if(abort.signal.aborted)throw unavailable();
   const part=await Promise.race([reader.read(),interrupted]);if(part.done)break;
   size+=part.value.byteLength;if(size>1_048_576)throw unavailable();chunks.push(part.value);
  }
  return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks))) as unknown;
 }catch {
  abort.abort();if(reader){try{void reader.cancel().catch(()=>{});}catch{/* Cancellation must not hold the deadline open. */}}else discard(response?.body);
  throw unavailable();
 }finally {
  clearTimeout(timer);externalSignal?.removeEventListener('abort',cancel);abort.signal.removeEventListener('abort',onAbort);reader?.releaseLock();
 }
}

// Region is explicit, never inferred from the academy address. These are the
// provider's fixed endpoints, not caller-supplied URLs:
// https://developers.boldsign.com/api-overview/versioning/
// https://developers.boldsign.com/documents/document-details-and-status/
// Read-only transport; its result is evidence for reconciliation, not clearance.
export async function getBoldSignDocument(config:BoldSignConnection,documentId:string,send:typeof fetch=fetch,signal?:AbortSignal) {
 const raw=await readBoldSignJson(config,documentId,'document',send,signal);
 try {const result=properties.parse(raw);if(result.documentId!==documentId.toLowerCase())throw new Error('WRONG_RESOURCE');return result;}
 catch{throw new ApiError(502,'BOLDSIGN_STATUS_UNAVAILABLE');}
}

// https://developers.boldsign.com/template/template-details/
// Role/field routing metadata is NOT a provider content revision or PDF hash.
// It cannot establish legal-text equivalence, signature completion or admission.
export async function getBoldSignTemplate(config:BoldSignConnection,templateId:string,send:typeof fetch=fetch,signal?:AbortSignal) {
 const raw=await readBoldSignJson(config,templateId,'template',send,signal);
 try {
  const result=templateProperties.parse(raw);
  if(result.templateId!==templateId.toLowerCase()||new Set(result.roles.map(r=>r.index)).size!==result.roles.length
   ||result.roles.some(r=>new Set(r.formFields.map(f=>f.id)).size!==r.formFields.length))throw new Error('AMBIGUOUS_RESOURCE');
  return result;
 }catch{throw new ApiError(502,'BOLDSIGN_TEMPLATE_UNAVAILABLE');}
}
