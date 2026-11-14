import assert from 'node:assert/strict';
import { test } from 'node:test';
import pg from 'pg';
import { fingerprintQuery,columnPrivilegesFingerprint,databaseVerificationSnapshot,backupVerification } from '../src/operations/database-verification.ts';
import { operationsFixture } from './operations-fixture.ts';

function rows(values:unknown[],error=false){return {query(q:pg.Query){for(const value of values)q.emit('row',{value});q.emit(error?'error':'end',error?new Error('PRIVATE_DATABASE_DIAGNOSTIC'):undefined);return q;}} as Pick<pg.Client,'query'>;}
test('cluster proof is explicit and backward compatible;partial or extra proof fields are refused',()=>{
 const fp={rows:0,sha256:'a'.repeat(64)},original={archiveSha256:'b'.repeat(64),snapshot:{format:'kavosh-database-verification-v1',schemaRevision:396,tables:[],relations:fp,functions:fp,policies:fp,sequenceValuesCovered:false,globalRolesCovered:false}};
 assert.deepEqual(backupVerification.parse(original),original);
 assert.deepEqual(backupVerification.parse({...original,snapshot:{...original.snapshot,columnPrivileges:fp}}).snapshot.columnPrivileges,fp);
 assert.throws(()=>backupVerification.parse({...original,snapshot:{...original.snapshot,columnPrivileges:{...fp,rows:-1}}}));
 const cluster={databaseAccess:{...fp,rows:1},globalRoleProperties:fp};assert.deepEqual(backupVerification.parse({...original,cluster}),{...original,cluster});
 for(const invalid of [{databaseAccess:fp},{...cluster,passwordsRestored:true},{...cluster,databaseAccess:{rows:1,sha256:'invalid'}}])assert.throws(()=>backupVerification.parse({...original,cluster:invalid}));
});
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
   for(const sql of ['CREATE TABLE public.verification_column_probe(discarded text,retained text)','ALTER TABLE public.verification_column_probe DROP COLUMN discarded','GRANT SELECT(retained) ON public.verification_column_probe TO PUBLIC'])await client.query(sql);
   const granted=await columnPrivilegesFingerprint(client);
   await client.query('REVOKE SELECT(retained) ON public.verification_column_probe FROM PUBLIC');
   const revoked=await columnPrivilegesFingerprint(client);assert.notDeepEqual(granted,revoked);assert.equal(granted.rows,revoked.rows+1);
   await client.query('GRANT SELECT ON public.verification_column_probe TO PUBLIC');
   assert.deepEqual(await columnPrivilegesFingerprint(client),revoked,'table grants must not masquerade as explicit column grants');
   for(const sql of ['REVOKE SELECT ON public.verification_column_probe FROM PUBLIC','DROP TABLE public.verification_column_probe','CREATE TABLE public.verification_column_probe(retained text)','GRANT SELECT(retained) ON public.verification_column_probe TO PUBLIC'])await client.query(sql);
   assert.deepEqual(await columnPrivilegesFingerprint(client),granted,'physical column renumbering during restore must not change semantic ACLs');
   await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
   const result=await databaseVerificationSnapshot(client);
   assert.ok(result.tables.some(t=>t.schema==='identity'&&t.name==='user'&&t.fingerprint.rows===5));
   assert.ok(result.tables.some(t=>t.schema==='public'&&t.name==='people'&&t.fingerprint.rows===6));
   assert.ok(result.functions.rows>0);assert.ok(result.policies.rows>0);assert.equal(result.sequenceValuesCovered,false);assert.equal(result.globalRolesCovered,false);
   assert.deepEqual(result.columnPrivileges,granted);
   const legacy=await databaseVerificationSnapshot(client,undefined,false),{columnPrivileges,...withoutColumns}=result;
   assert.deepEqual(legacy,withoutColumns);assert.equal(legacy.columnPrivileges,undefined);
   assert.doesNotMatch(JSON.stringify(result),/Synthetic person|example[.]test|synthetic-session|PRIVATE/);
  }finally{await client.query('ROLLBACK');native?.release();}
 }finally{await f.pg.close();}
});
