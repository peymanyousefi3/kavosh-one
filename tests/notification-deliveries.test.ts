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
async function fixture(options:{throughSchema?:number;autoPolicy?:boolean}={}){
 const f=await notificationFixture(options),sent:{channel:string;to:string;subject?:string;text:string}[]=[];
 const transport:MessageTransport={channels:['email','sms'],async email(m){sent.push({channel:'email',...m});return {provider:'smtp',providerMessageId:'<synthetic-message@example.test>',providerStatus:'accepted',providerAccepted:true,deliveryConfirmed:false};},async sms(m){sent.push({channel:'sms',...m});return {provider:'twilio',providerMessageId:'SM'+'a'.repeat(32),providerStatus:'accepted',providerAccepted:true,deliveryConfirmed:false};}};
 const database:Database={async connect(){const c=f.pg.runtime?await f.pg.runtime.connect():{query:f.pg.query.bind(f.pg),release(){}};await c.query('SET ROLE kavosh_message_worker');return c;}};
 async function configure(patch:Record<string,unknown>={},as='master'){const before=await f.request('automations/delivery-policy');assert.equal(before.response.status,200,JSON.stringify(before.body));return f.request('automations/delivery-policy',{expectedVersion:before.body.data.version,definition:{enabled:true,maxDailyEmailRequests:1000,maxDailySmsRequests:1000,maxHourlyRequestsPerRecipient:100,...before.body.data.definition,...patch},reason:'Synthetic explicitly reviewed sending policy'},as);}
 async function enablePolicy(){const current=await f.request('automations/delivery-policy');assert.equal(current.response.status,200,JSON.stringify(current.body));if(current.body.data.version===0)assert.equal((await configure()).response.status,200);}
 async function work(t:MessageTransport|null=transport,academies=[f.a],signal?:AbortSignal){if(options.autoPolicy!==false)await enablePolicy();try{return await processOneMessage(database,academies,a=>a===f.a?t:null,signal);}finally{if(!f.pg.runtime)await f.pg.exec('RESET ROLE');}}
 async function optIn(as='staff',channels=['email','sms'],locale='fr'){const old=await f.request('me/notification-preferences',undefined,as),r=await f.request('me/notification-preferences',{expectedVersion:old.body.data.version,emailEnabled:channels.includes('email'),smsEnabled:channels.includes('sms'),locale,acknowledgedNoticeVersion:1},as);assert.ok([200,201].includes(r.response.status),JSON.stringify(r.body));return r;}
 async function queue(channels=['email','sms'],code='OUTBOUND'){
  const r=await f.rule({actions:[{...f.definition.actions[0],channels,body:{en:'English update',fr:'Mise à jour', 'zh-CN':'通知'}}],execution:{...f.definition.execution,maxDailySms:100}},code),event=await f.source(),result=await f.dispatch(r.id,event.id);assert.equal(result.response.status,201,JSON.stringify(result.body));return {rule:r,event,result};
 }
 if(options.autoPolicy!==false&&(!options.throughSchema||options.throughSchema>=236))await enablePolicy();
 return {...f,sent,transport,database,work,optIn,queue,configure};
}
type F=Awaited<ReturnType<typeof fixture>>;
const monitoring='automations/deliveries';
async function allowMonitoring(f:F,role=f.managerRole){await f.pg.query("INSERT INTO public.role_permissions VALUES($1,$2,'notification-deliveries.view','allow')",[f.a,role]);}
function check(name:string,run:(f:F)=>Promise<void>){test(name,async()=>{const f=await fixture();try{await run(f);}finally{await f.pg.close();}});}
function noSecrets(v:unknown){assert.doesNotMatch(JSON.stringify(v),/example[.]test|[+]1647|owner_epoch|contact_epoch|lease_token|provider_id|auth_user_id|Mise à jour/);}

test('operational sending defaults off without a reviewed policy and paused queued notices resume without changing consent',async()=>{
 const f=await fixture({autoPolicy:false});try{
  await f.optIn('staff',['email']);await f.queue(['email']);assert.equal((await f.work()).claimed,false);assert.equal((await f.request('automations/delivery-policy')).body.data.version,0);assert.equal((await f.pg.query('SELECT * FROM public.operational_send_reservations')).rows.length,0);
  assert.equal((await f.configure()).response.status,200);assert.equal((await f.work()).outcome,'accepted');assert.equal(f.sent.length,1);
  assert.equal((await f.configure({enabled:false})).response.status,200);await f.queue(['email'],'PAUSED_NOTICE');assert.equal((await f.work()).claimed,false);assert.equal(f.sent.length,1);assert.equal((await f.pg.query("SELECT count(*)::int n FROM public.notification_deliveries WHERE status='queued'")).rows[0].n,1);
  assert.equal((await f.configure({enabled:true})).response.status,200);assert.equal((await f.work()).outcome,'accepted');assert.equal(f.sent.length,2);const usage=await f.request('automations/delivery-policy/usage');assert.equal(usage.body.data.emailRequests,'2');assert.equal(usage.body.requestsAreNotCarrierSegments,true);assert.equal(usage.body.chargesCalculated,false);noSecrets(usage.body);
 }finally{await f.pg.close();}
});

