import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { operationsFixture } from './operations-fixture.ts';
import { processOneAccountSecurity } from '../src/automations/account-security-worker.ts';
import type { Database } from '../src/core/database.ts';
import { upgradeToCurrent } from './migration-upgrade.ts';

async function fixture(options:{throughSchema?:number}={}){
 const f=await operationsFixture(options);let serial=0;
 const database:Database={async connect(){const c=f.pg.runtime?await f.pg.runtime.connect():{query:f.pg.query.bind(f.pg),release(){}};await c.query('SET ROLE kavosh_automation_worker');return c;}};
 async function work(ids:string[]=[f.a],signal?:AbortSignal){try{return await processOneAccountSecurity(database,ids,signal);}finally{if(!f.pg.runtime)await f.pg.exec('RESET ROLE');}}
 async function login(as='staff'){const actor=f.actors[as];actor.session=randomUUID();await f.pg.query('INSERT INTO identity.session(id,token,"userId","expiresAt","updatedAt","mfaVerified") VALUES($1,$2,$3,now()+interval \'1 day\',now(),true)',[actor.session,'synthetic-new-session-'+randomUUID(),actor.user]);}
 async function change(field:'email'|'phone'='phone',as='staff'){
  const value=field==='phone'?'+1647999'+String(++serial).padStart(4,'0'):'changed-'+(++serial)+'@example.test';
  await f.pg.query('UPDATE identity."user" SET '+(field==='phone'?'"phoneNumber"':'email')+'=$2 WHERE id=$1',[f.actors[as].user,value]);await login(as);return value;
 }
 return {...f,database,work,change,login};
}
type F=Awaited<ReturnType<typeof fixture>>;
function check(name:string,run:(f:F)=>Promise<void>){test(name,async()=>{const f=await fixture();try{await run(f);}finally{await f.pg.close();}});}
function noSecrets(value:unknown){assert.doesNotMatch(JSON.stringify(value),/example[.]test|[+]1647|user_id|contact_event_id|origin_transaction|session_token|password|code_hash|source_snapshot|envelope/);}

check('account security uses one inbox and a real linked source;reading never reverses the change or grants access',async f=>{
 const value=await f.change();assert.equal((await f.pg.query('SELECT * FROM public.account_security_events')).rows.length,0,'publication must not run inside authentication');
 const source=(await f.pg.query<{id:string;field:string}>('SELECT * FROM identity.contact_change_events')).rows[0];assert.equal(source.field,'phone');noSecrets({field:source.field});
 assert.equal((await f.work()).published,true);assert.equal((await f.work()).published,false);
 const recipients=(await f.pg.query<{person_id:string}>("SELECT person_id FROM public.portal_notifications WHERE origin='mandatory'")).rows.map(r=>r.person_id).sort();assert.deepEqual(recipients,[f.actors.staff.person,f.actors.manager.person,f.actors.master.person].sort());
 assert.equal((await f.request('notifications',undefined,'manager')).body.data.length,0,'no implicit new administrative grant');
 await f.pg.query("INSERT INTO public.role_permissions VALUES($1,$2,'account-security.view','allow')",[f.a,f.managerRole]);
 for(const as of ['master','manager','staff']){
  const r=await f.request('notifications?origin=mandatory',undefined,as);assert.equal(r.response.status,200,JSON.stringify(r.body));assert.equal(r.body.data.length,1);const n=r.body.data[0];assert.equal(n.source.kind,'account_security');assert.equal(n.title,'Account contact changed');assert.equal(n.severity,'critical');noSecrets(n);
  const linked=await f.request(n.source.recordPath.slice('/api/v1/'.length),undefined,as);assert.equal(linked.response.status,200,JSON.stringify(linked.body));assert.equal(linked.body.data.field,'phone');assert.equal(linked.body.data.actorAttributed,false);assert.equal(linked.body.data.contactValuesIncluded,false);noSecrets(linked.body);
 }
 assert.equal((await f.request('notifications',undefined,'peer')).body.data.length,0);
 const own=await f.request('me/account-security',undefined,'staff');assert.equal(own.body.data.length,1);const notice=(await f.request('notifications',undefined,'staff')).body.data[0],key=randomUUID();
 assert.equal((await f.request('notifications/'+notice.id+'/read',{},'staff',{key})).response.status,200);assert.equal((await f.request('notifications/'+notice.id+'/read',{},'staff',{key})).response.status,200);
 assert.equal((await f.request('notifications?unread=true',undefined,'staff')).body.data.length,0);assert.equal((await f.request('me/account-security',undefined,'staff')).body.data.length,1);
 assert.equal((await f.pg.query<{phone:string}>('SELECT "phoneNumber" phone FROM identity."user" WHERE id=$1',[f.actors.staff.user])).rows[0].phone,value);
 assert.equal((await f.request('notifications?locale=fr',undefined,'staff')).body.data[0].title,'Coordonnées du compte modifiées');assert.equal((await f.request('notifications?locale=zh-CN',undefined,'staff')).body.data[0].title,'账户联系方式已更改');
});

