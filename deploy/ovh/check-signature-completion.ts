// Preactivation read-only check. Never claim jobs or call a signing/storage API.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { postgresOptions } from '../../src/core/postgres-config.ts';
import { assertSchemaReady,type Database } from '../../src/core/database.ts';
import { assertSignatureCompletionRole } from '../../src/integrations/signature-completion-source.ts';
import { signatureCompletionWorkerConfiguration } from '../../src/integrations/signature-completion-config.ts';
let pool:pg.Pool|undefined;
try{
 assert.equal(process.argv.length,2);assert.notEqual(process.getuid?.(),0);assert.equal(process.env.SIGNATURE_COMPLETION_WORKER_ENABLED,'false');
 const configuration=signatureCompletionWorkerConfiguration({...process.env,SIGNATURE_COMPLETION_WORKER_ENABLED:'true'});assert.ok(configuration);
 let denied=false;try{readFileSync('/etc/kavosh-one/web.env');}catch(error){denied=(error as NodeJS.ErrnoException).code==='EACCES';}assert.equal(denied,true);
 pool=new pg.Pool({...postgresOptions(process.env.SIGNATURE_COMPLETION_DATABASE_URL),max:1,connectionTimeoutMillis:3000,statement_timeout:5000,query_timeout:7000});pool.on('error',()=>{});
 const db=pool as unknown as Database,c=await db.connect();try{
  await assertSignatureCompletionRole(c);await assertSchemaReady(c);
  const state=(await c.query<{login:string;tls:boolean;identity_access:boolean}>("SELECT current_user login,(SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()) tls,has_schema_privilege(current_user,'identity','usage') identity_access")).rows[0];
  assert.equal(state.login,'kavosh_one_signature_completion');assert.equal(state.tls,true);assert.equal(state.identity_access,false);
  await assert.rejects(c.query('SELECT * FROM public.signature_completion_jobs'),(error:unknown)=>(error as {code?:string}).code==='42501');
 }finally{c.release();}
 console.log(JSON.stringify({restrictedRoleVerified:true,ownTlsDatabaseLogin:true,webSecretsUnreadable:true,directJobReadDenied:true,workerEnabled:false,jobsClaimed:0,providerRequests:0,storageRequests:0,existingAgreementsChanged:0}));
}catch{console.error('SIGNATURE_COMPLETION_ACCEPTANCE_FAILED: check isolated configuration without logging credentials.');process.exitCode=1;}
finally{await pool?.end();}
