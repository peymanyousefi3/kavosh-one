import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { notificationFixture } from './notification-fixture.ts';
import { processOneMessage,type MessageTransport } from '../src/automations/message-worker.ts';
import { MessageDeliveryError } from '../src/integrations/message-delivery.ts';
import { assertRuntimeRole,type Database } from '../src/core/database.ts';
import { upgradeToCurrent } from './migration-upgrade.ts';
import { sessionNotificationFixture } from './session-notification-fixture.ts';
import { processOneSubscription } from '../src/automations/subscription-worker.ts';
import { processOneNotification } from '../src/automations/notification-worker.ts';
import { Temporal } from '@js-temporal/polyfill';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const root='me/notification-deliveries';
async function fixture(options:{throughSchema?:number}={}){
 const f=await notificationFixture(options),sent:{channel:string;to:string;subject?:string;text:string}[]=[];
 const transport:MessageTransport={channels:['email','sms'],async email(m){sent.push({channel:'email',...m});return {provider:'smtp',providerMessageId:'<synthetic-message@example.test>',providerStatus:'accepted',providerAccepted:true,deliveryConfirmed:false};},async sms(m){sent.push({channel:'sms',...m});return {provider:'twilio',providerMessageId:'SM'+'a'.repeat(32),providerStatus:'accepted',providerAccepted:true,deliveryConfirmed:false};}};
 const database:Database={async connect(){const c=f.pg.runtime?await f.pg.runtime.connect():{query:f.pg.query.bind(f.pg),release(){}};await c.query('SET ROLE kavosh_message_worker');return c;}};
 async function work(t:MessageTransport|null=transport,academies=[f.a],signal?:AbortSignal){try{return await processOneMessage(database,academies,a=>a===f.a?t:null,signal);}finally{if(!f.pg.runtime)await f.pg.exec('RESET ROLE');}}
 async function optIn(as='staff',channels=['email','sms'],locale='fr'){const old=await f.request('me/notification-preferences',undefined,as),r=await f.request('me/notification-preferences',{expectedVersion:old.body.data.version,emailEnabled:channels.includes('email'),smsEnabled:channels.includes('sms'),locale,acknowledgedNoticeVersion:1},as);assert.ok([200,201].includes(r.response.status),JSON.stringify(r.body));return r;}
 async function queue(channels=['email','sms'],code='OUTBOUND'){
  const r=await f.rule({actions:[{...f.definition.actions[0],channels,body:{en:'English update',fr:'Mise à jour', 'zh-CN':'通知'}}],execution:{...f.definition.execution,maxDailySms:100}},code),event=await f.source(),result=await f.dispatch(r.id,event.id);assert.equal(result.response.status,201,JSON.stringify(result.body));return {rule:r,event,result};
 }
 return {...f,sent,transport,database,work,optIn,queue};
}
type F=Awaited<ReturnType<typeof fixture>>;
function check(name:string,run:(f:F)=>Promise<void>){test(name,async()=>{const f=await fixture();try{await run(f);}finally{await f.pg.close();}});}
function noSecrets(v:unknown){assert.doesNotMatch(JSON.stringify(v),/example[.]test|[+]1647|owner_epoch|contact_epoch|lease_token|provider_id|auth_user_id|Mise à jour/);}

check('external-only approved rules queue opted-in current recipients without inventing portal messages or provider acceptance',async f=>{
 await f.optIn();const q=await f.queue();assert.equal(q.result.body.data.summary.outboundQueued,2);assert.equal(q.result.body.data.summary.portalNotifications,0);assert.equal(q.result.body.data.summary.externalChannelSuppressed,2);assert.equal(q.result.body.data.externalRequestMade,false);assert.equal(f.sent.length,0);
 assert.equal((await f.pg.query("SELECT * FROM public.portal_notifications WHERE origin='automation'")).rows.length,0);
 const jobs=(await f.pg.query<{id:string;locale:string;body:string}>('SELECT id,locale,body FROM public.notification_deliveries ORDER BY id')).rows;assert.equal(jobs.length,2);assert.ok(jobs.every(r=>r.locale==='fr'&&r.body==='Mise à jour'));
 assert.ok((await f.pg.query<{same:boolean}>('SELECT d.created_at=r.created_at same FROM public.notification_deliveries d JOIN public.automation_runs r ON r.academy_id=d.academy_id AND r.id=d.run_id')).rows.every(r=>r.same),'all channels must reserve against the same native transaction UTC day');
 const replay=await f.dispatch(q.rule.id,q.event.id);assert.equal(replay.body.data.duplicate,true);assert.equal((await f.pg.query('SELECT * FROM public.notification_deliveries')).rows.length,2);
 const one=await f.request(root+'?limit=1',undefined,'staff');assert.equal(one.response.status,200,JSON.stringify(one.body));assert.equal(one.body.data.length,1);assert.ok(one.body.nextCursor);noSecrets(one.body);
 const next=await f.request(root+'?limit=1&after='+one.body.nextCursor,undefined,'staff');assert.equal(next.body.data.length,1);assert.notEqual(next.body.data[0].id,one.body.data[0].id);assert.equal(next.body.nextCursor,null);
 assert.equal((await f.request(root,undefined,'manager')).body.data.length,0);assert.equal((await f.request(root+'/'+jobs[0].id,undefined,'master')).response.status,404);
 for(let i=0;i<2;i++){const r=await f.work();assert.equal(r.claimed,true);assert.equal(r.recorded,true,JSON.stringify(r));assert.equal(r.outcome,'accepted');}
 assert.equal((await f.work()).claimed,false);assert.equal(f.sent.length,2);assert.ok(f.sent.every(r=>r.text.includes('Mise à jour')));
 for(const job of jobs){const detail=await f.request(root+'/'+job.id,undefined,'staff');assert.equal(detail.body.data.status,'accepted');assert.equal(detail.body.deliveryConfirmed,false);noSecrets(detail.body);const history=await f.request(root+'/'+job.id+'/history',undefined,'staff');assert.deepEqual(history.body.data.map((r:{state:{status:string}})=>r.state.status),['accepted','sending','preparing','queued']);noSecrets(history.body);}
});

