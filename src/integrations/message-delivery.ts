import nodemailer from 'nodemailer';
import { z } from 'zod';

const text=z.string().refine(v=>v.isWellFormed()&&!v.includes('\0'));
export const emailMessage=z.object({to:z.string().email().max(254),subject:text.max(200).refine(v=>!/[\r\n]/.test(v)),text:text.max(10000),expiresAt:z.iso.datetime({offset:true}).optional()}).strict();
export const smsMessage=z.object({to:z.string().regex(/^\+[1-9]\d{7,14}$/),text:text.max(1000)}).strict();
export const smtpConnection=z.object({host:z.string().min(1).max(253).regex(/^[A-Za-z0-9.-]+$/),port:z.number().int().refine(v=>v===465||v===587),user:text.min(1).max(1000),password:text.min(1).max(4096),from:z.string().email().max(254)}).strict();
export const twilioConnection=z.object({accountSid:z.string().regex(/^AC[a-fA-F0-9]{32}$/),authToken:text.min(20).max(4096),messagingServiceSid:z.string().regex(/^MG[a-fA-F0-9]{32}$/)}).strict();
export const messageConnection=z.object({smtp:smtpConnection.optional(),twilio:twilioConnection.optional()}).strict().refine(v=>!!v.smtp||!!v.twilio);
export type MessageConnection=z.infer<typeof messageConnection>;
export type MessageAcceptance={provider:'smtp'|'twilio';providerMessageId:string;providerStatus:string;providerAccepted:true;deliveryConfirmed:false};
// A lost response may follow a successful send. Callers MUST NOT blindly
// retry outcome_unknown;there is no exactly-once promise for external IO.
export class MessageDeliveryError extends Error{
 constructor(readonly outcome:'not_attempted'|'rejected'|'outcome_unknown',code:string){super(code);this.name='MessageDeliveryError';}
}
async function responseJson(response:Response){
 if(!response.headers.get('content-type')?.toLowerCase().startsWith('application/json'))throw new Error('INVALID_MESSAGE_RESPONSE');
 const reader=response.body?.getReader();if(!reader)throw new Error('INVALID_MESSAGE_RESPONSE');const chunks:Uint8Array[]=[];let size=0,done=false;
 try{while(true){const part=await reader.read();if(part.done){done=true;break;}size+=part.value.byteLength;if(size>65536)throw new Error('MESSAGE_RESPONSE_TOO_LARGE');chunks.push(part.value);}return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks))) as unknown;}
 finally{if(!done)void reader.cancel().catch(()=>{});reader.releaseLock();}
}
const twilioReceipt=z.object({sid:z.string().regex(/^SM[a-fA-F0-9]{32}$/),account_sid:z.string(),messaging_service_sid:z.string(),to:z.string(),status:z.enum(['accepted','queued','sending','sent','delivered']),error_code:z.null()});
// No IO at construction. No arbitrary provider URL,TLS downgrade,attachments
// or message-selected sender. Reused by auth and isolated operational workers.
export function messageTransport(configuration:MessageConnection,send:typeof fetch=fetch){
 const config=messageConnection.parse(configuration),smtp=config.smtp,twilio=config.twilio;
 const transport=smtp?nodemailer.createTransport({host:smtp.host,port:smtp.port,secure:smtp.port===465,requireTLS:true,tls:{rejectUnauthorized:true,minVersion:'TLSv1.2'},auth:{user:smtp.user,pass:smtp.password},connectionTimeout:5000,greetingTimeout:5000,socketTimeout:10000,disableFileAccess:true,disableUrlAccess:true}):null;
 return {
  channels:[...(smtp?['email' as const]:[]),...(twilio?['sms' as const]:[])],
  async email(message:z.input<typeof emailMessage>):Promise<MessageAcceptance>{
   const input=emailMessage.parse(message);if(!smtp||!transport)throw new MessageDeliveryError('not_attempted','EMAIL_NOT_CONFIGURED');if(input.expiresAt&&Date.parse(input.expiresAt)<=Date.now())throw new MessageDeliveryError('not_attempted','MESSAGE_EXPIRED');
   try{
    const result=await transport.sendMail({from:smtp.from,to:input.to,subject:input.subject,text:input.text,disableFileAccess:true,disableUrlAccess:true});
    if(result.rejected?.length||!result.accepted?.some(v=>typeof v==='string'&&v.toLowerCase()===input.to.toLowerCase())||typeof result.messageId!=='string'||!result.messageId||result.messageId.length>500)throw new MessageDeliveryError('outcome_unknown','EMAIL_ACCEPTANCE_UNCONFIRMED');
    return {provider:'smtp',providerMessageId:result.messageId,providerStatus:'accepted',providerAccepted:true,deliveryConfirmed:false};
   }catch(e){if(e instanceof MessageDeliveryError)throw e;throw new MessageDeliveryError('outcome_unknown','EMAIL_OUTCOME_UNKNOWN');}
  },
  async sms(message:z.input<typeof smsMessage>):Promise<MessageAcceptance>{
   const input=smsMessage.parse(message);if(!twilio)throw new MessageDeliveryError('not_attempted','SMS_NOT_CONFIGURED');
   try{
    const response=await send('https://api.twilio.com/2010-04-01/Accounts/'+twilio.accountSid+'/Messages.json',{method:'POST',redirect:'error',signal:AbortSignal.timeout(10000),headers:{authorization:'Basic '+Buffer.from(twilio.accountSid+':'+twilio.authToken).toString('base64'),'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({To:input.to,Body:input.text,MessagingServiceSid:twilio.messagingServiceSid})});
    if(response.status!==201){void response.body?.cancel().catch(()=>{});throw new MessageDeliveryError(response.status>=400&&response.status<500&&response.status!==408?'rejected':'outcome_unknown','SMS_NOT_ACCEPTED');}
    const receipt=twilioReceipt.parse(await responseJson(response));if(receipt.account_sid!==twilio.accountSid||receipt.messaging_service_sid!==twilio.messagingServiceSid||receipt.to!==input.to)throw new Error('SMS_RECEIPT_MISMATCH');
    return {provider:'twilio',providerMessageId:receipt.sid,providerStatus:receipt.status,providerAccepted:true,deliveryConfirmed:false};
   }catch(e){if(e instanceof MessageDeliveryError)throw e;throw new MessageDeliveryError('outcome_unknown','SMS_OUTCOME_UNKNOWN');}
  }
 };
}

// Operator-only per-school configuration. Never infer operational delivery
// from authentication credentials or enable it from an API request body.
export function configuredOperationalDelivery(academyId:string,env:Record<string,string|undefined>=process.env,send:typeof fetch=fetch){
 if(env.OPERATIONAL_DELIVERY_ENABLED!=='true')return null;
 try{
  const uuid=z.string().uuid().transform(v=>v.toLowerCase()),id=uuid.parse(academyId),raw=env.OPERATIONAL_DELIVERY_CONNECTIONS;if(!raw||Buffer.byteLength(raw)>1048576)throw new Error('INVALID_CONFIG');
  const entries=z.array(z.object({academyId:uuid,configuration:messageConnection}).strict()).min(1).max(1000).refine(v=>new Set(v.map(e=>e.academyId)).size===v.length).parse(JSON.parse(raw));
  const selected=entries.find(e=>e.academyId===id);return selected?messageTransport(selected.configuration,send):null;
 }catch{throw new MessageDeliveryError('not_attempted','OPERATIONAL_DELIVERY_NOT_CONFIGURED');}
}
