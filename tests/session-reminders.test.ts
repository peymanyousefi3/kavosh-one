import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Temporal } from '@js-temporal/polyfill';
import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { upgradeToCurrent } from './migration-upgrade.ts';
import { sessionNotificationFixture } from './session-notification-fixture.ts';
import { processOneSubscription } from '../src/automations/subscription-worker.ts';
import { processOneNotification } from '../src/automations/notification-worker.ts';
import type { Database } from '../src/core/database.ts';

async function fixture(minutesBefore=4,maxDelayMinutes=2,startMinutes=4,audience:'session_guardians'|'session_staff'='session_guardians'){
 const f=await sessionNotificationFixture(audience),errors:{message:string;sql:string}[]=[];
 try{
  const start=Temporal.Now.zonedDateTimeISO('America/Toronto').add({minutes:startMinutes}).with({second:0,millisecond:0,microsecond:0,nanosecond:0}),end=start.add({hours:1}),local=(v:typeof start)=>v.toPlainDateTime().toString({smallestUnit:'minute'});
  assert.equal((await f.changeSession(1,{kind:'reschedule',start:local(start),end:local(end)})).response.status,200);
  const definition={...f.rule.definition,trigger:{kind:'domain_event',eventTypes:['session.reminder_due']},sessionReminder:{minutesBefore,maxDelayMinutes}};
  const changed=await f.request('automations/rules/'+f.rule.id+'/change',{expectedVersion:1,definition,reason:'Configured class reminder'});assert.equal(changed.response.status,200,JSON.stringify(changed.body));
  const sub=await f.request('automations/rules/'+f.rule.id+'/subscriptions',{expectedVersion:2,reason:'Reviewed persistent class reminders'});assert.equal(sub.response.status,201,JSON.stringify(sub.body));
  const database:Database={async connect(){const c=f.pg.runtime?await f.pg.runtime.connect():{query:f.pg.query.bind(f.pg),release(){}};await c.query('SET ROLE kavosh_automation_worker');return {async query<Row>(sql:string,params?:unknown[]){try{return await c.query<Row>(sql,params);}catch(error){errors.push({message:(error as Error).message,sql:sql.slice(0,160)});throw error;}},release(destroy?:boolean){c.release(destroy);}};}};
  const work=async()=>{try{return await processOneSubscription(database,[f.a]);}finally{if(!f.pg.runtime)await f.pg.exec('RESET ROLE');}},deliver=async()=>{try{return await processOneNotification(database,[f.a]);}finally{if(!f.pg.runtime)await f.pg.exec('RESET ROLE');}};
  const ready=async()=>{await f.pg.exec('BEGIN');try{await f.pg.exec('SET LOCAL ROLE kavosh_automation_policy');await f.pg.query("UPDATE public.automation_subscriptions SET available_at=clock_timestamp()-interval '1 second' WHERE id=$1",[sub.body.data.id]);await f.pg.exec('COMMIT');}catch(error){await f.pg.exec('ROLLBACK');throw error;}};
  return {...f,start,end,local,work,deliver,ready,errors,database,sub:sub.body.data,definition};
 }catch(error){await f.pg.close();throw error;}
}
test('actual due session emits one native timer event,queues under reviewed watcher and delivers one current-family portal notice',async()=>{
 const f=await fixture();try{
  const result=await f.work();assert.equal(result.outcome,'queued',JSON.stringify(f.errors));const rows=(await f.pg.query<{projection:{attributes:{reminder:{minutesBefore:number}}};source_kind:string}>("SELECT projection,source_kind FROM public.automation_event_sources WHERE event_type='session.reminder_due'")).rows;assert.equal(rows.length,1);assert.equal(rows[0].source_kind,'session');assert.equal(rows[0].projection.attributes.reminder.minutesBefore,4);assert.doesNotMatch(JSON.stringify(rows),/PRIVATE|onlineUrl|meeting.example/);
  assert.equal((await f.deliver()).outcome,'succeeded',JSON.stringify(f.errors));assert.equal((await f.request('notifications?origin=automation',undefined,'staff')).body.data.length,1);
  await f.ready();await f.work();assert.equal((await f.pg.query('SELECT * FROM public.session_reminder_occurrences')).rows.length,1);assert.equal((await f.pg.query('SELECT * FROM public.notification_jobs')).rows.length,1);
 }finally{await f.pg.close();}
});
test('not-yet-due and expired late windows create no timer event or notification job',async()=>{
 for(const [lead,delay] of [[1,2],[60,1]]){const f=await fixture(lead,delay);try{assert.equal((await f.work()).outcome,'idle',JSON.stringify(f.errors));assert.equal((await f.pg.query('SELECT * FROM public.session_reminder_occurrences')).rows.length,0);assert.equal((await f.pg.query('SELECT * FROM public.notification_jobs')).rows.length,0);}finally{await f.pg.close();}}
});
test('a future rule window must not consume the due reminder before the rule becomes active',async()=>{
 const f=await fixture();try{
  assert.equal((await f.request('automations/rules/'+f.rule.id+'/change',{expectedVersion:2,definition:{...f.definition,startsAt:Temporal.Now.instant().add({hours:1}).toString({smallestUnit:'millisecond'})},reason:'Stage the rule for a future window'})).response.status,200);await f.work();assert.equal((await f.pg.query('SELECT * FROM public.session_reminder_occurrences')).rows.length,0,'deferred rule activation must leave this reminder eligible');
  assert.equal((await f.request('automations/rules/'+f.rule.id+'/change',{expectedVersion:3,definition:{...f.definition,startsAt:null},reason:'Open the approved rule window now'})).response.status,200);await f.ready();assert.equal((await f.work()).outcome,'queued',JSON.stringify(f.errors));assert.equal((await f.deliver()).outcome,'succeeded');
 }finally{await f.pg.close();}
});
test('timer migration preserves real old rule,event,run and portal records without inventing past reminders',async()=>{
 const f=await sessionNotificationFixture('session_guardians',127);try{
  assert.equal((await f.changeSession(1,{kind:'cancel'})).response.status,200);const event=(await f.pg.query<{event_id:string}>("SELECT event_id FROM public.automation_event_sources WHERE source_kind='session' AND event_type='session.changed'")).rows[0];assert.ok(event);const run=randomUUID();
  // Historical persistence fixture uses that version's actual native guards,
  // not the current dispatcher pretending schema128 is already installed.
  await f.pg.exec('BEGIN');try{await f.pg.exec('SET LOCAL ROLE kavosh_runtime');await f.pg.query("SELECT set_config('app.academy_id',$1,true)",[f.a]);
   await f.pg.query("INSERT INTO public.automation_runs(academy_id,id,rule_id,rule_version,event_id,actor_id,outcome,summary) VALUES($1,$2,$3,1,$4,$5,'processed','{\"portalNotifications\":1}')",[f.a,run,f.rule.id,event.event_id,f.actors.master.person]);
   await f.pg.query("INSERT INTO public.portal_notifications(academy_id,id,run_id,rule_id,event_id,person_id,action_index,severity,title,body,locale) VALUES($1,$2,$3,$4,$5,$6,0,'normal','Historical session change','Preserve original notice','en')",[f.a,randomUUID(),run,f.rule.id,event.event_id,f.guardian]);await f.pg.exec('COMMIT');
  }catch(error){await f.pg.exec('ROLLBACK');throw error;}
  const tables=['automation_rule_revisions','automation_event_sources','automation_runs','portal_notifications'],before:Record<string,unknown>[][]=[];for(const t of tables)before.push((await f.pg.query('SELECT * FROM public.'+t+' ORDER BY 1,2')).rows);await f.pg.exec(await readFile(new URL('../db/migrations/128_session_reminders.sql',import.meta.url),'utf8'));
  for(let i=0;i<tables.length;i++)assert.deepEqual((await f.pg.query('SELECT * FROM public.'+tables[i]+' ORDER BY 1,2')).rows,before[i],tables[i]);assert.equal((await f.pg.query('SELECT * FROM public.session_reminder_occurrences')).rows.length,0);
  await upgradeToCurrent(f.pg);const inbox=await f.request('notifications?origin=automation',undefined,'staff');assert.equal(inbox.response.status,200,JSON.stringify(inbox.body));assert.equal(inbox.body.data.length,1);
 }finally{await f.pg.close();}
});
test('24-hour parent and one-hour teacher reminders use exact elapsed offsets and real class-specific access',async()=>{
 for(const lead of [1440,60]){const f=await fixture(lead,2,lead,lead===60?'session_staff':'session_guardians');try{
  if(lead===60){assert.equal((await f.request('class-staff/'+f.assignment.id+'/update',{expectedVersion:1,startsOn:f.start.toPlainDate().toString(),endsOn:null,reason:'Teacher assigned on actual upcoming session day'})).response.status,200);
   const role=await f.request('roles',{name:'Assigned class calendar',permissions:[{capability:'classes.view',effect:'allow'}]});assert.equal(role.response.status,201);const access='people/'+f.guardian+'/access';assert.equal((await f.request(access,{expectedVersion:(await f.request(access)).body.data.version,assignments:[{roleId:role.body.data.id,allHubs:false,classIds:[f.c.id]}]})).response.status,200);
  }
  assert.equal((await f.work()).outcome,'queued',JSON.stringify(f.errors));const timing=(await f.pg.query<{seconds:string}>('SELECT extract(epoch FROM((source->>\'startsAt\')::timestamptz-due_at))::text seconds FROM public.session_reminder_occurrences')).rows[0];assert.equal(Number(timing.seconds),lead*60);assert.equal((await f.deliver()).outcome,'succeeded');assert.equal((await f.request('notifications?origin=automation',undefined,'staff')).body.data.length,1);
 }finally{await f.pg.close();}}
});
test('failed timer event persistence rolls back its occurrence so a retry can create and deliver exactly once',async()=>{
 const f=await fixture();try{
  await f.pg.exec('REVOKE INSERT ON public.outbox_events FROM kavosh_runtime');try{assert.equal((await f.work()).outcome,'retry');}finally{await f.pg.exec('GRANT INSERT ON public.outbox_events TO kavosh_runtime');}
  assert.equal((await f.pg.query('SELECT * FROM public.session_reminder_occurrences')).rows.length,0);assert.equal((await f.pg.query('SELECT * FROM public.notification_jobs')).rows.length,0);
  await f.ready();assert.equal((await f.work()).outcome,'queued',JSON.stringify(f.errors));assert.equal((await f.deliver()).outcome,'succeeded');assert.equal((await f.pg.query('SELECT * FROM public.session_reminder_occurrences')).rows.length,1);
 }finally{await f.pg.close();}
});
test('canceling or rescheduling before delivery rejects the old reminder and a new due revision can be queued',async()=>{
 const f=await fixture();try{
  assert.equal((await f.work()).outcome,'queued',JSON.stringify(f.errors));assert.equal((await f.changeSession(2,{kind:'cancel'})).response.status,200);assert.equal((await f.deliver()).outcome,'cancelled');assert.equal((await f.request('notifications?origin=automation',undefined,'staff')).body.data.length,0);
  assert.equal((await f.changeSession(3,{kind:'restore'})).response.status,200);await f.ready();assert.equal((await f.work()).outcome,'queued',JSON.stringify(f.errors));assert.equal((await f.deliver()).outcome,'succeeded');assert.equal((await f.request('notifications?origin=automation',undefined,'staff')).body.data.length,1);
 }finally{await f.pg.close();}
});
test('rescheduling a queued class supersedes its old reminder while another actually due time receives fresh delivery',async()=>{
 const f=await fixture();try{
  assert.equal((await f.work()).outcome,'queued',JSON.stringify(f.errors));const start=f.start.subtract({minutes:1}),end=f.end.subtract({minutes:1});assert.equal((await f.changeSession(2,{kind:'reschedule',start:f.local(start),end:f.local(end)})).response.status,200);
  assert.equal((await f.deliver()).outcome,'cancelled');await f.ready();assert.equal((await f.work()).outcome,'queued',JSON.stringify(f.errors));assert.equal((await f.deliver()).outcome,'succeeded');assert.equal((await f.request('notifications?origin=automation',undefined,'staff')).body.data.length,1);assert.equal((await f.pg.query('SELECT * FROM public.session_reminder_occurrences')).rows.length,2);
 }finally{await f.pg.close();}
});
test('native timer records remain tenant-private and cannot be reserved or rewritten by a web request',async()=>{
 const f=await fixture();try{
  assert.equal((await f.work()).outcome,'queued',JSON.stringify(f.errors));
  await f.pg.exec('BEGIN');try{await f.pg.exec('SET LOCAL ROLE kavosh_runtime');await f.pg.query("SELECT set_config('app.academy_id',$1,true)",[f.a]);assert.equal((await f.pg.query('SELECT * FROM public.session_reminder_occurrences')).rows.length,1);
   for(const sql of ['INSERT INTO public.session_reminder_occurrences SELECT * FROM public.session_reminder_occurrences','UPDATE public.session_reminder_occurrences SET source_stamp=source_stamp','DELETE FROM public.session_reminder_occurrences']){await f.pg.exec('SAVEPOINT hostile');await assert.rejects(f.pg.exec(sql));await f.pg.exec('ROLLBACK TO SAVEPOINT hostile');}
   await f.pg.query("SELECT set_config('app.academy_id',$1,true)",[f.b]);assert.equal((await f.pg.query('SELECT * FROM public.session_reminder_occurrences')).rows.length,0);
  }finally{await f.pg.exec('ROLLBACK');}
 }finally{await f.pg.close();}
});
test('native deferred completeness refuses an occurrence reservation without its matching audited timer event',async()=>{
 const f=await fixture();try{
  await f.pg.exec('BEGIN');try{await f.pg.exec('SET LOCAL ROLE kavosh_automation_worker');await f.pg.query("SELECT set_config('app.academy_id',$1,true)",[f.a]);const lease=(await f.pg.query<{id:string;lease_token:string}>('SELECT * FROM public.claim_automation_subscription($1)',[[f.a]])).rows[0];assert.ok(lease);
   await f.pg.query('INSERT INTO public.session_reminder_occurrences(academy_id,id,subscription_id,lease_token,rule_id,rule_version,session_id,request_id,minutes_before,max_delay_minutes) VALUES($1,gen_random_uuid(),$2,$3,$4,2,$5,gen_random_uuid(),4,2)',[f.a,lease.id,lease.lease_token,f.rule.id,f.c.session.id]);
   await assert.rejects(f.pg.exec('SET CONSTRAINTS session_reminder_complete IMMEDIATE'),/SESSION_REMINDER_EVENT_REQUIRED/);
  }finally{await f.pg.exec('ROLLBACK');}
  assert.equal((await f.pg.query('SELECT * FROM public.session_reminder_occurrences')).rows.length,0);assert.equal((await f.work()).outcome,'queued',JSON.stringify(f.errors));
 }finally{await f.pg.close();}
});
test('tiny real cancellation race serializes behind current reminder delivery instead of changing the session mid-send',{skip:!process.env.TEST_DATABASE_URL},async()=>{
 const f=await fixture();let resume!:()=>void,reached!:()=>void;const gate=new Promise<void>(resolve=>resume=resolve),prepared=new Promise<void>(resolve=>reached=resolve);let delivery:ReturnType<typeof processOneNotification>|undefined,cancellation:ReturnType<typeof f.changeSession>|undefined;
 try{
  assert.equal((await f.work()).outcome,'queued',JSON.stringify(f.errors));const database:Database={async connect(){const c=await f.database.connect();return {async query<Row>(sql:string,params?:unknown[]){if(sql.startsWith('INSERT INTO public.portal_notifications')){reached();await gate;}return c.query<Row>(sql,params);},release(destroy?:boolean){c.release(destroy);}};}};
  const began=performance.now();delivery=processOneNotification(database,[f.a]);await Promise.race([prepared,delay(2000).then(()=>{throw new Error('REMINDER_DID_NOT_REACH_DELIVERY');})]);cancellation=f.changeSession(2,{kind:'cancel'});
  let blocked=false;for(let i=0;i<100&&!blocked;i++){blocked=(await f.pg.query<{blocked:boolean}>("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND state='active' AND wait_event_type='Lock' AND query LIKE 'SELECT * FROM public.classes%' AND query LIKE '%FOR UPDATE') blocked")).rows[0].blocked;if(!blocked)await delay(5);}
  assert.equal(blocked,true,'native activity must show the actual cancellation waiting on the protected class row');resume();assert.equal((await delivery).outcome,'succeeded');assert.equal((await cancellation).response.status,200);assert.equal((await f.request(f.path,undefined,'staff')).body.data.status,'cancelled');assert.equal((await f.request('notifications?origin=automation',undefined,'staff')).body.data.length,1);console.log(JSON.stringify({case:'reminder-delivery-vs-cancellation',elapsedMs:Math.round(performance.now()-began)}));
 }finally{resume();await Promise.allSettled([delivery,cancellation].filter(Boolean));await f.pg.close();}
});
test('actual isolated daemon generates and delivers a due class reminder without an API tick or provider credentials',{skip:!process.env.TEST_DATABASE_URL},async()=>{
 const f=await fixture();let child:ReturnType<typeof spawn>|undefined,login:string|undefined;try{
  const idleRule=await f.request('automations/rules',{hubId:f.hub,code:'IDLE_BEFORE_TIMER',definition:{...f.definition,sessionReminder:undefined,trigger:{kind:'domain_event',eventTypes:['unused.event']}},reason:'Check fairness across active watchers'});assert.equal(idleRule.response.status,201);const idle=await f.request('automations/rules/'+idleRule.body.data.id+'/subscriptions',{expectedVersion:1,reason:'Idle rule must not delay another due watcher'});assert.equal(idle.response.status,201);
  await f.pg.exec('BEGIN');try{await f.pg.exec('SET LOCAL ROLE kavosh_automation_policy');await f.pg.query("UPDATE public.automation_subscriptions SET available_at=clock_timestamp()-interval '1 second' WHERE id=$1",[idle.body.data.id]);await f.pg.exec('COMMIT');}catch(error){await f.pg.exec('ROLLBACK');throw error;}
  const database=(await f.pg.query<{name:string}>('SELECT current_database() name')).rows[0].name;assert.match(database,/^kavosh_test_[a-f0-9]{32}$/);login='kavosh_remind_'+randomUUID().replaceAll('-','');const password='synthetic_only_'+randomUUID().replaceAll('-','');await f.pg.exec(`CREATE ROLE ${login} LOGIN NOSUPERUSER NOCREATEROLE NOCREATEDB NOREPLICATION NOBYPASSRLS PASSWORD '${password}';GRANT kavosh_automation_worker TO ${login}`);
  const url=new URL(process.env.TEST_DATABASE_URL!);url.username=login;url.password=password;url.pathname='/'+database;let output='';const command=process.env.NOTIFICATION_WORKER_COMPILED_ENTRY?[process.env.NOTIFICATION_WORKER_COMPILED_ENTRY]:['--import','tsx','scripts/process-notifications.ts'];
  child=spawn(process.execPath,command,{cwd:process.cwd(),env:{PATH:process.env.PATH,NODE_ENV:'test',DATABASE_SSL_MODE:'disable',NOTIFICATION_WORKER_ENABLED:'true',NOTIFICATION_SUBSCRIPTIONS_ENABLED:'true',NOTIFICATION_WORKER_DATABASE_URL:url.toString(),NOTIFICATION_WORKER_ACADEMIES:JSON.stringify([f.a])},stdio:['ignore','ignore','pipe']});child.stderr?.on('data',data=>{if(output.length<2000)output+=String(data).slice(0,2000-output.length);});const exited=new Promise<number|null>(resolve=>child!.once('exit',resolve));
  let done=false;for(let i=0;i<100;i++){if((await f.pg.query("SELECT * FROM public.notification_jobs WHERE status='succeeded'")).rows.length){done=true;break;}if(child.exitCode!==null)break;await delay(50);}assert.ok(done,'Isolated class reminder did not complete: '+output);assert.equal((await f.pg.query('SELECT * FROM public.session_reminder_occurrences')).rows.length,1);assert.equal((await f.request('notifications?origin=automation',undefined,'staff')).body.data.length,1);
  const timing=(await f.pg.query<{elapsed_ms:string;idle_backoff:boolean}>("SELECT(extract(epoch FROM(o.created_at-(s.available_at-interval '10 seconds')))*1000)::text elapsed_ms,s.available_at>clock_timestamp()+interval '1 second' idle_backoff FROM public.session_reminder_occurrences o CROSS JOIN public.automation_subscriptions s WHERE s.id=$1",[idle.body.data.id])).rows[0];assert.equal(timing.idle_backoff,true);assert.ok(Number(timing.elapsed_ms)>=0);console.log(JSON.stringify({case:'idle-watcher-to-due-reminder',elapsedMs:Math.round(Number(timing.elapsed_ms))}));
  child.kill('SIGTERM');assert.equal(await Promise.race([exited,delay(2000,undefined,{ref:false}).then(()=>-1)]),0);assert.doesNotMatch(output,/postgresql:|synthetic_only_|password|token_hash/i);
 }finally{if(child&&child.exitCode===null){child.kill('SIGKILL');await new Promise(resolve=>child!.once('exit',resolve));}if(login)await f.pg.exec('DROP ROLE '+login);await f.pg.close();}
});
test('stopping a watcher during timer creation rolls back the occurrence,event and queue together',{skip:!process.env.TEST_DATABASE_URL},async()=>{
 const f=await fixture();let resume!:()=>void,reached!:()=>void;const gate=new Promise<void>(resolve=>resume=resolve),prepared=new Promise<void>(resolve=>reached=resolve);let working:ReturnType<typeof processOneSubscription>|undefined;
 try{
  const database:Database={async connect(){const c=await f.database.connect();return {async query<Row>(sql:string,params?:unknown[]){if(sql.startsWith('INSERT INTO public.notification_jobs')){reached();await gate;}return c.query<Row>(sql,params);},release(destroy?:boolean){c.release(destroy);}};}};
  working=processOneSubscription(database,[f.a]);await Promise.race([prepared,delay(2000).then(()=>{throw new Error('TIMER_DID_NOT_REACH_QUEUE');})]);const stopped=await Promise.race([f.request('automations/subscriptions/'+f.sub.id+'/stop',{}),delay(1000,undefined,{ref:false}).then(()=>{throw new Error('STOP_BLOCKED_BY_TIMER');})]);assert.equal(stopped.response.status,200);resume();assert.equal((await working).recorded,false);
  assert.equal((await f.pg.query('SELECT * FROM public.session_reminder_occurrences')).rows.length,0);assert.equal((await f.pg.query("SELECT * FROM public.automation_event_sources WHERE event_type='session.reminder_due'")).rows.length,0);assert.equal((await f.pg.query('SELECT * FROM public.notification_jobs')).rows.length,0);
 }finally{resume();await Promise.allSettled([working].filter(Boolean));await f.pg.close();}
});
