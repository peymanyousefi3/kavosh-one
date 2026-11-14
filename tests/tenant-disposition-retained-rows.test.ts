import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import type {Database} from '../src/core/database.ts';
import {inspectRetainedDispositionRows} from '../src/platform/disposition-retained-rows.ts';
import {testDatabase} from './database.ts';
import {operationsFixture} from './operations-fixture.ts';

async function fixture(){
 const pg=await testDatabase(),a=randomUUID(),b=randomUUID();let released=0,connections=0;
 try{
  await pg.exec(`CREATE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE AS 'SELECT 427';
   CREATE TABLE public.academies(id uuid PRIMARY KEY,name text NOT NULL);
   CREATE TABLE public.people(academy_id uuid NOT NULL REFERENCES public.academies(id),id integer NOT NULL,private_note text,PRIMARY KEY(academy_id,id));
   CREATE TABLE public.heads(academy_id uuid NOT NULL,id integer NOT NULL,current_revision integer,teacher integer,PRIMARY KEY(academy_id,id),FOREIGN KEY(academy_id,teacher) REFERENCES public.people(academy_id,id));
   CREATE TABLE public.revisions(academy_id uuid NOT NULL,id integer NOT NULL,head integer NOT NULL,PRIMARY KEY(academy_id,id),FOREIGN KEY(academy_id,head) REFERENCES public.heads(academy_id,id));
   ALTER TABLE public.heads ADD CONSTRAINT current_revision_fk FOREIGN KEY(academy_id,current_revision) REFERENCES public.revisions(academy_id,id);
   CREATE SCHEMA auth_private;CREATE TABLE auth_private.evidence(id integer PRIMARY KEY,school uuid NOT NULL,person integer NOT NULL,FOREIGN KEY(school,person) REFERENCES public.people(academy_id,id));
   CREATE TABLE public.legacy_links(academy_id uuid NOT NULL,id integer NOT NULL,parent_school uuid NOT NULL,parent integer NOT NULL,PRIMARY KEY(academy_id,id),FOREIGN KEY(parent_school,parent) REFERENCES public.people(academy_id,id));`);
  await pg.query("INSERT INTO public.academies VALUES($1,'Synthetic A'),($2,'Synthetic B')",[a,b]);
  await pg.query("INSERT INTO public.people VALUES($1,1,'private A1'),($1,2,'private A2'),($1,3,'private A3'),($2,1,'private B1')",[a,b]);
  await pg.query('INSERT INTO public.heads VALUES($1,501,NULL,1),($1,502,NULL,3)',[a]);
  await pg.query('INSERT INTO public.revisions VALUES($1,601,501),($1,602,502)',[a]);
  await pg.query('UPDATE public.heads SET current_revision=CASE id WHEN 501 THEN 601 ELSE 602 END');
  await pg.query('INSERT INTO auth_private.evidence VALUES(1,$1,2)',[a]);
  const database:Database={async connect(){connections++;return{query:pg.query.bind(pg),release(){released++;}};}};
  return{pg,a,b,database,counters:()=>({connections,released})};
 }catch(error){await pg.close();throw error;}
}
const noDeletion=(r:Awaited<ReturnType<typeof inspectRetainedDispositionRows>>)=>{assert.equal(r.executionAuthorized,false);assert.equal(r.dataDeleted,false);assert.equal(r.retentionEvaluated,false);assert.equal(r.closureComplete,true);};
const byRelation=(r:Awaited<ReturnType<typeof inspectRetainedDispositionRows>>)=>Object.fromEntries(r.relations.map(s=>[s.relation,s.count]));

test('failed rollback destroys the connection and preserves the original failure',async()=>{
 const original=new Error('synthetic catalog connection lost');let destroy:boolean|undefined;
 const database:Database={async connect(){return{async query<Row>(sql:string):Promise<{rows:Row[]}>{if(sql.startsWith('BEGIN')||sql.startsWith('SELECT set_config'))return{rows:[]};if(sql==='ROLLBACK')throw new Error('synthetic rollback connection lost');throw original;},release(value){destroy=value;}};}};
 await assert.rejects(inspectRetainedDispositionRows(database,{academyId:randomUUID(),seeds:[]}),(error:unknown)=>error===original);assert.equal(destroy,true);
});

