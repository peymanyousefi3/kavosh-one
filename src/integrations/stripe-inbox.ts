import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ApiError } from '../core/policy.ts';
import { assertSchemaReady,type Connection,type Database } from '../core/database.ts';
import { stripeConnectionTarget,stripeWebhookConnection,type StripeWebhookConnection } from './stripe-webhook-config.ts';
import { verifiedStripeEvent } from './stripe-event.ts';
import { assertWebhookIngestRole } from './webhook-role.ts';
import { webhookBytes } from './webhook-body.ts';

export function createStripeWebhook(database:Database,configuration:(id:string)=>StripeWebhookConnection|null){
 return async(request:Request,connectionId:string):Promise<Response>=>{
  const requestId=randomUUID(),reply=(status:number,body:unknown)=>Response.json(body,{status,headers:{'Cache-Control':'no-store','X-Request-ID':requestId,'X-Content-Type-Options':'nosniff'}});
  let db:Connection|undefined,transaction=false;
  try{
   if(request.method!=='POST')throw new ApiError(405,'METHOD_NOT_ALLOWED');if(new URL(request.url).search)throw new ApiError(400,'INVALID_QUERY');
   const id=z.string().uuid().parse(connectionId).toLowerCase(),c=stripeWebhookConnection.safeParse(configuration(id));
   if(!c.success||c.data.connectionId!==id)throw new ApiError(503,'STRIPE_WEBHOOK_NOT_CONFIGURED');
   const bytes=await webhookBytes(request,'INVALID_STRIPE_EVENT'),p=verifiedStripeEvent(bytes,request.headers.get('stripe-signature'),c.data);
   db=await database.connect();await assertWebhookIngestRole(db,'payment');await assertSchemaReady(db);await db.query('BEGIN');transaction=true;
   await db.query("SELECT set_config('statement_timeout','5000',true),set_config('lock_timeout','2000',true)");
   const receipt=(await db.query<{outcome:string}>('SELECT public.receive_payment_event($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) AS outcome',[id,stripeConnectionTarget(c.data),p.eventId,p.eventCreated,p.signatureTimestamp,p.eventType,p.objectType,p.resourceId,c.data.livemode,c.data.apiVersion,p.payloadSha256,p.payloadBytes])).rows[0];
   if(!['recorded','duplicate','conflict'].includes(receipt?.outcome??''))throw new ApiError(503,'STRIPE_INGEST_UNAVAILABLE');
   await db.query('COMMIT');transaction=false;return reply(200,{received:true});
  }catch(error){
   if(transaction&&db){try{await db.query('ROLLBACK');}catch{db.release(true);db=undefined;}}
   if(error instanceof ApiError)return reply(error.status,{error:{code:error.code,requestId}});
   if(error instanceof z.ZodError)return reply(400,{error:{code:'INVALID_STRIPE_EVENT',requestId}});
   const limited=error&&typeof error==='object'&&'code'in error&&error.code==='P0001'&&'message'in error&&error.message==='PAYMENT_RATE_LIMIT';
   return reply(limited?429:503,{error:{code:limited?'WEBHOOK_RATE_LIMIT':'STRIPE_INGEST_UNAVAILABLE',requestId}});
  }finally{db?.release();}
 };
}
