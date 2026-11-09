import { z } from 'zod';
import { assertRuntimeRole,assertSchemaReady,type Database } from '../core/database.ts';
import { deliveryRecipientPolicy,deliverySourceFrom } from '../modules/notification-deliveries.ts';
import { automationEventCurrentSourceSQL } from '../modules/automation-events.ts';
import { emailMessage,smsMessage,MessageDeliveryError,type messageTransport } from '../integrations/message-delivery.ts';

const uuid=z.string().uuid().transform(v=>v.toLowerCase()),ids=z.array(uuid).min(1).max(1000).refine(v=>new Set(v).size===v.length);
export type MessageTransport=ReturnType<typeof messageTransport>;
export type MessageConnections=(academyId:string)=>MessageTransport|null;
type Lease={id:string;academy_id:string;person_id:string;event_id:string;channel:'email'|'sms';lease_token:string};
const payloadSchema=z.object({channel:z.enum(['email','sms']),to:z.string(),title:z.string(),body:z.string(),locale:z.enum(['en','fr','zh-CN'])}).strict();
const deferred=z.object({deferred:z.literal(true)}).strict();
const acceptance=z.object({provider:z.enum(['smtp','twilio']),providerMessageId:z.string().min(1).max(500).refine(v=>!/[\p{Cc}]/u.test(v)),providerStatus:z.string().min(1).max(64),providerAccepted:z.literal(true),deliveryConfirmed:z.literal(false)}).strict();
// Exact source policy reused from dispatch/inboxes. Pending approval messages
// stop once that case changes;source-bound calendar/follow-up notices stop when
// their original occurrence is no longer current. Immutable audit stays readable.
const currentSource=`(e.source_kind<>'approval' OR p.version=e.source_version) AND(${automationEventCurrentSourceSQL})`;
function boundedText(raw:string,maximum:number){if(raw.length<=maximum)return raw;let output='';for(const c of raw){if(output.length+c.length>maximum-1)break;output+=c;}return output+'…';}

