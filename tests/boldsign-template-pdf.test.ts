import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { test } from 'node:test';
import { getBoldSignTemplatePdf,getBoldSignDocumentPdf,getBoldSignAuditPdf,type BoldSignConnection } from '../src/integrations/boldsign.ts';

const config:BoldSignConnection={region:'CA',apiKey:'synthetic-template-pdf-key'},id='e2af3028-2ec3-4f13-8c47-eafdfc51b1e4';
// A header fixture deliberately is not represented as a parsed/safe legal PDF.
const bytes=Buffer.from('%PDF-1.7\nsynthetic binary evidence\x00\xff\n%%EOF\n','latin1');
const unavailable={code:'BOLDSIGN_TEMPLATE_PDF_UNAVAILABLE',status:502};
const pdf=(value:BodyInit=bytes)=>new Response(value,{headers:{'content-type':'application/pdf'}});

test('template PDF captures exact bytes and independent Web Crypto digest from fixed regional read-only URLs',async()=>{
 for(const [region,host] of [['US','api.boldsign.com'],['CA','api-ca.boldsign.com'],['EU','api-eu.boldsign.com'],['AU','api-au.boldsign.com']] as const) {
  let calls=0;
  const result=await getBoldSignTemplatePdf({...config,region},id.toUpperCase(),async(url,options)=>{
   calls++;assert.equal(String(url),`https://${host}/v1/template/download?templateId=${id}&includeFormFieldValues=true`);
   assert.equal(options?.method,'GET');assert.equal(options?.body,undefined);assert.equal(options?.redirect,'error');assert.equal(options?.credentials,'omit');assert.equal(options?.cache,'no-store');
   const headers=new Headers(options?.headers);assert.equal(headers.get('X-API-KEY'),config.apiKey);assert.equal(headers.get('accept'),'application/pdf');assert.equal(headers.get('cookie'),null);
   return new Response(new ReadableStream({start(c){c.enqueue(bytes.subarray(0,3));c.enqueue(bytes.subarray(3));c.close();}}),{headers:{'content-type':'Application/PDF; charset=binary'}});
  });
  assert.equal(calls,1);assert.deepEqual(result.bytes,bytes);assert.equal(result.sizeBytes,bytes.length);assert.equal(result.templateId,id);
  assert.equal(result.sha256,Buffer.from(await webcrypto.subtle.digest('SHA-256',bytes)).toString('hex'));
  assert.deepEqual(Object.keys(result).sort(),['bytes','sha256','sizeBytes','templateId']);
 }
 const changed=await getBoldSignTemplatePdf(config,id,async()=>pdf(Buffer.concat([bytes,Buffer.from(' ')])));
 const original=await getBoldSignTemplatePdf(config,id,async()=>pdf());assert.notEqual(changed.sha256,original.sha256);
});
test('template PDF rejects bad configuration and identifier before sending credentials',async()=>{
 let calls=0;const send:typeof fetch=async()=>{calls++;return pdf();};
 for(const bad of ['',id+'&onBehalfOf=other@example.test','../download','https://localhost'])await assert.rejects(getBoldSignTemplatePdf(config,bad,send),{code:'INVALID_BOLDSIGN_TEMPLATE_ID',status:400});
 for(const bad of [{...config,region:'https://localhost'},{...config,apiKey:'bad\r\nkey'},{...config,baseUrl:'https://localhost'}])await assert.rejects(getBoldSignTemplatePdf(bad as BoldSignConnection,id,send),{code:'BOLDSIGN_CONNECTION_NOT_CONFIGURED',status:503});
 assert.equal(calls,0);
});
test('template PDF rejects partial responses, redirects, wrong MIME, errors and spoofed headers without leaking provider content',async()=>{
 let cancelled=0;
 for(const [status,type] of [[206,'application/pdf'],[302,'application/pdf'],[401,'application/pdf'],[429,'application/json'],[200,'text/html'],[200,'application/octet-stream']] as const) {
  const response=new Response(new ReadableStream({start(c){c.enqueue(Buffer.from(config.apiKey));},cancel(){cancelled++;return new Promise(()=>{});}}),{status,headers:{'content-type':type}});
  await assert.rejects(getBoldSignTemplatePdf(config,id,async()=>response),unavailable);
 }
 assert.equal(cancelled,6);
 const spoof=Buffer.from('%PDF-1.7\n','latin1');spoof[0]|=128;
 for(const value of [Buffer.alloc(0),Buffer.from('not pdf'),Buffer.from('%PDF-9.9\n'),spoof])await assert.rejects(getBoldSignTemplatePdf(config,id,async()=>pdf(value)),unavailable);
 for(const header of ['%PDF-1.0\n','%PDF-1.7\r\n','%PDF-2.0\n'])assert.equal((await getBoldSignTemplatePdf(config,id,async()=>pdf(header))).sizeBytes,Buffer.byteLength(header));
 try{await getBoldSignTemplatePdf(config,id,async()=>{throw new Error(config.apiKey);});assert.fail('must reject');}catch(error){assert.equal((error as {code:string}).code,unavailable.code);assert.ok(!String(error).includes(config.apiKey));}
});
test('template PDF actual ten-MiB ceiling ignores forged length and cancels excess without retaining a result',async()=>{
 const limit=10_485_760,boundary=Buffer.alloc(limit,32);bytes.copy(boundary);
 assert.equal((await getBoldSignTemplatePdf(config,id,async()=>pdf(boundary))).sizeBytes,limit);
 let cancelled=false;
 const response=new Response(new ReadableStream({start(c){c.enqueue(boundary);c.enqueue(Buffer.from('x'));},cancel(){cancelled=true;}}),{headers:{'content-type':'application/pdf','content-length':'1'}});
 await assert.rejects(getBoldSignTemplatePdf(config,id,async()=>response),unavailable);assert.equal(cancelled,true);
});
test('template PDF cancels stalled reads and late responses without waiting for uncooperative providers',{timeout:3000},async()=>{
 const pre=new AbortController();pre.abort();let calls=0;
 await assert.rejects(getBoldSignTemplatePdf(config,id,async()=>{calls++;return pdf();},pre.signal),unavailable);assert.equal(calls,0);
 const controller=new AbortController();let resolve!:(response:Response)=>void,cancelled=false;
 const pending=getBoldSignTemplatePdf(config,id,()=>new Promise<Response>(yes=>{resolve=yes;}),controller.signal);
 controller.abort();await assert.rejects(pending,unavailable);
 resolve(new Response(new ReadableStream({cancel(){cancelled=true;}}),{headers:{'content-type':'application/pdf'}}));
 await new Promise<void>(yes=>setImmediate(yes));assert.equal(cancelled,true);
 const stalled=new AbortController();let read=false,disposed=false;
 const reading=getBoldSignTemplatePdf(config,id,async()=>new Response(new ReadableStream({pull(){read=true;return new Promise(()=>{});},cancel(){disposed=true;return new Promise(()=>{});}}),{headers:{'content-type':'application/pdf'}}),stalled.signal);
 await new Promise<void>(yes=>setImmediate(yes));assert.equal(read,true);stalled.abort();await assert.rejects(reading,unavailable);assert.equal(disposed,true);
});

