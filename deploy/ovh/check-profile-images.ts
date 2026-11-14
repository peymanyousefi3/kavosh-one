// Actual worker identity probe plus two fixed tiny synthetic parser decodes.
// No queue claim,original media,provider read/write,notification or publication.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import pg from 'pg';
import {z} from 'zod';
import {postgresOptions} from '../../src/core/postgres-config.ts';
import {assertSchemaReady,type Connection} from '../../src/core/database.ts';
import {assertProfileImageWorkerRole} from '../../src/profiles/image-worker.ts';
import {assertPrivateImageSocket} from '../../src/files/image-runtime.ts';
import {imageServiceConfiguration,assertProfileImageService} from '../../src/files/image-service.ts';
import {r2Connection,r2TargetId} from '../../src/integrations/r2-config.ts';
let pool:pg.Pool|undefined;
try{
 assert.equal(process.argv.length,2);assert.notEqual(process.getuid?.(),0);assert.equal(process.env.PROFILE_IMAGE_WORKER_ENABLED,'false');
 for(const p of ['/etc/kavosh-one/web.env','/etc/kavosh-one/file-promotion.env','/etc/kavosh-one/file-inspection.env']){let denied=false;try{readFileSync(p);}catch(e){denied=(e as NodeJS.ErrnoException).code==='EACCES';}assert.equal(denied,true);}
 for(const k of ['DATABASE_URL','MIGRATION_DATABASE_URL','IDENTITY_DATABASE_URL','AUTH_SECRET','EDGE_AUTH_SECRET','SMTP_PASSWORD','TWILIO_API_KEY_SECRET','BOLDSIGN_COMPLETION_CONNECTIONS','R2_UPLOAD_CONNECTIONS','FILE_COPY_CONNECTIONS'])assert.equal(process.env[k],undefined);
 const entries=z.array(z.object({academyId:z.string().uuid(),readers:z.array(z.object({targetId:z.string().regex(/^[a-f0-9]{64}$/),configuration:r2Connection}).strict()).length(1),destination:r2Connection}).strict()).length(1).parse(JSON.parse(process.env.PROFILE_IMAGE_CONNECTIONS!)),entry=entries[0],reader=entry.readers[0];assert.equal(r2TargetId(reader.configuration),reader.targetId);assert.equal(r2TargetId(entry.destination),reader.targetId);assert.notEqual(reader.configuration.accessKeyId,entry.destination.accessKeyId);assert.notEqual(reader.configuration.secretAccessKey,entry.destination.secretAccessKey);assert.equal(process.env.FILE_IMAGE_VALIDATION_ENABLED,'true');const imageService=imageServiceConfiguration.parse({socketPath:process.env.FILE_IMAGE_VALIDATION_SOCKET_PATH});await assertPrivateImageSocket(imageService.socketPath);await assertProfileImageService(imageService);
 pool=new pg.Pool({...postgresOptions(process.env.PROFILE_IMAGE_DATABASE_URL),max:1,connectionTimeoutMillis:3000,statement_timeout:5000,query_timeout:7000});pool.on('error',()=>{});const c=await pool.connect();try{await c.query('BEGIN READ ONLY');await assertSchemaReady(c as Connection);await assertProfileImageWorkerRole(c as Connection);const r=await c.query<{tls:boolean;login:string}>("SELECT current_user login,(SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()) tls");assert.equal(r.rows[0].tls,true);assert.equal(r.rows[0].login,'kavosh_one_profile_images');}finally{try{await c.query('ROLLBACK');}finally{c.release();}}
 console.log(JSON.stringify({actualWorkerUid:process.getuid?.(),restrictedDatabaseIdentityVerified:true,databaseTlsVerified:true,sharedSecretsUnreadable:true,privateParserSocketVerified:true,profileImageProtocolVerified:true,syntheticCodecProbes:2,exactReaderAndSeparateWriterVerified:true,workerEnabled:false,jobsClaimed:0,objectsReadOrWritten:0,recordsPublished:0}));
}catch{console.error('PROFILE_IMAGE_ISOLATION_CHECK_FAILED');process.exitCode=1;}finally{await pool?.end();}
