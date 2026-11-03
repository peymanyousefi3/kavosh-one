import { symmetricEncrypt, symmetricDecrypt } from 'better-auth/crypto';
import nodemailer from 'nodemailer';
import { z } from 'zod';
import type { Delivery } from './config.ts';
import type { IdentityStore } from './store.ts';

const email=z.object({to:z.string().email(),subject:z.string().max(200),text:z.string().max(10000)}).strict();
const sms=z.object({to:z.string().regex(/^\+[1-9]\d{7,14}$/),text:z.string().max(1000)}).strict();

// The web process queues encrypted messages, never needs provider credentials.
export function queuedDelivery(store:IdentityStore,key:string):Delivery {
  async function queue(kind:'email'|'sms',message:unknown) {
    const input=(kind==='email'?email:sms).parse(message);
    const payload=await symmetricEncrypt({key,data:JSON.stringify(input)});
    await store.query(`INSERT INTO identity.delivery_outbox(kind,payload,expires_at) VALUES($1,$2,now()+$3*interval '1 second')`,[kind,payload,kind==='sms'?240:840]);
  }
  return {email:message=>queue('email',message),sms:message=>queue('sms',message)};
}

// Fixed provider endpoint: recipients cannot choose an outbound URL.
export function providerDelivery(env:Record<string,string|undefined>=process.env,send:typeof fetch=fetch):Delivery {
  const config=z.object({SMTP_HOST:z.string().min(1),SMTP_PORT:z.coerce.number().int().refine(n=>n===465||n===587),
    SMTP_USER:z.string().min(1),SMTP_PASSWORD:z.string().min(1),SMTP_FROM:z.string().email(),
    TWILIO_ACCOUNT_SID:z.string().regex(/^AC[a-fA-F0-9]{32}$/),TWILIO_AUTH_TOKEN:z.string().min(20),
    TWILIO_MESSAGING_SERVICE_SID:z.string().regex(/^MG[a-fA-F0-9]{32}$/)}).parse(env);
  const transport=nodemailer.createTransport({host:config.SMTP_HOST,port:config.SMTP_PORT,secure:config.SMTP_PORT===465,
    requireTLS:true,tls:{rejectUnauthorized:true,minVersion:'TLSv1.2'},auth:{user:config.SMTP_USER,pass:config.SMTP_PASSWORD},
    connectionTimeout:5000,greetingTimeout:5000,socketTimeout:10000});
  return {
    async email(message) {
      const input=email.parse(message);
      const result=await transport.sendMail({from:config.SMTP_FROM,to:input.to,subject:input.subject,text:input.text,disableFileAccess:true,disableUrlAccess:true});
      if(!result.accepted?.length)throw new Error('EMAIL_NOT_ACCEPTED');
    },
    async sms(message) {
      const input=sms.parse(message);
      const response=await send(`https://api.twilio.com/2010-04-01/Accounts/${config.TWILIO_ACCOUNT_SID}/Messages.json`,{
        method:'POST',redirect:'error',signal:AbortSignal.timeout(10000),
        headers:{authorization:`Basic ${Buffer.from(config.TWILIO_ACCOUNT_SID+':'+config.TWILIO_AUTH_TOKEN).toString('base64')}`,'content-type':'application/x-www-form-urlencoded'},
        body:new URLSearchParams({To:input.to,Body:input.text,MessagingServiceSid:config.TWILIO_MESSAGING_SERVICE_SID})});
      await response.body?.cancel();
      if(!response.ok)throw new Error('SMS_NOT_ACCEPTED');
    }
  };
}

export async function deliverOne(store:IdentityStore,key:string,delivery:Delivery) {
  // Single SQL lease works across workers; do not hold a connection during delivery.
  await store.query(`UPDATE identity.delivery_outbox SET payload=NULL,outcome='expired' WHERE outcome IS NULL AND expires_at<=now()`);
  const row=(await store.query<{id:string;kind:'email'|'sms';payload:string;attempts:number}>(`UPDATE identity.delivery_outbox SET locked_until=now()+interval '30 seconds',attempts=attempts+1
    WHERE id=(SELECT id FROM identity.delivery_outbox WHERE outcome IS NULL AND expires_at>now() AND available_at<=now()
      AND (locked_until IS NULL OR locked_until<now()) AND attempts<3 ORDER BY available_at,id FOR UPDATE SKIP LOCKED LIMIT 1)
    RETURNING id,kind,payload,attempts`)).rows[0];
  if(!row)return false;
  try {
    const input=JSON.parse(await symmetricDecrypt({key,data:row.payload}));
    if(row.kind==='email')await delivery.email(email.parse(input));else await delivery.sms(sms.parse(input));
    await store.query(`UPDATE identity.delivery_outbox SET payload=NULL,outcome='delivered',delivered_at=now(),locked_until=NULL WHERE id=$1`,[row.id]);
  } catch {
    await store.query(`UPDATE identity.delivery_outbox SET locked_until=NULL,available_at=now()+interval '20 seconds',
      outcome=CASE WHEN attempts>=3 THEN 'failed' ELSE NULL END,payload=CASE WHEN attempts>=3 THEN NULL ELSE payload END WHERE id=$1`,[row.id]);
  }
  return true;
}
