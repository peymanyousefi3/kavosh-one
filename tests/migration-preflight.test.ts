import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {stripTypeScriptTypes} from 'node:module';
import {createContext,runInContext} from 'node:vm';
import {postgresOptions} from '../src/core/postgres-config.ts';

const first='001_first.sql',next='002_next.sql',sql='SELECT 42;',checksum=createHash('sha256').update(sql).digest('hex');
async function run(options:{env?:Record<string,string|undefined>;args?:string[];uid?:number;username?:string;history?:{name:string;checksum:string}[];fail?:string}={}){
 const queries:string[]=[],logs:string[]=[];let connections=0,ended=false,configuration:unknown;
 const env=options.env??{MIGRATION_DATABASE_URL:'postgres://synthetic-private:password@localhost/test',NODE_ENV:'production'};
 const context=createContext({URL,createHash,userInfo:()=>({username:options.username??'postgres'}),
  readdir:async()=>[first,next],readFile:async()=>sql,
  postgresOptions:(value:string|undefined)=>postgresOptions(value,env),
  pg:{Client:class{constructor(value:unknown){configuration=value;connections++;}async connect(){if(options.fail==='connect')throw Error('synthetic-private-connect');}async query(query:string){queries.push(query);if(options.fail===query)throw Error('Migration changed synthetic-private-query');return{rows:query==='SELECT name,checksum FROM public.schema_migrations'?(options.history??[{name:first,checksum}]):[{revision:1}]};}async end(){ended=true;if(options.fail==='end')throw Error('synthetic-private-cleanup');}}},
  process:{env,argv:['node','script',...options.args??['--check']],getuid:()=>options.uid??100,exitCode:undefined as number|undefined},
  console:{log:(value:string)=>logs.push(value),error:(value:string)=>logs.push(value)}});
 const source=stripTypeScriptTypes(readFileSync(new URL('../scripts/migrate.ts',import.meta.url),'utf8')).replace(/^import .*;\n/gm,'').replaceAll('import.meta.url',JSON.stringify(import.meta.url));
 await runInContext('(async()=>{'+source+'})()',context,{timeout:1000});
 assert.doesNotMatch(logs.join(''),/synthetic-private|password/);
 return{queries,logs,connections,ended,configuration,exitCode:context.process.exitCode};
}
test('migration preflight reads history and checksums without applying SQL or creating metadata',async()=>{
 const r=await run();assert.equal(r.exitCode,undefined);assert.ok(r.ended);
 assert.deepEqual(r.configuration,{connectionString:'postgres://synthetic-private:password@localhost/test',ssl:{rejectUnauthorized:true}});
 assert.deepEqual(r.queries,['BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY','SELECT pg_advisory_xact_lock_shared(742061)','SELECT name,checksum FROM public.schema_migrations','SELECT public.schema_revision() revision','ROLLBACK']);
 assert.deepEqual(JSON.parse(r.logs[0]),{mode:'read_only_migration_preflight',currentRevision:1,recordedFiles:1,allAppliedChecksumsMatch:true,pending:[next],databaseChanged:false});
});
test('local administrator mode requires postgres OS user and fixes the socket,database and role',async()=>{
 const r=await run({env:{MIGRATION_LOCAL_PEER:'true'}});assert.equal(r.exitCode,undefined);
 assert.equal(JSON.stringify(r.configuration),JSON.stringify({host:'/var/run/postgresql',database:'kavosh_one',user:'postgres',ssl:false,connectionTimeoutMillis:5000,statement_timeout:30000}));
 for(const options of [{env:{MIGRATION_LOCAL_PEER:'true'},uid:0},{env:{MIGRATION_LOCAL_PEER:'true'},username:'ubuntu'},{env:{MIGRATION_LOCAL_PEER:'false'}},{env:{MIGRATION_LOCAL_PEER:'true',MIGRATION_DATABASE_URL:'synthetic-private'}},{env:{MIGRATION_DATABASE_URL:'synthetic-private'}},{env:{}},{args:['--unknown']},{env:{MIGRATION_DATABASE_URL:'postgres://synthetic-private:password@localhost/test',NODE_ENV:'production',DATABASE_SSL_MODE:'disable'}}]){
  const failed=await run(options);assert.equal(failed.exitCode,1);assert.equal(failed.connections,0);
 }
});
test('history mismatch,source removal and failures rollback and redact database errors',async()=>{
 for(const options of [{history:[{name:first,checksum:'wrong'}]},{history:[{name:'000_removed.sql',checksum}]},{fail:'SELECT name,checksum FROM public.schema_migrations'}]){
  const r=await run(options);assert.equal(r.exitCode,1);assert.ok(r.ended);assert.equal(r.queries.at(-1),'ROLLBACK');assert.ok(!r.queries.includes(sql));
 }
 const disconnected=await run({fail:'connect'});assert.equal(disconnected.exitCode,1);assert.deepEqual(disconnected.queries,[]);assert.ok(disconnected.ended);
 const cleanup=await run({fail:'end'});assert.equal(cleanup.exitCode,1);assert.ok(cleanup.ended);
});
test('normal migration retains transactional application and records only pending files',async()=>{
 const r=await run({args:[]});assert.equal(r.exitCode,undefined);assert.ok(r.ended);assert.equal(r.queries[0],'BEGIN');assert.equal(r.queries.at(-1),'COMMIT');assert.equal(r.queries.filter(q=>q===sql).length,1);assert.equal(r.queries.filter(q=>q.startsWith('INSERT INTO')).length,1);assert.deepEqual(r.logs,['Applied '+next]);
 const failed=await run({args:[],fail:sql});assert.equal(failed.exitCode,1);assert.equal(failed.queries.at(-1),'ROLLBACK');assert.ok(!failed.queries.includes('COMMIT'));
});