check('academy daily send limits span different rules and separate email SMS requests without hiding waiting jobs',async f=>{
 await f.configure({maxDailyEmailRequests:1,maxDailySmsRequests:1});await f.optIn('staff');await f.optIn('manager');await f.queue(['email','sms'],'DAILY_FIRST');await f.queue(['email','sms'],'DAILY_SECOND');
 let n=0;for(let i=0;i<8;i++){const r=await f.work();if(!r.claimed)break;assert.equal(r.outcome,'accepted');n++;}assert.equal(n,2);assert.equal(f.sent.filter(v=>v.channel==='email').length,1);assert.equal(f.sent.filter(v=>v.channel==='sms').length,1);
 const usage=await f.request('automations/delivery-policy/usage');assert.equal(usage.body.data.emailRequests,'1');assert.equal(usage.body.data.smsRequests,'1');assert.equal((await f.pg.query("SELECT count(*)::int n FROM public.notification_deliveries WHERE status='queued'")).rows[0].n,6);assert.equal((await f.work()).claimed,false);
});

check('recipient rolling-hour limit combines channels across rules while other recipients can still receive messages',async f=>{
 await f.configure({maxHourlyRequestsPerRecipient:1});await f.optIn('staff');await f.optIn('manager');await f.queue(['email','sms'],'HOUR_FIRST');await f.queue(['email','sms'],'HOUR_SECOND');
 assert.equal((await f.work()).outcome,'accepted');assert.equal((await f.work()).outcome,'accepted');assert.equal((await f.work()).claimed,false);assert.equal(f.sent.length,2);
 assert.deepEqual((await f.pg.query<{n:string}>('SELECT count(*)::text n FROM public.operational_send_reservations GROUP BY person_id ORDER BY person_id')).rows,[{n:'1'},{n:'1'}]);
 const person=f.actors.staff.person;assert.equal((await f.pg.query<{ok:boolean}>("SELECT public.operational_send_allowed($1,$2,'email',(SELECT recorded_at+interval '1 hour' FROM public.operational_send_reservations WHERE person_id=$2)) ok",[f.a,person])).rows[0].ok,true,'Exact native hour boundary must not lose microseconds');
 assert.equal((await f.pg.query<{ok:boolean}>("SELECT public.operational_send_allowed($1,$2,'email',(SELECT recorded_at+interval '59 minutes 59 seconds' FROM public.operational_send_reservations WHERE person_id=$2)) ok",[f.a,person])).rows[0].ok,false);
});

test('two real preclaimed senders cannot bypass the final native academy cap even when both claims saw free capacity',{skip:!process.env.TEST_DATABASE_URL},async()=>{
 const f=await fixture(),clients:Awaited<ReturnType<Database['connect']>>[]=[];try{
  await f.configure({maxDailyEmailRequests:1});await f.optIn('staff',['email']);await f.optIn('manager',['email']);await f.queue(['email']);
  const leases:{id:string;lease_token:string}[]=[];for(let i=0;i<2;i++){const c=await f.database.connect();clients.push(c);const lease=(await c.query<{id:string;lease_token:string}>('SELECT * FROM public.claim_notification_delivery($1::jsonb)',[JSON.stringify([{academy_id:f.a,channels:['email']}])])).rows[0];assert.ok(lease);leases.push(lease);}assert.notEqual(leases[0].id,leases[1].id);
  const begin=async(c:typeof clients[number],lease:typeof leases[number])=>{await c.query('BEGIN');try{await c.query("SELECT set_config('app.academy_id',$1,true),set_config('statement_timeout','5000',true)",[f.a]);const p=(await c.query<{data:{channel?:string;deferred?:boolean}}>('SELECT public.begin_notification_delivery($1,$2) data',[lease.id,lease.lease_token])).rows[0].data;await c.query('COMMIT');return p;}catch(e){await c.query('ROLLBACK');throw e;}};
  const result=await Promise.all(clients.map((c,i)=>begin(c,leases[i])));assert.equal(result.filter(p=>p.channel==='email').length,1);assert.equal(result.filter(p=>p.deferred===true).length,1);assert.equal((await f.pg.query('SELECT * FROM public.operational_send_reservations')).rows.length,1);assert.equal(f.sent.length,0,'This checks native handoff reservations,not provider IO');
 }finally{for(const c of clients){await c.query('ROLLBACK');c.release();}await f.pg.close();}
});

