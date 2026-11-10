import { isDeepStrictEqual } from 'node:util';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { parsePhoneNumberWithError } from 'libphonenumber-js/max';
import { ApiError } from '../core/policy.ts';
import { getBoldSignCompletionDocument,getBoldSignDocumentPdf,getBoldSignAuditPdf,type BoldSignConnection } from './boldsign.ts';

const uuid=z.string().uuid().transform(v=>v.toLowerCase()),hash=z.string().regex(/^[a-f0-9]{64}$/);
const signatureField=z.object({id:z.string().min(1).max(200),pageNumber:z.number().int().positive().max(1000),bounds:z.object({x:z.number().min(0).max(20000),y:z.number().min(0).max(20000),width:z.number().positive().max(20000),height:z.number().positive().max(20000)}).strict()}).strict();
const consentFields=z.array(signatureField.extend({purpose:z.enum(['public_profile','verified_member_profile'])}).strict()).min(1).max(2)
 .refine(v=>new Set(v.map(f=>f.id)).size===v.length&&new Set(v.map(f=>f.purpose)).size===v.length);
const expected=z.object({academyId:uuid,startId:uuid,signerId:uuid,documentId:uuid,packageId:uuid,attachmentId:uuid,bindingId:uuid,connectionId:uuid,connectionTargetId:hash,documentSha256:hash,sourceFingerprint:hash,region:z.enum(['US','CA','EU','AU']),signatureFields:z.array(signatureField).min(1).max(100).refine(v=>new Set(v.map(f=>f.id)).size===v.length),consentFields:consentFields.optional()}).strict();
const artifact=z.object({id:uuid,sha256:hash,sizeBytes:z.number().int().min(1).max(10485760)}).strict();
const retained=z.object({sourceFingerprint:hash,document:artifact,audit:artifact,properties:artifact}).strict();
export const signatureCompletionSourceSchema=expected;
export const workSignatureCompletionSourceSchema=expected.omit({signerId:true,packageId:true,attachmentId:true,signatureFields:true,consentFields:true}).extend({purpose:z.literal('worker_services'),requestId:uuid,preparationId:uuid,originalSourceFingerprint:hash,
 parties:z.array(z.object({role:z.enum(['worker','academy_representative']),signerId:uuid,signatureFields:expected.shape.signatureFields}).strict()).length(2)
 .refine(v=>new Set(v.map(p=>p.role)).size===2&&new Set(v.map(p=>p.signerId)).size===2&&v.reduce((n,p)=>n+p.signatureFields.length,0)<=100&&new Set(v.flatMap(p=>p.signatureFields.map(f=>f.id))).size===v.reduce((n,p)=>n+p.signatureFields.length,0))}).strict();
