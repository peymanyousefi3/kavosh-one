import { readdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import pg from 'pg';
import { postgresOptions } from '../src/core/postgres-config.ts';
import {userInfo} from 'node:os';
import {installDispositionInspectorInTransaction,inspectDispositionInstallation} from '../src/platform/disposition-installation.ts';

const connectionString = process.env.MIGRATION_DATABASE_URL;
let client:pg.Client|undefined,transaction=false;
try {
  const args=process.argv.slice(2),check=args.length===1&&args[0]==='--check';
  if(args.length&&!check)throw new Error('INVALID_MIGRATION_ARGUMENTS');
  let options:pg.ClientConfig;
  if(process.env.MIGRATION_LOCAL_PEER==='true'){
    // Explicit offline administrator path only. No TCP/TLS exception is added
    // to web/worker configuration,and no new password-bearing owner is needed.
    if(connectionString||typeof process.getuid!=='function'||process.getuid()===0||userInfo().username!=='postgres')throw new Error('LOCAL_PEER_ADMIN_REQUIRED');
    options={host:'/var/run/postgresql',database:'kavosh_one',user:'postgres',ssl:false,connectionTimeoutMillis:5000,statement_timeout:30000};
  }else{
    if(process.env.MIGRATION_LOCAL_PEER!==undefined)throw new Error('INVALID_MIGRATION_CONFIGURATION');
    options=postgresOptions(connectionString);
  }
  client=new pg.Client(options);
  await client.connect();
  const nativeDb={async query<Row>(sql:string,args?:unknown[]){return{rows:(await client!.query(sql,args)).rows as Row[]};},exec:(sql:string)=>client!.query(sql)};
  await client.query(check?'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY':'BEGIN');transaction=true;
  await client.query(check?'SELECT pg_advisory_xact_lock_shared(742061)':'SELECT pg_advisory_xact_lock(742061)');
  if(!check)await client.query(`CREATE TABLE IF NOT EXISTS public.schema_migrations (name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
  const directory = new URL('../db/migrations/', import.meta.url);
  const names=(await readdir(directory)).filter(n=>n.endsWith('.sql')).sort();
  // A misnamed SQL file must fail installation,not silently disappear while
  // test fixtures that load all SQL files appear to pass.
  if(names.some(n=>!/^\d+_[a-z_]+\.sql$/.test(n)))throw new Error('Invalid migration filename');
  const recorded=(await client.query<{name:string;checksum:string}>('SELECT name,checksum FROM public.schema_migrations')).rows;
  if(recorded.some(r=>!names.includes(r.name)))throw new Error('MIGRATION_HISTORY_SOURCE_MISSING');
  const previous=new Map(recorded.map(r=>[r.name,r.checksum])),pending:string[]=[];
  for (const name of names) {
    const sql = await readFile(new URL(name, directory), 'utf8');
    const checksum = createHash('sha256').update(sql).digest('hex');
    if (previous.has(name)) {
      if (previous.get(name) !== checksum) throw new Error(`Migration changed after application: ${name}`);
      continue;
    }
    pending.push(name);if(check)continue;
    await client.query(sql);
    await client.query('INSERT INTO public.schema_migrations (name,checksum) VALUES ($1,$2)', [name, checksum]);
  }
  if(check){
    const revision=(await client.query<{revision:number}>('SELECT public.schema_revision() revision')).rows[0].revision;
    const nativeInspector=revision>=428?await inspectDispositionInstallation(nativeDb):undefined;
    await client.query('ROLLBACK');transaction=false;
    console.log(JSON.stringify({mode:'read_only_migration_preflight',currentRevision:revision,recordedFiles:recorded.length,allAppliedChecksumsMatch:true,pending,databaseChanged:false,...nativeInspector?{nativeDispositionInspector:nativeInspector}:{}}));
    if(nativeInspector&&!nativeInspector.current)process.exitCode=1;
  }else{
    const installed=names.includes('428_disposition_inspection_role.sql')?await installDispositionInspectorInTransaction(nativeDb):undefined;
    await client.query('COMMIT');transaction=false;
    for(const name of pending)console.log(`Applied ${name}`);
    if(installed?.changed)console.log('Installed sealed native disposition inspector');
  }
} catch (error) {
  if(transaction)try { await client?.query('ROLLBACK'); } catch { /* The private transaction is never activated after a failure. */ }
  // Do not print pg errors: they may contain a connection string or row data.
  console.error('Migration failed; inspect database configuration without exposing secrets.');
  process.exitCode = 1;
} finally {
  try { await client?.end(); } catch {
    console.error('Migration connection cleanup failed; inspect database configuration without exposing secrets.');
    process.exitCode=1;
  }
}
