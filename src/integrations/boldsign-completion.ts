import { isDeepStrictEqual } from 'node:util';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { parsePhoneNumberWithError } from 'libphonenumber-js/max';
import { ApiError } from '../core/policy.ts';
import { getBoldSignCompletionDocument,getBoldSignDocumentPdf,getBoldSignAuditPdf,type BoldSignConnection } from './boldsign.ts';

const uuid=z.string().uuid().transform(v=>v.toLowerCase()),hash=z.string().regex(/^[a-f0-9]{64}$/);
const signatureField=z.object({id:z.string().min(1).max(200),pageNumber:z.number().int().positive().max(1000),bounds:z.object({x:z.number().min(0).max(20000),y:z.number().min(0).max(20000),width:z.number().positive().max(20000),height:z.number().positive().max(20000)}).strict()}).strict();
const expected=z.object({academyId:uuid,startId:uuid,signerId:uuid,documentId:uuid,packageId:uuid,attachmentId:uuid,bindingId:uuid,documentSha256:hash,sourceFingerprint:hash,region:z.enum(['US','CA','EU','AU']),signatureFields:z.array(signatureField).min(1).max(100).refine(v=>new Set(v.map(f=>f.id)).size===v.length)}).strict();
const artifact=z.object({id:uuid,sha256:hash,sizeBytes:z.number().int().min(1).max(10485760)}).strict();
const retained=z.object({sourceFingerprint:hash,document:artifact,audit:artifact,properties:artifact}).strict();
export const signatureCompletionSourceSchema=expected;
export type SignatureCompletionSource=z.infer<typeof expected>;
type Expected=SignatureCompletionSource;
type Projection=Awaited<ReturnType<typeof getBoldSignCompletionDocument>>['properties'];
type Artifact={bytes:Buffer;sha256:string;sizeBytes:number};
export type SignatureCompletionArtifacts={document:Artifact;audit:Artifact;properties:Artifact};
type Services={
 fetch?:typeof fetch;
 // Must compare to ORIGINAL private dispatch history,not current contacts or
 // caller booleans. No known historical binding => null,never a guessed match.
 matchSigner:(source:Expected,observed:{name:string;email:string;phone:string|null})=>Promise<{nameMatches:boolean;emailMatches:boolean;phoneMatches:boolean}|null>;
 // Required separately configured PRIVATE durable evidence storage. Merely
 // returning PDF hashes is not retention. No public URLs in its receipt.
 retain:(source:Expected,evidence:SignatureCompletionArtifacts,signal:AbortSignal)=>Promise<z.input<typeof retained>>;
};
let active=0;
function phone(value:Projection['signerDetails'][number]['phoneNumber']){
 if(value==null)return null;try{const raw=typeof value==='string'?value:(value.countryCode.startsWith('+')?value.countryCode:'+'+value.countryCode)+value.number,p=parsePhoneNumberWithError(raw);if(!p.isValid())throw Error();return p.number as string;}catch{throw new ApiError(409,'BOLDSIGN_COMPLETION_SIGNER_MISMATCH');}
}
function inspect(p:Projection,e:Expected){
 const bad=()=>new ApiError(409,'BOLDSIGN_COMPLETION_SOURCE_MISMATCH');
 if(p.documentId!==e.documentId||p.isDeleted===true)throw bad();
 const metadata={kavoshPackageId:e.packageId,kavoshContentAttachmentId:e.attachmentId,kavoshContentBindingId:e.bindingId,kavoshDocumentSha256:e.documentSha256};
 if(Object.entries(metadata).some(([k,v])=>p.metaData?.[k]!==v))throw bad();
 if(p.status!=='Completed')return null;
 if(p.signerDetails.length!==1)throw bad();const s=p.signerDetails[0];
 if(s.status!=='Completed'||s.isReassigned===true||s.isAuthenticationFailed===true||p.enablePrintAndSign===true||p.enableReassign===true)throw bad();
 if(s.signerType!==undefined&&s.signerType!=='Signer'||s.signType!==undefined&&s.signType!=='Single')throw bad();
 if(!s.signerName)throw new ApiError(409,'BOLDSIGN_COMPLETION_SIGNER_UNAVAILABLE');
 const fields=s.formFields?.filter(f=>f.type.toLowerCase()==='signature').sort((a,b)=>a.id.localeCompare(b.id));
 if(fields&&(new Set(fields.map(f=>f.id)).size!==fields.length||fields.length!==e.signatureFields.length||fields.some(f=>{const original=e.signatureFields.find(o=>o.id===f.id);return !original||f.pageNumber!==original.pageNumber||f.bounds!==undefined&&!isDeepStrictEqual(f.bounds,original.bounds);})))throw bad();
 const reasons:string[]=[];if(p.isDeleted!==false||p.enablePrintAndSign!==false||p.enableReassign!==false||s.signerType!=='Signer'||s.signType!=='Single'||s.isReassigned!==false)reasons.push('provider_flags_incomplete');
 if(s.authenticationType!=null&&s.authenticationType!=='SMSOTP'||s.enableEmailOTP===false)throw bad();
 if(s.authenticationType!=='SMSOTP'||s.enableEmailOTP!==true)reasons.push('dual_otp_not_reported');
 if(s.isAuthenticationFailed!==false)reasons.push('authentication_result_not_explicit');
 if(!fields||fields.some(f=>!f.bounds))reasons.push('signature_fields_not_reported');const observedPhone=phone(s.phoneNumber);if(!observedPhone)reasons.push('phone_target_not_reported');
 return {name:s.signerName,email:s.signerEmail,phone:observedPhone,providerSignerId:s.id,reasons};
}

