import { createHash,createHmac,timingSafeEqual } from 'node:crypto';
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
export const boldSignConnectionSchema=connection;
const uuid=z.string().uuid().transform(s=>s.toLowerCase()),status=z.string().min(1).max(80);
const properties=z.object({documentId:uuid,status,signerDetails:z.array(z.object({
  id:uuid,signerEmail:z.string().email().max(254),status,signerType:z.string().max(80).optional(),
  authenticationType:z.string().max(100).nullable().optional(),enableEmailOTP:z.boolean().optional(),
  isAuthenticationFailed:z.boolean().nullable().optional(),isReassigned:z.boolean().optional()
})).max(100)});
const completionProperties=properties.extend({
 isDeleted:z.boolean().optional(),enablePrintAndSign:z.boolean().optional(),enableReassign:z.boolean().optional(),
 metaData:z.record(z.string().max(100),z.string().max(2000)).refine(v=>Object.keys(v).length<=50).optional(),
 signerDetails:z.array(properties.shape.signerDetails.element.extend({
  signerName:z.string().max(200).optional(),signType:z.string().max(40).optional(),
  phoneNumber:z.union([z.string().max(40),z.object({countryCode:z.string().max(5),number:z.string().max(30)})]).nullable().optional(),
  formFields:z.array(z.object({id:z.string().max(200),type:z.string().max(80),pageNumber:z.number().int().positive().max(1000),bounds:z.object({x:z.number(),y:z.number(),width:z.number().positive(),height:z.number().positive()}).optional(),value:z.unknown().optional(),isRequired:z.unknown().optional(),isReadOnly:z.unknown().optional()})).max(1000).optional()
 })).max(100)
});
const templateProperties=z.object({templateId:uuid,title:z.string().max(1000),roles:z.array(z.object({
  name:z.string().max(200),index:z.number().int().nonnegative(),signerType:z.string().min(1).max(80),
  formFields:z.array(z.object({id:z.string().min(1).max(200),fieldType:z.string().min(1).max(80),isRequired:z.boolean(),isReadOnly:z.boolean().optional()})).max(1000)
})).max(100)});

const routingText=z.string().refine(v=>v.isWellFormed()&&!v.includes('\0'));
const agreementField=z.object({id:routingText.min(1).max(200),fieldType:routingText.min(1).max(80),isRequired:z.literal(true),pageNumber:z.number().int().min(1).max(1000),
 bounds:z.object({x:z.number().min(0).max(20000),y:z.number().min(0).max(20000),width:z.number().positive().max(20000),height:z.number().positive().max(20000)}).strict()}).strict();
// Recorded geometry is not automatically executable. A sender must explicitly
// support every recorded field; unknown types must never be silently dropped.
const consentField=agreementField.extend({fieldType:z.literal('CheckBox'),isRequired:z.literal(false),consentPurpose:z.enum(['public_profile','verified_member_profile'])}).strict();
// Optional disclosure choices remain in the SAME unified document. Neither a
// signature nor a checked mandatory acknowledgment is profile-publication consent.
export const agreementRouting=z.object({version:z.union([z.literal(1),z.literal(2)]),role:z.literal('legal_signer'),fields:z.array(z.union([agreementField,consentField])).min(1).max(100)}).strict()
 .refine(v=>{
  const choices=v.fields.filter(f=>!f.isRequired);
  return new Set(v.fields.map(f=>f.id)).size===v.fields.length&&v.fields.some(f=>f.isRequired&&f.fieldType.toLowerCase()==='signature')
   &&(v.version===1?choices.length===0:choices.length>0&&new Set(choices.map(f=>f.consentPurpose)).size===choices.length);
 },'Use unique fields, a required signature and distinct optional consent purposes only in version 2.');
