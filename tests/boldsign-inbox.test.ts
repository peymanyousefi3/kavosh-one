import assert from 'node:assert/strict';
import { createHash,createHmac,randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { readFile } from 'node:fs/promises';
import { upgradeToCurrent } from './migration-upgrade.ts';
import { operationsFixture } from './operations-fixture.ts';
import { createBoldSignWebhook,assertSignatureIngestRole } from '../src/integrations/boldsign-inbox.ts';
import { configuredBoldSignWebhook,signatureConnectionTarget,type WebhookConnection } from '../src/integrations/boldsign-webhook-config.ts';
import { assertRuntimeRole,type Database,type Connection } from '../src/core/database.ts';

const secret='synthetic-endpoint-specific-secret-123456789';
async function fixture(){
 const f=await operationsFixture(),c:WebhookConnection={connectionId:randomUUID(),academyId:f.a,region:'CA',environment:'Test',clientId:null,secrets:[secret]},foreign:WebhookConnection={...c,connectionId:randomUUID(),academyId:f.b,secrets:[secret+'-foreign']};
 for(const connection of [c,foreign])await f.pg.query('INSERT INTO public.signature_connections(id,academy_id,region,environment,client_id,enabled) VALUES($1,$2,$3,$4,$5,true)',[connection.connectionId,connection.academyId,connection.region,connection.environment,connection.clientId]);
 let connections=0;const db:Database={async connect(){connections++;
  if(f.pg.runtime){const connection=await f.pg.runtime.connect();await connection.query('SET ROLE kavosh_signature_ingest');return connection;}
  await f.pg.exec('SET ROLE kavosh_signature_ingest');return {async query<Row>(sql:string,params?:unknown[]){return f.pg.query<Row>(sql,params);},release(){}};
 }};
 const receive=createBoldSignWebhook(db,id=>[c,foreign].find(v=>v.connectionId===id)??null);
 const payload=(extra:Record<string,unknown>={})=>({event:{id:randomUUID(),created:Math.floor(Date.now()/1000),eventType:'Completed',environment:'Test'},data:{object:'document',documentId:randomUUID(),status:'Completed',signerDetails:[{signerEmail:'PRIVATE@example.test',privateMessage:'PRIVATE SIGNER BODY'}]},...extra});
 async function send(value:unknown,options:{connection?:WebhookConnection;bytes?:Uint8Array;header?:string;method?:string;extraHeaders?:Record<string,string>;query?:string;receiver?:ReturnType<typeof createBoldSignWebhook>}={}){
  const selected=options.connection??c,bytes=options.bytes??Buffer.from(JSON.stringify(value)),signed=Math.floor(Date.now()/1000),signature=createHmac('sha256',selected.secrets[0]).update(signed+'.').update(bytes).digest('hex');
  try{const response=await (options.receiver??receive)(new Request('https://academy.example/api/webhooks/boldsign/'+selected.connectionId+(options.query??''),{method:options.method??'POST',headers:{'content-type':'application/json','x-boldsign-signature':options.header??`t=${signed},s0=${signature}`,...options.extraHeaders},body:bytes as BodyInit}),selected.connectionId);return {response,body:await response.json()};}
  finally{if(!f.pg.runtime)await f.pg.exec('RESET ROLE');}
 }
 return {...f,c,foreign,db,receive,payload,send,get connections(){return connections;}};
}
type Fixture=Awaited<ReturnType<typeof fixture>>;
function check(name:string,run:(f:Fixture)=>Promise<void>){test(name,async()=>{const f=await fixture();try{await run(f);}finally{await f.pg.close();}});}
check('signed provider delivery persists minimal tenant-bound evidence and one durable event but cannot establish admission',async f=>{
 const payload=f.payload(),bytes=Buffer.from(JSON.stringify(payload)),r=await f.send(payload);assert.equal(r.response.status,200,JSON.stringify(r.body));assert.deepEqual(r.body,{received:true});assert.equal(r.response.headers.get('cache-control'),'no-store');
 const stored=(await f.pg.query('SELECT * FROM public.signature_webhook_inbox')).rows;assert.equal(stored.length,1);assert.equal(stored[0].academy_id,f.a);assert.equal(stored[0].connection_id,f.c.connectionId);assert.equal(stored[0].event_id,payload.event.id);assert.equal(stored[0].resource_id,payload.data.documentId);assert.equal(stored[0].payload_sha256,createHash('sha256').update(bytes).digest('hex'));assert.equal(stored[0].payload_bytes,bytes.length);
 assert.ok(!JSON.stringify(stored).includes('PRIVATE'));assert.equal('eligible'in stored[0],false);assert.equal((await f.pg.query("SELECT count(*)::integer AS n FROM public.outbox_events WHERE event_type='signature.webhook.received'")).rows[0].n,1);
 assert.equal((await f.request('finance/journals')).body.data.length,0);assert.equal((await f.pg.query('SELECT count(*)::integer AS n FROM public.signature_webhook_conflicts')).rows[0].n,0);
});
check('bound-only account callback acknowledges unrelated events without retaining their identities and still applies the shared request budget',async f=>{
 f.c.connectionId=randomUUID();await f.pg.query("INSERT INTO public.signature_connections(id,academy_id,region,environment,enabled,bound_documents_only,max_events_per_minute) VALUES($1,$2,'CA','Test',true,true,1)",[f.c.connectionId,f.a]);
 const event=f.payload(),r=await f.send(event);assert.equal(r.response.status,200,JSON.stringify(r.body));assert.deepEqual(r.body,{received:true});
 for(const table of ['signature_webhook_inbox','signature_webhook_conflicts'])assert.equal((await f.pg.query('SELECT * FROM public.'+table)).rows.length,0);
 assert.equal((await f.pg.query("SELECT * FROM public.outbox_events WHERE event_type LIKE 'signature.webhook.%'")).rows.length,0);
 await f.pg.query("UPDATE public.signature_ingest_limits SET window_started=date_trunc('minute',clock_timestamp())+interval '1 minute',attempts=1 WHERE connection_id=$1",[f.c.connectionId]);assert.equal((await f.send(event)).response.status,429);
});
test('actual388to389 preserves existing callback records and broker authority without broadening ingest access or changing old stream semantics',async()=>{
 const f=await operationsFixture({throughSchema:388});try{
  const c={connectionId:randomUUID(),academyId:f.a,region:'CA' as const,environment:'Test' as const,clientId:null},now=Math.floor(Date.now()/1000),event=randomUUID();
  await f.pg.query("INSERT INTO public.signature_connections(id,academy_id,region,environment,enabled) VALUES($1,$2,'CA','Test',true)",[c.connectionId,f.a]);
  const receive=async(id:string)=>f.pg.query<{outcome:string}>('SELECT public.receive_signature_event($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) outcome',[c.connectionId,signatureConnectionTarget(c),id,now,now,'Test',null,'Completed','document',randomUUID(),'Completed','b'.repeat(64),400]);
  assert.equal((await receive(event)).rows[0].outcome,'recorded');
  const snapshot=async()=> (await f.pg.query("SELECT jsonb_build_object('inbox',(SELECT jsonb_agg(to_jsonb(i)) FROM public.signature_webhook_inbox i),'events',(SELECT jsonb_agg(to_jsonb(e) ORDER BY id) FROM public.outbox_events e)) data")).rows;
  const identity=async()=> (await f.pg.query("SELECT oid,proowner,proacl,proconfig FROM pg_proc WHERE oid='public.receive_signature_event(uuid,text,uuid,bigint,bigint,text,uuid,text,text,uuid,text,text,integer)'::regprocedure")).rows;
  const before=await snapshot(),authority=await identity();await f.pg.exec(await readFile(new URL('../db/migrations/389_signature_webhook_retention.sql',import.meta.url),'utf8'));await upgradeToCurrent(f.pg);
  assert.deepEqual(await snapshot(),before);assert.deepEqual(await identity(),authority);assert.equal((await f.pg.query('SELECT bound_documents_only FROM public.signature_connections WHERE id=$1',[c.connectionId])).rows[0].bound_documents_only,false);
  assert.equal((await receive(randomUUID())).rows[0].outcome,'recorded');await f.pg.exec('SET ROLE kavosh_signature_ingest');try{await assertSignatureIngestRole({query:f.pg.query.bind(f.pg),release(){}});await assert.rejects(f.pg.query('SELECT * FROM public.signature_transport_receipts'),/permission denied/i);}finally{await f.pg.exec('RESET ROLE');}
 }finally{await f.pg.close();}
});
check('valid duplicate deliveries are idempotent and conflicting authenticated bytes retain the original with one critical alert',async f=>{
 const p=f.payload();assert.equal((await f.send(p)).response.status,200);assert.equal((await f.send(p)).response.status,200);
 const changed={...p,data:{...p.data,status:'Revoked'}};for(let i=0;i<2;i++)assert.equal((await f.send(changed)).response.status,200);
 assert.equal((await f.pg.query('SELECT provider_status FROM public.signature_webhook_inbox')).rows[0].provider_status,'Completed');assert.equal((await f.pg.query('SELECT count(*)::integer AS n FROM public.signature_webhook_conflicts')).rows[0].n,1);
 const events=(await f.pg.query('SELECT event_type FROM public.outbox_events ORDER BY event_type')).rows.map(r=>r.event_type);assert.deepEqual(events,['signature.webhook.conflict.critical','signature.webhook.received']);
});
check('signature, environment, application identity and event-header checks precede all database access',async f=>{
 const p=f.payload();for(const [value,options,status] of [[p,{header:'t=1,s0='+'0'.repeat(64)},401],[{...p,event:{...p.event,environment:'Live'}},{},400],[{...p,event:{...p.event,clientId:randomUUID()}},{},400],[p,{extraHeaders:{'x-boldsign-event':'Signed'}},400],[p,{query:'?academyId='+f.b},400],[p,{bytes:Buffer.from([0xff])},400]] as const){const r=await f.send(value,options);assert.equal(r.response.status,status,JSON.stringify(r.body));}
 assert.equal(f.connections,0);assert.equal((await f.pg.query('SELECT count(*)::integer AS n FROM public.signature_webhook_inbox')).rows[0].n,0);
});
check('unsigned provider verification is a strict side-effect-free probe, never a data-event bypass',async f=>{
 const event={id:randomUUID(),created:Math.floor(Date.now()/1000),eventType:'Verification',environment:'Test'},probe={event};
 const okay=await f.send(probe,{header:'invalid',extraHeaders:{'x-boldsign-event':'Verification'}});assert.equal(okay.response.status,200,JSON.stringify(okay.body));
 for(const value of [{...probe,data:{object:'document',documentId:randomUUID()}},{event:{...event,eventType:'Completed'}},{event:{...event,clientId:randomUUID()}}])assert.equal((await f.send(value,{extraHeaders:{'x-boldsign-event':'Verification'}})).response.status,400);
 assert.equal((await f.send(probe)).response.status,400);assert.equal(f.connections,0);assert.equal((await f.pg.query('SELECT count(*)::integer AS n FROM public.outbox_events')).rows[0].n,0);
});
check('registered target drift, disabled connections and inactive schools cannot accept even authentic callbacks',async f=>{
 const p=f.payload();await assert.rejects(f.pg.query("UPDATE public.signature_connections SET region='EU' WHERE id=$1",[f.c.connectionId]),/SIGNATURE_CONNECTION_IDENTITY_IMMUTABLE/);f.c.region='EU';assert.equal((await f.send(p)).response.status,503);f.c.region='CA';
 await f.pg.query('UPDATE public.signature_connections SET enabled=false WHERE id=$1',[f.c.connectionId]);assert.equal((await f.send(p)).response.status,503);
 await f.pg.query('UPDATE public.signature_connections SET enabled=true WHERE id=$1',[f.c.connectionId]);await f.pg.query("UPDATE public.academies SET status='suspended' WHERE id=$1",[f.a]);assert.equal((await f.send(p)).response.status,503);
 await f.pg.query("UPDATE public.academies SET status='read_only' WHERE id=$1",[f.a]);assert.equal((await f.send(p)).response.status,200);assert.equal((await f.pg.query('SELECT count(*)::integer AS n FROM public.signature_webhook_inbox')).rows[0].n,1);
});
check('durable per-connection rate limits are shared by handler instances without affecting another school',async f=>{
 await f.pg.query('UPDATE public.signature_connections SET max_events_per_minute=2 WHERE id=$1',[f.c.connectionId]);for(let i=0;i<2;i++)assert.equal((await f.send(f.payload())).response.status,200);
 // Pin an exhausted future window to avoid a wall-clock minute-boundary race
 // and also verify that moving the clock backwards cannot reopen the budget.
 await f.pg.query("UPDATE public.signature_ingest_limits SET window_started=date_trunc('minute',clock_timestamp())+interval '1 minute',attempts=2 WHERE connection_id=$1",[f.c.connectionId]);
 const another=createBoldSignWebhook(f.db,id=>id===f.c.connectionId?f.c:null),limited=await f.send(f.payload(),{receiver:another});assert.equal(limited.response.status,429,JSON.stringify(limited.body));assert.equal(limited.body.error.code,'WEBHOOK_RATE_LIMIT');assert.equal((await f.send(f.payload(),{connection:f.foreign})).response.status,200);
 await f.pg.query("UPDATE public.signature_ingest_limits SET window_started=window_started-interval '3 minutes' WHERE connection_id=$1",[f.c.connectionId]);assert.equal((await f.send(f.payload())).response.status,200);
 assert.equal((await f.pg.query('SELECT count(*)::integer AS n FROM public.signature_ingest_limits')).rows[0].n,2);
});
check('outbox failure rolls back inbox and budget so a retry can record exactly once',async f=>{
 const p=f.payload();await f.pg.exec('REVOKE INSERT ON public.outbox_events FROM kavosh_signature_policy');try{const r=await f.send(p);assert.equal(r.response.status,503);assert.doesNotMatch(JSON.stringify(r.body),/permission|signature_policy|postgres|PRIVATE/);}finally{await f.pg.exec('GRANT INSERT ON public.outbox_events TO kavosh_signature_policy');}
 assert.equal((await f.pg.query('SELECT count(*)::integer AS n FROM public.signature_webhook_inbox')).rows[0].n,0);assert.equal((await f.pg.query('SELECT count(*)::integer AS n FROM public.signature_ingest_limits')).rows[0].n,0);assert.equal((await f.send(p)).response.status,200);
 const missingReceipt=createBoldSignWebhook({async connect(){const c=await f.db.connect();return {async query<Row>(sql:string,args?:unknown[]){const r=await c.query<Row>(sql,args);return sql.startsWith('SELECT public.receive_signature_event')?{...r,rows:[]}:r;},release(destroy?:boolean){c.release(destroy);}};}},()=>f.c);
 assert.equal((await f.send(f.payload(),{receiver:missingReceipt})).response.status,503);assert.equal((await f.pg.query('SELECT count(*)::integer AS n FROM public.signature_webhook_inbox')).rows[0].n,1);assert.equal((await f.pg.query('SELECT attempts FROM public.signature_ingest_limits')).rows[0].attempts,1);
});
check('ingest has no direct table, identity, business or runtime access and runtime cannot fabricate provider evidence',async f=>{
 await f.send(f.payload());await f.pg.exec('SET ROLE kavosh_signature_ingest');try{
  for(const sql of ['SELECT * FROM public.signature_webhook_inbox','SELECT * FROM public.signature_connections','SELECT * FROM public.people','SELECT * FROM identity."user"','SELECT * FROM auth_private.credentials',"UPDATE public.signature_webhook_inbox SET provider_status='Completed'",'DELETE FROM public.signature_webhook_inbox'])await assert.rejects(f.pg.exec(sql),/permission denied/i);
 }finally{await f.pg.exec('RESET ROLE');}
 await f.pg.exec('SET ROLE kavosh_runtime');try{
  await f.pg.query("SELECT set_config('app.academy_id',$1,false)",[f.a]);await assert.rejects(f.pg.exec('SELECT * FROM public.signature_webhook_inbox'),/permission denied/i);
  await assert.rejects(f.pg.exec("SELECT public.receive_signature_event(NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL)"),/permission denied/i);
 }finally{await f.pg.exec('RESET ROLE');}
});
check('native intake independently enforces registered stream, transport freshness and required document identity with no partial budget',async f=>{
 const now=Math.floor(Date.now()/1000),base:unknown[]=[f.c.connectionId,signatureConnectionTarget(f.c),randomUUID(),now,now,'Test',null,'Completed','document',randomUUID(),'Completed','1'.repeat(64),500];
 const connection=await f.db.connect();try{
  for(const [index,value,pattern] of [[1,'0'.repeat(64),/SIGNATURE_CONNECTION_CHANGED/],[5,'Live',/SIGNATURE_CONNECTION_CHANGED/],[6,randomUUID(),/SIGNATURE_CONNECTION_CHANGED/],[4,now-1000,/SIGNATURE_TIMESTAMP_INVALID/],[9,null,/check constraint/i],[7,'Verification',/check constraint/i]] as const){const args=[...base];args[index]=value;await assert.rejects(connection.query('SELECT public.receive_signature_event($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)',args),pattern);}
 }finally{connection.release();await f.pg.exec('RESET ROLE');}
 assert.equal((await f.pg.query('SELECT count(*)::integer AS n FROM public.signature_webhook_inbox')).rows[0].n,0);assert.equal((await f.pg.query('SELECT count(*)::integer AS n FROM public.signature_ingest_limits')).rows[0].n,0);
});
check('webhook rejects excess bytes, compressed claims, malformed fields and unsafe configuration without disclosing supplied data',async f=>{
 for(const [options,status] of [[{bytes:Buffer.alloc(1048577,32)},413],[{extraHeaders:{'content-encoding':'gzip'}},415],[{extraHeaders:{'content-type':'text/plain'}},415]] as const)assert.equal((await f.send(f.payload(),options)).response.status,status);
 for(const value of [{event:{},data:{}},{...f.payload(),data:{object:'document'}},{...f.payload(),data:{object:'document',documentId:randomUUID(),status:'bad\nstatus'}}])assert.equal((await f.send(value)).response.status,400);
 assert.equal(f.connections,0);
 const disabled=createBoldSignWebhook({async connect(){assert.fail('disabled must not access DB');}},()=>null),r=await disabled(new Request('https://academy.example/callback',{method:'POST'}),f.c.connectionId);assert.equal(r.status,503);assert.doesNotMatch(await r.text(),new RegExp(secret));
 const unavailable=createBoldSignWebhook({async connect(){throw new TypeError(secret);}},()=>f.c),failed=await f.send(f.payload(),{receiver:unavailable});assert.equal(failed.response.status,503);assert.doesNotMatch(JSON.stringify(failed.body),new RegExp(secret));
});
test('webhook connection registry is explicit, disabled by default and forbids endpoint/shared-key ambiguity',()=>{
 const c:WebhookConnection={connectionId:randomUUID(),academyId:randomUUID(),region:'CA',environment:'Live',clientId:null,secrets:[secret]};
 assert.equal(configuredBoldSignWebhook(c.connectionId,{}),null);const env={BOLDSIGN_WEBHOOK_ENABLED:'true',BOLDSIGN_WEBHOOK_CONNECTIONS:JSON.stringify([c])};assert.deepEqual(configuredBoldSignWebhook(c.connectionId,env),c);
 assert.equal(configuredBoldSignWebhook(randomUUID(),env),null);assert.equal(signatureConnectionTarget(c),signatureConnectionTarget({...c,secrets:['other']} as WebhookConnection));
 for(const entries of [[c,c],[c,{...c,connectionId:randomUUID()}],[{...c,region:'URL'}],[{...c,apiKey:'forbidden'}],[{...c,secrets:[]}],[{...c,secrets:[secret,secret]}],[{...c,secrets:['<provider-issued signing secret>']}]])assert.throws(()=>configuredBoldSignWebhook(c.connectionId,{...env,BOLDSIGN_WEBHOOK_CONNECTIONS:JSON.stringify(entries)}),{code:'BOLDSIGN_WEBHOOK_NOT_CONFIGURED'});
});
check('combined service memberships cannot turn the webhook role into a business or identity account',async f=>{
 for(const role of ['kavosh_runtime','kavosh_identity','kavosh_file_worker','kavosh_signature_policy','pg_execute_server_program','pg_read_server_files','pg_use_reserved_connections']){
  await f.pg.exec('GRANT '+role+' TO kavosh_signature_ingest');try{
   const connection=await f.db.connect();try{await assert.rejects(assertSignatureIngestRole(connection),/UNSAFE_SIGNATURE_INGEST_ROLE/);}finally{connection.release();await f.pg.exec('RESET ROLE');}
  }finally{await f.pg.exec('REVOKE '+role+' FROM kavosh_signature_ingest');}
 }
 await f.pg.exec('GRANT kavosh_signature_ingest TO kavosh_runtime');try{
  await f.pg.exec('SET ROLE kavosh_runtime');const connection:Connection={async query<Row>(sql:string,params?:unknown[]){return f.pg.query<Row>(sql,params);},release(){}};await assert.rejects(assertRuntimeRole(connection),/UNSAFE_DATABASE_ROLE/);
 }finally{await f.pg.exec('RESET ROLE');await f.pg.exec('REVOKE kavosh_signature_ingest FROM kavosh_runtime');}
});
check('direct table, column and unrelated privileged-function grants are rejected even without a mixed role',async f=>{
 const grants=['SELECT ON public.people','SELECT(name) ON public.people','INSERT(name) ON public.people','UPDATE(name) ON public.people','DELETE ON public.finance_journals','TRUNCATE ON public.signature_webhook_inbox','MAINTAIN ON public.people','EXECUTE ON FUNCTION public.claim_file_inspection(uuid[],uuid,integer)'];
 for(const grant of grants){
  await f.pg.exec('GRANT '+grant+' TO kavosh_signature_ingest');try{const c=await f.db.connect();try{await assert.rejects(assertSignatureIngestRole(c),/UNSAFE_SIGNATURE_INGEST_ROLE/);}finally{c.release();await f.pg.exec('RESET ROLE');}}
  finally{await f.pg.exec('REVOKE '+grant+' FROM kavosh_signature_ingest');}
 }
 assert.equal((await f.send(f.payload())).response.status,200,'removing excessive grants restores legitimate intake');
});
check('a stalled or abandoned webhook body times out and cancels without holding a database connection',async f=>{
 let cancelled=false;const response=await f.receive(new Request('https://academy.example/callback',{method:'POST',headers:{'content-type':'application/json'},body:new ReadableStream({cancel(){cancelled=true;}}),duplex:'half'} as RequestInit),f.c.connectionId);
 assert.equal(response.status,408);assert.equal((await response.json()).error.code,'WEBHOOK_BODY_TIMEOUT');assert.equal(cancelled,true);assert.equal(f.connections,0);
 const stop=new AbortController();stop.abort();let abandoned=false;const aborted=await f.receive(new Request('https://academy.example/callback',{method:'POST',headers:{'content-type':'application/json'},signal:stop.signal,body:new ReadableStream({cancel(){abandoned=true;}}),duplex:'half'} as RequestInit),f.c.connectionId);assert.equal(aborted.status,408);assert.equal((await aborted.json()).error.code,'WEBHOOK_BODY_CANCELLED');assert.equal(abandoned,true);assert.equal(f.connections,0);
});
check('actual loopback HTTP delivery preserves signed original bytes, Unicode and duplicate handling without session credentials',async f=>{
 const server=createServer(async(incoming,outgoing)=>{
  try{
   const request=new Request('http://127.0.0.1'+incoming.url,{method:incoming.method,headers:incoming.headers as Record<string,string>,body:Readable.toWeb(incoming) as ReadableStream<Uint8Array>,duplex:'half'} as RequestInit);
   const response=await f.receive(request,new URL(request.url).pathname.split('/').at(-1)!);if(!f.pg.runtime)await f.pg.exec('RESET ROLE');outgoing.writeHead(response.status,Object.fromEntries(response.headers));outgoing.end(Buffer.from(await response.arrayBuffer()));
  }catch{outgoing.writeHead(500);outgoing.end();}
 });
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 try{
  const address=server.address();assert.ok(address&&typeof address!=='string');const bytes=Buffer.from(JSON.stringify({...f.payload(),privateNote:'机器人 — Montréal 🔒'},null,2)+'\n'),signed=Math.floor(Date.now()/1000),digest=createHmac('sha256',secret).update(signed+'.').update(bytes).digest('hex');
  const url='http://127.0.0.1:'+address.port+'/api/webhooks/boldsign/'+f.c.connectionId;
  for(let i=0;i<2;i++){const response=await fetch(url,{method:'POST',headers:{'content-type':'application/json','x-boldsign-signature':`t=${signed},s0=${digest}`},body:bytes});assert.equal(response.status,200);assert.deepEqual(await response.json(),{received:true});}
  const forged=await fetch(url,{method:'POST',headers:{'content-type':'application/json','x-boldsign-signature':`t=${signed},s0=${'0'.repeat(64)}`},body:bytes});assert.equal(forged.status,401);await forged.arrayBuffer();
  const rows=(await f.pg.query('SELECT payload_sha256 FROM public.signature_webhook_inbox')).rows;assert.equal(rows.length,1);assert.equal(rows[0].payload_sha256,createHash('sha256').update(bytes).digest('hex'));
 }finally{await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
});
if(process.env.TEST_DATABASE_URL)check('operator command registers an immutable target, enables ingestion and reports conflicting school remaps without leaking secrets',async f=>{
 const database=(await f.pg.query<{name:string}>('SELECT current_database() AS name')).rows[0].name;assert.match(database,/^kavosh_test_[a-f0-9]{32}$/);
 const url=new URL(process.env.TEST_DATABASE_URL!);url.pathname='/'+database;const c={...f.c,connectionId:randomUUID()},run=promisify(execFile);
 const env={PATH:process.env.PATH,NODE_ENV:'test' as const,DATABASE_SSL_MODE:'disable',MIGRATION_DATABASE_URL:url.toString(),BOLDSIGN_WEBHOOK_CONNECTIONS:JSON.stringify([c])};
 const invoke=(args:string[],extra={})=>run(process.execPath,['--import','tsx','scripts/register-signature-webhook.ts',c.connectionId,...args],{env:{...env,...extra}});
 assert.doesNotMatch((await invoke([])).stdout,new RegExp(secret));assert.equal((await f.pg.query('SELECT enabled FROM public.signature_connections WHERE id=$1',[c.connectionId])).rows[0].enabled,false);
 await invoke(['--enable']);assert.equal((await f.pg.query('SELECT enabled FROM public.signature_connections WHERE id=$1',[c.connectionId])).rows[0].enabled,true);
 const before=(await f.pg.query('SELECT count(*)::integer AS n FROM public.outbox_events')).rows[0].n;await invoke(['--enable']);assert.equal((await f.pg.query('SELECT count(*)::integer AS n FROM public.outbox_events')).rows[0].n,before,'rerunning an unchanged setup must not generate a false critical change');
 await assert.rejects(invoke(['--enable'],{BOLDSIGN_WEBHOOK_CONNECTIONS:JSON.stringify([{...c,academyId:f.b}])}),(error:unknown)=>{const e=error as {stderr?:string};assert.doesNotMatch(e.stderr??'',new RegExp(secret));return true;});
 assert.equal((await f.pg.query('SELECT academy_id FROM public.signature_connections WHERE id=$1',[c.connectionId])).rows[0].academy_id,f.a);assert.equal((await f.pg.query('SELECT count(*)::integer AS n FROM public.outbox_events')).rows[0].n,before);
 f.c.connectionId=c.connectionId;assert.equal((await f.send(f.payload())).response.status,200);
});
if(process.env.TEST_DATABASE_URL)check('one hundred concurrent retries deduplicate while one hundred distinct signed events all persist through the real pool',async f=>{
 const before=(await f.pg.query<{minute:string}>("SELECT date_trunc('minute',clock_timestamp())::text AS minute")).rows[0].minute,p=f.payload(),times:number[]=[];
 await Promise.all(Array.from({length:100},async()=>{const start=performance.now(),r=await f.send(p);times.push(performance.now()-start);assert.equal(r.response.status,200,JSON.stringify(r.body));}));
 assert.equal((await f.pg.query('SELECT count(*)::integer AS n FROM public.signature_webhook_inbox')).rows[0].n,1);assert.equal((await f.pg.query('SELECT count(*)::integer AS n FROM public.outbox_events')).rows[0].n,1);
 const budget=(await f.pg.query<{minute:string;attempts:number}>('SELECT window_started::text AS minute,attempts FROM public.signature_ingest_limits')).rows[0];if(budget.minute===before)assert.equal(budget.attempts,100);else assert.ok(budget.attempts>=1&&budget.attempts<=100,'real minute rollover resets only the bounded current-window counter');
 const writes:number[]=[];await Promise.all(Array.from({length:100},async()=>{const start=performance.now(),r=await f.send(f.payload());writes.push(performance.now()-start);assert.equal(r.response.status,200,JSON.stringify(r.body));}));
 assert.equal((await f.pg.query('SELECT count(*)::integer AS n FROM public.signature_webhook_inbox')).rows[0].n,101);assert.equal((await f.pg.query('SELECT count(*)::integer AS n FROM public.outbox_events')).rows[0].n,101);
 console.log(JSON.stringify({measurement:'synthetic-boldsign-authenticated-webhook',concurrencyPerPhase:100,poolMaximum:4,endpointConnections:1,retryResponses:100,retryPersistedEvents:1,retryP99Ms:Math.ceil(times.sort((a,b)=>a-b)[98]),distinctResponses:100,distinctPersistedEvents:100,distinctP99Ms:Math.ceil(writes.sort((a,b)=>a-b)[98]),finalInboxEvents:101,finalNotifications:101,liveProviderRequests:0}));
});
if(process.env.TEST_DATABASE_URL)check('connection and school disable serialize with real incoming webhooks and block acceptance after commit',async f=>{
 for(const [sql,id] of [['UPDATE public.signature_connections SET enabled=false WHERE id=$1',f.c.connectionId],["UPDATE public.academies SET status='suspended' WHERE id=$1",f.a]] as const){
  await f.pg.exec('BEGIN');let pending:ReturnType<typeof f.send>|undefined,open=true;try{
   await f.pg.query(sql,[id]);pending=f.send(f.payload());let waited=false;
   for(let i=0;i<150;i++){await f.pg.query('SELECT pg_stat_clear_snapshot()');if((await f.pg.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND wait_event_type='Lock'")).rows.length){waited=true;break;}await delay(5);}assert.equal(waited,true);
   await f.pg.exec('COMMIT');open=false;assert.equal((await pending).response.status,503);assert.equal((await f.pg.query('SELECT count(*)::integer AS n FROM public.signature_webhook_inbox')).rows[0].n,0);
  }finally{if(open)await f.pg.exec('ROLLBACK');await Promise.allSettled([pending]);}
  await f.pg.query('UPDATE public.signature_connections SET enabled=true WHERE id=$1',[f.c.connectionId]);
 }
});
