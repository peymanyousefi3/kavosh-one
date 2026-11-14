import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { notificationFixture } from './notification-fixture.ts';
import { processOneSubscription } from '../src/automations/subscription-worker.ts';
import { processOneNotification } from '../src/automations/notification-worker.ts';
import type { Connection,Database } from '../src/core/database.ts';

async function fixture(){const f=await notificationFixture(),errors:{message:string;sql:string}[]=[];const database:Database={async connect(){const c=f.pg.runtime?await f.pg.runtime.connect():{query:f.pg.query.bind(f.pg),release(){}};await c.query('SET ROLE kavosh_automation_worker');return {async query<Row>(sql:string,params?:unknown[]){try{return await c.query<Row>(sql,params);}catch(error){errors.push({message:(error as Error).message,sql:sql.slice(0,140)});throw error;}},release(destroy?:boolean){c.release(destroy);}};}};
 const work=async()=>{try{return await processOneSubscription(database,[f.a]);}finally{if(!f.pg.runtime)await f.pg.exec('RESET ROLE');}},deliver=async()=>{try{return await processOneNotification(database,[f.a]);}finally{if(!f.pg.runtime)await f.pg.exec('RESET ROLE');}};
 const subscribe=(rule:string,as='master')=>f.request('automations/rules/'+rule+'/subscriptions',{expectedVersion:1,reason:'Watch approved automatic rule'},as);
 const ready=async(id:string)=>{await f.pg.exec('BEGIN');try{await f.pg.exec('SET LOCAL ROLE kavosh_automation_policy');await f.pg.query("UPDATE public.automation_subscriptions SET available_at=clock_timestamp()-interval '1 second' WHERE id=$1",[id]);await f.pg.exec('COMMIT');}catch(error){await f.pg.exec('ROLLBACK');throw error;}};
 return {...f,database,work,deliver,subscribe,ready,errors};}