check('worker does not release a pooled connection until its final result transaction actually finishes',async f=>{
 await f.optIn('staff',['email']);await f.queue(['email']);const connect=f.database.connect.bind(f.database);let pending=0,lastFinished='',releases=0;
 f.database.connect=async()=>{const connection=await connect();return {async query<Row>(sql:string,params?:unknown[]){pending++;try{return await connection.query<Row>(sql,params);}finally{pending--;lastFinished=sql;}},release(destroy?:boolean){assert.equal(pending,0,'A pending database operation must never continue on a returned pool client');assert.equal(lastFinished,'COMMIT');releases++;connection.release(destroy);}};};
 const r=await f.work();assert.equal(r.outcome,'accepted');assert.equal(r.recorded,true);assert.equal(releases,1);assert.equal(f.sent.length,1);
});

check('no choice means no outbound queue;withdrawal cancels pending and leased jobs without disabling mandatory portal notices',async f=>{
 const off=await f.queue(['portal','email','sms']);assert.equal(off.result.body.data.summary.outboundQueued,0);assert.equal(off.result.body.data.summary.externalChannelSuppressed,4);assert.equal(off.result.body.data.summary.portalNotifications,2);assert.equal((await f.work()).claimed,false);
 await f.optIn();await f.queue(['email','sms'],'OPTED');const before=(await f.pg.query('SELECT id FROM public.portal_notifications ORDER BY id')).rows;
 await f.pg.exec('BEGIN');try{await f.pg.exec('SET LOCAL ROLE kavosh_message_worker');const lease=await f.pg.query('SELECT * FROM public.claim_notification_delivery($1::jsonb)',[JSON.stringify([{academy_id:f.a,channels:['email','sms']}])]);assert.equal(lease.rows.length,1);await f.pg.exec('COMMIT');}catch(e){await f.pg.exec('ROLLBACK');throw e;}
 const disable=await f.request('me/notification-preferences/disable',{expectedVersion:1},'staff');assert.equal(disable.response.status,200,JSON.stringify(disable.body));assert.ok((await f.pg.query<{status:string}>('SELECT status FROM public.notification_deliveries')).rows.every(r=>r.status==='cancelled'));
 assert.equal((await f.work()).claimed,false);assert.equal(f.sent.length,0);assert.deepEqual((await f.pg.query('SELECT id FROM public.portal_notifications ORDER BY id')).rows,before);
});

check('disabling SMS preserves waiting email;later re-enabling SMS cannot resurrect an old cancelled message',async f=>{
 await f.optIn();await f.queue();const change=await f.request('me/notification-preferences',{expectedVersion:1,emailEnabled:true,smsEnabled:false,locale:'zh-CN',acknowledgedNoticeVersion:1},'staff');assert.equal(change.response.status,200);
 assert.deepEqual((await f.pg.query<{channel:string;status:string}>('SELECT channel,status FROM public.notification_deliveries ORDER BY channel')).rows,[{channel:'email',status:'queued'},{channel:'sms',status:'cancelled'}]);
 assert.equal((await f.work()).outcome,'accepted');assert.equal(f.sent.length,1);assert.equal(f.sent[0].channel,'email');assert.equal(f.sent[0].text,'Mise à jour','existing messages retain their original authored locale;new preferences apply to new messages');
 await f.optIn('staff',['email','sms'],'en');assert.equal((await f.work()).claimed,false);assert.equal(f.sent.length,1);
});

check('suppressed pending-message cancellation rolls back opt-out instead of falsely claiming success',async f=>{
 await f.optIn();await f.queue();await f.pg.exec("CREATE FUNCTION public.suppress_cancel_test() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN IF NEW.status='cancelled' THEN RETURN NULL;END IF;RETURN NEW;END$$;CREATE TRIGGER suppress_cancel_test BEFORE UPDATE ON public.notification_deliveries FOR EACH ROW EXECUTE FUNCTION public.suppress_cancel_test()");
 const key=randomUUID();assert.equal((await f.request('me/notification-preferences/disable',{expectedVersion:1},'staff',{key})).response.status,503);assert.equal((await f.request('me/notification-preferences',undefined,'staff')).body.data.version,1);assert.equal((await f.request('me/notification-preferences',undefined,'staff')).body.data.sms.enabled,true);
 await f.pg.exec('DROP TRIGGER suppress_cancel_test ON public.notification_deliveries;DROP FUNCTION public.suppress_cancel_test()');assert.equal((await f.request('me/notification-preferences/disable',{expectedVersion:1},'staff',{key})).response.status,200);assert.equal((await f.work()).claimed,false);assert.equal(f.sent.length,0);
});

check('contact replacement cancels the affected queued channel before any provider call;unconfigured school or channel is never silently claimed',async f=>{
 await f.optIn();await f.queue();assert.equal((await f.work(null)).claimed,false);assert.equal((await f.work(f.transport,[f.b])).claimed,false);
 const emailOnly={...f.transport,channels:['email' as const]};assert.equal((await f.work(emailOnly)).outcome,'accepted');assert.equal((await f.work(emailOnly)).claimed,false);assert.equal((await f.pg.query("SELECT status FROM public.notification_deliveries WHERE channel='sms'")).rows[0].status,'queued');
 await f.pg.query('UPDATE identity."user" SET "phoneNumber"=$2 WHERE id=$1',[f.actors.staff.user,'+16479990089']);
 assert.equal((await f.work()).outcome,'cancelled');assert.equal(f.sent.length,1);assert.equal(f.sent[0].channel,'email');assert.deepEqual((await f.pg.query<{channel:string;status:string}>('SELECT channel,status FROM public.notification_deliveries ORDER BY channel')).rows,[{channel:'email',status:'accepted'},{channel:'sms',status:'cancelled'}]);
});

