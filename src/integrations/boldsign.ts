import { createHmac,timingSafeEqual } from 'node:crypto';
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
