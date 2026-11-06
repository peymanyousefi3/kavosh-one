import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createSigningControlApi } from '../src/integrations/signing-control-api.ts';
import { mintToken } from '../src/core/tokens.ts';

const config=()=>({origin:'https://control.example',academyId:randomUUID(),token:mintToken()});
const json=(value:unknown,status=200)=>Response.json(value,{status});
test('signing control restricts origin and identifiers before any network request',async()=>{
 let calls=0;const send:typeof fetch=async()=>{calls++;return json({});},c=config();
 for(const origin of ['http://control.example','https://user:secret@control.example','https://control.example/private','https://control.example/?token=secret','https://control.example/#private'])assert.throws(()=>createSigningControlApi({...c,origin},send),{code:'SIGNING_CONTROL_NOT_CONFIGURED'});
 const api=createSigningControlApi(c,send);
 assert.throws(()=>api.intention('../other'),{code:'INVALID_SIGNING_CONTROL_REQUEST'});
 assert.throws(()=>api.source(randomUUID(),'https://other.example'),{code:'INVALID_SIGNING_CONTROL_REQUEST'});
 await assert.rejects(api.reserve(randomUUID(),{},'invalid'),{code:'INVALID_SIGNING_CONTROL_REQUEST'});
 assert.equal(calls,0);
});
test('signing control sends only fixed paths and scoped credentials with redirects and cookies disabled',async()=>{
 const c=config(),request=randomUUID(),copy=randomUUID(),attempt=randomUUID(),key=randomUUID();let calls=0;
 const send:typeof fetch=async(url,options)=>{
  calls++;assert.equal(new URL(String(url)).origin,c.origin);assert.equal(options?.redirect,'error');assert.equal(options?.credentials,'omit');assert.equal(options?.cache,'no-store');
  const headers=new Headers(options?.headers);assert.equal(headers.get('authorization'),'Bearer '+c.token);assert.equal(headers.get('x-academy-id'),c.academyId);assert.equal(headers.get('cookie'),null);
  if(options?.method==='POST'){assert.equal(headers.get('idempotency-key'),key);assert.equal(options.body,JSON.stringify({value:1}));}
  return json({data:{ok:true}});
 };
 const api=createSigningControlApi(c,send);assert.equal(Object.isFrozen(api),true);
 await api.intention(request);await api.source(request,copy);await api.attempts(request);await api.reserve(request,{value:1},key);await api.start(request,attempt,{value:1},key);assert.equal(calls,5);
});
test('signing control rejects unsafe responses and redacts upstream diagnostics',async()=>{
 const c=config(),request=randomUUID();
 for(const response of [new Response('PRIVATE',{headers:{'content-type':'text/html'}}),new Response('{',{headers:{'content-type':'application/json'}}),json({private:'x'.repeat(1_048_576)}),json({error:{code:'PRIVATE_PROVIDER_DIAGNOSTIC'}},403)]){
  await assert.rejects(createSigningControlApi(c,async()=>response).intention(request),error=>{assert.doesNotMatch(String(error),/PRIVATE/);return true;});
 }
 await assert.rejects(createSigningControlApi(c,async()=>json({error:{code:'SIGNATURE_ATTEMPT_ALREADY_RESERVED'}},409)).reserve(request,{},randomUUID()),{code:'SIGNATURE_ATTEMPT_ALREADY_RESERVED',status:409});
 let calls=0;const aborted=AbortSignal.abort();await assert.rejects(createSigningControlApi(c,async()=>{calls++;return json({});}).intention(request,aborted),{code:'SIGNING_CONTROL_UNAVAILABLE'});assert.equal(calls,0);
});
test('signing control deadline ends ignored requests and discards late private responses',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});let settle!:(response:Response)=>void,cancelled=false;
 const pending=new Promise<Response>(resolve=>{settle=resolve;}),api=createSigningControlApi({...config(),timeoutMs:1000},async()=>pending);
 const request=api.intention(randomUUID());t.mock.timers.tick(1000);await assert.rejects(request,{code:'SIGNING_CONTROL_UNAVAILABLE'});
 settle(new Response(new ReadableStream({cancel(){cancelled=true;}}),{headers:{'content-type':'application/json'}}));await new Promise<void>(resolve=>setImmediate(resolve));assert.equal(cancelled,true);
});
