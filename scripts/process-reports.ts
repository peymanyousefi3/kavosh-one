import pg from 'pg';
import { z } from 'zod';
import { setTimeout as delay } from 'node:timers/promises';
import { postgresOptions } from '../src/core/postgres-config.ts';
import { processOneReport } from '../src/reports/export-worker.ts';
import { processOneReportSchedule } from '../src/reports/schedule-worker.ts';
import type { Database } from '../src/core/database.ts';

let pool:pg.Pool|undefined;const stopping=new AbortController();for(const signal of ['SIGINT','SIGTERM']as const)process.on(signal,()=>stopping.abort());
try{
 if(process.env.REPORT_WORKER_ENABLED!=='true')throw new Error('WORKER_DISABLED');
 if(['NOTIFICATION_OUTBOUND_DATABASE_URL','OPERATIONAL_DELIVERY_CONNECTIONS','MIGRATION_DATABASE_URL','DATABASE_URL','IDENTITY_DATABASE_URL','DELIVERY_DATABASE_URL','NOTIFICATION_WORKER_DATABASE_URL','FILE_INSPECTION_DATABASE_URL','SIGNATURE_INGEST_DATABASE_URL','AUTH_SECRET','EDGE_AUTH_SECRET','SMTP_PASSWORD','TWILIO_AUTH_TOKEN','R2_UPLOAD_CONNECTIONS','BOLDSIGN_WEBHOOK_CONNECTIONS'].some(k=>process.env[k]))throw new Error('SHARED_CREDENTIAL_ENVIRONMENT_FORBIDDEN');
 const ids=z.array(z.string().uuid().transform(v=>v.toLowerCase())).min(1).max(1000).refine(v=>new Set(v).size===v.length).parse(JSON.parse(z.string().max(50000).parse(process.env.REPORT_WORKER_ACADEMIES)));
 pool=new pg.Pool({...postgresOptions(process.env.REPORT_WORKER_DATABASE_URL),max:2,connectionTimeoutMillis:3000,statement_timeout:5000,query_timeout:7000});pool.on('error',()=>console.error('report_worker_database_pool_error'));
 if(process.env.REPORT_SCHEDULER_ENABLED!==undefined&&!['true','false'].includes(process.env.REPORT_SCHEDULER_ENABLED))throw new Error('INVALID_SCHEDULER_FLAG');
 while(!stopping.signal.aborted){const s=process.env.REPORT_SCHEDULER_ENABLED==='true'?await processOneReportSchedule(pool as unknown as Database,ids,stopping.signal):null;const r=await processOneReport(pool as unknown as Database,ids,stopping.signal);if((r.claimed&&!r.recorded)||(s?.claimed&&!s.recorded))console.error('report_worker_lease_lost');if(!r.claimed&&!s?.claimed)await delay(1000,undefined,{signal:stopping.signal});}
}catch{if(!stopping.signal.aborted){console.error('Report worker stopped; check isolated configuration without logging credentials.');process.exitCode=1;}}finally{await pool?.end();}
