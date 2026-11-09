import 'server-only';
import { createStripeWebhook } from '../../../../../src/integrations/stripe-inbox.ts';
import { configuredStripeWebhook } from '../../../../../src/integrations/stripe-webhook-config.ts';
import { getPaymentIngestDatabase } from '../../../../../src/server/payments.ts';

export const runtime='nodejs';
export const dynamic='force-dynamic';
const receive=createStripeWebhook({connect:()=>getPaymentIngestDatabase().connect()},configuredStripeWebhook);
async function handle(request:Request,context:{params:Promise<{connectionId:string}>}){return receive(request,(await context.params).connectionId);}
export {handle as POST,handle as GET,handle as PUT,handle as PATCH,handle as DELETE};
