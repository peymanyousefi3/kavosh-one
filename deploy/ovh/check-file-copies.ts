// Actual unprivileged worker identity; no copy or object access is performed.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import pg from 'pg';
import {z} from 'zod';
import {postgresOptions} from '../../src/core/postgres-config.ts';
import {assertSchemaReady,type Database} from '../../src/core/database.ts';
import {assertFileWorkerRole} from '../../src/files/inspection-worker.ts';
let pool:pg.Pool|undefined;
try{
 const mode=z.enum(['promotion','verification']).parse(process.argv[2]);assert.equal(process.argv.length,3);assert.equal(process.env.FILE_COPY_MODE,mode);assert.notEqual(process.getuid?.(),0);
 let denied=false;try{readFileSync('/etc/kavosh-one/web.env');}catch(e){denied=(e as NodeJS.ErrnoException).code==='EACCES';}assert.equal(denied,true);
 for(const k of ['AUTH_SECRET','DATABASE_URL','IDENTITY_DATABASE_URL','SMTP_PASSWORD','FILE_INSPECTION_R2_CONNECTIONS'])assert.equal(process.env[k],undefined);
 pool=new pg.Pool({...postgresOptions(process.env.FILE_COPY_WORKER_DATABASE_URL),max:1,connectionTimeoutMillis:3000,statement_timeout:5000,query_timeout:7000});pool.on('error',()=>{});const db=pool as unknown as Database,c=await db.connect();try{
  await c.query('BEGIN READ ONLY');
  await assertSchemaReady(c);
  await assertFileWorkerRole(c);const r=await c.query<{tls:boolean;direct:boolean;login:string}>(`SELECT current_user login,(SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()) tls,EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN('public','identity','auth_private','platform_private') AND c.relkind IN('r','p','v','m','f') AND has_table_privilege(current_user,c.oid,'SELECT,INSERT,UPDATE,DELETE')) direct`);assert.equal(r.rows[0].tls,true);assert.equal(r.rows[0].direct,false);assert.equal(r.rows[0].login,'kavosh_one_file_'+mode);
 }finally{try{await c.query('ROLLBACK');}finally{c.release();}}
 const entries=JSON.parse(process.env.FILE_COPY_CONNECTIONS!);assert.equal(entries.length,1);assert.deepEqual(Object.keys(entries[0]).sort(),mode==='promotion'?['academyId','destination','source']:['academyId','reader']);
 console.log(JSON.stringify({mode,actualWorkerUid:process.getuid?.(),ownDatabaseLoginVerified:true,databaseTlsVerified:true,directTablesDenied:true,webSecretsUnreadable:true,modeSpecificCredentialsOnly:true,readOnlyIsolationCheck:true,queueState:'not_examined',jobsClaimed:0,objectsReadOrWritten:0}));
}catch{console.error('FILE_COPY_ISOLATION_CHECK_FAILED');process.exitCode=1;}
finally{await pool?.end();}
