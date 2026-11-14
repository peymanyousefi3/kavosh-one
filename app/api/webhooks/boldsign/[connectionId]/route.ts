import 'server-only';
import { createBoldSignWebhook } from '../../../../../src/integrations/boldsign-inbox.ts';
import { configuredBoldSignWebhook } from '../../../../../src/integrations/boldsign-webhook-config.ts';
import { getSignatureIngestDatabase } from '../../../../../src/server/signatures.ts';

export const runtime='nodejs';
export const dynamic='force-dynamic';
const receive=createBoldSignWebhook({connect:()=>getSignatureIngestDatabase().connect()},configuredBoldSignWebhook);
async function handle(request:Request,context:{params:Promise<{connectionId:string}>}){return receive(request,(await context.params).connectionId);}
export {handle as POST,handle as GET,handle as PUT,handle as PATCH,handle as DELETE};
