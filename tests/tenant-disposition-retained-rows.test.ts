import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {readdir} from 'node:fs/promises';
import {expectedSchemaRevision,type Database} from '../src/core/database.ts';
import {inspectRetainedDispositionRows,inspectDispositionManifest} from '../src/platform/disposition-retained-rows.ts';
import {testDatabase} from './database.ts';
import {operationsFixture} from './operations-fixture.ts';
import {dispositionInspectorRole,dispositionInspectorSignature} from '../src/platform/disposition-native-inspector.ts';
import {installDispositionInspectorInTransaction,inspectDispositionInstallation} from '../src/platform/disposition-installation.ts';
import {upgradeToCurrent} from './migration-upgrade.ts';

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

test('sealed owner snapshot has native authority,audit and SELECT-only isolation without accepting caller SQL',async t=>{
 const f=await operationsFixture(),client='synthetic_disposition_client_'+randomUUID().replaceAll('-',''),role=dispositionInspectorRole;let installed=false;
 const quote=(name:string)=>'"'+name.replaceAll('"','""')+'"';
 try{
  const operatorSession=(await f.pg.query<{name:string}>('SELECT session_user name')).rows[0].name;
  const owner=f.actors.master;await f.pg.query('SELECT platform_private.register_owner($1,$2)',[owner.user,'Synthetic owner snapshot authority']);
  await f.pg.exec('BEGIN');try{
   await f.pg.exec(`CREATE ROLE ${client} NOLOGIN;GRANT USAGE ON SCHEMA platform_private TO ${client};`);
   await installDispositionInspectorInTransaction(f.pg);assert.equal((await inspectDispositionInstallation(f.pg)).current,true);assert.equal((await installDispositionInspectorInTransaction(f.pg)).changed,false);
   await f.pg.exec(`GRANT EXECUTE ON FUNCTION ${dispositionInspectorSignature} TO ${client}`);await f.pg.exec('COMMIT');installed=true;
  }catch(error){await f.pg.exec('ROLLBACK');throw error;}
  const seeds=[{relation:'public.people',key:[f.a,owner.person]}];
  async function asClient<Row=Record<string,unknown>>(sql:string,args:unknown[]=[]){
   // SET ROLE alone preserves a superuser session_user and can still SET ROLE
   // to arbitrary roles. Model the actual restricted connection identity too.
   await f.pg.exec(`SET SESSION AUTHORIZATION ${client}`);let begun=false;try{
    await f.pg.exec("BEGIN;SET LOCAL statement_timeout='15s'");begun=true;
    const result=await f.pg.query<Row>(sql,args);await f.pg.exec('COMMIT');begun=false;return result;
   }finally{try{if(begun)await f.pg.exec('ROLLBACK');}finally{
    // Observed embedded18.6 leaves session_user unchanged on RESET SESSION
    // AUTHORIZATION even while clearing its GUC. Restore the observed identity
    // explicitly,and verify actual privileges rather than trusting RESET text.
    await f.pg.exec('SET SESSION AUTHORIZATION '+quote(operatorSession)+';RESET ROLE');
    assert.deepEqual((await f.pg.query('SELECT current_user name,session_user session')).rows[0],{name:operatorSession,session:operatorSession});
   }}
  }
  const inspect=async(patch:{user?:string;session?:string;academy?:string;seeds?:unknown;limit?:number;maxSource?:number;purpose?:string}={})=>(await asClient<{result:any}>('SELECT platform_private.inspect_disposition_manifest($1,$2,$3,$4::jsonb,$5,$6,$7) result',[patch.user??owner.user,patch.session??owner.session,patch.academy??f.a,JSON.stringify(patch.seeds??seeds),patch.limit??100000,patch.maxSource??100000,patch.purpose??'Synthetic exact-source owner review'])).rows[0].result;
  await t.test('native result matches the shared planner,records audit and leaves protected source records unchanged',async()=>{
   const database:Database={async connect(){return{query:f.pg.query.bind(f.pg),release(){}};}},oracle=await inspectDispositionManifest(database,{academyId:f.a,seeds}),before=(await f.pg.query('SELECT to_jsonb(p) data FROM public.people p ORDER BY academy_id,id')).rows,started=performance.now();
   const result=await inspect();assert.equal(result.snapshot.retained_count,oracle.retainedCount);assert.deepEqual(result.snapshot.relations,oracle.relations);const{fingerprint:_,...source}=oracle.sourceManifest;assert.deepEqual(result.snapshot.source_manifest,source);assert.equal(result.executionAuthorized,false);assert.equal(result.dataDeleted,false);assert.equal(result.retentionEvaluated,false);assert.match(result.sourceFingerprint,/^[a-f0-9]{64}$/);
   const audit=(await f.pg.query<any>('SELECT actor_user_id,session_id,academy_id,after_data FROM platform_private.audit_events WHERE id=$1',[result.auditId])).rows[0];assert.equal(audit.actor_user_id,owner.user);assert.equal(audit.session_id,owner.session);assert.equal(audit.academy_id,f.a);assert.equal(audit.after_data.sourceFingerprint,result.sourceFingerprint);assert.deepEqual((await f.pg.query('SELECT to_jsonb(p) data FROM public.people p ORDER BY academy_id,id')).rows,before);
   console.log(JSON.stringify({case:'sealed-native-owner-snapshot',durationMs:Math.round(performance.now()-started),retainedRows:result.snapshot.retained_count,sourceRows:source.totalRows,auditRecorded:true,dataDeleted:false}));
   await assert.rejects(asClient('SELECT * FROM public.people'),(e:any)=>e.code==='42501');await assert.rejects(asClient('SET ROLE '+role),(e:any)=>e.code==='42501');
   assert.equal((await f.pg.query("SELECT has_function_privilege('kavosh_runtime',$1,'EXECUTE') allowed",[dispositionInspectorSignature])).rows[0].allowed,false);
  });
  await t.test('unverified or non-owner actors,invalid inputs and source limits never create a successful snapshot audit',async()=>{
   const count=async()=>(await f.pg.query("SELECT count(*)::integer n FROM platform_private.audit_events WHERE action='platform.disposition.snapshot.read'")).rows[0].n,before=await count();
   await assert.rejects(inspect({user:f.actors.foreignMaster.user,session:f.actors.foreignMaster.session}),(e:any)=>e.code==='42501');await assert.rejects(inspect({session:randomUUID()}),(e:any)=>e.code==='42501');
   await f.pg.query('UPDATE identity.session SET "mfaVerified"=false WHERE id=$1',[owner.session]);try{await assert.rejects(inspect(),(e:any)=>e.code==='42501');}finally{await f.pg.query('UPDATE identity.session SET "mfaVerified"=true WHERE id=$1',[owner.session]);}
   for(const patch of [{purpose:''},{seeds:[...seeds,...seeds]},{seeds:[{relation:'public.people;DELETE',key:[f.a,owner.person]}]},{seeds:[{relation:'public.people',key:[f.a,owner.person],approved:true}]},{limit:0},{maxSource:0}])await assert.rejects(inspect(patch),(e:any)=>e.code==='22023');
   await assert.rejects(inspect({limit:1}),(e:any)=>e.message==='DISPOSITION_RETENTION_LIMIT_EXCEEDED');await assert.rejects(inspect({maxSource:1}),(e:any)=>e.message==='DISPOSITION_MANIFEST_LIMIT_EXCEEDED');await assert.rejects(inspect({seeds:[{relation:'public.people',key:[f.b,f.actors.foreignMaster.person]}]}),(e:any)=>e.message==='DISPOSITION_RETENTION_SOURCE_MISSING');assert.equal(await count(),before);
  });
  await t.test('missing,restrictive or writable reader permissions and catalog drift fail closed',async()=>{
   await f.pg.exec(`BEGIN;SET LOCAL ROLE ${role};SET LOCAL row_security=off`);try{assert.equal((await f.pg.query("SELECT has_table_privilege(current_user,'public.people','SELECT') allowed")).rows[0].allowed,true);await assert.rejects(f.pg.query('SELECT academy_id,id FROM public.people'),(e:any)=>e.code==='42501');}finally{await f.pg.exec('ROLLBACK');}
   await f.pg.exec(`ALTER ROLE ${role} LOGIN`);try{await assert.rejects(inspect(),(e:any)=>e.message==='UNSAFE_DISPOSITION_READER');}finally{await f.pg.exec(`ALTER ROLE ${role} NOLOGIN`);}
   await f.pg.exec('DROP POLICY disposition_reader_select ON public.people');try{await assert.rejects(inspect(),(e:any)=>e.message==='UNSAFE_DISPOSITION_READER');}finally{await f.pg.exec(`CREATE POLICY disposition_reader_select ON public.people FOR SELECT TO ${role} USING(true)`);}
   await f.pg.exec(`CREATE POLICY synthetic_restrict ON public.people AS RESTRICTIVE FOR SELECT TO ${role} USING(false)`);try{await assert.rejects(inspect(),(e:any)=>e.message==='UNSAFE_DISPOSITION_READER');}finally{await f.pg.exec('DROP POLICY synthetic_restrict ON public.people');}
   await f.pg.exec(`GRANT UPDATE(name) ON public.people TO ${role}`);try{await assert.rejects(inspect(),(e:any)=>e.message==='UNSAFE_DISPOSITION_READER');}finally{await f.pg.exec(`REVOKE UPDATE(name) ON public.people FROM ${role}`);}
   await f.pg.exec('CREATE TABLE public.synthetic_disposition_drift(academy_id uuid NOT NULL,id uuid PRIMARY KEY)');try{await assert.rejects(inspect(),(e:any)=>e.message==='DISPOSITION_SCHEMA_CHANGED');}finally{await f.pg.exec('DROP TABLE public.synthetic_disposition_drift');}
   assert.equal((await inspect()).dataDeleted,false);
  });
  await t.test('real legal holds block preparation and an audit write failure rolls back the entire read receipt',async()=>{
   const hold=(await f.pg.query<{r:any}>("SELECT platform_private.request($1,$2,'holds.create',$3,$4::jsonb) r",[owner.user,owner.session,randomUUID(),JSON.stringify({academyId:f.a,caseReference:'SEALED-SNAPSHOT-HOLD',reason:'Synthetic hold protects all school records'})])).rows[0].r.body.data;
   await assert.rejects(inspect(),(e:any)=>e.message==='ACADEMY_LEGAL_HOLD_ACTIVE');await f.pg.query("SELECT platform_private.request($1,$2,'holds.release',$3,$4::jsonb)",[owner.user,owner.session,randomUUID(),JSON.stringify({academyId:f.a,holdId:hold.id,confirmAcademyId:f.a,expectedVersion:1,reason:'Synthetic hold review completed'})]);
   const before=(await f.pg.query("SELECT count(*)::integer n FROM platform_private.audit_events WHERE action='platform.disposition.snapshot.read'")).rows[0].n;
   await f.pg.exec("CREATE FUNCTION platform_private.synthetic_snapshot_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='platform.disposition.snapshot.read' THEN RAISE EXCEPTION 'synthetic snapshot audit failure';END IF;RETURN NEW;END $$;CREATE TRIGGER synthetic_snapshot_audit_failure BEFORE INSERT ON platform_private.audit_events FOR EACH ROW EXECUTE FUNCTION platform_private.synthetic_snapshot_audit_failure()");
   try{await assert.rejects(inspect(),/synthetic snapshot audit failure/);}finally{await f.pg.exec('DROP TRIGGER synthetic_snapshot_audit_failure ON platform_private.audit_events');}assert.equal((await f.pg.query("SELECT count(*)::integer n FROM platform_private.audit_events WHERE action='platform.disposition.snapshot.read'")).rows[0].n,before);assert.equal((await inspect()).dataDeleted,false);
  });
 }finally{
  try{await f.pg.exec('RESET ROLE');if(installed){await f.pg.exec('DROP OWNED BY '+client+';DROP ROLE '+client);}}finally{await f.pg.close();}
 }
});