test('watcher queries reject repeated pagination selectors without changing subscriptions or queueing work',async()=>{
 const f=await fixture();try{
  const r=await f.rule(),s=await f.subscribe(r.id);assert.equal(s.response.status,201);const before=(await f.pg.query('SELECT * FROM public.automation_subscriptions ORDER BY id')).rows;
  for(const query of ['?limit=1&limit=2','?after='+randomUUID()+'&after='+randomUUID()]){const result=await f.request('automations/rules/'+r.id+'/subscriptions'+query);assert.equal(result.response.status,400);assert.equal(result.body.error.code,'DUPLICATE_QUERY');}
  assert.deepEqual((await f.pg.query('SELECT * FROM public.automation_subscriptions ORDER BY id')).rows,before);assert.equal((await f.pg.query('SELECT * FROM public.notification_jobs')).rows.length,0);
 }finally{await f.pg.close();}
});
test('approved watcher starts at activation,queues each new authorized event once and uses the existing delivery worker',async()=>{
 const f=await fixture();try{
  const r=await f.rule(),old=await f.source(),s=await f.subscribe(r.id);assert.equal(s.response.status,201,JSON.stringify(s.body));assert.equal(s.body.data.historicalBackfill,false);assert.doesNotMatch(JSON.stringify(s.body),/credential_id|user_id|initial_snapshot|activation_transaction|lease_token/);const first=await f.work();assert.equal(first.outcome,'idle',JSON.stringify(f.errors));assert.equal((await f.pg.query('SELECT * FROM public.notification_jobs')).rows.length,0);
  const event=await f.source();await f.ready(s.body.data.id);const worked=await f.work();assert.equal(worked.outcome,'queued',JSON.stringify(worked));assert.equal((await f.pg.query('SELECT event_id FROM public.notification_jobs')).rows[0].event_id,event.id);assert.equal((await f.pg.query('SELECT * FROM public.automation_subscription_events WHERE event_id=$1',[old.id])).rows.length,0);
  assert.equal((await f.deliver()).outcome,'succeeded');assert.equal((await f.pg.query("SELECT * FROM public.portal_notifications WHERE origin='automation'")).rows.length,2);assert.equal((await f.work()).outcome,'idle');assert.equal((await f.pg.query('SELECT * FROM public.notification_jobs')).rows.length,1);
 }finally{await f.pg.close();}
});
test('bot watcher requires upper review and keeps its own credential;revocation suspends without borrowing approver authority',async()=>{
 const f=await fixture();try{
  const r=await f.rule(),pending=await f.subscribe(r.id,'bot');assert.equal(pending.response.status,202,JSON.stringify(pending.body));assert.equal((await f.pg.query('SELECT * FROM public.automation_subscriptions')).rows.length,0);
  const approved=await f.approve(pending.body.approval.id,'manager');assert.equal(approved.response.status,200,JSON.stringify(approved.body));const id=approved.body.data.id;
  const owner=(await f.pg.query('SELECT owner_id,credential_id FROM public.automation_subscriptions')).rows[0];assert.equal(owner.owner_id,f.bot);assert.equal(owner.credential_id,f.credential);
  await f.pg.query('UPDATE auth_private.credentials SET revoked_at=clock_timestamp() WHERE id=$1',[f.credential]);const result=await f.work();assert.equal(result.outcome,'authorization_lost',JSON.stringify(f.errors));assert.equal((await f.request('automations/subscriptions/'+id)).body.data.status,'authorization_lost');assert.equal((await f.pg.query('SELECT * FROM public.notification_jobs')).rows.length,0);
 }finally{await f.pg.close();}
});
test('human-session verification and current execute permission remain mandatory for persistent work',async()=>{
 const f=await fixture();try{
  const r=await f.rule(),pending=await f.subscribe(r.id,'staff');assert.equal(pending.response.status,202);const approved=await f.approve(pending.body.approval.id,'manager');assert.equal(approved.response.status,200,JSON.stringify(approved.body));
  await f.pg.query("DELETE FROM public.role_permissions WHERE role_id=$1 AND capability='automations.execute'",[f.staffRole]);assert.equal((await f.work()).outcome,'authorization_lost');assert.equal((await f.pg.query('SELECT * FROM public.notification_jobs')).rows.length,0);
  const second=await f.subscribe(r.id);assert.equal(second.response.status,201);await f.pg.query('UPDATE identity."user" SET "phoneNumberVerified"=false WHERE id=$1',[f.actors.master.user]);assert.equal((await f.work()).outcome,'authorization_lost');assert.equal((await f.pg.query('SELECT * FROM public.notification_jobs')).rows.length,0);
 }finally{await f.pg.close();}
});
test('owner or upper stop prevents future claims,keeps history and permits a newly reviewed fresh watcher',async()=>{
 const f=await fixture();try{
  const r=await f.rule(),pending=await f.subscribe(r.id,'staff'),approved=await f.approve(pending.body.approval.id,'manager');assert.equal(approved.response.status,200);const id=approved.body.data.id;
  assert.equal((await f.request('automations/subscriptions/'+id+'/stop',{},'peer')).response.status,404);
  const stopped=await f.request('automations/subscriptions/'+id+'/stop',{},'manager');assert.equal(stopped.response.status,200,JSON.stringify(stopped.body));assert.equal(stopped.body.existingJobsCancelled,false);assert.equal(stopped.body.data.status,'stopped');assert.equal((await f.work()).claimed,false);
  assert.equal((await f.request('automations/subscriptions/'+id+'/stop',{},'manager')).response.status,200);const next=await f.subscribe(r.id,'staff');assert.equal(next.response.status,202);assert.equal((await f.approve(next.body.approval.id,'manager')).response.status,200);assert.equal((await f.pg.query('SELECT * FROM public.automation_subscriptions')).rows.length,2);
 }finally{await f.pg.close();}
});
test('watcher creation is exact,duplicate-safe and atomic with its audit/outbox and rejects caller identity injection',async()=>{
 const f=await fixture();try{
  const r=await f.rule(),path='automations/rules/'+r.id+'/subscriptions',key=randomUUID(),input={expectedVersion:1,reason:'Reviewed watch'};
  for(const extra of [{ownerId:f.bot},{credentialId:f.credential},{initialSnapshot:'1:2:'},{expectedVersion:0},{send:true}])assert.equal((await f.request(path,{...input,...extra})).response.status,400);
  await f.pg.exec('REVOKE INSERT ON public.outbox_events FROM kavosh_runtime');try{assert.equal((await f.request(path,input,'master',{key})).response.status,503);}finally{await f.pg.exec('GRANT INSERT ON public.outbox_events TO kavosh_runtime');}assert.equal((await f.pg.query('SELECT * FROM public.automation_subscriptions')).rows.length,0);
  const created=await f.request(path,input,'master',{key});assert.equal(created.response.status,201);assert.deepEqual((await f.request(path,input,'master',{key})).body,created.body);assert.equal((await f.subscribe(r.id)).response.status,409);assert.equal((await f.pg.query('SELECT * FROM public.automation_subscriptions')).rows.length,1);
  assert.equal((await f.request('automations/subscriptions/'+created.body.data.id,undefined,'foreignMaster',{academy:f.b})).response.status,404);
 }finally{await f.pg.close();}
});
test('worker failure rolls back queued work before bounded retry and never consumes its source event',async()=>{
 const f=await fixture();try{
  const r=await f.rule(),s=await f.subscribe(r.id),event=await f.source();assert.equal(s.response.status,201);
  await f.pg.exec('REVOKE INSERT ON public.outbox_events FROM kavosh_runtime');try{assert.equal((await f.work()).outcome,'retry');}finally{await f.pg.exec('GRANT INSERT ON public.outbox_events TO kavosh_runtime');}
  assert.equal((await f.pg.query('SELECT * FROM public.notification_jobs')).rows.length,0);assert.equal((await f.pg.query('SELECT * FROM public.automation_subscription_events')).rows.length,0);await f.ready(s.body.data.id);assert.equal((await f.work()).outcome,'queued');assert.equal((await f.pg.query('SELECT event_id FROM public.notification_jobs')).rows[0].event_id,event.id);
 }finally{await f.pg.close();}
});
test('snapshot watcher retains a late commit even after processing a newer committed event',{skip:!process.env.TEST_DATABASE_URL},async()=>{
 const f=await fixture();let late:Connection|undefined;try{
  const r=await f.rule({trigger:{kind:'domain_event',eventTypes:['synthetic.*']}},'LATE_COMMIT');
  const publish=async(c:Connection,action:string)=>{const entity=randomUUID(),request=randomUUID(),event=randomUUID();await c.query("SELECT set_config('app.academy_id',$1,true)",[f.a]);await c.query(`INSERT INTO public.audit_events(academy_id,id,actor_id,session_id,actor_kind,request_id,action,entity_id,hub_id,changes) VALUES($1,$2,$3,$4,'human',$5,$6,$7,$8,'{}')`,[f.a,randomUUID(),f.actors.master.person,f.actors.master.session,request,action,entity,f.hub]);await c.query('INSERT INTO public.outbox_events(academy_id,id,event_type,entity_id,request_id) VALUES($1,$2,$3,$4,$5)',[f.a,event,action,entity,request]);return event;};
  late=await f.pg.runtime!.connect();await late.query('BEGIN');const first=await publish(late,'synthetic.late');const s=await f.subscribe(r.id);assert.equal(s.response.status,201);const early=await f.pg.runtime!.connect();let second:string;try{await early.query('BEGIN');second=await publish(early,'synthetic.early');await early.query('COMMIT');}finally{early.release();}
  assert.equal((await f.work()).outcome,'queued',JSON.stringify(f.errors));assert.equal((await f.pg.query('SELECT event_id FROM public.notification_jobs')).rows[0].event_id,second);
  await late.query('COMMIT');late.release();late=undefined;assert.equal((await f.work()).outcome,'queued',JSON.stringify(f.errors));assert.deepEqual((await f.pg.query<{event_id:string}>('SELECT event_id FROM public.notification_jobs')).rows.map(r=>r.event_id).sort(),[first,second].sort());
  const timing=(await f.pg.query<{older:boolean;captured_before_activation:boolean;visible_at_activation:boolean}>('SELECT a.occurred_at<b.occurred_at older,a.occurred_at<s.created_at captured_before_activation,pg_visible_in_snapshot(a.origin_transaction,s.initial_snapshot) visible_at_activation FROM public.automation_event_sources a CROSS JOIN public.automation_event_sources b CROSS JOIN public.automation_subscriptions s WHERE a.event_id=$1 AND b.event_id=$2 AND s.id=$3',[first,second,s.body.data.id])).rows[0];assert.equal(timing.older,true);assert.equal(timing.captured_before_activation,true);assert.equal(timing.visible_at_activation,false);assert.equal((await f.pg.query('SELECT * FROM public.automation_subscription_events')).rows.length,2);
 }finally{if(late){await late.query('ROLLBACK');late.release();}await f.pg.close();}
});
test('tiny simultaneous watcher steps claim once and retain one queue operation',{skip:!process.env.TEST_DATABASE_URL},async()=>{
 const f=await fixture();try{const r=await f.rule(),s=await f.subscribe(r.id);assert.equal(s.response.status,201);await f.source();const began=performance.now(),result=await Promise.all([f.work(),f.work()]);assert.equal(result.filter(r=>r.claimed).length,1);assert.equal((await f.pg.query('SELECT * FROM public.notification_jobs')).rows.length,1);const stopped=await Promise.all([f.request('automations/subscriptions/'+s.body.data.id+'/stop',{}),f.request('automations/subscriptions/'+s.body.data.id+'/stop',{})]);assert.ok(stopped.every(r=>r.response.status===200));assert.equal((await f.pg.query("SELECT * FROM public.audit_events WHERE action='automation.subscription.stopped'")).rows.length,1);console.log(JSON.stringify({case:'subscription-two-workers-and-two-stops',elapsedMs:Math.round(performance.now()-began)}));}finally{await f.pg.close();}
});
test('native watcher ownership,snapshots,receipts and broker functions cannot be forged by the web role',async()=>{
 const f=await fixture();try{
  const r=await f.rule(),s=await f.subscribe(r.id);assert.equal(s.response.status,201);await f.pg.exec('BEGIN');try{await f.pg.query("SELECT set_config('app.academy_id',$1,true)",[f.a]);await f.pg.exec('SET LOCAL ROLE kavosh_runtime');
   for(const sql of ["UPDATE public.automation_subscriptions SET initial_snapshot=pg_current_snapshot()","UPDATE public.automation_subscriptions SET owner_id=gen_random_uuid()","UPDATE public.automation_subscriptions SET status='stopped'","DELETE FROM public.automation_subscriptions","INSERT INTO public.automation_subscription_events SELECT * FROM public.automation_subscription_events","SELECT * FROM public.claim_automation_subscription(ARRAY[]::uuid[])"]){await f.pg.exec('SAVEPOINT hostile');await assert.rejects(f.pg.exec(sql));await f.pg.exec('ROLLBACK TO SAVEPOINT hostile');}
   await f.pg.query("SELECT set_config('app.academy_id',$1,true)",[f.b]);assert.equal((await f.pg.query('SELECT * FROM public.automation_subscriptions')).rows.length,0);
  }finally{await f.pg.exec('ROLLBACK');}
 }finally{await f.pg.close();}
});
test('stop during a watcher step fences commit and rolls back its prepared queue operation',{skip:!process.env.TEST_DATABASE_URL},async()=>{
 const f=await fixture();try{
  const r=await f.rule(),s=await f.subscribe(r.id);assert.equal(s.response.status,201);await f.source();let stopped=false;
  const database:Database={async connect(){const c=await f.database.connect();return {async query<Row>(sql:string,params?:unknown[]){const result=await c.query<Row>(sql,params);if(!stopped&&sql.includes('ORDER BY e.origin_transaction,e.event_id LIMIT 1')){stopped=true;assert.equal((await f.request('automations/subscriptions/'+s.body.data.id+'/stop',{})).response.status,200);}return result;},release(destroy?:boolean){c.release(destroy);}};}};
  const result=await processOneSubscription(database,[f.a]);assert.equal(stopped,true);assert.equal(result.recorded,false);assert.equal((await f.pg.query('SELECT * FROM public.notification_jobs')).rows.length,0);assert.equal((await f.pg.query('SELECT * FROM public.automation_subscription_events')).rows.length,0);assert.equal((await f.request('automations/subscriptions/'+s.body.data.id)).body.data.status,'stopped');
 }finally{await f.pg.close();}
});
test('five real transient failures stop retries without consuming events or leaving partial jobs',async()=>{
 const f=await fixture();try{
  const r=await f.rule(),s=await f.subscribe(r.id);await f.source();await f.pg.exec('REVOKE INSERT ON public.outbox_events FROM kavosh_runtime');try{for(let i=0;i<5;i++){await f.ready(s.body.data.id);assert.equal((await f.work()).outcome,'retry');}}finally{await f.pg.exec('GRANT INSERT ON public.outbox_events TO kavosh_runtime');}
  const status=await f.request('automations/subscriptions/'+s.body.data.id);assert.equal(status.body.data.status,'failed');assert.equal(status.body.data.failure_count,5);assert.equal(status.body.data.last_error,'PROCESSING_UNAVAILABLE');assert.equal((await f.work()).claimed,false);assert.equal((await f.pg.query('SELECT * FROM public.notification_jobs')).rows.length,0);assert.equal((await f.pg.query('SELECT * FROM public.automation_subscription_events')).rows.length,0);
 }finally{await f.pg.close();}
});
test('watcher migration preserves real prior event projections without inventing historical transaction origins',async()=>{
 const f=await notificationFixture({throughSchema:124});try{
  await f.rule({},'BEFORE_WATCH_MIGRATION');const old=await f.source(),before=(await f.pg.query('SELECT event_id,audit_id,projection FROM public.automation_event_sources ORDER BY event_id')).rows;assert.ok(before.length);
  await f.pg.exec(await readFile(new URL('../db/migrations/125_automation_subscriptions.sql',import.meta.url),'utf8'));assert.deepEqual((await f.pg.query('SELECT event_id,audit_id,projection FROM public.automation_event_sources ORDER BY event_id')).rows,before);assert.equal((await f.pg.query('SELECT * FROM public.automation_event_sources WHERE origin_transaction IS NOT NULL')).rows.length,0);
  const fresh=await f.source();assert.notEqual(fresh.id,old.id);assert.equal((await f.pg.query('SELECT origin_transaction IS NOT NULL recorded FROM public.automation_event_sources WHERE event_id=$1',[fresh.id])).rows[0].recorded,true);assert.equal((await f.pg.query('SELECT * FROM public.automation_subscriptions')).rows.length,0);
 }finally{await f.pg.close();}
});
test('actual isolated daemon watches a new event,queues it and delivers the portal notice',{skip:!process.env.TEST_DATABASE_URL},async()=>{
 const f=await fixture();let child:ReturnType<typeof spawn>|undefined,login:string|undefined;try{
  const r=await f.rule();assert.equal((await f.subscribe(r.id)).response.status,201);const event=await f.source(),database=(await f.pg.query<{name:string}>('SELECT current_database() name')).rows[0].name;assert.match(database,/^kavosh_test_[a-f0-9]{32}$/);
  login='kavosh_watch_'+randomUUID().replaceAll('-','');const password='synthetic_only_'+randomUUID().replaceAll('-','');await f.pg.exec(`CREATE ROLE ${login} LOGIN NOSUPERUSER NOCREATEROLE NOCREATEDB NOREPLICATION NOBYPASSRLS PASSWORD '${password}';GRANT kavosh_automation_worker TO ${login}`);
  const url=new URL(process.env.TEST_DATABASE_URL!);url.username=login;url.password=password;url.pathname='/'+database;let output='';
  const command=process.env.NOTIFICATION_WORKER_COMPILED_ENTRY?[process.env.NOTIFICATION_WORKER_COMPILED_ENTRY]:['--import','tsx','scripts/process-notifications.ts'];child=spawn(process.execPath,command,{cwd:process.cwd(),env:{PATH:process.env.PATH,NODE_ENV:'test',DATABASE_SSL_MODE:'disable',NOTIFICATION_WORKER_ENABLED:'true',NOTIFICATION_SUBSCRIPTIONS_ENABLED:'true',NOTIFICATION_WORKER_DATABASE_URL:url.toString(),NOTIFICATION_WORKER_ACADEMIES:JSON.stringify([f.a])},stdio:['ignore','ignore','pipe']});child.stderr?.on('data',data=>{if(output.length<2000)output+=String(data).slice(0,2000-output.length);});const exited=new Promise<number|null>(resolve=>child!.once('exit',resolve));
  let done=false;for(let i=0;i<100;i++){const jobs=(await f.pg.query<{status:string}>('SELECT status FROM public.notification_jobs WHERE event_id=$1',[event.id])).rows;if(jobs.some(j=>j.status==='succeeded')){done=true;break;}if(child.exitCode!==null)break;await delay(50);}assert.ok(done,'Isolated watcher did not complete: '+output);assert.equal((await f.pg.query('SELECT * FROM public.automation_subscription_events WHERE event_id=$1',[event.id])).rows.length,1);assert.equal((await f.pg.query("SELECT * FROM public.portal_notifications WHERE origin='automation'")).rows.length,2);
  child.kill('SIGTERM');assert.equal(await Promise.race([exited,delay(2000,undefined,{ref:false}).then(()=>-1)]),0);assert.doesNotMatch(output,/postgresql:|synthetic_only_|password|token_hash/i);
 }finally{if(child&&child.exitCode===null){child.kill('SIGKILL');await new Promise(resolve=>child!.once('exit',resolve));}if(login)await f.pg.exec('DROP ROLE '+login);await f.pg.close();}
});
test('watcher follows a newly approved rule version while preserving its original activation evidence',async()=>{
 const f=await fixture();try{
  const r=await f.rule(),s=await f.subscribe(r.id);assert.equal(s.response.status,201);const changed=await f.request('automations/rules/'+r.id+'/change',{expectedVersion:1,definition:{...r.definition,actions:r.definition.actions.map((a:Record<string,unknown>)=>({...a,title:{en:'New approved version'}}))},reason:'Approve updated message'});assert.equal(changed.response.status,200,JSON.stringify(changed.body));const event=await f.source();
  assert.equal((await f.work()).outcome,'ignored');assert.equal((await f.work()).outcome,'queued',JSON.stringify(f.errors));const job=(await f.pg.query('SELECT event_id,rule_version FROM public.notification_jobs')).rows[0];assert.equal(job.event_id,event.id);assert.equal(job.rule_version,2);assert.equal((await f.deliver()).outcome,'succeeded');assert.equal((await f.request('notifications?origin=automation',undefined,'staff')).body.data[0].title,'New approved version');const read=await f.request('automations/subscriptions/'+s.body.data.id);assert.equal(read.body.data.rule_version,1);assert.equal(read.body.data.currentRuleVersion,2);
 }finally{await f.pg.close();}
});
