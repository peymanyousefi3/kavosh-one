import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { postgresOptions } from '../src/core/postgres-config.ts';
import type { Database } from '../src/core/database.ts';
import { signatureCompletionWorkerConfiguration } from '../src/integrations/signature-completion-config.ts';
import { processOneSignatureCompletion } from '../src/integrations/signature-completion-job-worker.ts';

let pool:pg.Pool|undefined;
const stopping=new AbortController();
for(const signal of ['SIGINT','SIGTERM'] as const)process.on(signal,()=>stopping.abort());
try{
 if(process.argv.length!==2)throw Error('INVALID_ARGUMENTS');
 const config=signatureCompletionWorkerConfiguration();if(!config)throw Error('WORKER_DISABLED');
 pool=new pg.Pool({...postgresOptions(process.env.SIGNATURE_COMPLETION_DATABASE_URL),max:2,connectionTimeoutMillis:3000,statement_timeout:5000,query_timeout:7000});
 pool.on('error',()=>console.error('signature_completion_database_pool_error'));
 const database=pool as unknown as Database,workerId=randomUUID();
 while(!stopping.signal.aborted){
  const result=await processOneSignatureCompletion({academyIds:config.academyIds,workerId,retrySeconds:config.retrySeconds},{database,providers:config.providers,evidenceStores:config.evidenceStores},{enabled:true,signal:stopping.signal});
  if(result.state==='lease_lost')console.error('signature_completion_lease_lost');
  // Single sequential worker, no tight loop over empty or budget-deferred jobs.
  if(result.state==='idle')await delay(5000,undefined,{signal:stopping.signal});
 }
}catch{if(!stopping.signal.aborted){console.error('Agreement completion worker stopped; check isolated configuration without logging credentials.');process.exitCode=1;}}
finally{await pool?.end();}