test('managed disposition installation is repeatable,read-only when current and transactionally recoverable',async t=>{
 const f=await operationsFixture(),role=dispositionInspectorRole;
 const inspect=()=>inspectDispositionInstallation(f.pg);
 async function isolated(action:()=>Promise<void>){await f.pg.exec('BEGIN');try{await action();}finally{await f.pg.exec('ROLLBACK');}}
 try{
  const baseline=await inspect();assert.equal(baseline.current,true);
  const identity=async()=>(await f.pg.query('SELECT oid,proowner,proacl::text FROM pg_proc WHERE oid=$1::regprocedure',[dispositionInspectorSignature])).rows[0],before=await identity();
  await t.test('current preflight and repeated install issue no writes even in a read-only transaction',async()=>{
   await f.pg.exec('BEGIN READ ONLY');try{assert.equal((await inspect()).current,true);assert.equal((await installDispositionInspectorInTransaction(f.pg)).changed,false);}finally{await f.pg.exec('ROLLBACK');}assert.deepEqual(await identity(),before);
  });
  await t.test('catalog updates including dollar identifiers seal correctly and all DDL rolls back together',async()=>{
   await isolated(async()=>{
    await f.pg.exec('CREATE TABLE public."disposition$$quoted"(academy_id uuid NOT NULL,id uuid NOT NULL,PRIMARY KEY(academy_id,id));ALTER TABLE public."disposition$$quoted" ENABLE ROW LEVEL SECURITY;ALTER TABLE public."disposition$$quoted" FORCE ROW LEVEL SECURITY');
    assert.equal((await inspect()).current,false);assert.equal((await installDispositionInspectorInTransaction(f.pg)).changed,true);assert.equal((await inspect()).current,true);assert.equal((await installDispositionInspectorInTransaction(f.pg)).changed,false);
   });assert.deepEqual(await inspect(),baseline);assert.deepEqual(await identity(),before);assert.equal((await f.pg.query("SELECT to_regclass('public.\"disposition$$quoted\"') value")).rows[0].value,null);
  });
  await t.test('unsafe write privileges are rejected while missing declared dependencies and settings are repairable',async()=>{
   await isolated(async()=>{await f.pg.exec(`GRANT UPDATE(name) ON public.people TO ${role}`);assert.equal((await inspect()).boundarySafe,false);await assert.rejects(installDispositionInspectorInTransaction(f.pg),/UNSAFE_DISPOSITION_READER/);});
   await isolated(async()=>{await f.pg.exec(`REVOKE SELECT("phoneNumber") ON identity."user" FROM ${role}`);assert.equal((await inspect()).current,false);assert.equal((await installDispositionInspectorInTransaction(f.pg)).changed,true);assert.equal((await inspect()).current,true);});
   await isolated(async()=>{await f.pg.exec(`ALTER FUNCTION ${dispositionInspectorSignature} SET jit=on`);assert.equal((await inspect()).current,false);assert.equal((await installDispositionInspectorInTransaction(f.pg)).changed,true);assert.equal((await inspect()).current,true);});assert.deepEqual(await inspect(),baseline);
  });
  await t.test('restrictive policies are not silently removed to manufacture a successful installation',async()=>{
   await isolated(async()=>{await f.pg.exec(`CREATE POLICY synthetic_install_restrict ON public.people AS RESTRICTIVE FOR SELECT TO ${role} USING(false)`);assert.equal((await inspect()).current,false);await assert.rejects(installDispositionInspectorInTransaction(f.pg),/DISPOSITION_INSPECTOR_INSTALLATION_INVALID/);});assert.deepEqual(await inspect(),baseline);assert.deepEqual(await identity(),before);
  });
 }finally{await f.pg.close();}
});

