import assert from 'node:assert/strict';
import { createHmac,webcrypto } from 'node:crypto';
import { test } from 'node:test';
import { getBoldSignDocument,verifyBoldSignSignature,type BoldSignConnection } from '../src/integrations/boldsign.ts';

const now=1700000000,secret='synthetic-webhook-secret',body=Buffer.from('{"event":{"id":"synthetic-event","eventType":"Completed","environment":"Test"}}');
// Independent OpenSSL fixture: HMAC-SHA256(secret, timestamp + '.' + raw bytes).
const digest='699f6864bef84092e8d734d537b363cbc2e0a5085fa23b728c57a69e7884831b',header=`t=${now}, s0=${digest}`;
const invalid={code:'INVALID_BOLDSIGN_SIGNATURE',status:401};
function sign(bytes:Uint8Array,key=secret,time=now){return createHmac('sha256',key).update(time+'.').update(bytes).digest('hex');}

test('BoldSign raw-byte verification matches independent OpenSSL and Web Crypto evidence, including Unicode',async()=>{
  assert.equal(verifyBoldSignSignature(body,header,[secret],now),now);
  const bytes=Buffer.from('{"message":"机器人 — Montréal","spacing":  true}\n'),key=await webcrypto.subtle.importKey('raw',Buffer.from(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']);
  const signature=Buffer.from(await webcrypto.subtle.sign('HMAC',key,Buffer.concat([Buffer.from(now+'.'),bytes]))).toString('hex');
  assert.equal(verifyBoldSignSignature(bytes,`t=${now},s0=${signature}`,[secret],now),now);
  assert.throws(()=>verifyBoldSignSignature(Buffer.from(JSON.stringify(JSON.parse(bytes.toString()))),`t=${now},s0=${signature}`,[secret],now),invalid,'re-serialization must not preserve authenticity');
  assert.throws(()=>verifyBoldSignSignature(Buffer.from(body.toString()+' '),header,[secret],now),invalid);
  assert.throws(()=>verifyBoldSignSignature(body,header,['different-test-secret'],now),invalid);
});
test('BoldSign callback time window rejects stale and future signatures without allowing tolerance disablement',()=>{
  for(const delta of [-300,0,300])assert.equal(verifyBoldSignSignature(body,`t=${now+delta},s0=${sign(body,secret,now+delta)}`,[secret],now),now+delta);
  for(const delta of [-301,301])assert.throws(()=>verifyBoldSignSignature(body,`t=${now+delta},s0=${sign(body,secret,now+delta)}`,[secret],now),invalid);
});
test('BoldSign rotation accepts configured current or previous keys but never unconfigured keys',()=>{
  const next='synthetic-next-secret',rotation=`t=${now}, s0=${sign(body,next)}, s1=${digest}`;
  for(const keys of [[next],[secret],[next,secret]])assert.equal(verifyBoldSignSignature(body,rotation,keys,now),now);
  assert.throws(()=>verifyBoldSignSignature(body,header,[next],now),invalid,'retiring the old key invalidates its otherwise fresh signature');
});
test('BoldSign signature grammar rejects duplicates, malformed hashes, unsupported fields and ambiguous timestamps',()=>{
  for(const value of [null,'',`t=${now}`,`s0=${digest}`,`t=${now},s1=${digest}`,header+',t='+now,header+',s0='+digest,header+',s1='+digest+',s1='+digest,
    header+',x=ignored',header+',',`t=0${now},s0=${digest}`,`t=+${now},s0=${digest}`,`t=${now}.0,s0=${digest}`,`t=1e9,s0=${digest}`,`t=99999999999999,s0=${digest}`,
    `t=${now},s0=${digest.slice(1)}`,`t=${now},s0=${digest}00`,`t=${now},s0=${'g'.repeat(64)}`,header+',s1=invalid',' '.repeat(1025)+header])
    assert.throws(()=>verifyBoldSignSignature(body,value,[secret],now),invalid,String(value));
  assert.equal(verifyBoldSignSignature(body,` t=${now} , s0=${digest.toUpperCase()} `,[secret],now),now);
});
test('BoldSign verification fails closed for missing configuration and never exposes supplied secrets',()=>{
  for(const keys of [[],[''],[secret,''],[secret,secret,secret],['x'.repeat(4097)]])assert.throws(()=>verifyBoldSignSignature(body,header,keys,now),{code:'BOLDSIGN_VERIFICATION_NOT_CONFIGURED',status:503});
  for(const time of [NaN,Infinity,-1,now+0.5])assert.throws(()=>verifyBoldSignSignature(body,header,[secret],time),{code:'BOLDSIGN_VERIFICATION_NOT_CONFIGURED',status:503});
  try{verifyBoldSignSignature(body,header,['wrong-secret'],now);assert.fail('must reject');}catch(error){assert.ok(!String(error).includes('wrong-secret'));assert.ok(!String(error).includes(digest));}
});

const documentId='7dd390f6-3cdc-41cf-a3f8-acfe5e679098',signerId='f631b2a0-a664-41ca-9f64-c65f00ea08b1';
const config:BoldSignConnection={region:'CA',apiKey:'synthetic-provider-api-key'};
const result={documentId,status:'Completed',signerDetails:[{id:signerId,signerEmail:'synthetic@example.test',status:'Completed',authenticationType:'EmailOTP',enableEmailOTP:true,isAuthenticationFailed:false,isReassigned:false,signerType:'Signer'}]};
const unavailable={code:'BOLDSIGN_STATUS_UNAVAILABLE',status:502};
function json(value:unknown){return Response.json(value);}
test('BoldSign read-only reconciliation transport selects explicit regional endpoints and returns only necessary status evidence',async()=>{
  for(const [region,host] of [['US','api.boldsign.com'],['CA','api-ca.boldsign.com'],['EU','api-eu.boldsign.com'],['AU','api-au.boldsign.com']] as const) {
    let calls=0;
    const data=await getBoldSignDocument({...config,region},documentId.toUpperCase(),async(url,options)=>{
      calls++;assert.equal(String(url),`https://${host}/v1/document/properties?documentId=${documentId}`);
      assert.equal(options?.method,'GET');assert.equal(options?.redirect,'error');assert.equal(options?.cache,'no-store');assert.equal(options?.credentials,'omit');assert.equal(options?.body,undefined);
      const headers=new Headers(options?.headers);assert.equal(headers.get('X-API-KEY'),config.apiKey);assert.equal(headers.get('accept'),'application/json');assert.equal(headers.get('cookie'),null);assert.equal(headers.get('authorization'),null);
      assert.ok(options?.signal instanceof AbortSignal);assert.equal(options.signal.aborted,false);
      return json({...result,privateMessage:'Do not forward',signerDetails:[{...result.signerDetails[0],formFields:[{privateValue:'Do not forward'}]}]});
    });
    assert.equal(calls,1);assert.deepEqual(data,result);
    assert.equal('eligible' in data,false);assert.equal('environment' in data,false,'document properties alone do not establish sandbox/live environment');
  }
});
test('BoldSign status transport rejects missing region, arbitrary destinations, invalid keys and document injection before networking',async()=>{
  let calls=0;const send:typeof fetch=async()=>{calls++;return json(result);};
  for(const bad of [{apiKey:config.apiKey},{...config,region:'unknown'},{...config,region:'https://localhost'},{...config,baseUrl:'https://localhost'},
    {...config,apiKey:''},{...config,apiKey:'invalid\r\nheader'},{...config,apiKey:'x'.repeat(4097)}])
    await assert.rejects(getBoldSignDocument(bad as BoldSignConnection,documentId,send),{code:'BOLDSIGN_CONNECTION_NOT_CONFIGURED',status:503});
  for(const bad of ['',documentId+'&other=leak','https://localhost','../../document',' '+documentId])await assert.rejects(getBoldSignDocument(config,bad,send),{code:'INVALID_BOLDSIGN_DOCUMENT_ID',status:400});
  assert.equal(calls,0);
});
test('BoldSign status evidence must identify the selected document and contain bounded typed signer fields',async()=>{
  for(const bad of [{...result,documentId:signerId},{...result,documentId:undefined},{...result,status:''},{...result,status:'x'.repeat(81)},
    {...result,signerDetails:undefined},{...result,signerDetails:[{...result.signerDetails[0],signerEmail:'not-an-email'}]},
    {...result,signerDetails:[{...result.signerDetails[0],isAuthenticationFailed:'false'}]},{...result,signerDetails:Array(101).fill(result.signerDetails[0])}])
    await assert.rejects(getBoldSignDocument(config,documentId,async()=>json(bad)),unavailable);
  const unknown=await getBoldSignDocument(config,documentId,async()=>json({...result,status:'FutureProviderState'}));assert.equal(unknown.status,'FutureProviderState');assert.equal('eligible' in unknown,false);
});
test('BoldSign transport cancels HTTP errors, wrong content types and redirects and never leaks upstream messages or credentials',async()=>{
  for(const [status,type] of [[401,'application/json'],[429,'application/json'],[500,'application/json'],[302,'application/json'],[200,'text/html']] as const) {
    let cancelled=false;
    const response=new Response(new ReadableStream({pull(controller){controller.enqueue(Buffer.from(config.apiKey));},cancel(){cancelled=true;}}),{status,headers:{'content-type':type}});
    await assert.rejects(getBoldSignDocument(config,documentId,async()=>response),unavailable);assert.equal(cancelled,true);
  }
  for(const error of [new Error(config.apiKey),new DOMException(config.apiKey,'TimeoutError'),new TypeError('redirect to internal host')]) {
    try{await getBoldSignDocument(config,documentId,async()=>{throw error;});assert.fail('must reject');}catch(caught){assert.equal((caught as {code:string}).code,'BOLDSIGN_STATUS_UNAVAILABLE');assert.ok(!String(caught).includes(config.apiKey));assert.ok(!String(caught).includes('internal host'));}
  }
});
test('BoldSign status reads enforce the actual byte limit, cancel excess streams and reject corrupt bodies',async()=>{
  const bytes=Buffer.from(JSON.stringify(result)),limit=1_048_576;
  const boundary=Buffer.concat([bytes,Buffer.alloc(limit-bytes.byteLength,32)]);
  assert.deepEqual(await getBoldSignDocument(config,documentId,async()=>new Response(boundary,{headers:{'content-type':'application/json; charset=utf-8'}})),result);
  let cancelled=false;
  const tooLarge=new Response(new ReadableStream({start(controller){controller.enqueue(boundary);controller.enqueue(Buffer.from(' '));},cancel(){cancelled=true;}}),{headers:{'content-type':'application/json','content-length':'1'}});
  await assert.rejects(getBoldSignDocument(config,documentId,async()=>tooLarge),unavailable);assert.equal(cancelled,true);
  for(const body of [null,'not json',Buffer.from([0xff,0xfe]),'{"documentId":'])await assert.rejects(getBoldSignDocument(config,documentId,async()=>new Response(body,{headers:{'content-type':'application/json'}})),unavailable);
  await assert.rejects(getBoldSignDocument(config,documentId,async()=>new Response(new ReadableStream({start(c){c.error(new Error(config.apiKey));}}),{headers:{'content-type':'application/json'}})),unavailable);
});