check('account security publication failure rolls back alerts and source,not the already committed account change',async f=>{
 const phone=await f.change();await f.pg.exec("CREATE FUNCTION public.synthetic_security_notice_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.origin='mandatory' THEN RAISE EXCEPTION 'SYNTHETIC_SECURITY_NOTICE_FAILURE';END IF;RETURN NEW;END $$;CREATE TRIGGER synthetic_security_notice_failure BEFORE INSERT ON public.portal_notifications FOR EACH ROW EXECUTE FUNCTION public.synthetic_security_notice_failure()");
 await assert.rejects(f.work(),/SYNTHETIC_SECURITY_NOTICE_FAILURE/);
 for(const table of ['account_security_events','automation_event_sources','outbox_events','portal_notifications'])assert.equal((await f.pg.query('SELECT * FROM public.'+table)).rows.length,0,table);
 assert.equal((await f.pg.query<{status:string}>('SELECT status FROM identity.contact_change_targets')).rows[0].status,'pending');assert.equal((await f.pg.query<{phone:string}>('SELECT "phoneNumber" phone FROM identity."user" WHERE id=$1',[f.actors.staff.user])).rows[0].phone,phone);
 await f.pg.exec('DROP TRIGGER synthetic_security_notice_failure ON public.portal_notifications;DROP FUNCTION public.synthetic_security_notice_failure()');assert.equal((await f.work()).published,true);assert.equal((await f.work()).published,false);assert.equal((await f.pg.query('SELECT * FROM public.account_security_events')).rows.length,1);
});

check('account security grants and present hierarchy filter notifications before pagination without hiding explicitly permitted history',async f=>{
 await f.pg.query("INSERT INTO public.role_permissions VALUES($1,$2,'account-security.view','allow')",[f.a,f.managerRole]);
 await f.change();await f.work();const notice=(await f.request('notifications',undefined,'manager')).body.data[0];assert.ok(notice);
 await f.pg.query('UPDATE public.people SET supervisor_person_id=$2 WHERE academy_id=$1 AND id=$3',[f.a,f.actors.peer.person,f.actors.staff.person]);
 assert.equal((await f.request('notifications?limit=1',undefined,'manager')).body.data.length,0);assert.equal((await f.request('notifications/'+notice.id,undefined,'manager')).response.status,404);assert.equal((await f.request('notifications/'+notice.id+'/read',{},'manager')).response.status,404);
 assert.equal((await f.request('people/'+f.actors.staff.person+'/account-security',undefined,'manager')).body.data.length,1,'explicit scoped view grant remains independently configurable');
 await f.pg.query("DELETE FROM public.role_permissions WHERE role_id=$1 AND capability='account-security.view'",[f.managerRole]);assert.equal((await f.request('people/'+f.actors.staff.person+'/account-security',undefined,'manager')).response.status,404);
 assert.equal((await f.request('people/'+f.actors.staff.person+'/account-security',undefined,'peer')).response.status,404);
});