check('current source access rule state case version and active person are checked again without producer or master impersonation',async f=>{
 await f.optIn('staff',['email']);await f.queue(['email']);await f.pg.query("DELETE FROM public.role_permissions WHERE role_id=$1 AND capability='automations.view'",[f.staffRole]);
 assert.equal((await f.request(root,undefined,'staff')).body.data.length,0);assert.equal((await f.work()).outcome,'cancelled');assert.equal(f.sent.length,0);
 await f.pg.query("INSERT INTO public.role_permissions VALUES($1,$2,'automations.view','allow')",[f.a,f.staffRole]);const second=await f.queue(['email'],'STALE_CASE');
 const source=(await f.pg.query<{approval_id:string}>('SELECT approval_id FROM public.automation_event_sources WHERE event_id=$1',[second.event.id])).rows[0];assert.ok(source.approval_id);assert.equal((await f.approve(source.approval_id)).response.status,200);assert.equal((await f.work()).outcome,'cancelled');assert.equal(f.sent.length,0);
 const changed=await f.queue(['email'],'CHANGED_RULE');assert.equal((await f.request('automations/rules/'+changed.rule.id+'/change',{expectedVersion:1,definition:{...f.definition,enabled:false},reason:'Stop queued automatic notices'})).response.status,200);assert.equal((await f.work()).outcome,'cancelled');assert.equal(f.sent.length,0);
 await f.queue(['email'],'DISABLED_PERSON');await f.pg.query("UPDATE public.people SET status='disabled' WHERE id=$1",[f.actors.staff.person]);assert.equal((await f.work()).outcome,'cancelled');assert.equal(f.sent.length,0);
});

check('outbound notifications never borrow a bot producer authority for a human recipient',async f=>{
 await f.optIn('staff',['email']);await f.optIn('manager',['email']);const rule=await f.rule({actions:[{...f.definition.actions[0],channels:['email']}]},'BOT_OUTBOUND');
 const p=await f.request('automations/rules',{hubId:f.hub,code:'BOT_SOURCE',definition:f.definition,reason:'Scoped bot proposal'},'bot');assert.equal(p.response.status,202);const event=(await f.pg.query<{event_id:string}>('SELECT event_id FROM public.automation_event_sources WHERE approval_id=$1',[p.body.approval.id])).rows[0];
 const queued=await f.dispatch(rule.id,event.event_id,'bot');assert.equal(queued.response.status,201);assert.equal(queued.body.data.summary.outboundQueued,1);assert.equal((await f.work()).outcome,'accepted');assert.equal(f.sent.length,1);assert.equal(f.sent[0].to,'manager@example.test');assert.equal((await f.request(root,undefined,'staff')).body.data.length,0);
});

check('expanded subjects and long multilingual SMS remain bounded without broken Unicode or silent email body loss',async f=>{
 await f.optIn('staff',['email','sms'],'en');const body='😀'.repeat(1000),rule=await f.rule({actions:[{...f.definition.actions[0],channels:['email','sms'],title:{en:'{{entityId}}'.repeat(15)},body:{en:body}}],execution:{...f.definition.execution,maxDailySms:100}},'UNICODE');
 assert.equal((await f.dispatch(rule.id,(await f.source()).id)).body.data.summary.outboundQueued,2);await f.work();await f.work();assert.equal(f.sent.length,2);const mail=f.sent.find(r=>r.channel==='email')!,sms=f.sent.find(r=>r.channel==='sms')!;assert.equal(mail.text,body);assert.equal(mail.subject?.length,200);assert.equal(mail.subject?.endsWith('…'),true);assert.ok(sms.text.length<=1000);assert.ok(sms.text.isWellFormed());assert.ok(sms.text.endsWith('…'));
});

check('a failed post-send history commit stays uncertain and is not overwritten or blindly sent again',async f=>{
 await f.optIn('staff',['email']);await f.queue(['email']);await f.pg.exec('CREATE FUNCTION public.suppress_delivery_finish_test() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN IF NEW.version>=4 THEN RETURN NULL;END IF;RETURN NEW;END$$;CREATE TRIGGER suppress_delivery_finish_test BEFORE INSERT ON public.notification_delivery_revisions FOR EACH ROW EXECUTE FUNCTION public.suppress_delivery_finish_test()');
 await assert.rejects(f.work(),/NOTIFICATION_DELIVERY_HISTORY_REQUIRED/);assert.equal(f.sent.length,1);assert.equal((await f.pg.query('SELECT status FROM public.notification_deliveries')).rows[0].status,'sending');
 await f.pg.exec('DROP TRIGGER suppress_delivery_finish_test ON public.notification_delivery_revisions;DROP FUNCTION public.suppress_delivery_finish_test()');assert.equal((await f.work()).claimed,false);assert.equal(f.sent.length,1);
 const job=(await f.pg.query<{id:string;lease_token:string}>('SELECT id,lease_token FROM public.notification_deliveries')).rows[0];await f.pg.exec('BEGIN');try{await f.pg.query("SELECT set_config('app.academy_id',$1,true)",[f.a]);await f.pg.exec('SET LOCAL ROLE kavosh_message_worker');assert.equal((await f.pg.query<{ok:boolean}>('SELECT public.finish_notification_delivery($1,$2,\'unknown\',NULL,\'SEND_OUTCOME_UNKNOWN\') ok',[job.id,job.lease_token])).rows[0].ok,true);assert.equal((await f.pg.query<{ok:boolean}>('SELECT public.finish_notification_delivery($1,$2,\'accepted\',\'<late-synthetic@example.test>\',NULL) ok',[job.id,job.lease_token])).rows[0].ok,false);await f.pg.exec('COMMIT');}catch(e){await f.pg.exec('ROLLBACK');throw e;}
 assert.equal((await f.work()).claimed,false);assert.equal(f.sent.length,1);assert.equal((await f.pg.query('SELECT status FROM public.notification_deliveries')).rows[0].status,'unknown');
});

