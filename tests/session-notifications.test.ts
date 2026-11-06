import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { reportFixture } from './report-fixture.ts';
import { processOneNotification } from '../src/automations/notification-worker.ts';
import type { Database } from '../src/core/database.ts';

import { sessionNotificationFixture as fixture } from './session-notification-fixture.ts';
test('dynamic guardian audience follows current effective enrollment and family authority,not a saved person list',async()=>{
 const f=await fixture('session_guardians');try{
  await f.pg.query('UPDATE public.people SET hub_id=$1 WHERE id=$2',[f.otherHub,f.guardian]);
  assert.equal((await f.changeSession(1,{kind:'cancel'})).response.status,200);assert.equal((await f.dispatch((await f.events())[0].id)).body.data.summary.portalNotifications,1);
  assert.equal((await f.request('enrollments/'+f.enrollment.id+'/change',{expectedVersion:1,joinsOn:'2026-01-03',reason:'Student joins after this session'})).response.status,200);
  assert.equal((await f.changeSession(2,{kind:'restore'})).response.status,200);assert.equal((await f.dispatch((await f.events()).find((e:{sourceVersion:number})=>e.sourceVersion===3).id)).body.data.summary.portalNotifications,0);
  assert.equal((await f.request('enrollments/'+f.enrollment.id+'/change',{expectedVersion:2,joinsOn:'2026-01-02',reason:'Restore actual effective membership'})).response.status,200);
  assert.equal((await f.request('family-relationships/'+f.relationship.id+'/suspend',{expectedVersion:1,reason:'Guardian authority withdrawn'})).response.status,200);
  assert.equal((await f.changeSession(3,{kind:'cancel'})).response.status,200);assert.equal((await f.dispatch((await f.events()).find((e:{sourceVersion:number})=>e.sourceVersion===4).id)).body.data.summary.portalNotifications,0);
 }finally{await f.pg.close();}
});
test('one guardian with two enrolled siblings receives one notice and retains access when only one child leaves',async()=>{
 const f=await fixture('session_guardians');try{
  const sibling=f.actors.manager.person;assert.equal((await f.request('students',{personId:sibling,legalName:'PRIVATE sibling',dateOfBirth:'2015-04-12',recruiter:{kind:'academy'}})).response.status,201);
  assert.equal((await f.request('students/'+sibling+'/guardians',{guardianId:f.guardian,relationship:'parent',reason:'Verified sibling relationship'})).response.status,201);
  assert.equal((await f.request('classes/'+f.c.id+'/enrollments',{studentId:sibling,studentProfileVersion:1,joinsOn:'2026-01-02',reason:'Sibling also attends this session'})).response.status,201);
  const access='people/'+f.guardian+'/access';assert.equal((await f.request(access,{expectedVersion:(await f.request(access)).body.data.version,assignments:[{roleId:f.parentRole,allHubs:false,personIds:[f.student,sibling]}]})).response.status,200);
  assert.equal((await f.changeSession(1,{kind:'cancel'})).response.status,200);assert.equal((await f.dispatch((await f.events())[0].id)).body.data.summary.portalNotifications,1,'two children do not duplicate the same action for their guardian');
  assert.equal((await f.request('enrollments/'+f.enrollment.id+'/change',{expectedVersion:1,joinsOn:'2026-01-03',reason:'One sibling joins later'})).response.status,200);
  assert.equal((await f.request('family-relationships/'+f.relationship.id+'/suspend',{expectedVersion:1,reason:'One relationship withdrawn'})).response.status,200);
  assert.equal((await f.changeSession(2,{kind:'restore'})).response.status,200);assert.equal((await f.dispatch((await f.events()).find((e:{sourceVersion:number})=>e.sourceVersion===3).id)).body.data.summary.portalNotifications,1);assert.equal((await f.request(f.path,undefined,'staff')).response.status,200,'other current child still grants authorized calendar access');
 }finally{await f.pg.close();}
});
test('audience migration preserves existing approved static definitions and permits a newly reviewed dynamic revision',async()=>{
 const f=await fixture(undefined,126);try{
  const before=(await f.pg.query('SELECT * FROM public.automation_rule_revisions WHERE rule_id=$1 ORDER BY version',[f.rule.id])).rows;
  await f.pg.exec(await readFile(new URL('../db/migrations/127_session_notification_audiences.sql',import.meta.url),'utf8'));assert.deepEqual((await f.pg.query('SELECT * FROM public.automation_rule_revisions WHERE rule_id=$1 ORDER BY version',[f.rule.id])).rows,before);
  await f.pg.exec(await readFile(new URL('../db/migrations/128_session_reminders.sql',import.meta.url),'utf8'));
  const prior=before[0].definition as {actions:{audience:unknown}[]},definition={...prior,trigger:{kind:'domain_event',eventTypes:['*']},actions:prior.actions.map(a=>({...a,audience:{kind:'session_guardians'}}))};const changed=await f.request('automations/rules/'+f.rule.id+'/change',{expectedVersion:1,definition,reason:'Use current class families instead of static audience'});assert.equal(changed.response.status,200,JSON.stringify(changed.body));assert.equal(changed.body.data.latestVersion,2);
  assert.equal((await f.changeSession(1,{kind:'cancel'})).response.status,200);const sent=await f.request('automations/rules/'+f.rule.id+'/dispatch',{eventId:(await f.events())[0].id,expectedVersion:2});assert.equal(sent.response.status,201);assert.equal(sent.body.data.summary.portalNotifications,1);
  const audit=(await f.request('automations/events?sourceKind=audit&limit=100')).body.data.find((e:{sample:{hubId:string|null}})=>e.sample.hubId===f.hub);assert.ok(audit);const unrelated=await f.request('automations/rules/'+f.rule.id+'/dispatch',{eventId:audit.id,expectedVersion:2});assert.equal(unrelated.response.status,201);assert.equal(unrelated.body.data.outcome,'processed');assert.equal(unrelated.body.data.summary.portalNotifications,0,'wildcard audit events cannot borrow class audiences from their entity ID');
 }finally{await f.pg.close();}
});
test('dynamic teaching audience follows inclusive session-day assignments and suppresses deactivated staff',async()=>{
 const f=await fixture('session_staff');try{
  assert.equal((await f.changeSession(1,{kind:'cancel'})).response.status,200);assert.equal((await f.dispatch((await f.events())[0].id)).body.data.summary.portalNotifications,1,'assignment ending on local session day is included even when UTC day is later');
  assert.equal((await f.request('class-staff/'+f.assignment.id+'/update',{expectedVersion:1,active:false,reason:'Teacher no longer assigned'})).response.status,200);
  assert.equal((await f.changeSession(2,{kind:'restore'})).response.status,200);assert.equal((await f.dispatch((await f.events()).find((e:{sourceVersion:number})=>e.sourceVersion===3).id)).body.data.summary.portalNotifications,0);
 }finally{await f.pg.close();}
});
test('linked parent receives current private calendar and approved session-change notice without roster,private notes or meeting URL in events',async()=>{
 const f=await fixture();try{
  const original=await f.request(f.path,undefined,'staff');assert.equal(original.response.status,200,JSON.stringify({body:original.body,failures:f.metrics.queryFailures}));assert.equal(original.body.data.localStart,'2026-01-02T23:30');assert.equal(original.body.rosterIncluded,false);assert.equal(original.body.privateProfilesIncluded,false);
  assert.equal((await f.changeSession(1,{kind:'delivery',mode:'online',onlineUrl:'https://meeting.example.test/private'})).response.status,200);const events=await f.events();assert.equal(events.length,1);const event=events[0];assert.equal(event.sourceKind,'session');assert.equal(event.sourceVersion,2);assert.equal(event.sessionSourceCurrent,true);assert.equal(event.sourceVerification,'database_bound_session_event');assert.doesNotMatch(JSON.stringify(event),/PRIVATE|meeting.example|online_url|onlineUrl|legalName/);
  const sent=await f.dispatch(event.id);assert.equal(sent.response.status,201,JSON.stringify(sent.body));assert.equal(sent.body.data.summary.portalNotifications,1);const inbox=await f.request('notifications?origin=automation',undefined,'staff');assert.equal(inbox.body.data.length,1);assert.deepEqual(inbox.body.data[0].source,{kind:'session',id:f.c.session.id});const read=await f.request(f.path,undefined,'staff');assert.equal(read.body.data.onlineUrl,'https://meeting.example.test/private');
  assert.equal((await f.request('automations/events/'+event.id,undefined,'staff')).response.status,403,'calendar receipt does not grant automation control');
 }finally{await f.pg.close();}
});
test('current session/source version prevents stale reschedule delivery and canceled sessions hide online meeting links',async()=>{
 const f=await fixture();try{
  assert.equal((await f.changeSession(1,{kind:'delivery',mode:'online',onlineUrl:'https://meeting.example.test/private'})).response.status,200);const first=(await f.events())[0];assert.equal((await f.changeSession(2,{kind:'cancel'})).response.status,200);
  const stale=await f.request('automations/events/'+first.id);assert.equal(stale.body.data.sourceStateChanged,true);assert.equal(stale.body.data.sessionSourceCurrent,false);assert.equal((await f.dispatch(first.id)).body.error.code,'AUTOMATION_SESSION_SOURCE_CHANGED');assert.equal((await f.request('automations/rules/'+f.rule.id+'/queue',{eventId:first.id,expectedVersion:1})).body.error.code,'AUTOMATION_SESSION_SOURCE_CHANGED');
  const current=(await f.events()).find((e:{sourceVersion:number})=>e.sourceVersion===3);assert.ok(current);assert.equal((await f.dispatch(current.id)).response.status,201);const calendar=await f.request(f.path,undefined,'staff');assert.equal(calendar.body.data.status,'cancelled');assert.equal(calendar.body.data.onlineUrl,null);
 }finally{await f.pg.close();}
});
test('joining dates,family status,explicit record-hub denial and other schools remain strict private-calendar boundaries',async()=>{
 const f=await fixture();try{
  assert.equal((await f.request(f.path,undefined,'manager')).response.status,404);assert.equal((await f.request(f.path,undefined,'foreignMaster',{academy:f.b})).response.status,404);assert.equal((await f.request('received-sessions/'+randomUUID(),undefined,'staff')).response.status,404);
  await f.pg.query("INSERT INTO public.role_permissions VALUES($1,$2,'received-calendar.view','allow')",[f.a,f.managerRole]);await f.pg.query('INSERT INTO public.assignment_hubs(academy_id,assignment_id,hub_id) SELECT $1,id,$2 FROM public.role_assignments WHERE person_id=$3 AND role_id=$4',[f.a,f.otherHub,f.actors.manager.person,f.managerRole]);assert.equal((await f.request(f.path,undefined,'manager')).response.status,404,'a broad calendar permission is not a guardian relationship');
  const delegated=await f.request('people/'+f.guardian+'/access',{expectedVersion:(await f.request('people/'+f.guardian+'/access')).body.data.version,assignments:[{roleId:f.parentRole,allHubs:false,personIds:[f.student]}]},'manager');assert.equal(delegated.response.status,403);assert.equal(delegated.body.error.code,'DELEGATION_EXCEEDS_AUTHORITY','hub authority cannot delegate a student grant that follows future hubs');
  const later=await f.request('enrollments/'+f.enrollment.id+'/change',{expectedVersion:1,joinsOn:'2026-01-03',reason:'Join after this actual session'});assert.equal(later.response.status,200,JSON.stringify(later.body));assert.equal((await f.request(f.path,undefined,'staff')).response.status,404);
  assert.equal((await f.request('enrollments/'+f.enrollment.id+'/change',{expectedVersion:2,joinsOn:'2026-01-02',reason:'Restore valid actual joining date'})).response.status,200);assert.equal((await f.request(f.path,undefined,'staff')).response.status,200);
  assert.equal((await f.changeSession(1,{kind:'cancel'})).response.status,200);assert.equal((await f.dispatch((await f.events())[0].id)).response.status,201);assert.equal((await f.request('notifications?origin=automation',undefined,'staff')).body.data.length,1);
  const denied=await f.request('roles',{name:'No calendar for this record hub',permissions:[{capability:'received-calendar.view',effect:'deny'}]});assert.equal(denied.response.status,201);const access='people/'+f.guardian+'/access',version=(await f.request(access)).body.data.version;
  const changed=await f.request(access,{expectedVersion:version,assignments:[{roleId:f.parentRole,allHubs:false,personIds:[f.student]},{roleId:denied.body.data.id,allHubs:false,hubIds:[f.hub]}]});assert.equal(changed.response.status,200,JSON.stringify(changed.body));assert.equal((await f.request(f.path,undefined,'staff')).response.status,404);assert.equal((await f.request('notifications?origin=automation',undefined,'staff')).body.data.length,0);
  assert.equal((await f.request(access,{expectedVersion:(await f.request(access)).body.data.version,assignments:[{roleId:f.parentRole,allHubs:false,personIds:[f.student]}]})).response.status,200);assert.equal((await f.request(f.path,undefined,'staff')).response.status,200);
  const suspended=await f.request('family-relationships/'+f.relationship.id+'/suspend',{expectedVersion:1,reason:'Protective suspension'});assert.equal(suspended.response.status,200,JSON.stringify(suspended.body));assert.equal((await f.request(f.path,undefined,'staff')).response.status,404);assert.equal((await f.request('notifications?origin=automation',undefined,'staff')).body.data.length,0);
 }finally{await f.pg.close();}
});
test('session-source migration preserves old audit envelopes and captures only new reviewed session revisions',async()=>{
 const f=await reportFixture(125);try{
  const path='sessions/'+f.c.session.id+'/change',old=await f.request(path,{expectedVersion:1,change:{kind:'cancel'},reason:'Historical actual cancellation'});assert.equal(old.response.status,200);const before=(await f.pg.query('SELECT event_id,audit_id,projection,source_kind FROM public.automation_event_sources ORDER BY event_id')).rows;assert.ok(before.some(r=>r.source_kind==='audit'&&(r.projection as {eventType:string}).eventType==='session.changed'));
  await f.pg.exec(await readFile(new URL('../db/migrations/126_session_notification_sources.sql',import.meta.url),'utf8'));assert.deepEqual((await f.pg.query('SELECT event_id,audit_id,projection,source_kind FROM public.automation_event_sources ORDER BY event_id')).rows,before);assert.equal((await f.pg.query("SELECT * FROM public.automation_event_sources WHERE source_kind='session'")).rows.length,0);
  await f.pg.exec(await readFile(new URL('../db/migrations/127_session_notification_audiences.sql',import.meta.url),'utf8'));await f.pg.exec(await readFile(new URL('../db/migrations/128_session_reminders.sql',import.meta.url),'utf8'));
  const restored=await f.request(path,{expectedVersion:2,change:{kind:'restore'},reason:'New actual restored session'});assert.equal(restored.response.status,200,JSON.stringify(restored.body));const source=(await f.pg.query("SELECT session_id,source_version FROM public.automation_event_sources WHERE source_kind='session'")).rows;assert.equal(source.length,1);assert.equal(source[0].session_id,f.c.session.id);assert.equal(source[0].source_version,3);
 }finally{await f.pg.close();}
});
test('adding a later class session must not discard an already queued unchanged-session notice',async()=>{
 const f=await fixture();try{
  assert.equal((await f.changeSession(1,{kind:'cancel'})).response.status,200);const event=(await f.events())[0];
  assert.equal((await f.request('automations/rules/'+f.rule.id+'/queue',{eventId:event.id,expectedVersion:1})).response.status,202);
  const appended=await f.request('classes/'+f.c.id+'/schedules',{expectedVersion:1,schedule:{oneOff:[{start:'2026-01-09T23:30',end:'2026-01-10T00:30'}]}});assert.equal(appended.response.status,201,JSON.stringify(appended.body));assert.equal(appended.body.classVersion,2);
  const current=await f.request('automations/events/'+event.id);assert.equal(current.body.data.sessionSourceCurrent,true,'unrelated new session does not supersede this cancellation');
  const database:Database={async connect(){const c=f.pg.runtime?await f.pg.runtime.connect():{query:f.pg.query.bind(f.pg),release(){}};await c.query('SET ROLE kavosh_automation_worker');return c;}};
  try{assert.equal((await processOneNotification(database,[f.a])).outcome,'succeeded');}finally{if(!f.pg.runtime)await f.pg.exec('RESET ROLE');}
  assert.equal((await f.request('notifications?origin=automation',undefined,'staff')).body.data.length,1);const duplicate=await f.dispatch(event.id);assert.equal(duplicate.response.status,200);assert.equal(duplicate.body.data.duplicate,true);assert.equal((await f.request('notifications?origin=automation',undefined,'staff')).body.data.length,1);
  assert.equal((await f.request('classes/'+f.c.id+'/update',{expectedVersion:2,name:'New class display name'})).response.status,200);
  assert.equal((await f.request('automations/events/'+event.id)).body.data.sessionSourceCurrent,false,'changed class facts in the event remain a stale source');
 }finally{await f.pg.close();}
});
test('queued class notices recheck source freshness and current family access at actual worker execution',async()=>{
 const f=await fixture();const database:Database={async connect(){const c=f.pg.runtime?await f.pg.runtime.connect():{query:f.pg.query.bind(f.pg),release(){}};await c.query('SET ROLE kavosh_automation_worker');return c;}};const work=async()=>{try{return await processOneNotification(database,[f.a]);}finally{if(!f.pg.runtime)await f.pg.exec('RESET ROLE');}};
 try{
  assert.equal((await f.changeSession(1,{kind:'delivery',mode:'online',onlineUrl:'https://meeting.example.test/private'})).response.status,200);const old=(await f.events())[0],queue='automations/rules/'+f.rule.id+'/queue';assert.equal((await f.request(queue,{eventId:old.id,expectedVersion:1})).response.status,202);assert.equal((await f.changeSession(2,{kind:'cancel'})).response.status,200);assert.equal((await work()).outcome,'cancelled');assert.equal((await f.pg.query("SELECT * FROM public.portal_notifications WHERE origin='automation'")).rows.length,0);
  const current=(await f.events()).find((e:{sourceVersion:number})=>e.sourceVersion===3);assert.ok(current);assert.equal((await f.request(queue,{eventId:current.id,expectedVersion:1})).response.status,202);assert.equal((await f.request('family-relationships/'+f.relationship.id+'/suspend',{expectedVersion:1,reason:'Current family authority withdrawn'})).response.status,200);assert.equal((await work()).outcome,'succeeded');assert.equal((await f.pg.query("SELECT * FROM public.portal_notifications WHERE origin='automation'")).rows.length,0);const run=(await f.pg.query<{summary:{suppressed:number;portalNotifications:number}}>('SELECT summary FROM public.automation_runs')).rows[0];assert.equal(run.summary.suppressed,1);assert.equal(run.summary.portalNotifications,0);
 }finally{await f.pg.close();}
});
