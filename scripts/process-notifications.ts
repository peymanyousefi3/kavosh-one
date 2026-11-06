import pg from 'pg';
import { z } from 'zod';
import { setTimeout as delay } from 'node:timers/promises';
import { postgresOptions } from '../src/core/postgres-config.ts';
import { processOneNotification } from '../src/automations/notification-worker.ts';
import { processOneSubscription } from '../src/automations/subscription-worker.ts';
import type { Database } from '../src/core/database.ts';

// Explicit operator-only daemon. The web app never auto-starts it.
let pool:pg.Pool|undefined;const stopping=new AbortController();for(const signal of ['SIGINT','SIGTERM']as const)process.on(signal,()=>stopping.abort());
try{
 if(process.env.NOTIFICATION_WORKER_ENABLED!=='true')throw new Error('WORKER_DISABLED');
 if(['MIGRATION_DATABASE_URL','DATABASE_URL','IDENTITY_DATABASE_URL','DELIVERY_DATABASE_URL','FILE_INSPECTION_DATABASE_URL','SIGNATURE_INGEST_DATABASE_URL','AUTH_SECRET','EDGE_AUTH_SECRET','SMTP_PASSWORD','TWILIO_AUTH_TOKEN','R2_UPLOAD_CONNECTIONS','FILE_INSPECTION_R2_CONNECTIONS','BOLDSIGN_WEBHOOK_CONNECTIONS'].some(name=>process.env[name]))throw new Error('SHARED_CREDENTIAL_ENVIRONMENT_FORBIDDEN');
 const raw=z.string().min(2).max(50000).parse(process.env.NOTIFICATION_WORKER_ACADEMIES),ids=z.array(z.string().uuid().transform(v=>v.toLowerCase())).min(1).max(1000).refine(v=>new Set(v).size===v.length).parse(JSON.parse(raw));
 pool=new pg.Pool({...postgresOptions(process.env.NOTIFICATION_WORKER_DATABASE_URL),max:2,connectionTimeoutMillis:3000,statement_timeout:5000,query_timeout:7000});pool.on('error',()=>{console.error('notification_worker_database_pool_error');});
 const subscriptions=z.enum(['true','false']).default('false').parse(process.env.NOTIFICATION_SUBSCRIPTIONS_ENABLED)==='true';
 while(!stopping.signal.aborted){const watched=subscriptions?await processOneSubscription(pool as unknown as Database,ids,stopping.signal):undefined;const result=await processOneNotification(pool as unknown as Database,ids,stopping.signal);if(result.claimed&&!result.recorded)console.error('notification_worker_lease_lost');if(watched?.claimed&&!watched.recorded)console.error('subscription_worker_lease_lost');if(!result.claimed&&!watched?.claimed)await delay(1000,undefined,{signal:stopping.signal});}
}catch{if(!stopping.signal.aborted){console.error('Notification worker stopped; check isolated configuration without logging credentials.');process.exitCode=1;}}finally{await pool?.end();}