test('actual class reminder reaches the outbound queue but a later class cancellation prevents sending',async()=>{
 const f=await sessionNotificationFixture('session_guardians');try{
  const start=Temporal.Now.zonedDateTimeISO('America/Toronto').add({minutes:4}).with({second:0,millisecond:0,microsecond:0,nanosecond:0}),end=start.add({hours:1}),local=(v:typeof start)=>v.toPlainDateTime().toString({smallestUnit:'minute'});
  assert.equal((await f.changeSession(1,{kind:'reschedule',start:local(start),end:local(end)})).response.status,200);
  assert.equal((await f.request('me/notification-preferences',{expectedVersion:0,emailEnabled:true,smsEnabled:false,locale:'en',acknowledgedNoticeVersion:1},'staff')).response.status,201);
  const definition={...f.rule.definition,trigger:{kind:'domain_event',eventTypes:['session.reminder_due']},sessionReminder:{minutesBefore:4,maxDelayMinutes:2},actions:f.rule.definition.actions.map((a:Record<string,unknown>)=>({...a,channels:['email']}))};
  assert.equal((await f.request('automations/rules/'+f.rule.id+'/change',{expectedVersion:1,definition,reason:'Parent email reminder'})).response.status,200);
  assert.equal((await f.request('automations/rules/'+f.rule.id+'/subscriptions',{expectedVersion:2,reason:'Reviewed real class timer'})).response.status,201);
  const db=(role:string):Database=>({async connect(){const c=f.pg.runtime?await f.pg.runtime.connect():{query:f.pg.query.bind(f.pg),release(){}};await c.query('SET ROLE '+role);return c;}});
  try{assert.equal((await processOneSubscription(db('kavosh_automation_worker'),[f.a])).outcome,'queued');}finally{if(!f.pg.runtime)await f.pg.exec('RESET ROLE');}
  try{assert.equal((await processOneNotification(db('kavosh_automation_worker'),[f.a])).outcome,'succeeded');}finally{if(!f.pg.runtime)await f.pg.exec('RESET ROLE');}
  assert.equal((await f.pg.query('SELECT * FROM public.notification_deliveries')).rows.length,1);assert.equal((await f.changeSession(2,{kind:'cancel'})).response.status,200);let sends=0;
  const transport:MessageTransport={channels:['email'],async email(){sends++;return {provider:'smtp',providerMessageId:'<synthetic@example.test>',providerStatus:'accepted',providerAccepted:true,deliveryConfirmed:false};},async sms(){throw new Error('SMS_NOT_CONFIGURED');}};
  try{assert.equal((await processOneMessage(db('kavosh_message_worker'),[f.a],()=>transport)).outcome,'cancelled');}finally{if(!f.pg.runtime)await f.pg.exec('RESET ROLE');}assert.equal(sends,0);
 }finally{await f.pg.close();}
});

check('uncertain or rejected sends are terminal distinct from acceptance and no later worker blindly repeats them',async f=>{
 await f.optIn('staff',['sms']);await f.queue(['sms']);let calls=0;
 const uncertain={...f.transport,channels:['sms' as const],async sms(){calls++;throw new MessageDeliveryError('outcome_unknown','SYNTHETIC_RESPONSE_LOST');}};
 assert.equal((await f.work(uncertain)).outcome,'unknown');assert.equal((await f.work(uncertain)).claimed,false);assert.equal(calls,1);
 await f.queue(['sms'],'REJECTED');const rejected={...f.transport,channels:['sms' as const],async sms(){calls++;throw new MessageDeliveryError('rejected','SYNTHETIC_HTTP_REJECTION');}};assert.equal((await f.work(rejected)).outcome,'failed');assert.equal((await f.work(rejected)).claimed,false);assert.equal(calls,2);
 assert.deepEqual((await f.pg.query<{status:string}>('SELECT status FROM public.notification_deliveries ORDER BY status')).rows.map(r=>r.status),['failed','unknown']);
});

check('withdrawal during a provider handoff cancels other waiting channels but never pretends to recall the in-flight message',async f=>{
 await f.optIn();await f.queue();let calls=0;
 const transport={...f.transport,channels:['email' as const],async email(){calls++;const withdrawal=await f.request('me/notification-preferences/disable',{expectedVersion:1},'staff');assert.equal(withdrawal.response.status,200);assert.equal(withdrawal.body.alreadyInFlightMessagesMayStillArrive,true);return {provider:'smtp' as const,providerMessageId:'<inflight-synthetic@example.test>',providerStatus:'accepted',providerAccepted:true as const,deliveryConfirmed:false as const};}};
 assert.equal((await f.work(transport)).outcome,'accepted');assert.equal(calls,1);assert.equal((await f.work()).claimed,false);assert.deepEqual((await f.pg.query<{channel:string;status:string}>('SELECT channel,status FROM public.notification_deliveries ORDER BY channel')).rows,[{channel:'email',status:'accepted'},{channel:'sms',status:'cancelled'}]);assert.equal((await f.request('me/notification-preferences',undefined,'staff')).body.data.email.enabled,false);
});

