import pg from 'pg';
import { z } from 'zod';
import { setTimeout as delay } from 'node:timers/promises';
import { postgresOptions } from '../src/core/postgres-config.ts';
import { processOneMessage } from '../src/automations/message-worker.ts';
import { configuredOperationalDelivery } from '../src/integrations/message-delivery.ts';
import type { Database } from '../src/core/database.ts';

// Explicit isolated operator process only;not started by the web/reminder app.
// Never run with real provider credentials during local automated tests.
let pool:pg.Pool|undefined;const stopping=new AbortController();for(const signal of ['SIGINT','SIGTERM']as const)process.on(signal,()=>stopping.abort());
try{
 if(process.env.NOTIFICATION_OUTBOUND_WORKER_ENABLED!=='true'||process.env.OPERATIONAL_DELIVERY_ENABLED!=='true')throw new Error('WORKER_DISABLED');
 if(['MIGRATION_DATABASE_URL','DATABASE_URL','IDENTITY_DATABASE_URL','DELIVERY_DATABASE_URL','NOTIFICATION_WORKER_DATABASE_URL','REPORT_WORKER_DATABASE_URL','FILE_INSPECTION_DATABASE_URL','SIGNATURE_INGEST_DATABASE_URL','AUTH_SECRET','EDGE_AUTH_SECRET','SMTP_PASSWORD','TWILIO_AUTH_TOKEN','TWILIO_API_KEY_SECRET','R2_UPLOAD_CONNECTIONS','FILE_INSPECTION_R2_CONNECTIONS','BOLDSIGN_WEBHOOK_CONNECTIONS'].some(k=>process.env[k]))throw new Error('SHARED_CREDENTIAL_ENVIRONMENT_FORBIDDEN');
 const raw=z.string().min(2).max(50000).parse(process.env.NOTIFICATION_OUTBOUND_ACADEMIES),academies=z.array(z.string().uuid().transform(v=>v.toLowerCase())).min(1).max(1000).refine(v=>new Set(v).size===v.length).parse(JSON.parse(raw));
 const connections=new Map(academies.map(id=>[id,configuredOperationalDelivery(id)]));if([...connections.values()].some(v=>!v))throw new Error('ACADEMY_TRANSPORT_NOT_CONFIGURED');
 pool=new pg.Pool({...postgresOptions(process.env.NOTIFICATION_OUTBOUND_DATABASE_URL),max:2,connectionTimeoutMillis:3000,statement_timeout:5000,query_timeout:7000});pool.on('error',()=>{console.error('message_worker_database_pool_error');});
 while(!stopping.signal.aborted){const result=await processOneMessage(pool as unknown as Database,academies,id=>connections.get(id)??null,stopping.signal),deferred='outcome'in result&&result.outcome==='deferred';if(result.claimed&&!result.recorded&&!deferred)console.error('message_worker_result_not_recorded');if(!result.claimed||deferred)await delay(1000,undefined,{signal:stopping.signal});}
}catch{if(!stopping.signal.aborted){console.error('Outbound message worker stopped;check isolated configuration without logging credentials or recipients.');process.exitCode=1;}}finally{await pool?.end();}
