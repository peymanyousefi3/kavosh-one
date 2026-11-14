import assert from 'node:assert/strict';
import { createHash,webcrypto } from 'node:crypto';
import { test } from 'node:test';
import { buildBoldSignSendRequest,type BoldSignSendDraft } from '../src/integrations/boldsign-send-request.ts';
import { agreementRouting,workAgreementRouting } from '../src/integrations/boldsign.ts';

const packageId='e2af3028-2ec3-4f13-8c47-eafdfc51b1e4',attachmentId='f631b2a0-a664-41ca-9f64-c65f00ea08b1',bindingId='7dd390f6-3cdc-41cf-a3f8-acfe5e679098';
// Header fixture, not a parsed/clean legal PDF or actual provider evidence.
const pdf=Buffer.from('%PDF-1.7\nPRIVATE agreement fixture\x00\xff\n%%EOF\n','latin1'),hash=(v:Uint8Array|string)=>createHash('sha256').update(v).digest('hex');
const input:BoldSignSendDraft={packageId,attachmentId,bindingId,title:'PRIVATE Unified agreement',message:'PRIVATE Please review the complete agreement.',locale:'en',expiryDays:30,
 document:{sha256:hash(pdf),sizeBytes:pdf.length},routing:{version:1,role:'legal_signer',fields:[{id:'Signature1',fieldType:'Signature',isRequired:true,pageNumber:1,bounds:{x:20,y:40,width:180,height:35}}]},
 signer:{personId:'2ca4d03e-96ec-4e47-95fe-63b21cba297d',legalName:'PRIVATE Jean-Luc 王',email:'PRIVATE@example.test',phoneE164:'+16475550101',emailVerified:true,phoneVerified:true,contactFingerprint:'c'.repeat(64)}};
const invalid={code:'INVALID_BOLDSIGN_SEND_DRAFT',status:400},mismatch={code:'BOLDSIGN_DOCUMENT_IDENTITY_MISMATCH',status:409};

test('version two keeps optional profile choices unchecked and editable within the mandatory signed document',()=>{
 const signature=input.routing.fields[0],choice={...signature,id:'PublicProfileChoice',fieldType:'CheckBox',isRequired:false,consentPurpose:'public_profile'};
 const routing={version:2,role:'legal_signer',fields:[signature,choice,{...choice,id:'MembersChoice',consentPurpose:'verified_member_profile'}]};
 const body=JSON.parse(buildBoldSignSendRequest({...input,routing},pdf).body),fields=body.Signers[0].FormFields;
 assert.equal(body.Signers.length,1);assert.deepEqual(fields[0],JSON.parse(buildBoldSignSendRequest(input,pdf).body).Signers[0].FormFields[0]);
 for(const [n,id] of ['PublicProfileChoice','MembersChoice'].entries())assert.deepEqual(fields[n+1],{Id:id,FieldType:'CheckBox',IsRequired:false,PageNumber:1,Bounds:{X:20,Y:40,Width:180,Height:35},Value:'off',IsReadOnly:false});
 assert.ok(!JSON.stringify(body).includes('consentPurpose'));
 const before=buildBoldSignSendRequest(input,pdf);assert.deepEqual(buildBoldSignSendRequest(input,pdf),before);
 for(const fields of [[choice],[signature],[signature,{...choice,isRequired:true}],[signature,{...choice,fieldType:'Signature'}],[signature,{...choice,consentPurpose:'all_data'}],
  [signature,{...choice,Value:'on'}],[signature,{...choice,isReadOnly:true}],[signature,choice,{...choice,id:'DuplicatePurpose'}]])assert.throws(()=>buildBoldSignSendRequest({...input,routing:{...routing,fields}},pdf),invalid);
 assert.equal(agreementRouting.safeParse({...routing,version:1}).success,false);
 assert.equal(workAgreementRouting.safeParse({version:1,parties:[{role:'worker',fields:routing.fields},{role:'academy_representative',fields:[{...signature,id:'AcademySignature'}]}]}).success,false);
});