check('rule delivery and SMS budgets count all reserved channels and cooldown includes external-only queued intents',async f=>{
 await f.optIn('staff',['email','sms']);
 const limited=await f.rule({actions:[{...f.definition.actions[0],channels:['email','sms']}],execution:{...f.definition.execution,maxDailyDeliveries:1,maxDailySms:100}},'LIMITED'),event=await f.source();let r=await f.dispatch(limited.id,event.id);assert.equal(r.body.data.outcome,'daily_limit');assert.equal(r.body.data.summary.outboundQueued,0);
 const noSms=await f.rule({actions:[{...f.definition.actions[0],channels:['sms']}],execution:{...f.definition.execution,maxDailySms:0}},'NO_SMS');r=await f.dispatch(noSms.id,event.id);assert.equal(r.body.data.outcome,'daily_limit');assert.equal(r.body.data.summary.outboundQueued,0);
 const cooldown=await f.rule({actions:[{...f.definition.actions[0],channels:['email']}],execution:{...f.definition.execution,cooldownSeconds:3600}},'COOL_OUTBOUND');assert.equal((await f.dispatch(cooldown.id,event.id)).body.data.summary.outboundQueued,1);const next=await f.source();assert.equal((await f.dispatch(cooldown.id,next.id)).body.data.summary.outboundQueued,0);
});

test('native commit budget rejects an incorrectly planned extra send independently of the application counter',{skip:!process.env.TEST_DATABASE_URL},async()=>{
 const f=await fixture();try{
  await f.optIn('staff',['email']);const rule=await f.rule({actions:[{...f.definition.actions[0],channels:['email']}],execution:{...f.definition.execution,maxDailyDeliveries:1}},'NATIVE_BUDGET');assert.equal((await f.dispatch(rule.id,(await f.source()).id)).body.data.summary.outboundQueued,1);
  const pool=f.pg.runtime!,connect=pool.connect.bind(pool),commitErrors:string[]=[];let substituted=0;
  // Deliberately wrong planning ONLY at this disposable client's read boundary.
  // Production SQL guard,locks,rows and deferred commit checks stay untouched.
  pool.connect=async()=>{const c=await connect();return {async query<Row>(sql:string,params?:unknown[]){try{if(sql.startsWith('WITH deliveries AS(')){substituted++;return await c.query<Row>('SELECT 0::integer n,0::integer sms');}return await c.query<Row>(sql,params);}catch(e){if(sql==='COMMIT'&&e instanceof Error)commitErrors.push(e.message);throw e;}},release(destroy?:boolean){c.release(destroy);}};};
  const r=await f.dispatch(rule.id,(await f.source()).id);assert.equal(substituted,1);assert.equal(r.response.status,503);assert.deepEqual(commitErrors,['NOTIFICATION_OUTBOUND_BUDGET_EXCEEDED']);assert.equal((await f.pg.query('SELECT * FROM public.notification_deliveries')).rows.length,1);assert.equal((await f.pg.query('SELECT * FROM public.automation_runs WHERE rule_id=$1',[rule.id])).rows.length,1);
  const body=(await f.pg.query<{definition:string}>("SELECT pg_get_functiondef('public.require_outbound_notification_run()'::regprocedure) definition")).rows[0].definition,formula=body.match(/day_start=([^;]+);/)![1].replace('NEW.created_at',()=>'$1::timestamptz'),duration=body.match(/created_at<day_start\+interval '([^']+)'/)![1];assert.equal(duration,'24 hours');
  await f.pg.exec("BEGIN;SET LOCAL TIME ZONE 'America/Toronto'");try{for(const day of ['2026-03-08T12:00:00Z','2026-11-01T12:00:00Z'])assert.equal(Number((await f.pg.query<{seconds:string}>('SELECT extract(epoch FROM(('+formula+')+$2::interval-('+formula+')))::text seconds',[day,duration])).rows[0].seconds),86400,'Actual native guard UTC-day expression must not grow/shrink across Toronto DST');}finally{await f.pg.exec('ROLLBACK');}
 }finally{await f.pg.close();}
});

check('queue/history/audit/outbox suppression rolls back dispatch and permits recovery with the exact request key',async f=>{
 await f.optIn('staff',['email']);const rule=await f.rule({actions:[{...f.definition.actions[0],channels:['email']}]},'ATOMIC');
 for(const table of ['notification_deliveries','notification_delivery_revisions','audit_events','outbox_events']){
  const event=await f.source(),before=(await f.pg.query('SELECT id FROM public.notification_deliveries ORDER BY id')).rows,key=randomUUID();
  await f.pg.exec('CREATE FUNCTION public.suppress_outbound_test() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RETURN NULL;END$$;CREATE TRIGGER suppress_outbound_test BEFORE INSERT ON public.'+table+' FOR EACH ROW EXECUTE FUNCTION public.suppress_outbound_test()');
  const r=await f.dispatch(rule.id,event.id,'master',key);assert.equal(r.response.status,503,table+JSON.stringify(r.body));assert.deepEqual((await f.pg.query('SELECT id FROM public.notification_deliveries ORDER BY id')).rows,before);
  await f.pg.exec('DROP TRIGGER suppress_outbound_test ON public.'+table+';DROP FUNCTION public.suppress_outbound_test()');assert.equal((await f.dispatch(rule.id,event.id,'master',key)).response.status,201);
 }
});

