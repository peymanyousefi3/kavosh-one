import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { configuredBoldSignWebhook } from '../src/integrations/boldsign-webhook-config.ts';
import { postgresOptions } from '../src/core/postgres-config.ts';
import { expectedSchemaRevision } from '../src/core/database.ts';

// Explicit operator-only registration. Never run from the web app and never
// call BoldSign, send a signing invitation, or change admission clearance.
let client:pg.Client|undefined,transaction=false;
try{
 const args=process.argv.slice(2),id=z.string().uuid().transform(v=>v.toLowerCase()).parse(args[0]);if(args.length>2||args.length===2&&args[1]!=='--enable')throw new Error('INVALID_ARGUMENTS');
 const c=configuredBoldSignWebhook(id,{...process.env,BOLDSIGN_WEBHOOK_ENABLED:'true'});if(!c)throw new Error('CONNECTION_NOT_CONFIGURED');
 client=new pg.Client(postgresOptions(process.env.MIGRATION_DATABASE_URL));await client.connect();
 if((await client.query('SELECT public.schema_revision() AS revision')).rows[0].revision<expectedSchemaRevision)throw new Error('SCHEMA_NOT_CURRENT');
 await client.query('BEGIN');transaction=true;
 const result=await client.query(`INSERT INTO public.signature_connections(id,academy_id,region,environment,client_id,enabled) VALUES($1,$2,$3,$4,$5,$6)
 ON CONFLICT(id) DO UPDATE SET enabled=EXCLUDED.enabled
 WHERE signature_connections.academy_id=EXCLUDED.academy_id AND signature_connections.region=EXCLUDED.region AND signature_connections.environment=EXCLUDED.environment AND signature_connections.client_id IS NOT DISTINCT FROM EXCLUDED.client_id AND signature_connections.enabled IS DISTINCT FROM EXCLUDED.enabled RETURNING id`,[c.connectionId,c.academyId,c.region,c.environment,c.clientId,args[1]==='--enable']);
 if(result.rowCount!==1&&!(await client.query('SELECT 1 FROM public.signature_connections WHERE id=$1 AND academy_id=$2 AND region=$3 AND environment=$4 AND client_id IS NOT DISTINCT FROM $5::uuid',[c.connectionId,c.academyId,c.region,c.environment,c.clientId])).rowCount)throw new Error('CONNECTION_IDENTITY_CONFLICT');
 if(result.rowCount===1)await client.query('INSERT INTO public.outbox_events(academy_id,id,event_type,entity_id,request_id) VALUES($1,$2,$3,$4,$5)',[c.academyId,randomUUID(),args[1]==='--enable'?'signature.connection.enabled.critical':'signature.connection.disabled.critical',c.connectionId,randomUUID()]);
 await client.query('COMMIT');transaction=false;console.log('Signature webhook registry updated. No provider send or admission verification performed.');
}catch{
 if(transaction)try{await client?.query('ROLLBACK');}catch{ /* connection close discards a failed transaction */ }
 console.error('Signature webhook registration failed; check operator configuration and role without logging credentials.');process.exitCode=1;
}finally{await client?.end();}
