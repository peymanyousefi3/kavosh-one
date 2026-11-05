import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { postgresOptions } from '../src/core/postgres-config.ts';
import { r2Connection } from '../src/integrations/r2-config.ts';
import { processOneInspection,inspectStoredFile } from '../src/files/inspection-worker.ts';
import type { Database } from '../src/core/database.ts';
import { imageServiceConfiguration } from '../src/files/image-service.ts';
import { assertPrivateImageSocket } from '../src/files/image-runtime.ts';
import { pdfServiceConfiguration } from '../src/files/pdf-service.ts';
import { assertPrivatePdfSocket } from '../src/files/pdf-runtime.ts';
import { clamdConfiguration } from '../src/integrations/clamav.ts';
import { clamdDatabasePolicy } from '../src/integrations/clamav-database.ts';

// Separate operator process, never auto-started by the web app or a migration.
let pool:pg.Pool|undefined;
const stopping=new AbortController();for(const signal of ['SIGINT','SIGTERM'] as const)process.on(signal,()=>stopping.abort());
try {
  if(process.env.FILE_INSPECTION_WORKER_ENABLED!=='true')throw new Error('FILE_WORKER_DISABLED');
  if(['MIGRATION_DATABASE_URL','DATABASE_URL','IDENTITY_DATABASE_URL','DELIVERY_DATABASE_URL','AUTH_SECRET','EDGE_AUTH_SECRET'].some(name=>process.env[name]))throw new Error('SHARED_CREDENTIAL_ENVIRONMENT_FORBIDDEN');
  const imageService=process.env.FILE_IMAGE_VALIDATION_ENABLED==='true'?imageServiceConfiguration.parse({socketPath:process.env.FILE_IMAGE_VALIDATION_SOCKET_PATH}):undefined;
  if(imageService)await assertPrivateImageSocket(imageService.socketPath);
  const pdfService=process.env.FILE_PDF_VALIDATION_ENABLED==='true'?pdfServiceConfiguration.parse({socketPath:process.env.FILE_PDF_VALIDATION_SOCKET_PATH}):undefined;
  if(pdfService)await assertPrivatePdfSocket(pdfService.socketPath);
  const raw=z.string().min(1).refine(v=>Buffer.byteLength(v)<=1_048_576).parse(process.env.FILE_INSPECTION_R2_CONNECTIONS);
  const entries=z.array(z.object({academyId:z.string().uuid().transform(v=>v.toLowerCase()),configuration:r2Connection}).strict()).min(1).max(1000).refine(v=>new Set(v.map(e=>e.academyId)).size===v.length).parse(JSON.parse(raw));
  const connections=new Map(entries.map(e=>[e.academyId,e.configuration]));
  const databasePolicy=clamdDatabasePolicy.parse({timeZone:process.env.CLAMD_TIME_ZONE,maximumAgeSeconds:z.coerce.number().default(172800).parse(process.env.CLAMD_MAXIMUM_DATABASE_AGE_SECONDS)});
  const maximumBytes=z.coerce.number().int().min(1).max(4_294_967_296).default(67_108_864).parse(process.env.FILE_INSPECTION_MAXIMUM_BYTES);
  const timeoutMs=z.coerce.number().int().min(1000).max(600000).default(120000).parse(process.env.FILE_INSPECTION_TIMEOUT_MS);
  pool=new pg.Pool({...postgresOptions(process.env.FILE_INSPECTION_DATABASE_URL),max:2,connectionTimeoutMillis:3000,statement_timeout:5000,query_timeout:7000});
  pool.on('error',()=>{console.error('file_inspection_database_pool_error');});
  const database=pool as unknown as Database,workerId=randomUUID(),scanner=clamdConfiguration.parse({socketPath:process.env.CLAMD_SOCKET_PATH,maximumBytes,timeoutMs});
  while(!stopping.signal.aborted) {
    if(imageService)await assertPrivateImageSocket(imageService.socketPath);
    if(pdfService)await assertPrivatePdfSocket(pdfService.socketPath);
    const result=await processOneInspection(database,[...connections.keys()],workerId,(task,signal)=>inspectStoredFile(task,id=>connections.get(id)??null,scanner,signal,timeoutMs,undefined,imageService,databasePolicy,pdfService),{timeoutMs,signal:stopping.signal});
    if(result.claimed&&!result.recorded)console.error('file_inspection_lease_lost');
    if(!result.claimed)await delay(1000,undefined,{signal:stopping.signal});
  }
}catch{
  if(!stopping.signal.aborted){console.error('File inspection worker stopped; check enabled/configuration and isolated role without logging credentials.');process.exitCode=1;}
}finally{await pool?.end();}
