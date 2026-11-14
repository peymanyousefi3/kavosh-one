import { createCipheriv,createDecipheriv,createHmac,createSecretKey,randomBytes } from 'node:crypto';
import { z } from 'zod';
import { ApiError } from './policy.ts';

const maxBytes=16384,keyId=z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/),uuid=z.string().uuid().transform(v=>v.toLowerCase());
const binding=z.object({academyId:uuid,personId:uuid,version:z.number().int().positive().max(2147483647)}).strict();
const config=z.object({activeKeyId:keyId,keys:z.record(keyId,z.string().length(43).regex(/^[A-Za-z0-9_-]+$/)),fingerprintKey:z.string().length(43).regex(/^[A-Za-z0-9_-]+$/)}).strict();
export const payrollPrivateEnvelope=z.object({format:z.literal('payroll-private-v1'),keyId,nonce:z.string().length(16).regex(/^[A-Za-z0-9_-]+$/),tag:z.string().length(22).regex(/^[A-Za-z0-9_-]+$/),ciphertext:z.string().min(1).max(Math.ceil(maxBytes*4/3)).regex(/^[A-Za-z0-9_-]+$/)}).strict();
export const studentCareEnvelope=payrollPrivateEnvelope.extend({format:z.literal('student-care-private-v1')});
const text=z.string().min(1).max(maxBytes).refine(v=>v.isWellFormed()&&Buffer.byteLength(v,'utf8')<=maxBytes);
export type PayrollPrivateBinding=z.infer<typeof binding>;
export type PayrollPrivateVault=ReturnType<typeof createPayrollPrivateVault>;
export const payrollPrivateReviewPrefix='payroll-private-review-v1:';
function decode(value:string,bytes?:number){const b=Buffer.from(value,'base64url');if(b.toString('base64url')!==value||(bytes!==undefined&&b.length!==bytes))throw new Error('INVALID_ENCODING');return b;}
function context(raw:unknown,domain:'payroll'|'student-care'){const parsed=binding.safeParse(raw);if(!parsed.success)throw new ApiError(400,'INVALID_PAYROLL_PRIVATE_INPUT');return Buffer.from(JSON.stringify([domain==='payroll'?'kavosh-payroll-identity-v1':'kavosh-student-care-v1',parsed.data.academyId,parsed.data.personId,parsed.data.version]),'utf8');}
function plaintext(raw:unknown){const parsed=text.safeParse(raw);if(!parsed.success)throw new ApiError(400,'INVALID_PAYROLL_PRIVATE_INPUT');return Buffer.from(parsed.data,'utf8');}

// Native authenticated encryption,not a new cryptographic algorithm. Separate
// HMAC material supports stable private request fingerprints without a public
// low-entropy identifier hash or deterministic/reused encryption nonce.
// https://nodejs.org/docs/latest-v22.x/api/crypto.html
export function createPayrollPrivateVault(raw:unknown,domain:'payroll'|'student-care'='payroll'){
 let activeKeyId:string,keys:Map<string,ReturnType<typeof createSecretKey>>,fingerprint:ReturnType<typeof createSecretKey>;
 try{const c=config.parse(raw),entries=Object.entries(c.keys);if(entries.length<1||entries.length>10||!Object.hasOwn(c.keys,c.activeKeyId)||new Set([...entries.map(([,k])=>k),c.fingerprintKey]).size!==entries.length+1)throw new Error('INVALID_KEYS');activeKeyId=c.activeKeyId;keys=new Map(entries.map(([id,k])=>{const b=decode(k,32);try{return [id,createSecretKey(b)];}finally{b.fill(0);}}));const b=decode(c.fingerprintKey,32);try{fingerprint=createSecretKey(b);}finally{b.fill(0);}}
 catch{throw new Error('PAYROLL_PRIVATE_CONFIG_INVALID');}
 return {
  seal(rawBinding:unknown,rawPlaintext:unknown){const aad=context(rawBinding,domain),body=plaintext(rawPlaintext);try{const nonce=randomBytes(12),cipher=createCipheriv('aes-256-gcm',keys.get(activeKeyId)!,nonce,{authTagLength:16});cipher.setAAD(Buffer.concat([aad,Buffer.from('\0'+activeKeyId)]));const ciphertext=Buffer.concat([cipher.update(body),cipher.final()]);return {format:domain==='payroll'?'payroll-private-v1' as const:'student-care-private-v1' as const,keyId:activeKeyId,nonce:nonce.toString('base64url'),tag:cipher.getAuthTag().toString('base64url'),ciphertext:ciphertext.toString('base64url')};}finally{body.fill(0);}},
  open(rawBinding:unknown,rawEnvelope:unknown){const aad=context(rawBinding,domain),parts:Buffer[]=[];try{const e=(domain==='payroll'?payrollPrivateEnvelope:studentCareEnvelope).parse(rawEnvelope),key=keys.get(e.keyId);if(!key)throw new Error('KEY_UNAVAILABLE');const nonce=decode(e.nonce,12),tag=decode(e.tag,16),ciphertext=decode(e.ciphertext);if(ciphertext.length<1||ciphertext.length>maxBytes)throw new Error('INVALID_LENGTH');const cipher=createDecipheriv('aes-256-gcm',key,nonce,{authTagLength:16});cipher.setAAD(Buffer.concat([aad,Buffer.from('\0'+e.keyId)]));cipher.setAuthTag(tag);parts.push(cipher.update(ciphertext));parts.push(cipher.final());const body=Buffer.concat(parts);try{return new TextDecoder('utf-8',{fatal:true}).decode(body);}finally{body.fill(0);}}
   catch{throw new ApiError(503,'PAYROLL_PRIVATE_DATA_UNAVAILABLE');}finally{for(const p of parts)p.fill(0);}},
  fingerprint(rawBinding:unknown,rawPlaintext:unknown){const aad=context(rawBinding,domain),body=plaintext(rawPlaintext);try{return createHmac('sha256',fingerprint).update(domain==='payroll'?'kavosh-payroll-private-fingerprint-v1\0':'kavosh-student-care-fingerprint-v1\0').update(aad).update('\0').update(body).digest('hex');}finally{body.fill(0);}}
 };
}
