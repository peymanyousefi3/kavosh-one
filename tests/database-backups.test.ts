import assert from 'node:assert/strict';
import { randomBytes,randomUUID,createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp,realpath,readFile,writeFile,readdir,lstat,chmod,unlink,rmdir,symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join,resolve } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { isDeepStrictEqual } from 'node:util';
import pg from 'pg';
import { checkoutFixture } from './checkout-fixture.ts';
import { expectedSchemaRevision } from '../src/core/database.ts';
import { backupDatabase,restoreDatabaseBackup } from '../src/operations/database-backups.ts';

const run=promisify(execFile);
test('backup and restore reject configuration and never leak supplied credentials through the operator command',async()=>{
 await assert.rejects(backupDatabase({databaseUrl:'PRIVATE'}),{code:'INVALID_BACKUP_CONFIGURATION'});
 await assert.rejects(restoreDatabaseBackup({expectedSha256:'PRIVATE'}),{code:'INVALID_RESTORE_CONFIGURATION'});
 const secret=randomBytes(32).toString('hex');
 await assert.rejects(run(process.execPath,['--import','tsx','scripts/database-recovery.ts','backup'],{env:{PATH:process.env.PATH,NODE_ENV:'test',BACKUP_DATABASE_URL:'postgresql://private:'+secret+'@invalid/PRIVATE'},timeout:5000}),e=>{
  const r=e as Error&{stdout:string;stderr:string};assert.equal(r.stdout,'');assert.equal(r.stderr.trim(),'INVALID_BACKUP_CONFIGURATION');assert.ok(!r.stderr.includes(secret));return true;
 });
});
test('real encrypted full database backup preserves money,identity,ownership and RLS;corruption,unsafe roles,source races and existing targets fail closed',{
 skip:!process.env.TEST_DATABASE_URL||!process.env.AGE_BIN||!process.env.AGE_KEYGEN_BIN||!process.env.PG_DUMP_BIN||!process.env.PG_RESTORE_BIN
},async()=>{
 const f=await checkoutFixture(),directory=await realpath(await mkdtemp(join(tmpdir(),'kavosh-recovery-check-'))),identity=join(directory,'identity.txt'),wrongIdentity=join(directory,'wrong-identity.txt'),role='kavosh_backup_check_'+randomUUID().replaceAll('-',''),password=randomBytes(32).toString('hex')+':\\'+randomUUID(),target='kavosh_recovery_'+randomUUID().replaceAll('-','');
 let roleCreated=false,targetCreated=false,recovery:pg.Client|undefined,archivePath:string|undefined,manifestPath:string|undefined,backupFolder:string|undefined;
 try{
  await chmod(directory,0o700);await run(process.env.AGE_KEYGEN_BIN!,['--output',identity]);await chmod(identity,0o600);await run(process.env.AGE_KEYGEN_BIN!,['--output',wrongIdentity]);await chmod(wrongIdentity,0o600);
  const recipient=(await run(process.env.AGE_KEYGEN_BIN!,['-y',identity])).stdout.trim(),sourceName=(await f.pg.query<{name:string}>('SELECT current_database() name')).rows[0].name,source=new URL(process.env.TEST_DATABASE_URL!);source.pathname='/'+sourceName;
  await f.pg.exec(`CREATE ROLE "${role}" LOGIN BYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION INHERIT PASSWORD '${password}'`);roleCreated=true;
  await f.pg.exec(`GRANT EXECUTE ON FUNCTION public.schema_revision() TO "${role}"`);
  const backupUrl=new URL(source);backupUrl.username=role;backupUrl.password=password;
  const common={workDirectory:directory,age:resolve(process.env.AGE_BIN!),sslMode:'disable',timeoutMs:30000},options={...common,databaseUrl:backupUrl.toString(),pgDump:resolve(process.env.PG_DUMP_BIN!),recipient};
  await assert.rejects(backupDatabase(options,AbortSignal.abort()),{code:'RECOVERY_CANCELLED'});
  await assert.rejects(backupDatabase({...options,sslMode:'verify-full'}),{code:'RECOVERY_DATABASE_CA_REQUIRED'});
  await chmod(directory,0o755);try{await assert.rejects(backupDatabase(options),{code:'PRIVATE_RECOVERY_DIRECTORY_REQUIRED'});}finally{await chmod(directory,0o700);}
  const alias=join(directory,'directory-alias');await symlink(directory,alias);try{await assert.rejects(backupDatabase({...options,workDirectory:alias}),{code:'PRIVATE_RECOVERY_DIRECTORY_REQUIRED'});}finally{await unlink(alias);}
  const privateText='PRIVATE_'+randomBytes(24).toString('hex');await f.pg.exec("CREATE TABLE public.recovery_test_private(academy_id uuid NOT NULL,payload text NOT NULL);ALTER TABLE public.recovery_test_private ENABLE ROW LEVEL SECURITY;ALTER TABLE public.recovery_test_private FORCE ROW LEVEL SECURITY;CREATE POLICY tenant_boundary ON public.recovery_test_private USING(academy_id=nullif(current_setting('app.academy_id',true),'')::uuid);GRANT SELECT ON public.recovery_test_private TO kavosh_runtime");
  await f.pg.query('INSERT INTO public.recovery_test_private VALUES($1,$3),($2,$4)',[f.a,f.b,privateText,'OTHER_'+randomUUID()]);assert.equal((await f.pay({amount:'25'})).response.status,201);
  await f.pg.exec(`GRANT USAGE ON SCHEMA public,identity,auth_private,platform_private TO "${role}";GRANT SELECT ON ALL TABLES IN SCHEMA public,identity,auth_private,platform_private TO "${role}";GRANT SELECT ON ALL SEQUENCES IN SCHEMA public,identity,auth_private,platform_private TO "${role}"`);
  const snapshot="SELECT jsonb_build_object('journals',(SELECT jsonb_agg(to_jsonb(j) ORDER BY id) FROM public.finance_journals j),'lines',(SELECT jsonb_agg(to_jsonb(l) ORDER BY journal_id,line_number) FROM public.finance_journal_lines l),'receipts',(SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM public.tuition_receipts r),'private',(SELECT jsonb_agg(to_jsonb(p) ORDER BY academy_id) FROM public.recovery_test_private p),'identityUsers',(SELECT jsonb_agg(to_jsonb(u) ORDER BY id) FROM identity.\"user\" u)) data",before=(await f.pg.query(snapshot)).rows[0].data;
  await assert.rejects(backupDatabase({...options,databaseUrl:source.toString()}),{code:'UNSAFE_BACKUP_ROLE'});assert.deepEqual(await readdir(directory),['identity.txt','wrong-identity.txt']);
  await f.pg.exec('BEGIN');try{await f.pg.query('SELECT pg_advisory_xact_lock(742061)');await assert.rejects(backupDatabase(options),{code:'BACKUP_MIGRATION_BUSY'});}finally{await f.pg.exec('ROLLBACK');}
  await f.pg.exec(`GRANT INSERT ON public.recovery_test_private TO "${role}"`);try{await assert.rejects(backupDatabase(options),{code:'UNSAFE_BACKUP_ROLE'});}finally{await f.pg.exec(`REVOKE INSERT ON public.recovery_test_private FROM "${role}"`);}
  await f.pg.exec(`GRANT pg_read_all_data TO "${role}"`);try{await assert.rejects(backupDatabase(options),{code:'UNSAFE_BACKUP_ROLE'});}finally{await f.pg.exec(`REVOKE pg_read_all_data FROM "${role}"`);}
  await assert.rejects(backupDatabase({...options,pgDump:'/usr/bin/false'}),{code:'RECOVERY_TOOL_FAILED'});assert.equal((await readdir(directory)).filter(v=>v.startsWith('backup-')).length,0);
  const command=process.env.RECOVERY_COMPILED_CLI,operatorEnv={PATH:process.env.PATH,NODE_ENV:'test' as const,AGE_BIN:common.age,RECOVERY_WORK_DIRECTORY:directory,RECOVERY_DATABASE_SSL_MODE:'disable'},began=performance.now();
  let pending:Promise<Awaited<ReturnType<typeof backupDatabase>>>|undefined,released=false;
  await f.pg.exec('BEGIN;LOCK TABLE public.recovery_test_private IN ACCESS EXCLUSIVE MODE');
  const changedText='COMMITTED_AFTER_SNAPSHOT_'+randomUUID();
  try{
   pending=command?run(process.execPath,[command,'backup'],{env:{...operatorEnv,BACKUP_DATABASE_URL:backupUrl.toString(),BACKUP_AGE_RECIPIENT:recipient,PG_DUMP_BIN:options.pgDump},timeout:30000}).then(r=>JSON.parse(r.stdout)):backupDatabase(options);void pending.catch(()=>{});
   let waiting=false;const deadline=Date.now()+4500;while(Date.now()<deadline){await f.pg.query('SELECT pg_stat_clear_snapshot()');waiting=(await f.pg.query<{n:number}>("SELECT count(*)::integer n FROM pg_stat_activity WHERE datname=$1 AND usename=$2 AND application_name='kavosh-backup-dump' AND wait_event_type='Lock' AND wait_event='relation'",[sourceName,role])).rows[0].n>0;if(waiting)break;await delay(5);}
   assert.equal(waiting,true,'Native pg_dump must actually wait after importing its exported snapshot');
   await f.pg.query('UPDATE public.recovery_test_private SET payload=$2 WHERE academy_id=$1',[f.a,changedText]);await f.pg.exec('COMMIT');released=true;
  }finally{if(!released)await f.pg.exec('ROLLBACK');if(!released)await pending?.catch(()=>{});}
  const backup=await pending!;archivePath=backup.archivePath;backupFolder=join(directory,'backup-'+backup.id);manifestPath=join(backupFolder,'manifest.json');
  assert.equal((await f.pg.query<{payload:string}>('SELECT payload FROM public.recovery_test_private WHERE academy_id=$1',[f.a])).rows[0].payload,changedText);
  const bytes=await readFile(archivePath);assert.equal(bytes.subarray(0,22).toString(),'age-encryption.org/v1\n');assert.equal(bytes.includes(Buffer.from(privateText)),false);assert.equal(backup.ciphertextSha256,createHash('sha256').update(bytes).digest('hex'));assert.equal(backup.restoreVerified,false);assert.equal(backup.rolesIncluded,false);assert.equal(backup.mediaIncluded,false);assert.equal((await lstat(archivePath)).mode&0o777,0o600);assert.equal((await lstat(backupFolder)).mode&0o777,0o700);const metadata=await readFile(manifestPath,'utf8');assert.ok(![password,privateText,'postgresql:'].some(v=>metadata.includes(v)));
  assert.ok(backup.encryptedBytes>1_048_576,'The actual full-schema fixture must exceed the deliberate smaller cap');await assert.rejects(backupDatabase({...options,maximumBytes:1_048_576}),{code:'RECOVERY_SIZE_LIMIT'});assert.equal((await readdir(directory)).filter(v=>v.startsWith('backup-')).length,1);
  await f.pg.query(`CREATE DATABASE "${target}"`);targetCreated=true;const targetUrl=new URL(source);targetUrl.pathname='/'+target;recovery=new pg.Client({connectionString:targetUrl.toString()});await recovery.connect();
  const restore={...common,databaseUrl:targetUrl.toString(),pgRestore:resolve(process.env.PG_RESTORE_BIN!),archive:archivePath,identityFile:identity,expectedSha256:backup.ciphertextSha256,expectedRevision:expectedSchemaRevision,confirmation:'RESTORE:'+target};
  const ordinaryUrl=new URL(targetUrl);ordinaryUrl.username=role;ordinaryUrl.password=password;
  await assert.rejects(restoreDatabaseBackup({...restore,databaseUrl:ordinaryUrl.toString()}),{code:'OFFLINE_RESTORE_ADMIN_REQUIRED'});
  const ordinary=new pg.Client({connectionString:ordinaryUrl.toString()});await ordinary.connect();try{await assert.rejects(restoreDatabaseBackup(restore),{code:'RESTORE_TARGET_IN_USE'});}finally{await ordinary.end();}
  await chmod(identity,0o644);try{await assert.rejects(restoreDatabaseBackup(restore),{code:'UNSAFE_RECOVERY_FILE'});}finally{await chmod(identity,0o600);}
  const pluginKey=join(directory,'unsupported-identity.txt');await writeFile(pluginKey,'AGE-PLUGIN-SYNTHETIC-1\n',{mode:0o600});try{await assert.rejects(restoreDatabaseBackup({...restore,identityFile:pluginKey}),{code:'UNSAFE_RECOVERY_IDENTITY'});}finally{await unlink(pluginKey);}
  await assert.rejects(restoreDatabaseBackup({...restore,databaseUrl:source.toString(),confirmation:'RESTORE:'+sourceName}),{code:'ISOLATED_RESTORE_TARGET_REQUIRED'});
  await assert.rejects(restoreDatabaseBackup({...restore,expectedSha256:'0'.repeat(64)}),{code:'BACKUP_DIGEST_MISMATCH'});
  await assert.rejects(restoreDatabaseBackup({...restore,identityFile:wrongIdentity}),{code:'RECOVERY_TOOL_FAILED'});
  const corrupt=join(directory,'corrupt.age');await writeFile(corrupt,bytes.subarray(0,bytes.length-20),{mode:0o600});try{await assert.rejects(restoreDatabaseBackup({...restore,archive:corrupt,expectedSha256:createHash('sha256').update(await readFile(corrupt)).digest('hex')}),{code:'RECOVERY_TOOL_FAILED'});}finally{await unlink(corrupt);}
  assert.equal((await recovery.query("SELECT count(*)::integer n FROM pg_class c JOIN pg_namespace s ON s.oid=c.relnamespace WHERE s.nspname='public'")).rows[0].n,0);assert.equal((await readdir(directory)).filter(v=>v.startsWith('restore-')).length,0);
  await recovery.query('CREATE TABLE public.recovery_sentinel(id integer);INSERT INTO public.recovery_sentinel VALUES(7)');try{await assert.rejects(restoreDatabaseBackup(restore),{code:'EMPTY_RESTORE_TARGET_REQUIRED'});assert.equal((await recovery.query('SELECT id FROM public.recovery_sentinel')).rows[0].id,7);}finally{await recovery.query('DROP TABLE public.recovery_sentinel');}
  const result:Awaited<ReturnType<typeof restoreDatabaseBackup>>=command?JSON.parse((await run(process.execPath,[command,'restore',restore.archive,restore.expectedSha256,String(restore.expectedRevision),restore.confirmation],{env:{...operatorEnv,RESTORE_DATABASE_URL:targetUrl.toString(),RESTORE_AGE_IDENTITY_FILE:identity,PG_RESTORE_BIN:restore.pgRestore},timeout:30000})).stdout):await restoreDatabaseBackup(restore);assert.equal(result.restored,true);assert.equal(result.applicationActivationAllowed,false);assert.equal(result.requiresPrivacyAndOutboxReconciliation,true);assert.ok(isDeepStrictEqual((await recovery.query(snapshot)).rows[0].data,before),'Restored financial,identity or private records differ');
  assert.deepEqual((await readdir(backupFolder)).sort(),['database.dump.age','manifest.json']);
  assert.equal(result.ordinaryClientConnectionsBlocked,true);assert.equal((await f.pg.query<{limit:number}>('SELECT datconnlimit AS limit FROM pg_database WHERE datname=$1',[target])).rows[0].limit,0);
  const blocked=new pg.Client({connectionString:ordinaryUrl.toString()});try{await assert.rejects(blocked.connect(),(e:unknown)=>(e as {code:string}).code==='53300');}finally{await blocked.end();}
  const security="SELECT n.nspname,c.relname,c.relrowsecurity,c.relforcerowsecurity,pg_get_userbyid(c.relowner) owner,(SELECT jsonb_agg(to_jsonb(a) ORDER BY grantor,grantee,privilege_type,is_grantable) FROM aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a) acl FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN('public','identity','auth_private','platform_private') AND c.relkind IN('r','p') ORDER BY n.nspname,c.relname";
  assert.ok(isDeepStrictEqual((await recovery.query(security)).rows,(await f.pg.query(security)).rows),'Restored ownership,effective grants or RLS flags differ');
  const policies="SELECT schemaname,tablename,policyname,permissive,roles,cmd,qual,with_check FROM pg_policies WHERE schemaname IN('public','identity','auth_private','platform_private') ORDER BY schemaname,tablename,policyname";assert.ok(isDeepStrictEqual((await recovery.query(policies)).rows,(await f.pg.query(policies)).rows),'Restored row policies differ');
  const functions="SELECT n.nspname,p.oid::regprocedure::text signature,pg_get_userbyid(p.proowner) owner,p.prosecdef,p.proconfig,pg_get_functiondef(p.oid) definition,(SELECT jsonb_agg(to_jsonb(a) ORDER BY grantor,grantee,privilege_type,is_grantable) FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a) acl FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN('public','identity','auth_private','platform_private') AND p.prokind IN('f','p') ORDER BY n.nspname,p.oid::regprocedure::text";assert.ok(isDeepStrictEqual((await recovery.query(functions)).rows,(await f.pg.query(functions)).rows),'Restored function definitions,owners or effective execution grants differ');
  await recovery.query('BEGIN;SET LOCAL ROLE kavosh_runtime');try{await recovery.query("SELECT set_config('app.academy_id',$1,true)",[f.a]);assert.deepEqual((await recovery.query('SELECT payload FROM public.recovery_test_private')).rows,[{payload:privateText}]);}finally{await recovery.query('ROLLBACK');}
  await recovery.query('SET ROLE kavosh_checkout_result_worker');try{await assert.rejects(recovery.query('SELECT * FROM public.tuition_receipts'),/permission denied/);}finally{await recovery.query('RESET ROLE');}
  assert.equal((await readdir(directory)).filter(v=>v.startsWith('restore-')).length,0);console.log(JSON.stringify({measurement:'native-encrypted-backup-and-restore',schemaRevision:result.verifiedSchemaRevision,encryptedBytes:backup.encryptedBytes,elapsedMs:Math.ceil(performance.now()-began),realMoneyMoved:false,productionActivated:false,mediaRecovered:false}));
 }finally{
  await recovery?.end();if(targetCreated)await f.pg.query(`DROP DATABASE "${target}"`);if(roleCreated){await f.pg.exec(`REVOKE EXECUTE ON FUNCTION public.schema_revision() FROM "${role}";REVOKE ALL ON ALL TABLES IN SCHEMA public,identity,auth_private,platform_private FROM "${role}";REVOKE ALL ON ALL SEQUENCES IN SCHEMA public,identity,auth_private,platform_private FROM "${role}";REVOKE ALL ON SCHEMA public,identity,auth_private,platform_private FROM "${role}"`);await f.pg.query(`DROP ROLE "${role}"`);}await f.pg.close();
  if(archivePath)await unlink(archivePath).catch(()=>{});if(manifestPath)await unlink(manifestPath).catch(()=>{});if(backupFolder)await rmdir(backupFolder).catch(()=>{});await unlink(identity).catch(()=>{});await unlink(wrongIdentity).catch(()=>{});await rmdir(directory).catch(()=>{});
 }
});
