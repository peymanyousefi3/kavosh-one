import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomUUID,createHash} from 'node:crypto';
import {mkdtemp,realpath,open,readFile,unlink,rmdir} from 'node:fs/promises';
import type {FileHandle} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import type pg from 'pg';
import {captureMediaReferencePlan} from '../src/operations/media-reference-plan.ts';
import {expectedSchemaRevision,type Database} from '../src/core/database.ts';
import {fixture,hash,target} from './file-copy-fixture.ts';
import {processOneCopy} from '../src/files/copy-worker.ts';

const binding={databaseBackupId:randomUUID(),archiveSha256:'a'.repeat(64),schemaRevision:expectedSchemaRevision};
test('reference plans require a matching unfiltered repeatable read-only snapshot and never expose database errors',async()=>{
 for(const patch of [{isolation:'read committed'},{readOnly:'off'},{unfiltered:false},{revision:expectedSchemaRevision-1}]){
  let writes=0;const c={async query(){return{rows:[{isolation:'repeatable read',readOnly:'on',unfiltered:true,revision:expectedSchemaRevision,...patch}]};}} as unknown as pg.Client;
  const output={async writeFile(){writes++;},async sync(){}} as unknown as FileHandle;await assert.rejects(captureMediaReferencePlan(c,output,binding),{code:'MEDIA_REFERENCE_SNAPSHOT_REQUIRED'});assert.equal(writes,0);
 }
 const c={async query(){throw Error('PRIVATE_DATABASE_DIAGNOSTIC');}} as unknown as pg.Client;await assert.rejects(captureMediaReferencePlan(c,{} as FileHandle,binding),error=>{assert.equal((error as {code:string}).code,'MEDIA_REFERENCE_PLAN_FAILED');assert.doesNotMatch(String(error),/PRIVATE/);return true;});
});
test('reference capture uses bounded cursor pages and closes its cursor on conflicting observations or cancellation',async()=>{
 for(const mode of ['normal','conflict','cancel']){
  const queries:string[]=[],chunks:string[]=[],controller=new AbortController();let cursor='',schoolPage=0,referencePage=0,synced=false;
  const row=(n:number)=>({academyId:'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa',stage:'clean',storageTargetId:'b'.repeat(64),fileId:'00000000-0000-4000-8000-'+n.toString(16).padStart(12,'0'),bytes:'42',sha256:'c'.repeat(64)});
  const client={async query(sql:string){queries.push(sql);if(sql.startsWith('SELECT current_setting'))return{rows:[{isolation:'repeatable read',readOnly:'on',unfiltered:true,revision:expectedSchemaRevision}]};if(sql.startsWith('DECLARE ')){cursor=sql.split(' ')[1];return{rows:[]};}if(sql.startsWith('FETCH ')){assert.ok(sql.startsWith('FETCH FORWARD 1000 '));if(cursor==='media_backup_academies')return{rows:schoolPage++?[]:[{academyId:row(1).academyId,unconfirmedUploads:'1'}]};referencePage++;if(mode==='conflict')return{rows:[row(1),{...row(1),sha256:'d'.repeat(64)}]};if(mode==='cancel'&&referencePage===2)controller.abort();return{rows:referencePage===1?Array.from({length:1000},(_,i)=>row(i+1)):referencePage===2?[row(1001)]:[]};}return{rows:[]};}} as unknown as pg.Client;
  const output={async writeFile(text:string){assert.ok(text.trim().split('\n').length<=1000);chunks.push(text);},async sync(){synced=true;}} as unknown as FileHandle;
  if(mode==='normal'){const result=await captureMediaReferencePlan(client,output,binding,controller.signal);assert.equal(result.references,1001);assert.equal(result.unconfirmedUploads,1);assert.equal(result.plaintextBytes,Buffer.byteLength(chunks.join('')));assert.equal(synced,true);}
  else{await assert.rejects(captureMediaReferencePlan(client,output,binding,controller.signal),{code:mode==='conflict'?'MEDIA_REFERENCE_CONTENT_CONFLICT':'RECOVERY_CANCELLED'});assert.equal(synced,false);assert.ok(!chunks.join('').includes('"type":"complete"'));}
  assert.equal(queries.at(-1),'CLOSE media_backup_references');
 }
});
test('actual SQL plan retains historical observed source/destination bytes and distinguishes unconfirmed uploads',async()=>{
 const f=await fixture(),folder=await realpath(await mkdtemp(join(tmpdir(),'kavosh-media-references-'))),file=join(folder,'plan.jsonl');let client:Awaited<ReturnType<NonNullable<typeof f.pg.runtime>['connect']>>|undefined;
 try{
  const item=await f.file();assert.equal((await f.copy(item)).response.status,202);
  try{assert.deepEqual(await processOneCopy(f.database as Database,[f.a],randomUUID(),async task=>({outcome:'written_verified',bytes:task.expectedBytes,sha256:task.expectedSha256,source:{storageTargetId:task.sourceTargetId,etag:'"original-source"'},destination:{storageTargetId:task.destinationTargetId,etag:'"stored-destination"'}})),{claimed:true,recorded:true});}finally{if(!f.pg.runtime)await f.pg.exec('RESET ROLE');}
  assert.equal((await f.request('files/'+item.id+'/change',{expectedVersion:1,archived:true,reason:'Historical media must remain recoverable'})).response.status,200);
  const pending=await f.request('files',{anchor:{kind:'hub',id:f.hub},name:'Pending upload,not committed bytes',claimedMimeType:'image/png',expectedBytes:f.bytes.length});assert.equal(pending.response.status,201);assert.equal((await f.request('files/'+pending.body.data.id+'/upload-link',{expectedMetadataVersion:1})).response.status,201);
  client=f.pg.runtime?await f.pg.runtime.connect():undefined;if(client)await client.query('RESET ROLE');
  const c=(client??{query:(sql:string)=>f.pg.query(sql)}) as pg.Client;await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try{
   await c.query('SELECT count(*) FROM public.file_inspection_attempts');
   // Native coverage proves a subsequent committed source is not substituted
   // into the established dump snapshot. Embedded mode has one SQL session.
   if(client)await f.file();
   const output=await open(file,'wx',0o600);let result;try{result=await captureMediaReferencePlan(c,output,binding);}finally{await output.close();}
   const text=await readFile(file,'utf8'),lines=text.trim().split('\n').map(line=>JSON.parse(line)),refs=lines.filter(line=>line.type==='reference');
   assert.equal(result.references,2);assert.equal(result.unconfirmedUploads,1);assert.equal(result.plaintextSha256,createHash('sha256').update(text).digest('hex'));assert.equal(lines[0].archiveSha256,binding.archiveSha256);assert.equal(lines.at(-1).type,'complete');
   assert.equal(refs.length,2);assert.deepEqual(refs.map(row=>row.stage).sort(),['clean','quarantine']);assert.ok(refs.every(row=>row.academyId===f.a&&row.fileId===item.id&&row.bytes===f.bytes.length&&row.sha256===hash(f.bytes)));assert.equal(refs.find(row=>row.stage==='quarantine').storageTargetId,target);assert.equal(refs.find(row=>row.stage==='clean').storageTargetId,'b'.repeat(64));
   assert.ok(lines.some(line=>line.type==='academy'&&line.academyId===f.b));assert.doesNotMatch(text,/Synthetic source|Pending upload|example[.]test|secretAccessKey/);
  }finally{await c.query('ROLLBACK');}
 }finally{client?.release();await unlink(file).catch(()=>{});await rmdir(folder);await f.pg.close();}
});
