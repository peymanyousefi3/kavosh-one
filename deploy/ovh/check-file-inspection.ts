// Run with the actual worker UID and EnvironmentFile. Read-only isolation and
// metadata check; never claims jobs or creates files, records or messages.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import pg from 'pg';
import {postgresOptions} from '../../src/core/postgres-config.ts';
import {assertFileWorkerRole} from '../../src/files/inspection-worker.ts';
import {assertPrivateImageSocket} from '../../src/files/image-runtime.ts';
import {assertPrivatePdfSocket} from '../../src/files/pdf-runtime.ts';
import {assertPrivateVideoSocket} from '../../src/files/video-runtime.ts';
import {getClamdDatabase} from '../../src/integrations/clamav-database.ts';
import {detectContentSignature} from '../../src/files/content-signature.ts';
import {assertSchemaReady,type Database} from '../../src/core/database.ts';
let pool:pg.Pool|undefined;
try{
 assert.deepEqual(process.argv.slice(2),['--execute']);assert.notEqual(process.getuid?.(),0);
 for(const k of ['DATABASE_URL','IDENTITY_DATABASE_URL','AUTH_SECRET','SMTP_PASSWORD','TWILIO_API_KEY_SECRET','R2_UPLOAD_CONNECTIONS'])assert.equal(process.env[k],undefined);
 let denied=false;try{readFileSync('/etc/kavosh-one/web.env');}catch(e){denied=(e as NodeJS.ErrnoException).code==='EACCES';}assert.equal(denied,true);
 pool=new pg.Pool({...postgresOptions(process.env.FILE_INSPECTION_DATABASE_URL),max:1,connectionTimeoutMillis:3000,statement_timeout:5000,query_timeout:7000});pool.on('error',()=>{});
 const db=pool as unknown as Database,c=await db.connect();try{
  await c.query('BEGIN READ ONLY');
  await assertSchemaReady(c);
  await assertFileWorkerRole(c);const r=await c.query<{tls:boolean;directAccess:boolean}>(`SELECT (SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()) tls,EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN('public','identity','auth_private','platform_private') AND c.relkind IN('r','p','v','m','f') AND has_table_privilege(current_user,c.oid,'SELECT,INSERT,UPDATE,DELETE')) "directAccess"`);assert.equal(r.rows[0].tls,true);assert.equal(r.rows[0].directAccess,false);
 }finally{try{await c.query('ROLLBACK');}finally{c.release();}}
 await assertPrivateImageSocket(process.env.FILE_IMAGE_VALIDATION_SOCKET_PATH!);await assertPrivatePdfSocket(process.env.FILE_PDF_VALIDATION_SOCKET_PATH!);await assertPrivateVideoSocket(process.env.FILE_VIDEO_VALIDATION_SOCKET_PATH!);
 const database=await getClamdDatabase({socketPath:process.env.CLAMD_SOCKET_PATH!,maximumBytes:Number(process.env.FILE_INSPECTION_MAXIMUM_BYTES),timeoutMs:5000},{timeZone:process.env.CLAMD_TIME_ZONE!,maximumAgeSeconds:172800});
 assert.equal((await detectContentSignature(Buffer.from('Kavosh One synthetic isolation check'))).detector,'file-type@22.3.0');
 const configs=JSON.parse(process.env.FILE_INSPECTION_R2_CONNECTIONS!);assert.equal(configs.length,1);assert.equal(configs[0].configuration.bucket,'kavosh-one-production-quarantine');
 console.log(JSON.stringify({actualWorkerUid:process.getuid?.(),restrictedDatabaseRoleVerified:true,databaseTlsVerified:true,directAccountFinanceAndFileTablesDenied:true,webSecretsUnreadable:true,allPrivateParserSocketsAccessible:true,freshScannerDatabaseAccessible:true,scannerDatabaseVersion:database.databaseVersion,signatureDetectorPackaged:true,readOnlyIsolationCheck:true,queueState:'not_examined',jobsClaimed:0,filesReadOrPublished:0,messagesSent:0}));
}catch{console.error('FILE_INSPECTION_ISOLATION_CHECK_FAILED');process.exitCode=1;}
finally{await pool?.end();}
