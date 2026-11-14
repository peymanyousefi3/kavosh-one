import { z } from 'zod';

const uuid=z.string().uuid().transform(v=>v.toLowerCase()),alias=z.string().regex(/^[A-Za-z0-9_-]{22}$/);
// Lossless UUID compression,not a password,permission or new identity. Strict
// round-trip validation rejects alternate spellings of unused base64 bits.
export function profileShareAlias(id:string){return Buffer.from(uuid.parse(id).replaceAll('-',''),'hex').toString('base64url');}
export const profileShareId=z.union([uuid,alias]).transform((raw,ctx)=>{
 const plain=uuid.safeParse(raw);if(plain.success)return plain.data;
 const bytes=Buffer.from(raw,'base64url'),hex=bytes.toString('hex'),id=[hex.slice(0,8),hex.slice(8,12),hex.slice(12,16),hex.slice(16,20),hex.slice(20)].join('-'),parsed=uuid.safeParse(id);
 if(bytes.length!==16||!parsed.success||bytes.toString('base64url')!==raw){ctx.addIssue({code:'custom',message:'Use a valid profile UUID or canonical short sharing ID.'});return z.NEVER;}return parsed.data;
});
export function profileBrowserPath(id:string,audience:'public'|'members',academyId?:string){const short=profileShareAlias(profileShareId.parse(id));return audience==='public'?'/api/public/v1/profiles/'+short:'/api/member/v1/academies/'+uuid.parse(academyId)+'/profiles/'+short;}