// Read-only operator component,not mounted as a route or enabled by an env
// toggle. Its expected binding MUST come from an owned original-bound start
// and conflict-free provider receipt. Nothing here creates/sends/retries a
// signing request or grants admission. Persistence/review follows separately.
export async function reconcileEnrollmentCompletion(config:BoldSignConnection,raw:unknown,services:Services,options:{signal?:AbortSignal;timeoutMs?:number}={}){
 const parsed=expected.safeParse(raw);if(!parsed.success)throw new ApiError(400,'INVALID_SIGNATURE_COMPLETION_SOURCE');const e=parsed.data;for(const f of e.signatureFields){Object.freeze(f.bounds);Object.freeze(f);}Object.freeze(e.signatureFields);Object.freeze(e);
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
  let match;try{match=await bounded(services.matchSigner(e,{name:before.name,email:before.email,phone:before.phone}));}catch{throw new ApiError(503,'SIGNATURE_SIGNER_HISTORY_UNAVAILABLE');}
  if(!match)throw new ApiError(409,'SIGNATURE_SIGNER_HISTORY_UNAVAILABLE');if(match.nameMatches!==true||match.emailMatches!==true||before.phone!==null&&match.phoneMatches!==true)throw new ApiError(409,'BOLDSIGN_COMPLETION_SIGNER_MISMATCH');
  const document=await getBoldSignDocumentPdf(config,e.documentId,services.fetch,abort.signal,observe);buffers.push(document.bytes);
  const audit=await getBoldSignAuditPdf(config,e.documentId,services.fetch,abort.signal,observe);buffers.push(audit.bytes);if(document.sha256===audit.sha256)throw new ApiError(409,'BOLDSIGN_COMPLETION_ARTIFACT_MISMATCH');
  const latest=await getBoldSignCompletionDocument(config,e.documentId,services.fetch,abort.signal,observe);buffers.push(latest.bytes);const after=inspect(latest.properties,e);
  if(!after||!isDeepStrictEqual(before,after))throw new ApiError(409,'BOLDSIGN_COMPLETION_CHANGED');
  const artifacts={document:Object.freeze({...document}),audit:Object.freeze({...audit}),properties:Object.freeze({bytes:latest.bytes,sha256:latest.sha256,sizeBytes:latest.sizeBytes})};
  let receipt;try{receipt=retained.parse(await bounded(services.retain(e,artifacts,abort.signal)));}catch{throw new ApiError(503,'SIGNATURE_COMPLETION_RETENTION_UNAVAILABLE');}
  if(receipt.sourceFingerprint!==e.sourceFingerprint||new Set([receipt.document.id,receipt.audit.id,receipt.properties.id]).size!==3||(['document','audit','properties'] as const).some(k=>{const actual=k==='document'?document:k==='audit'?audit:latest;return receipt[k].sha256!==actual.sha256||receipt[k].sizeBytes!==actual.sizeBytes;}))throw new ApiError(409,'SIGNATURE_COMPLETION_RETENTION_MISMATCH');
  if(Object.values(artifacts).some(a=>createHash('sha256').update(a.bytes).digest('hex')!==a.sha256))throw new ApiError(409,'SIGNATURE_COMPLETION_RETENTION_MISMATCH');
  return {state:after.reasons.length?'review_required' as const:'evidence_recorded' as const,completionReported:true,reviewReasons:after.reasons,evidence:receipt,providerSignerId:after.providerSignerId,evidenceRetained:true,admissionCleared:false,legalValidityCertified:false,malwareFreeVerified:false,providerMutationPerformed:false};
 }catch(error){if(error instanceof ApiError)throw error;throw new ApiError(502,'SIGNATURE_COMPLETION_UNAVAILABLE');}
 finally{clearTimeout(timer);options.signal?.removeEventListener('abort',cancel);abort.signal.removeEventListener('abort',onAbort);const release=()=>{for(const b of buffers)b.fill(0);active--;};if(resources.size)void Promise.allSettled([...resources]).then(release);else release();}
}
