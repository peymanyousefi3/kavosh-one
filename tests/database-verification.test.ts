import assert from 'node:assert/strict';
import { test } from 'node:test';
import pg from 'pg';
import { fingerprintQuery,databaseVerificationSnapshot } from '../src/operations/database-verification.ts';
import { operationsFixture } from './operations-fixture.ts';

function rows(values:unknown[],error=false){return {query(q:pg.Query){for(const value of values)q.emit('row',{value});q.emit(error?'error':'end',error?new Error('PRIVATE_DATABASE_DIAGNOSTIC'):undefined);return q;}} as Pick<pg.Client,'query'>;}
test('verification hashes framed rows without accumulating values and detects changed,missing,duplicate and ambiguously concatenated rows',async()=>{
 const reference=await fingerprintQuery(rows(['ab','c']),'synthetic');assert.equal(reference.rows,2);assert.match(reference.sha256,/^[a-f0-9]{64}$/);
 assert.deepEqual(await fingerprintQuery(rows(['ab','c']),'synthetic'),reference);
 for(const values of [['a','bc'],['ab'],['ab','c','c'],['ab','changed']])assert.notEqual((await fingerprintQuery(rows(values),'synthetic')).sha256,reference.sha256);
 assert.equal((await fingerprintQuery(rows([]),'synthetic')).rows,0);
 assert.deepEqual(Object.keys(reference).sort(),['rows','sha256']);
});
test('invalid values,cancellation and query errors never produce a successful fingerprint or private diagnostic',async()=>{
 await assert.rejects(fingerprintQuery(rows([null]),'synthetic'),/VERIFICATION_ROW_LIMIT/);
 await assert.rejects(fingerprintQuery(rows(['private']), 'synthetic',AbortSignal.abort()),/VERIFICATION_CANCELLED/);
 await assert.rejects(fingerprintQuery(rows([],true),'synthetic'),{message:'VERIFICATION_QUERY_FAILED'});
});
test('snapshot collection refuses a non-repeatable or writable transaction before scanning data',async()=>{
 for(const state of [{isolation:'read committed',read_only:'on'},{isolation:'repeatable read',read_only:'off'}]){
  let calls=0;const client={async query(){calls++;return {rows:[state]};}} as unknown as pg.Client;
  await assert.rejects(databaseVerificationSnapshot(client),/VERIFICATION_SNAPSHOT_REQUIRED/);assert.equal(calls,1);
 }
});
test('actual SQL snapshot covers populated private tables,ownership,functions and RLS without returning row values',async()=>{
 const f=await operationsFixture();try{
  const native= f.pg.runtime?await f.pg.runtime.connect():undefined;
  if(native)await native.query('RESET ROLE');
  const client=(native??{query(q:string|pg.Query){
   if(typeof q==='string')return q.startsWith('SET LOCAL ')?f.pg.exec(q):f.pg.query(q);
   void f.pg.query((q as unknown as {text:string}).text).then(r=>{for(const row of r.rows)q.emit('row',row);q.emit('end');},e=>q.emit('error',e));return q;
  }}) as unknown as pg.Client;
  try{
   await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
   const result=await databaseVerificationSnapshot(client);
   assert.ok(result.tables.some(t=>t.schema==='identity'&&t.name==='user'&&t.fingerprint.rows===5));
   assert.ok(result.tables.some(t=>t.schema==='public'&&t.name==='people'&&t.fingerprint.rows===6));
   assert.ok(result.functions.rows>0);assert.ok(result.policies.rows>0);assert.equal(result.sequenceValuesCovered,false);assert.equal(result.globalRolesCovered,false);
   assert.doesNotMatch(JSON.stringify(result),/Synthetic person|example[.]test|synthetic-session|PRIVATE/);
  }finally{await client.query('ROLLBACK');native?.release();}
 }finally{await f.pg.close();}
});
