import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { createApi,jsonBody } from '../src/core/api.ts';
import { identityGateway } from '../src/auth/gateway.ts';
import type { Identity,IdentityConfig } from '../src/auth/config.ts';
import type { IdentityStore } from '../src/auth/store.ts';
import { operationsFixture } from './operations-fixture.ts';

const origin='https://academy.example';
function request(body:ReadableStream<Uint8Array>|Uint8Array,signal?:AbortSignal){return new Request(origin+'/api/v1/roles',{method:'POST',headers:{'content-type':'application/json'},body:body instanceof Uint8Array?Buffer.from(body):body,signal,duplex:'half'} as RequestInit);}
function stalled(cancel:()=>void|Promise<void>=()=>{}){let observed!:()=>void;const read=new Promise<void>(r=>{observed=r;}),stream=new ReadableStream<Uint8Array>({pull(){observed();},cancel},{highWaterMark:0});return {stream,read};}
test('JSON reader keeps exact byte limits fatal UTF8 strict MIME and literal Unicode parsing',async()=>{
 const bytes=Buffer.from('{"text":"中文 — Français"}');assert.deepEqual(await jsonBody(request(bytes),bytes.length),{text:'中文 — Français'});await assert.rejects(jsonBody(request(bytes),bytes.length-1),{code:'BODY_TOO_LARGE',status:413});await assert.rejects(jsonBody(request(Buffer.concat([Buffer.from('{"x":"'),Buffer.from([0xff]),Buffer.from('"}')]))),{code:'INVALID_JSON',status:400});await assert.rejects(jsonBody(new Request(origin,{method:'POST',headers:{'content-type':'text/plain'},body:'{}'})),{code:'JSON_REQUIRED',status:415});await assert.rejects(jsonBody(request(Buffer.from('{"x":'))),{code:'INVALID_JSON',status:400});
});
test('JSON total deadline cancels a stalled read and releases its reader without awaiting uncooperative cancellation',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});let cancelled=false;const f=stalled(()=>{cancelled=true;return new Promise<void>(()=>{});}),r=request(f.stream),pending=jsonBody(r),checked=assert.rejects(pending,{code:'JSON_BODY_TIMEOUT',status:408});await f.read;t.mock.timers.tick(10_000);await checked;assert.equal(cancelled,true);assert.equal(r.body?.locked,false);
});
test('JSON deadline is total and is not renewed by tiny partial chunks',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});let controller!:ReadableStreamDefaultController<Uint8Array>,reads=0;const r=request(new ReadableStream<Uint8Array>({start(c){controller=c;},pull(){reads++;}},{highWaterMark:0})),pending=jsonBody(r),checked=assert.rejects(pending,{code:'JSON_BODY_TIMEOUT',status:408});controller.enqueue(Buffer.from('{"x":"'));await new Promise<void>(resolve=>setImmediate(resolve));t.mock.timers.tick(9000);controller.enqueue(Buffer.from('p'));await new Promise<void>(resolve=>setImmediate(resolve));t.mock.timers.tick(1000);await checked;assert.ok(reads>=2);assert.equal(r.body?.locked,false);
});
test('oversized JSON rejection never waits for cancellation and preserves the size error when cancellation fails',async()=>{
 for(const cancel of [()=>new Promise<void>(()=>{}),()=>{throw Error('PRIVATE cancellation diagnostics');}]){let cancelled=false;const r=request(new ReadableStream<Uint8Array>({start(c){c.enqueue(Buffer.from('{"large":true}'));},cancel(){cancelled=true;return cancel();}}));await assert.rejects(jsonBody(r,1),{code:'BODY_TOO_LARGE',status:413});assert.equal(cancelled,true);assert.equal(r.body?.locked,false);}
});
test('JSON reader aborts immediately and after a pending read without leaking an abort reason',async()=>{
 for(const before of [true,false]){const controller=new AbortController();let cancelled=false;const f=stalled(()=>{cancelled=true;}),r=request(f.stream,controller.signal);if(before)controller.abort('PRIVATE cancellation reason');const pending=jsonBody(r),checked=assert.rejects(pending,{code:'JSON_BODY_ABORTED',status:408});if(!before){await f.read;controller.abort('PRIVATE cancellation reason');}await checked;assert.equal(cancelled,true);assert.equal(r.body?.locked,false);}
});
test('successful JSON parsing clears its deadline and abort listener rather than cancelling a completed source',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});let cancelled=false;const controller=new AbortController(),r=request(new ReadableStream<Uint8Array>({start(c){c.enqueue(Buffer.from('{}'));c.close();},cancel(){cancelled=true;}}),controller.signal);assert.deepEqual(await jsonBody(r),{});t.mock.timers.tick(100_000);controller.abort();await new Promise<void>(resolve=>setImmediate(resolve));assert.equal(cancelled,false);assert.equal(r.body?.locked,false);
});
test('oversized cloned JSON requests reject without waiting for the original unread branch',{timeout:2000},async()=>{
 const original=request(Buffer.from('{"oversized":true}')),clone=original.clone();try{await assert.rejects(jsonBody(clone,1),{code:'BODY_TOO_LARGE',status:413});assert.equal(clone.body?.locked,false);assert.equal(await original.text(),'{"oversized":true}');}finally{void original.body?.cancel().catch(()=>{});}
});
function gateway(){let handled=0,sessions=0;const api={api:{async getSession(){sessions++;return null;}},async handler(){handled++;return Response.json({ok:true});}} as unknown as Identity,store={async safe(){},async budget(){return true;}} as unknown as IdentityStore,config:IdentityConfig={origin,production:false,secret:'synthetic-parser-only-test-secret-not-live-000000'};return {run:identityGateway(api,store,config),counts:()=>({handled,sessions})};}
function authRequest(body:ReadableStream<Uint8Array>|Uint8Array){const headers={'content-type':'application/json',origin};return new Request(origin+'/api/auth/sign-in/email',{method:'POST',headers,body:body instanceof Uint8Array?Buffer.from(body):body,duplex:'half'} as RequestInit);}
test('authentication gateway shares the JSON deadline and never forwards a stalled login body',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});const f=gateway(),stream=stalled(),pending=f.run(authRequest(stream.stream));await stream.read;t.mock.timers.tick(10_000);const response=await pending;assert.equal(response.status,408);assert.deepEqual(await response.json(),{error:{code:'JSON_BODY_TIMEOUT'}});assert.equal(response.headers.get('cache-control'),'no-store');assert.deepEqual(f.counts(),{handled:0,sessions:0});
});
test('authentication rejects malformed UTF8 and oversized bodies without invoking the identity library',async()=>{
 for(const bytes of [Buffer.concat([Buffer.from('{"email":"'),Buffer.from([0xff]),Buffer.from('"}')]),Buffer.alloc(16385,0x20)]){const f=gateway(),response=await f.run(authRequest(bytes));assert.equal(response.status,bytes.length>16384?413:400);assert.deepEqual(f.counts(),{handled:0,sessions:0});}
});
test('native stalled JSON timeout releases real transaction locks leaves no writes and permits a normal retry',{skip:!process.env.TEST_DATABASE_URL,timeout:10000},async t=>{
 const f=await operationsFixture();try{const actor=f.actors.master,api=createApi(f.pg.runtime!,async()=>({userId:actor.user,sessionId:actor.session,academyId:f.a}));t.mock.timers.enable({apis:['setTimeout']});const stream=stalled(()=>new Promise<void>(()=>{})),r=new Request(origin+'/api/v1/hubs',{method:'POST',headers:{'content-type':'application/json',cookie:'synthetic-only-resolver-cookie','idempotency-key':randomUUID()},body:stream.stream,duplex:'half'} as RequestInit),running=api(r,'hubs');await stream.read;await f.pg.exec('BEGIN');try{await assert.rejects(f.pg.query('SELECT id FROM public.people WHERE id=$1 FOR UPDATE NOWAIT',[actor.person]),(e:unknown)=>(e as {code:string}).code==='55P03');}finally{await f.pg.exec('ROLLBACK');}t.mock.timers.tick(10_000);const response=await running;assert.equal(response.status,408);const result=await response.json();assert.match(result.error.requestId,/^[0-9a-f-]{36}$/);assert.deepEqual(result,{error:{code:'JSON_BODY_TIMEOUT',requestId:result.error.requestId}});t.mock.timers.reset();assert.equal((await f.pg.query('SELECT * FROM public.request_keys')).rows.length,0);await f.pg.exec('BEGIN');try{assert.equal((await f.pg.query('SELECT id FROM public.people WHERE id=$1 FOR UPDATE NOWAIT',[actor.person])).rows.length,1);}finally{await f.pg.exec('ROLLBACK');}assert.equal((await f.request('roles',{name:'Recovery after interrupted body',permissions:[{capability:'people.view',effect:'allow'}]})).response.status,201);
 }finally{t.mock.timers.reset();await f.pg.close();}
});