check('account security captures actual binding targets once and publishes only configured schools without cross-tenant identities',async f=>{
 const inB=randomUUID();await f.pg.query("INSERT INTO public.people(academy_id,id,kind,name,auth_user_id) VALUES($1,$2,'human','Second-school person',$3)",[f.b,inB,f.actors.staff.user]);
 await f.change('email');assert.equal((await f.pg.query('SELECT * FROM identity.contact_change_targets')).rows.length,2);
 const c=randomUUID(),master=randomUUID(),late=randomUUID();await f.pg.exec('BEGIN');try{await f.pg.query("INSERT INTO public.academies(id,name,status,master_person_id) VALUES($1,'Late academy','active',$2)",[c,master]);await f.pg.query("INSERT INTO public.people(academy_id,id,kind,name,auth_user_id) VALUES($1,$2,'human','Late academy master',$3),($1,$4,'human','Late membership',$5)",[c,master,f.actors.foreignMaster.user,late,f.actors.staff.user]);await f.pg.exec('COMMIT');}catch(e){await f.pg.exec('ROLLBACK');throw e;}assert.equal((await f.work([c])).published,false,'later binding must not receive old contact observations');
 assert.equal((await f.work([f.a])).published,true);assert.equal((await f.work([f.a])).published,false);assert.equal((await f.pg.query('SELECT * FROM public.account_security_events WHERE academy_id=$1',[f.b])).rows.length,0);
 assert.equal((await f.work([f.b])).published,true);assert.equal((await f.work([f.b])).published,false);
 const b=(await f.request('notifications',undefined,'foreignMaster',{academy:f.b})).body.data;assert.equal(b.length,1);assert.equal(b[0].source.personId,inB);noSecrets(b);
 const denied=await f.request(b[0].source.recordPath.slice('/api/v1/'.length));assert.equal(denied.response.status,404);
 assert.equal((await f.request('me/account-security',undefined,'staff',{academy:f.b})).body.data.length,1);
 const aSource=(await f.request('me/account-security',undefined,'staff')).body.data[0];assert.notEqual(aSource.id,b[0].source.id);
});

check('account security broker cannot publish an old observation to a replacement identity binding',async f=>{
 const second=randomUUID();await f.pg.query("INSERT INTO public.people(academy_id,id,kind,name,auth_user_id) VALUES($1,$2,'human','Original binding',$3)",[f.b,second,f.actors.staff.user]);await f.change();
 await f.pg.query('UPDATE public.people SET auth_user_id=$3 WHERE academy_id=$1 AND id=$2',[f.b,second,f.actors.peer.user]);
 assert.equal((await f.work([f.b])).published,true);assert.equal((await f.work([f.b])).published,false);assert.equal((await f.pg.query('SELECT * FROM public.account_security_events WHERE academy_id=$1',[f.b])).rows.length,0);
 assert.equal((await f.pg.query<{status:string}>('SELECT status FROM identity.contact_change_targets WHERE academy_id=$1',[f.b])).rows[0].status,'discarded');assert.equal((await f.work([f.a])).published,true);
});

check('account security retains contact-time hub while delivery and viewing use current supervision and person scope',async f=>{
 await f.change();await f.pg.query('UPDATE public.people SET hub_id=$3,supervisor_person_id=$4 WHERE academy_id=$1 AND id=$2',[f.a,f.actors.staff.person,f.otherHub,f.actors.peer.person]);
 await f.pg.query("INSERT INTO public.role_permissions VALUES($1,$2,'account-security.view','allow')",[f.a,f.managerRole]);assert.equal((await f.work()).published,true);
 assert.equal((await f.pg.query<{hub_id:string}>("SELECT hub_id FROM public.automation_event_sources WHERE source_kind='account_security'")).rows[0].hub_id,f.hub);
 assert.equal((await f.request('notifications',undefined,'manager')).body.data.length,0);const current=await f.request('notifications',undefined,'peer');assert.equal(current.body.data.length,1);assert.equal((await f.request(current.body.data[0].source.recordPath.slice('/api/v1/'.length),undefined,'peer')).response.status,200);
 assert.equal((await f.request('people/'+f.actors.staff.person+'/account-security',undefined,'manager')).response.status,404);
});

