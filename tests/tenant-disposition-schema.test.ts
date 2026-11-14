import assert from 'node:assert/strict';
import test from 'node:test';
import {dispositionSchemaOrder,readDispositionSchema} from '../src/platform/disposition-schema.ts';
import {expectedSchemaRevision,type Connection} from '../src/core/database.ts';
import {operationsFixture} from './operations-fixture.ts';

const relation=(name:string,patch:Record<string,unknown>={})=>({schema:'public',name,scopeColumn:name==='academies'?'id':'academy_id',scopeType:'uuid',scopeNotNull:true,primaryKey:['id'],partitioned:false,partitionChild:false,inheritance:false,...patch});
const fk=(child:string,parent:string,patch:Record<string,unknown>={})=>({name:child+'_'+parent+'_fk',childSchema:'public',childRelation:child,parentSchema:'public',parentRelation:parent,childColumns:['academy_id','parent_id'],parentColumns:['academy_id','id'],deferrable:false,initiallyDeferred:false,deleteAction:'a',validated:true,enforced:true,enforcementTriggersActive:true,period:false,...patch});
const source=(names:string[],foreignKeys:Record<string,unknown>[]=[])=>({schemaRevision:427,replicationRole:'origin',relations:[relation('academies'),...names.map(n=>relation(n))],foreignKeys});
const noAuthority=(result:ReturnType<typeof dispositionSchemaOrder>)=>{assert.equal(result.executionAuthorized,false);assert.equal(result.dataDeleted,false);assert.equal(result.retentionEvaluated,false);assert.equal(result.recordScopeEvaluated,false);};
const invalid=(raw:unknown)=>assert.throws(()=>dispositionSchemaOrder(raw),(e:any)=>e.code==='DISPOSITION_SCHEMA_INVALID');

