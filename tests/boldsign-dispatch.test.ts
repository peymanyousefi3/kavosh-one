import assert from 'node:assert/strict';
import { createHash,randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { prepareBoldSignDispatch } from '../src/integrations/boldsign-dispatch.ts';
import { buildBoldSignSendRequest,buildBoldSignWorkSendRequest,type BoldSignSendDraft,type BoldSignWorkSendDraft } from '../src/integrations/boldsign-send-request.ts';
import { submitBoldSignWireRequest,type BoldSignConnection } from '../src/integrations/boldsign.ts';

// Header-only PDF and synthetic transport responses are NOT safe file clearance,
// a real durable dispatch claim, provider acceptance, delivery or legal proof.
const bytes=Buffer.from('%PDF-1.7\nPRIVATE dispatch fixture\n'),sha256=createHash('sha256').update(bytes).digest('hex');
const config:BoldSignConnection={region:'CA',apiKey:'synthetic-PRIVATE-dispatch-key'},documentId=randomUUID();
const signature={id:'Signature1',fieldType:'Signature',isRequired:true as const,pageNumber:1,bounds:{x:10,y:10,width:100,height:30}};
const signer={personId:randomUUID(),legalName:'PRIVATE Signer 王',email:'signer@example.test',phoneE164:'+16475550101',emailVerified:true as const,phoneVerified:true as const,contactFingerprint:'c'.repeat(64)};
const draft:BoldSignSendDraft={packageId:randomUUID(),bindingId:randomUUID(),attachmentId:randomUUID(),title:'PRIVATE Agreement',message:'PRIVATE review',expiryDays:30,locale:'en',document:{sha256,sizeBytes:bytes.length},signer,routing:{version:1,role:'legal_signer',fields:[signature]}};
const work:BoldSignWorkSendDraft={preparationId:randomUUID(),bindingId:randomUUID(),title:draft.title,message:draft.message,expiryDays:30,locale:'en',document:draft.document,worker:signer,academyRepresentative:{...signer,personId:randomUUID(),email:'academy@example.test',phoneE164:'+12025550123'},routing:{version:1,parties:[{role:'worker',fields:[signature]},{role:'academy_representative',fields:[{...signature,id:'AcademySignature'}]}]}};
const wire=buildBoldSignSendRequest(draft,bytes),workWire=buildBoldSignWorkSendRequest(work,bytes);
function reservation(value:{receipt:{requestSha256:string;requestBytes:number;documentSha256:string}}=wire){return {attemptId:randomUUID(),requestSha256:value.receipt.requestSha256,requestBytes:value.receipt.requestBytes,documentSha256:value.receipt.documentSha256};}
const accepted={state:'accepted_for_processing',documentId,automaticRetryAllowed:false,reconciliationRequired:true,deliveryVerified:false};
const unknown={state:'outcome_unknown',automaticRetryAllowed:false,reconciliationRequired:true,deliveryVerified:false};
const tick=()=>new Promise<void>(yes=>setImmediate(yes));

test('private dispatcher uses fixed region POST once,exact reviewed bodies and both routing kinds without treating 201 as delivery',async()=>{
 for(const [region,host]of [['US','api.boldsign.com'],['CA','api-ca.boldsign.com'],['EU','api-eu.boldsign.com'],['AU','api-au.boldsign.com']]as const)for(const purpose of ['unified_enrollment','worker_services']as const){
  const selected=purpose==='worker_services'?workWire:wire;let calls=0;
  const attempt=prepareBoldSignDispatch({...config,region},{purpose,draft:purpose==='worker_services'?work:draft},bytes,reservation(selected),async(url,options)=>{
   calls++;assert.equal(String(url),'https://'+host+'/v1/document/send');assert.equal(options?.method,'POST');assert.equal(options?.body,selected.body);assert.equal(options?.redirect,'error');assert.equal(options?.cache,'no-store');assert.equal(options?.credentials,'omit');
   const headers=new Headers(options?.headers);assert.equal(headers.get('X-API-KEY'),config.apiKey);assert.equal(headers.get('content-type'),'application/json');assert.equal(headers.get('cookie'),null);assert.equal(headers.get('authorization'),null);assert.ok(options?.signal instanceof AbortSignal);
   return Response.json({documentId:documentId.toUpperCase(),ignoredPrivateValue:'PRIVATE'},{status:201});
  });
  assert.equal(calls,0);assert.deepEqual(await attempt.dispatch(),accepted);assert.equal(calls,1);await assert.rejects(attempt.dispatch(),{code:'BOLDSIGN_DISPATCH_ALREADY_USED',status:409});assert.equal(calls,1);
 }
});
test('reserved manifest,PDF identity,purpose and strict input failures reject before IO;caller mutations cannot substitute closed-over content',async()=>{
 let calls=0;const send:typeof fetch=async(_url,options)=>{calls++;assert.equal(options?.body,wire.body);assert.equal(new Headers(options?.headers).get('X-API-KEY'),config.apiKey);return Response.json({documentId},{status:201});};
 for(const patch of [{requestSha256:'0'.repeat(64)},{requestBytes:wire.receipt.requestBytes+1},{documentSha256:'0'.repeat(64)}])assert.throws(()=>prepareBoldSignDispatch(config,{purpose:'unified_enrollment',draft},bytes,{...reservation(),...patch},send),{code:'BOLDSIGN_RESERVED_MANIFEST_MISMATCH',status:409});
 for(const bad of [{purpose:'unknown',draft},{purpose:'unified_enrollment',draft,url:'https://localhost'},{purpose:'worker_services',draft}])assert.throws(()=>prepareBoldSignDispatch(config,bad,bytes,reservation(),send));
 for(const bad of [{...reservation(),attemptId:'../private'},{...reservation(),requestBytes:0},{...reservation(),approved:true}])assert.throws(()=>prepareBoldSignDispatch(config,{purpose:'unified_enrollment',draft},bytes,bad,send),{code:'INVALID_BOLDSIGN_DISPATCH',status:400});
 const altered=Buffer.from(bytes);altered[12]^=1;assert.throws(()=>prepareBoldSignDispatch(config,{purpose:'unified_enrollment',draft},altered,reservation(),send),{code:'BOLDSIGN_DOCUMENT_IDENTITY_MISMATCH',status:409});assert.equal(calls,0);
 const mutableBytes=Buffer.from(bytes),mutableConfig={...config},attempt=prepareBoldSignDispatch(mutableConfig,{purpose:'unified_enrollment',draft:structuredClone(draft)},mutableBytes,reservation(),send);
 mutableBytes.fill(0);mutableConfig.apiKey='changed';mutableConfig.region='US';attempt.receipt.requestSha256='0'.repeat(64);
 assert.deepEqual(await attempt.dispatch(),accepted);assert.equal(calls,1);
});
test('one local dispatch consumes its handle before asynchronous IO,including rejected and ambiguous requests',async()=>{
 for(const [index,response] of [()=>Response.json({documentId},{status:201}),()=>{throw new Error('PRIVATE provider exception '+config.apiKey);}].entries()){
  let calls=0,release!:()=>void;const gate=new Promise<void>(yes=>{release=yes;});
  const attempt=prepareBoldSignDispatch(config,{purpose:'unified_enrollment',draft},bytes,reservation(),async()=>{calls++;await gate;return response();});
  const pending=attempt.dispatch();await assert.rejects(attempt.dispatch(),{code:'BOLDSIGN_DISPATCH_ALREADY_USED',status:409});release();assert.deepEqual(await pending,index===0?accepted:unknown);
  assert.equal(calls,1);
 }
});
test('HTTP errors,redirects,invalid status/MIME/JSON/UTF8/IDs remain unknown with no retry or private diagnostics',async()=>{
 const responses=[...([200,202,301,307,400,401,403,429,500,503]as const).map(status=>()=>Response.json({documentId,private:config.apiKey},{status})),
  ()=>new Response('PRIVATE',{status:201,headers:{'content-type':'text/html'}}),()=>Response.json({documentId:'invalid',private:config.apiKey},{status:201}),()=>Response.json({},{status:201}),
  ()=>new Response('not JSON PRIVATE',{status:201,headers:{'content-type':'application/json'}}),()=>new Response(Buffer.from([0xff]),{status:201,headers:{'content-type':'application/json'}}),
  ()=>{const r=Response.json({documentId},{status:201});Object.defineProperty(r,'redirected',{value:true});return r;}];
 for(const response of responses){let calls=0;const result=await submitBoldSignWireRequest(config,wire.body,async()=>{calls++;return response();});assert.deepEqual(result,unknown);assert.equal(calls,1);assert.ok(!JSON.stringify(result).includes('PRIVATE'));}
 let calls=0;assert.deepEqual(await submitBoldSignWireRequest(config,wire.body,()=>{calls++;throw new Error('PRIVATE '+config.apiKey);}),unknown);assert.equal(calls,1);
});
test('invalid operator config and byte budgets never reach IO;pre-cancellation is not an ambiguous provider request',async()=>{
 let calls=0;const send:typeof fetch=async()=>{calls++;return Response.json({documentId},{status:201});};
 for(const bad of [{...config,region:'https://localhost'},{...config,apiKey:'bad\nkey'},{...config,baseUrl:'https://localhost'}])await assert.rejects(submitBoldSignWireRequest(bad as BoldSignConnection,wire.body,send),{code:'BOLDSIGN_CONNECTION_NOT_CONFIGURED',status:503});
 for(const bad of ['',null,'\ud800','x'.repeat(16_777_217),'王'.repeat(5_592_406)])await assert.rejects(submitBoldSignWireRequest(config,bad as string,send),{code:'INVALID_BOLDSIGN_WIRE_REQUEST',status:400});
 const controller=new AbortController();controller.abort();const attempt=prepareBoldSignDispatch(config,{purpose:'unified_enrollment',draft},bytes,reservation(),send);
 assert.deepEqual(await attempt.dispatch(controller.signal),{state:'not_attempted',automaticRetryAllowed:false,reconciliationRequired:false,deliveryVerified:false});assert.equal(calls,0);
 await assert.rejects(attempt.dispatch(),{code:'BOLDSIGN_DISPATCH_ALREADY_USED',status:409});assert.equal(calls,0);
});
test('actual response-byte ceiling and stalled/cancelled/late responses release resources without blocking or exposing response bodies',{timeout:3000},async()=>{
 let cancelled=0;const json=Buffer.from(JSON.stringify({documentId})),maximum=Buffer.concat([json,Buffer.alloc(1_048_576-json.length,32)]);
 assert.deepEqual(await submitBoldSignWireRequest(config,wire.body,async()=>new Response(maximum,{status:201,headers:{'content-type':'application/json'}})),accepted);
 const tooLarge=new Response(new ReadableStream({start(c){c.enqueue(maximum);c.enqueue(Buffer.from(' '));},cancel(){cancelled++;return new Promise(()=>{});}}),{status:201,headers:{'content-type':'application/json','content-length':'1'}});
 assert.deepEqual(await submitBoldSignWireRequest(config,wire.body,async()=>tooLarge),unknown);assert.equal(cancelled,1);
 const early=new AbortController();let resolve!:(value:Response)=>void;
 const waiting=submitBoldSignWireRequest(config,wire.body,()=>new Promise<Response>(yes=>{resolve=yes;}),early.signal);early.abort();assert.deepEqual(await waiting,unknown);
 resolve(new Response(new ReadableStream({cancel(){cancelled++;}}),{status:201,headers:{'content-type':'application/json'}}));await tick();assert.equal(cancelled,2);
 const stalled=new AbortController();let reading=false;
 const body=new ReadableStream<Uint8Array>({pull(){reading=true;return new Promise(()=>{});},cancel(){cancelled++;return new Promise(()=>{});}});
 const pending=submitBoldSignWireRequest(config,wire.body,async()=>new Response(body,{status:201,headers:{'content-type':'application/json'}}),stalled.signal);
 await tick();assert.equal(reading,true);stalled.abort();assert.deepEqual(await pending,unknown);assert.equal(cancelled,3);
 const synchronous=new AbortController();assert.deepEqual(await submitBoldSignWireRequest(config,wire.body,async()=>{synchronous.abort();return Response.json({documentId},{status:201});},synchronous.signal),unknown);
});
test('send shares the fixed absolute ten-second deadline even when transport ignores cancellation',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});let calls=0,signal:AbortSignal|undefined;
 const pending=submitBoldSignWireRequest(config,wire.body,async(_url,options)=>{calls++;signal=options?.signal??undefined;return new Promise(()=>{});});
 t.mock.timers.tick(10000);assert.deepEqual(await pending,unknown);assert.equal(signal?.aborted,true);assert.equal(calls,1);
});
test('real loopback HTTP exercises one complete binary-bearing JSON POST and response;fixed provider target is rewritten only by the injected test adapter',async()=>{
 let requests=0;const server=createServer(async(req,res)=>{requests++;assert.equal(req.method,'POST');assert.equal(req.url,'/v1/document/send');assert.equal(req.headers['x-api-key'],config.apiKey);const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(chunk);const body=Buffer.concat(chunks).toString('utf8');assert.equal(body,workWire.body);assert.deepEqual(Buffer.from(JSON.parse(body).Files[0].split(',')[1],'base64'),bytes);res.writeHead(201,{'content-type':'application/json'}).end(JSON.stringify({documentId}));});
 await new Promise<void>(yes=>server.listen(0,'127.0.0.1',yes));const address=server.address();assert.ok(address&&typeof address!=='string');
 try{const attempt=prepareBoldSignDispatch(config,{purpose:'worker_services',draft:work},bytes,reservation(workWire),async(url,options)=>{assert.equal(String(url),'https://api-ca.boldsign.com/v1/document/send');return fetch('http://127.0.0.1:'+address.port+'/v1/document/send',options);});assert.deepEqual(await attempt.dispatch(),accepted);assert.equal(requests,1);}
 finally{server.closeAllConnections();await new Promise<void>(yes=>server.close(()=>yes()));}
});