check('account security private queues publishers and hidden source identifiers are not exposed to web identity delivery or worker roles',async f=>{
 await f.change();
 for(const role of ['kavosh_runtime','kavosh_identity','kavosh_delivery','kavosh_automation_worker']){
  await f.pg.exec('BEGIN');try{await f.pg.query("SELECT set_config('app.academy_id',$1,true)",[f.a]);await f.pg.exec('SET LOCAL ROLE '+role);
   for(const sql of ['SELECT * FROM identity.contact_change_events','SELECT * FROM identity.contact_change_targets','INSERT INTO public.account_security_events DEFAULT VALUES','SELECT contact_event_id FROM public.account_security_events']){await f.pg.exec('SAVEPOINT hostile');await assert.rejects(f.pg.exec(sql),/permission denied/i);await f.pg.exec('ROLLBACK TO SAVEPOINT hostile');}
   if(role!=='kavosh_automation_worker'){await f.pg.exec('SAVEPOINT publisher');await assert.rejects(f.pg.query('SELECT public.publish_pending_account_security($1)',[[f.a]]),/permission denied/i);await f.pg.exec('ROLLBACK TO SAVEPOINT publisher');}
  }finally{await f.pg.exec('ROLLBACK');}
 }
 const aborted=new AbortController();aborted.abort();assert.equal((await f.work([f.a],aborted.signal)).published,false);assert.equal((await f.pg.query<{status:string}>('SELECT status FROM identity.contact_change_targets')).rows[0].status,'pending');
 for(const ids of [[],[f.a,f.a],['not-an-id']])await assert.rejects(f.work(ids));assert.equal((await f.work()).published,true);
 for(const table of ['identity.contact_change_events','identity.contact_change_targets','public.account_security_events']){await f.pg.exec('BEGIN');try{await assert.rejects(f.pg.exec('DELETE FROM '+table),/IMMUTABLE|PRIVATE_CONTACT_EVENT_WRITER_REQUIRED/);}finally{await f.pg.exec('ROLLBACK');}}
});

check('account security native guards reject directly invented facts targets source snapshots and unrelated mandatory recipients',async f=>{
 await f.change();const fact=(await f.pg.query<{id:string}>('SELECT id FROM identity.contact_change_events')).rows[0];
 await f.pg.exec('BEGIN;SET LOCAL ROLE kavosh_identity_policy');try{
  await f.pg.exec('SAVEPOINT fact');await assert.rejects(f.pg.query('INSERT INTO identity.contact_change_events(id,user_id,field) VALUES($1,$2,\'phone\')',[randomUUID(),f.actors.staff.user]),/CONTACT_CHANGE_TRIGGER_REQUIRED/);await f.pg.exec('ROLLBACK TO SAVEPOINT fact');
  await f.pg.exec('SAVEPOINT target');await assert.rejects(f.pg.query('INSERT INTO identity.contact_change_targets(event_id,academy_id,person_id) VALUES($1,$2,$3)',[fact.id,f.b,f.actors.foreignMaster.person]),/CONTACT_EVENT_BINDING_REQUIRED/);await f.pg.exec('ROLLBACK TO SAVEPOINT target');
 }finally{await f.pg.exec('ROLLBACK');}
 await f.work();const event=(await f.pg.query<{event_id:string}>('SELECT event_id FROM public.automation_event_sources')).rows[0];
 await f.pg.exec('BEGIN');try{
  await f.pg.query("SELECT set_config('app.academy_id',$1,true)",[f.a]);await f.pg.exec('SET LOCAL ROLE kavosh_event_policy');
  await f.pg.exec('SAVEPOINT source');await assert.rejects(f.pg.query('INSERT INTO public.automation_event_sources(academy_id,event_id,source_kind,source_version,event_type,hub_id,occurred_at,projection,account_security_id) SELECT academy_id,$2,source_kind,source_version,event_type,hub_id,occurred_at,projection,account_security_id FROM public.automation_event_sources WHERE event_id=$1',[event.event_id,randomUUID()]),/ACCOUNT_SECURITY_EVENT_SOURCE_REQUIRED/);await f.pg.exec('ROLLBACK TO SAVEPOINT source');
  await f.pg.exec('SAVEPOINT recipient');await assert.rejects(f.pg.query("INSERT INTO public.portal_notifications(academy_id,id,event_id,person_id,action_index,severity,title,body,locale,origin) VALUES($1,$2,$3,$4,0,'critical','Account contact changed','Open the linked account-security record to review this change. Reading this notification does not reverse it.','en','mandatory')",[f.a,randomUUID(),event.event_id,f.actors.peer.person]),/MANDATORY_ALERT_SOURCE_INVALID/);await f.pg.exec('ROLLBACK TO SAVEPOINT recipient');
 }finally{await f.pg.exec('ROLLBACK');}
});