check('rejected and uncertain provider attempts consume conservative handoff capacity and are never automatically refunded or repeated',async f=>{
 await f.configure({maxDailyEmailRequests:1});await f.optIn('staff',['email']);await f.queue(['email'],'CAP_REJECTED');let attempts=0;
 const rejected={...f.transport,async email(){attempts++;throw new MessageDeliveryError('rejected','SYNTHETIC_REJECTION');}};assert.equal((await f.work(rejected)).outcome,'failed');assert.equal(attempts,1);
 await f.queue(['email'],'CAP_WAITING');assert.equal((await f.work(rejected)).claimed,false);assert.equal(attempts,1);assert.equal((await f.request('automations/delivery-policy/usage')).body.data.emailRequests,'1');
 await f.configure({maxDailyEmailRequests:2});const uncertain={...f.transport,async email(){attempts++;throw new Error('SYNTHETIC_UNCERTAIN');}};assert.equal((await f.work(uncertain)).outcome,'unknown');assert.equal(attempts,2);assert.equal((await f.request('automations/delivery-policy/usage')).body.data.emailRequests,'2');assert.equal((await f.work(uncertain)).claimed,false);assert.equal(attempts,2);
});

check('sending policy needs full-school explicit grants and upper human approval with exact versions immutable history and tenant isolation',async f=>{
 const path='automations/delivery-policy';for(const suffix of ['', '/usage','/history'])assert.equal((await f.request(path+suffix,undefined,'manager')).response.status,403);
 for(const cap of ['delivery-policy.view','delivery-policy.edit'])await f.pg.query("INSERT INTO public.role_permissions VALUES($1,$2,$3,'allow')",[f.a,f.managerRole,cap]);assert.equal((await f.request(path,undefined,'manager')).response.status,403,'A finite hub grant cannot edit a school-wide cap');
 for(const cap of ['delivery-policy.view','delivery-policy.edit'])await f.pg.query("INSERT INTO public.role_permissions VALUES($1,$2,$3,'allow')",[f.a,f.policyRole,cap]);const proposed=await f.configure({maxDailySmsRequests:2},'manager');assert.equal(proposed.response.status,202,JSON.stringify(proposed.body));assert.equal((await f.request(path)).body.data.version,1);assert.equal((await f.approve(proposed.body.approval.id,'manager')).response.status,403);assert.equal((await f.approve(proposed.body.approval.id)).response.status,200);
 const bot=await f.configure({enabled:false},'bot');assert.equal(bot.response.status,202,JSON.stringify(bot.body));assert.equal((await f.approve(bot.body.approval.id,'bot')).response.status,403);assert.equal((await f.approve(bot.body.approval.id)).response.status,200);assert.equal((await f.request(path)).body.data.version,3);
 const history=await f.request(path+'/history?limit=1');assert.equal(history.body.data[0].version,1);assert.equal(history.body.nextVersion,1);assert.equal((await f.request(path,undefined,'foreignMaster',{academy:f.b})).body.data.version,0);assert.equal((await f.request(path+'/usage',undefined,'foreignMaster',{academy:f.b})).body.data.emailRequests,'0');
 for(const sql of ['UPDATE public.operational_send_policy_revisions SET version=version','DELETE FROM public.operational_send_policies'])await assert.rejects(f.pg.exec(sql),/IMMUTABLE|HEAD_REQUIRED/);
});

check('suppressed handoff reservations roll back sending before any provider request and private ledger and old bypass helper stay inaccessible',async f=>{
 await f.optIn('staff',['email']);await f.queue(['email'],'RESERVATION_FAILURE');await f.pg.exec('CREATE FUNCTION public.suppress_send_reservation_test() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RETURN NULL;END$$;CREATE TRIGGER suppress_send_reservation_test BEFORE INSERT ON public.operational_send_reservations FOR EACH ROW EXECUTE FUNCTION public.suppress_send_reservation_test()');
 await assert.rejects(f.work(),/SEND_RESERVATION_REQUIRED/);assert.equal(f.sent.length,0);assert.equal((await f.pg.query('SELECT * FROM public.operational_send_reservations')).rows.length,0);assert.equal((await f.pg.query('SELECT status FROM public.notification_deliveries')).rows[0].status,'preparing');
 await f.pg.exec('DROP TRIGGER suppress_send_reservation_test ON public.operational_send_reservations;DROP FUNCTION public.suppress_send_reservation_test()');await f.queue(['email'],'RESERVATION_RECOVERY');assert.equal((await f.work()).outcome,'accepted');assert.equal(f.sent.length,1);
 for(const role of ['kavosh_runtime','kavosh_message_worker']){await f.pg.exec('BEGIN');try{await f.pg.exec('SET LOCAL ROLE '+role);for(const sql of ['SELECT * FROM public.operational_send_reservations','SELECT public.begin_notification_delivery_before_limits(NULL,NULL)','SELECT public.operational_send_allowed(NULL,NULL,NULL,NULL)']){await f.pg.exec('SAVEPOINT private');await assert.rejects(f.pg.exec(sql),/permission denied/);await f.pg.exec('ROLLBACK TO SAVEPOINT private');}}finally{await f.pg.exec('ROLLBACK');}}
});

