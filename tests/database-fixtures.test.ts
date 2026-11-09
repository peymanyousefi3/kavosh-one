import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile,readdir } from 'node:fs/promises';
import { testDatabase,migratedTestDatabase,type TestDatabase } from './database.ts';
import { operationsFixture } from './operations-fixture.ts';
import { expectedSchemaRevision } from '../src/core/database.ts';
import { randomUUID } from 'node:crypto';

test('prepared fixtures execute real current migrations and never share fixture tables,data or actor sessions',async()=>{
 const a=await migratedTestDatabase(),b=await migratedTestDatabase();try{
  for(const db of [a,b]){assert.equal((await db.query('SELECT public.schema_revision() revision')).rows[0].revision,expectedSchemaRevision);assert.equal((await db.query('SELECT count(*)::integer n FROM public.people')).rows[0].n,0);assert.equal((await db.query('SELECT count(*)::integer n FROM identity.session')).rows[0].n,0);}
  if(process.env.TEST_DATABASE_URL){const seeds=(await a.query<{datallowconn:boolean}>("SELECT datallowconn FROM pg_database WHERE datname LIKE 'kavosh_schema_%'")).rows;assert.ok(seeds.length>0);assert.ok(seeds.every(s=>s.datallowconn===false));}
  await a.exec('CREATE TABLE public.fixture_isolation_probe(value integer NOT NULL);INSERT INTO public.fixture_isolation_probe VALUES(7)');assert.equal((await a.query('SELECT value FROM public.fixture_isolation_probe')).rows[0].value,7);assert.equal((await b.query("SELECT to_regclass('public.fixture_isolation_probe') value")).rows[0].value,null);
  await a.exec("CREATE FUNCTION public.fixture_isolation_function() RETURNS integer LANGUAGE sql AS 'SELECT 7'");assert.equal((await b.query("SELECT to_regprocedure('public.fixture_isolation_function()') value")).rows[0].value,null);
 }finally{await a.close();await b.close();}
});
test('current cloned schema preserves complete native relation,function,policy,index and constraint security definitions',{skip:!process.env.TEST_DATABASE_URL},async()=>{
 const a=await testDatabase(),b=await migratedTestDatabase();try{
  for(const name of(await readdir(new URL('../db/migrations/',import.meta.url))).filter(n=>n.endsWith('.sql')).sort())await a.exec(await readFile(new URL('../db/migrations/'+name,import.meta.url),'utf8'));
  const snapshot=async(db:TestDatabase)=>({relations:(await db.query("SELECT n.nspname,c.relname,c.relkind,pg_get_userbyid(c.relowner) owner,c.relrowsecurity,c.relforcerowsecurity,c.relacl::text,c.reloptions,CASE WHEN c.relkind IN('v','m') THEN pg_get_viewdef(c.oid,true) END view_definition FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN('public','identity','auth_private') ORDER BY n.nspname,c.relname")).rows,
   functions:(await db.query("SELECT n.nspname,p.proname,pg_get_function_identity_arguments(p.oid) args,pg_get_userbyid(p.proowner) owner,p.prosecdef,p.proacl::text,p.proconfig,pg_get_functiondef(p.oid) definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN('public','identity','auth_private') AND p.prokind='f' ORDER BY n.nspname,p.proname,args")).rows,
   policies:(await db.query("SELECT schemaname,tablename,policyname,permissive,roles,cmd,qual,with_check FROM pg_policies WHERE schemaname IN('public','identity','auth_private') ORDER BY schemaname,tablename,policyname")).rows,
   indexes:(await db.query("SELECT schemaname,tablename,indexname,indexdef FROM pg_indexes WHERE schemaname IN('public','identity','auth_private') ORDER BY schemaname,tablename,indexname")).rows,
   constraints:(await db.query("SELECT n.nspname,c.relname,k.conname,k.condeferrable,k.condeferred,pg_get_constraintdef(k.oid) definition FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN('public','identity','auth_private') ORDER BY n.nspname,c.relname,k.conname")).rows,
   triggers:(await db.query("SELECT n.nspname,c.relname,t.tgname,t.tgenabled,t.tgdeferrable,t.tginitdeferred,pg_get_triggerdef(t.oid,true) definition FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE NOT t.tgisinternal AND n.nspname IN('public','identity','auth_private') ORDER BY n.nspname,c.relname,t.tgname")).rows});
  const source=await snapshot(a);assert.deepEqual(await snapshot(b),source);console.log(JSON.stringify({fixtureSchemaCompared:true,relations:source.relations.length,functions:source.functions.length,policies:source.policies.length,constraints:source.constraints.length,indexes:source.indexes.length,triggers:source.triggers.length}));
 }finally{await a.close();await b.close();}
});
test('historical fixtures remain real old schemas and later current fixtures are not contaminated',async()=>{
 const old=await operationsFixture({throughSchema:248});try{assert.equal((await old.pg.query('SELECT public.schema_revision() n')).rows[0].n,248);assert.equal((await old.pg.query("SELECT to_regclass('public.expense_cost_allocations') value")).rows[0].value,null);}finally{await old.pg.close();}
 const current=await operationsFixture();try{assert.equal((await current.pg.query('SELECT public.schema_revision() n')).rows[0].n,expectedSchemaRevision);assert.equal((await current.request('people')).response.status,200);}finally{await current.pg.close();}
});
test('fixture template identifiers fail closed before opening or creating any database',async()=>{
 for(const template of ['', 'postgres','kavosh_schema_bad','kavosh_schema_00000000000000000000000000000000";DROP DATABASE postgres;--'])await assert.rejects(testDatabase(template),/Invalid owned test schema template/);
});
test('missing owned native templates reject without retaining an administrator connection',{skip:!process.env.TEST_DATABASE_URL},async()=>{
 await assert.rejects(testDatabase('kavosh_schema_'+randomUUID().replaceAll('-','')),/does not exist/);
});
test('failed native schema preparation removes its exact owned partial database without leaving a reusable template',{skip:!process.env.TEST_DATABASE_URL},async()=>{
 const admin=await testDatabase(),original=process.env.TEST_DATABASE_URL!,login='kavosh_fixture_fail_'+randomUUID().replaceAll('-',''),password='synthetic_only_'+randomUUID().replaceAll('-','');let created=false;
 try{await admin.exec(`CREATE ROLE ${login} LOGIN CREATEDB NOSUPERUSER NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${password}'`);created=true;const url=new URL(original);url.username=login;url.password=password;process.env.TEST_DATABASE_URL=url.toString();try{await assert.rejects(migratedTestDatabase(),/permission|must be|not permitted/i);}finally{process.env.TEST_DATABASE_URL=original;}assert.equal((await admin.query<{n:number}>("SELECT count(*)::integer n FROM pg_database WHERE datdba=(SELECT oid FROM pg_roles WHERE rolname=$1) AND datname LIKE 'kavosh_schema_%'",[login])).rows[0].n,0);
 }finally{process.env.TEST_DATABASE_URL=original;try{if(created)await admin.exec('DROP ROLE '+login);}finally{await admin.close();}}
});
test('three paired native fixture setups compare real full installs with isolated schema clones,not skipped logic',{skip:!process.env.TEST_DATABASE_URL},async()=>{
 const seed=await migratedTestDatabase();await seed.close();const samples={full:[] as number[],cloned:[] as number[]},databases=new Set<string>(),people=new Set<string>();
 for(let i=0;i<3;i++)for(const mode of ['full','cloned'] as const){const start=performance.now(),f=await operationsFixture(mode==='full'?{throughSchema:expectedSchemaRevision}:{});try{samples[mode].push(Math.ceil(performance.now()-start));databases.add((await f.pg.query<{name:string}>('SELECT current_database() name')).rows[0].name);assert.ok(!people.has(f.actors.master.person));people.add(f.actors.master.person);assert.equal((await f.request('people')).response.status,200);}finally{await f.pg.close();}}
 assert.equal(databases.size,6);assert.equal(people.size,6);console.log(JSON.stringify({nativeFixtureSetupMs:samples,medianMs:Object.fromEntries(Object.entries(samples).map(([k,v])=>[k,[...v].sort((a,b)=>a-b)[1]])),fixtures:6,externalIO:false,stress:false}));
});