check('account security self access never inherits old identity history after a person is rebound;explicit finite bot grants remain configurable',async f=>{
 await f.change();await f.work();const record=(await f.request('me/account-security',undefined,'staff')).body.data[0];
 assert.equal((await f.request('people/'+f.actors.staff.person+'/account-security/'+record.id,undefined,'bot')).response.status,404);
 assert.equal((await f.request('me/account-security',undefined,'bot')).response.status,403);
 await f.pg.query("INSERT INTO public.role_permissions VALUES($1,$2,'account-security.view','allow')",[f.a,f.managerRole]);
 const bot=await f.request('people/'+f.actors.staff.person+'/account-security/'+record.id,undefined,'bot');assert.equal(bot.response.status,200,JSON.stringify(bot.body));noSecrets(bot.body);
 await f.pg.query("UPDATE auth_private.credentials SET capabilities=array_remove(capabilities,'account-security.view') WHERE id=$1",[f.botAuth.credentialId]);assert.equal((await f.request('people/'+f.actors.staff.person+'/account-security/'+record.id,undefined,'bot')).response.status,404);
 // Keep the old identity alive in a different school,then bind this one school
 // person to another verified user. No old implicit self history is borrowed.
 const original=f.actors.staff.user,newUser=randomUUID();await f.pg.query('INSERT INTO identity."user"(id,name,email,"emailVerified","phoneNumber","phoneNumberVerified","mfaRequired") VALUES($1,\'Replacement account\',\'replacement@example.test\',true,\'+16479990999\',true,false)',[newUser]);
 await f.pg.query('UPDATE public.people SET auth_user_id=$3 WHERE academy_id=$1 AND id=$2',[f.a,f.actors.staff.person,newUser]);f.actors.staff.user=newUser;await f.login();
 assert.equal((await f.request('me/account-security',undefined,'staff')).body.data.length,0);assert.equal((await f.request('people/'+f.actors.staff.person+'/account-security/'+record.id,undefined,'staff')).response.status,404);assert.equal((await f.request('people/'+f.actors.staff.person+'/account-security/'+record.id)).response.status,200);
 assert.notEqual(original,newUser);
});

check('account security cursor filtering is bounded and strict;explicit person and hub exclusions win before paging',async f=>{
 await f.change();await f.work();await f.change('email');await f.work();
 const first=await f.request('me/account-security?limit=1',undefined,'staff');assert.equal(first.body.data.length,1);assert.ok(first.body.nextCursor);const cursor=first.body.nextCursor,second=await f.request('me/account-security?limit=1&afterOccurredAt='+encodeURIComponent(cursor.afterOccurredAt)+'&afterId='+cursor.afterId,undefined,'staff');assert.equal(second.body.data.length,1);assert.notEqual(first.body.data[0].id,second.body.data[0].id);assert.equal(second.body.nextCursor,null);
 assert.equal((await f.request('me/account-security?field=phone',undefined,'staff')).body.data.length,1);
 for(const query of ['limit=51','field=address','afterId='+randomUUID(),'limit=1&limit=2','userId='+randomUUID()])assert.equal((await f.request('me/account-security?'+query,undefined,'staff')).response.status,400);
 assert.equal((await f.request('me/account-security',{},'staff')).response.status,405);
 await f.pg.query("INSERT INTO public.role_permissions VALUES($1,$2,'account-security.view','allow')",[f.a,f.managerRole]);
 const deny=randomUUID(),assignment=randomUUID();await f.pg.query('INSERT INTO public.roles(academy_id,id,name) VALUES($1,$2,\'Security person denial\')',[f.a,deny]);await f.pg.query("INSERT INTO public.role_permissions VALUES($1,$2,'account-security.view','deny')",[f.a,deny]);await f.pg.query('INSERT INTO public.role_assignments(academy_id,id,person_id,role_id,all_hubs) VALUES($1,$2,$3,$4,false)',[f.a,assignment,f.actors.manager.person,deny]);await f.pg.query('INSERT INTO public.assignment_people(academy_id,assignment_id,person_id) VALUES($1,$2,$3)',[f.a,assignment,f.actors.staff.person]);
 assert.equal((await f.request('people/'+f.actors.staff.person+'/account-security?limit=1',undefined,'manager')).response.status,404);assert.equal((await f.request('notifications?limit=1',undefined,'manager')).body.data.length,0);
 await f.pg.query('DELETE FROM public.assignment_people WHERE assignment_id=$1',[assignment]);await f.pg.query('INSERT INTO public.assignment_hubs(academy_id,assignment_id,hub_id) VALUES($1,$2,$3)',[f.a,assignment,f.hub]);assert.equal((await f.request('people/'+f.actors.staff.person+'/account-security?limit=1',undefined,'manager')).response.status,404);assert.equal((await f.request('notifications?limit=1',undefined,'manager')).body.data.length,0);
});