check('actual worker honors a native capacity deferral when a reviewed limit changes after its real claim',async f=>{
 await f.optIn('staff',['email']);await f.queue(['email']);const connect=f.database.connect.bind(f.database);let changed=false;
 f.database.connect=async()=>{const c=await connect();return {async query<Row>(sql:string,params?:unknown[]){const r=await c.query<Row>(sql,params);if(!changed&&sql.startsWith('SELECT * FROM public.claim_notification_delivery')&&r.rows.length){changed=true;assert.equal((await f.configure({maxDailyEmailRequests:0})).response.status,200);await c.query('SET ROLE kavosh_message_worker');}return r;},release(destroy?:boolean){c.release(destroy);}};};
 const result=await f.work();assert.equal(changed,true);assert.equal(result.outcome,'deferred');assert.equal(result.recorded,false);assert.equal(f.sent.length,0);assert.equal((await f.pg.query('SELECT * FROM public.operational_send_reservations')).rows.length,0);assert.equal((await f.pg.query('SELECT status FROM public.notification_deliveries')).rows[0].status,'preparing');assert.equal((await f.work()).claimed,false);
});

check('modified native handoff reservation cannot move an attempt outside the quota window or reach the provider',async f=>{
 await f.optIn('staff',['email']);await f.queue(['email']);await f.pg.exec("CREATE FUNCTION public.modify_send_reservation_test() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN NEW.recorded_at=NEW.recorded_at-interval '3 days';RETURN NEW;END$$;CREATE TRIGGER modify_send_reservation_test BEFORE INSERT ON public.operational_send_reservations FOR EACH ROW EXECUTE FUNCTION public.modify_send_reservation_test()");
 await assert.rejects(f.work(),/SEND_RESERVATION_REQUIRED/);assert.equal(f.sent.length,0);assert.equal((await f.pg.query('SELECT * FROM public.operational_send_reservations')).rows.length,0);assert.equal((await f.pg.query('SELECT status FROM public.notification_deliveries')).rows[0].status,'preparing');assert.equal((await f.request('automations/delivery-policy/usage')).body.data.emailRequests,'0');
});

check('sending policy strict inputs and suppressed audit rollback preserve exact retry and read-only schools permit pause only',async f=>{
 const path='automations/delivery-policy',before=(await f.request(path)).body.data,input={expectedVersion:before.version,definition:{...before.definition,maxDailySmsRequests:3},reason:'Synthetic exact sending limit review'},key=randomUUID();
 for(const patch of [{definition:{...input.definition,maxDailySmsRequests:100001}},{definition:{...input.definition,maxHourlyRequestsPerRecipient:-1}},{definition:{...input.definition,provider:'caller override'}},{approved:true},{expectedVersion:1.5}])assert.equal((await f.request(path,{...input,...patch})).response.status,400);
 assert.equal((await f.request(path+'?enabled=true')).response.status,400);assert.equal((await f.request(path+'/history?limit=51')).response.status,400);
 await f.pg.exec("CREATE FUNCTION public.suppress_send_policy_audit_test() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN IF NEW.action='notification.delivery-policy.change' THEN RETURN NULL;END IF;RETURN NEW;END$$;CREATE TRIGGER suppress_send_policy_audit_test BEFORE INSERT ON public.audit_events FOR EACH ROW EXECUTE FUNCTION public.suppress_send_policy_audit_test()");
 assert.equal((await f.request(path,input,'master',{key})).response.status,503);assert.equal((await f.request(path)).body.data.version,before.version);await f.pg.exec('DROP TRIGGER suppress_send_policy_audit_test ON public.audit_events;DROP FUNCTION public.suppress_send_policy_audit_test()');const saved=await f.request(path,input,'master',{key});assert.equal(saved.response.status,200,JSON.stringify(saved.body));assert.equal((await f.request(path,input,'master',{key})).response.status,409,'As with existing source-checked approvals,an obsolete policy input is not a current-policy receipt');assert.equal((await f.pg.query('SELECT * FROM public.operational_send_policy_revisions')).rows.length,2);
 const next={...input,expectedVersion:2,definition:{...input.definition,maxDailySmsRequests:4}},nextKey=randomUUID();await f.pg.exec("CREATE FUNCTION public.suppress_send_policy_outbox_test() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN IF NEW.event_type='notification.delivery-policy.change' THEN RETURN NULL;END IF;RETURN NEW;END$$;CREATE TRIGGER suppress_send_policy_outbox_test BEFORE INSERT ON public.outbox_events FOR EACH ROW EXECUTE FUNCTION public.suppress_send_policy_outbox_test()");assert.equal((await f.request(path,next,'master',{key:nextKey})).response.status,503);assert.equal((await f.request(path)).body.data.version,2);await f.pg.exec('DROP TRIGGER suppress_send_policy_outbox_test ON public.outbox_events;DROP FUNCTION public.suppress_send_policy_outbox_test()');assert.equal((await f.request(path,next,'master',{key:nextKey})).response.status,200);
 await f.pg.query("UPDATE public.academies SET status='read_only' WHERE id=$1",[f.a]);assert.equal((await f.configure({enabled:false})).response.status,200);assert.equal((await f.configure({enabled:true})).response.status,403);assert.equal((await f.configure({maxDailyEmailRequests:0})).response.status,403,'A read-only pause must not smuggle unrelated cap changes');assert.equal((await f.request(path)).body.data.definition.enabled,false);
});

