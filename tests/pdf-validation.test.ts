import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash,webcrypto } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { pdfValidationSchema,pdfValidationMatches,validateUnsignedPdf } from '../src/files/pdf-validation.ts';

const pythonPath=process.env.TEST_PDF_PYTHON_BINARY,peerPath=fileURLToPath(new URL('./fixtures/pdf-python-peer.sh',import.meta.url));
if(process.env.PDF_VALIDATION_TEST_REQUIRED==='true'&&!pythonPath)throw new Error('PDF_TEST_INTERPRETER_REQUIRED');
const hash=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
let fixture:Record<string,Buffer>|undefined;
function vectors(){
 if(fixture)return fixture;
 assert.ok(pythonPath,'explicit test interpreter is required');
 const result=spawnSync(pythonPath,['-I','-B',fileURLToPath(new URL('./fixtures/pdf-fixtures.py',import.meta.url))],{env:{NODE_ENV:'test',TZ:'UTC'},encoding:'utf8',timeout:10000,maxBuffer:2_097_152});
 assert.equal(result.status,0,result.stderr);const raw=JSON.parse(result.stdout) as Record<string,string>;fixture=Object.fromEntries(Object.entries(raw).map(([key,value])=>[key,Buffer.from(value,'base64')]));return fixture;
}
const check=(name:string,run:()=>Promise<void>)=>test(name,{skip:!pythonPath},run);
const unavailable={code:'PDF_VALIDATION_UNAVAILABLE',status:503};
check('actual pinned native parser screens static,compressed,linearized,cyclic and ordinary-link PDFs without returning text or changing bytes',async()=>{
 for(const name of ['ordinary','object_streams','linearized','cycle','https_link','internal_opening']){
  const bytes=vectors()[name],before=Buffer.from(bytes),result=await validateUnsignedPdf(bytes,{pythonPath:pythonPath!});
  assert.equal(result.outcome,'screened',name);assert.equal(result.validator,'pikepdf@10.17.0');assert.equal(result.qpdf,'12.4.2');assert.equal(result.inputBytes,bytes.length);assert.equal(result.inputSha256,Buffer.from(await webcrypto.subtle.digest('SHA-256',bytes)).toString('hex'));assert.deepEqual(bytes,before);
  if(result.outcome==='screened'){assert.equal(result.pageCount,1);assert.deepEqual(result.pages[0],{mediaBox:[0,0,612,792],cropBox:[0,0,612,792],rotation:0,userUnit:1});assert.equal(result.coordinateSpace,'pdf-default-user-space');}
  assert.ok(result.resources.peakRssKiB>0);assert.ok(!JSON.stringify(result).includes('PRIVATE'));
  for(const key of ['safeToServe','malwareCleared','signatureVerified','legallyEffective','text','filePath','pid','downloadUrl'])assert.equal(key in result,false);
 }
});
check('native PDF geometry preserves crop,rotation and user units without assuming provider pixels or flattening legitimate form values',async()=>{
 for(const name of ['rotated','scaled','interactive']){
  const bytes=vectors()[name],before=hash(bytes),result=await validateUnsignedPdf(bytes,{pythonPath:pythonPath!});assert.equal(result.outcome,'screened',name);assert.equal(hash(bytes),before);
  if(result.outcome==='screened'){
   if(name==='rotated'){assert.equal(result.pages[0].rotation,270);assert.deepEqual(result.pages[0].cropBox,[10,20,600,780]);}
   if(name==='scaled')assert.equal(result.pages[0].userUnit,2);
   assert.equal(result.interactiveForms,name==='interactive');
  }
 }
});
check('actual parser rejects active features,encryption,external streams and existing signature objects instead of silently sanitizing them',async()=>{
 const cases:Record<string,string>={javascript:'ACTIVE_CONTENT',nested_javascript:'ACTIVE_CONTENT',hex_name_javascript:'ACTIVE_CONTENT',launch:'ACTIVE_CONTENT',form_submit:'ACTIVE_CONTENT',javascript_link:'ACTIVE_CONTENT',encoded_control_link:'ACTIVE_CONTENT',credential_link:'ACTIVE_CONTENT',chained_link:'ACTIVE_CONTENT',automatic_link:'ACTIVE_CONTENT',xfa:'XFA_FORM',embedded:'EMBEDDED_FILE',claimed_provenance:'EMBEDDED_FILE',multimedia:'EMBEDDED_FILE',external_stream:'EXTERNAL_STREAM',existing_signature:'EXISTING_SIGNATURE',encrypted:'ENCRYPTED',owner_encrypted:'ENCRYPTED'};
 for(const [name,reason]of Object.entries(cases)){
  const bytes=vectors()[name],before=Buffer.from(bytes),result=await validateUnsignedPdf(bytes,{pythonPath:pythonPath!});assert.equal(result.outcome,'rejected',name);if(result.outcome==='rejected')assert.equal(result.reason,reason,name);assert.equal(result.inputSha256,hash(bytes));assert.deepEqual(bytes,before);assert.ok(!JSON.stringify(result).includes('PRIVATE'));
 }
});
check('actual structural,geometry,page and work budgets reject malformed sources and recover for the next request',async()=>{
 for(const [name,reason]of [['truncated','MALFORMED_PDF'],['bad_box','GEOMETRY_INVALID'],['string_box','MALFORMED_PDF'],['bad_rotation','GEOMETRY_INVALID'],['oversize_geometry','GEOMETRY_INVALID'],['page_limit','PAGE_LIMIT'],['work_limit','STRUCTURE_LIMIT'],['depth_limit','STRUCTURE_LIMIT']]){
  const result=await validateUnsignedPdf(vectors()[name],{pythonPath:pythonPath!});assert.equal(result.outcome,'rejected',name);if(result.outcome==='rejected')assert.equal(result.reason,reason,name);
 }
 for(const name of ['missing_box','zero_unit'])assert.equal((await validateUnsignedPdf(vectors()[name],{pythonPath:pythonPath!})).outcome,'rejected',name);
 assert.equal((await validateUnsignedPdf(vectors().ordinary,{pythonPath:pythonPath!})).outcome,'screened');
});
test('PDF adapter refuses arbitrary input/configuration,unbounded bytes and pre-cancelled work before subprocess execution',async()=>{
 const bytes=Buffer.from('%PDF-1.7\nsynthetic transport input');
 for(const options of [{pythonPath:'https://localhost'},{pythonPath:'relative'},{pythonPath:'/tmp/../binary'},{pythonPath:'/tmp/./binary'},{pythonPath:'/bad\0path'},{pythonPath:'/usr/bin/python3',command:'PRIVATE'},{pythonPath:'/usr/bin/python3',timeoutMs:0}])await assert.rejects(validateUnsignedPdf(bytes,options),{code:'INVALID_PDF_VALIDATION_CONFIGURATION',status:400});
 for(const value of [null,{},'file:///PRIVATE',Buffer.alloc(0),Buffer.alloc(10_485_761),Buffer.from('not a PDF'),Buffer.from('%PDF-9.9\ninvalid')])await assert.rejects(validateUnsignedPdf(value as Uint8Array,{pythonPath:'/tmp/does-not-exist'}),{code:'INVALID_PDF_VALIDATION_BYTES',status:400});
 const controller=new AbortController();controller.abort();await assert.rejects(validateUnsignedPdf(bytes,{pythonPath:'/tmp/does-not-exist',signal:controller.signal}),{code:'PDF_VALIDATION_CANCELLED',status:503});
 await assert.rejects(validateUnsignedPdf(bytes,{pythonPath:'/tmp/ko-missing-pdf-python'}),unavailable);
});
test('synthetic process peer malformed,duplicate,non-UTF8 and oversized output cannot become parser evidence',{timeout:5000},async()=>{
 const control=spawnSync(peerPath,[],{input:'%PDF-1.7\n%bad\n',encoding:'utf8',timeout:1000});assert.equal(control.status,0);assert.equal(control.stdout,'{}');
 for(const mode of ['bad','badutf8','duplicate','flood'])await assert.rejects(validateUnsignedPdf(Buffer.from('%PDF-1.7\n%'+mode+'\n'),{pythonPath:peerPath}),unavailable);
});
check('selected byte copy excludes backing data and remains bound to the native receipt after caller mutation',async()=>{
 const original=vectors().ordinary,backing=Buffer.concat([original,Buffer.from('PRIVATE backing bytes')]),selected=backing.subarray(0,original.length),pending=validateUnsignedPdf(selected,{pythonPath:pythonPath!});selected.fill(0);
 const result=await pending;assert.equal(result.outcome,'screened');assert.equal(result.inputBytes,original.length);assert.equal(result.inputSha256,hash(original));
 assert.equal(pdfValidationMatches(result,result.inputBytes,result.inputSha256),true);assert.equal(pdfValidationMatches(result,result.inputBytes+1,result.inputSha256),false);assert.equal(pdfValidationMatches(result,result.inputBytes,'0'.repeat(64)),false);
 for(const changed of [{...result,safeToServe:true},{...result,qpdf:'unreviewed'},{...result,inputSha256:'bad'},{...result,maximumObjects:50001},{...result,resources:{...result.resources,PRIVATE:'data'}}])assert.equal(pdfValidationSchema.safeParse(changed).success,false);
});
check('two-child admission rejects a third concurrent call and recovers after real native children finish',async()=>{
 const bytes=vectors().ordinary,first=validateUnsignedPdf(bytes,{pythonPath:pythonPath!}),second=validateUnsignedPdf(bytes,{pythonPath:pythonPath!});
 await assert.rejects(validateUnsignedPdf(bytes,{pythonPath:pythonPath!}),{code:'PDF_VALIDATOR_BUSY',status:503});assert.equal((await first).outcome,'screened');assert.equal((await second).outcome,'screened');assert.equal((await validateUnsignedPdf(bytes,{pythonPath:pythonPath!})).outcome,'screened');
});
check('active cancellation is only resolved after the native child closes and frees its slot',async()=>{
 const bytes=vectors().ordinary,controller=new AbortController(),pending=validateUnsignedPdf(bytes,{pythonPath:pythonPath!,signal:controller.signal});controller.abort();await assert.rejects(pending,{code:'PDF_VALIDATION_CANCELLED',status:503});assert.equal((await validateUnsignedPdf(bytes,{pythonPath:pythonPath!})).outcome,'screened');
});
test('fixed ten-second process deadline kills and reaps a real subprocess without a ten-second test delay',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});const pending=validateUnsignedPdf(Buffer.from('%PDF-1.7\n%stall\n'),{pythonPath:peerPath});t.mock.timers.tick(10000);await assert.rejects(pending,{code:'PDF_VALIDATION_TIMEOUT',status:503});
});
