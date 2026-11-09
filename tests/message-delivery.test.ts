import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import nodemailer from 'nodemailer';
import { configuredOperationalDelivery,messageConnection,messageTransport,MessageDeliveryError } from '../src/integrations/message-delivery.ts';

const twilio={accountSid:'AC'+'a'.repeat(32),authToken:'synthetic-provider-token-not-real',messagingServiceSid:'MG'+'b'.repeat(32)};
const smtp={host:'smtp.example.test',port:465 as const,user:'synthetic',password:'synthetic-password',from:'academy@example.test'};
const message={to:'+16475550123',text:'Synthetic operational notice'},email={to:'parent@example.test',subject:'Academy update',text:'Synthetic operational notice'};
const receipt=()=>({sid:'SM'+'c'.repeat(32),account_sid:twilio.accountSid,messaging_service_sid:twilio.messagingServiceSid,to:message.to,status:'accepted',error_code:null});
const outcome=(value:string)=>((e:unknown)=>e instanceof MessageDeliveryError&&e.outcome===value);

test('message transport refuses a process-wide TLS certificate-validation bypass before any provider IO',()=>{
 const previous=process.env.NODE_TLS_REJECT_UNAUTHORIZED;try{process.env.NODE_TLS_REJECT_UNAUTHORIZED='0';assert.throws(()=>messageTransport({twilio}),e=>e instanceof MessageDeliveryError&&e.outcome==='not_attempted'&&e.message==='INSECURE_TRANSPORT_ENVIRONMENT');}finally{if(previous===undefined)delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;else process.env.NODE_TLS_REJECT_UNAUTHORIZED=previous;}
});

test('per-school operational connections are disabled by default and never borrow authentication secrets or another academy connection',()=>{
 const a=randomUUID(),b=randomUUID();assert.equal(configuredOperationalDelivery(a,{SMTP_PASSWORD:'not-an-operational-configuration',TWILIO_AUTH_TOKEN:twilio.authToken}),null);
 const env={OPERATIONAL_DELIVERY_ENABLED:'true',OPERATIONAL_DELIVERY_CONNECTIONS:JSON.stringify([{academyId:a,configuration:{twilio}}])};
 assert.deepEqual(configuredOperationalDelivery(a,env)?.channels,['sms']);assert.equal(configuredOperationalDelivery(b,env),null);
 for(const raw of ['[]','{}','not-json',JSON.stringify([{academyId:a,configuration:{}}]),JSON.stringify([{academyId:a,configuration:{twilio}},{academyId:a.toUpperCase(),configuration:{twilio}}]),JSON.stringify([{academyId:a,configuration:{twilio:{...twilio,endpoint:'https://attacker.example'}}}]),'x'.repeat(1048577)]){
  assert.throws(()=>configuredOperationalDelivery(a,{...env,OPERATIONAL_DELIVERY_CONNECTIONS:raw}),e=>e instanceof MessageDeliveryError&&e.outcome==='not_attempted'&&e.message==='OPERATIONAL_DELIVERY_NOT_CONFIGURED');
 }
 assert.throws(()=>messageConnection.parse({smtp:{...smtp,port:25}}));for(const configuration of [{smtp:{...smtp,rejectUnauthorized:false}},{smtp:{...smtp,host:'smtp.example.test\r\n'}}])assert.throws(()=>messageTransport(configuration));
});

test('SMS validates fixed endpoint exact original recipient account and service receipt;acceptance is never delivery confirmation',async()=>{
 let calls=0;const send:typeof fetch=async(url,options)=>{
  calls++;assert.equal(url,'https://api.twilio.com/2010-04-01/Accounts/'+twilio.accountSid+'/Messages.json');assert.equal(options?.redirect,'error');assert.ok(options?.signal);assert.equal(options?.method,'POST');assert.ok(options?.body instanceof URLSearchParams);assert.equal(options.body.get('To'),message.to);assert.equal(options.body.get('Body'),message.text);assert.equal(options.body.get('MessagingServiceSid'),twilio.messagingServiceSid);assert.equal(options.body.has('StatusCallback'),false);
  return Response.json(receipt(),{status:201});
 };
 const transport=messageTransport({twilio},send);assert.deepEqual(transport.channels,['sms']);assert.equal(calls,0,'construction must not send');
 assert.deepEqual(await transport.sms(message),{provider:'twilio',providerMessageId:receipt().sid,providerStatus:'accepted',providerAccepted:true,deliveryConfirmed:false});assert.equal(calls,1);
 for(const input of [{...message,to:'https://attacker.example'},{...message,text:'x'.repeat(1001)},{...message,providerUrl:'https://attacker.example'}])await assert.rejects(transport.sms(input));assert.equal(calls,1);
 await assert.rejects(transport.email(email),outcome('not_attempted'));assert.equal(calls,1);
});

