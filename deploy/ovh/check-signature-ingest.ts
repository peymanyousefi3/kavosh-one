// Own-server synthetic discard probe, NOT a verified BoldSign delivery/signature.
import assert from 'node:assert/strict';
import {createHmac,randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import pg from 'pg';
import {z} from 'zod';
import {postgresOptions} from '../../src/core/postgres-config.ts';
import {assertSchemaReady,type Database} from '../../src/core/database.ts';
import {assertSignatureIngestRole} from '../../src/integrations/boldsign-inbox.ts';
import {configuredBoldSignWebhook} from '../../src/integrations/boldsign-webhook-config.ts';
let pool:pg.Pool|undefined;
try{
 assert.equal(process.argv.length,2);assert.notEqual(process.getuid?.(),0);
 for(const key of ['DATABASE_URL','IDENTITY_DATABASE_URL','MIGRATION_DATABASE_URL','AUTH_SECRET','EDGE_AUTH_SECRET','OPERATIONAL_DELIVERY_CONNECTIONS','R2_UPLOAD_CONNECTIONS'])assert.equal(process.env[key],undefined);
 let denied=false;try{readFileSync('/etc/kavosh-one/web.env');}catch(e){denied=(e as NodeJS.ErrnoException).code==='EACCES';}assert.equal(denied,true);
 const ids=z.array(z.object({connectionId:z.string().uuid()}).passthrough()).length(1).parse(JSON.parse(process.env.BOLDSIGN_WEBHOOK_CONNECTIONS!)),configuration=configuredBoldSignWebhook(ids[0].connectionId);assert.ok(configuration);assert.equal(configuration.region,'CA');assert.equal(configuration.environment,'Live');assert.equal(configuration.clientId,null);
 pool=new pg.Pool({...postgresOptions(process.env.SIGNATURE_INGEST_DATABASE_URL),max:1,connectionTimeoutMillis:3000,statement_timeout:5000,query_timeout:7000});pool.on('error',()=>{});const db=pool as unknown as Database,c=await db.connect();try{
  await assertSignatureIngestRole(c);await assertSchemaReady(c);const r=(await c.query<{login:string;tls:boolean;identityAccess:boolean}>("SELECT current_user login,(SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()) tls,has_schema_privilege(current_user,'identity','usage') \"identityAccess\"")).rows[0];assert.equal(r.login,'kavosh_one_signature_ingest');assert.equal(r.tls,true);assert.equal(r.identityAccess,false);
 }finally{c.release();}
 const bytes=Buffer.from(JSON.stringify({event:{id:randomUUID(),created:Math.floor(Date.now()/1000),eventType:'Completed',environment:'Live'},data:{object:'document',documentId:randomUUID(),status:'Completed'}})),timestamp=Math.floor(Date.now()/1000),signature=createHmac('sha256',configuration.secrets[0]).update(timestamp+'.').update(bytes).digest('hex');
 const response=await fetch('https://one.kavosh.ai/api/webhooks/boldsign/'+configuration.connectionId,{method:'POST',redirect:'error',credentials:'omit',headers:{'content-type':'application/json','x-boldsign-event':'Completed','x-boldsign-signature':`t=${timestamp},s0=${signature}`},body:bytes,signal:AbortSignal.timeout(15000)});
 assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');assert.match(response.headers.get('content-type')??'',/^application\/json/);
 const reader=response.body!.getReader(),chunks:Uint8Array[]=[];let size=0;try{for(;;){const part=await reader.read();if(part.done)break;size+=part.value.byteLength;assert.ok(size<=1024);chunks.push(part.value);}}finally{await reader.cancel().catch(()=>{});reader.releaseLock();}assert.deepEqual(JSON.parse(Buffer.concat(chunks).toString('utf8')),{received:true});
 console.log(JSON.stringify({actualWorkerUid:process.getuid?.(),restrictedRoleVerified:true,ownTlsDatabaseLogin:true,identitySchemaDenied:true,webSecretsUnreadable:true,selfSignedUnknownEventAcknowledged:true,verifiedBoldSignDelivery:false,agreementsSentOrChanged:0}));
}catch{console.error('SIGNATURE_INGEST_ACCEPTANCE_FAILED: check private role/configuration without logging keys.');process.exitCode=1;}
finally{await pool?.end();}
