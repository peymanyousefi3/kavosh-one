import { configuredStripeCheckout } from '../src/integrations/stripe-checkout.ts';
import { executeCheckoutAttempt } from '../src/integrations/checkout-worker.ts';
import { z } from 'zod';
import pg from 'pg';
import { postgresOptions } from '../src/core/postgres-config.ts';
import type { Database } from '../src/core/database.ts';

// Explicit isolated operator command only. No dotenv loading,no key/token in
// arguments,URL output,daemon,automatic retries or default-on production sends.
let pool:pg.Pool|undefined;try{
 const args=process.argv.slice(2);if(args.length!==4||args[3]!=='--dispatch')throw new Error();
 const [connectionId,requestId,attemptId]=args.slice(0,3).map(v=>z.string().uuid().transform(v=>v.toLowerCase()).parse(v));
 const config=configuredStripeCheckout(connectionId),workerId=z.string().uuid().parse(process.env.CHECKOUT_WORKER_ID);if(!config||!process.env.CHECKOUT_WORKER_TOKEN)throw new Error();
 if(['DATABASE_URL','MIGRATION_DATABASE_URL','IDENTITY_DATABASE_URL','AUTH_SECRET','EDGE_AUTH_SECRET','DELIVERY_DATABASE_URL','PAYMENT_INGEST_DATABASE_URL','SIGNATURE_INGEST_DATABASE_URL','SIGNATURE_RESULT_DATABASE_URL','FILE_INSPECTION_DATABASE_URL','NOTIFICATION_OUTBOUND_DATABASE_URL','OPERATIONAL_DELIVERY_CONNECTIONS','STRIPE_WEBHOOK_CONNECTIONS','BOLDSIGN_WEBHOOK_CONNECTIONS','R2_UPLOAD_CONNECTIONS','R2_DOWNLOAD_CONNECTIONS','SMTP_PASSWORD','TWILIO_AUTH_TOKEN'].some(k=>process.env[k]))throw new Error();
 pool=new pg.Pool({...postgresOptions(process.env.CHECKOUT_RESULT_DATABASE_URL),max:1,connectionTimeoutMillis:3000,statement_timeout:5000,query_timeout:7000});pool.on('error',()=>console.error('checkout_result_database_unavailable'));
 const result=await executeCheckoutAttempt({requestId,attemptId},config,{origin:config.origin,token:process.env.CHECKOUT_WORKER_TOKEN,workerId,resultDatabase:pool as unknown as Database});
 console.log(JSON.stringify({requestId,attemptId,startId:result.startId,outcome:result.outcome,transportReceiptRecorded:result.transportReceiptRecorded,transportConflict:result.transportConflict,observationRecorded:result.observationRecorded,reconciliationRequired:true,paymentVerified:false,ledgerAdjusted:false}));
 if(!result.transportReceiptRecorded||result.transportConflict||!result.observationRecorded||result.outcome!=='accepted')process.exitCode=1;
}catch{console.error('Checkout dispatch did not finish. Inspect the saved attempt; do not resend an uncertain payment. No credentials or private provider response logged.');process.exitCode=1;}finally{await pool?.end();}
