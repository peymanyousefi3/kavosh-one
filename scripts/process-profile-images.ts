import pg from 'pg';
import {z} from 'zod';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {postgresOptions} from '../src/core/postgres-config.ts';
import type {Database} from '../src/core/database.ts';
import {r2Connection,r2TargetId,type R2Connection} from '../src/integrations/r2-config.ts';
import {assertPrivateImageSocket} from '../src/files/image-runtime.ts';
import {imageServiceConfiguration,assertProfileImageService} from '../src/files/image-service.ts';
import {generateStoredProfileImage,processOneProfileImage} from '../src/profiles/image-worker.ts';

let pool:pg.Pool|undefined;const stop=new AbortController();for(const signal of ['SIGINT','SIGTERM']as const)process.on(signal,()=>stop.abort());
try{
 if(process.argv.length!==2||process.env.PROFILE_IMAGE_WORKER_ENABLED!=='true'||!process.getuid||process.getuid()===0)throw Error('WORKER_DISABLED');
 if(['MIGRATION_DATABASE_URL','DATABASE_URL','IDENTITY_DATABASE_URL','DELIVERY_DATABASE_URL','FILE_INSPECTION_DATABASE_URL','FILE_COPY_WORKER_DATABASE_URL','FILE_COPY_CONNECTIONS','FILE_INSPECTION_R2_CONNECTIONS','AUTH_SECRET','EDGE_AUTH_SECRET','SMTP_PASSWORD','TWILIO_API_KEY_SECRET','OPERATIONAL_DELIVERY_CONNECTIONS','R2_UPLOAD_CONNECTIONS','BOLDSIGN_WEBHOOK_CONNECTIONS','BOLDSIGN_COMPLETION_CONNECTIONS'].some(k=>process.env[k]))throw Error('SHARED_CREDENTIAL_ENVIRONMENT_FORBIDDEN');
 const uuid=z.string().uuid().transform(v=>v.toLowerCase()),digest=z.string().regex(/^[a-f0-9]{64}$/),reader=z.object({targetId:digest,configuration:r2Connection}).strict();
 const entries=z.array(z.object({academyId:uuid,readers:z.array(reader).min(1).max(10).refine(v=>new Set(v.map(e=>e.targetId)).size===v.length),destination:r2Connection}).strict()).min(1).max(1000).refine(v=>new Set(v.map(e=>e.academyId)).size===v.length).parse(JSON.parse(z.string().min(2).max(1048576).parse(process.env.PROFILE_IMAGE_CONNECTIONS)));
 const readers=new Map<string,R2Connection>(),writers=new Map<string,R2Connection>();for(const e of entries){for(const r of e.readers){if(r2TargetId(r.configuration)!==r.targetId||r.configuration.accessKeyId===e.destination.accessKeyId)throw Error('SEPARATE_BOUND_READ_CREDENTIALS_REQUIRED');readers.set(e.academyId+'/'+r.targetId,r.configuration);}writers.set(e.academyId,e.destination);}
 if(process.env.FILE_IMAGE_VALIDATION_ENABLED!=='true')throw Error('ISOLATED_IMAGE_SERVICE_REQUIRED');const imageService=imageServiceConfiguration.parse({socketPath:process.env.FILE_IMAGE_VALIDATION_SOCKET_PATH});await assertPrivateImageSocket(imageService.socketPath);await assertProfileImageService({...imageService,signal:stop.signal});
 pool=new pg.Pool({...postgresOptions(process.env.PROFILE_IMAGE_DATABASE_URL),max:2,connectionTimeoutMillis:3000,idleTimeoutMillis:30000,statement_timeout:5000,query_timeout:7000});pool.on('error',()=>console.error('profile_image_database_pool_error'));
 const database=pool as unknown as Database,academies=entries.map(e=>e.academyId),worker=randomUUID();
 while(!stop.signal.aborted){const r=await processOneProfileImage(database,academies,worker,(source,signal)=>generateStoredProfileImage(source,(academy,target)=>readers.get(academy+'/'+target)??null,academy=>writers.get(academy)??null,imageService.socketPath,signal),{signal:stop.signal});if(r.claimed&&!r.recorded)console.error('profile_image_result_not_recorded');if(!r.claimed)await delay(1000,undefined,{signal:stop.signal});}
}catch{if(!stop.signal.aborted){console.error('Profile image worker stopped;check its isolated opt-in settings without logging credentials.');process.exitCode=1;}}
finally{await pool?.end();}