test('native retained-row closure follows real composite keys and circular row references,not table-level cycles',async()=>{
 const f=await fixture();try{
  const before=(await f.pg.query('SELECT to_jsonb(p) value FROM public.people p ORDER BY academy_id,id')).rows;
  const r=await inspectRetainedDispositionRows(f.database,{academyId:f.a,seeds:[{relation:'public.revisions',key:[f.a,'601']}]});
  assert.equal(r.retainedCount,5);assert.deepEqual(byRelation(r),{'public.academies':1,'public.heads':1,'public.people':2,'public.revisions':1});assert.equal(r.crossTenantReference,false);noDeletion(r);
  assert.equal(r.recordScopeEvaluated,true);assert.match(r.structuralFingerprint,/^[a-f0-9]{64}$/);assert.ok(r.relations.every(s=>/^[a-f0-9]{64}$/.test(s.fingerprint)));assert.doesNotMatch(JSON.stringify(r),/private A|private B|601|Synthetic A/);
  assert.deepEqual((await f.pg.query('SELECT to_jsonb(p) value FROM public.people p ORDER BY academy_id,id')).rows,before);assert.deepEqual(f.counters(),{connections:1,released:1});
 }finally{await f.pg.close();}
});
test('cross-school incoming references retain their parent and outgoing anomalies are reported without targeting the other school',async()=>{
 const f=await fixture();try{
  await f.pg.query('INSERT INTO public.legacy_links VALUES($1,1,$2,3),($2,2,$1,1)',[f.b,f.a]);
  const r=await inspectRetainedDispositionRows(f.database,{academyId:f.a,seeds:[]});assert.equal(r.crossTenantReference,true);assert.deepEqual(byRelation(r),{'public.academies':1,'public.people':2});assert.equal(r.retainedCount,3);noDeletion(r);
  assert.equal((await f.pg.query('SELECT * FROM public.people WHERE academy_id=$1',[f.b])).rows.length,1);
 }finally{await f.pg.close();}
});
test('record-key fingerprints detect changed reference closure but do not pretend to hash private record contents',async()=>{
 const f=await fixture();try{
  const input={academyId:f.a,seeds:[{relation:'public.revisions',key:[f.a,'601']}]},before=await inspectRetainedDispositionRows(f.database,input);
  await f.pg.query('UPDATE public.heads SET teacher=3 WHERE academy_id=$1 AND id=501',[f.a]);
  const after=await inspectRetainedDispositionRows(f.database,input);assert.equal(before.structuralFingerprint,after.structuralFingerprint);assert.deepEqual(byRelation(before),byRelation(after));assert.notEqual(before.relations.find(s=>s.relation==='public.people')!.fingerprint,after.relations.find(s=>s.relation==='public.people')!.fingerprint);
  await f.pg.query("UPDATE public.people SET private_note='different private contents' WHERE academy_id=$1",[f.a]);
  assert.deepEqual((await inspectRetainedDispositionRows(f.database,input)).relations,after.relations);noDeletion(after);
 }finally{await f.pg.close();}
});
test('missing school,foreign-school or nonexistent seeds never produce a partial success and connections are released',async()=>{
 const f=await fixture();try{
  for(const input of [{academyId:randomUUID(),seeds:[]},{academyId:f.a,seeds:[{relation:'public.people',key:[f.b,'1']}]},{academyId:f.a,seeds:[{relation:'public.people',key:[f.a,'999']}] }])await assert.rejects(inspectRetainedDispositionRows(f.database,input),(e:any)=>e.code==='DISPOSITION_RETENTION_SOURCE_MISSING');
  const r=await inspectRetainedDispositionRows(f.database,{academyId:f.a,seeds:[]});assert.equal(r.retainedCount,2);assert.deepEqual(f.counters(),{connections:4,released:4});
 }finally{await f.pg.close();}
});
test('retained-row bound fails closed instead of returning a truncated closure;exact limit and empty seeds work',async()=>{
 const f=await fixture();try{
  const seeds=[{relation:'public.revisions',key:[f.a,'601']}];await assert.rejects(inspectRetainedDispositionRows(f.database,{academyId:f.a,seeds,maxRows:4}),(e:any)=>e.code==='DISPOSITION_RETENTION_LIMIT_EXCEEDED');
  assert.equal((await inspectRetainedDispositionRows(f.database,{academyId:f.a,seeds,maxRows:5})).retainedCount,5);
  const empty=await inspectRetainedDispositionRows(f.database,{academyId:f.b,seeds:[],maxRows:1});assert.deepEqual(byRelation(empty),{'public.academies':1});noDeletion(empty);
 }finally{await f.pg.close();}
});
test('input identifiers,key arity,duplicate seeds and attempts to inject policy authority are rejected',async()=>{
 const f=await fixture();try{
  const seed={relation:'public.people',key:[f.a,'1']};
  for(const patch of [{seeds:[{...seed,relation:'public.people;DELETE'}]},{seeds:[{...seed,relation:'auth_private.evidence'}]},{seeds:[seed,seed]},{maxRows:0},{maxRows:1000001},{executionAuthorized:true},{seeds:[{...seed,key:[f.a]}]},{seeds:[{...seed,relation:'public.missing'}] }])await assert.rejects(inspectRetainedDispositionRows(f.database,{academyId:f.a,seeds:[],...patch}),(e:any)=>e.code==='DISPOSITION_RETENTION_INPUT_INVALID');
  await assert.rejects(inspectRetainedDispositionRows(f.database,{academyId:f.a,seeds:[{relation:'public.people',key:[f.a,'1 OR 1=1']}]}),(e:any)=>e.code==='DISPOSITION_RETENTION_SOURCE_MISSING');
 }finally{await f.pg.close();}
});
test('the native transaction is repeatable-read,read-only and refuses writes without changing source data',async()=>{
 const f=await fixture();let checked=false;try{
  const originalJit=(await f.pg.query("SELECT current_setting('jit') value")).rows[0].value;
  const database:Database={async connect(){return{async query<Row>(sql:string,params?:unknown[]){
   if(sql.startsWith('WITH RECURSIVE requested')){
    const settings=(await f.pg.query("SELECT current_setting('transaction_isolation') isolation,current_setting('transaction_read_only') read_only,current_setting('row_security') row_security,current_setting('jit') jit")).rows[0];assert.deepEqual(settings,{isolation:'repeatable read',read_only:'on',row_security:'off',jit:'off'});
    await f.pg.exec('SAVEPOINT forbidden_write');await assert.rejects(f.pg.query('UPDATE public.people SET private_note=$1',['changed']),(e:any)=>e.code==='25006');await f.pg.exec('ROLLBACK TO SAVEPOINT forbidden_write');checked=true;
   }return f.pg.query<Row>(sql,params);
  },release(){}};}};
  const r=await inspectRetainedDispositionRows(database,{academyId:f.a,seeds:[]});assert.equal(checked,true);noDeletion(r);assert.equal((await f.pg.query('SELECT count(*)::integer count FROM public.people WHERE private_note=$1',['changed'])).rows[0].count,0);
  assert.equal((await f.pg.query("SELECT current_setting('jit') value")).rows[0].value,originalJit);
 }finally{await f.pg.close();}
});
test('an RLS-filtered runtime cannot silently certify incomplete retained records',async()=>{
 const f=await fixture(),role='synthetic_disposition_'+randomUUID().replaceAll('-','');let created=false;try{
  await f.pg.exec('CREATE ROLE '+role);created=true;
  await f.pg.exec(`GRANT USAGE ON SCHEMA public,auth_private TO ${role};GRANT SELECT ON ALL TABLES IN SCHEMA public,auth_private TO ${role};ALTER TABLE public.people ENABLE ROW LEVEL SECURITY;CREATE POLICY only_some ON public.people FOR SELECT TO ${role} USING(id=1);SET ROLE ${role}`);
  await assert.rejects(inspectRetainedDispositionRows(f.database,{academyId:f.a,seeds:[]}),(e:any)=>e.code==='42501');assert.deepEqual(f.counters(),{connections:1,released:1});
 }finally{try{await f.pg.exec('RESET ROLE');if(created)await f.pg.exec(`DROP POLICY IF EXISTS only_some ON public.people;REVOKE ALL ON ALL TABLES IN SCHEMA public,auth_private FROM ${role};REVOKE ALL ON SCHEMA public,auth_private FROM ${role};DROP ROLE ${role}`);}finally{await f.pg.close();}}
});
test('actual current academy schema produces a bounded record closure without sending private records to JavaScript',async()=>{
 const f=await operationsFixture();try{
  const database:Database={async connect(){return{query:f.pg.query.bind(f.pg),release(){}};}};
  const engine=(await f.pg.query("SELECT current_setting('server_version_num') version,pg_jit_available() jit_available,current_setting('jit') jit_default")).rows[0];
  const started=performance.now(),r=await inspectRetainedDispositionRows(database,{academyId:f.a,seeds:[{relation:'public.people',key:[f.a,f.actors.master.person]}]});
  assert.equal(r.crossTenantReference,false);assert.ok(r.retainedCount>=2);assert.ok(r.relations.some(s=>s.relation==='public.people'));noDeletion(r);
  assert.equal((await f.pg.query('SELECT count(*)::integer count FROM public.academies')).rows[0].count,2);
  console.log(JSON.stringify({case:'actual-schema-retained-closure',engine,durationMs:Math.round(performance.now()-started),retainedCount:r.retainedCount,relationCount:r.relations.length,closureComplete:r.closureComplete,dataDeleted:r.dataDeleted}));
 }finally{await f.pg.close();}
});
