import { createHash } from 'node:crypto';
import { parsePhoneNumberWithError } from 'libphonenumber-js/max';
import { z } from 'zod';
import { ApiError } from '../core/policy.ts';
import { agreementRouting,workAgreementRouting } from './boldsign.ts';

const uuid=z.string().uuid().transform(v=>v.toLowerCase()),hash=z.string().regex(/^[a-f0-9]{64}$/);
const text=z.string().refine(v=>v.isWellFormed()&&!v.includes('\0'));
const label=text.min(1).max(200).refine(v=>v.trim().length>0&&!/[\r\n]/.test(v));
export const boldSignRequestOptions=z.object({title:label,message:text.max(2000),expiryDays:z.number().int().min(1).max(180)}).strict();
const signer=z.object({personId:uuid,legalName:label,email:z.string().email().max(254),phoneE164:z.string().regex(/^\+[1-9]\d{7,14}$/),emailVerified:z.literal(true),phoneVerified:z.literal(true),contactFingerprint:hash}).strict();
const draft=boldSignRequestOptions.extend({packageId:uuid,attachmentId:uuid,bindingId:uuid,locale:z.enum(['en','fr','zh-CN']),
 document:z.object({sha256:hash,sizeBytes:z.number().int().min(9).max(10_485_760)}).strict(),routing:agreementRouting,
 signer}).strict();
const revision=z.number().int().positive().max(2147483647),guardianBase=signer.extend({authorityVersion:revision,authorityApprovalId:uuid,guardianProfileVersion:revision});
const guardian=z.union([guardianBase.extend({workerIdentityVersion:revision,workerIdentityApprovalId:uuid}).strict(),guardianBase.extend({identitySource:z.literal('student'),studentRelationshipId:uuid,studentProfileVersion:revision}).strict()]);
const authorityBase=z.object({personId:uuid,version:revision,approvalId:uuid,profileVersion:revision});
export const workGuardianAuthoritySchema=z.union([authorityBase.extend({workerIdentityVersion:revision,workerIdentityApprovalId:uuid}).strict(),authorityBase.extend({identitySource:z.literal('student'),relationshipId:uuid,studentProfileVersion:revision}).strict()]);
export function workGuardianMetadata(a:z.infer<typeof workGuardianAuthoritySchema>){return{kavoshWorkGuardianId:a.personId,kavoshWorkGuardianAuthorityVersion:String(a.version),kavoshWorkGuardianAuthorityApprovalId:a.approvalId,kavoshWorkGuardianProfileVersion:String(a.profileVersion),...('identitySource'in a?{kavoshWorkIdentitySource:a.identitySource,kavoshWorkStudentRelationshipId:a.relationshipId,kavoshWorkStudentProfileVersion:String(a.studentProfileVersion)}:{kavoshWorkerIdentityVersion:String(a.workerIdentityVersion),kavoshWorkerIdentityApprovalId:a.workerIdentityApprovalId})};}
const workDraft=boldSignRequestOptions.extend({preparationId:uuid,bindingId:uuid,locale:draft.shape.locale,document:draft.shape.document,routing:workAgreementRouting,worker:signer,academyRepresentative:signer,guardian:guardian.optional()}).strict().refine(i=>(i.routing.version===3?i.guardian!==undefined:i.guardian===undefined)&&(!i.guardian||!('identitySource'in i.guardian)||i.routing.parties.every(p=>p.fields.every(f=>f.isRequired))));
export type BoldSignSendDraft=z.infer<typeof draft>;
export const boldSignSendDraftSchema=draft;
export type BoldSignWorkSendDraft=z.infer<typeof workDraft>;
export const boldSignWorkSendDraftSchema=workDraft;
const executableTypes={signature:'Signature',initial:'Initial',checkbox:'CheckBox',datesigned:'DateSigned'} as const;
const digest=(value:Uint8Array|string)=>createHash('sha256').update(value).digest('hex');

