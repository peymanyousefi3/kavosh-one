import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getBoldSignTemplate,getBoldSignDocument,type BoldSignConnection } from '../src/integrations/boldsign.ts';

const config:BoldSignConnection={region:'CA',apiKey:'synthetic-template-secret'},id='e2af3028-2ec3-4f13-8c47-eafdfc51b1e4';
const data={templateId:id,title:'Unified enrollment',roles:[{name:'Legal signer',index:1,signerType:'Signer',formFields:[{id:'Signature1',fieldType:'signature',isRequired:true,isReadOnly:false}]}]};
const unavailable={code:'BOLDSIGN_TEMPLATE_UNAVAILABLE',status:502};
test('template read selects only fixed regional GET endpoints and strips contacts, defaults and field values',async()=>{
 for(const [region,host] of [['US','api.boldsign.com'],['CA','api-ca.boldsign.com'],['EU','api-eu.boldsign.com'],['AU','api-au.boldsign.com']] as const) {
  let calls=0;
  const result=await getBoldSignTemplate({...config,region},id.toUpperCase(),async(url,options)=>{
   calls++;assert.equal(String(url),'https://'+host+'/v1/template/properties?templateId='+id);assert.equal(options?.method,'GET');assert.equal(options?.redirect,'error');assert.equal(options?.cache,'no-store');assert.equal(options?.credentials,'omit');assert.equal(options?.body,undefined);
   const h=new Headers(options?.headers);assert.equal(h.get('X-API-KEY'),config.apiKey);assert.equal(h.get('cookie'),null);assert.equal(h.get('authorization'),null);
   return Response.json({...data,createdBy:{emailAddress:'PRIVATE@example.test'},roles:[{...data.roles[0],defaultSignerEmail:'PRIVATE@example.test',formFields:[{...data.roles[0].formFields[0],value:'PRIVATE value'}]}]});
  });
  assert.equal(calls,1);assert.deepEqual(result,data);assert.ok(!JSON.stringify(result).includes('PRIVATE'));for(const key of ['contentHash','version','signed','admissionCleared'])assert.equal(key in result,false);
 }
});
test('template configuration and identifier validation reject URL injection before network access',async()=>{
 let calls=0;const send:typeof fetch=async()=>{calls++;return Response.json(data);};
 for(const value of ['',id+'&other=x','https://localhost','../template',' '+id])await assert.rejects(getBoldSignTemplate(config,value,send),{code:'INVALID_BOLDSIGN_TEMPLATE_ID',status:400});
 for(const bad of [{...config,region:'https://localhost'},{...config,apiKey:'bad\nkey'},{...config,baseUrl:'https://localhost'}])await assert.rejects(getBoldSignTemplate(bad as BoldSignConnection,id,send),{code:'BOLDSIGN_CONNECTION_NOT_CONFIGURED',status:503});
 assert.equal(calls,0);
});
test('template evidence rejects wrong resource, ambiguous roles/fields, missing fields and type/size forgery',async()=>{
 const role=data.roles[0],field=role.formFields[0];
 for(const bad of [{...data,templateId:'f631b2a0-a664-41ca-9f64-c65f00ea08b1'},{...data,roles:undefined},{...data,title:'x'.repeat(1001)},
  {...data,roles:[role,role]},{...data,roles:[{...role,index:-1}]},{...data,roles:[{...role,index:1.2}]},{...data,roles:[{...role,formFields:[field,field]}]},
  {...data,roles:[{...role,formFields:[{...field,isRequired:'true'}]}]},{...data,roles:Array(101).fill(role)}])await assert.rejects(getBoldSignTemplate(config,id,async()=>Response.json(bad)),unavailable);
 const unknown={...data,roles:[{...role,signerType:'FutureProviderType',formFields:[{...field,fieldType:'FutureProviderField'}]}]};
 assert.deepEqual(await getBoldSignTemplate(config,id,async()=>Response.json(unknown)),unknown,'unknown types stay evidence, never an inferred signing approval');
});
test('template reads enforce actual response bytes and cancel errors without waiting on an uncooperative cancel hook',{timeout:3000},async()=>{
 let cancelled=0;
 for(const [status,type] of [[401,'application/json'],[429,'application/json'],[200,'text/html']] as const) {
  const response=new Response(new ReadableStream({pull(c){c.enqueue(Buffer.from(config.apiKey));},cancel(){cancelled++;return new Promise(()=>{});}}),{status,headers:{'content-type':type}});
  await assert.rejects(getBoldSignTemplate(config,id,async()=>response),unavailable);
 }
 assert.equal(cancelled,3);
 const bytes=Buffer.from(JSON.stringify(data)),limit=1_048_576,boundary=Buffer.concat([bytes,Buffer.alloc(limit-bytes.length,32)]);
 assert.deepEqual(await getBoldSignTemplate(config,id,async()=>new Response(boundary,{headers:{'content-type':'application/json'}})),data);
 const response=new Response(new ReadableStream({start(c){c.enqueue(boundary);c.enqueue(Buffer.from(' '));},cancel(){cancelled++;}}),{headers:{'content-type':'application/json','content-length':'1'}});
 await assert.rejects(getBoldSignTemplate(config,id,async()=>response),unavailable);assert.equal(cancelled,4);
});
test('template read rejects malformed UTF-8/JSON and sanitizes provider failure content',async()=>{
 for(const value of [Buffer.from([0xff]),'not json','{"templateId":'])await assert.rejects(getBoldSignTemplate(config,id,async()=>new Response(value,{headers:{'content-type':'application/json'}})),unavailable);
 try{await getBoldSignTemplate(config,id,async()=>{throw new Error(config.apiKey);});assert.fail('must reject');}catch(error){assert.equal((error as {code:string}).code,unavailable.code);assert.ok(!String(error).includes(config.apiKey));}
});
test('read-only provider calls cancel before networking and a late response is disposed of after caller cancellation',{timeout:3000},async()=>{
 const aborted=new AbortController();aborted.abort();let calls=0;
 await assert.rejects(getBoldSignTemplate(config,id,async()=>{calls++;return Response.json(data);},aborted.signal),unavailable);assert.equal(calls,0);
 const controller=new AbortController();let resolve!:(response:Response)=>void,cancelled=false;
 const pending=getBoldSignTemplate(config,id,()=>new Promise<Response>(yes=>{resolve=yes;}),controller.signal);
 controller.abort();await assert.rejects(pending,unavailable);
 resolve(new Response(new ReadableStream({cancel(){cancelled=true;}}),{headers:{'content-type':'application/json'}}));
 await new Promise<void>(yes=>setImmediate(yes));assert.equal(cancelled,true);
 const synchronous=new AbortController();
 await assert.rejects(getBoldSignTemplate(config,id,async()=>{synchronous.abort();return Response.json(data);},synchronous.signal),unavailable,'a response settled alongside cancellation must not bypass it');
});
test('cancellation releases a stalled provider body even when the stream ignores abort and never finishes cancellation',{timeout:3000},async()=>{
 for(const kind of ['template','document'] as const) {
  const controller=new AbortController();let read=false,cancelled=false;
  const response=new Response(new ReadableStream({pull(){read=true;return new Promise(()=>{});},cancel(){cancelled=true;return new Promise(()=>{});}}),{headers:{'content-type':'application/json'}});
  const pending=(kind==='template'?getBoldSignTemplate:getBoldSignDocument)(config,id,async()=>response,controller.signal);
  await new Promise<void>(yes=>setImmediate(yes));assert.equal(read,true);controller.abort();
  await assert.rejects(pending,{code:kind==='template'?'BOLDSIGN_TEMPLATE_UNAVAILABLE':'BOLDSIGN_STATUS_UNAVAILABLE',status:502});assert.equal(cancelled,true);
 }
});
test('fixed ten-second deadline rejects a transport that never resolves or honors its abort signal',{timeout:12000},async()=>{
 const started=performance.now();let signal:AbortSignal|undefined;
 await assert.rejects(getBoldSignTemplate(config,id,async(_url,options)=>{signal=options?.signal??undefined;return new Promise(()=>{});}),unavailable);
 const elapsed=performance.now()-started;assert.equal(signal?.aborted,true);assert.ok(elapsed>=9900&&elapsed<12000,'exercise the unchanged production deadline, allowing scheduling jitter only');
});
