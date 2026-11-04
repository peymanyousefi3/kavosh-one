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

// Region is explicit, never inferred from the academy address. These are the
// provider's fixed endpoints, not caller-supplied URLs:
// https://developers.boldsign.com/api-overview/versioning/
// https://developers.boldsign.com/documents/document-details-and-status/
// Read-only transport; its result is evidence for reconciliation, not clearance.
export async function getBoldSignDocument(config:BoldSignConnection,documentId:string,send:typeof fetch=fetch) {
  const configured=connection.safeParse(config);
  if(!configured.success)throw new ApiError(503,'BOLDSIGN_CONNECTION_NOT_CONFIGURED');
  const selected=uuid.safeParse(documentId);if(!selected.success)throw new ApiError(400,'INVALID_BOLDSIGN_DOCUMENT_ID');
  const unavailable=()=>new ApiError(502,'BOLDSIGN_STATUS_UNAVAILABLE');
  try {
    const response=await send(endpoints[configured.data.region]+'/v1/document/properties?'+new URLSearchParams({documentId:selected.data}),{
      method:'GET',headers:{'X-API-KEY':configured.data.apiKey,accept:'application/json'},redirect:'error',cache:'no-store',credentials:'omit',signal:AbortSignal.timeout(10000)
    });
    // Always cancel rejected responses; never include provider errors or keys in
    // our exception. Check the streamed bytes, not a claimed Content-Length.
    if(!response.ok||response.redirected||!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type')??'')) {
      await response.body?.cancel();throw unavailable();
    }
    const reader=response.body?.getReader();if(!reader)throw unavailable();
    const chunks:Uint8Array[]=[];let size=0;
    try {
      while(true) {
        const part=await reader.read();if(part.done)break;size+=part.value.byteLength;
        if(size>1_048_576){await reader.cancel();throw unavailable();}chunks.push(part.value);
      }
    }finally{reader.releaseLock();}
    const result=properties.parse(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks))));
    if(result.documentId!==selected.data)throw unavailable();
    return result;
  }catch{throw unavailable();}
}
