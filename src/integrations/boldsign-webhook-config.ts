import { createHash } from 'node:crypto';
import { z } from 'zod';
import { ApiError } from '../core/policy.ts';

const uuid=z.string().uuid().transform(v=>v.toLowerCase());
export const webhookConnection=z.object({connectionId:uuid,academyId:uuid,region:z.enum(['US','CA','EU','AU']),environment:z.enum(['Test','Live']),clientId:uuid.nullable(),secrets:z.array(z.string().min(16).max(4096).regex(/^[\x21-\x7e]+$/)).min(1).max(2)}).strict();
export type WebhookConnection=z.infer<typeof webhookConnection>;
export function signatureConnectionTarget(c:Omit<WebhookConnection,'secrets'>){return createHash('sha256').update(JSON.stringify([1,c.connectionId,c.academyId,c.region,c.environment,c.clientId])).digest('hex');}
export function configuredBoldSignWebhook(id:string,env:Record<string,string|undefined>=process.env):WebhookConnection|null{
 if(env.BOLDSIGN_WEBHOOK_ENABLED!=='true')return null;
 try{
  const selected=uuid.parse(id),raw=env.BOLDSIGN_WEBHOOK_CONNECTIONS;if(!raw||Buffer.byteLength(raw)>1_048_576)throw new Error('INVALID_CONFIG');
  const all=z.array(webhookConnection).max(1000).parse(JSON.parse(raw));
  if(new Set(all.map(c=>c.connectionId)).size!==all.length)throw new Error('DUPLICATE_CONNECTION');
  // A key reused on another school/endpoint would authenticate the wrong
  // provider stream. Rotation must retain distinct, endpoint-specific keys.
  const keys=all.flatMap(c=>c.secrets);if(new Set(keys).size!==keys.length)throw new Error('SHARED_WEBHOOK_KEY');
  return all.find(c=>c.connectionId===selected)??null;
 }catch{throw new ApiError(503,'BOLDSIGN_WEBHOOK_NOT_CONFIGURED');}
}