test('account security native two-worker race publishes one source and current-recipient alert set',{skip:!process.env.TEST_DATABASE_URL},async()=>{
 const f=await fixture();try{await f.change();const start=performance.now(),results=await Promise.all([f.work(),f.work()]);assert.deepEqual(results.map(r=>r.published).sort(),[false,true]);assert.equal((await f.pg.query('SELECT * FROM public.account_security_events')).rows.length,1);assert.equal((await f.pg.query('SELECT * FROM public.automation_event_sources')).rows.length,1);assert.equal((await f.pg.query('SELECT * FROM public.portal_notifications')).rows.length,3);console.log('Two account-event workers finished in '+Math.ceil(performance.now()-start)+'ms;not capacity/SLO evidence.');}finally{await f.pg.close();}
});

test('account security hierarchy remains tenant-bound even for a private policy role with colliding person UUIDs',async()=>{
 const f=await fixture();try{
  const duplicate=f.actors.staff.person;await f.pg.query("INSERT INTO public.people(academy_id,id,kind,name,supervisor_person_id) VALUES($1,$2,'human','Same UUID in another school',$3)",[f.b,duplicate,f.actors.foreignMaster.person]);
  // Simulate even a future accidental EXECUTE grant;the test transaction
  // rolls it back. Production grants to this private role are not expanded.
  await f.pg.exec('BEGIN;GRANT EXECUTE ON FUNCTION public.supervisor_chain(uuid) TO kavosh_identity_policy;SET LOCAL ROLE kavosh_identity_policy');try{
   await f.pg.query("SELECT set_config('app.academy_id',$1,true)",[f.a]);const a=(await f.pg.query<{person_id:string}>('SELECT * FROM public.supervisor_chain($1)',[duplicate])).rows.map(r=>r.person_id);assert.deepEqual(a,[f.actors.manager.person,f.actors.master.person]);
   await f.pg.query("SELECT set_config('app.academy_id',$1,true)",[f.b]);assert.deepEqual((await f.pg.query<{person_id:string}>('SELECT * FROM public.supervisor_chain($1)',[duplicate])).rows.map(r=>r.person_id),[f.actors.foreignMaster.person]);
   await f.pg.query("SELECT set_config('app.academy_id','',true)");assert.equal((await f.pg.query('SELECT * FROM public.supervisor_chain($1)',[duplicate])).rows.length,0);
  }finally{await f.pg.exec('ROLLBACK');}
 }finally{await f.pg.close();}
});