check('upper reviewer can approve an exact pending sending pause in a read-only school without permitting a cap increase',async f=>{
 for(const cap of ['delivery-policy.view','delivery-policy.edit'])await f.pg.query("INSERT INTO public.role_permissions VALUES($1,$2,$3,'allow')",[f.a,f.policyRole,cap]);
 const pending=await f.configure({enabled:false},'manager');assert.equal(pending.response.status,202,JSON.stringify(pending.body));await f.pg.query("UPDATE public.academies SET status='read_only' WHERE id=$1",[f.a]);const approved=await f.approve(pending.body.approval.id);assert.equal(approved.response.status,200,JSON.stringify(approved.body));assert.equal((await f.request('automations/delivery-policy')).body.data.definition.enabled,false);assert.equal((await f.configure({enabled:true})).response.status,403);
});

test('actual235to236 preserves delivery facts and imports only real historic handoff timestamps without inventing a sending policy',async()=>{
 const f=await fixture({throughSchema:235,autoPolicy:false});try{
  await f.optIn('staff',['email']);await f.queue(['email']);await f.pg.exec('BEGIN');try{
   await f.pg.exec('SET LOCAL ROLE kavosh_message_worker');const lease=(await f.pg.query<{id:string;lease_token:string}>('SELECT * FROM public.claim_notification_delivery($1::jsonb)',[JSON.stringify([{academy_id:f.a,channels:['email']}])])).rows[0];assert.ok(lease);await f.pg.query("SELECT set_config('app.academy_id',$1,true)",[f.a]);assert.equal((await f.pg.query<{data:{channel:string}}>('SELECT public.begin_notification_delivery($1,$2) data',[lease.id,lease.lease_token])).rows[0].data.channel,'email');assert.equal((await f.pg.query<{ok:boolean}>("SELECT public.finish_notification_delivery($1,$2,'unknown',NULL,'SYNTHETIC_OUTCOME_UNKNOWN') ok",[lease.id,lease.lease_token])).rows[0].ok,true);await f.pg.exec('COMMIT');
  }catch(e){await f.pg.exec('ROLLBACK');throw e;}
  const snapshot=async()=>{const rows=[];for(const t of ['notification_deliveries','notification_delivery_revisions','role_permissions','audit_events','outbox_events'])rows.push((await f.pg.query('SELECT to_jsonb(x) data FROM public.'+t+' x ORDER BY to_jsonb(x)::text')).rows);return rows;},before=await snapshot();await upgradeToCurrent(f.pg);assert.deepEqual(await snapshot(),before);
  const reservation=(await f.pg.query<{origin:string;policy_id:string|null;same:boolean}>("SELECT s.origin,s.policy_id,s.recorded_at=(r.definition->>'changedAt')::timestamptz same FROM public.operational_send_reservations s JOIN public.notification_delivery_revisions r ON r.academy_id=s.academy_id AND r.delivery_id=s.delivery_id AND r.definition->>'status'='sending'")).rows;assert.deepEqual(reservation,[{origin:'historical_sending_state',policy_id:null,same:true}]);assert.equal((await f.request('automations/delivery-policy')).body.data.version,0);assert.equal((await f.request('automations/delivery-policy/usage')).body.data.emailRequests,'1');assert.equal((await f.work()).claimed,false);assert.equal(f.sent.length,0);
 }finally{await f.pg.close();}
});

