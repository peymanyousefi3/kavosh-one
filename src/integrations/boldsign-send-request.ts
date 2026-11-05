import { createHash } from 'node:crypto';
import { parsePhoneNumberWithError } from 'libphonenumber-js/max';
import { z } from 'zod';
import { ApiError } from '../core/policy.ts';
import { agreementRouting } from './boldsign.ts';

const uuid=z.string().uuid().transform(v=>v.toLowerCase()),hash=z.string().regex(/^[a-f0-9]{64}$/);
const text=z.string().refine(v=>v.isWellFormed()&&!v.includes('\0'));
const label=text.min(1).max(200).refine(v=>v.trim().length>0&&!/[\r\n]/.test(v));
export const boldSignRequestOptions=z.object({title:label,message:text.max(2000),expiryDays:z.number().int().min(1).max(180)}).strict();
const draft=boldSignRequestOptions.extend({packageId:uuid,attachmentId:uuid,bindingId:uuid,locale:z.enum(['en','fr','zh-CN']),
 document:z.object({sha256:hash,sizeBytes:z.number().int().min(9).max(10_485_760)}).strict(),routing:agreementRouting,
 signer:z.object({personId:uuid,legalName:label,email:z.string().email().max(254),phoneE164:z.string().regex(/^\+[1-9]\d{7,14}$/),
  emailVerified:z.literal(true),phoneVerified:z.literal(true),contactFingerprint:hash}).strict()}).strict();
export type BoldSignSendDraft=z.infer<typeof draft>;
const executableTypes={signature:'Signature',initial:'Initial',checkbox:'CheckBox',datesigned:'DateSigned'} as const;
const digest=(value:Uint8Array|string)=>createHash('sha256').update(value).digest('hex');

// OFFLINE ONLY. No credentials, fetch, database access or mounted route. Caller
// must hydrate private identity/source facts from authorized durable records;
// supplied verification booleans are claims, not independent identity proof.
// https://developers.boldsign.com/documents/send-document/
// https://developers.boldsign.com/documents/add-authentication-to-the-document/
export function buildBoldSignSendRequest(raw:unknown,inputBytes:Uint8Array) {
 const selected=draft.safeParse(raw);if(!selected.success)throw new ApiError(400,'INVALID_BOLDSIGN_SEND_DRAFT');
 const i=selected.data;let bytes:Buffer;
 try {
  if(!(inputBytes instanceof Uint8Array)||inputBytes.byteLength!==i.document.sizeBytes||inputBytes.byteLength>10_485_760)throw new Error('BYTES');
  bytes=Buffer.from(inputBytes);
 }catch{throw new ApiError(409,'BOLDSIGN_DOCUMENT_IDENTITY_MISMATCH');}
 if(digest(bytes)!==i.document.sha256||!/^%PDF-(?:1\.[0-7]|2\.0)[\r\n]/.test(bytes.subarray(0,9).toString('latin1')))throw new ApiError(409,'BOLDSIGN_DOCUMENT_IDENTITY_MISMATCH');
 let phone:ReturnType<typeof parsePhoneNumberWithError>;
 try{phone=parsePhoneNumberWithError(i.signer.phoneE164);if(!phone.isValid()||phone.number!==i.signer.phoneE164)throw new Error('PHONE');}
 catch{throw new ApiError(400,'INVALID_BOLDSIGN_SIGNER_PHONE');}
 const fields=i.routing.fields.map(f=>{
  const type=f.fieldType.toLowerCase();
  if(!/^[A-Za-z_][A-Za-z0-9_]*$/.test(f.id)||!Object.hasOwn(executableTypes,type))throw new ApiError(409,'BOLDSIGN_ROUTING_UNSUPPORTED');
  return {Id:f.id,FieldType:executableTypes[type as keyof typeof executableTypes],IsRequired:true,PageNumber:f.pageNumber,Bounds:{X:f.bounds.x,Y:f.bounds.y,Width:f.bounds.width,Height:f.bounds.height}};
 });
 // Both documented OTP settings are requested, not proven jointly enforced.
 // Live account entitlement/compatibility must be verified before any sender
 // is enabled; do not infer authentication success from a generated payload.
 const body=JSON.stringify({Title:i.title,Message:i.message,Files:['data:application/pdf;base64,'+bytes.toString('base64')],
  Signers:[{Name:i.signer.legalName,EmailAddress:i.signer.email,SignerType:'Signer',SignType:'Single',Locale:({en:'EN',fr:'FR','zh-CN':'ZH_CN'} as const)[i.locale],
   AuthenticationType:'SMSOTP',EnableEmailOTP:true,PhoneNumber:{CountryCode:'+'+phone.countryCallingCode,Number:phone.nationalNumber},DeliveryMode:'Email',AllowFieldConfiguration:false,FormFields:fields}],
  EnableReassign:false,EnablePrintAndSign:false,AutoDetectFields:false,UseTextTags:false,EnableSigningOrder:false,EnableEmbeddedSigning:false,
  DisableEmails:false,DisableSMS:false,ReminderSettings:{EnableAutoReminder:false},ExpiryDateType:'Days',ExpiryValue:i.expiryDays,HideDocumentId:false,
  MetaData:{kavoshPackageId:i.packageId,kavoshContentAttachmentId:i.attachmentId,kavoshContentBindingId:i.bindingId,kavoshDocumentSha256:i.document.sha256}});
 const bodyBytes=Buffer.byteLength(body,'utf8');if(bodyBytes>16_777_216)throw new ApiError(409,'BOLDSIGN_REQUEST_TOO_LARGE');
 // Keep the private wire body separate from the bounded receipt. Do not log or
 // publish either; hashes/IDs still link to personal agreement records.
 return {body,receipt:{formatVersion:1 as const,packageId:i.packageId,attachmentId:i.attachmentId,bindingId:i.bindingId,signerId:i.signer.personId,
  contactFingerprint:i.signer.contactFingerprint,documentSha256:i.document.sha256,documentBytes:bytes.length,requestSha256:digest(body),requestBytes:bodyBytes}};
}