check('account security same-identity owner repair never releases a cooling address to another identity or a normal web caller',async f=>{
 const user=f.actors.staff.user,old='staff@example.test';await f.change('email');
 assert.equal((await f.pg.query<{user_id:string}>('SELECT user_id FROM identity.retired_emails WHERE email=$1',[old])).rows[0].user_id,user);
 await f.pg.exec('BEGIN');try{await assert.rejects(f.pg.query('UPDATE identity."user" SET email=$2 WHERE id=$1',[f.actors.peer.user,old]),/EMAIL_UNAVAILABLE/);}finally{await f.pg.exec('ROLLBACK');}
 await f.pg.exec('BEGIN;SET LOCAL ROLE kavosh_identity');try{await assert.rejects(f.pg.query('UPDATE identity."user" SET email=$2 WHERE id=$1',[user,old]),/EMAIL_CHANGE_REQUIRES_RECOVERY/);}finally{await f.pg.exec('ROLLBACK');}
 await f.pg.query('UPDATE identity."user" SET email=$2 WHERE id=$1',[user,old]);assert.equal((await f.pg.query<{email:string}>('SELECT email FROM identity."user" WHERE id=$1',[user])).rows[0].email,old);
 await f.pg.exec('BEGIN');try{await assert.rejects(f.pg.query('INSERT INTO identity."user"(id,name,email,"emailVerified","mfaRequired") VALUES($1,\'Different identity\',$2,false,false)',[randomUUID(),old]),/EMAIL_UNAVAILABLE/);}finally{await f.pg.exec('ROLLBACK');}
});

test('account security actual198to199 upgrade preserves old contact reservations identities source notifications and helper ACLs without invented history',async()=>{
 const f=await fixture({throughSchema:198});try{
  const proposal=await f.proposal('Original pending policy');assert.ok(proposal.id);await f.change('email');
  const oldInbox=(await f.pg.query<{id:string;title:string;body:string;severity:string;origin:string}>('SELECT id,title,body,severity,origin FROM public.portal_notifications ORDER BY id')).rows,tables=['identity."user"','identity.session','identity.account','identity.security_events','identity.invites','identity.retired_emails','public.people','public.role_permissions','public.approval_requests','public.audit_events','public.outbox_events','public.automation_event_sources','public.portal_notifications'];
  async function snapshot(){const data=[];for(const table of tables){const expression=table==='identity.retired_emails'?"to_jsonb(x)-'user_id'":table==='public.automation_event_sources'?"to_jsonb(x)-'account_security_id'":'to_jsonb(x)';data.push({table,rows:(await f.pg.query('SELECT '+expression+' r FROM '+table+' x ORDER BY to_jsonb(x)::text')).rows});}return data;}
  const before=await snapshot(),helpers="SELECT oid,proowner,proacl FROM pg_proc WHERE oid=ANY(ARRAY['identity.guard_email_change()'::regprocedure,'identity.finish_email_change()'::regprocedure,'public.supervisor_chain(uuid)'::regprocedure,'public.mandatory_alert_guard()'::regprocedure,'public.guardian_contact_status(uuid)'::regprocedure]) ORDER BY oid",acl=(await f.pg.query(helpers)).rows;
  await f.pg.exec(await readFile(new URL('../db/migrations/199_account_security_notifications.sql',import.meta.url),'utf8'));assert.deepEqual(await snapshot(),before);assert.deepEqual((await f.pg.query(helpers)).rows,acl);assert.equal((await f.pg.query('SELECT public.schema_revision() n')).rows[0].n,199);await upgradeToCurrent(f.pg);
  assert.equal((await f.pg.query('SELECT * FROM identity.contact_change_events')).rows.length,0);assert.equal((await f.pg.query('SELECT * FROM identity.contact_change_targets')).rows.length,0);assert.equal((await f.pg.query('SELECT * FROM public.account_security_events')).rows.length,0);assert.equal((await f.pg.query<{user_id:null}>('SELECT user_id FROM identity.retired_emails')).rows[0].user_id,null);assert.equal((await f.work()).published,false);
  const afterInbox=await f.request('notifications');assert.equal(afterInbox.response.status,200,JSON.stringify(afterInbox.body));for(const before of oldInbox){const current=afterInbox.body.data.find((n:{id:string})=>n.id===before.id);assert.ok(current);for(const field of ['id','title','body','severity','origin'] as const)assert.equal(current[field],before[field]);assert.equal(current.source.id,proposal.id);}
  await f.change();assert.equal((await f.work()).published,true);assert.equal((await f.pg.query('SELECT * FROM public.account_security_events')).rows.length,1);
 }finally{await f.pg.close();}
});