check('delivery supervision requires a separate explicit permission and keeps source privacy before metadata counts and paging',async f=>{
 await f.optIn();await f.queue();assert.equal((await f.request(monitoring,undefined,'manager')).response.status,403);assert.equal((await f.request(monitoring,undefined,'bot')).response.status,403);
 await allowMonitoring(f);const first=await f.request(monitoring+'?limit=1',undefined,'manager');assert.equal(first.response.status,200,JSON.stringify(first.body));assert.equal(first.body.data.length,1);assert.ok(first.body.nextCursor);noSecrets(first.body);
 const second=await f.request(monitoring+'?limit=1&after='+first.body.nextCursor,undefined,'manager');assert.equal(second.body.data.length,1);assert.notEqual(first.body.data[0].id,second.body.data[0].id);assert.equal(second.body.nextCursor,null);
 assert.equal((await f.request(monitoring+'/summary',undefined,'manager')).body.data.reduce((n:number,r:{count:string})=>n+Number(r.count),0),2);
 assert.equal((await f.request(monitoring+'?attentionOnly=true',undefined,'manager')).body.data.length,0);
 await f.pg.query("DELETE FROM public.role_permissions WHERE role_id=$1 AND capability='automations.view'",[f.managerRole]);
 assert.deepEqual((await f.request(monitoring,undefined,'manager')).body.data,[]);assert.deepEqual((await f.request(monitoring+'/summary',undefined,'manager')).body.data,[]);
 for(const suffix of ['', '/history'])assert.equal((await f.request(monitoring+'/'+first.body.data[0].id+suffix,undefined,'manager')).response.status,404);
 assert.equal((await f.request(root,undefined,'staff')).body.data.length,2,'monitoring permissions do not replace private self access');
});

check('delivery monitoring shows precise failure and uncertain states without retrying or treating provider acceptance as receipt',async f=>{
 await f.optIn();const q=await f.queue();await allowMonitoring(f);let attempts=0;
 const transport={...f.transport,async email(){attempts++;throw new MessageDeliveryError('rejected','SYNTHETIC_REJECTION');},async sms(){attempts++;throw new Error('SYNTHETIC_UNCERTAIN');}};
 for(let i=0;i<2;i++)assert.equal((await f.work(transport)).recorded,true);assert.equal(attempts,2);
 const records=await f.request(monitoring+'?attentionOnly=true&ruleId='+q.rule.id,undefined,'manager');assert.equal(records.response.status,200,JSON.stringify(records.body));assert.deepEqual(records.body.data.map((d:{status:string})=>d.status).sort(),['failed','unknown']);assert.ok(records.body.data.every((d:{needsAttention:boolean})=>d.needsAttention));noSecrets(records.body);
 const counts=await f.request(monitoring+'/summary?attentionOnly=true&ruleId='+q.rule.id,undefined,'manager');assert.deepEqual(counts.body.data.map((r:{status:string;count:string;attentionCount:string})=>[r.status,r.count,r.attentionCount]).sort(),[['failed','1','1'],['unknown','1','1']]);
 for(const job of records.body.data){const detail=await f.request(monitoring+'/'+job.id,undefined,'manager');assert.equal(detail.body.data.sourceStillCurrent,true);assert.equal(detail.body.readDoesNotResolve,true);assert.equal(detail.body.deliveryConfirmed,false);noSecrets(detail.body);
  const history=await f.request(monitoring+'/'+job.id+'/history?limit=1',undefined,'manager');assert.equal(history.body.data.length,1);assert.equal(history.body.data[0].state.status,job.status);assert.equal(history.body.nextCursor,4);noSecrets(history.body);}
 assert.equal((await f.work(transport)).claimed,false);assert.equal(attempts,2);assert.equal((await f.request(monitoring+'/summary?status=accepted',undefined,'manager')).body.data.length,0);
});