test('actual migration CLI installs,checks,repairs and rolls back on an owned native database',{skip:!process.env.TEST_DATABASE_URL},async()=>{
 const db=await testDatabase();try{
  const name=(await db.query<{name:string}>('SELECT current_database() name')).rows[0].name;assert.match(name,/^kavosh_test_[a-f0-9]{32}$/);
  const url=new URL(process.env.TEST_DATABASE_URL!);assert.ok(['localhost','127.0.0.1','[::1]'].includes(url.hostname));url.pathname='/'+name;
  const cli=(args:string[]=[])=>{const result=spawnSync(process.execPath,['--import','tsx',fileURLToPath(new URL('../scripts/migrate.ts',import.meta.url)),...args],{cwd:fileURLToPath(new URL('../',import.meta.url)),env:{PATH:process.env.PATH??'',NODE_ENV:'test',DATABASE_SSL_MODE:'disable',MIGRATION_DATABASE_URL:url.toString()},encoding:'utf8',timeout:60000,maxBuffer:262144});if(url.password)assert.ok(!(result.stdout+result.stderr).includes(url.password));return result;};
  // Intentionally unsafe existing role,only in this disposable test cluster.
  // The CLI must roll its entire SQL+native installation back,not leave a
  // misleading schema ledger behind. Restore the role even if the child fails.
  await db.exec(`DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='${dispositionInspectorRole}') THEN CREATE ROLE ${dispositionInspectorRole} NOLOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOREPLICATION;END IF;END $$`);assert.equal((await db.query('SELECT rolcanlogin FROM pg_roles WHERE rolname=$1',[dispositionInspectorRole])).rows[0].rolcanlogin,false);
  await db.exec(`ALTER ROLE ${dispositionInspectorRole} LOGIN`);try{const failed=cli();assert.equal(failed.status,1);assert.doesNotMatch(failed.stdout,/Applied |Installed /);assert.equal((await db.query("SELECT to_regclass('public.schema_migrations') ledger,to_regclass('public.academies') academy")).rows[0].ledger,null);assert.equal((await db.query("SELECT to_regclass('public.academies') value")).rows[0].value,null);}finally{await db.exec(`ALTER ROLE ${dispositionInspectorRole} NOLOGIN`);}
  const started=performance.now(),first=cli();assert.equal(first.status,0,first.stderr.slice(-1000));assert.equal((await db.query('SELECT public.schema_revision() revision')).rows[0].revision,expectedSchemaRevision);assert.equal((await inspectDispositionInstallation(db)).current,true);
  const names=(await readdir(new URL('../db/migrations/',import.meta.url))).filter(n=>n.endsWith('.sql'));assert.equal((await db.query('SELECT count(*)::integer n FROM public.schema_migrations')).rows[0].n,names.length);
  const history=(await db.query('SELECT name,checksum,applied_at FROM public.schema_migrations ORDER BY name')).rows,identity=(await db.query('SELECT oid,proowner,proacl::text,prosrc FROM pg_proc WHERE oid=$1::regprocedure',[dispositionInspectorSignature])).rows;
  const repeated=cli();assert.equal(repeated.status,0,repeated.stderr.slice(-1000));assert.equal(repeated.stdout.trim(),'');assert.deepEqual((await db.query('SELECT name,checksum,applied_at FROM public.schema_migrations ORDER BY name')).rows,history);assert.deepEqual((await db.query('SELECT oid,proowner,proacl::text,prosrc FROM pg_proc WHERE oid=$1::regprocedure',[dispositionInspectorSignature])).rows,identity);
  const checked=cli(['--check']);assert.equal(checked.status,0);assert.equal(JSON.parse(checked.stdout).nativeDispositionInspector.current,true);assert.equal(JSON.parse(checked.stdout).databaseChanged,false);
  await db.exec(`ALTER FUNCTION ${dispositionInspectorSignature} SET jit=on`);const stale=cli(['--check']);assert.equal(stale.status,1);assert.equal(JSON.parse(stale.stdout).nativeDispositionInspector.current,false);assert.equal(JSON.parse(stale.stdout).databaseChanged,false);assert.ok((await db.query<{configs:string[]}>('SELECT proconfig configs FROM pg_proc WHERE oid=$1::regprocedure',[dispositionInspectorSignature])).rows[0].configs.includes('jit=on'));
  const repaired=cli();assert.equal(repaired.status,0,repaired.stderr.slice(-1000));assert.match(repaired.stdout,/Installed sealed native disposition inspector/);assert.equal((await inspectDispositionInstallation(db)).current,true);assert.deepEqual((await db.query('SELECT name,checksum,applied_at FROM public.schema_migrations ORDER BY name')).rows,history);
  console.log(JSON.stringify({case:'actual-native-migration-cli',schema:expectedSchemaRevision,files:names.length,failedInstallRolledBack:true,repeatUnchanged:true,readOnlyStaleCheck:true,repairVerified:true,durationMs:Math.round(performance.now()-started),productionChanged:false}));
 }finally{await db.close();}
});

