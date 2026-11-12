import pg from 'pg';
import { setTimeout as delay } from 'node:timers/promises';
import { postgresOptions } from '../src/core/postgres-config.ts';
import { processPlatformNotices } from '../src/platform/notice-worker.ts';
import type { Database } from '../src/core/database.ts';

let pool:pg.Pool|undefined;const stopping=new AbortController();for(const s of ['SIGINT','SIGTERM']as const)process.on(s,()=>stopping.abort());
try{
 if(process.env.PLATFORM_NOTICE_WORKER_ENABLED!=='true')throw new Error('WORKER_DISABLED');
 if(['DATABASE_URL','MIGRATION_DATABASE_URL','PLATFORM_DATABASE_URL','IDENTITY_DATABASE_URL','DELIVERY_DATABASE_URL','NOTIFICATION_WORKER_DATABASE_URL','NOTIFICATION_OUTBOUND_DATABASE_URL','AUTH_SECRET','EDGE_AUTH_SECRET','SMTP_PASSWORD','TWILIO_AUTH_TOKEN','TWILIO_API_KEY_SECRET','OPERATIONAL_DELIVERY_CONNECTIONS','R2_UPLOAD_CONNECTIONS','BOLDSIGN_WEBHOOK_CONNECTIONS','STRIPE_WEBHOOK_CONNECTIONS'].some(n=>process.env[n]))throw new Error('SHARED_CREDENTIAL_ENVIRONMENT_FORBIDDEN');
 pool=new pg.Pool({...postgresOptions(process.env.PLATFORM_NOTICE_WORKER_DATABASE_URL),max:1,connectionTimeoutMillis:3000,statement_timeout:5000,query_timeout:7000});pool.on('error',()=>console.error('platform_notice_pool_error'));
 while(!stopping.signal.aborted){const r=await processPlatformNotices(pool as unknown as Database);if(r.processed<50)await delay(1000,undefined,{signal:stopping.signal});}
}catch{if(!stopping.signal.aborted){console.error('Platform notice worker stopped; check isolated configuration without logging credentials.');process.exitCode=1;}}finally{await pool?.end();}