export const workAgreementRouting=z.object({version:z.union([z.literal(1),z.literal(2)]),parties:z.array(z.object({role:z.enum(['worker','academy_representative']),fields:agreementRouting.shape.fields}).strict()).length(2)
 .refine(v=>new Set(v.map(p=>p.role)).size===2&&v.reduce((n,p)=>n+p.fields.length,0)<=100&&new Set(v.flatMap(p=>p.fields.map(f=>f.id))).size===v.reduce((n,p)=>n+p.fields.length,0),'Use both parties,at most100 fields and globally unique field IDs.')
 .transform(v=>v.sort((a,b)=>a.role==='worker'?-1:b.role==='worker'?1:0))}).strict().refine(r=>{
 const worker=r.parties.find(p=>p.role==='worker'),academy=r.parties.find(p=>p.role==='academy_representative');if(!worker||!academy||r.parties.some(p=>!p.fields.some(f=>f.isRequired&&f.fieldType.toLowerCase()==='signature')))return false;
 const choices=worker.fields.filter(f=>!f.isRequired);return academy.fields.every(f=>f.isRequired)&&(r.version===1?choices.length===0:choices.length>0&&new Set(choices.map(f=>f.consentPurpose)).size===choices.length);
},'Both parties must sign;version2 permits only distinct optional worker disclosure purposes,never academy choices or preselected fields.');

// Shared bounded provider transport. The fixed resource union cannot become
// an arbitrary URL or mutation method. The absolute deadline also covers a
// transport/stream implementation that fails to honor its AbortSignal.
type PdfResource='template-pdf'|'document-pdf'|'audit-pdf';
const pdfError={ 'template-pdf':'BOLDSIGN_TEMPLATE_PDF_UNAVAILABLE','document-pdf':'BOLDSIGN_DOCUMENT_PDF_UNAVAILABLE','audit-pdf':'BOLDSIGN_AUDIT_PDF_UNAVAILABLE' } as const;
async function readBoldSignBytes(config:BoldSignConnection,id:string,resource:'document'|'template'|PdfResource|'send',send:typeof fetch,externalSignal?:AbortSignal,wire?:{body:string;onAttempt:()=>void;observeResources?:(settled:Promise<unknown>)=>void},observeResources?:(settled:Promise<unknown>)=>void) {
 const posting=resource==='send',pdf=resource.endsWith('-pdf'),kind=resource==='template'||resource==='template-pdf'?'template':'document';
 const configured=connection.safeParse(config),upper=kind.toUpperCase(),mime=pdf?'application/pdf':'application/json',limit=pdf?10_485_760:1_048_576;
 if(!configured.success)throw new ApiError(503,'BOLDSIGN_CONNECTION_NOT_CONFIGURED');
 const selected=posting?null:uuid.safeParse(id);if(selected&&!selected.success)throw new ApiError(400,'INVALID_BOLDSIGN_'+upper+'_ID');
 const unavailable=()=>new ApiError(502,posting?'BOLDSIGN_SEND_OUTCOME_UNKNOWN':pdf?pdfError[resource as PdfResource]:'BOLDSIGN_'+(resource==='document'?'STATUS':'TEMPLATE')+'_UNAVAILABLE');
 const abort=new AbortController(),cancel=()=>abort.abort(),timer=setTimeout(cancel,10000);
 let rejectAbort:(error:Error)=>void=()=>{};
 const interrupted=new Promise<never>((_,reject)=>{rejectAbort=reject;});
 void interrupted.catch(()=>{});
 const onAbort=()=>rejectAbort(unavailable());abort.signal.addEventListener('abort',onAbort,{once:true});
 externalSignal?.addEventListener('abort',cancel,{once:true});
 let reader:ReadableStreamDefaultReader<Uint8Array>|undefined,response:Response|undefined,pendingRequest:Promise<unknown>|undefined,pendingRead:Promise<ReadableStreamReadResult<Uint8Array>>|undefined;const disposals:Promise<unknown>[]=[];
 const discard=(body:ReadableStream<Uint8Array>|null|undefined)=>{try{const p=body?.cancel();if(p){disposals.push(p);void p.catch(()=>{});}return p;}catch{/* Never expose upstream cancellation errors. */}};
 try {
  if(externalSignal?.aborted)throw unavailable();
  const query=new URLSearchParams(selected?.success?{[kind+'Id']:selected.data}:{});
  if(resource==='template-pdf')query.set('includeFormFieldValues','true');
  if(resource==='document-pdf')query.set('format','Combined');
  const operation=posting?'send':resource==='audit-pdf'?'downloadAuditLog':pdf?'download':'properties';
  if(posting&&!wire)throw unavailable();
  if(posting)wire!.onAttempt();
  const request=send(endpoints[configured.data.region]+'/v1/'+kind+'/'+operation+(posting?'':'?'+query),{
   method:posting?'POST':'GET',headers:{'X-API-KEY':configured.data.apiKey,accept:mime,...posting?{'content-type':'application/json'}:{}},
   ...posting?{body:wire!.body}:{},redirect:'error',cache:'no-store',credentials:'omit',signal:abort.signal
  });
  // A non-cooperative transport may settle after cancellation. Dispose of its
  // late response without waiting or retaining the body in the worker.
  pendingRequest=request.then(value=>abort.signal.aborted?discard(value.body):undefined,()=>{});void pendingRequest.catch(()=>{});
  response=await Promise.race([request,interrupted]);
  if(abort.signal.aborted)throw unavailable();
  if(response.status!==(posting?201:200)||response.redirected||(response.headers.get('content-type')??'').split(';')[0].trim().toLowerCase()!==mime)throw unavailable();
  reader=response.body?.getReader();if(!reader)throw unavailable();
  const chunks:Uint8Array[]=[];let size=0;
  while(true) {
   if(abort.signal.aborted)throw unavailable();
   pendingRead=reader.read();const part=await Promise.race([pendingRead,interrupted]);if(part.done)break;
   size+=part.value.byteLength;if(size>limit)throw unavailable();chunks.push(part.value);
  }
  return Buffer.concat(chunks,size);
 }catch {
  abort.abort();if(reader){try{const p=reader.cancel();disposals.push(p);void p.catch(()=>{});}catch{/* Cancellation must not hold the deadline open. */}}else discard(response?.body);
  throw unavailable();
 }finally {
  clearTimeout(timer);externalSignal?.removeEventListener('abort',cancel);abort.signal.removeEventListener('abort',onAbort);
  try{reader?.releaseLock();}finally{(wire?.observeResources??observeResources)?.(Promise.allSettled([...(pendingRequest?[pendingRequest]:[]),...(pendingRead?[pendingRead]:[]),...disposals]));}
 }
}

