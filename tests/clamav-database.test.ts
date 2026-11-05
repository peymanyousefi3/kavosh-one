import assert from 'node:assert/strict';
import { createHash,randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { once } from 'node:events';
import { test } from 'node:test';
import { getClamdDatabase,scanWithFreshClamd } from '../src/integrations/clamav-database.ts';
import { clamdPeer,clamdVersionString as version } from './fixtures/clamd-peer.ts';
import { inspectStoredFile } from '../src/files/inspection-worker.ts';
import { privateR2 } from '../src/integrations/r2.ts';

// Synthetic protocol peer, NOT signed official databases, deployment proof or
// a statement that arbitrary files/PDFs are safe. Real engine gate is separate.
const bytes=Buffer.from('Synthetic freshness protocol input'),sha256=createHash('sha256').update(bytes).digest('hex');
const policy={timeZone:'UTC',maximumAgeSeconds:172800};
const reply=(text=version())=>Buffer.from(text+'\0');
const stableReply=reply();
async function peer(replies:ReadonlyArray<Buffer|null>,run:(p:Awaited<ReturnType<typeof clamdPeer>>)=>Promise<void>,mode='success'){
 const p=await clamdPeer(mode,replies);try{await run(p);}finally{await p.close();}
}
test('loaded database metadata uses the explicit real daemon zone,not client host/hub,including fractional-hour zones',async()=>{
 const created=Math.floor((Date.now()-60000)/1000)*1000;
 for(const zone of ['UTC','America/Toronto','Europe/Paris','Asia/Shanghai','Asia/Kathmandu'])await peer([reply(version(created,zone))],async p=>{
  const value=await getClamdDatabase(p.config,{...policy,timeZone:zone});
  assert.equal(Date.parse(value.databaseCreatedAt),created);assert.equal(value.databaseVersion,30001);assert.equal(value.engineVersion,'1.5.4');assert.equal(value.timeZone,zone);assert.equal(value.maximumAgeSeconds,172800);assert.ok(Date.parse(value.observedAt)>=created);assert.deepEqual(p.commands,['VERSION']);
  for(const key of ['safeToServe','databaseSignatureVerified','configurationVerified','freshnessPersisted'])assert.equal(key in value,false);
 });
});
test('complete scan checks loaded metadata before and after exact bytes,without a second file read or invented engine pin',async()=>{
 const r=reply();await peer([r,r],async p=>{
  const source=Readable.from([bytes.subarray(0,5),bytes.subarray(5)]),result=await scanWithFreshClamd(p.config,policy,source,{bytes:bytes.length,sha256});
  assert.equal(result.verdict,'no_detection');assert.equal(result.bytes,bytes.length);assert.equal(result.sha256,sha256);assert.equal(result.database?.databaseVersion,30001);assert.ok(result.database?.observedBeforeAt);assert.deepEqual(p.commands,['VERSION','INSTREAM','VERSION']);assert.deepEqual(Buffer.concat(p.received),bytes);assert.equal(source.destroyed,true);
 });
});
test('metadata framing accepts fragmented bytes but rejects delayed data after the terminator;active cancellation closes the socket',async()=>{
 await peer([stableReply],async p=>{assert.equal((await getClamdDatabase(p.config,policy)).databaseVersion,30001);},'fragment');
 await peer([stableReply],async p=>{await assert.rejects(getClamdDatabase(p.config,policy),{code:'SCANNER_DATABASE_METADATA_INVALID',status:503});},'trailing-version');
 await peer([null],async p=>{
  const connected=once(p.server,'connection'),controller=new AbortController(),pending=getClamdDatabase(p.config,policy,controller.signal);await connected;controller.abort();
  await assert.rejects(pending,{code:'SCANNER_CANCELLED',status:503});assert.equal(p.connections(),1);
 });
});
test('missing,invalid,stale or future database metadata prevents byte streaming and releases source',async()=>{
 const current=version(),weekday=current.split('/')[2].slice(0,3),wrong=current.replace('/'+weekday+' ','/'+(weekday==='Sun'?'Mon':'Sun')+' ');
 for(const value of [Buffer.from('ClamAV 1.5.4\0'),Buffer.from('ClamAV 1.5.4'),reply('UNKNOWN COMMAND'),reply(current.replace('/30001/','/0/')),reply(current.replace('/30001/','/4294967296/')),reply(wrong),
  reply(current.replace(/:[0-9]{2}:[0-9]{2}/,':99:00')),reply('ClamAV 1.5.4/30001/Mon Feb 30 12:00:00 2026'),reply(current+'\n'),reply(current)+'unexpected',Buffer.alloc(4097,65),Buffer.from([0xff,0]),Buffer.concat([reply(),reply()])]){
  const wire=typeof value==='string'?Buffer.from(value):value;
  await peer([wire],async p=>{const source=Readable.from([bytes]);await assert.rejects(scanWithFreshClamd(p.config,policy,source,{bytes:bytes.length}),{code:'SCANNER_DATABASE_METADATA_INVALID',status:503});assert.deepEqual(p.commands,['VERSION']);assert.equal(p.received.length,0);assert.equal(source.destroyed,true);});
 }
 for(const at of [Date.now()-173000000,Date.now()+60000])await peer([reply(version(at))],async p=>{const source=Readable.from([bytes]);await assert.rejects(scanWithFreshClamd(p.config,policy,source,{bytes:bytes.length}),{code:'SCANNER_DATABASE_NOT_CURRENT',status:503});assert.equal(source.destroyed,true);assert.deepEqual(p.commands,['VERSION']);});
});
test('DST folds,gaps and a wrong weekday reject rather than guess an offset',async()=>{
 for(const stamp of ['Sun Nov  1 01:30:00 2026','Sun Mar  8 02:30:00 2026'])await peer([reply('ClamAV 1.5.4/30001/'+stamp)],async p=>{
  await assert.rejects(getClamdDatabase(p.config,{timeZone:'America/Toronto',maximumAgeSeconds:604800}),{code:'SCANNER_DATABASE_METADATA_INVALID',status:503});
 });
});
test('post-scan staleness,changed database/engine or missing health cannot yield successful no-detection evidence',async()=>{
 const before=reply();for(const after of [reply(version(Date.now()-60000,'UTC',30002)),reply(version(Date.now()-60000,'UTC',30001,'1.5.5')),reply(version(Date.now()-120000)),reply(version(Date.now()-173000000)),reply('ClamAV 1.5.4')])await peer([before,after],async p=>{
  const source=Readable.from([bytes]);await assert.rejects(scanWithFreshClamd(p.config,policy,source,{bytes:bytes.length}),error=>error instanceof Error&&/^SCANNER_DATABASE_/.test(error.message));assert.deepEqual(p.commands,['VERSION','INSTREAM','VERSION']);assert.deepEqual(Buffer.concat(p.received),bytes);assert.equal(source.destroyed,true);
 });
});
test('positive detection remains rejection and cannot disappear behind a later unavailable health request',async()=>{
 await peer([reply(),null],async p=>{const result=await scanWithFreshClamd(p.config,policy,Readable.from([bytes]),{bytes:bytes.length});assert.equal(result.verdict,'detected');assert.equal(result.database,null);assert.deepEqual(p.commands,['VERSION','INSTREAM']);},'detected');
});
test('strict operator zone,age,socket and input budgets reject before connections;selected configuration cannot mutate during IO',async()=>{
 await peer([stableReply,stableReply],async p=>{
  for(const bad of [{timeZone:undefined,maximumAgeSeconds:1},{...policy,timeZone:'Not/AZone'},{...policy,timeZone:'+01:00'},{...policy,maximumAgeSeconds:0},{...policy,maximumAgeSeconds:604801},{...policy,verified:true}]){
   const source=Readable.from([bytes]);await assert.rejects(scanWithFreshClamd(p.config,bad as typeof policy,source,{bytes:bytes.length}),{code:'SCANNER_DATABASE_POLICY_NOT_CONFIGURED',status:503});assert.equal(source.destroyed,true);
  }
  for(const socketPath of ['/tmp/./scanner.sock','/'+ '王'.repeat(40)])await assert.rejects(getClamdDatabase({...p.config,socketPath},policy),{code:'SCANNER_NOT_CONFIGURED',status:503});
  for(const value of [{bytes:0},{bytes:1000001},{bytes:bytes.length,sha256:'bad'}])await assert.rejects(scanWithFreshClamd(p.config,policy,Readable.from([bytes]),value),{code:'INVALID_SCAN_CLAIMS',status:400});
  assert.equal(p.connections(),0);
  const config={...p.config},selected={...policy},claims={bytes:bytes.length,sha256},source=Readable.from([bytes]),pending=scanWithFreshClamd(config,selected,source,claims);
  config.socketPath='/tmp/not-used.sock';selected.timeZone='Not/AZone';selected.maximumAgeSeconds=0;claims.bytes=1;claims.sha256='0'.repeat(64);
  assert.equal((await pending).sha256,sha256);assert.deepEqual(p.commands,['VERSION','INSTREAM','VERSION']);
 });
});
test('absolute overall deadline,cancellation and byte/hash failures close sources and do not start later phases',{timeout:3000},async()=>{
 for(const responses of [[null],[reply(),null]])await peer(responses,async p=>{
  const source=Readable.from([bytes]);await assert.rejects(scanWithFreshClamd({...p.config,timeoutMs:100},policy,source,{bytes:bytes.length}),{code:'SCANNER_TIMEOUT',status:503});assert.equal(source.destroyed,true);
 });
 await peer([reply()],async p=>{
  const controller=new AbortController();controller.abort();const source=Readable.from([bytes]);await assert.rejects(scanWithFreshClamd(p.config,policy,source,{bytes:bytes.length},controller.signal),{code:'SCANNER_CANCELLED',status:503});assert.equal(p.connections(),0);assert.equal(source.destroyed,true);
 });
 await peer([reply()],async p=>{const source=Readable.from([bytes]);await assert.rejects(scanWithFreshClamd(p.config,policy,source,{bytes:bytes.length,sha256:'0'.repeat(64)}),{code:'FILE_HASH_MISMATCH',status:409});assert.deepEqual(p.commands,['VERSION','INSTREAM']);assert.equal(source.destroyed,true);});
});
test('strict production inspection composition reads one object and rejects stale scanner data without fabricating publication or durable freshness proof',async()=>{
 const connection={accountId:'a'.repeat(32),jurisdiction:'default' as const,bucket:'synthetic-fresh-scan',accessKeyId:'synthetic-id',secretAccessKey:'synthetic-not-real-secret',maximumUploadBytes:1000},academyId=randomUUID();
 const store=privateR2(connection,academyId),storageTargetId=store.storageTargetId;store.close();
 const task={academyId,inspectionId:randomUUID(),fileId:randomUUID(),storageTargetId,leaseToken:randomUUID(),attemptNo:1,expectedBytes:bytes.length,expectedSha256:sha256,claimedMimeType:'text/plain'};
 for(const fresh of [true,false])await peer(fresh?[stableReply,stableReply]:[reply(version(Date.now()-173000000))],async p=>{
  let reads=0;const body=Readable.from([bytes]);
  const result=await inspectStoredFile(task,()=>connection,p.config,new AbortController().signal,5000,{async handle(){reads++;return {response:{statusCode:200,headers:{'content-length':String(bytes.length),'content-type':'application/octet-stream',etag:'"synthetic-fresh"'},body}};}},undefined,policy);
  assert.equal(reads,1);assert.equal(body.destroyed,true);assert.equal(result.outcome,fresh?'no_detection':'unavailable');if(result.outcome==='unavailable')assert.equal(result.reason,'SCANNER_UNAVAILABLE');assert.deepEqual(p.commands,fresh?['VERSION','INSTREAM','VERSION']:['VERSION']);
  for(const key of ['safeToServe','downloadUrl','freshnessPersisted','scannerDatabase'])assert.equal(key in result,false);
 });
 let reads=0;const handler={async handle(){reads++;throw new Error('INVALID_POLICY_MUST_NOT_REACH_STORAGE');}};
 for(const invalid of [null,false,{}, {...policy,timeZone:'Not/AZone'}])assert.deepEqual(await inspectStoredFile(task,()=>connection,{socketPath:'/tmp/not-used.sock',maximumBytes:1000,timeoutMs:1000},new AbortController().signal,5000,handler,undefined,invalid as typeof policy),{outcome:'unavailable',reason:'TARGET_UNAVAILABLE'});
 assert.equal(reads,0);
});
