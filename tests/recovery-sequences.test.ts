import assert from 'node:assert/strict';
import {test} from 'node:test';
import type pg from 'pg';
import {testDatabase} from './database.ts';
import {verifyRecoveredSequenceSafety} from '../src/operations/recovery-sequences.ts';

test('sequence recovery refuses writable or nonrepeatable reads before inspecting sequence data',async()=>{
 for(const transaction of [{isolation:'read committed',readOnly:'on',unfiltered:true},{isolation:'repeatable read',readOnly:'off',unfiltered:true},{isolation:'repeatable read',readOnly:'on',unfiltered:false}]){
  let calls=0;const client={async query(){calls++;return {rows:[transaction]};}} as unknown as Pick<pg.Client,'query'>;
  await assert.rejects(verifyRecoveredSequenceSafety(client),/RECOVERY_SEQUENCE_SNAPSHOT_REQUIRED/);assert.equal(calls,1);
 }
 await assert.rejects(verifyRecoveredSequenceSafety({} as Pick<pg.Client,'query'>,AbortSignal.abort()),/RECOVERY_CANCELLED/);
});
test('actual retained identity data detects unsafe restored next values,exhaustion and unsupported layouts without consuming or repairing sequences',async()=>{
 const db=await testDatabase(),client=db as unknown as Pick<pg.Client,'query'>;
 const inspect=async()=>{await db.exec('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');try{return await verifyRecoveredSequenceSafety(client);}finally{await db.exec('ROLLBACK');}};
 try{
  assert.equal((await inspect()).ownedSequencesChecked,0);
  await db.exec('CREATE TABLE public.recovered(id bigint GENERATED ALWAYS AS IDENTITY(START WITH 10 INCREMENT BY 5 CACHE 8),value text);INSERT INTO public.recovered(value) VALUES(\'SYNTHETIC_ONLY\'),(\'SYNTHETIC_ONLY\');CREATE SCHEMA "odd""schema";CREATE TABLE "odd""schema"."odd""table"("odd""column" bigint GENERATED ALWAYS AS IDENTITY(START WITH -1 INCREMENT BY -2 MINVALUE -99 MAXVALUE -1));INSERT INTO "odd""schema"."odd""table" DEFAULT VALUES;CREATE TABLE public.unused(id integer GENERATED ALWAYS AS IDENTITY)');
  const odd=(await db.query<{seq:string}>('SELECT pg_get_serial_sequence($1,$2) seq',['"odd""schema"."odd""table"','odd"column'])).rows[0].seq;
  const state=()=>db.query<{last_value:string;is_called:boolean}>('SELECT last_value::text,is_called FROM public.recovered_id_seq'),before=(await state()).rows;
  const result=await inspect();assert.equal(result.ownedSequencesChecked,3);assert.equal(result.unusedSequencesChecked,1);assert.equal(result.nextGeneratedValuesOutsideRetainedData,true);assert.equal(result.originalLiveSequenceValuesCompared,false);assert.equal(result.sequenceValuesChanged,false);assert.deepEqual((await state()).rows,before);assert.doesNotMatch(JSON.stringify(result),/SYNTHETIC|lastValue|odd|recovered/);
  await db.exec("SELECT setval('public.recovered_id_seq',9007199254740993,true)");assert.equal((await inspect()).ownedSequencesChecked,3);assert.equal((await state()).rows[0].last_value,'9007199254740993');
  await db.exec("INSERT INTO public.recovered(id,value) OVERRIDING SYSTEM VALUE VALUES(9007199254740998,'SYNTHETIC_ONLY')");await assert.rejects(inspect(),/RECOVERY_SEQUENCE_RETAINED_DATA_CONFLICT/);await db.exec('DELETE FROM public.recovered WHERE id=9007199254740998');
  await db.exec("SELECT setval('public.recovered_id_seq',10,true)");await assert.rejects(inspect(),/RECOVERY_SEQUENCE_RETAINED_DATA_CONFLICT/);assert.equal((await state()).rows[0].last_value,'10');
  await db.exec("SELECT setval('public.recovered_id_seq',100,true);INSERT INTO public.unused(id) OVERRIDING SYSTEM VALUE VALUES(1)");await assert.rejects(inspect(),/RECOVERY_SEQUENCE_RETAINED_DATA_CONFLICT/);
  await db.exec("SELECT setval('public.unused_id_seq',1,true)");await db.query('SELECT setval($1::regclass,-1,false)',[odd]);await assert.rejects(inspect(),/RECOVERY_SEQUENCE_RETAINED_DATA_CONFLICT/);
  await db.query('SELECT setval($1::regclass,-99,true)',[odd]);await assert.rejects(inspect(),/RECOVERY_SEQUENCE_EXHAUSTED/);
  await db.query('SELECT setval($1::regclass,-3,true)',[odd]);await db.exec('ALTER SEQUENCE public.recovered_id_seq CYCLE');await assert.rejects(inspect(),/RECOVERY_SEQUENCE_LAYOUT_UNSUPPORTED/);
  await db.exec('ALTER SEQUENCE public.recovered_id_seq NO CYCLE;CREATE SEQUENCE public.unowned');await assert.rejects(inspect(),/RECOVERY_SEQUENCE_LAYOUT_UNSUPPORTED/);
  await db.exec('DROP SEQUENCE public.unowned');assert.equal((await inspect()).ownedSequencesChecked,3);
 }finally{await db.close();}
});
