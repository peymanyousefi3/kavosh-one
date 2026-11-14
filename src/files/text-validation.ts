import { createHash } from 'node:crypto';
import { z } from 'zod';
import { ApiError } from '../core/policy.ts';

// ponytail: one MiB whole-file decoding per queued inspection;larger text
// needs incremental decoding/evidence,not a larger unbounded web-process buffer.
export const maximumTextInputBytes=1048576;
const base={validator:z.literal('utf8-plain-text@1'),maximumBytes:z.literal(maximumTextInputBytes),inputBytes:z.number().int().min(1).max(maximumTextInputBytes),inputSha256:z.string().regex(/^[a-f0-9]{64}$/)};
export const textValidationSchema=z.discriminatedUnion('outcome',[
 z.object({...base,outcome:z.literal('decoded'),codePoints:z.number().int().min(0).max(maximumTextInputBytes)}).strict(),
 z.object({...base,outcome:z.literal('rejected'),reason:z.enum(['INVALID_UTF8','CONTROL_CHARACTERS'])}).strict()
]);
export type TextValidation=z.infer<typeof textValidationSchema>;
// Whole-byte UTF-8 screen only. NEVER import/evaluate code,interpret markup,
// execute commands or render this string. Delivery remains octet-stream with
// attachment disposition,not an inline source-code preview or malware clearance.
export function validateText(input:Uint8Array):TextValidation{
 if(!(input instanceof Uint8Array)||input.byteLength<1||input.byteLength>maximumTextInputBytes)throw new ApiError(400,'INVALID_TEXT_VALIDATION_BYTES');
 const bytes=Buffer.from(input),basis={validator:'utf8-plain-text@1' as const,maximumBytes:maximumTextInputBytes,inputBytes:bytes.length,inputSha256:createHash('sha256').update(bytes).digest('hex')}as const;let text:string;
 try{text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{return{...basis,outcome:'rejected',reason:'INVALID_UTF8'};}
 if(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/u.test(text))return{...basis,outcome:'rejected',reason:'CONTROL_CHARACTERS'};
 let codePoints=0;for(const _ of text)codePoints++;return{...basis,outcome:'decoded',codePoints};
}
export function textValidationMatches(r:TextValidation,bytes:number,sha:string){return r.inputBytes===bytes&&r.inputSha256===sha&&(r.outcome!=='decoded'||r.codePoints<=bytes);}
