import pg from 'pg';
import {z} from 'zod';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {postgresOptions} from '../src/core/postgres-config.ts';
import type {Database} from '../src/core/database.ts';
import {r2Connection,r2TargetId,type R2Connection} from '../src/integrations/r2-config.ts';
import {processOneCopy,copyStoredFile} from '../src/files/copy-worker.ts';
import {processOneCopyCheck,checkCopyDestination} from '../src/files/copy-check-worker.ts';

let pool:pg.Pool|undefined;const stopping=new AbortController();for(const s of ['SIGINT','SIGTERM']as const)process.on(s,()=>stopping.abort());
try{
 const mode=z.enum(['promotion','verification']).parse(process.argv[2]);if(process.argv.length!==3||process.env.FILE_COPY_WORKER_ENABLED!=='true'||process.env.FILE_COPY_MODE!==mode)throw Error('WORKER_DISABLED');
 if(['MIGRATION_DATABASE_URL','DATABASE_URL','IDENTITY_DATABASE_URL','DELIVERY_DATABASE_URL','FILE_INSPECTION_DATABASE_URL','FILE_INSPECTION_R2_CONNECTIONS','AUTH_SECRET','EDGE_AUTH_SECRET','SMTP_PASSWORD','TWILIO_API_KEY_SECRET','OPERATIONAL_DELIVERY_CONNECTIONS','R2_UPLOAD_CONNECTIONS','BOLDSIGN_WEBHOOK_CONNECTIONS'].some(k=>process.env[k]))throw Error('SHARED_CREDENTIAL_ENVIRONMENT_FORBIDDEN');
 const uuid=z.string().uuid().transform(v=>v.toLowerCase()),shape=mode==='promotion'?z.object({academyId:uuid,source:r2Connection,destination:r2Connection}).strict():z.object({academyId:uuid,reader:r2Connection}).strict();
 const raw=z.string().min(2).max(1048576).parse(process.env.FILE_COPY_CONNECTIONS),entries=z.array(shape).min(1).max(1000).refine(v=>new Set(v.map(e=>e.academyId)).size===v.length).parse(JSON.parse(raw));
 const ids=entries.map(e=>e.academyId),connections=new Map<string,R2Connection>();
 for(const e of entries){
  if('source'in e){if(r2TargetId(e.source)===r2TargetId(e.destination)||e.source.accessKeyId===e.destination.accessKeyId)throw Error('SEPARATE_STORAGE_TARGETS_REQUIRED');connections.set(e.academyId+'/'+r2TargetId(e.source),e.source);connections.set(e.academyId+'/'+r2TargetId(e.destination),e.destination);}
  else connections.set(e.academyId+'/'+r2TargetId(e.reader),e.reader);
 }
 const selected=(academy:string,target:string)=>connections.get(academy+'/'+target)??null;
 pool=new pg.Pool({...postgresOptions(process.env.FILE_COPY_WORKER_DATABASE_URL),max:2,connectionTimeoutMillis:3000,statement_timeout:5000,query_timeout:7000});pool.on('error',()=>console.error('file_copy_database_pool_error'));
 const db=pool as unknown as Database,worker=randomUUID();
 while(!stopping.signal.aborted){
  const options={signal:stopping.signal,timeoutMs:120000};
  const result=mode==='promotion'?await processOneCopy(db,ids,worker,(task,signal)=>copyStoredFile(task,selected,signal),options):await processOneCopyCheck(db,ids,worker,(task,signal)=>checkCopyDestination(task,selected(task.academyId,task.destinationTargetId),signal),options);
  if(result.claimed&&!result.recorded)console.error('file_copy_result_not_recorded');if(!result.claimed)await delay(1000,undefined,{signal:stopping.signal});
 }
}catch{if(!stopping.signal.aborted){console.error('File copy worker stopped; check isolated mode and configuration without logging credentials.');process.exitCode=1;}}
finally{await pool?.end();}
