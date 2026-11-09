import { createHash } from 'node:crypto';
import { z } from 'zod';
import { ApiError } from '../core/policy.ts';

export const stripeSnapshotVersion='2026-10-28.endive';
const uuid=z.string().uuid().transform(v=>v.toLowerCase());
// Each school uses its own account-level snapshot endpoint. Stripe Connect
// events and thin events are deliberately not accepted by this endpoint.
export const stripeWebhookConnection=z.object({connectionId:uuid,academyId:uuid,accountId:z.string().regex(/^acct_[A-Za-z0-9]{1,200}$/),livemode:z.boolean(),apiVersion:z.literal(stripeSnapshotVersion),secrets:z.array(z.string().regex(/^whsec_[A-Za-z0-9]{16,256}$/)).min(1).max(2)}).strict();
export type StripeWebhookConnection=z.infer<typeof stripeWebhookConnection>;
export function stripeConnectionTarget(c:Omit<StripeWebhookConnection,'secrets'>){return createHash('sha256').update(JSON.stringify([1,c.connectionId,c.academyId,c.accountId,c.livemode,c.apiVersion])).digest('hex');}
export function configuredStripeWebhook(id:string,env:Record<string,string|undefined>=process.env):StripeWebhookConnection|null{
 if(env.STRIPE_WEBHOOK_ENABLED!=='true')return null;
 try{
  const selected=uuid.parse(id),raw=env.STRIPE_WEBHOOK_CONNECTIONS;if(!raw||Buffer.byteLength(raw)>1_048_576)throw new Error('INVALID_CONFIG');
  const all=z.array(stripeWebhookConnection).max(1000).parse(JSON.parse(raw)),keys=all.flatMap(c=>c.secrets);
  if(new Set(all.map(c=>c.connectionId)).size!==all.length||new Set(keys).size!==keys.length)throw new Error('AMBIGUOUS_CONNECTION');
  // A payment must never be credited to two schools sharing an account stream.
  if(new Set(all.map(c=>JSON.stringify([c.accountId,c.livemode]))).size!==all.length)throw new Error('SHARED_ACCOUNT_STREAM');
  return all.find(c=>c.connectionId===selected)??null;
 }catch{throw new ApiError(503,'STRIPE_WEBHOOK_NOT_CONFIGURED');}
}