// No invented session/actor or approval. One native lease,read-only recipient
// policy,current verified contact/preference check,then COMMIT before provider IO.
// No daemon auto-start and no automatic retry after any attempted external send.
export async function processOneMessage(database:Database,academies:string[],connections:MessageConnections,signal?:AbortSignal){
 const allowed=ids.parse(academies);if(signal?.aborted)return {claimed:false,recorded:false};const transports=new Map(allowed.map(a=>[a,connections(a)])),routes=allowed.flatMap(a=>{const t=transports.get(a);return t?.channels.length?[{academy_id:a,channels:z.array(z.enum(['email','sms'])).min(1).max(2).refine(v=>new Set(v).size===v.length).parse(t.channels)}]:[];});
 if(!routes.length)return {claimed:false,recorded:false};const db=await database.connect();let transaction=false,broken=false;
 try{
  await assertRuntimeRole(db,'message_worker');await assertSchemaReady(db);
  const lease=(await db.query<Lease>('SELECT * FROM public.claim_notification_delivery($1::jsonb)',[JSON.stringify(routes)])).rows[0];if(!lease)return {claimed:false,recorded:false};
  async function begin(){await db.query('BEGIN');transaction=true;await db.query("SELECT set_config('app.academy_id',$1,true),set_config('statement_timeout','5000',true),set_config('lock_timeout','2000',true)",[lease.academy_id]);}
  async function commit(){await db.query('COMMIT');transaction=false;}
  async function finish(outcome:'accepted'|'failed'|'unknown'|'cancelled',providerId:string|null,error:string|null){await begin();const recorded=(await db.query<{ok:boolean}>('SELECT public.finish_notification_delivery($1,$2,$3,$4,$5) ok',[lease.id,lease.lease_token,outcome,providerId,error])).rows[0]?.ok===true;await commit();return {claimed:true,recorded,outcome};}
  await begin();await db.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1,8))',[lease.academy_id]);await db.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1,9))',[lease.academy_id]);
  const locked=(await db.query<{ok:boolean}>('SELECT public.lock_notification_delivery_source($1,$2) ok',[lease.id,lease.lease_token])).rows[0]?.ok===true;
  if(!locked){await commit();return {claimed:true,recorded:false,outcome:'lease_lost' as const};}
  const policy=await deliveryRecipientPolicy(db,lease.person_id),source=policy?(await db.query(`SELECT d.id ${deliverySourceFrom} AND d.id=$6 AND coalesce((${currentSource}),false) AND EXISTS(SELECT 1 FROM public.automation_rules rule JOIN public.automation_rule_revisions v ON v.academy_id=rule.academy_id AND v.rule_id=rule.id AND v.version=rule.version WHERE rule.id=d.rule_id AND rule.version=d.rule_version AND v.definition->'enabled'='true'::jsonb AND v.definition#>>'{execution,mode}'='automatic')`,[...policy,lease.id])).rows[0]:null;
  if(!source){const ok=(await db.query<{ok:boolean}>('SELECT public.finish_notification_delivery($1,$2,\'cancelled\',NULL,$3) ok',[lease.id,lease.lease_token,'SOURCE_OR_AUTHORITY_CHANGED'])).rows[0]?.ok===true;await commit();return {claimed:true,recorded:ok,outcome:'cancelled' as const};}
  if(signal?.aborted){await db.query('ROLLBACK');transaction=false;return {claimed:true,recorded:false,outcome:'preparation_stopped' as const};}
  const raw=(await db.query<{data:unknown}>('SELECT public.begin_notification_delivery($1,$2) data',[lease.id,lease.lease_token])).rows[0]?.data;
  if(deferred.safeParse(raw).success){await commit();return {claimed:true,recorded:false,outcome:'deferred' as const};}
  if(!raw){const status=(await db.query<{status:string}>('SELECT status FROM public.notification_deliveries WHERE id=$1',[lease.id])).rows[0]?.status;await commit();return {claimed:true,recorded:status==='cancelled',outcome:status==='cancelled'?'cancelled' as const:'lease_lost' as const};}
  const payload=payloadSchema.parse(raw);if(payload.channel!==lease.channel)throw new Error('DELIVERY_CHANNEL_CHANGED');
  const email=payload.channel==='email'?emailMessage.parse({to:payload.to,subject:boundedText(payload.title.replace(/[\r\n]/g,' '),200),text:payload.body}):null,sms=payload.channel==='sms'?smsMessage.parse({to:payload.to,text:boundedText(payload.title+'\n'+payload.body,1000)}):null;
  if(signal?.aborted){await db.query('ROLLBACK');transaction=false;return {claimed:true,recorded:false,outcome:'preparation_stopped' as const};}
  await commit();if(signal?.aborted)return await finish('failed',null,'WORKER_STOPPED_BEFORE_SEND');
  let outcome:'accepted'|'failed'|'unknown'='unknown',providerId:string|null=null,error:string|null='SEND_OUTCOME_UNKNOWN';
  try{
   const transport=transports.get(lease.academy_id);if(!transport)throw new MessageDeliveryError('not_attempted','CHANNEL_NOT_CONFIGURED');
   const result=acceptance.parse(email?await transport.email(email):await transport.sms(sms!));if(result.provider!==(lease.channel==='email'?'smtp':'twilio'))throw new Error('PROVIDER_RECEIPT_MISMATCH');
   outcome='accepted';providerId=result.providerMessageId;error=null;
  }catch(e){if(e instanceof MessageDeliveryError&&e.outcome!=='outcome_unknown'){outcome='failed';error=e.outcome==='rejected'?'PROVIDER_REJECTED':'PROVIDER_NOT_ATTEMPTED';}}
  // Await inside this try:otherwise finally returns the connection to the
  // pool while the finish transaction is still running on that same client.
  return await finish(outcome,providerId,error);
 }catch(error){if(transaction)try{await db.query('ROLLBACK');}catch{broken=true;}throw error;}finally{db.release(broken);}
}