check('API bot monitoring intersects its own current token ceiling and never borrows a manager or master source identity',async f=>{
 await f.optIn('manager',['email']);await allowMonitoring(f);await f.pg.query("INSERT INTO public.role_permissions VALUES($1,$2,'audit.view','allow')",[f.a,f.managerRole]);
 const created=await f.request('people',{name:'Synthetic source for bot observation',hubId:f.hub});assert.equal(created.response.status,201);
 const event=(await f.pg.query<{event_id:string}>("SELECT event_id FROM public.automation_event_sources WHERE source_kind='audit' AND projection->>'entityId'=$1",[created.body.data.id])).rows[0];assert.ok(event);
 const rule=await f.rule({trigger:{kind:'domain_event',eventTypes:['person.created']},actions:[{...f.definition.actions[0],channels:['email'],audience:{kind:'people',personIds:[f.actors.manager.person]}}]},'BOT_SUPERVISION');assert.equal((await f.dispatch(rule.id,event.event_id)).body.data.summary.outboundQueued,1);
 const list=await f.request(monitoring,undefined,'bot');assert.equal(list.response.status,200,JSON.stringify(list.body));assert.equal(list.body.data.length,1);const id=list.body.data[0].id;noSecrets(list.body);assert.equal((await f.request(monitoring+'/'+id+'/history',undefined,'bot')).response.status,200);
 await f.pg.query('INSERT INTO public.assignment_hubs(academy_id,assignment_id,hub_id) SELECT $1,id,$2 FROM public.role_assignments WHERE person_id=$3 AND role_id=$4',[f.a,f.otherHub,f.bot,f.managerRole]);
 await f.pg.query('UPDATE auth_private.credentials SET all_hubs=false WHERE id=$1',[f.credential]);await f.pg.query('INSERT INTO auth_private.credential_hubs VALUES($1,$2,$3)',[f.credential,f.a,f.otherHub]);
 const narrowed=await f.request(monitoring,undefined,'bot');assert.equal(narrowed.response.status,200,JSON.stringify(narrowed.body));assert.deepEqual(narrowed.body.data,[]);assert.deepEqual((await f.request(monitoring+'/summary',undefined,'bot')).body.data,[]);assert.equal((await f.request(monitoring+'/'+id,undefined,'bot')).response.status,404);
 assert.equal((await f.request(monitoring,undefined,'master')).body.data.length,1);assert.equal((await f.pg.query('SELECT status FROM public.notification_deliveries')).rows[0].status,'queued');assert.equal(f.sent.length,0);
});

check('selected-recipient delivery permission and explicit person denial constrain detail history and summaries before pagination',async f=>{
 await f.optIn('staff',['email']);await f.optIn('manager',['email']);await f.queue(['email']);
 const role=randomUUID(),assignment=randomUUID();await f.pg.query('INSERT INTO public.roles(academy_id,id,name) VALUES($1,$2,\'Selected delivery monitor\')',[f.a,role]);await f.pg.query("INSERT INTO public.role_permissions VALUES($1,$2,'notification-deliveries.view','allow')",[f.a,role]);await f.pg.query('INSERT INTO public.role_assignments(academy_id,id,person_id,role_id,all_hubs) VALUES($1,$2,$3,$4,false)',[f.a,assignment,f.actors.manager.person,role]);await f.pg.query('INSERT INTO public.assignment_people VALUES($1,$2,$3)',[f.a,assignment,f.actors.staff.person]);
 const records=await f.request(monitoring+'?limit=1',undefined,'manager');assert.equal(records.response.status,200,JSON.stringify(records.body));assert.equal(records.body.data.length,1);assert.equal(records.body.data[0].recipientPersonId,f.actors.staff.person);assert.equal(records.body.nextCursor,null);
 assert.equal((await f.request(monitoring+'/summary',undefined,'manager')).body.data[0].count,'1');
 const hidden=(await f.pg.query<{id:string}>('SELECT id FROM public.notification_deliveries WHERE person_id=$1',[f.actors.manager.person])).rows[0];assert.equal((await f.request(monitoring+'/'+hidden.id,undefined,'manager')).response.status,404);
 await allowMonitoring(f);await f.pg.query("UPDATE public.role_permissions SET effect='deny' WHERE role_id=$1 AND capability='notification-deliveries.view'",[role]);
 const remaining=await f.request(monitoring,undefined,'manager');assert.equal(remaining.body.data.length,1);assert.equal(remaining.body.data[0].id,hidden.id);assert.equal((await f.request(monitoring+'/'+records.body.data[0].id+'/history',undefined,'manager')).response.status,404);
});

