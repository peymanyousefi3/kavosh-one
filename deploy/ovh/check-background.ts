// Actual daemon identities and read-only role contracts. No provider send,
// rule creation, actor manufacture, financial posting or school activation.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import pg from 'pg';
import {z} from 'zod';
import {assertRuntimeRole,assertSchemaReady,type Database} from '../../src/core/database.ts';
import {postgresOptions} from '../../src/core/postgres-config.ts';
import {assertPlatformNoticeWorker} from '../../src/platform/notice-worker.ts';
import {configuredOperationalDelivery} from '../../src/integrations/message-delivery.ts';
let pool:pg.Pool|undefined;
try{
 const mode=z.enum(['notifications','reports','messages','platform-notices']).parse(process.argv[2]);assert.equal(process.argv.length,3);assert.notEqual(process.getuid?.(),0);
 let denied=false;try{readFileSync('/etc/kavosh-one/web.env');}catch(e){denied=(e as NodeJS.ErrnoException).code==='EACCES';}assert.equal(denied,true);
 for(const k of ['DATABASE_URL','IDENTITY_DATABASE_URL','AUTH_SECRET','EDGE_AUTH_SECRET','SMTP_PASSWORD','R2_UPLOAD_CONNECTIONS','BOLDSIGN_WEBHOOK_CONNECTIONS'])assert.equal(process.env[k],undefined);if(mode!=='messages')assert.equal(process.env.OPERATIONAL_DELIVERY_CONNECTIONS,undefined);
 const name=mode==='notifications'?'NOTIFICATION_WORKER':mode==='reports'?'REPORT_WORKER':mode==='messages'?'NOTIFICATION_OUTBOUND':'PLATFORM_NOTICE_WORKER';
 pool=new pg.Pool({...postgresOptions(process.env[name+'_DATABASE_URL']),max:1,connectionTimeoutMillis:3000,statement_timeout:5000,query_timeout:7000});pool.on('error',()=>{});const db=pool as unknown as Database,c=await db.connect();try{
  await c.query('BEGIN READ ONLY');
  if(mode==='platform-notices')await assertPlatformNoticeWorker(c);else await assertRuntimeRole(c,mode==='messages'?'message_worker':'automation_worker');await assertSchemaReady(c);
  const r=await c.query<{tls:boolean;login:string;identityAccess:boolean}>('SELECT current_user login,(SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()) tls,has_schema_privilege(current_user,\'identity\',\'usage\') "identityAccess"');assert.equal(r.rows[0].tls,true);assert.equal(r.rows[0].identityAccess,false);assert.equal(r.rows[0].login,'kavosh_one_'+mode.replaceAll('-','_'));
 }finally{try{await c.query('ROLLBACK');}finally{c.release();}}
 const ids=mode==='platform-notices'?[]:z.array(z.string().uuid()).length(1).parse(JSON.parse(process.env[name+'_ACADEMIES']!));
 if(mode==='messages')assert.ok(configuredOperationalDelivery(ids[0])); // Factory validates configuration without IO.
 console.log(JSON.stringify({mode,actualWorkerUid:process.getuid?.(),roleSafetyVerified:true,ownTlsDatabaseLoginVerified:true,identitySchemaDenied:true,webSecretsUnreadable:true,providerCredentialsSeparated:true,readOnlyIsolationCheck:true,queueState:'not_examined',jobsClaimed:0,messagesSent:0,financialPostingsCreated:0}));
}catch{console.error('BACKGROUND_WORKER_ISOLATION_CHECK_FAILED');process.exitCode=1;}
finally{await pool?.end();}