check('message service roles cannot impersonate web or reminder workers;API metadata remains human-only strict and tenant-bound',async f=>{
 await f.optIn('staff',['email']);await f.queue(['email']);const job=(await f.pg.query<{id:string}>('SELECT id FROM public.notification_deliveries')).rows[0];
 for(const suffix of ['', '/'+job.id,'/'+job.id+'/history'])assert.equal((await f.request(root+suffix,undefined,'bot')).response.status,403);
 for(const q of ['limit=51','limit=1&limit=2','status=delivered','personId='+f.actors.master.person,'after=invalid'])assert.equal((await f.request(root+'?'+q,undefined,'staff')).response.status,400);
 assert.equal((await f.request(root,{},'staff')).response.status,405);assert.equal((await f.request(root+'/'+job.id,undefined,'foreignMaster',{academy:f.b})).response.status,404);
 assert.equal((await f.request(root+'/'+job.id+'/history?beforeVersion=2147483648',undefined,'staff')).response.status,400);
 for(const role of ['kavosh_runtime','kavosh_automation_worker','kavosh_message_worker']){
  await f.pg.exec('BEGIN');try{await f.pg.query("SELECT set_config('app.academy_id',$1,true)",[f.a]);await f.pg.exec('SET LOCAL ROLE '+role);
   if(role==='kavosh_message_worker'){const c={query:f.pg.query.bind(f.pg),release(){}};await assert.rejects(assertRuntimeRole(c));await assert.rejects(assertRuntimeRole(c,'automation_worker'));await assertRuntimeRole(c,'message_worker');}
   for(const sql of ['SELECT * FROM identity."user"','SELECT * FROM identity.contact_change_events','SELECT lease_token,lease_until,provider_id FROM public.notification_deliveries','UPDATE public.notification_deliveries SET status=\'accepted\'','DELETE FROM public.notification_delivery_revisions']){await f.pg.exec('SAVEPOINT private');await assert.rejects(f.pg.exec(sql));await f.pg.exec('ROLLBACK TO SAVEPOINT private');}
   if(role!=='kavosh_message_worker'){await f.pg.exec('SAVEPOINT claim');await assert.rejects(f.pg.query('SELECT * FROM public.claim_notification_delivery($1::jsonb)',[JSON.stringify([{academy_id:f.a,channels:['email']}])]),/permission denied/);await f.pg.exec('ROLLBACK TO SAVEPOINT claim');}
  }finally{await f.pg.exec('ROLLBACK');}
 }
});

check('isolated sender has no inherited web authority or direct domain writes;column-only overgrants fail its startup gate',async f=>{
 await f.optIn('staff',['email']);await f.queue(['email']);
 await f.pg.exec('BEGIN');try{
  await f.pg.query("SELECT set_config('app.academy_id',$1,true)",[f.a]);await f.pg.exec('SET LOCAL ROLE kavosh_message_worker');
  assert.equal((await f.pg.query<{member:boolean}>("SELECT pg_has_role(current_user,'kavosh_runtime','member') member")).rows[0].member,false);
  const c={query:f.pg.query.bind(f.pg),release(){}};await assertRuntimeRole(c,'message_worker');
  for(const sql of [
   "UPDATE public.people SET name='Unapproved' WHERE false",'DELETE FROM public.role_assignments WHERE false',
   'UPDATE public.approval_requests SET version=version WHERE false','DELETE FROM public.finance_accounts WHERE false',
   'INSERT INTO public.notification_deliveries(academy_id,id) SELECT NULL,NULL WHERE false',
   'SELECT payload,credential_snapshot FROM public.approval_requests','SELECT title,body,owner_epoch,contact_epoch FROM public.notification_deliveries',
   'SELECT public.authenticate_bot(NULL)','SELECT public.revoke_bot(NULL)','SELECT public.lock_bot(NULL)',
   'SELECT * FROM public.claim_notification_job(NULL)','SELECT * FROM public.notification_delivery_revisions'
  ]){await f.pg.exec('SAVEPOINT denied');await assert.rejects(f.pg.exec(sql),/permission denied/);await f.pg.exec('ROLLBACK TO SAVEPOINT denied');}
  await f.pg.exec('RESET ROLE;GRANT UPDATE(name) ON public.people TO kavosh_message_worker;SET LOCAL ROLE kavosh_message_worker');
  await assert.rejects(assertRuntimeRole(c,'message_worker'),/UNSAFE_DATABASE_ROLE/);
  await f.pg.exec('RESET ROLE;REVOKE UPDATE(name) ON public.people FROM kavosh_message_worker;GRANT EXECUTE ON FUNCTION public.revoke_bot(uuid) TO kavosh_message_worker;SET LOCAL ROLE kavosh_message_worker');
  await assert.rejects(assertRuntimeRole(c,'message_worker'),/UNSAFE_DATABASE_ROLE/,'Private mutators must not bypass the table-write check through a direct function grant');
 }finally{await f.pg.exec('ROLLBACK');}
 assert.equal((await f.work()).outcome,'accepted');assert.equal(f.sent.length,1);
});

