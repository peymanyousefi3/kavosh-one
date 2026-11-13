import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdir,chown,writeFile,readFile,rm} from 'node:fs/promises';
import pg from 'pg';
import {testDatabase} from './database.ts';
import {canonicalRoleExport,roleExportForRestore,isolatedClusterRecoveryPlan} from '../src/operations/role-recovery.ts';
import {clusterVerificationSnapshot} from '../src/operations/database-verification.ts';

// CI-only: the entire host is disposable. Never run recovered superuser SQL
// under the live server's postgres OS identity. Production needs its own OS
// isolation boundary as well as this separate database cluster/socket.
test('fresh native cluster rebuild preserves global roles and original database access/settings without touching the source',{
 skip:process.env.CI!=='true'||process.env.KAVOSH_FRESH_CLUSTER_TEST!=='true'||!process.env.TEST_DATABASE_URL||process.getuid?.()!==0
},async()=>{
 const run=promisify(execFile),id=randomUUID().replaceAll('-',''),directory='/var/lib/kavosh-one-recovery-'+id;
 const source=new URL(process.env.TEST_DATABASE_URL!);assert.ok(['127.0.0.1','localhost'].includes(source.hostname));
 const administrator=new pg.Client({connectionString:source.toString()});let bootstrap:string;
 try{await administrator.connect();bootstrap=(await administrator.query('SELECT rolname FROM pg_roles WHERE oid=10')).rows[0].rolname;}finally{await administrator.end();}
 const plan=isolatedClusterRecoveryPlan(directory,bootstrap,process.env.RECOVERY_POSTGRES_BIN??'');
 const uid=Number((await run('/usr/bin/id',['-u','postgres'])).stdout.trim()),gid=Number((await run('/usr/bin/id',['-g','postgres'])).stdout.trim());
 const env={PATH:'/usr/local/bin:/usr/bin:/bin',NODE_ENV:'test' as const,LANG:'C',TZ:'UTC',PGHOST:source.hostname,PGPORT:source.port||'5432',PGUSER:decodeURIComponent(source.username),PGPASSWORD:decodeURIComponent(source.password)};
 const local={PATH:'/usr/local/bin:/usr/bin:/bin',NODE_ENV:'test' as const,LANG:'C',TZ:'UTC'};
 const tool=(args:string[])=>run('/usr/sbin/runuser',['-u','postgres','--',...args],{env:local,timeout:30000,maxBuffer:4194304});
 const f=await testDatabase();let owned=false,started=false,restored:pg.Client|undefined,sourceClient:pg.Client|undefined;
 try{
  const name=(await f.query<{name:string}>('SELECT current_database() name')).rows[0].name;assert.match(name,/^kavosh_test_[a-f0-9]{32}$/);source.pathname='/'+name;
  const role='kavosh_rebuild_'+id,quote='"'+name+'"';
  await f.exec('CREATE ROLE '+role+' NOLOGIN;CREATE TABLE public.recovery_record(id integer PRIMARY KEY,value text);INSERT INTO public.recovery_record VALUES(1,\'SYNTHETIC_ONLY\');REVOKE ALL ON DATABASE '+quote+' FROM PUBLIC;GRANT CONNECT ON DATABASE '+quote+' TO '+role+';ALTER DATABASE '+quote+' CONNECTION LIMIT 7;ALTER DATABASE '+quote+" SET application_name='synthetic_database_setting';ALTER ROLE "+role+' IN DATABASE '+quote+" SET statement_timeout='5s'");
  sourceClient=new pg.Client({connectionString:source.toString()});await sourceClient.connect();
  const capture=async(c:pg.Client,exclude?:string)=>{await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');try{return await clusterVerificationSnapshot(c,undefined,exclude);}finally{await c.query('ROLLBACK');}};
  const baseline=await capture(sourceClient);
  await mkdir(directory,{mode:0o700});owned=true;await chown(directory,uid,gid);await mkdir(plan.socket,{mode:0o700});await chown(plan.socket,uid,gid);
  const roleText=(await run(plan.initdb[0].replace(/initdb$/,'pg_dumpall'),['--roles-only','--no-role-passwords','--no-password'],{env,timeout:10000,maxBuffer:4194304})).stdout;
  await writeFile(directory+'/roles.sql',roleExportForRestore(roleText,bootstrap),{mode:0o600});await chown(directory+'/roles.sql',uid,gid);
  await run(plan.initdb[0].replace(/initdb$/,'pg_dump'),['--format=custom','--no-password','--file',directory+'/database.dump','--dbname',name],{env,timeout:10000});await chown(directory+'/database.dump',uid,gid);
  await tool(plan.initdb);await tool(plan.start);started=true;await tool(plan.roles);await tool(plan.database);
  restored=new pg.Client({host:plan.socket,port:plan.port,user:bootstrap,database:name});await restored.connect();
  assert.deepEqual(await capture(restored),baseline);
  assert.deepEqual((await restored.query('SELECT * FROM public.recovery_record')).rows,[{id:1,value:'SYNTHETIC_ONLY'}]);
  assert.equal((await restored.query('SHOW listen_addresses')).rows[0].listen_addresses,'');
  const exported=(await tool([plan.initdb[0].replace(/initdb$/,'pg_dumpall'),'--roles-only','--no-role-passwords','--no-password','--host',plan.socket,'--port',String(plan.port),'--username',bootstrap,'--database','postgres'])).stdout;
  assert.deepEqual(canonicalRoleExport(exported),canonicalRoleExport(roleText));
  await restored.query('REVOKE CONNECT ON DATABASE '+quote+' FROM '+role);assert.notDeepEqual(await capture(restored),baseline);
  assert.deepEqual(await capture(sourceClient),baseline,'isolated rebuild must not change source privileges/settings/roles');
  assert.equal((await readFile(directory+'/roles.sql','utf8')).includes('PASSWORD'),false);
 }finally{
  await restored?.end();await sourceClient?.end();if(started)await tool(plan.stop);if(owned)await rm(directory,{recursive:true});
  // Drop only the role created above,after its disposable database is removed.
  await f.close();const admin=new pg.Client({connectionString:process.env.TEST_DATABASE_URL});try{await admin.connect();await admin.query('DROP ROLE IF EXISTS kavosh_rebuild_'+id);}finally{await admin.end();}
 }
});
