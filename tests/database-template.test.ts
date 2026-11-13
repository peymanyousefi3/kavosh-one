import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {test} from 'node:test';
import pg from 'pg';
import {testDatabase,migratedTestDatabase,type TestDatabase} from './database.ts';
import {expectedSchemaRevision} from '../src/core/database.ts';

test('native blank and prepared fixtures remain isolated while template1 has a real open connection',{skip:!process.env.TEST_DATABASE_URL},async()=>{
 const original=process.env.TEST_DATABASE_URL!,occupied=new URL(original),fresh=new URL(original);assert.ok(['localhost','127.0.0.1','[::1]'].includes(occupied.hostname));occupied.pathname='/template1';fresh.searchParams.set('application_name','kavosh_fixture_template0_'+randomUUID().replaceAll('-',''));
 const blocker=new pg.Client({connectionString:occupied.toString()});let blank:TestDatabase|undefined,prepared:TestDatabase|undefined;
 try{
  await blocker.connect();assert.equal((await blocker.query('SELECT current_database() name')).rows[0].name,'template1');process.env.TEST_DATABASE_URL=fresh.toString();
  blank=await testDatabase();assert.equal((await blank.query("SELECT to_regclass('public.people') table_name")).rows[0].table_name,null);
  // A unique connection-map key forces a real fresh migrated seed,not an
  // existing template. Its distinct copy must remain empty and fully current.
  prepared=await migratedTestDatabase();assert.equal((await prepared.query('SELECT public.schema_revision() revision')).rows[0].revision,expectedSchemaRevision);assert.equal((await prepared.query('SELECT count(*)::integer n FROM public.people')).rows[0].n,0);assert.notEqual((await prepared.query('SELECT current_database() name')).rows[0].name,(await blank.query('SELECT current_database() name')).rows[0].name);
  assert.equal((await blocker.query('SELECT current_database() name')).rows[0].name,'template1');
 }finally{process.env.TEST_DATABASE_URL=original;try{await prepared?.close();}finally{try{await blank?.close();}finally{await blocker.end();}}}
});