test('agreement and audit PDF downloads stay distinct, fixed-region, exact-byte read-only evidence',async()=>{
 for(const [download,artifactKind,path] of [[getBoldSignDocumentPdf,'document','download'],[getBoldSignAuditPdf,'audit','downloadAuditLog']] as const)
 for(const [region,host] of [['US','api.boldsign.com'],['CA','api-ca.boldsign.com'],['EU','api-eu.boldsign.com'],['AU','api-au.boldsign.com']] as const) {
  let calls=0;
  const result=await download({...config,region},id.toUpperCase(),async(url,options)=>{
   calls++;assert.equal(String(url),`https://${host}/v1/document/${path}?documentId=${id}`+(artifactKind==='document'?'&format=Combined':''));
   assert.equal(options?.method,'GET');assert.equal(options?.body,undefined);assert.equal(options?.redirect,'error');assert.equal(options?.cache,'no-store');assert.equal(options?.credentials,'omit');
   const h=new Headers(options?.headers);assert.equal(h.get('accept'),'application/pdf');assert.equal(h.get('X-API-KEY'),config.apiKey);assert.equal(h.get('cookie'),null);
   return pdf();
  });
  assert.equal(calls,1);assert.equal(result.artifactKind,artifactKind);assert.equal(result.documentId,id);assert.deepEqual(result.bytes,bytes);assert.equal(result.sizeBytes,bytes.length);
  assert.equal(result.sha256,Buffer.from(await webcrypto.subtle.digest('SHA-256',bytes)).toString('hex'));
  assert.deepEqual(Object.keys(result).sort(),['artifactKind','bytes','documentId','sha256','sizeBytes']);
 }
});
test('all PDF artifacts enforce validation, bounded bytes, sanitized failures and caller cancellation',{timeout:3000},async()=>{
 for(const [download,kind] of [[getBoldSignTemplatePdf,'TEMPLATE'],[getBoldSignDocumentPdf,'DOCUMENT'],[getBoldSignAuditPdf,'AUDIT']] as const) {
  const error={code:`BOLDSIGN_${kind}_PDF_UNAVAILABLE`,status:502};let calls=0;
  const send:typeof fetch=async()=>{calls++;return pdf();};
  await assert.rejects(download(config,null as unknown as string,send),{code:`INVALID_BOLDSIGN_${kind==='TEMPLATE'?'TEMPLATE':'DOCUMENT'}_ID`,status:400});
  await assert.rejects(download({...config,region:'http://localhost'} as unknown as BoldSignConnection,id,send),{code:'BOLDSIGN_CONNECTION_NOT_CONFIGURED',status:503});assert.equal(calls,0);
  for(const response of [new Response(bytes,{status:206,headers:{'content-type':'application/pdf'}}),new Response(bytes,{headers:{'content-type':'text/html'}}),pdf('not pdf')])await assert.rejects(download(config,id,async()=>response),error);
  let cancelled=false;const huge=new Response(new ReadableStream({start(c){c.enqueue(Buffer.alloc(10_485_761));},cancel(){cancelled=true;}}),{headers:{'content-type':'application/pdf','content-length':'1'}});
  await assert.rejects(download(config,id,async()=>huge),error);assert.equal(cancelled,true);
  const abort=new AbortController();let resolve!:(response:Response)=>void,disposed=false;
  const pending=download(config,id,()=>new Promise<Response>(yes=>{resolve=yes;}),abort.signal);abort.abort();await assert.rejects(pending,error);
  resolve(new Response(new ReadableStream({cancel(){disposed=true;}}),{headers:{'content-type':'application/pdf'}}));await new Promise<void>(yes=>setImmediate(yes));assert.equal(disposed,true);
 }
});