test('real427 upgrade installs the native broker without changing existing school,identity,permissions or legal-hold evidence',async()=>{
 const f=await operationsFixture({throughSchema:427});try{
  const owner=f.actors.master;await f.pg.query('SELECT platform_private.register_owner($1,$2)',[owner.user,'Synthetic existing owner']);
  await f.pg.query("SELECT platform_private.request($1,$2,'holds.create',$3,$4::jsonb)",[owner.user,owner.session,randomUUID(),JSON.stringify({academyId:f.a,caseReference:'EXISTING427-HOLD',reason:'Retain existing records during genuine upgrade'})]);
  const tables=['public.academies','public.people','public.roles','public.role_permissions','public.role_assignments','public.assignment_hubs','identity.user','identity.session','auth_private.credentials','platform_private.owner_registration','platform_private.academy_legal_holds','platform_private.academy_legal_hold_releases','platform_private.audit_events','platform_private.request_receipts'];
  const snapshot=async()=>{const rows=[];for(const table of tables)rows.push((await f.pg.query('SELECT to_jsonb(t) row FROM '+table+' t ORDER BY to_jsonb(t)::text')).rows);return rows;},before=await snapshot();
  const functions="SELECT oid,proowner,proconfig,prosrc FROM pg_proc WHERE oid IN('platform_private.request(uuid,uuid,text,uuid,jsonb)'::regprocedure,'platform_private.authorize_owner(uuid,uuid,boolean)'::regprocedure,'platform_private.immutable_record()'::regprocedure) ORDER BY oid",original=(await f.pg.query(functions)).rows;
  const permissions="SELECT p.oid::integer function_id,coalesce(r.rolname,'PUBLIC') grantee,a.privilege_type,a.is_grantable FROM pg_proc p CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a LEFT JOIN pg_roles r ON r.oid=a.grantee WHERE p.oid IN('platform_private.request(uuid,uuid,text,uuid,jsonb)'::regprocedure,'platform_private.authorize_owner(uuid,uuid,boolean)'::regprocedure,'platform_private.immutable_record()'::regprocedure) ORDER BY p.oid,grantee,a.privilege_type",originalPermissions=(await f.pg.query(permissions)).rows;
  assert.equal((await f.pg.query('SELECT public.schema_revision() n')).rows[0].n,427);assert.equal((await f.pg.query('SELECT to_regprocedure($1) fn',[dispositionInspectorSignature])).rows[0].fn,null);
  await upgradeToCurrent(f.pg);assert.equal((await inspectDispositionInstallation(f.pg)).current,true);assert.deepEqual(await snapshot(),before);assert.deepEqual((await f.pg.query(functions)).rows,original);
  const updatedPermissions=(await f.pg.query(permissions)).rows;assert.deepEqual(updatedPermissions.filter(row=>row.grantee!==dispositionInspectorRole),originalPermissions);assert.deepEqual(updatedPermissions.filter(row=>row.grantee===dispositionInspectorRole),[{function_id:(await f.pg.query("SELECT 'platform_private.authorize_owner(uuid,uuid,boolean)'::regprocedure::oid::integer id")).rows[0].id,grantee:dispositionInspectorRole,privilege_type:'EXECUTE',is_grantable:false}]);
  assert.equal((await f.request('people')).response.status,200);console.log(JSON.stringify({case:'427-managed-inspector-upgrade',preservedTables:tables.length,existingFunctionIdentityPreserved:true,legalHoldsPreserved:true,schema:expectedSchemaRevision,productionChanged:false}));
 }finally{await f.pg.close();}
});