test('disposition schema orders children before parents,retains the academy anchor and never authorizes deletion',()=>{
 const result=dispositionSchemaOrder(source(['people','classes','reports'],[fk('reports','classes'),fk('classes','people'),fk('people','academies')]));
 assert.equal(result.schemaOrderReady,true);assert.deepEqual(result.deleteOrder,['public.reports','public.classes','public.people']);assert.deepEqual(result.protectedRoots,['public.academies']);assert.equal(result.blockers.length,0);assert.ok(result.externalReferences.some(f=>f.childRelation==='people'&&f.parentRelation==='academies'&&f.direction==='outgoing'));noAuthority(result);
});
test('schema fingerprint and order are independent of catalog row order,including duplicate dependency edges',()=>{
 const input=source(['people','classes','reports'],[fk('reports','classes'),fk('reports','classes',{name:'second_same_parent'}),fk('classes','people')]),a=dispositionSchemaOrder(input),b=dispositionSchemaOrder({...input,relations:[...input.relations].reverse(),foreignKeys:[...input.foreignKeys].reverse()});assert.deepEqual(a,b);assert.equal(a.deleteOrder.length,3);assert.match(a.structuralFingerprint,/^[a-f0-9]{64}$/);
});
test('only deferrable NO ACTION breaks an otherwise cyclic table dependency',()=>{
 const result=dispositionSchemaOrder(source(['heads','revisions'],[fk('revisions','heads'),fk('heads','revisions',{deferrable:true})]));assert.equal(result.schemaOrderReady,true);assert.deepEqual(result.deleteOrder,['public.revisions','public.heads']);assert.equal(result.deferConstraints.length,1);assert.equal(result.deferConstraints[0].childRelation,'heads');noAuthority(result);
});
test('CASCADE,RESTRICT,SET NULL and SET DEFAULT actions stay immediate even on deferrable foreign keys',()=>{
 for(const deleteAction of ['c','r','n','d']){const result=dispositionSchemaOrder(source(['heads','revisions'],[fk('revisions','heads'),fk('heads','revisions',{deferrable:true,deleteAction})]));assert.equal(result.schemaOrderReady,false,deleteAction);assert.deepEqual(result.deleteOrder,[]);assert.equal(result.deferConstraints.length,0);assert.ok(result.blockers.some(b=>b.code==='ACTION_DEPENDENCY_CYCLE'));noAuthority(result);}
});
test('nondeferrable cycles with unschedulable downstream parents return no partial executable order',()=>{
 const result=dispositionSchemaOrder(source(['a','b','c','independent'],[fk('a','b'),fk('b','a'),fk('b','c')]));assert.equal(result.schemaOrderReady,false);assert.deepEqual(result.deleteOrder,[]);assert.deepEqual(result.blockers.find(b=>b.code==='ACTION_DEPENDENCY_CYCLE')?.relations,['public.a','public.b','public.c']);noAuthority(result);
});
test('self-referencing rows require one per-relation statement or later row-level dependency proof',()=>{
 const result=dispositionSchemaOrder(source(['people'],[fk('people','people')]));assert.equal(result.schemaOrderReady,true);assert.deepEqual(result.deleteOrder,['public.people']);assert.deepEqual(result.singleStatementRequiredFor,['public.people']);assert.equal(result.selfReferences.length,1);assert.equal(result.deferConstraints.length,0);noAuthority(result);
});
test('external incoming security records and outgoing identities stay outside the deletion order',()=>{
 const result=dispositionSchemaOrder(source(['people'],[fk('people','user',{parentSchema:'identity'}),fk('recovery_cases','people',{childSchema:'auth_private',deleteAction:'c'}),fk('academies','user',{parentSchema:'identity'})]));assert.deepEqual(result.deleteOrder,['public.people']);assert.equal(result.externalReferences.length,2);assert.ok(result.externalReferences.some(f=>f.childSchema==='auth_private'&&f.direction==='incoming'));assert.ok(result.externalReferences.some(f=>f.parentSchema==='identity'&&f.direction==='outgoing'));assert.ok(result.externalReferences.every(f=>f.childRelation==='people'||f.parentRelation==='people'));noAuthority(result);
});
test('missing primary keys,nullable or non-UUID school keys and partitions fail closed before deletion',()=>{
 for(const [patch,code]of [[{primaryKey:[]},'MISSING_PRIMARY_KEY'],[{scopeType:'text'},'UNSUPPORTED_TENANT_KEY'],[{scopeNotNull:false},'UNSUPPORTED_TENANT_KEY'],[{scopeColumn:'id'},'UNSUPPORTED_TENANT_KEY'],[{partitioned:true},'PARTITION_REVIEW_REQUIRED'],[{partitionChild:true},'PARTITION_REVIEW_REQUIRED'],[{inheritance:true},'INHERITANCE_REVIEW_REQUIRED']]as const){const result=dispositionSchemaOrder({...source([]),relations:[relation('academies'),relation('people',patch)]});assert.equal(result.schemaOrderReady,false);assert.deepEqual(result.deleteOrder,[]);assert.ok(result.blockers.some(b=>b.code===code));noAuthority(result);}
});
test('unvalidated constraints cannot certify a schema order or quietly assume existing rows satisfy references',()=>{
 const result=dispositionSchemaOrder(source(['people'],[fk('people','academies',{validated:false})]));assert.equal(result.schemaOrderReady,false);assert.deepEqual(result.deleteOrder,[]);assert.equal(result.blockers[0].code,'UNVALIDATED_FOREIGN_KEY');noAuthority(result);
});
test('PostgreSQL18 unenforced or temporal foreign keys require review rather than inheriting older database assumptions',()=>{
 for(const [patch,code]of [[{enforced:false},'UNENFORCED_FOREIGN_KEY'],[{period:true},'TEMPORAL_FOREIGN_KEY_REVIEW_REQUIRED']]as const){const result=dispositionSchemaOrder(source(['people'],[fk('people','academies',patch)]));assert.equal(result.schemaOrderReady,false);assert.deepEqual(result.deleteOrder,[]);assert.equal(result.blockers[0].code,code);noAuthority(result);}
});
test('disabled constraint triggers and non-origin execution mode cannot produce a runnable table order',()=>{
 const disabled=dispositionSchemaOrder(source(['people'],[fk('people','academies',{enforcementTriggersActive:false})]));assert.equal(disabled.schemaOrderReady,false);assert.equal(disabled.blockers[0].code,'DISABLED_FOREIGN_KEY_TRIGGER');for(const replicationRole of ['replica','local']){const result=dispositionSchemaOrder({...source(['people']),replicationRole});assert.equal(result.schemaOrderReady,false);assert.deepEqual(result.deleteOrder,[]);assert.equal(result.blockers[0].code,'REPLICATION_MODE_REVIEW_REQUIRED');noAuthority(result);}
});
test('malformed,duplicate,foreign-schema and unrelated catalog inputs never become trusted identifiers',()=>{
 invalid({...source(['people']),approved:true});invalid({...source(['people']),relations:[relation('people')]});invalid({...source(['people']),relations:[relation('academies'),relation('people'),relation('people')]});invalid({...source(['people']),relations:[relation('academies'),relation('people',{schema:'identity'})]});invalid({...source(['people']),relations:[relation('academies'),relation('people;DROP_TABLE')]});invalid({...source(['people']),relations:[relation('academies'),relation('people',{primaryKey:['id','id']})]});
 for(const patch of [{initiallyDeferred:true,deferrable:false},{childColumns:['id'],parentColumns:['academy_id','id']},{childColumns:['id','id']},{parentColumns:['id','id']}])invalid(source(['people','classes'],[fk('people','classes',patch)]));invalid(source(['people'],[fk('unrelated','missing')]));invalid(source(['people','classes'],[fk('people','classes'),fk('people','classes')]));
});
test('structural source changes invalidate the fingerprint without pretending to fingerprint private row contents',()=>{
 const a=dispositionSchemaOrder(source(['people','classes'],[fk('classes','people')]));for(const b of [dispositionSchemaOrder({...source(['people','classes'],[fk('classes','people')]),schemaRevision:428}),dispositionSchemaOrder(source(['people','classes'],[fk('classes','people',{deferrable:true})])),dispositionSchemaOrder(source(['people','classes','extra'],[fk('classes','people')]))])assert.notEqual(a.structuralFingerprint,b.structuralFingerprint);noAuthority(a);
});
test('catalog reader performs one static metadata query and rejects missing or unexpected result rows',async()=>{
 let calls=0;const db={async query(sql:string){calls++;assert.match(sql,/pg_catalog[.]pg_constraint/);assert.doesNotMatch(sql,/\b(?:DELETE|UPDATE|INSERT|TRUNCATE|ALTER|DROP|CREATE)\s+(?:FROM|INTO|TABLE|public[.])/i);return{rows:[{snapshot:source(['people'])}]};}};const result=await readDispositionSchema(db as unknown as Pick<Connection,'query'>);assert.equal(calls,1);assert.equal(result.schemaOrderReady,true);noAuthority(result);await assert.rejects(readDispositionSchema({async query(){return{rows:[]};}}),(e:any)=>e.code==='DISPOSITION_SCHEMA_INVALID');
});
test('actual academy catalog is inspected without touching business rows or weakening any foreign key',async()=>{
 const f=await operationsFixture();try{
  const before=(await f.pg.query('SELECT to_jsonb(a) value FROM public.academies a ORDER BY id')).rows,constraints=(await f.pg.query("SELECT oid,condeferrable,condeferred,convalidated FROM pg_constraint WHERE contype='f' ORDER BY oid")).rows;
  const result=await readDispositionSchema(f.pg);assert.equal(result.schemaRevision,expectedSchemaRevision);assert.ok(result.relationCount>=400);assert.ok(result.foreignKeyCount>1200);assert.deepEqual((await f.pg.query('SELECT to_jsonb(a) value FROM public.academies a ORDER BY id')).rows,before);assert.deepEqual((await f.pg.query("SELECT oid,condeferrable,condeferred,convalidated FROM pg_constraint WHERE contype='f' ORDER BY oid")).rows,constraints);assert.ok(!result.deleteOrder.includes('public.academies'));noAuthority(result);
  console.log(JSON.stringify({case:'actual-disposition-schema',relations:result.relationCount,foreignKeys:result.foreignKeyCount,schemaOrderReady:result.schemaOrderReady,blockers:result.blockers,externalReferences:result.externalReferences.length,dataDeleted:result.dataDeleted}));
 }finally{await f.pg.close();}
});
test('actual database confirms immediate referential actions and defers only NO ACTION until commit',async()=>{
 const f=await operationsFixture();try{
  const version=Number((await f.pg.query("SELECT current_setting('server_version_num') version")).rows[0].version);
  await f.pg.exec('CREATE TEMP TABLE disposition_action_parent(id integer PRIMARY KEY);INSERT INTO pg_temp.disposition_action_parent VALUES(1),(2)');
  for(const [code,action]of [['a','NO ACTION'],['c','CASCADE'],['r','RESTRICT'],['n','SET NULL'],['d','SET DEFAULT']]as const){
   await f.pg.exec('CREATE TEMP TABLE disposition_action_child(id integer PRIMARY KEY,parent_id integer DEFAULT 2 REFERENCES pg_temp.disposition_action_parent(id) ON DELETE '+action+' DEFERRABLE INITIALLY DEFERRED);INSERT INTO pg_temp.disposition_action_child VALUES(1,1)');await f.pg.exec('BEGIN');
   try{
    if(code==='r'){await assert.rejects(f.pg.exec('DELETE FROM pg_temp.disposition_action_parent WHERE id=1'),(e:any)=>{assert.equal(e.code,version>=180000?'23001':'23503');console.log(JSON.stringify({case:'immediate-restrict',version,sqlstate:e.code}));return true;});continue;}
    await f.pg.exec('DELETE FROM pg_temp.disposition_action_parent WHERE id=1');const rows=(await f.pg.query('SELECT parent_id FROM pg_temp.disposition_action_child')).rows;
    if(code==='c')assert.equal(rows.length,0);else assert.equal(rows[0].parent_id,code==='n'?null:code==='d'?2:1);
    if(code==='a')await assert.rejects(f.pg.exec('COMMIT'),(e:any)=>e.code==='23503');
   }finally{await f.pg.exec('ROLLBACK;DROP TABLE pg_temp.disposition_action_child');}
   assert.equal((await f.pg.query('SELECT * FROM pg_temp.disposition_action_parent')).rows.length,2);
  }
  for(const action of ['NO ACTION','RESTRICT']){
   await f.pg.exec('CREATE TEMP TABLE disposition_self(id integer PRIMARY KEY,parent_id integer REFERENCES pg_temp.disposition_self(id) ON DELETE '+action+' NOT DEFERRABLE);INSERT INTO pg_temp.disposition_self VALUES(1,2),(2,1)');await f.pg.exec('BEGIN;SAVEPOINT partial');
   try{await assert.rejects(f.pg.exec('DELETE FROM pg_temp.disposition_self WHERE id=1'),(e:any)=>e.code===(action==='RESTRICT'&&version>=180000?'23001':'23503'));await f.pg.exec('ROLLBACK TO SAVEPOINT partial;DELETE FROM pg_temp.disposition_self');assert.equal((await f.pg.query('SELECT * FROM pg_temp.disposition_self')).rows.length,0);}finally{await f.pg.exec('ROLLBACK;DROP TABLE pg_temp.disposition_self');}
  }
 }finally{await f.pg.close();}
});
test('PostgreSQL18 actual unenforced foreign-key metadata blocks a disposition schema',async t=>{
 const f=await operationsFixture();try{
  const version=Number((await f.pg.query("SELECT current_setting('server_version_num') version")).rows[0].version);if(version<180000){t.skip('Requires PostgreSQL18; separately exercised in its native CI job');return;}
  await f.pg.exec('CREATE TABLE public.synthetic_disposition_parent(academy_id uuid NOT NULL,id integer NOT NULL,PRIMARY KEY(academy_id,id));CREATE TABLE public.synthetic_disposition_child(academy_id uuid NOT NULL,id integer NOT NULL,parent_id integer,PRIMARY KEY(academy_id,id),FOREIGN KEY(academy_id,parent_id) REFERENCES public.synthetic_disposition_parent(academy_id,id) NOT ENFORCED)');
  await f.pg.query('INSERT INTO public.synthetic_disposition_child VALUES($1,1,999)',[f.a]);const result=await readDispositionSchema(f.pg);assert.equal(result.schemaOrderReady,false);assert.deepEqual(result.deleteOrder,[]);assert.ok(result.blockers.some(b=>b.code==='UNENFORCED_FOREIGN_KEY'&&b.relations.includes('public.synthetic_disposition_child')));noAuthority(result);
 }finally{await f.pg.close();}
});
test('actual validated foreign keys with disabled triggers and replica-mode sessions still block disposition',async()=>{
 const f=await operationsFixture();try{
  await f.pg.exec('CREATE TABLE public.synthetic_disposition_checked_parent(academy_id uuid NOT NULL,id integer NOT NULL,PRIMARY KEY(academy_id,id));CREATE TABLE public.synthetic_disposition_checked_child(academy_id uuid NOT NULL,id integer NOT NULL,parent_id integer,PRIMARY KEY(academy_id,id),FOREIGN KEY(academy_id,parent_id) REFERENCES public.synthetic_disposition_checked_parent(academy_id,id));ALTER TABLE public.synthetic_disposition_checked_child DISABLE TRIGGER ALL');
  const validated=(await f.pg.query("SELECT convalidated FROM pg_constraint WHERE conrelid='public.synthetic_disposition_checked_child'::regclass AND contype='f'")).rows;assert.equal(validated.length,1);assert.equal(validated[0].convalidated,true);
  const disabled=await readDispositionSchema(f.pg);assert.deepEqual(disabled.deleteOrder,[]);assert.ok(disabled.blockers.some(b=>b.code==='DISABLED_FOREIGN_KEY_TRIGGER'&&b.relations.includes('public.synthetic_disposition_checked_child')));noAuthority(disabled);
  await f.pg.exec('ALTER TABLE public.synthetic_disposition_checked_child ENABLE TRIGGER ALL');assert.ok(!(await readDispositionSchema(f.pg)).blockers.some(b=>b.code==='DISABLED_FOREIGN_KEY_TRIGGER'));
  await f.pg.exec("SET session_replication_role='replica'");try{const replica=await readDispositionSchema(f.pg);assert.deepEqual(replica.deleteOrder,[]);assert.ok(replica.blockers.some(b=>b.code==='REPLICATION_MODE_REVIEW_REQUIRED'));noAuthority(replica);}finally{await f.pg.exec("SET session_replication_role='origin'");}
 }finally{await f.pg.close();}
});
