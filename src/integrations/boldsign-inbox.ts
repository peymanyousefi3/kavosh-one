import { createHash,randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ApiError } from '../core/policy.ts';
import { assertSchemaReady,type Connection,type Database } from '../core/database.ts';
import { verifyBoldSignSignature } from './boldsign.ts';
import { signatureConnectionTarget,webhookConnection,type WebhookConnection } from './boldsign-webhook-config.ts';

const uuid=z.string().uuid().transform(v=>v.toLowerCase()),epoch=z.number().int().min(0).max(Number.MAX_SAFE_INTEGER-300);
const meta=z.object({id:uuid,created:epoch,eventType:z.string().regex(/^[A-Za-z][A-Za-z0-9_.-]{0,99}$/),clientId:uuid.nullable().optional(),environment:z.enum(['Test','Live'])});
const event=z.object({event:meta,data:z.object({object:z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,79}$/),documentId:uuid.optional(),templateId:uuid.optional(),status:z.string().min(1).max(80).regex(/^[\x20-\x7e]+$/).optional()})});
const probe=z.object({event:meta.extend({eventType:z.literal('Verification')}).strict()}).strict();
export const boldSignWebhookBody=z.union([probe,event]).describe('Original UTF-8 JSON bytes, at most 1 MiB. Data events require a valid X-BoldSign-Signature and configured environment/client identity. Only an X-BoldSign-Event: Verification probe with no data is unsigned and side-effect free. Document objects require documentId. Unknown provider fields are discarded, not retained.');
function json(bytes:Uint8Array){try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)) as unknown;}catch{throw new ApiError(400,'INVALID_BOLDSIGN_EVENT');}}
export async function assertSignatureIngestRole(db:Connection){
 const r=await db.query<{safe:boolean}>(`SELECT NOT r.rolsuper AND NOT r.rolbypassrls AND pg_has_role(current_user,'kavosh_signature_ingest','member')
 AND NOT EXISTS(SELECT 1 FROM pg_roles b WHERE (left(b.rolname,3)='pg_' OR b.rolname IN ('kavosh_runtime','kavosh_identity','kavosh_identity_policy','kavosh_delivery','kavosh_file_worker','kavosh_file_policy','kavosh_signature_policy','kavosh_signature_result_worker','kavosh_signature_result_policy')) AND pg_has_role(current_user,b.oid,'member'))
 AND NOT has_schema_privilege(current_user,'identity','usage') AND NOT has_schema_privilege(current_user,'auth_private','usage') AND NOT has_schema_privilege(current_user,'public','create')
 AND NOT EXISTS(SELECT 1 FROM pg_database d WHERE d.datname=current_database() AND pg_has_role(current_user,d.datdba,'member'))
 AND NOT EXISTS(SELECT 1 FROM pg_namespace n WHERE n.nspname IN ('public','identity','auth_private') AND pg_has_role(current_user,n.nspowner,'member'))
 AND NOT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN ('public','identity','auth_private') AND pg_has_role(current_user,c.relowner,'member'))
 AND NOT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN ('public','identity','auth_private') AND c.relkind IN ('r','p','v','m','f')
  AND (has_table_privilege(current_user,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN') OR has_any_column_privilege(current_user,c.oid,'SELECT,INSERT,UPDATE,REFERENCES')))
 AND NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN ('public','identity','auth_private') AND p.prosecdef AND has_schema_privilege(current_user,n.oid,'USAGE') AND has_function_privilege(current_user,p.oid,'EXECUTE')
  AND p.oid<>'public.receive_signature_event(uuid,text,uuid,bigint,bigint,text,uuid,text,text,uuid,text,text,integer)'::regprocedure)
 AND NOT EXISTS(SELECT 1 FROM pg_roles e WHERE (e.rolsuper OR e.rolbypassrls) AND pg_has_role(current_user,e.oid,'member')) AS safe FROM pg_roles r WHERE r.rolname=current_user`);
 if(!r.rows[0]?.safe)throw new Error('UNSAFE_SIGNATURE_INGEST_ROLE');
}
async function originalBytes(request:Request){
 if(!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type')??'')||!['','identity'].includes(request.headers.get('content-encoding')??''))throw new ApiError(415,'JSON_REQUIRED');
 const length=request.headers.get('content-length');if(length&&(!/^\d{1,10}$/.test(length)||Number(length)>1_048_576))throw new ApiError(413,'BODY_TOO_LARGE');
 const reader=request.body?.getReader();if(!reader)throw new ApiError(400,'INVALID_BOLDSIGN_EVENT');
 let reject!: (error:ApiError)=>void;const cancelled=new Promise<never>((_resolve,r)=>{reject=r;}),abort=()=>reject(new ApiError(408,'WEBHOOK_BODY_CANCELLED'));
 const timer=setTimeout(()=>reject(new ApiError(408,'WEBHOOK_BODY_TIMEOUT')),3000);request.signal.addEventListener('abort',abort,{once:true});if(request.signal.aborted)abort();
 const chunks:Uint8Array[]=[];let size=0,finished=false;
 try{while(true){const part=await Promise.race([reader.read(),cancelled]);if(part.done){finished=true;break;}size+=part.value.byteLength;if(size>1_048_576)throw new ApiError(413,'BODY_TOO_LARGE');chunks.push(part.value);}return Buffer.concat(chunks);}
 finally{clearTimeout(timer);request.signal.removeEventListener('abort',abort);if(!finished)void reader.cancel().catch(()=>{});reader.releaseLock();}
}
export function createBoldSignWebhook(database:Database,configuration:(id:string)=>WebhookConnection|null){
 return async(request:Request,connectionId:string):Promise<Response>=>{
  const requestId=randomUUID(),reply=(status:number,body:unknown)=>Response.json(body,{status,headers:{'Cache-Control':'no-store','X-Request-ID':requestId,'X-Content-Type-Options':'nosniff'}});
  let db:Connection|undefined,transaction=false;
  try{
   if(request.method!=='POST')throw new ApiError(405,'METHOD_NOT_ALLOWED');if(new URL(request.url).search)throw new ApiError(400,'INVALID_QUERY');
   const id=uuid.parse(connectionId),raw=configuration(id),parsed=webhookConnection.safeParse(raw);if(!parsed.success||parsed.data.connectionId!==id)throw new ApiError(503,'BOLDSIGN_WEBHOOK_NOT_CONFIGURED');const c=parsed.data;
   const bytes=await originalBytes(request),header=request.headers.get('x-boldsign-event');
   // BoldSign's unsigned URL-verification probe has no data and produces no
   // database calls, notification, binding or admission effect.
   if(header==='Verification'){
    const p=probe.parse(json(bytes));if((p.event.clientId??null)!==c.clientId)throw new ApiError(400,'BOLDSIGN_STREAM_MISMATCH');return reply(200,{received:true});
   }
   const signed=verifyBoldSignSignature(bytes,request.headers.get('x-boldsign-signature'),c.secrets),p=event.parse(json(bytes));
   if(p.event.eventType==='Verification'||(header!==null&&header!==p.event.eventType)||p.event.environment!==c.environment||(p.event.clientId??null)!==c.clientId||p.event.created>signed+300)throw new ApiError(400,'BOLDSIGN_STREAM_MISMATCH');
   if(p.data.object==='document'&&!p.data.documentId)throw new ApiError(400,'INVALID_BOLDSIGN_EVENT');
   db=await database.connect();await assertSignatureIngestRole(db);await assertSchemaReady(db);await db.query('BEGIN');transaction=true;
   await db.query("SELECT set_config('statement_timeout','5000',true),set_config('lock_timeout','2000',true)");
   const receipt=(await db.query<{outcome:string}>('SELECT public.receive_signature_event($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) AS outcome',[c.connectionId,signatureConnectionTarget(c),p.event.id,p.event.created,signed,p.event.environment,p.event.clientId??null,p.event.eventType,p.data.object,p.data.documentId??p.data.templateId??null,p.data.status??null,createHash('sha256').update(bytes).digest('hex'),bytes.length])).rows[0];
   if(!['recorded','duplicate','conflict'].includes(receipt?.outcome??''))throw new ApiError(503,'BOLDSIGN_INGEST_UNAVAILABLE');
   await db.query('COMMIT');transaction=false;return reply(200,{received:true});
  }catch(error){
   if(transaction&&db){try{await db.query('ROLLBACK');}catch{db.release(true);db=undefined;}}
   if(error instanceof ApiError)return reply(error.status,{error:{code:error.code,requestId}});
   if(error instanceof z.ZodError)return reply(400,{error:{code:'INVALID_BOLDSIGN_EVENT',requestId}});
   const limited=error&&typeof error==='object'&&'code'in error&&error.code==='P0001'&&'message'in error&&error.message==='SIGNATURE_RATE_LIMIT';
   return reply(limited?429:503,{error:{code:limited?'WEBHOOK_RATE_LIMIT':'BOLDSIGN_INGEST_UNAVAILABLE',requestId}});
  }finally{db?.release();}
 };
}
