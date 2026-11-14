import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import type {Database} from '../src/core/database.ts';
import {inspectRetainedDispositionRows,inspectDispositionManifest} from '../src/platform/disposition-retained-rows.ts';
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
  assert.equal(r.recordScopeEvaluated,true);assert.match(r.structuralFingerprint,/^[a-f0-9]{64}$/);assert.ok(r.relations.every(s=>/^[a-f0-9]{64}$/.test(s.fingerprint)));assert.doesNotMatch(JSON.stringify(r),/private A|private B|"601"|Synthetic A/);
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

test('source manifest fingerprints exact candidate keys and full school rows without exporting private records',async()=>{
 const f=await fixture();try{
  const input={academyId:f.a,seeds:[{relation:'public.revisions',key:[f.a,'601']}]},r=await inspectDispositionManifest(f.database,input),m=r.sourceManifest;
  assert.equal(m.version,1);assert.equal(m.totalRows,8);assert.equal(m.retainedRows,5);assert.equal(m.candidateRows,3);assert.match(m.fingerprint,/^[a-f0-9]{64}$/);
  assert.deepEqual(Object.fromEntries(m.relations.map(s=>[s.relation,[s.totalRows,s.retainedRows,s.candidateRows]])),{'public.academies':[1,1,0],'public.heads':[2,1,1],'public.people':[3,2,1],'public.revisions':[2,1,1]});
  assert.ok(m.relations.every(s=>/^[a-f0-9]{64}$/.test(s.sourceFingerprint)&&/^[a-f0-9]{64}$/.test(s.candidateKeyFingerprint)));assert.doesNotMatch(JSON.stringify(m),/private A|private B|Synthetic A|record_key|"601"/);noDeletion(r);
  assert.deepEqual((await inspectDispositionManifest(f.database,{...input,seeds:[...input.seeds,{relation:'public.people',key:[f.a,'1']}]})).sourceManifest,m);
  assert.equal((await inspectRetainedDispositionRows(f.database,input)).sourceManifest,null);
 }finally{await f.pg.close();}
});
test('content and external-reference edits invalidate the manifest while another school edit does not',async()=>{
 const f=await fixture();try{
  const input={academyId:f.a,seeds:[{relation:'public.revisions',key:[f.a,'601']}]},before=(await inspectDispositionManifest(f.database,input)).sourceManifest;
  await f.pg.query("UPDATE public.people SET private_note='candidate edited' WHERE academy_id=$1 AND id=3",[f.a]);
  const candidate=(await inspectDispositionManifest(f.database,input)).sourceManifest;assert.notEqual(before.fingerprint,candidate.fingerprint);assert.equal(before.candidateRows,candidate.candidateRows);assert.equal(before.relations.find(s=>s.relation==='public.people')!.candidateKeyFingerprint,candidate.relations.find(s=>s.relation==='public.people')!.candidateKeyFingerprint);
  await f.pg.query("UPDATE public.people SET private_note='retained evidence edited' WHERE academy_id=$1 AND id=2",[f.a]);
  const retained=(await inspectDispositionManifest(f.database,input)).sourceManifest;assert.notEqual(candidate.fingerprint,retained.fingerprint);
  await f.pg.query("UPDATE public.people SET private_note='other school edited' WHERE academy_id=$1",[f.b]);assert.deepEqual((await inspectDispositionManifest(f.database,input)).sourceManifest,retained);
  await f.pg.exec('UPDATE auth_private.evidence SET person=3 WHERE id=1');
  const external=(await inspectDispositionManifest(f.database,input)).sourceManifest;assert.notEqual(external.fingerprint,retained.fingerprint);assert.equal(external.totalRows,retained.totalRows);assert.equal(external.retainedRows,retained.retainedRows);assert.deepEqual(external.relations.map(s=>s.sourceFingerprint),retained.relations.map(s=>s.sourceFingerprint));assert.notEqual(external.relations.find(s=>s.relation==='public.people')!.candidateKeyFingerprint,retained.relations.find(s=>s.relation==='public.people')!.candidateKeyFingerprint);
 }finally{await f.pg.close();}
});
test('new and removed candidate rows change the exact snapshot even when the schema and retained keys stay the same',async()=>{
 const f=await fixture();try{
  const input={academyId:f.a,seeds:[]},before=await inspectDispositionManifest(f.database,input);
  await f.pg.query("INSERT INTO public.people VALUES($1,4,'new private row')",[f.a]);
  const added=await inspectDispositionManifest(f.database,input);assert.equal(before.structuralFingerprint,added.structuralFingerprint);assert.equal(before.retainedCount,added.retainedCount);assert.equal(added.sourceManifest.candidateRows,before.sourceManifest.candidateRows+1);assert.notEqual(before.sourceManifest.fingerprint,added.sourceManifest.fingerprint);
  await f.pg.query('DELETE FROM public.people WHERE academy_id=$1 AND id=4',[f.a]);assert.deepEqual((await inspectDispositionManifest(f.database,input)).sourceManifest,before.sourceManifest);
 }finally{await f.pg.close();}
});
test('source limits are independent of retained-row limits and never certify a truncated manifest',async()=>{
 const f=await fixture();try{
  const input={academyId:f.a,seeds:[{relation:'public.revisions',key:[f.a,'601']}],maxRows:5};
  await assert.rejects(inspectDispositionManifest(f.database,{...input,maxSourceRows:7}),(e:any)=>e.code==='DISPOSITION_MANIFEST_LIMIT_EXCEEDED');
  const r=await inspectDispositionManifest(f.database,{...input,maxSourceRows:8});assert.equal(r.retainedCount,5);assert.equal(r.sourceManifest.totalRows,8);assert.deepEqual(f.counters(),{connections:2,released:2});noDeletion(r);
  for(const patch of [{maxSourceRows:0},{maxSourceRows:1000001},{maxSourceRows:'8'},{approved:true},{executionAuthorized:true}])await assert.rejects(inspectDispositionManifest(f.database,{...input,...patch}),(e:any)=>e.code==='DISPOSITION_RETENTION_INPUT_INVALID');assert.deepEqual(f.counters(),{connections:2,released:2});
 }finally{await f.pg.close();}
});
test('native content hashes are canonical across caller timezone,date,float,binary and interval settings without changing them',async()=>{
 const f=await fixture();try{
  await f.pg.exec('ALTER TABLE public.people ADD COLUMN seen_at timestamptz,ADD COLUMN ratio double precision,ADD COLUMN proof bytea,ADD COLUMN duration interval');
  await f.pg.query("UPDATE public.people SET seen_at='2026-03-08T07:30:00Z'::timestamptz,ratio=1.2345678901234567,proof=decode('00ff5c61','hex'),duration=interval '2 months 3 days 04:05:06' WHERE academy_id=$1",[f.a]);
  await f.pg.exec("SET TimeZone='America/Toronto';SET DateStyle='SQL,DMY';SET extra_float_digits=0;SET bytea_output='escape';SET IntervalStyle='postgres_verbose'");
  const settings="SELECT current_setting('TimeZone') tz,current_setting('DateStyle') dates,current_setting('extra_float_digits') floats,current_setting('bytea_output') binary,current_setting('IntervalStyle') intervals,current_setting('search_path') path",original=(await f.pg.query(settings)).rows[0],input={academyId:f.a,seeds:[]};
  const a=await inspectDispositionManifest(f.database,input);assert.deepEqual((await f.pg.query(settings)).rows[0],original);
  await f.pg.exec("SET TimeZone='Asia/Shanghai';SET DateStyle='German,DMY';SET extra_float_digits=1;SET bytea_output='hex';SET IntervalStyle='sql_standard'");const changed=(await f.pg.query(settings)).rows[0];
  const b=await inspectDispositionManifest(f.database,input);assert.deepEqual(a.sourceManifest,b.sourceManifest);assert.deepEqual((await f.pg.query(settings)).rows[0],changed);
 }finally{await f.pg.close();}
});
test('having reference-key access alone does not grant permission to fingerprint protected row content',async()=>{
 const f=await fixture(),role='synthetic_manifest_'+randomUUID().replaceAll('-','');let created=false;try{
  await f.pg.exec('CREATE ROLE '+role);created=true;
  await f.pg.exec(`GRANT USAGE ON SCHEMA public,auth_private TO ${role};GRANT SELECT ON ALL TABLES IN SCHEMA public,auth_private TO ${role};REVOKE ALL ON public.people FROM ${role};GRANT SELECT(academy_id,id) ON public.people TO ${role};SET ROLE ${role}`);
  const input={academyId:f.a,seeds:[]};assert.equal((await inspectRetainedDispositionRows(f.database,input)).retainedCount,2);
  await assert.rejects(inspectDispositionManifest(f.database,input),(e:any)=>e.code==='42501');
 }finally{try{await f.pg.exec('RESET ROLE');if(created)await f.pg.exec(`DROP OWNED BY ${role};DROP ROLE ${role}`);}finally{await f.pg.close();}}
});
test('caller search-path shadow functions cannot forge native content or candidate fingerprints',async()=>{
 const f=await fixture();try{
  const input={academyId:f.a,seeds:[]},before=await inspectDispositionManifest(f.database,input);
  await f.pg.exec("CREATE FUNCTION public.sha256(bytea) RETURNS bytea LANGUAGE sql IMMUTABLE AS $$ SELECT pg_catalog.decode(pg_catalog.repeat('00',32),'hex') $$;SET search_path=public,pg_catalog");
  assert.equal((await f.pg.query("SELECT encode(sha256('synthetic'::bytea),'hex') hash")).rows[0].hash,'00'.repeat(32));
  assert.deepEqual((await inspectDispositionManifest(f.database,input)).sourceManifest,before.sourceManifest);
  assert.equal((await f.pg.query("SELECT current_setting('search_path') path")).rows[0].path,'public, pg_catalog');
 }finally{await f.pg.close();}
});
test('actual full academy schema produces a content-bound manifest under the same native snapshot and limits',async()=>{
 const f=await operationsFixture();try{
  const database:Database={async connect(){return{query:f.pg.query.bind(f.pg),release(){}};}},started=performance.now();
  const r=await inspectDispositionManifest(database,{academyId:f.a,seeds:[{relation:'public.people',key:[f.a,f.actors.master.person]}]});
  assert.equal(r.sourceManifest.retainedRows,r.retainedCount);assert.ok(r.sourceManifest.totalRows>=r.retainedCount);assert.equal(r.sourceManifest.totalRows,r.sourceManifest.candidateRows+r.retainedCount);noDeletion(r);
  assert.equal((await f.pg.query('SELECT count(*)::integer count FROM public.academies')).rows[0].count,2);
  console.log(JSON.stringify({case:'actual-schema-disposition-manifest',durationMs:Math.round(performance.now()-started),sourceRows:r.sourceManifest.totalRows,candidateRows:r.sourceManifest.candidateRows,retainedRows:r.retainedCount,sourceRelations:r.sourceManifest.relations.length,dataDeleted:r.dataDeleted}));
 }finally{await f.pg.close();}
});
