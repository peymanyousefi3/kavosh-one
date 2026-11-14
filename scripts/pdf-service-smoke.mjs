import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { assertIsolatedPdfRuntime,assertPrivatePdfSocket,pdfServiceSocket,pdfServicePython } from '../src/files/pdf-runtime.js';
import { validatePdfViaService,validateSignedEvidencePdfViaService } from '../src/files/pdf-service.js';

// In-memory trusted fixture generation,not an authored user document. No input
// PDF is saved,rewritten,flattened or mounted into this isolated service.
await assertIsolatedPdfRuntime();
const generated=spawnSync(pdfServicePython,['-I','-B','-c',`import base64,io,json,pikepdf
result={}
for name in ['ordinary','active','embedded','signed_layout']:
 with pikepdf.Pdf.new() as p:
  p.add_blank_page(page_size=(612,792))
  if name=='active':p.Root.OpenAction=pikepdf.Dictionary(S=pikepdf.Name.JavaScript,JS=pikepdf.String('private'))
  if name=='embedded':p.attachments['private.txt']=b'private'
  if name=='signed_layout':p.Root.SignatureTest=p.make_indirect(pikepdf.Dictionary(Type=pikepdf.Name.Sig,ByteRange=pikepdf.Array([0,1111111111,2222222222,3333333333]),Contents=pikepdf.String(bytes([48,130,0,4,0,0]))))
  out=io.BytesIO();p.save(out);data=out.getvalue()
  if name=='signed_layout':
   gap=data.index(b'<308200040000>');old=b'[ 0 1111111111 2222222222 3333333333 ]';replacement=('[ 0 %10d %10d %10d ]'%(gap,gap+14,len(data)-gap-14)).encode('ascii');assert len(old)==len(replacement) and old in data;data=data.replace(old,replacement,1)
  result[name]=base64.b64encode(data).decode('ascii')
print(json.dumps(result))`],{env:{NODE_ENV:'test',TZ:'UTC'},encoding:'utf8',timeout:10000,maxBuffer:65536});
assert.equal(generated.status,0);const vectors=JSON.parse(generated.stdout),bytes=Buffer.from(vectors.ordinary,'base64');
const validate=b=>validatePdfViaService(b,{socketPath:pdfServiceSocket});
const validateSigned=b=>validateSignedEvidencePdfViaService(b,{socketPath:pdfServiceSocket});
let ready=false;for(let i=0;i<100;i++){try{assert.equal((await validate(bytes)).outcome,'screened');ready=true;break;}catch{await delay(100);}}
assert.ok(ready,'Private PDF service failed to become ready');await assertPrivatePdfSocket(pdfServiceSocket);
const result=await validate(bytes);assert.equal(result.inputSha256,createHash('sha256').update(bytes).digest('hex'));assert.equal(result.validator,'pikepdf@10.17.0');assert.equal(result.qpdf,'12.4.2');assert.equal(result.pageCount,1);assert.equal('safeToServe' in result,false);
for(const [name,reason]of [['active','ACTIVE_CONTENT'],['embedded','EMBEDDED_FILE']]){const r=await validate(Buffer.from(vectors[name],'base64'));assert.equal(r.outcome,'rejected');assert.equal(r.reason,reason);}
// A syntactically bounded placeholder,NOT a valid CMS signature/certificate.
const signedBytes=Buffer.from(vectors.signed_layout,'base64'),signed=await validateSigned(signedBytes);assert.equal(signed.outcome,'screened');assert.equal(signed.policyVersion,2);assert.equal(signed.profile,'signed-evidence');assert.equal(signed.signatureCount,1);assert.equal(signed.cryptographicValidityVerified,false);assert.equal(signed.signatures[0].coversWholeFile,true);assert.equal(signed.inputSha256,createHash('sha256').update(signedBytes).digest('hex'));assert.equal((await validate(signedBytes)).reason,'EXISTING_SIGNATURE');
await assert.rejects(writeFile('/app/pdf-service-read-only-probe','no'),e=>['EROFS','EACCES'].includes(e.code));
const outcomes=await Promise.allSettled([validateSigned(signedBytes),validate(bytes),validate(bytes)]);assert.equal(outcomes.filter(r=>r.status==='fulfilled').length,2);assert.equal(outcomes.filter(r=>r.status==='rejected').length,1);assert.equal((await validate(bytes)).outcome,'screened');
console.log(JSON.stringify({measurement:'actual-isolated-pdf-container',uid:process.getuid(),parser:result.validator,qpdf:result.qpdf,signedEvidenceProfile:2,cryptographicValidityVerified:false,requests:3,admitted:2,busy:1,peakRssKiB:result.resources.peakRssKiB,liveStorageCalls:0,liveProviderCalls:0}));
