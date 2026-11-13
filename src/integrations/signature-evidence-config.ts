import { z } from 'zod';
import { r2Connection,r2TargetId } from './r2-config.ts';
import { clamdConfiguration } from './clamav.ts';
import { clamdDatabasePolicy } from './clamav-database.ts';
import { pdfServiceConfiguration } from '../files/pdf-service.ts';

const uuid=z.string().uuid().transform(v=>v.toLowerCase());
const entry=z.object({academyId:uuid,configuration:r2Connection}).strict();
export function signatureEvidenceConfiguration(env:Record<string,string|undefined>=process.env){
 if(env.SIGNATURE_EVIDENCE_ENABLED===undefined||env.SIGNATURE_EVIDENCE_ENABLED==='false')return null;
 try{
  if(env.SIGNATURE_EVIDENCE_ENABLED!=='true')throw Error();
  if(['DATABASE_URL','MIGRATION_DATABASE_URL','IDENTITY_DATABASE_URL','DELIVERY_DATABASE_URL','AUTH_SECRET','EDGE_AUTH_SECRET','SIGNATURE_INGEST_DATABASE_URL','SIGNATURE_RESULT_DATABASE_URL','CHECKOUT_RESULT_DATABASE_URL','CHECKOUT_WORKER_TOKEN','BOLDSIGN_API_KEY','STRIPE_SECRET_KEY','STRIPE_WEBHOOK_SECRET','PLATFORM_NOTICE_WORKER_DATABASE_URL','SIGNATURE_COMPLETION_DATABASE_URL','SIGNATURE_COMPLETION_CONNECTIONS','BOLDSIGN_WEBHOOK_CONNECTIONS','OPERATIONAL_DELIVERY_CONNECTIONS','SMTP_PASSWORD','TWILIO_AUTH_TOKEN','TWILIO_API_KEY_SECRET','FILE_INSPECTION_DATABASE_URL','FILE_COPY_WORKER_DATABASE_URL','FILE_INSPECTION_R2_CONNECTIONS','FILE_COPY_CONNECTIONS','R2_UPLOAD_CONNECTIONS','R2_DOWNLOAD_CONNECTIONS','NOTIFICATION_WORKER_DATABASE_URL','NOTIFICATION_OUTBOUND_DATABASE_URL','REPORT_WORKER_DATABASE_URL'].some(k=>Boolean(env[k])))throw Error();
  const raw=env.SIGNATURE_EVIDENCE_CONNECTIONS;if(!raw||Buffer.byteLength(raw)>1048576)throw Error();
  const entries=z.array(entry).min(1).max(1000).parse(JSON.parse(raw));if(new Set(entries.map(e=>e.academyId)).size!==entries.length)throw Error();
  const connections=new Map(entries.map(e=>[e.academyId+'/'+r2TargetId(e.configuration),e.configuration]));
  const scanner=clamdConfiguration.parse({socketPath:env.CLAMD_SOCKET_PATH,maximumBytes:10485760,timeoutMs:30000});
  const databasePolicy=clamdDatabasePolicy.parse({timeZone:env.CLAMD_TIME_ZONE,maximumAgeSeconds:z.coerce.number().default(172800).parse(env.CLAMD_MAXIMUM_DATABASE_AGE_SECONDS)});
  const pdfService=pdfServiceConfiguration.parse({socketPath:env.SIGNATURE_EVIDENCE_PDF_SOCKET_PATH});
  return {academyIds:entries.map(e=>e.academyId),scanner,databasePolicy,pdfService,readers:(academy:string,target:string)=>connections.get(academy+'/'+target)??null};
 }catch{throw Error('SIGNATURE_EVIDENCE_NOT_CONFIGURED');}
}