// OFFLINE ONLY. No credentials, fetch, database access or mounted route. Caller
// must hydrate private identity/source facts from authorized durable records;
// supplied verification booleans are claims, not independent identity proof.
// https://developers.boldsign.com/documents/send-document/
// https://developers.boldsign.com/documents/add-authentication-to-the-document/
function documentBytes(document:z.infer<typeof draft.shape.document>,inputBytes:Uint8Array){let bytes:Buffer;
 try {
  if(!(inputBytes instanceof Uint8Array)||inputBytes.byteLength!==document.sizeBytes||inputBytes.byteLength>10_485_760)throw new Error('BYTES');
  bytes=Buffer.from(inputBytes);
 }catch{throw new ApiError(409,'BOLDSIGN_DOCUMENT_IDENTITY_MISMATCH');}
 if(digest(bytes)!==document.sha256||!/^%PDF-(?:1\.[0-7]|2\.0)[\r\n]/.test(bytes.subarray(0,9).toString('latin1')))throw new ApiError(409,'BOLDSIGN_DOCUMENT_IDENTITY_MISMATCH');return bytes;
}
function recipient(s:z.infer<typeof signer>,locale:z.infer<typeof draft.shape.locale>,routing:z.infer<typeof agreementRouting>['fields']){
 let phone:ReturnType<typeof parsePhoneNumberWithError>;
 try{phone=parsePhoneNumberWithError(s.phoneE164);if(!phone.isValid()||phone.number!==s.phoneE164)throw new Error('PHONE');}
 catch{throw new ApiError(400,'INVALID_BOLDSIGN_SIGNER_PHONE');}
 const fields=routing.map(f=>{
  const type=f.fieldType.toLowerCase();
  if(!/^[A-Za-z_][A-Za-z0-9_]*$/.test(f.id)||!Object.hasOwn(executableTypes,type))throw new ApiError(409,'BOLDSIGN_ROUTING_UNSUPPORTED');
  return {Id:f.id,FieldType:executableTypes[type as keyof typeof executableTypes],IsRequired:f.isRequired,PageNumber:f.pageNumber,Bounds:{X:f.bounds.x,Y:f.bounds.y,Width:f.bounds.width,Height:f.bounds.height},...!f.isRequired?{Value:'off',IsReadOnly:false}:{}};
 });
 return {Name:s.legalName,EmailAddress:s.email,SignerType:'Signer',SignType:'Single',Locale:({en:'EN',fr:'FR','zh-CN':'ZH_CN'} as const)[locale],AuthenticationType:'SMSOTP',EnableEmailOTP:true,PhoneNumber:{CountryCode:'+'+phone.countryCallingCode,Number:phone.nationalNumber},DeliveryMode:'Email',AllowFieldConfiguration:false,FormFields:fields};
}
function wireBody(i:z.infer<typeof boldSignRequestOptions>,bytes:Buffer,signers:ReturnType<typeof recipient>[],metadata:Record<string,string>){
 // Both documented OTP settings are requested, not proven jointly enforced.
 // Live account entitlement/compatibility must be verified before any sender
 // is enabled; do not infer authentication success from a generated payload.
 const body=JSON.stringify({Title:i.title,Message:i.message,Files:['data:application/pdf;base64,'+bytes.toString('base64')],
  Signers:signers,
  EnableReassign:false,EnablePrintAndSign:false,AutoDetectFields:false,UseTextTags:false,EnableSigningOrder:false,EnableEmbeddedSigning:false,
  DisableEmails:false,DisableSMS:false,ReminderSettings:{EnableAutoReminder:false},ExpiryDateType:'Days',ExpiryValue:i.expiryDays,HideDocumentId:false,
  MetaData:metadata});
 const bodyBytes=Buffer.byteLength(body,'utf8');if(bodyBytes>16_777_216)throw new ApiError(409,'BOLDSIGN_REQUEST_TOO_LARGE');
 return {body,requestSha256:digest(body),requestBytes:bodyBytes};
}
export function buildBoldSignSendRequest(raw:unknown,inputBytes:Uint8Array) {
 const selected=draft.safeParse(raw);if(!selected.success)throw new ApiError(400,'INVALID_BOLDSIGN_SEND_DRAFT');const i=selected.data,bytes=documentBytes(i.document,inputBytes);
 const {body,requestSha256,requestBytes}=wireBody(i,bytes,[recipient(i.signer,i.locale,i.routing.fields)],{kavoshPackageId:i.packageId,kavoshContentAttachmentId:i.attachmentId,kavoshContentBindingId:i.bindingId,kavoshDocumentSha256:i.document.sha256});
 // Keep the private wire body separate from the bounded receipt. Do not log or
 // publish either; hashes/IDs still link to personal agreement records.
 return {body,receipt:{formatVersion:1 as const,packageId:i.packageId,attachmentId:i.attachmentId,bindingId:i.bindingId,signerId:i.signer.personId,
  contactFingerprint:i.signer.contactFingerprint,documentSha256:i.document.sha256,documentBytes:bytes.length,requestSha256,requestBytes}};
}
// Same bounded offline transport format, but never treat one legal_signer or a
// group signer as proof that BOTH individual counterparties signed a framework.
export function buildBoldSignWorkSendRequest(raw:unknown,inputBytes:Uint8Array){
 const selected=workDraft.safeParse(raw);if(!selected.success)throw new ApiError(400,'INVALID_BOLDSIGN_WORK_SEND_DRAFT');const i=selected.data;
 const parties=[{role:'worker' as const,signer:i.worker},{role:'academy_representative' as const,signer:i.academyRepresentative},...i.guardian?[{role:'legal_guardian' as const,signer:i.guardian}]:[]];
 if(new Set(parties.map(p=>p.signer.personId)).size!==parties.length||new Set(parties.map(p=>p.signer.email.toLowerCase())).size!==parties.length||new Set(parties.map(p=>p.signer.phoneE164)).size!==parties.length)throw new ApiError(409,'INDEPENDENT_WORK_SIGNERS_REQUIRED');
 const bytes=documentBytes(i.document,inputBytes),authority=i.guardian?{personId:i.guardian.personId,version:i.guardian.authorityVersion,approvalId:i.guardian.authorityApprovalId,profileVersion:i.guardian.guardianProfileVersion,...('identitySource'in i.guardian?{identitySource:i.guardian.identitySource,relationshipId:i.guardian.studentRelationshipId,studentProfileVersion:i.guardian.studentProfileVersion}:{workerIdentityVersion:i.guardian.workerIdentityVersion,workerIdentityApprovalId:i.guardian.workerIdentityApprovalId})}:null;
 const {body,requestSha256,requestBytes}=wireBody(i,bytes,parties.map(p=>recipient(p.signer,i.locale,i.routing.parties.find(r=>r.role===p.role)!.fields)),{kavoshWorkPreparationId:i.preparationId,kavoshWorkContentBindingId:i.bindingId,kavoshDocumentSha256:i.document.sha256,...authority?workGuardianMetadata(authority):{}});
 return {body,receipt:{formatVersion:i.guardian?2 as const:1 as const,purpose:'worker_services' as const,preparationId:i.preparationId,bindingId:i.bindingId,signers:parties.map(p=>({role:p.role,personId:p.signer.personId,contactFingerprint:p.signer.contactFingerprint})),...authority?{guardianAuthority:authority}:{},documentSha256:i.document.sha256,documentBytes:bytes.length,requestSha256,requestBytes}};
}