test('offline request uses exact PDF bytes and independent body digest with no mutable template, URLs, credentials or network',async()=>{
 const original=globalThis.fetch;let calls=0;globalThis.fetch=async()=>{calls++;throw new Error('NETWORK_FORBIDDEN');};
 let result:ReturnType<typeof buildBoldSignSendRequest>;
 try{result=buildBoldSignSendRequest(input,pdf);}finally{globalThis.fetch=original;}
 assert.equal(calls,0);assert.deepEqual(buildBoldSignSendRequest(input,pdf),result);
 const body=JSON.parse(result.body);assert.deepEqual(Buffer.from(body.Files[0].split(',')[1],'base64'),pdf);assert.equal(body.Files.length,1);
 assert.equal(result.receipt.requestSha256,Buffer.from(await webcrypto.subtle.digest('SHA-256',Buffer.from(result.body))).toString('hex'));assert.equal(result.receipt.requestBytes,Buffer.byteLength(result.body));
 assert.equal(result.receipt.documentSha256,hash(pdf));assert.equal(result.receipt.documentBytes,pdf.length);assert.equal(result.receipt.signerId,input.signer.personId);assert.equal(result.receipt.contactFingerprint,input.signer.contactFingerprint);
 assert.deepEqual(body.MetaData,{kavoshPackageId:packageId,kavoshContentAttachmentId:attachmentId,kavoshContentBindingId:bindingId,kavoshDocumentSha256:hash(pdf)});
 for(const key of ['TemplateId','FileUrls','OnBehalfOf','CC','apiKey','AuthenticationCode'])assert.equal(key in body,false);
 assert.equal(JSON.stringify(result.receipt).includes('PRIVATE'),false);assert.equal('readyToSend' in result.receipt,false);assert.equal('admissionCleared' in result.receipt,false);
});
test('OTP, recipient editing and field discovery cannot be downgraded through the fixed request policy',()=>{
 const body=JSON.parse(buildBoldSignSendRequest(input,pdf).body),signer=body.Signers[0];assert.equal(body.Signers.length,1);
 assert.equal(signer.Name,input.signer.legalName);assert.equal(signer.EmailAddress,input.signer.email);assert.equal(signer.AuthenticationType,'SMSOTP');assert.equal(signer.EnableEmailOTP,true);assert.equal(signer.SignerType,'Signer');assert.equal(signer.SignType,'Single');assert.equal(signer.DeliveryMode,'Email');assert.equal(signer.AllowFieldConfiguration,false);
 for(const key of ['EnableReassign','EnablePrintAndSign','AutoDetectFields','UseTextTags','EnableSigningOrder','EnableEmbeddedSigning'])assert.equal(body[key],false,key);
 assert.deepEqual(body.ReminderSettings,{EnableAutoReminder:false});assert.equal(body.ExpiryDateType,'Days');assert.equal(body.ExpiryValue,30);
 for(const patch of [{AuthenticationType:'None'},{EnableEmailOTP:false},{EnableReassign:true},{FileUrls:['https://localhost']},{apiKey:'PRIVATE-secret'},{signer:{...input.signer,emailVerified:false}},{signer:{...input.signer,phoneVerified:false}}])assert.throws(()=>buildBoldSignSendRequest({...input,...patch},pdf),invalid);
});
test('international phone parsing derives real calling codes and preserves canonical verified numbers without a country guess',()=>{
 for(const [phone,code,number] of [['+16475550101','+1','6475550101'],['+12025550123','+1','2025550123'],['+442079460018','+44','2079460018'],['+8613812345678','+86','13812345678']] as const) {
  const body=JSON.parse(buildBoldSignSendRequest({...input,signer:{...input.signer,phoneE164:phone}},pdf).body);assert.deepEqual(body.Signers[0].PhoneNumber,{CountryCode:code,Number:number});
 }
 for(const phone of ['+999123456789','+10000000000','+4402079460018'])assert.throws(()=>buildBoldSignSendRequest({...input,signer:{...input.signer,phoneE164:phone}},pdf),{code:'INVALID_BOLDSIGN_SIGNER_PHONE',status:400});
 for(const phone of ['6475550101','+1 6475550101','+16475550101;ext=5'])assert.throws(()=>buildBoldSignSendRequest({...input,signer:{...input.signer,phoneE164:phone}},pdf),invalid);
});
test('all approved signing locales are explicit and Unicode private text contributes its actual UTF-8 bytes to the fingerprint',()=>{
 const hashes=new Set<string>();for(const [locale,wire] of [['en','EN'],['fr','FR'],['zh-CN','ZH_CN']] as const){const result=buildBoldSignSendRequest({...input,locale,title:'合同 — Montréal',message:'请阅读并签名。'},pdf),body=JSON.parse(result.body);assert.equal(body.Signers[0].Locale,wire);assert.equal(body.Title,'合同 — Montréal');assert.equal(body.Message,'请阅读并签名。');assert.equal(result.receipt.requestBytes,Buffer.byteLength(result.body,'utf8'));hashes.add(result.receipt.requestSha256);}assert.equal(hashes.size,3);
 assert.throws(()=>buildBoldSignSendRequest({...input,locale:'de'},pdf),invalid);
});
test('supported reviewed fields retain every required page and bound; unsupported types or provider-invalid IDs are never silently dropped',()=>{
 const first=input.routing.fields[0],fields=['signature','Initial','CheckBox','DateSigned'].map((type,n)=>({...first,id:'Field_'+n,fieldType:type,pageNumber:n+1,bounds:{x:n+0.25,y:n+0.5,width:50.5,height:20.25}}));
 const body=JSON.parse(buildBoldSignSendRequest({...input,routing:{...input.routing,fields}},pdf).body);assert.equal(body.Signers[0].FormFields.length,4);
 for(const [n,type] of ['Signature','Initial','CheckBox','DateSigned'].entries())assert.deepEqual(body.Signers[0].FormFields[n],{Id:'Field_'+n,FieldType:type,IsRequired:true,PageNumber:n+1,Bounds:{X:n+0.25,Y:n+0.5,Width:50.5,Height:20.25}});
 for(const bad of [{...first,id:'签名'},{...first,id:'1wrong'},{...first,id:'has space'},{...first,fieldType:'FutureProviderField'},{...first,fieldType:'__proto__'},{...first,fieldType:'constructor'},{...first,fieldType:'TextBox'}])assert.throws(()=>buildBoldSignSendRequest({...input,routing:{...input.routing,fields:[first,{...bad,id:bad.id===first.id?'Other':bad.id}]}},pdf),{code:'BOLDSIGN_ROUTING_UNSUPPORTED',status:409});
});
test('source byte count, exact binary hash and strict PDF header prevent accidental content substitution',()=>{
 const changed=Buffer.from(pdf);changed[12]^=1;for(const value of [changed,pdf.subarray(1),Buffer.concat([pdf,Buffer.from(' ')])])assert.throws(()=>buildBoldSignSendRequest(input,value),mismatch);
 for(const value of [Buffer.from('not a pdf'),Buffer.from('%PDF-9.9\nfixture'),Buffer.from([0xa5,...Buffer.from('PDF-1.7\nfixture')])])assert.throws(()=>buildBoldSignSendRequest({...input,document:{sha256:hash(value),sizeBytes:value.length}},value),mismatch);
 for(const value of [null,{},pdf.toString('base64'),new DataView(pdf.buffer)])assert.throws(()=>buildBoldSignSendRequest(input,value as Uint8Array),mismatch);
 const copy=Buffer.from(pdf),before=buildBoldSignSendRequest(input,copy);copy.fill(0);assert.deepEqual(Buffer.from(JSON.parse(before.body).Files[0].split(',')[1],'base64'),pdf);
});
test('identity, expiry and routing validation stays bounded and sanitizes failures without including private source data',()=>{
 const first=input.routing.fields[0];
 for(const patch of [{packageId:'../private'},{attachmentId:undefined},{document:{...input.document,sha256:'bad'}},{expiryDays:0},{expiryDays:181},{expiryDays:1.2},{signer:{...input.signer,email:'PRIVATE-not-email'}},
  {title:'PRIVATE\nheader'},{message:'PRIVATE\0content'},{routing:{...input.routing,fields:[]}},{routing:{...input.routing,fields:[first,first]}},{routing:{...input.routing,fields:[{...first,isRequired:false}]}},{routing:{...input.routing,fields:[{...first,pageNumber:0}]}},{routing:{...input.routing,fields:[{...first,bounds:{...first.bounds,width:0}}]}}]) {
  try{buildBoldSignSendRequest({...input,...patch},pdf);assert.fail('must reject');}catch(error){assert.equal((error as {code:string}).code,invalid.code);assert.ok(!String(error).includes('PRIVATE'));}
 }
 for(const days of [1,180])assert.equal(JSON.parse(buildBoldSignSendRequest({...input,expiryDays:days},pdf).body).ExpiryValue,days);
});
test('declared ten-MiB PDF and hundred-field boundary produces one bounded body without per-field network or processing jobs',()=>{
 const bytes=Buffer.alloc(10_485_760,32);pdf.copy(bytes);const first=input.routing.fields[0],fields=Array.from({length:100},(_,n)=>({...first,id:'Signature_'+n})),start=performance.now();
 const result=buildBoldSignSendRequest({...input,document:{sha256:hash(bytes),sizeBytes:bytes.length},routing:{...input.routing,fields}},bytes),body=JSON.parse(result.body);
 assert.equal(Buffer.from(body.Files[0].split(',')[1],'base64').length,bytes.length);assert.equal(body.Signers[0].FormFields.length,100);assert.ok(result.receipt.requestBytes<16_777_216);
 assert.throws(()=>buildBoldSignSendRequest({...input,routing:{...input.routing,fields:[...fields,{...first,id:'TooMany'}]}},pdf),invalid);
 console.log(JSON.stringify({case:'declared-binary-request-boundary',pdfBytes:bytes.length,fields:fields.length,requestBytes:result.receipt.requestBytes,elapsedMs:Math.round(performance.now()-start)}));
});