check('private source locking is fenced by the exact preparing lease and school without granting row-lock write authority',async f=>{
 await f.optIn('staff',['email']);await f.queue(['email']);
 const c=await f.database.connect();try{
  const lease=(await c.query<{id:string;lease_token:string}>('SELECT * FROM public.claim_notification_delivery($1::jsonb)',[JSON.stringify([{academy_id:f.a,channels:['email']}])])).rows[0];assert.ok(lease);
  await c.query('BEGIN');try{
   const lock=async(id=lease.id,token=lease.lease_token)=>(await c.query<{ok:boolean}>('SELECT public.lock_notification_delivery_source($1,$2) ok',[id,token])).rows[0].ok;
   assert.equal(await lock(),false);await c.query("SELECT set_config('app.academy_id',$1,true)",[f.b]);assert.equal(await lock(),false);
   await c.query("SELECT set_config('app.academy_id',$1,true)",[f.a]);assert.equal(await lock(randomUUID()),false);assert.equal(await lock(lease.id,randomUUID()),false);assert.equal(await lock(),true);
   if(f.pg.runtime){
    const source=(await c.query<{approval_id:string}>('SELECT s.approval_id FROM public.notification_deliveries d JOIN public.automation_event_sources s ON s.academy_id=d.academy_id AND s.event_id=d.event_id WHERE d.id=$1',[lease.id])).rows[0];
    const other=await f.pg.runtime.connect();try{await other.query('BEGIN');await other.query("SELECT set_config('app.academy_id',$1,true),set_config('lock_timeout','25ms',true)",[f.a]);
     await assert.rejects(other.query('SELECT id FROM public.approval_requests WHERE id=$1 FOR UPDATE',[source.approval_id]),(error:unknown)=>!!error&&typeof error==='object'&&'code'in error&&error.code==='55P03');
    }finally{await other.query('ROLLBACK');other.release();}
   }
   await c.query('SAVEPOINT row_lock');await assert.rejects(c.query('SELECT id FROM public.approval_requests FOR SHARE'),/permission denied/);await c.query('ROLLBACK TO SAVEPOINT row_lock');
   await c.query("SELECT public.finish_notification_delivery($1,$2,'cancelled',NULL,'TEST_CANCELLED')",[lease.id,lease.lease_token]);assert.equal(await lock(),false);
   await c.query('COMMIT');
  }catch(e){await c.query('ROLLBACK');throw e;}
 }finally{c.release();if(!f.pg.runtime)await f.pg.exec('RESET ROLE');}
 assert.equal(f.sent.length,0);assert.equal((await f.work()).claimed,false);
});

test('actual233to234 upgrade preserves queued jobs and immutable history while removing sender web privileges',async()=>{
 const f=await fixture({throughSchema:233});try{
  await f.optIn('staff',['email']);await f.queue(['email']);
  const tables=['notification_deliveries','notification_delivery_revisions','people','approval_requests','audit_events','outbox_events'];
  async function snapshot(){const rows=[];for(const t of tables)rows.push((await f.pg.query('SELECT to_jsonb(x) data FROM public.'+t+' x ORDER BY to_jsonb(x)::text')).rows);return rows;}
  const before=await snapshot();assert.equal((await f.pg.query<{inherited:boolean}>("SELECT pg_has_role('kavosh_message_worker','kavosh_runtime','member') inherited")).rows[0].inherited,true);
  await upgradeToCurrent(f.pg);assert.deepEqual(await snapshot(),before);
  assert.equal((await f.pg.query<{inherited:boolean}>("SELECT pg_has_role('kavosh_message_worker','kavosh_runtime','member') inherited")).rows[0].inherited,false);
  assert.equal((await f.work()).outcome,'accepted');assert.equal(f.sent.length,1);
 }finally{await f.pg.close();}
});

check('another verified account rebound to the person cannot inherit former private delivery history or contact permission',async f=>{
 await f.optIn('staff',['email']);await f.queue(['email']);const job=(await f.pg.query<{id:string}>('SELECT id FROM public.notification_deliveries')).rows[0],replacement=randomUUID(),session=randomUUID();
 await f.pg.query('INSERT INTO identity."user"(id,name,email,"emailVerified","phoneNumber","phoneNumberVerified","mfaRequired") VALUES($1,\'Synthetic replacement\',\'replacement-delivery@example.test\',true,\'+16479990189\',true,false)',[replacement]);
 await f.pg.query('UPDATE public.people SET auth_user_id=$2 WHERE id=$1',[f.actors.staff.person,replacement]);f.actors.staff.user=replacement;f.actors.staff.session=session;
 await f.pg.query('INSERT INTO identity.session(id,token,"userId","expiresAt","updatedAt","mfaVerified") VALUES($1,$2,$3,now()+interval \'1 day\',now(),true)',[session,'synthetic-replacement-session-'+randomUUID(),replacement]);
 assert.equal((await f.request(root,undefined,'staff')).body.data.length,0);assert.equal((await f.request(root+'/'+job.id,undefined,'staff')).response.status,404);assert.equal((await f.request(root+'/'+job.id+'/history',undefined,'staff')).response.status,404);assert.equal((await f.work()).outcome,'cancelled');assert.equal(f.sent.length,0);
});

test('two native delivery workers issue one external attempt for one job',{skip:!process.env.TEST_DATABASE_URL},async()=>{
 const f=await fixture();try{await f.optIn('staff',['email']);await f.queue(['email']);const start=performance.now(),r=await Promise.all([f.work(),f.work()]);assert.deepEqual(r.map(v=>v.claimed).sort(),[false,true]);assert.equal(f.sent.length,1);assert.equal((await f.pg.query("SELECT id FROM public.notification_deliveries WHERE status='accepted'")).rows.length,1);console.log('Two outbound workers finished in '+Math.ceil(performance.now()-start)+'ms;correctness only,not capacity/SLO.');}finally{await f.pg.close();}
});