check('delivery supervision validates strict bounded filters and stays tenant-bound and read-only',async f=>{
 await f.optIn('staff',['email']);const q=await f.queue(['email']);const id=(await f.pg.query<{id:string}>('SELECT id FROM public.notification_deliveries')).rows[0].id;await allowMonitoring(f);
 const day=(await f.pg.query<{created_on:string}>("SELECT to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD') created_on FROM public.notification_deliveries")).rows[0].created_on;
 const selected=await f.request(monitoring+'?channel=email&status=queued&personId='+f.actors.staff.person+'&eventId='+q.event.id+'&from='+day+'&through='+day,undefined,'manager');assert.equal(selected.body.data.length,1);
 assert.deepEqual((await f.request(monitoring+'?through=2000-01-01',undefined,'manager')).body.data,[]);
 for(const suffix of ['?limit=51','?status=delivered','?to=private@example.test','?limit=1&limit=2','?from=2026-11-09&through=2026-11-08','/summary?limit=1','/summary?from=0000-01-01','/'+id+'/history?beforeVersion=2147483648'])assert.equal((await f.request(monitoring+suffix,undefined,'manager')).response.status,400,suffix);
 for(const suffix of ['', '/summary','/'+id,'/'+id+'/history'])assert.equal((await f.request(monitoring+suffix,{},'manager')).response.status,405);
 for(const suffix of ['', '/summary'])assert.deepEqual((await f.request(monitoring+suffix,undefined,'foreignMaster',{academy:f.b})).body.data,[]);
 for(const suffix of ['', '/history'])assert.equal((await f.request(monitoring+'/'+id+suffix,undefined,'foreignMaster',{academy:f.b})).response.status,404);
 const before=(await f.pg.query('SELECT id,status,version FROM public.notification_deliveries')).rows;await f.request(monitoring+'/'+id+'/history',undefined,'manager');assert.deepEqual((await f.pg.query('SELECT id,status,version FROM public.notification_deliveries')).rows,before);assert.equal(f.sent.length,0);
 await f.pg.query("DELETE FROM public.role_permissions WHERE role_id=$1 AND capability='people.view'",[f.managerRole]);assert.equal((await f.request(monitoring,undefined,'manager')).response.status,403);
});

test('actual234to235 preserves all prior jobs permissions and credentials without inferring delivery-monitor grants',async()=>{
 const f=await fixture({throughSchema:234});try{await f.optIn('staff',['email']);await f.queue(['email']);
  const tables=['public.role_permissions','public.role_assignments','auth_private.credentials','public.notification_deliveries','public.notification_delivery_revisions'];
  async function snapshot(){const rows=[];for(const table of tables)rows.push((await f.pg.query('SELECT to_jsonb(x) data FROM '+table+' x ORDER BY to_jsonb(x)::text')).rows);return rows;}
  const before=await snapshot();await upgradeToCurrent(f.pg);assert.deepEqual(await snapshot(),before);assert.equal((await f.request(monitoring,undefined,'manager')).response.status,403);assert.equal((await f.request(monitoring,undefined,'bot')).response.status,403);assert.equal((await f.request(monitoring,undefined,'master')).body.data.length,1);assert.equal(f.sent.length,0);
 }finally{await f.pg.close();}
});

check('master configures the monitoring feature through ordinary role presets and selected-person access APIs',async f=>{
 await f.optIn('staff',['email']);await f.optIn('manager',['email']);await f.queue(['email']);
 const catalog=await f.request('capabilities');assert.equal(catalog.response.status,200);assert.deepEqual(catalog.body.data.find((c:{name:string})=>c.name==='notification-deliveries.view').scope_kinds,['hub','person','country','region','city']);
 const preset=await f.request('roles',{name:'Selected message monitoring',permissions:[{capability:'notification-deliveries.view',effect:'allow'}]});assert.equal(preset.response.status,201,JSON.stringify(preset.body));
 const path='people/'+f.actors.manager.person+'/access',before=await f.request(path);assert.equal(before.response.status,200);
 const assign=await f.request(path,{expectedVersion:before.body.data.version,assignments:[{roleId:f.managerRole,allHubs:false,hubIds:[f.hub]},{roleId:f.policyRole,allHubs:true},{roleId:preset.body.data.id,allHubs:false,personIds:[f.actors.staff.person]}]});assert.equal(assign.response.status,200,JSON.stringify(assign.body));
 const list=await f.request(monitoring,undefined,'manager');assert.equal(list.response.status,200,JSON.stringify(list.body));assert.equal(list.body.data.length,1);assert.equal(list.body.data[0].recipientPersonId,f.actors.staff.person);assert.equal(f.sent.length,0);
 await f.pg.query("UPDATE public.academies SET status='read_only' WHERE id=$1",[f.a]);assert.equal((await f.request(monitoring+'/summary',undefined,'manager')).body.data[0].count,'1','Supervision stays available while writes are frozen');
});

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
  assert.equal((await f.request('automations/delivery-policy',{expectedVersion:0,definition:{enabled:true,maxDailyEmailRequests:100,maxDailySmsRequests:0,maxHourlyRequestsPerRecipient:10},reason:'Synthetic explicitly reviewed class reminder policy'})).response.status,200);
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
