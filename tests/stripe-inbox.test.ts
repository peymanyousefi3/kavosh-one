import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { operationsFixture } from './operations-fixture.ts';
import { createStripeWebhook } from '../src/integrations/stripe-inbox.ts';
import { assertWebhookIngestRole } from '../src/integrations/webhook-role.ts';
import { assertRuntimeRole,type Connection,type Database } from '../src/core/database.ts';
import { stripeConnectionTarget } from '../src/integrations/stripe-webhook-config.ts';
import { paymentConnection,paymentEvent,stripeHeader,stripeTestSecret } from './stripe-fixture.ts';

async function fixture(){
 const f=await operationsFixture(),c=paymentConnection(f.a),foreign={...paymentConnection(f.b),secrets:[stripeTestSecret+'Foreign']};
 for(const v of [c,foreign])await f.pg.query('INSERT INTO public.payment_connections(id,academy_id,account_id,livemode,api_version,enabled) VALUES($1,$2,$3,$4,$5,true)',[v.connectionId,v.academyId,v.accountId,v.livemode,v.apiVersion]);
 let connections=0;const database:Database={async connect(){connections++;if(f.pg.runtime){const db=await f.pg.runtime.connect();await db.query('SET ROLE kavosh_payment_ingest');return db;}await f.pg.exec('SET ROLE kavosh_payment_ingest');return {query:<Row>(sql:string,args?:unknown[])=>f.pg.query<Row>(sql,args),release(){}};}};
 const receive=createStripeWebhook(database,id=>[c,foreign].find(v=>v.connectionId===id)??null);
 async function send(value:unknown=paymentEvent(),options:{connection?:typeof c;header?:string;bytes?:Uint8Array;headers?:Record<string,string>;query?:string;receiver?:typeof receive}={}){
  const v=options.connection??c,bytes=options.bytes??Buffer.from(JSON.stringify(value));try{
   const response=await (options.receiver??receive)(new Request('https://academy.example/api/webhooks/stripe/'+v.connectionId+(options.query??''),{method:'POST',headers:{'content-type':'application/json','stripe-signature':options.header??stripeHeader(bytes,v.secrets[0]),...options.headers},body:bytes as BodyInit}),v.connectionId);return {response,body:await response.json()};
  }finally{if(!f.pg.runtime)await f.pg.exec('RESET ROLE');}
 }
 return {...f,c,foreign,database,receive,send,get connections(){return connections;}};
}
type Fixture=Awaited<ReturnType<typeof fixture>>;
function check(name:string,run:(f:Fixture)=>Promise<void>){test(name,async()=>{const f=await fixture();try{await run(f);}finally{await f.pg.close();}});}
check('authenticated snapshot persists only immutable school/account-bound references; completed unpaid checkout never posts money',async f=>{
 const value=paymentEvent(),r=await f.send(value);assert.equal(r.response.status,200,JSON.stringify(r.body));assert.deepEqual(r.body,{received:true});assert.equal(r.response.headers.get('cache-control'),'no-store');
 const rows=(await f.pg.query('SELECT * FROM public.payment_webhook_inbox')).rows;assert.equal(rows.length,1);assert.equal(rows[0].academy_id,f.a);assert.equal(rows[0].account_id,f.c.accountId);assert.equal(rows[0].event_id,value.id);assert.equal(rows[0].resource_id,value.data.object.id);assert.doesNotMatch(JSON.stringify(rows),/PRIVATE|customer|99999|metadata|paid/);
 assert.equal((await f.request('finance/journals')).body.data.length,0);assert.equal((await f.pg.query('SELECT count(*)::integer n FROM public.tuition_receipts')).rows[0].n,0);
 assert.equal((await f.pg.query("SELECT count(*)::integer n FROM public.outbox_events WHERE event_type='payment.webhook.received'")).rows[0].n,1);
});
check('duplicate delivery is idempotent; changed authenticated bytes retain original and one critical conflict per digest',async f=>{
 const p=paymentEvent();for(let i=0;i<2;i++)assert.equal((await f.send(p)).response.status,200);
 const changed={...p,type:'checkout.session.async_payment_succeeded'};for(let i=0;i<2;i++)assert.equal((await f.send(changed)).response.status,200);
 assert.equal((await f.pg.query('SELECT event_type FROM public.payment_webhook_inbox')).rows[0].event_type,'checkout.session.completed');assert.equal((await f.pg.query('SELECT count(*)::integer n FROM public.payment_webhook_conflicts')).rows[0].n,1);
 assert.deepEqual((await f.pg.query('SELECT event_type FROM public.outbox_events ORDER BY event_type')).rows.map(r=>r.event_type),['payment.webhook.conflict.critical','payment.webhook.received']);
 // Different IDs about the same resource are separate evidence, not receipts.
 assert.equal((await f.send({...p,id:'evt_'+randomUUID().replaceAll('-',''),created:p.created-50})).response.status,200);assert.equal((await f.pg.query('SELECT count(*)::integer n FROM public.payment_webhook_inbox')).rows[0].n,2);
 assert.equal((await f.pg.query('SELECT count(*)::integer n FROM public.tuition_receipts')).rows[0].n,0);
});
check('forged, wrong-mode/account/version, malformed and oversized requests fail before database access; no unsigned probe',async f=>{
 const p=paymentEvent();
 for(const [value,options,status] of [[p,{header:'invalid'},401],[{...p,livemode:true},{},400],[{...p,account:f.c.accountId},{},400],[{...p,api_version:'2024-01-01'},{},400],[p,{headers:{'content-encoding':'gzip'}},415],[p,{headers:{'content-type':'text/plain'}},415],[p,{bytes:Buffer.alloc(1048577,32)},413],[p,{query:'?academyId='+f.b},400]] as const)assert.equal((await f.send(value,options)).response.status,status);
 assert.equal(f.connections,0);
 const disabled=createStripeWebhook({async connect(){assert.fail('disabled must not connect');}},()=>null);assert.equal((await f.send(p,{receiver:disabled})).response.status,503);
 const failed=createStripeWebhook({async connect(){throw new Error(stripeTestSecret+'PRIVATE');}},()=>f.c),r=await f.send(p,{receiver:failed});assert.equal(r.response.status,503);assert.doesNotMatch(JSON.stringify(r.body),/whsec_|PRIVATE|postgres/);
});
check('native registry pins immutable identity, shared account uniqueness and inactive school; valid read-only school notices still persist',async f=>{
 await assert.rejects(f.pg.query('UPDATE public.payment_connections SET account_id=$1 WHERE id=$2',['acct_other',f.c.connectionId]),/PAYMENT_CONNECTION_IDENTITY_IMMUTABLE/);
 await assert.rejects(f.pg.query('INSERT INTO public.payment_connections(id,academy_id,account_id,livemode,api_version) VALUES($1,$2,$3,$4,$5)',[randomUUID(),f.b,f.c.accountId,false,f.c.apiVersion]),/unique constraint/);
 f.c.accountId+='drift';assert.equal((await f.send()).response.status,503);f.c.accountId=f.c.accountId.slice(0,-5);
 await f.pg.query('UPDATE public.payment_connections SET enabled=false WHERE id=$1',[f.c.connectionId]);assert.equal((await f.send()).response.status,503);await f.pg.query('UPDATE public.payment_connections SET enabled=true WHERE id=$1',[f.c.connectionId]);
 await f.pg.query("UPDATE public.academies SET status='suspended' WHERE id=$1",[f.a]);assert.equal((await f.send()).response.status,503);
 await f.pg.query("UPDATE public.academies SET status='read_only' WHERE id=$1",[f.a]);assert.equal((await f.send()).response.status,200);
 assert.equal((await f.send(undefined,{connection:f.foreign})).response.status,200);assert.equal((await f.pg.query('SELECT count(DISTINCT academy_id)::integer n FROM public.payment_webhook_inbox')).rows[0].n,2);
});
check('transactional outbox failure leaves no accepted event or budget and a retry records exactly once',async f=>{
 const p=paymentEvent();await f.pg.exec('REVOKE INSERT ON public.outbox_events FROM kavosh_payment_policy');try{assert.equal((await f.send(p)).response.status,503);}finally{await f.pg.exec('GRANT INSERT ON public.outbox_events TO kavosh_payment_policy');}
 for(const table of ['payment_webhook_inbox','payment_ingest_limits'])assert.equal((await f.pg.query('SELECT count(*)::integer n FROM public.'+table)).rows[0].n,0);
 assert.equal((await f.send(p)).response.status,200);
});
check('database budget is shared across handlers, bounded to one row and isolated from another school',async f=>{
 await f.pg.query('UPDATE public.payment_connections SET max_events_per_minute=2 WHERE id=$1',[f.c.connectionId]);for(let i=0;i<2;i++)assert.equal((await f.send()).response.status,200);
 await f.pg.query("UPDATE public.payment_ingest_limits SET window_started=date_trunc('minute',clock_timestamp())+interval '1 minute',attempts=2 WHERE connection_id=$1",[f.c.connectionId]);
 assert.equal((await f.send(undefined,{receiver:createStripeWebhook(f.database,()=>f.c)})).response.status,429);assert.equal((await f.send(undefined,{connection:f.foreign})).response.status,200);
 await f.pg.query("UPDATE public.payment_ingest_limits SET window_started=window_started-interval '3 minutes' WHERE connection_id=$1",[f.c.connectionId]);assert.equal((await f.send()).response.status,200);assert.equal((await f.pg.query('SELECT count(*)::integer n FROM public.payment_ingest_limits')).rows[0].n,2);
});
check('public ingest and ordinary runtime cannot read raw inbox, identities or write accounting; mixed or direct grants fail closed',async f=>{
 await f.pg.exec('SET ROLE kavosh_payment_ingest');try{for(const sql of ['SELECT * FROM public.payment_connections','SELECT * FROM public.payment_webhook_inbox','SELECT * FROM public.people','SELECT * FROM identity."user"','SELECT * FROM auth_private.credentials','SELECT * FROM public.tuition_receipts',"DELETE FROM public.payment_webhook_inbox"])await assert.rejects(f.pg.exec(sql),/permission denied/);}finally{await f.pg.exec('RESET ROLE');}
 await f.pg.exec('SET ROLE kavosh_runtime');try{for(const sql of ['SELECT * FROM public.payment_webhook_inbox','SELECT public.receive_payment_event(NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL)'])await assert.rejects(f.pg.exec(sql),/permission denied/);}finally{await f.pg.exec('RESET ROLE');}
 for(const grant of ['GRANT kavosh_runtime TO kavosh_payment_ingest','GRANT kavosh_signature_ingest TO kavosh_payment_ingest','GRANT kavosh_payment_policy TO kavosh_payment_ingest','GRANT SELECT ON public.payment_webhook_inbox TO kavosh_payment_ingest','GRANT SELECT(name) ON public.people TO kavosh_payment_ingest']){
  await f.pg.exec(grant);try{const db=await f.database.connect();try{await assert.rejects(assertWebhookIngestRole(db,'payment'),/UNSAFE_PAYMENT_INGEST_ROLE/);}finally{db.release();if(!f.pg.runtime)await f.pg.exec('RESET ROLE');}}finally{await f.pg.exec(grant.replace('GRANT ','REVOKE ').replace(' TO ',' FROM '));}
 }
 await f.pg.exec('GRANT kavosh_payment_ingest TO kavosh_runtime');try{await f.pg.exec('SET ROLE kavosh_runtime');const db:Connection={query:<Row>(sql:string,args?:unknown[])=>f.pg.query<Row>(sql,args),release(){}};await assert.rejects(assertRuntimeRole(db),/UNSAFE_DATABASE_ROLE/);}finally{await f.pg.exec('RESET ROLE');await f.pg.exec('REVOKE kavosh_payment_ingest FROM kavosh_runtime');}
});
check('native broker independently rejects wrong target/mode/version, stale or future timestamps and mismatched resources atomically',async f=>{
 const now=Math.floor(Date.now()/1000),args:unknown[]=[f.c.connectionId,stripeConnectionTarget(f.c),'evt_native',now,now,'checkout.session.completed','checkout.session','cs_test_native',false,f.c.apiVersion,'1'.repeat(64),400],db=await f.database.connect();
 try{for(const [index,value,pattern] of [[1,'0'.repeat(64),/PAYMENT_CONNECTION_CHANGED/],[8,true,/PAYMENT_CONNECTION_CHANGED/],[9,'2024-01-01',/PAYMENT_CONNECTION_CHANGED/],[4,now+1000,/PAYMENT_TIMESTAMP_INVALID/],[4,now-1000,/PAYMENT_TIMESTAMP_INVALID/],[7,'cs_live_native',/check constraint/],[5,'payment_intent.succeeded',/check constraint/],[10,'invalid',/check constraint/]] as const){const v=[...args];v[index]=value;await assert.rejects(db.query('SELECT public.receive_payment_event($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',v),pattern);}}finally{db.release();if(!f.pg.runtime)await f.pg.exec('RESET ROLE');}
 for(const table of ['payment_webhook_inbox','payment_ingest_limits'])assert.equal((await f.pg.query('SELECT count(*)::integer n FROM public.'+table)).rows[0].n,0);
});
check('actual HTTP transport preserves original signed whitespace and Unicode; GET and query overrides cannot accept evidence',async f=>{
 const server=createServer(async(req,res)=>{try{
  const method=req.method??'GET',headers=new Headers();for(const [key,value] of Object.entries(req.headers))if(value!==undefined)headers.set(key,Array.isArray(value)?value.join(','):value);
  const response=await f.receive(new Request('http://127.0.0.1'+req.url,{method,headers,...(method==='GET'?{}:{body:Readable.toWeb(req) as ReadableStream<Uint8Array>,duplex:'half'})}),f.c.connectionId);
  res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));
 }catch{res.writeHead(500);res.end();}finally{if(!f.pg.runtime)await f.pg.exec('RESET ROLE');}});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));try{
  const address=server.address();assert.ok(address&&typeof address==='object');const url='http://127.0.0.1:'+address.port+'/api/webhooks/stripe/'+f.c.connectionId,p=paymentEvent(),bytes=Buffer.from(JSON.stringify({...p,description:'PRIVATE 中文 français'},null,2)),headers={'content-type':'application/json','stripe-signature':stripeHeader(bytes)};
  assert.equal((await fetch(url,{method:'POST',headers,body:bytes})).status,200);assert.equal((await fetch(url,{method:'POST',headers,body:bytes})).status,200);
  assert.equal((await fetch(url,{method:'GET'})).status,405);assert.equal((await fetch(url+'?paid=true',{method:'POST',headers,body:bytes})).status,400);
  const rows=(await f.pg.query('SELECT * FROM public.payment_webhook_inbox')).rows;assert.equal(rows.length,1);assert.equal(rows[0].payload_bytes,bytes.length);assert.doesNotMatch(JSON.stringify(rows),/PRIVATE|中文|français/);
 }finally{server.closeAllConnections();await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));}
});
check('operator command is idempotent, pins school/account identity and never calls a provider or discloses secrets',async f=>{
 const selected=paymentConnection(f.a),call=promisify(execFile),base=process.env.TEST_DATABASE_URL?new URL(process.env.TEST_DATABASE_URL):null;
 // The embedded engine has no server to connect the operator process to.
 if(!base)return;
 base.pathname='/'+(await f.pg.query<{name:string}>('SELECT current_database() name')).rows[0].name;
 const env={...process.env,MIGRATION_DATABASE_URL:base.toString(),DATABASE_SSL_MODE:'disable',STRIPE_WEBHOOK_CONNECTIONS:JSON.stringify([selected])},args=['--import','tsx','scripts/register-payment-webhook.ts',selected.connectionId,'--enable'];
 const before=(await f.pg.query('SELECT count(*)::integer n FROM public.outbox_events')).rows[0].n;
 for(let i=0;i<2;i++){const r=await call(process.execPath,args,{env});assert.match(r.stdout,/No provider call, charge or financial posting performed/);assert.doesNotMatch(r.stdout+r.stderr,/whsec_|postgresql/);}
 assert.equal((await f.pg.query('SELECT enabled FROM public.payment_connections WHERE id=$1',[selected.connectionId])).rows[0].enabled,true);assert.equal((await f.pg.query('SELECT count(*)::integer n FROM public.outbox_events')).rows[0].n,Number(before)+1);
 await assert.rejects(call(process.execPath,args,{env:{...env,STRIPE_WEBHOOK_CONNECTIONS:JSON.stringify([{...selected,academyId:f.b}])}}),error=>{assert.ok(error&&typeof error==='object'&&'stderr'in error);assert.match(String(error.stderr),/registration failed/);assert.doesNotMatch(String(error.stderr),/whsec_|postgresql|acct_/);return true;});
 assert.equal((await f.pg.query('SELECT academy_id FROM public.payment_connections WHERE id=$1',[selected.connectionId])).rows[0].academy_id,f.a);
});
if(process.env.TEST_DATABASE_URL)check('a committed school suspension or connection disable defeats an already waiting authenticated delivery',async f=>{
 for(const [sql,id] of [['UPDATE public.payment_connections SET enabled=false WHERE id=$1',f.c.connectionId],["UPDATE public.academies SET status='suspended' WHERE id=$1",f.a]] as const){
  await f.pg.exec('BEGIN');let pending:ReturnType<typeof f.send>|undefined,open=true;try{
   await f.pg.query(sql,[id]);pending=f.send();let waiting=false;
   for(let i=0;i<100;i++){await f.pg.query('SELECT pg_stat_clear_snapshot()');if((await f.pg.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND wait_event_type='Lock'")).rows.length){waiting=true;break;}await delay(5);}assert.equal(waiting,true);
   await f.pg.exec('COMMIT');open=false;assert.equal((await pending).response.status,503);assert.equal((await f.pg.query('SELECT count(*)::integer n FROM public.payment_webhook_inbox')).rows[0].n,0);
  }finally{if(open)await f.pg.exec('ROLLBACK');await Promise.allSettled([pending]);}
  await f.pg.query('UPDATE public.payment_connections SET enabled=true WHERE id=$1',[f.c.connectionId]);
 }
});
if(process.env.TEST_DATABASE_URL)check('eight real concurrent authenticated retries persist one event and one notice without any receipt',async f=>{
 const p=paymentEvent(),start=performance.now(),r=await Promise.all(Array.from({length:8},()=>f.send(p)));for(const v of r)assert.equal(v.response.status,200,JSON.stringify(v.body));
 assert.equal((await f.pg.query('SELECT count(*)::integer n FROM public.payment_webhook_inbox')).rows[0].n,1);assert.equal((await f.pg.query('SELECT count(*)::integer n FROM public.outbox_events')).rows[0].n,1);assert.equal((await f.pg.query('SELECT count(*)::integer n FROM public.tuition_receipts')).rows[0].n,0);
 console.log(JSON.stringify({measurement:'synthetic-payment-webhook-retries',requests:8,poolMaximum:4,elapsedMs:Math.ceil(performance.now()-start),events:1,receipts:0,liveProviderRequests:0}));
});
