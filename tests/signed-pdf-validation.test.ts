import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { validateUnsignedPdf,validateSignedEvidencePdf,pdfValidationSchema,signedEvidencePdfValidationSchema } from '../src/files/pdf-validation.ts';

const pythonPath=process.env.TEST_PDF_PYTHON_BINARY;
if(process.env.PDF_VALIDATION_TEST_REQUIRED==='true'&&!pythonPath)throw Error('PDF_TEST_INTERPRETER_REQUIRED');
const check=(name:string,run:()=>Promise<void>)=>test(name,{skip:!pythonPath},run),hash=(b:Buffer)=>createHash('sha256').update(b).digest('hex');let fixtures:Record<string,Buffer>|undefined;
function vectors(){if(!fixtures){const r=spawnSync(pythonPath!,['-I','-B',fileURLToPath(new URL('./fixtures/pdf-fixtures.py',import.meta.url))],{env:{NODE_ENV:'test',TZ:'UTC'},encoding:'utf8',timeout:10000,maxBuffer:2097152});assert.equal(r.status,0,r.stderr);fixtures=Object.fromEntries(Object.entries(JSON.parse(r.stdout) as Record<string,string>).map(([k,v])=>[k,Buffer.from(v,'base64')]));}return fixtures;}
check('signed-evidence structural profile preserves exact archive bytes and reports layout without inventing cryptographic or legal verification',async()=>{
 for(const name of ['ordinary','interactive','signature_layout','signature_later_bytes']){
  const bytes=vectors()[name],before=Buffer.from(bytes),r=await validateSignedEvidencePdf(bytes,{pythonPath:pythonPath!});assert.equal(r.outcome,'screened',name);assert.equal(r.policyVersion,2);assert.equal(r.profile,'signed-evidence');assert.equal(r.cryptographicValidityVerified,false);assert.equal(r.inputSha256,hash(bytes));assert.equal(r.inputBytes,bytes.length);assert.deepEqual(bytes,before);
  if(r.outcome==='screened'){assert.equal(r.signatureCount,name.startsWith('signature_')?1:0);if(r.signatureCount){assert.equal(r.signatures[0].coversWholeFile,name==='signature_layout');assert.equal(r.signatures[0].contentsBytes,6);}}
  assert.doesNotMatch(JSON.stringify(r),/PRIVATE|certificateSubject|signerName|legalValidityCertified|safeToServe|downloadUrl/);
 }
 // The placeholder deliberately has NO valid CMS signature/certificate.
 // Passing STRUCTURE must never be represented as successful signature proof.
 const r=await validateSignedEvidencePdf(vectors().signature_layout,{pythonPath:pythonPath!});assert.equal(r.cryptographicValidityVerified,false);
});
check('signed archive parsing rejects invalid byte ranges and the original active-content encryption and attachment hazards',async()=>{
 const cases:Record<string,string>={signature_wrong_start:'SIGNATURE_LAYOUT_INVALID',signature_overlap:'SIGNATURE_LAYOUT_INVALID',signature_overflow:'SIGNATURE_LAYOUT_INVALID',signature_wrong_gap:'SIGNATURE_LAYOUT_INVALID',existing_signature:'SIGNATURE_LAYOUT_INVALID',signature_javascript:'ACTIVE_CONTENT',signature_limit:'SIGNATURE_LIMIT',javascript:'ACTIVE_CONTENT',embedded:'EMBEDDED_FILE',external_stream:'EXTERNAL_STREAM',xfa:'XFA_FORM',encrypted:'ENCRYPTED'};
 for(const [name,reason] of Object.entries(cases)){const bytes=vectors()[name],r=await validateSignedEvidencePdf(bytes,{pythonPath:pythonPath!});assert.equal(r.outcome,'rejected',name);if(r.outcome==='rejected')assert.equal(r.reason,reason,name);assert.equal(r.cryptographicValidityVerified,false);assert.equal(r.inputSha256,hash(bytes));assert.doesNotMatch(JSON.stringify(r),/PRIVATE/);}
});
check('unsigned upload and signed evidence profiles cannot be interchanged or forged into signature clearance',async()=>{
 const bytes=vectors().signature_layout,unsigned=await validateUnsignedPdf(bytes,{pythonPath:pythonPath!}),signed=await validateSignedEvidencePdf(bytes,{pythonPath:pythonPath!});assert.equal(unsigned.outcome,'rejected');if(unsigned.outcome==='rejected')assert.equal(unsigned.reason,'EXISTING_SIGNATURE');assert.equal(pdfValidationSchema.safeParse(signed).success,false);assert.equal(signedEvidencePdfValidationSchema.safeParse(unsigned).success,false);
 for(const changed of [{...signed,cryptographicValidityVerified:true},{...signed,policyVersion:1},{...signed,admissionCleared:true},{...signed,signatureCount:100},{...signed,signatures:[]}])assert.equal(signedEvidencePdfValidationSchema.safeParse(changed).success,false);
});
check('signed and unsigned native jobs share the same two-child bound and selected input copies survive caller mutation',async()=>{
 const bytes=vectors().signature_layout,selected=Buffer.from(bytes),first=validateSignedEvidencePdf(selected,{pythonPath:pythonPath!}),second=validateUnsignedPdf(vectors().ordinary,{pythonPath:pythonPath!});selected.fill(0);await assert.rejects(validateSignedEvidencePdf(bytes,{pythonPath:pythonPath!}),{code:'PDF_VALIDATOR_BUSY'});assert.equal((await first).inputSha256,hash(bytes));assert.equal((await second).outcome,'screened');assert.equal((await validateSignedEvidencePdf(bytes,{pythonPath:pythonPath!})).outcome,'screened');
});
test('signed-evidence configuration cannot choose arbitrary flags profiles paths or pre-cancelled subprocesses',async()=>{
 const bytes=Buffer.from('%PDF-1.7\nsynthetic');await assert.rejects(validateSignedEvidencePdf(bytes,{pythonPath:'/missing/python',profile:'unsigned'} as {pythonPath:string}),{code:'INVALID_PDF_VALIDATION_CONFIGURATION'});await assert.rejects(validateSignedEvidencePdf(bytes,{pythonPath:'/missing/python',signal:AbortSignal.abort()}),{code:'PDF_VALIDATION_CANCELLED'});await assert.rejects(validateSignedEvidencePdf(Buffer.alloc(10485761),{pythonPath:'/missing/python'}),{code:'INVALID_PDF_VALIDATION_BYTES'});
});