test('native real send-lease expiry becomes unknown and an old sender cannot repeat or overwrite it',{skip:!process.env.TEST_DATABASE_URL,timeout:40000},async()=>{
 const f=await fixture();try{
  await f.optIn('staff',['email']);await f.queue(['email']);const c=await f.database.connect();let job:{id:string;lease_token:string};
  try{job=(await c.query<{id:string;lease_token:string}>('SELECT * FROM public.claim_notification_delivery($1::jsonb)',[JSON.stringify([{academy_id:f.a,channels:['email']}])])).rows[0];assert.ok(job);await c.query('BEGIN');await c.query("SELECT set_config('app.academy_id',$1,true)",[f.a]);assert.ok((await c.query<{v:unknown}>('SELECT public.begin_notification_delivery($1,$2) v',[job.id,job.lease_token])).rows[0].v);await c.query('COMMIT');}finally{c.release();}
  // Wait for the ACTUAL native deadline,not an assumed elapsed sleep. This
  // one30s protocol check is not a throughput/stress run or provider call.
  await f.pg.query('SELECT pg_sleep(greatest(0,extract(epoch FROM(lease_until-clock_timestamp())))+0.01) FROM public.notification_deliveries WHERE id=$1',[job.id]);
  assert.equal((await f.pg.query<{expired:boolean}>('SELECT clock_timestamp()>lease_until expired FROM public.notification_deliveries WHERE id=$1',[job.id])).rows[0].expired,true);
  assert.equal((await f.work()).claimed,false);assert.equal(f.sent.length,0);assert.equal((await f.pg.query('SELECT status FROM public.notification_deliveries WHERE id=$1',[job.id])).rows[0].status,'unknown');
  await f.pg.exec('BEGIN');try{await f.pg.query("SELECT set_config('app.academy_id',$1,true)",[f.a]);await f.pg.exec('SET LOCAL ROLE kavosh_message_worker');assert.equal((await f.pg.query<{ok:boolean}>('SELECT public.finish_notification_delivery($1,$2,\'accepted\',\'<stale@example.test>\',NULL) ok',[job.id,job.lease_token])).rows[0].ok,false);await f.pg.exec('COMMIT');}catch(e){await f.pg.exec('ROLLBACK');throw e;}
 }finally{await f.pg.close();}
});

test('actual isolated outbound daemon boots with only its own role,leaves unavailable channels queued and stops cleanly without provider IO',{skip:!process.env.TEST_DATABASE_URL,timeout:10000},async()=>{
 const f=await fixture();let child:ReturnType<typeof spawn>|undefined,login:string|undefined;try{
  await f.optIn('staff',['sms']);await f.queue(['sms']);const name=(await f.pg.query<{name:string}>('SELECT current_database() name')).rows[0].name;assert.match(name,/^kavosh_test_[a-f0-9]{32}$/);
  login='kavosh_msg_'+randomUUID().replaceAll('-','');const password='synthetic_'+randomUUID().replaceAll('-','');await f.pg.exec(`CREATE ROLE ${login} LOGIN NOSUPERUSER NOCREATEROLE NOCREATEDB NOREPLICATION NOBYPASSRLS PASSWORD '${password}';GRANT kavosh_message_worker TO ${login}`);
  const url=new URL(process.env.TEST_DATABASE_URL!);url.username=login;url.password=password;url.pathname='/'+name;url.searchParams.set('application_name',login);let output='';
  const command=process.env.MESSAGE_WORKER_COMPILED_ENTRY?[process.env.MESSAGE_WORKER_COMPILED_ENTRY]:['--import','tsx','scripts/process-messages.ts'];
  child=spawn(process.execPath,command,{cwd:process.cwd(),env:{PATH:process.env.PATH,NODE_ENV:'test',DATABASE_SSL_MODE:'disable',NOTIFICATION_OUTBOUND_WORKER_ENABLED:'true',NOTIFICATION_OUTBOUND_DATABASE_URL:url.href,NOTIFICATION_OUTBOUND_ACADEMIES:JSON.stringify([f.a]),OPERATIONAL_DELIVERY_ENABLED:'true',OPERATIONAL_DELIVERY_CONNECTIONS:JSON.stringify([{academyId:f.a,configuration:{smtp:{host:'smtp.example.test',port:465,user:'synthetic',password:'synthetic',from:'sender@example.test'}}}])},stdio:['ignore','ignore','pipe']});child.stderr?.on('data',d=>{output+=String(d).slice(0,2000);});
  let seen=false;for(let i=0;i<80;i++){seen=(await f.pg.query('SELECT 1 FROM pg_stat_activity WHERE usename=$1 AND application_name=$1 AND datname=$2 AND query LIKE $3',[login,name,'%claim_notification_delivery%'])).rows.length>0;if(seen||child.exitCode!==null)break;await delay(25);}assert.equal(seen,true,'Daemon did not reach its actual native lease query: '+output);assert.equal((await f.pg.query('SELECT status FROM public.notification_deliveries')).rows[0].status,'queued');
  const ended=new Promise<number|null>(resolve=>child!.once('exit',resolve));child.kill('SIGTERM');assert.equal(await Promise.race([ended,delay(2000,undefined,{ref:false}).then(()=>-1)]),0);assert.equal(f.sent.length,0);assert.doesNotMatch(output,/postgresql:|synthetic_|smtp[.]example|password|token_hash/);
 }finally{if(child&&child.exitCode===null){const ended=new Promise(resolve=>child!.once('exit',resolve));child.kill('SIGKILL');await ended;}if(login)await f.pg.exec('DROP ROLE '+login);await f.pg.close();}
});

test('actual232to233 upgrade preserves old preference and notification history without inventing queued sends',async()=>{
 const f=await fixture({throughSchema:232});try{await f.optIn();const tables=['public.people','public.notification_preferences','public.notification_preference_revisions','public.portal_notifications','public.audit_events','public.outbox_events'];async function snapshot(){const r=[];for(const table of tables)r.push((await f.pg.query('SELECT to_jsonb(x) r FROM '+table+' x ORDER BY to_jsonb(x)::text')).rows);return r;}const before=await snapshot();await upgradeToCurrent(f.pg);assert.deepEqual(await snapshot(),before);assert.equal((await f.pg.query('SELECT * FROM public.notification_deliveries')).rows.length,0);assert.equal((await f.pg.query('SELECT * FROM public.notification_delivery_revisions')).rows.length,0);assert.equal((await f.request('me/notification-preferences',undefined,'staff')).body.data.email.effective,true);}finally{await f.pg.close();}
});