test('uncertain SMS responses never become success and are not retried by the transport',async()=>{
 const replies=[()=>Response.json({},{status:201}),()=>Response.json({...receipt(),to:'+16475550999'},{status:201}),()=>Response.json({...receipt(),account_sid:'AC'+'f'.repeat(32)},{status:201}),()=>Response.json({...receipt(),messaging_service_sid:'MG'+'f'.repeat(32)},{status:201}),()=>Response.json({...receipt(),status:'failed',error_code:21610},{status:201}),()=>new Response('x'.repeat(65537),{status:201,headers:{'content-type':'application/json'}}),()=>new Response('invalid-json',{status:201,headers:{'content-type':'application/json'}}),()=>new Response('not-json',{status:201}),()=>new Response(null,{status:500}),()=>new Response(null,{status:408}),()=>new Response(null,{status:202})];
 for(const response of replies){let calls=0;const transport=messageTransport({twilio},async()=>{calls++;return response();});await assert.rejects(transport.sms(message),outcome('outcome_unknown'));assert.equal(calls,1);}
 let calls=0;const lost=messageTransport({twilio},async()=>{calls++;throw new Error('synthetic network failure containing '+twilio.authToken);});await assert.rejects(lost.sms(message),e=>outcome('outcome_unknown')(e)&&e instanceof Error&&!e.message.includes(twilio.authToken));assert.equal(calls,1);
 for(const status of [400,401,403,429])await assert.rejects(messageTransport({twilio},async()=>new Response(null,{status})).sms(message),outcome('rejected'));
});

test('SMTP uses existing Nodemailer with mandatory TLS no attachments or remote resources;injected acceptance is not delivery proof',async t=>{
 let calls=0;const created:unknown[]=[],messages:unknown[]=[];
 t.mock.method(nodemailer,'createTransport',(options:unknown)=>{created.push(options);return {async sendMail(input:unknown){calls++;messages.push(input);return {accepted:[email.to],rejected:[],messageId:'<synthetic@example.test>'};}};});
 const transport=messageTransport({smtp});assert.deepEqual(transport.channels,['email']);assert.equal(calls,0);assert.deepEqual(created,[{host:smtp.host,port:465,secure:true,requireTLS:true,tls:{rejectUnauthorized:true,minVersion:'TLSv1.2'},auth:{user:smtp.user,pass:smtp.password},connectionTimeout:5000,greetingTimeout:5000,socketTimeout:10000,disableFileAccess:true,disableUrlAccess:true}]);
 assert.deepEqual(await transport.email(email),{provider:'smtp',providerMessageId:'<synthetic@example.test>',providerStatus:'accepted',providerAccepted:true,deliveryConfirmed:false});assert.deepEqual(messages,[{from:smtp.from,...email,disableFileAccess:true,disableUrlAccess:true}]);
 const injectedAttachment={...email,attachments:[{path:'/etc/passwd'}]};await assert.rejects(transport.email({...email,expiresAt:'2000-01-01T00:00:00Z'}),outcome('not_attempted'));await assert.rejects(transport.email({...email,subject:'Header\r\nBcc: victim@example.test'}));await assert.rejects(transport.email(injectedAttachment));assert.equal(calls,1);
 await assert.rejects(transport.sms(message),outcome('not_attempted'));messageTransport({smtp:{...smtp,port:587}});assert.equal((created[1] as {secure:boolean}).secure,false);
});

test('SMTP rejects unclear acceptance and sanitizes provider failures without internal retry',async t=>{
 let calls=0;let value:unknown={accepted:['someone-else@example.test'],rejected:[],messageId:'<wrong@example.test>'};
 t.mock.method(nodemailer,'createTransport',()=>({async sendMail(){calls++;if(value instanceof Error)throw value;return value;}}));
 const transport=messageTransport({smtp});for(const result of [value,{accepted:[email.to],rejected:[email.to],messageId:'<rejected@example.test>'},{accepted:[email.to],rejected:[]},new Error('private '+smtp.password)]){value=result;await assert.rejects(transport.email(email),e=>outcome('outcome_unknown')(e)&&e instanceof Error&&!e.message.includes(smtp.password));}assert.equal(calls,4);
});
