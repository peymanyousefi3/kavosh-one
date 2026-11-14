import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { notificationFixture } from './notification-fixture.ts';
import { processOneNotification } from '../src/automations/notification-worker.ts';
import type { Database } from '../src/core/database.ts';

async function created(f:Awaited<ReturnType<typeof notificationFixture>>,hubId=f.hub){const r=await f.request('people',{name:'PRIVATE synthetic person',email:'private@example.test',hubId});assert.equal(r.response.status,201,JSON.stringify(r.body));const row=(await f.pg.query<{event_id:string}>('SELECT event_id FROM public.automation_event_sources WHERE source_kind=\'audit\' AND projection->>\'entityId\'=$1',[r.body.data.id])).rows[0];assert.ok(row);return {id:row.event_id,person:r.body.data.id};}
test('new audit-backed activity feeds existing rules without copying private changes or lending source rights',async()=>{
 const f=await notificationFixture();try{
  await f.pg.query("INSERT INTO public.role_permissions VALUES($1,$2,'audit.view','allow')",[f.a,f.managerRole]);
  const rule=await f.rule({trigger:{kind:'domain_event',eventTypes:['person.created']}},'AUDITED');const event=await created(f),read=await f.request('automations/events/'+event.id);assert.equal(read.response.status,200);assert.equal(read.body.data.sourceKind,'audit');assert.equal(read.body.data.approvalId,null);assert.equal(read.body.data.sourceVerification,'database_bound_audit_event');assert.equal(read.body.data.currentStatus,'recorded');assert.equal(read.body.data.underlyingBusinessFactsIndependentlyVerified,false);assert.doesNotMatch(JSON.stringify(read.body),/PRIVATE|private@example|before|after|changes/);
  assert.equal((await f.request('automations/events/'+event.id,undefined,'staff')).response.status,404);
  const sent=await f.dispatch(rule.id,event.id);assert.equal(sent.response.status,201,JSON.stringify(sent.body));assert.equal(sent.body.data.summary.portalNotifications,1);assert.equal((await f.request('notifications?origin=automation',undefined,'staff')).body.data.length,0);
  const inbox=await f.request('notifications?origin=automation',undefined,'manager');assert.equal(inbox.body.data.length,1);assert.deepEqual(inbox.body.data[0].source,{kind:'audit',id:read.body.data.auditId});
  await f.pg.query("INSERT INTO public.role_permissions VALUES($1,$2,'audit.view','allow')",[f.a,f.staffRole]);const next=await created(f),queued=await f.request('automations/events/'+next.id+'/queue',{},'staff');assert.equal(queued.response.status,202,JSON.stringify(queued.body));assert.equal(queued.body.data.length,1);const job=queued.body.data[0].jobId;assert.equal((await f.request('automations/jobs/'+job,undefined,'staff')).response.status,200);
  const database:Database={async connect(){const c=f.pg.runtime?await f.pg.runtime.connect():{query:f.pg.query.bind(f.pg),release(){}};await c.query('SET ROLE kavosh_automation_worker');return c;}};
  try{assert.equal((await processOneNotification(database,[f.a])).outcome,'succeeded');}finally{if(!f.pg.runtime)await f.pg.exec('RESET ROLE');}
  assert.equal((await f.request('automations/jobs/'+job,undefined,'staff')).body.data.status,'succeeded');assert.equal((await f.request('notifications?origin=automation',undefined,'staff')).body.data.length,1);
  await f.pg.query("DELETE FROM public.role_permissions WHERE role_id=$1 AND capability='audit.view'",[f.managerRole]);assert.equal((await f.request('notifications?origin=automation',undefined,'manager')).body.data.length,0);assert.equal((await f.request('notifications/'+inbox.body.data[0].id,undefined,'manager')).response.status,404);assert.equal((await f.request('automations/rules/'+rule.id+'/runs',undefined,'manager')).body.data.length,0);
  await f.pg.query("DELETE FROM public.role_permissions WHERE role_id=$1 AND capability='audit.view'",[f.staffRole]);assert.equal((await f.request('automations/jobs/'+job,undefined,'staff')).response.status,404);
 }finally{await f.pg.close();}
});
test('audit scope and bot ceilings filter before cursor selection and never disclose other-school metadata',async()=>{
 const f=await notificationFixture();try{
  for(const role of [f.staffRole,f.managerRole])await f.pg.query("INSERT INTO public.role_permissions VALUES($1,$2,'audit.view','allow')",[f.a,role]);
  const hidden=await created(f,f.otherHub),own=await created(f),page=await f.request('automations/events?sourceKind=audit&eventType=person.created&limit=1',undefined,'staff');assert.equal(page.response.status,200,JSON.stringify(page.body));assert.deepEqual(page.body.data.map((e:{id:string})=>e.id),[own.id]);assert.equal(page.body.nextCursor,null);assert.equal((await f.request('automations/events/'+hidden.id,undefined,'staff')).response.status,404);assert.equal((await f.request('automations/events/'+own.id,undefined,'foreignMaster',{academy:f.b})).response.status,404);
  assert.equal((await f.request('automations/events/'+own.id,undefined,'bot')).response.status,200);await f.pg.query('INSERT INTO public.assignment_hubs(academy_id,assignment_id,hub_id) SELECT $1,id,$2 FROM public.role_assignments WHERE person_id=$3 AND role_id=$4',[f.a,f.otherHub,f.bot,f.managerRole]);await f.pg.query('UPDATE auth_private.credentials SET all_hubs=false WHERE id=$1',[f.credential]);await f.pg.query('INSERT INTO auth_private.credential_hubs VALUES($1,$2,$3)',[f.credential,f.a,f.otherHub]);assert.equal((await f.request('automations/events/'+own.id,undefined,'bot')).response.status,404);
 }finally{await f.pg.close();}
});
test('same-transaction unique audit binding rejects unbound,ambiguous and old outbox replays,and capture failure rolls back the activity',async()=>{
 const f=await notificationFixture();try{
  const event=await created(f),before=(await f.pg.query('SELECT * FROM public.automation_event_sources')).rows.length;
  await f.pg.query('INSERT INTO public.outbox_events(academy_id,id,event_type,entity_id,request_id) SELECT academy_id,$2,event_type,entity_id,request_id FROM public.outbox_events WHERE id=$1',[event.id,randomUUID()]);assert.equal((await f.pg.query('SELECT * FROM public.automation_event_sources')).rows.length,before);
  await f.pg.exec('BEGIN');try{const request=randomUUID(),entity=randomUUID();for(let i=0;i<2;i++)await f.pg.query("INSERT INTO public.audit_events(academy_id,id,actor_id,session_id,actor_kind,request_id,action,entity_id,hub_id,changes) VALUES($1,$2,$3,$4,'human',$5,'synthetic.changed',$6,$7,'{}')",[f.a,randomUUID(),f.actors.master.person,f.actors.master.session,request,entity,f.hub]);await f.pg.query("INSERT INTO public.outbox_events(academy_id,id,event_type,entity_id,request_id) VALUES($1,$2,'synthetic.changed',$3,$4)",[f.a,randomUUID(),entity,request]);await f.pg.exec('COMMIT');}catch(error){await f.pg.exec('ROLLBACK');throw error;}assert.equal((await f.pg.query('SELECT * FROM public.automation_event_sources')).rows.length,before);
  const count=(await f.pg.query('SELECT count(*)::int n FROM public.people')).rows[0].n;await f.pg.exec('REVOKE INSERT ON public.automation_event_sources FROM kavosh_event_policy');try{assert.equal((await f.request('people',{name:'PRIVATE must roll back',hubId:f.hub})).response.status,503);}finally{await f.pg.exec('GRANT INSERT ON public.automation_event_sources TO kavosh_event_policy');}assert.equal((await f.pg.query('SELECT count(*)::int n FROM public.people')).rows[0].n,count);
 }finally{await f.pg.close();}
});
test('audit capture migration preserves real prior approval events and never invents old activity snapshots',async()=>{
 const f=await notificationFixture({throughSchema:123});try{
  await f.rule({},'BEFORE_UPGRADE');const old=await f.request('people',{name:'PRIVATE old activity',hubId:f.hub});assert.equal(old.response.status,201);const before=(await f.pg.query('SELECT * FROM public.automation_event_sources ORDER BY event_id')).rows;assert.ok(before.length>0);
  await f.pg.exec(await readFile(new URL('../db/migrations/124_audited_automation_events.sql',import.meta.url),'utf8'));assert.deepEqual((await f.pg.query('SELECT * FROM public.automation_event_sources ORDER BY event_id')).rows,before);assert.equal((await f.pg.query("SELECT * FROM public.automation_event_sources WHERE source_kind='audit'")).rows.length,0);await created(f);assert.equal((await f.pg.query("SELECT * FROM public.automation_event_sources WHERE source_kind='audit'")).rows.length,1);
 }finally{await f.pg.close();}
});
