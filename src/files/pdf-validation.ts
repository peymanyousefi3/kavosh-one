import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { ApiError } from '../core/policy.ts';

export const maximumPdfInputBytes=10_485_760;
const box=z.tuple([z.number().min(-20000).max(20000),z.number().min(-20000).max(20000),z.number().min(-20000).max(20000),z.number().min(-20000).max(20000)]).refine(v=>v[0]<v[2]&&v[1]<v[3]);
const page=z.object({mediaBox:box,cropBox:box,rotation:z.union([z.literal(0),z.literal(90),z.literal(180),z.literal(270)]),userUnit:z.number().positive().max(75000)}).strict().refine(v=>{
 const m=v.mediaBox,c=v.cropBox;return c[0]>=m[0]&&c[1]>=m[1]&&c[2]<=m[2]&&c[3]<=m[3]&&(m[2]-m[0])*v.userUnit<=20000&&(m[3]-m[1])*v.userUnit<=20000;
});
const base={validator:z.literal('pikepdf@10.17.0'),qpdf:z.literal('12.4.2'),policyVersion:z.literal(1),inputBytes:z.number().int().min(1).max(maximumPdfInputBytes),inputSha256:z.string().regex(/^[a-f0-9]{64}$/),maximumPages:z.literal(1000),maximumObjects:z.literal(50000),maximumDepth:z.literal(64),
 resources:z.object({peakRssKiB:z.number().int().positive(),userCpuMicros:z.number().int().nonnegative(),systemCpuMicros:z.number().int().nonnegative()}).strict()};
export const pdfValidationSchema=z.discriminatedUnion('outcome',[
 z.object({...base,outcome:z.literal('screened'),pageCount:z.number().int().min(1).max(1000),objectCount:z.number().int().min(1).max(50000),pages:z.array(page).min(1).max(1000),interactiveForms:z.boolean(),coordinateSpace:z.literal('pdf-default-user-space')}).strict().refine(v=>v.pageCount===v.pages.length),
 z.object({...base,outcome:z.literal('rejected'),reason:z.enum(['ACTIVE_CONTENT','EMBEDDED_FILE','EXTERNAL_STREAM','XFA_FORM','ENCRYPTED','EXISTING_SIGNATURE','GEOMETRY_INVALID','STRUCTURE_LIMIT','PAGE_LIMIT','MALFORMED_PDF'])}).strict()
]);
export type PdfValidation=z.infer<typeof pdfValidationSchema>;
export function pdfValidationMatches(result:PdfValidation,bytes:number,sha256:string){return result.inputBytes===bytes&&result.inputSha256===sha256;}
const configuration=z.object({pythonPath:z.string().min(2).max(512).refine(v=>v.startsWith('/')&&!/[\0\r\n]/.test(v)&&!v.split('/').some(p=>p==='.'||p==='..')),signal:z.instanceof(AbortSignal).optional()}).strict();
let active=0;

// Internal killable-process adapter, NOT a public endpoint or OS sandbox. Never
// run this native parser with storage/identity credentials or enable it in the
// web process. Production requires a separately verified isolated service.
// This unsigned-source profile must not replace signed-artifact verification.
export async function validateUnsignedPdf(input:Uint8Array,options:z.input<typeof configuration>):Promise<PdfValidation>{
 const parsed=configuration.safeParse(options);if(!parsed.success)throw new ApiError(400,'INVALID_PDF_VALIDATION_CONFIGURATION');
 if(!(input instanceof Uint8Array)||input.byteLength<9||input.byteLength>maximumPdfInputBytes)throw new ApiError(400,'INVALID_PDF_VALIDATION_BYTES');
 if(!/^%PDF-(?:1\.[0-7]|2\.0)[\r\n]/.test(Buffer.from(input.buffer,input.byteOffset,9).toString('latin1')))throw new ApiError(400,'INVALID_PDF_VALIDATION_BYTES');
 if(parsed.data.signal?.aborted)throw new ApiError(503,'PDF_VALIDATION_CANCELLED');
 // ponytail: two native children per caller process; use the durable job queue
 // and isolated replicas for throughput, never an unbounded process fanout.
 if(active>=2)throw new ApiError(503,'PDF_VALIDATOR_BUSY');
 const bytes=Buffer.from(input),sha256=createHash('sha256').update(bytes).digest('hex');active++;
 return new Promise((resolve,reject)=>{
  let child:ReturnType<typeof spawn>;
  try{child=spawn(parsed.data.pythonPath,['-I','-B',fileURLToPath(new URL('./pdf-inspector.py',import.meta.url))],{env:{NODE_ENV:'production',TZ:'UTC'},stdio:['pipe','pipe','pipe']});}
  catch{active--;reject(new ApiError(503,'PDF_VALIDATION_UNAVAILABLE'));return;}
  let failure:ApiError|undefined,size=0;const chunks:Buffer[]=[];
  const stop=(code:string)=>{if(failure)return;failure=new ApiError(503,code);child.kill('SIGKILL');};
  const cancel=()=>stop('PDF_VALIDATION_CANCELLED'),timer=setTimeout(()=>stop('PDF_VALIDATION_TIMEOUT'),10000);
  child.stderr?.resume();child.once('error',()=>stop('PDF_VALIDATION_UNAVAILABLE'));
  child.stdout?.on('data',(chunk:Buffer)=>{size+=chunk.length;if(size>1_048_576){stop('PDF_VALIDATION_UNAVAILABLE');return;}chunks.push(chunk);});
  child.stdout?.once('error',()=>stop('PDF_VALIDATION_UNAVAILABLE'));child.stdin?.once('error',()=>stop('PDF_VALIDATION_UNAVAILABLE'));
  child.once('close',code=>{
   clearTimeout(timer);parsed.data.signal?.removeEventListener('abort',cancel);active--;
   if(failure){reject(failure);return;}
   try{
    if(code!==0)throw new Error('INCOMPLETE_CHILD');
    const result=pdfValidationSchema.parse(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks,size))));
    if(!pdfValidationMatches(result,bytes.length,sha256))throw new Error('WRONG_CONTENT');resolve(result);
   }catch{reject(new ApiError(503,'PDF_VALIDATION_UNAVAILABLE'));}
  });
  parsed.data.signal?.addEventListener('abort',cancel,{once:true});if(parsed.data.signal?.aborted){cancel();return;}
  try{child.stdin?.end(bytes);}catch{stop('PDF_VALIDATION_UNAVAILABLE');}
 });
}
