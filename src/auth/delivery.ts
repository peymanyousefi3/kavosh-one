import { symmetricEncrypt, symmetricDecrypt } from 'better-auth/crypto';
import { z } from 'zod';
import { emailMessage as email,smsMessage as sms,messageTransport,MessageDeliveryError } from '../integrations/message-delivery.ts';
import type { Delivery } from './config.ts';
import type { IdentityStore } from './store.ts';

// The web process queues encrypted messages, never needs provider credentials.
export function queuedDelivery(store:IdentityStore,key:string):Delivery {
  async function queue(kind:'email'|'sms',message:unknown) {
    const input=(kind==='email'?email:sms).parse(message);
    const payload=await symmetricEncrypt({key,data:JSON.stringify(input)});
    const deadline='expiresAt' in input?input.expiresAt??null:null;
    await store.query(`INSERT INTO identity.delivery_outbox(kind,payload,expires_at) VALUES($1,$2,least(now()+$3*interval '1 second',$4::timestamptz))`,[kind,payload,kind==='sms'?240:840,deadline]);
  }
  return {email:message=>queue('email',message),sms:message=>queue('sms',message)};
}

// Fixed provider endpoint: recipients cannot choose an outbound URL.
export function providerDelivery(env:Record<string,string|undefined>=process.env,send:typeof fetch=fetch):Delivery {
  const config=z.object({SMTP_HOST:z.string().min(1),SMTP_PORT:z.coerce.number().int().refine(n=>n===465||n===587),
    SMTP_USER:z.string().min(1),SMTP_PASSWORD:z.string().min(1),SMTP_FROM:z.string().email(),
    TWILIO_ACCOUNT_SID:z.string().regex(/^AC[a-fA-F0-9]{32}$/),TWILIO_AUTH_TOKEN:z.string().min(20),
    TWILIO_MESSAGING_SERVICE_SID:z.string().regex(/^MG[a-fA-F0-9]{32}$/)}).parse(env);
  const transport=messageTransport({smtp:{host:config.SMTP_HOST,port:config.SMTP_PORT,user:config.SMTP_USER,password:config.SMTP_PASSWORD,from:config.SMTP_FROM},twilio:{accountSid:config.TWILIO_ACCOUNT_SID,authToken:config.TWILIO_AUTH_TOKEN,messagingServiceSid:config.TWILIO_MESSAGING_SERVICE_SID}},send);
  return {
    async email(message) {
      await transport.email(message);
    },
    async sms(message) {
      await transport.sms(message);
    }
  };
}

export async function deliverOne(store:IdentityStore,key:string,delivery:Delivery) {
  // Single SQL lease works across workers; do not hold a connection during delivery.
  await store.query(`UPDATE identity.delivery_outbox SET payload=NULL,outcome='expired' WHERE outcome IS NULL AND expires_at<=now()`);
  // An expired in-flight lease is not proof the provider rejected a send.
  // A user may explicitly request a new verification message;never silently
  // resend this one after a worker crash or uncertain external response.
  await store.query(`UPDATE identity.delivery_outbox SET payload=NULL,outcome='failed',locked_until=NULL WHERE outcome IS NULL AND locked_until<=now()`);
  const row=(await store.query<{id:string;kind:'email'|'sms';payload:string;attempts:number;lease_until:string}>(`UPDATE identity.delivery_outbox SET locked_until=now()+interval '30 seconds',attempts=attempts+1
    WHERE id=(SELECT id FROM identity.delivery_outbox WHERE outcome IS NULL AND expires_at>now() AND available_at<=now()
      AND locked_until IS NULL AND attempts<3 ORDER BY available_at,id FOR UPDATE SKIP LOCKED LIMIT 1)
    RETURNING id,kind,payload,attempts,to_char(locked_until AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') lease_until`)).rows[0];
  if(!row)return false;
  try {
    const input=JSON.parse(await symmetricDecrypt({key,data:row.payload}));
    if(row.kind==='email')await delivery.email(email.parse(input));else await delivery.sms(sms.parse(input));
    await store.query(`UPDATE identity.delivery_outbox SET payload=NULL,outcome='delivered',delivered_at=now(),locked_until=NULL WHERE id=$1 AND outcome IS NULL AND locked_until=$2::timestamptz`,[row.id,row.lease_until]);
  } catch(error) {
    const retryable=error instanceof MessageDeliveryError&&error.outcome!=='outcome_unknown';
    await store.query(`UPDATE identity.delivery_outbox SET locked_until=NULL,available_at=now()+interval '20 seconds',
      outcome=CASE WHEN attempts>=3 OR NOT $2::boolean THEN 'failed' ELSE NULL END,payload=CASE WHEN attempts>=3 OR NOT $2::boolean THEN NULL ELSE payload END WHERE id=$1 AND outcome IS NULL AND locked_until=$3::timestamptz`,[row.id,retryable,row.lease_until]);
  }
  return true;
}
