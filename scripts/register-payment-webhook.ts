import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { configuredStripeWebhook } from '../src/integrations/stripe-webhook-config.ts';
import { postgresOptions } from '../src/core/postgres-config.ts';
import { expectedSchemaRevision } from '../src/core/database.ts';

// Explicit operator-only local registry change. No Stripe account/API call,
// charge, message, financial posting or acceptance of provider terms.
let client:pg.Client|undefined,transaction=false;
try{
 const args=process.argv.slice(2),id=z.string().uuid().parse(args[0]).toLowerCase();if(args.length>2||args.length===2&&args[1]!=='--enable')throw new Error('INVALID_ARGUMENTS');
 const c=configuredStripeWebhook(id,{...process.env,STRIPE_WEBHOOK_ENABLED:'true'});if(!c)throw new Error('CONNECTION_NOT_CONFIGURED');
 client=new pg.Client(postgresOptions(process.env.MIGRATION_DATABASE_URL));await client.connect();
 if((await client.query('SELECT public.schema_revision() AS revision')).rows[0].revision<expectedSchemaRevision)throw new Error('SCHEMA_NOT_CURRENT');
 await client.query('BEGIN');transaction=true;
 const result=await client.query(`INSERT INTO public.payment_connections(id,academy_id,account_id,livemode,api_version,enabled) VALUES($1,$2,$3,$4,$5,$6)
 ON CONFLICT(id) DO UPDATE SET enabled=EXCLUDED.enabled
 WHERE payment_connections.academy_id=EXCLUDED.academy_id AND payment_connections.account_id=EXCLUDED.account_id AND payment_connections.livemode=EXCLUDED.livemode AND payment_connections.api_version=EXCLUDED.api_version AND payment_connections.enabled IS DISTINCT FROM EXCLUDED.enabled RETURNING id`,[c.connectionId,c.academyId,c.accountId,c.livemode,c.apiVersion,args[1]==='--enable']);
 if(result.rowCount!==1&&!(await client.query('SELECT 1 FROM public.payment_connections WHERE id=$1 AND academy_id=$2 AND account_id=$3 AND livemode=$4 AND api_version=$5',[c.connectionId,c.academyId,c.accountId,c.livemode,c.apiVersion])).rowCount)throw new Error('CONNECTION_IDENTITY_CONFLICT');
 if(result.rowCount===1)await client.query('INSERT INTO public.outbox_events(academy_id,id,event_type,entity_id,request_id) VALUES($1,$2,$3,$4,$5)',[c.academyId,randomUUID(),args[1]==='--enable'?'payment.connection.enabled.critical':'payment.connection.disabled.critical',c.connectionId,randomUUID()]);
 await client.query('COMMIT');transaction=false;console.log('Payment webhook registry updated. No provider call, charge or financial posting performed.');
}catch{
 if(transaction)try{await client?.query('ROLLBACK');}catch{/* Closing discards a failed transaction. */}
 console.error('Payment webhook registration failed; check operator configuration and role without logging credentials.');process.exitCode=1;
}finally{await client?.end();}