export const boldSignSubmissionOutcomeSchema=z.discriminatedUnion('state',[
 z.object({state:z.literal('not_attempted'),automaticRetryAllowed:z.literal(false),reconciliationRequired:z.literal(false),deliveryVerified:z.literal(false)}).strict(),
 z.object({state:z.literal('outcome_unknown'),automaticRetryAllowed:z.literal(false),reconciliationRequired:z.literal(true),deliveryVerified:z.literal(false)}).strict(),
 z.object({state:z.literal('accepted_for_processing'),documentId:uuid,automaticRetryAllowed:z.literal(false),reconciliationRequired:z.literal(true),deliveryVerified:z.literal(false)}).strict()
]);
export type BoldSignSubmissionOutcome=z.infer<typeof boldSignSubmissionOutcomeSchema>;

// Internal IO primitive, NOT a public endpoint or authorization boundary.
// Caller must retain a durable single-use attempt BEFORE invoking it, bind the
// exact body to reviewed source/identity and clear all file/provider gates.
// No retry: a timeout, 4xx/5xx, redirect or malformed response after invocation
// cannot prove that the provider did not create/send the document.
// 201/documentId only acknowledges asynchronous processing, not Sent/Completed:
// https://developers.boldsign.com/documents/send-document/
export async function submitBoldSignWireRequest(config:BoldSignConnection,body:string,send:typeof fetch=fetch,signal?:AbortSignal,observeResources?:(settled:Promise<unknown>)=>void):Promise<BoldSignSubmissionOutcome> {
 if(!connection.safeParse(config).success)throw new ApiError(503,'BOLDSIGN_CONNECTION_NOT_CONFIGURED');
 if(typeof body!=='string'||!body.length||body.length>16_777_216||!body.isWellFormed()||Buffer.byteLength(body)>16_777_216)throw new ApiError(400,'INVALID_BOLDSIGN_WIRE_REQUEST');
 let attempted=false;
 try {
  const bytes=await readBoldSignBytes(config,'','send',send,signal,{body,observeResources,onAttempt(){attempted=true;}});
  const response=z.object({documentId:uuid}).parse(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)));
  return {state:'accepted_for_processing',documentId:response.documentId,automaticRetryAllowed:false,reconciliationRequired:true,deliveryVerified:false};
 }catch {
  return attempted?{state:'outcome_unknown',automaticRetryAllowed:false,reconciliationRequired:true,deliveryVerified:false}
   :{state:'not_attempted',automaticRetryAllowed:false,reconciliationRequired:false,deliveryVerified:false};
 }
}