export type SignatureCompletionSource=z.infer<typeof expected>;
export type WorkSignatureCompletionSource=z.infer<typeof workSignatureCompletionSourceSchema>;
type Expected=SignatureCompletionSource;
type Projection=Awaited<ReturnType<typeof getBoldSignCompletionDocument>>['properties'];
// Observed checkbox selection is evidence,NOT effective consent/publication.
// Missing,ambiguous,required or locked choices cannot be treated as an opt-in.
export function observeProfileConsentChoices(original:NonNullable<SignatureCompletionSource['consentFields']>,fields:Projection['signerDetails'][number]['formFields']){
 return original.map(o=>{
  const matches=fields?.filter(f=>f.id===o.id)??[],f=matches[0];
  const exact=matches.length===1&&f.type.toLowerCase()==='checkbox'&&f.pageNumber===o.pageNumber&&isDeepStrictEqual(f.bounds,o.bounds)&&f.isRequired===false&&f.isReadOnly===false;
  return {purpose:o.purpose,fieldId:o.id,choice:exact&&f.value==='on'?'selected' as const:exact&&f.value==='off'?'declined' as const:'unverified' as const};
 });
}
type Artifact={bytes:Buffer;sha256:string;sizeBytes:number};
export type SignatureCompletionArtifacts={document:Artifact;audit:Artifact;properties:Artifact};
// Retention must be independently configured private durable storage,not merely
// PDF hashes. Neither metadata nor an injected test receipt proves retention.
type EvidenceServices<S>={fetch?:typeof fetch;retain:(source:S,evidence:SignatureCompletionArtifacts,signal:AbortSignal)=>Promise<z.input<typeof retained>>};
type SignerObservation={name:string;email:string;phone:string|null};
type SignerMatch={nameMatches:boolean;emailMatches:boolean;phoneMatches:boolean}|null;
type Services=EvidenceServices<Expected>&{
 // Must compare to ORIGINAL private dispatch history,not current contacts or
 // caller booleans. No known historical binding => null,never a guessed match.
 matchSigner:(source:Expected,observed:SignerObservation)=>Promise<SignerMatch>;
};
type WorkServices=EvidenceServices<WorkSignatureCompletionSource>&{matchSigner:(source:WorkSignatureCompletionSource,role:'worker'|'academy_representative',observed:SignerObservation)=>Promise<SignerMatch>};
type Bounded=<T>(p:Promise<T>)=>Promise<T>;
let active=0;
function phone(value:Projection['signerDetails'][number]['phoneNumber']){
 if(value==null)return null;try{const raw=typeof value==='string'?value:(value.countryCode.startsWith('+')?value.countryCode:'+'+value.countryCode)+value.number,p=parsePhoneNumberWithError(raw);if(!p.isValid())throw Error();return p.number as string;}catch{throw new ApiError(409,'BOLDSIGN_COMPLETION_SIGNER_MISMATCH');}
}
function inspectSigner(s:Projection['signerDetails'][number],signatureFields:Expected['signatureFields']|null){
 const bad=()=>new ApiError(409,'BOLDSIGN_COMPLETION_SOURCE_MISMATCH');
 if(s.status!=='Completed'||s.isReassigned===true||s.isAuthenticationFailed===true)throw bad();
 if(s.signerType!==undefined&&s.signerType!=='Signer'||s.signType!==undefined&&s.signType!=='Single')throw bad();
 if(!s.signerName)throw new ApiError(409,'BOLDSIGN_COMPLETION_SIGNER_UNAVAILABLE');
 const fields=s.formFields?.filter(f=>f.type.toLowerCase()==='signature').sort((a,b)=>a.id.localeCompare(b.id));
 if(fields&&signatureFields&&(new Set(fields.map(f=>f.id)).size!==fields.length||fields.length!==signatureFields.length||fields.some(f=>{const original=signatureFields.find(o=>o.id===f.id);return !original||f.pageNumber!==original.pageNumber||f.bounds!==undefined&&!isDeepStrictEqual(f.bounds,original.bounds);})))throw bad();
 const reasons:string[]=[];if(s.signerType!=='Signer'||s.signType!=='Single'||s.isReassigned!==false)reasons.push('provider_flags_incomplete');
 if(s.authenticationType!=null&&s.authenticationType!=='SMSOTP'||s.enableEmailOTP===false)throw bad();
 if(s.authenticationType!=='SMSOTP'||s.enableEmailOTP!==true)reasons.push('dual_otp_not_reported');
 if(s.isAuthenticationFailed!==false)reasons.push('authentication_result_not_explicit');
 if(!fields||fields.some(f=>!f.bounds))reasons.push('signature_fields_not_reported');const observedPhone=phone(s.phoneNumber);if(!observedPhone)reasons.push('phone_target_not_reported');
 return {name:s.signerName,email:s.signerEmail,phone:observedPhone,providerSignerId:s.id,reasons};
}
function inspectDocument(p:Projection,e:{documentId:string},metadata:Record<string,string>){
 if(p.documentId!==e.documentId||p.isDeleted===true||Object.entries(metadata).some(([k,v])=>p.metaData?.[k]!==v))throw new ApiError(409,'BOLDSIGN_COMPLETION_SOURCE_MISMATCH');
 if(p.status!=='Completed')return false;
 if(p.enablePrintAndSign===true||p.enableReassign===true)throw new ApiError(409,'BOLDSIGN_COMPLETION_SOURCE_MISMATCH');return true;
}
function inspect(p:Projection,e:Expected){
 if(!inspectDocument(p,e,{kavoshPackageId:e.packageId,kavoshContentAttachmentId:e.attachmentId,kavoshContentBindingId:e.bindingId,kavoshDocumentSha256:e.documentSha256}))return null;
 if(p.signerDetails.length!==1)throw new ApiError(409,'BOLDSIGN_COMPLETION_SOURCE_MISMATCH');const s=inspectSigner(p.signerDetails[0],e.signatureFields);
 if(p.isDeleted!==false||p.enablePrintAndSign!==false||p.enableReassign!==false)if(!s.reasons.includes('provider_flags_incomplete'))s.reasons.unshift('provider_flags_incomplete');
 return {...s,...e.consentFields?{profileConsentObservations:observeProfileConsentChoices(e.consentFields,p.signerDetails[0].formFields)}:{}};
}
function inspectWork(p:Projection,e:WorkSignatureCompletionSource){
 if(!inspectDocument(p,e,{kavoshWorkPreparationId:e.preparationId,kavoshWorkContentBindingId:e.bindingId,kavoshDocumentSha256:e.documentSha256}))return null;
 if(p.signerDetails.length!==2||new Set(p.signerDetails.map(s=>s.id)).size!==2||new Set(p.signerDetails.map(s=>s.signerEmail.toLowerCase())).size!==2)throw new ApiError(409,'BOLDSIGN_COMPLETION_SOURCE_MISMATCH');
 const candidates=p.signerDetails.map(s=>({...inspectSigner(s,null),fields:s.formFields?.filter(f=>f.type.toLowerCase()==='signature').sort((a,b)=>a.id.localeCompare(b.id))})).sort((a,b)=>a.providerSignerId.localeCompare(b.providerSignerId));
 return {candidates,reasons:p.isDeleted!==false||p.enablePrintAndSign!==false||p.enableReassign!==false?['provider_flags_incomplete']:[]};
}

