import { z } from 'zod';
import { boldSignConnectionSchema } from './boldsign.ts';
import { signatureConnectionTarget } from './boldsign-webhook-config.ts';
import { r2Connection,r2TargetId } from './r2-config.ts';

const uuid=z.string().uuid().transform(v=>v.toLowerCase());
const provider=boldSignConnectionSchema.extend({connectionId:uuid,environment:z.enum(['Test','Live']),clientId:uuid.nullable()}).strict();
const entry=z.object({academyId:uuid,providers:z.array(provider).min(1).max(1000),archive:r2Connection}).strict();
// Operator-only configuration. No webhook HMAC, current identity/contact data,
// browser token, media credential or send capability is needed by this runner.
export function signatureCompletionWorkerConfiguration(env:Record<string,string|undefined>=process.env){
 if(env.SIGNATURE_COMPLETION_WORKER_ENABLED===undefined||env.SIGNATURE_COMPLETION_WORKER_ENABLED==='false')return null;
 try{
  if(env.SIGNATURE_COMPLETION_WORKER_ENABLED!=='true')throw Error();
  if(['MIGRATION_DATABASE_URL','DATABASE_URL','IDENTITY_DATABASE_URL','DELIVERY_DATABASE_URL','SIGNATURE_INGEST_DATABASE_URL','NOTIFICATION_WORKER_DATABASE_URL','NOTIFICATION_OUTBOUND_DATABASE_URL','REPORT_WORKER_DATABASE_URL','FILE_INSPECTION_DATABASE_URL','FILE_COPY_WORKER_DATABASE_URL','AUTH_SECRET','EDGE_AUTH_SECRET','SMTP_PASSWORD','TWILIO_AUTH_TOKEN','TWILIO_API_KEY_SECRET','OPERATIONAL_DELIVERY_CONNECTIONS','BOLDSIGN_WEBHOOK_CONNECTIONS','R2_UPLOAD_CONNECTIONS','R2_DOWNLOAD_CONNECTIONS','FILE_INSPECTION_R2_CONNECTIONS','FILE_COPY_CONNECTIONS'].some(k=>Boolean(env[k])))throw Error();
  const text=env.SIGNATURE_COMPLETION_CONNECTIONS;
  if(!text||Buffer.byteLength(text)>1048576)throw Error();
  const entries=z.array(entry).min(1).max(1000).parse(JSON.parse(text));
  const ids=entries.map(e=>e.academyId),connections=entries.flatMap(e=>e.providers.map(p=>p.connectionId));
  if(new Set(ids).size!==ids.length||new Set(connections).size!==connections.length)throw Error();
  const retrySeconds=z.coerce.number().int().min(60).max(86400).parse(env.SIGNATURE_COMPLETION_RETRY_SECONDS??'21600');
  const providers=new Map(entries.flatMap(e=>e.providers.map(p=>[e.academyId+'/'+p.connectionId+'/'+signatureConnectionTarget({...p,academyId:e.academyId}),{region:p.region,apiKey:p.apiKey}] as const)));
  const archives=new Map(entries.map(e=>[e.academyId,{configuration:e.archive,targetId:r2TargetId(e.archive)}]));
  return {academyIds:ids,retrySeconds,providers:(academy:string,connection:string,target:string)=>providers.get(academy+'/'+connection+'/'+target)??null,evidenceStores:(academy:string)=>archives.get(academy)??null};
 }catch{throw Error('SIGNATURE_COMPLETION_WORKER_NOT_CONFIGURED');}
}