async function readBoldSignJson(config:BoldSignConnection,id:string,resource:'document'|'template',send:typeof fetch,signal?:AbortSignal) {
 const bytes=await readBoldSignBytes(config,id,resource,send,signal);
 try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)) as unknown;}
 catch{throw new ApiError(502,'BOLDSIGN_'+(resource==='document'?'STATUS':'TEMPLATE')+'_UNAVAILABLE');}
}

// https://developers.boldsign.com/template/download-template/
// Includes rendered field values so prefilled legal terms enter the exact-byte
// fingerprint. This is untrusted PDF evidence, NOT malware clearance, a provider
// revision, a routing snapshot, or proof that a later template send uses it.
export async function getBoldSignTemplatePdf(config:BoldSignConnection,templateId:string,send:typeof fetch=fetch,signal?:AbortSignal) {
 const evidence=await readBoldSignPdf(config,templateId,'template-pdf',send,signal);
 return {templateId:templateId.toLowerCase(),...evidence};
}
async function readBoldSignPdf(config:BoldSignConnection,id:string,resource:PdfResource,send:typeof fetch,signal?:AbortSignal,observeResources?:(settled:Promise<unknown>)=>void) {
 const bytes=await readBoldSignBytes(config,id,resource,send,signal,undefined,observeResources);
 if(!/^%PDF-(?:1\.[0-7]|2\.0)[\r\n]/.test(bytes.subarray(0,9).toString('latin1'))){bytes.fill(0);throw new ApiError(502,pdfError[resource]);}
 return {bytes,sha256:createHash('sha256').update(bytes).digest('hex'),sizeBytes:bytes.length};
}

// https://developers.boldsign.com/documents/download-document/
// https://developers.boldsign.com/documents/download-audit-trail/
// Explicit artifact kinds prevent confusing an audit PDF with the agreement.
// The caller must independently bind owned document/signer/status and protect
// retained bytes. A provider download alone establishes none of these facts.
export async function getBoldSignDocumentPdf(config:BoldSignConnection,documentId:string,send:typeof fetch=fetch,signal?:AbortSignal,observeResources?:(settled:Promise<unknown>)=>void) {
 const evidence=await readBoldSignPdf(config,documentId,'document-pdf',send,signal,observeResources);
 return {documentId:documentId.toLowerCase(),artifactKind:'document' as const,...evidence};
}
export async function getBoldSignAuditPdf(config:BoldSignConnection,documentId:string,send:typeof fetch=fetch,signal?:AbortSignal,observeResources?:(settled:Promise<unknown>)=>void) {
 const evidence=await readBoldSignPdf(config,documentId,'audit-pdf',send,signal,observeResources);
 return {documentId:documentId.toLowerCase(),artifactKind:'audit' as const,...evidence};
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

// Private reconciliation input,NOT an API response. Retain original provider
// bytes separately from the bounded projection;caller must protect and wipe
// those bytes. Unknown fields cannot silently become verified completion facts.
export async function getBoldSignCompletionDocument(config:BoldSignConnection,documentId:string,send:typeof fetch=fetch,signal?:AbortSignal,observeResources?:(settled:Promise<unknown>)=>void){
 const bytes=await readBoldSignBytes(config,documentId,'document',send,signal,undefined,observeResources);
 try{const value=completionProperties.parse(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)));if(value.documentId!==documentId.toLowerCase())throw new Error('WRONG_RESOURCE');return {properties:value,bytes,sha256:createHash('sha256').update(bytes).digest('hex'),sizeBytes:bytes.length};}
 catch{bytes.fill(0);throw new ApiError(502,'BOLDSIGN_COMPLETION_PROPERTIES_UNAVAILABLE');}
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
