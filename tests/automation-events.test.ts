import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { operationsFixture } from './operations-fixture.ts';
import { workFixture } from './work-fixture.ts';
import { readFile } from 'node:fs/promises';
import { upgradeToCurrent } from './migration-upgrade.ts';

async function fixture(options:{throughSchema?:number}={}){const f=await operationsFixture(options);try{
 for(const role of [f.staffRole,f.managerRole])for(const cap of ['automations.view','automations.edit'])await f.pg.query("INSERT INTO public.role_permissions VALUES($1,$2,$3,'allow')",[f.a,role,cap]);
 const definition={name:'Approval notice',enabled:true,trigger:{kind:'domain_event',eventTypes:['approval.*']},condition:{op:'eq',field:'attributes.action',value:'automation.rule.create'},actions:[{kind:'notify',channels:['portal'],audience:{kind:'actor_supervisors'},title:{en:'Review {{eventType}}'},body:{en:'Case {{entityId}}'}}]},input={hubId:f.hub,code:'APPROVALS',definition,reason:'Private text never copied to event projection'};
 const create=(code='APPROVALS',as='master',hubId=f.hub)=>f.request('automations/rules',{...input,code,hubId},as);
 const events=(approvalId:string,as='master',extra='')=>f.request('automations/events?approvalId='+approvalId+extra,undefined,as);
 return {...f,definition,input,create,events};
}catch(error){await f.pg.close();throw error;}}
type Fixture=Awaited<ReturnType<typeof fixture>>;
function check(name:string,run:(f:Fixture)=>Promise<void>){test(name,async()=>{const f=await fixture();try{await run(f);}finally{await f.pg.close();}});}
check('actual approval events bind to exactly one audit and preserve their captured version/status after source changes',async f=>{
 const pending=await f.create('PENDING','staff');assert.equal(pending.response.status,202,JSON.stringify(pending.body));const first=await f.events(pending.body.approval.id,'staff');assert.equal(first.response.status,200,JSON.stringify(first.body));assert.equal(first.body.data.length,1);const event=first.body.data[0];assert.equal(event.sourceVerification,'database_bound_approval_event');assert.equal(event.sample.attributes.approvalStatus,'pending');assert.equal(event.sourceVersion,1);assert.equal(event.sample.hubId,f.hub);assert.equal(event.sample.actorId,f.actors.staff.person);assert.equal(event.sample.severity,'critical');assert.equal(event.underlyingBusinessFactsIndependentlyVerified,false);assert.doesNotMatch(JSON.stringify(first.body),/Private text|Approval notice|Review \{\{|condition|personIds/);
 assert.equal((await f.approve(pending.body.approval.id,'manager')).response.status,200);const later=await f.events(pending.body.approval.id,'staff');assert.equal(later.body.data.length,2);const retained=later.body.data.find((e:{id:string})=>e.id===event.id);assert.equal(retained.sample.attributes.approvalStatus,'pending');assert.equal(retained.currentStatus,'applied');assert.equal(retained.sourceStateChanged,true);assert.equal(later.body.data.find((e:{sample:{eventType:string}})=>e.sample.eventType==='approval.applied').sourceVersion,2);
 const role=await f.proposal('Sensitive permission-preset request');assert.equal((await f.events(role.id)).body.data[0].sample.severity,'critical');
});
check('bound-event rule previews require real current source access and cannot accept caller-substituted samples or queue work',async f=>{
 const rule=await f.create(),pending=await f.create('PENDING','staff');assert.equal(rule.response.status,201,JSON.stringify(rule.body));assert.equal(pending.response.status,202);const event=(await f.events(pending.body.approval.id)).body.data[0],outbox=(await f.pg.query('SELECT * FROM public.outbox_events')).rows.length,keys=(await f.pg.query('SELECT * FROM public.request_keys')).rows.length;
 await f.pg.query("UPDATE public.academies SET status='read_only' WHERE id=$1",[f.a]);const preview=await f.request('automations/rules/'+rule.body.data.id+'/event-preview',{eventId:event.id},'manager');assert.equal(preview.response.status,200,JSON.stringify(preview.body));assert.equal(preview.body.data.sampleSource,'server_bound_approval_event');assert.equal(preview.body.data.eligibleByConfiguration,true);assert.equal(preview.body.data.queued,false);assert.equal(preview.body.data.workerActive,false);assert.equal(preview.body.data.event.id,event.id);assert.equal((await f.pg.query('SELECT * FROM public.outbox_events')).rows.length,outbox);assert.equal((await f.pg.query('SELECT * FROM public.request_keys')).rows.length,keys);
 assert.equal((await f.request('automations/rules/'+rule.body.data.id+'/event-preview',{eventId:event.id,sample:{severity:'normal'}})).response.status,400);
 await f.pg.query("DELETE FROM public.role_permissions WHERE role_id=$1 AND capability='approvals.view'",[f.managerRole]);assert.equal((await f.request('automations/events/'+event.id,undefined,'manager')).response.status,404);assert.equal((await f.events(pending.body.approval.id,'manager')).body.data.length,0);assert.equal((await f.request('automations/rules/'+rule.body.data.id+'/event-preview',{eventId:event.id},'manager')).response.status,404);
});
check('event visibility is filtered before pagination and tenant/bot ceilings do not expand source approval access',async f=>{
 const own=await f.create('OWN','staff'),other=await f.create('OTHER','peer',f.otherHub);assert.equal(own.response.status,202);assert.equal(other.response.status,202);const otherEvent=(await f.events(other.body.approval.id)).body.data[0];
 assert.equal((await f.request('automations/events/'+otherEvent.id,undefined,'staff')).response.status,404);assert.equal((await f.events(other.body.approval.id,'staff','&limit=1')).body.data.length,0);assert.equal((await f.events(own.body.approval.id,'staff','&limit=1')).body.data.length,1);
 await f.pg.query('UPDATE auth_private.credentials SET all_hubs=false WHERE id=$1',[f.credential]);await f.pg.query('INSERT INTO auth_private.credential_hubs(credential_id,academy_id,hub_id) VALUES($1,$2,$3)',[f.credential,f.a,f.hub]);assert.equal((await f.events(other.body.approval.id,'bot')).body.data.length,0);
 assert.equal((await f.request('automations/events',undefined,'foreignMaster',{academy:f.b})).body.data.length,0);
});
check('unbound, duplicate-audit, unsupported and old-audit replays never manufacture verified source events',async f=>{
 const pending=await f.create('PENDING','staff');assert.equal(pending.response.status,202);const bound=(await f.events(pending.body.approval.id)).body.data[0];
 await f.pg.exec('BEGIN');try{await f.pg.query("SELECT set_config('app.academy_id',$1,true)",[f.a]);
  for(const eventType of ['unmapped.event','approval.requested'])await f.pg.query('INSERT INTO public.outbox_events(academy_id,id,event_type,entity_id,request_id) VALUES($1,$2,$3,$4,$5)',[f.a,randomUUID(),eventType,randomUUID(),randomUUID()]);
  await f.pg.query('INSERT INTO public.outbox_events(academy_id,id,event_type,entity_id,request_id) SELECT academy_id,$2,event_type,entity_id,request_id FROM public.outbox_events WHERE id=$1',[bound.id,randomUUID()]);
  const requestId=randomUUID();for(let i=0;i<2;i++)await f.pg.query("INSERT INTO public.audit_events(academy_id,id,actor_id,session_id,actor_kind,request_id,action,entity_id,hub_id,changes) VALUES($1,$2,$3,$4,'human',$5,'approval.requested',$6,$7,'{}')",[f.a,randomUUID(),f.actors.staff.person,f.actors.staff.session,requestId,pending.body.approval.id,f.hub]);
  await f.pg.query("INSERT INTO public.outbox_events(academy_id,id,event_type,entity_id,request_id) VALUES($1,$2,'approval.requested',$3,$4)",[f.a,randomUUID(),pending.body.approval.id,requestId]);await f.pg.exec('COMMIT');
 }catch(error){await f.pg.exec('ROLLBACK');throw error;}
 assert.equal((await f.events(pending.body.approval.id)).body.data.length,1);assert.equal((await f.pg.query('SELECT * FROM public.automation_event_sources')).rows.length,1);
});
check('native event projections are not forgeable by the web role and capture failures roll back the originating proposal atomically',async f=>{
 const pending=await f.create('PENDING','staff');assert.equal(pending.response.status,202);await f.pg.exec('BEGIN');try{await f.pg.query("SELECT set_config('app.academy_id',$1,true)",[f.a]);await f.pg.exec('SET LOCAL ROLE kavosh_runtime');for(const sql of ['INSERT INTO public.automation_event_sources SELECT * FROM public.automation_event_sources','UPDATE public.automation_event_sources SET projection=\'{}\'','DELETE FROM public.automation_event_sources']){await f.pg.exec('SAVEPOINT hostile');await assert.rejects(f.pg.exec(sql));await f.pg.exec('ROLLBACK TO SAVEPOINT hostile');}assert.equal((await f.pg.query<{member:boolean}>("SELECT pg_has_role(current_user,'kavosh_event_policy','member') AS member")).rows[0].member,false);await f.pg.query("SELECT set_config('app.academy_id',$1,true)",[f.b]);assert.equal((await f.pg.query('SELECT * FROM public.automation_event_sources')).rows.length,0);}finally{await f.pg.exec('ROLLBACK');}
 const before=(await f.pg.query('SELECT count(*)::integer AS n FROM public.approval_requests')).rows[0].n;
 await f.pg.exec("CREATE FUNCTION public.reject_bound_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic event-source failure';END $$;CREATE TRIGGER reject_bound_event BEFORE INSERT ON public.automation_event_sources FOR EACH ROW EXECUTE FUNCTION public.reject_bound_event()");assert.equal((await f.create('ROLLBACK','staff')).response.status,503);assert.equal((await f.pg.query('SELECT count(*)::integer AS n FROM public.approval_requests')).rows[0].n,before);
});
check('event cursors retain native microseconds without repeats or dropped events',async f=>{
 const pending=await f.create('PENDING','staff');assert.equal(pending.response.status,202);assert.equal((await f.approve(pending.body.approval.id)).response.status,200);const events=(await f.events(pending.body.approval.id)).body.data;
 // Isolated synthetic cursor timestamps force both rows into one JavaScript
 // millisecond; production roles cannot edit these server-owned timestamps.
 for(let i=0;i<events.length;i++)await f.pg.query('UPDATE public.automation_event_sources SET occurred_at=$2 WHERE event_id=$1',[events[i].id,'2026-11-04T12:00:00.12300'+(i+1)+'Z']);
 const first=await f.events(pending.body.approval.id,'master','&limit=1');assert.equal(first.body.data.length,1);assert.match(first.body.nextCursor.afterOccurredAt,/[.]123001Z$/);const cursor=new URLSearchParams(first.body.nextCursor).toString(),second=await f.events(pending.body.approval.id,'master','&limit=1&'+cursor);assert.equal(second.body.data.length,1);assert.notEqual(second.body.data[0].id,first.body.data[0].id);assert.equal(second.body.nextCursor,null);
});
test('private payroll event sources disappear when underlying pay viewing is revoked even if automation viewing remains',async()=>{
 const f=await workFixture();try{for(const role of [f.staffRole,f.managerRole])await f.pg.query("INSERT INTO public.role_permissions VALUES($1,$2,'automations.view','allow')",[f.a,role]);const pending=await f.create({components:[f.components[0]]},'staff');assert.equal(pending.response.status,202);const path='automations/events?approvalId='+pending.body.approval.id,events=await f.request(path,undefined,'staff');assert.equal(events.response.status,200,JSON.stringify(events.body));assert.equal(events.body.data.length,1);assert.equal(events.body.data[0].sample.hubId,f.hub);await f.pg.query("DELETE FROM public.role_permissions WHERE role_id=$1 AND capability='work-pay.view'",[f.staffRole]);assert.equal((await f.request(path,undefined,'staff')).body.data.length,0);assert.equal((await f.request('automations/events/'+events.body.data[0].id,undefined,'staff')).response.status,404);}finally{await f.pg.close();}
});
test('event-source migration does not invent historical approval snapshots and captures only new publications',async()=>{
 const f=await fixture({throughSchema:59});try{
  const pending=await f.request('automations/rules',{...f.input,definition:{...f.definition,trigger:{kind:'domain_event',eventTypes:['approval.requested']}}},'staff');assert.equal(pending.response.status,202,JSON.stringify(pending.body));const before=(await f.pg.query('SELECT * FROM public.outbox_events ORDER BY id')).rows;
  await f.pg.exec(await readFile(new URL('../db/migrations/060_automation_event_sources.sql',import.meta.url),'utf8'));assert.deepEqual((await f.pg.query('SELECT * FROM public.outbox_events ORDER BY id')).rows,before);assert.equal((await f.pg.query('SELECT * FROM public.automation_event_sources')).rows.length,0);
  // The preservation/no-backfill assertion above is actual59to60 evidence.
  // Current approval code requires the actual remaining migrations,including
  // contextual review concurrency;do not pretend it is the old schema60 app.
  await upgradeToCurrent(f.pg);assert.equal((await f.approve(pending.body.approval.id,'manager')).response.status,200);
  const sources=(await f.pg.query<{projection:{eventType:string};source_version:number}>('SELECT projection,source_version FROM public.automation_event_sources WHERE approval_id=$1',[pending.body.approval.id])).rows;assert.equal(sources.length,1);assert.equal(sources[0].projection.eventType,'approval.applied');assert.equal(sources[0].source_version,2);
 }finally{await f.pg.close();}
});
check('server capture time is not replaced by an outbox supplied timestamp',async f=>{
 const pending=await f.create('PENDING','staff');assert.equal(pending.response.status,202);const requestId=randomUUID(),eventId=randomUUID(),before=Date.now();
 await f.pg.exec('BEGIN');try{await f.pg.query("SELECT set_config('app.academy_id',$1,true)",[f.a]);await f.pg.exec('SET LOCAL ROLE kavosh_runtime');
  await f.pg.query("INSERT INTO public.audit_events(academy_id,id,actor_id,session_id,actor_kind,request_id,action,entity_id,hub_id,changes) VALUES($1,$2,$3,$4,'human',$5,'approval.requested',$6,$7,'{}')",[f.a,randomUUID(),f.actors.staff.person,f.actors.staff.session,requestId,pending.body.approval.id,f.hub]);
  await f.pg.query("INSERT INTO public.outbox_events(academy_id,id,event_type,entity_id,request_id,created_at) VALUES($1,$2,'approval.requested',$3,$4,'2000-01-01T00:00:00Z')",[f.a,eventId,pending.body.approval.id,requestId]);await f.pg.exec('COMMIT');
 }catch(error){await f.pg.exec('ROLLBACK');throw error;}
 const event=await f.request('automations/events/'+eventId);assert.equal(event.response.status,200,JSON.stringify(event.body));const at=Date.parse(event.body.data.recordedAt);assert.ok(at>=before&&at<=Date.now());
});
test('brief native bound-event reads return consistent authorized snapshots',async t=>{
 const f=await fixture();try{if(!f.pg.runtime){t.skip('Independent native PostgreSQL connections required');return;}const pending=await f.create('PENDING','staff');assert.equal(pending.response.status,202);const start=performance.now(),responses=await Promise.all([f.events(pending.body.approval.id,'manager'),f.events(pending.body.approval.id,'manager'),f.events(pending.body.approval.id,'manager')]);assert.ok(responses.every(r=>r.response.status===200&&r.body.data.length===1&&r.body.data[0].sourceVersion===1));console.log(JSON.stringify({measurement:'brief-bound-event-reads',requests:3,elapsedMs:Math.ceil(performance.now()-start)}));}finally{await f.pg.close();}
});