// Read-only operator component,not mounted as a route or enabled by an env
// toggle. Its expected binding MUST come from an owned original-bound start
// and conflict-free provider receipt. Nothing here creates/sends/retries a
// signing request or grants admission. Persistence/review follows separately.
async function reconcileCompletion<S extends {documentId:string;region:BoldSignConnection['region'];sourceFingerprint:string},P extends {reasons:string[]}>(config:BoldSignConnection,e:S,services:EvidenceServices<S>,inspect:(p:Projection,e:S)=>P|null,verify:(e:S,p:P,bounded:Bounded)=>Promise<{providerSignerId?:string;providerSigners?:{role:string;providerSignerId:string}[];reviewReasons?:string[]}>,options:{signal?:AbortSignal;timeoutMs?:number}){
 const freeze=(v:unknown)=>{if(v&&typeof v==='object'){for(const child of Object.values(v))freeze(child);Object.freeze(v);}};freeze(e);
 const timeout=options.timeoutMs??30000;if(!Number.isInteger(timeout)||timeout<1||timeout>30000)throw new ApiError(400,'INVALID_SIGNATURE_COMPLETION_DEADLINE');
 if(config.region!==e.region)throw new ApiError(503,'SIGNATURE_COMPLETION_CONNECTION_MISMATCH');if(active>=2)throw new ApiError(503,'SIGNATURE_COMPLETION_BUSY');
 const abort=new AbortController(),cancel=()=>abort.abort();options.signal?.addEventListener('abort',cancel,{once:true});if(options.signal?.aborted)cancel();const timer=setTimeout(cancel,timeout);active++;
 const buffers:Buffer[]=[],resources=new Set<Promise<unknown>>();let rejectStop!:(e:Error)=>void;const stopped=new Promise<never>((_,reject)=>{rejectStop=reject;});void stopped.catch(()=>{});const onAbort=()=>rejectStop(new ApiError(503,'SIGNATURE_COMPLETION_INTERRUPTED'));abort.signal.addEventListener('abort',onAbort,{once:true});
 const observe=(p:Promise<unknown>)=>{const tracked=p.then(()=>{},()=>{});resources.add(tracked);void tracked.then(()=>resources.delete(tracked));};
 const bounded=<T>(p:Promise<T>)=>{observe(p);return Promise.race([p,stopped]);};
 try{
  if(abort.signal.aborted)throw new ApiError(503,'SIGNATURE_COMPLETION_INTERRUPTED');
  const first=await getBoldSignCompletionDocument(config,e.documentId,services.fetch,abort.signal,observe);buffers.push(first.bytes);const before=inspect(first.properties,e);
  if(!before)return {state:'not_completed' as const,completionReported:false,evidenceRetained:false,admissionCleared:false,providerMutationPerformed:false};
  const verified=await verify(e,before,bounded);
  const document=await getBoldSignDocumentPdf(config,e.documentId,services.fetch,abort.signal,observe);buffers.push(document.bytes);
  const audit=await getBoldSignAuditPdf(config,e.documentId,services.fetch,abort.signal,observe);buffers.push(audit.bytes);if(document.sha256===audit.sha256)throw new ApiError(409,'BOLDSIGN_COMPLETION_ARTIFACT_MISMATCH');
  const latest=await getBoldSignCompletionDocument(config,e.documentId,services.fetch,abort.signal,observe);buffers.push(latest.bytes);const after=inspect(latest.properties,e);
  if(!after||!isDeepStrictEqual(before,after))throw new ApiError(409,'BOLDSIGN_COMPLETION_CHANGED');
  const artifacts={document:Object.freeze({...document}),audit:Object.freeze({...audit}),properties:Object.freeze({bytes:latest.bytes,sha256:latest.sha256,sizeBytes:latest.sizeBytes})};
  let receipt;try{receipt=retained.parse(await bounded(services.retain(e,artifacts,abort.signal)));}catch{throw new ApiError(503,'SIGNATURE_COMPLETION_RETENTION_UNAVAILABLE');}
  if(receipt.sourceFingerprint!==e.sourceFingerprint||new Set([receipt.document.id,receipt.audit.id,receipt.properties.id]).size!==3||(['document','audit','properties'] as const).some(k=>{const actual=k==='document'?document:k==='audit'?audit:latest;return receipt[k].sha256!==actual.sha256||receipt[k].sizeBytes!==actual.sizeBytes;}))throw new ApiError(409,'SIGNATURE_COMPLETION_RETENTION_MISMATCH');
  if(Object.values(artifacts).some(a=>createHash('sha256').update(a.bytes).digest('hex')!==a.sha256))throw new ApiError(409,'SIGNATURE_COMPLETION_RETENTION_MISMATCH');
  const reasons=verified.reviewReasons??after.reasons;
  return {state:reasons.length?'review_required' as const:'evidence_recorded' as const,completionReported:true,reviewReasons:reasons,evidence:receipt,...verified.providerSignerId?{providerSignerId:verified.providerSignerId}:{providerSigners:verified.providerSigners},evidenceRetained:true,admissionCleared:false,legalValidityCertified:false,malwareFreeVerified:false,providerMutationPerformed:false};
 }catch(error){if(error instanceof ApiError)throw error;throw new ApiError(502,'SIGNATURE_COMPLETION_UNAVAILABLE');}
 finally{clearTimeout(timer);options.signal?.removeEventListener('abort',cancel);abort.signal.removeEventListener('abort',onAbort);const release=()=>{for(const b of buffers)b.fill(0);active--;};if(resources.size)void Promise.allSettled([...resources]).then(release);else release();}
}
export async function reconcileEnrollmentCompletion(config:BoldSignConnection,raw:unknown,services:Services,options:{signal?:AbortSignal;timeoutMs?:number}={}){
 const parsed=expected.safeParse(raw);if(!parsed.success)throw new ApiError(400,'INVALID_SIGNATURE_COMPLETION_SOURCE');
 return reconcileCompletion(config,parsed.data,services,inspect,async(e,before,bounded)=>{
  let match;try{match=await bounded(services.matchSigner(e,{name:before.name,email:before.email,phone:before.phone}));}catch{throw new ApiError(503,'SIGNATURE_SIGNER_HISTORY_UNAVAILABLE');}
  if(!match)throw new ApiError(409,'SIGNATURE_SIGNER_HISTORY_UNAVAILABLE');if(match.nameMatches!==true||match.emailMatches!==true||before.phone!==null&&match.phoneMatches!==true)throw new ApiError(409,'BOLDSIGN_COMPLETION_SIGNER_MISMATCH');
  return {providerSignerId:before.providerSignerId};
 },options);
}
export async function reconcileWorkCompletion(config:BoldSignConnection,raw:unknown,services:WorkServices,options:{signal?:AbortSignal;timeoutMs?:number}={}){
 const parsed=workSignatureCompletionSourceSchema.safeParse(raw);if(!parsed.success)throw new ApiError(400,'INVALID_SIGNATURE_COMPLETION_SOURCE');
 const result=await reconcileCompletion(config,parsed.data,services,inspectWork,async(e,before,bounded)=>{
  const chosen=new Set<string>(),signers:{role:string;providerSignerId:string}[]=[],reasons=[...before.reasons];
  for(const party of e.parties){const matches:typeof before.candidates=[];
   for(const candidate of before.candidates){let match;try{match=await bounded(services.matchSigner(e,party.role,{name:candidate.name,email:candidate.email,phone:candidate.phone}));}catch{throw new ApiError(503,'SIGNATURE_SIGNER_HISTORY_UNAVAILABLE');}
    if(!match)throw new ApiError(409,'SIGNATURE_SIGNER_HISTORY_UNAVAILABLE');if(match.nameMatches===true&&match.emailMatches===true&&(candidate.phone===null||match.phoneMatches===true))matches.push(candidate);
   }
   if(matches.length!==1||chosen.has(matches[0].providerSignerId))throw new ApiError(409,'BOLDSIGN_COMPLETION_SIGNER_MISMATCH');const candidate=matches[0];chosen.add(candidate.providerSignerId);
   if(candidate.fields&&(new Set(candidate.fields.map(f=>f.id)).size!==candidate.fields.length||candidate.fields.length!==party.signatureFields.length||candidate.fields.some(f=>{const field=party.signatureFields.find(o=>o.id===f.id);return !field||f.pageNumber!==field.pageNumber||f.bounds!==undefined&&!isDeepStrictEqual(f.bounds,field.bounds);})))throw new ApiError(409,'BOLDSIGN_COMPLETION_SOURCE_MISMATCH');
   reasons.push(...candidate.reasons.map(r=>party.role+':'+r));signers.push({role:party.role,providerSignerId:candidate.providerSignerId});
  }
  return {providerSigners:signers,reviewReasons:reasons};
 },options);
 return {...result,purpose:'worker_services' as const,signedByBothPartiesVerified:false,legallyEffective:false,paymentCleared:false};
}
