import { configuredStripeCheckout } from '../src/integrations/stripe-checkout.ts';
import { executeCheckoutAttempt } from '../src/integrations/checkout-worker.ts';
import { z } from 'zod';

// Explicit isolated operator command only. No dotenv loading,no key/token in
// arguments,URL output,daemon,automatic retries or default-on production sends.
try{
 const args=process.argv.slice(2);if(args.length!==4||args[3]!=='--dispatch')throw new Error();
 const [connectionId,requestId,attemptId]=args.slice(0,3).map(v=>z.string().uuid().transform(v=>v.toLowerCase()).parse(v));
 const config=configuredStripeCheckout(connectionId);if(!config||!process.env.CHECKOUT_WORKER_TOKEN)throw new Error();
 const result=await executeCheckoutAttempt({requestId,attemptId},config,{origin:config.origin,token:process.env.CHECKOUT_WORKER_TOKEN});
 console.log(JSON.stringify({requestId,attemptId,outcome:result.outcome,observationRecorded:result.observationRecorded,reconciliationRequired:true,paymentVerified:false,ledgerAdjusted:false}));
 if(!result.observationRecorded||result.outcome!=='accepted')process.exitCode=1;
}catch{console.error('Checkout dispatch did not finish. Inspect the saved attempt; do not resend an uncertain payment. No credentials or private provider response logged.');process.exitCode=1;}
