import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { operationsFixture } from './operations-fixture.ts';

async function fixture(){
 const f=await operationsFixture(),country=randomUUID(),region=randomUUID(),city=randomUUID();
 await f.pg.query("INSERT INTO public.countries(academy_id,id,code,name) VALUES($1,$2,'CA','Canada')",[f.a,country]);
 await f.pg.query("INSERT INTO public.regions(academy_id,id,country_id,code,name) VALUES($1,$2,$3,'ON','Ontario')",[f.a,region,country]);
 await f.pg.query("INSERT INTO public.cities(academy_id,id,region_id,name) VALUES($1,$2,$3,'Toronto')",[f.a,city,region]);
 await f.pg.query("UPDATE public.hubs SET city_id=$1,time_zone='America/Toronto',currency='CAD' WHERE academy_id=$2",[city,f.a]);
 const course=await f.request('courses',{code:'TIME',name:'Time recording curriculum'});assert.equal(course.response.status,201);
 async function createClass(hubId=f.hub){
  const c=await f.request('classes',{hubId,courseId:course.body.data.id,courseVersion:1,name:'Staff session',mode:'in_person',schedule:{oneOff:[{start:'2026-01-02T10:00',end:'2026-01-02T11:00'}]}});assert.equal(c.response.status,201);
  const s=(await f.request('classes/'+c.body.data.id+'/sessions')).body.data[0];return {...c.body.data,session:s};
 }
 const c=await createClass(),other=await createClass(f.otherHub);
 const assignment=await f.request('classes/'+c.id+'/staff',{personId:f.actors.staff.person,role:'teacher',startsOn:'2026-01-02',endsOn:'2026-01-02',reason:'Synthetic accepted staff assignment'});assert.equal(assignment.response.status,201);
 for(const cap of ['session-time.record','session-time.view','session-time.edit'])await f.pg.query("INSERT INTO public.role_permissions VALUES($1,$2,$3,'allow')",[f.a,f.managerRole,cap]);
 await f.pg.query("INSERT INTO public.role_permissions VALUES($1,$2,'session-time.record','allow')",[f.a,f.staffRole]);
 const path='sessions/'+c.session.id+'/my-time',input={expectedVersion:0,assignmentId:assignment.body.data.id,assignmentVersion:1,sessionVersion:1,startsAt:'2026-01-02T14:55:00.123Z',endsAt:'2026-01-02T16:10:00.456Z',reason:'Private manual actual-time evidence'};
 const save=(body:unknown=input,as='staff',key?:string)=>f.request(path,body,as,key?{key}:{});
 return {...f,c,other,path,input,assignment:assignment.body.data,save,createClass};
}
type Fixture=Awaited<ReturnType<typeof fixture>>;
function check(name:string,run:(f:Fixture)=>Promise<void>){test(name,async()=>{const f=await fixture();try{await run(f);}finally{await f.pg.close();}});}

check('staff record exact own time with outside-schedule indicators, safe retries and retained private revisions, never automatic payroll',async f=>{
 const initial=await f.request(f.path,undefined,'staff');assert.equal(initial.body.data,null);assert.deepEqual(initial.body.assignment,{id:f.assignment.id,version:1,role:'teacher'});assert.equal(initial.body.session.timeZone,'America/Toronto');assert.equal(initial.body.session.version,1);assert.equal(initial.body.session.online_url,undefined);
 const key=randomUUID(),first=await f.save(f.input,'staff',key);assert.equal(first.response.status,201,JSON.stringify(first.body));const e=first.body.data;
 assert.equal(e.recordedMilliseconds,4500333);assert.equal(e.outsideScheduleMilliseconds,900333);assert.equal(e.rounded,false);assert.equal(e.payrollApproved,false);assert.equal(e.scheduleChanged,false);
 assert.equal((await f.save(f.input,'staff',key)).body.data.id,e.id);assert.equal((await f.save()).response.status,409);
 const second=await f.save({...f.input,expectedVersion:1,endsAt:'2026-01-02T16:00:00Z'});assert.equal(second.response.status,200,JSON.stringify(second.body));assert.equal(second.body.data.version,2);
 const own=await f.request(f.path,undefined,'staff');assert.equal(own.body.data.id,e.id);
 const history=await f.request('session-time-entries/'+e.id+'/history?limit=1',undefined,'staff');assert.equal(history.body.data[0].definition.reason,f.input.reason);assert.equal(history.body.nextVersion,1);
 assert.equal((await f.request('session-time-entries/'+e.id+'/history?afterVersion=1',undefined,'staff')).body.data.length,1);
 assert.equal((await f.pg.query('SELECT * FROM public.session_time_entries')).rows.length,1);
 assert.equal((await f.pg.query('SELECT * FROM public.finance_journals')).rows.length,0);
 const events=(await f.pg.query<{changes:unknown}>("SELECT changes FROM public.audit_events WHERE action='session.time.recorded'")).rows;assert.equal(events.length,2);assert.doesNotMatch(JSON.stringify(events),/Private manual|14:55/);
});
check('own-time permission does not expose coworkers, unassigned humans cannot record and bots cannot impersonate staff',async f=>{
 const e=(await f.save()).body.data;
 assert.equal((await f.request('sessions/'+f.c.session.id+'/time-entries',undefined,'staff')).response.status,403);
 assert.equal((await f.request('session-time-entries/'+e.id,undefined,'manager')).response.status,200);
 assert.equal((await f.save(f.input,'manager')).response.status,409);
 assert.equal((await f.save(f.input,'bot')).response.status,403);
 assert.equal((await f.request(f.path+'?personId='+f.actors.manager.person,undefined,'staff')).response.status,400);
 assert.equal((await f.save({...f.input,personId:f.actors.manager.person})).response.status,400);
 await f.pg.query("INSERT INTO public.role_permissions VALUES($1,$2,'session-time.record','allow') ON CONFLICT DO NOTHING",[f.a,f.policyRole]);
 const mgrAssignment=await f.request('classes/'+f.c.id+'/staff',{personId:f.actors.manager.person,role:'ta',startsOn:'2026-01-01',reason:'Other assigned staff'});assert.equal(mgrAssignment.response.status,201);
 const other=await f.save({...f.input,assignmentId:mgrAssignment.body.data.id},'manager');assert.equal(other.response.status,201);
 assert.equal((await f.request('session-time-entries/'+other.body.data.id,undefined,'staff')).response.status,403);
 assert.equal((await f.request('session-time-entries/'+other.body.data.id+'/history',undefined,'staff')).response.status,403);
 const all=await f.request('sessions/'+f.c.session.id+'/time-entries?limit=1',undefined,'manager');assert.equal(all.body.data.length,1);assert.ok(all.body.nextCursor);
 assert.equal((await f.request('sessions/'+f.c.session.id+'/time-entries?after='+all.body.nextCursor,undefined,'manager')).body.data.length,1);
});
check('time correction needs upper human approval, preserves original evidence and refuses beneficiary review',async f=>{
 const e=(await f.save()).body.data,correction={expectedVersion:1,sessionVersion:1,startsAt:'2026-01-02T15:00:00Z',endsAt:'2026-01-02T16:00:00Z',reason:'Private admin correction'};
 const proposal=await f.request('session-time-entries/'+e.id+'/change',correction,'manager');assert.equal(proposal.response.status,202,JSON.stringify(proposal.body));
 assert.equal((await f.request(f.path,undefined,'staff')).body.data.version,1);assert.equal((await f.approve(proposal.body.approval.id,'manager')).response.status,403);
 const applied=await f.approve(proposal.body.approval.id);assert.equal(applied.response.status,200,JSON.stringify(applied.body));assert.equal(applied.body.data.outsideScheduleMilliseconds,0);assert.equal(applied.body.data.payrollApproved,false);
 const history=await f.request('session-time-entries/'+e.id+'/history',undefined,'staff');assert.equal(history.body.data.length,2);assert.equal(history.body.data[0].definition.reason,f.input.reason);
 // A different requester cannot make the teacher review his own changed hours.
 for(const cap of ['session-time.view','session-time.edit','approvals.review','approvals.view'])await f.pg.query("INSERT INTO public.role_permissions VALUES($1,$2,$3,'allow') ON CONFLICT DO NOTHING",[f.a,f.staffRole,cap]);
 await f.pg.query('UPDATE public.people SET supervisor_person_id=NULL WHERE id=$1',[f.actors.staff.person]);await f.pg.query('UPDATE public.people SET supervisor_person_id=$1 WHERE id=$2',[f.actors.staff.person,f.actors.manager.person]);
 const ownBenefit=await f.request('session-time-entries/'+e.id+'/change',{...correction,expectedVersion:2},'manager');assert.equal(ownBenefit.response.status,202);
 const rejected=await f.approve(ownBenefit.body.approval.id,'staff');assert.equal(rejected.response.status,403);assert.equal(rejected.body.error.code,'BENEFICIARY_REVIEW_FORBIDDEN');
});
check('changed own time invalidates pending corrections and revoked viewing hides private approval history',async f=>{
 const e=(await f.save()).body.data,change={expectedVersion:1,sessionVersion:1,startsAt:'2026-01-02T15:00:00Z',endsAt:'2026-01-02T16:00:00Z',reason:'Sensitive pending revision'};
 const pending=await f.request('session-time-entries/'+e.id+'/change',change,'manager');assert.equal(pending.response.status,202);
 assert.equal((await f.save({...f.input,expectedVersion:1,reason:'Teacher corrected before review'})).response.status,200);
 const stale=await f.approve(pending.body.approval.id);assert.equal(stale.response.status,409);assert.equal(stale.body.approval.status,'stale');
 const next=await f.request('session-time-entries/'+e.id+'/change',{...change,expectedVersion:2},'manager');assert.equal(next.response.status,202);
 await f.pg.query("DELETE FROM public.role_permissions WHERE role_id=$1 AND capability='session-time.view'",[f.managerRole]);
 assert.equal((await f.request('approvals/'+next.body.approval.id,undefined,'manager')).response.status,404);
 assert.ok(!(await f.request('approvals',undefined,'manager')).body.data.some((p:{id:string})=>p.id===next.body.approval.id));
});
check('cancellation or rescheduling never deletes delivered time; self edits require active dated assignment and current schedule evidence',async f=>{
 const e=(await f.save()).body.data;
 const changed=await f.request('sessions/'+f.c.session.id+'/change',{expectedVersion:1,reason:'Historical cancellation correction',change:{kind:'cancel'}});assert.equal(changed.response.status,200);
 const retained=await f.request(f.path,undefined,'staff');assert.equal(retained.body.data.version,1);assert.equal(retained.body.data.scheduleChanged,true);assert.equal(retained.body.data.recordedMilliseconds,4500333);
 assert.equal((await f.save({...f.input,expectedVersion:1,sessionVersion:2})).response.status,409);
 const corrected=await f.request('session-time-entries/'+e.id+'/change',{expectedVersion:1,sessionVersion:2,startsAt:f.input.startsAt,endsAt:'2026-01-02T16:00:00Z',reason:'Retain actually delivered time despite calendar correction'});assert.equal(corrected.response.status,200,JSON.stringify(corrected.body));
 assert.equal(corrected.body.data.version,2);assert.equal(corrected.body.data.payrollApproved,false);
});
check('invalid durations, future claims, malformed submillisecond inputs and stale assignment/session versions do not persist',async f=>{
 for(const patch of [{startsAt:f.input.endsAt},{endsAt:'2026-01-04T16:00:00Z'},{startsAt:'2026-01-02T14:55:00.1234Z'},{sessionVersion:2},{assignmentVersion:2},{startsAt:'2099-01-01T00:00:00Z',endsAt:'2099-01-01T01:00:00Z'}])assert.ok([400,409].includes((await f.save({...f.input,...patch})).response.status));
 await f.pg.query('UPDATE public.class_staff SET active=false WHERE id=$1',[f.assignment.id]);assert.equal((await f.save()).body.error.code,'STAFF_ASSIGNMENT_CHANGED');
 assert.equal((await f.pg.query('SELECT * FROM public.session_time_entries')).rows.length,0);
});
check('own staff eligibility uses the saved class-local start day across midnight, never UTC or the class end day',async f=>{
 const created=await f.request('classes',{hubId:f.hub,courseId:f.c.course_id,courseVersion:1,name:'Late local session',mode:'in_person',schedule:{oneOff:[{start:'2026-01-02T23:30',end:'2026-01-03T00:30'}]}});assert.equal(created.response.status,201);
 const s=(await f.request('classes/'+created.body.data.id+'/sessions')).body.data[0];assert.match(s.starts_at,/2026-01-03T/);
 const a=await f.request('classes/'+created.body.data.id+'/staff',{personId:f.actors.staff.person,role:'ta',startsOn:'2026-01-02',endsOn:'2026-01-02',reason:'Only assigned on the local start day'});assert.equal(a.response.status,201);
 await f.pg.query("UPDATE public.hubs SET time_zone='Pacific/Kiritimati' WHERE id=$1",[f.hub]);
 const path='sessions/'+s.id+'/my-time',context=await f.request(path,undefined,'staff');assert.equal(context.body.assignment.id,a.body.data.id);assert.equal(context.body.session.timeZone,'America/Toronto');
 const saved=await f.request(path,{...f.input,assignmentId:a.body.data.id,startsAt:'2026-01-03T04:30:00Z',endsAt:'2026-01-03T05:30:00Z'},'staff');assert.equal(saved.response.status,201,JSON.stringify(saved.body));assert.equal(saved.body.data.outsideScheduleMilliseconds,0);
 await f.pg.query("UPDATE public.class_sessions SET time_info=time_info-'localStart' WHERE id=$1",[s.id]);assert.equal((await f.request(path,undefined,'staff')).body.error.code,'SESSION_TIME_EVIDENCE_INVALID');
});
check('class-only grants isolate time records and explicit class denials override a broad self-record grant',async f=>{
 const r=await f.request('roles',{name:'One class personal time',permissions:[{capability:'session-time.record',effect:'allow'}]});assert.equal(r.response.status,201);
 const target='people/'+f.actors.staff.person+'/access',before=await f.request(target);
 assert.equal((await f.request(target,{expectedVersion:before.body.data.version,assignments:[{roleId:r.body.data.id,allHubs:false,classIds:[f.c.id]}]})).response.status,200);
 assert.equal((await f.save()).response.status,201);assert.equal((await f.request('sessions/'+f.other.session.id+'/my-time',undefined,'staff')).response.status,404);
 const deny=await f.request('roles',{name:'Personal time class blocked',permissions:[{capability:'session-time.record',effect:'deny'}]}),v=(await f.request(target)).body.data.version;
 assert.equal((await f.request(target,{expectedVersion:v,assignments:[{roleId:r.body.data.id,allHubs:true},{roleId:deny.body.data.id,allHubs:false,classIds:[f.c.id]}]})).response.status,200);
 assert.equal((await f.request(f.path,undefined,'staff')).response.status,404);
});
check('revoked personal-time rights block idempotent private-response replay and bots remain proposal-only for corrections',async f=>{
 const key=randomUUID(),saved=await f.save(f.input,'staff',key);assert.equal(saved.response.status,201);
 await f.pg.query("DELETE FROM public.role_permissions WHERE role_id=$1 AND capability='session-time.record'",[f.staffRole]);
 assert.equal((await f.save(f.input,'staff',key)).response.status,403);
 const correction=await f.request('session-time-entries/'+saved.body.data.id+'/change',{expectedVersion:1,sessionVersion:1,startsAt:f.input.startsAt,endsAt:'2026-01-02T16:00:00Z',reason:'Scoped bot proposes only'},'bot');assert.equal(correction.response.status,202,JSON.stringify(correction.body));
 assert.equal((await f.approve(correction.body.approval.id,'bot')).response.status,403);assert.equal((await f.approve(correction.body.approval.id)).response.status,200);
});
check('time writes and history roll back atomically if notification event persistence fails',async f=>{
 await f.pg.exec("CREATE FUNCTION public.reject_time_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.event_type='session.time.recorded' THEN RAISE EXCEPTION 'synthetic failure';END IF;RETURN NEW;END $$;CREATE TRIGGER reject_time_event BEFORE INSERT ON public.outbox_events FOR EACH ROW EXECUTE FUNCTION public.reject_time_event()");
 assert.equal((await f.save()).response.status,503);assert.equal((await f.pg.query('SELECT * FROM public.session_time_entries')).rows.length,0);assert.equal((await f.pg.query('SELECT * FROM public.session_time_revisions')).rows.length,0);
});
check('native time invariants preserve tenant identity, exact history and server-owned audit fields',async f=>{
 const saved=await f.save();assert.equal(saved.response.status,201,JSON.stringify(saved.body));const e=saved.body.data;
 await f.pg.exec('BEGIN');await f.pg.query("SELECT set_config('app.academy_id',$1,true)",[f.a]);await f.pg.exec('SET LOCAL ROLE kavosh_runtime');
 try{
  for(const [sql,params] of [
   ['DELETE FROM public.session_time_entries WHERE id=$1',[e.id]],
   ["UPDATE public.session_time_entries SET created_at=now() WHERE id=$1",[e.id]],
   ["UPDATE public.session_time_revisions SET definition='{}' WHERE entry_id=$1",[e.id]],
   ['UPDATE public.session_time_entries SET ends_at=starts_at,version=version+1 WHERE id=$1',[e.id]],
   ["INSERT INTO public.session_time_revisions(academy_id,entry_id,version,definition) VALUES($1,$2,99,'{}')",[f.a,e.id]],
   ['UPDATE public.session_time_entries SET changed_by=$2,version=version+1 WHERE id=$1',[e.id,f.actors.manager.person]]
  ] as [string,unknown[]][]){await f.pg.exec('SAVEPOINT hostile');await assert.rejects(f.pg.query(sql,params));await f.pg.exec('ROLLBACK TO SAVEPOINT hostile');}
  await f.pg.query("SELECT set_config('app.academy_id',$1,true)",[f.b]);assert.equal((await f.pg.query('SELECT * FROM public.session_time_entries WHERE id=$1',[e.id])).rows.length,0);assert.equal((await f.pg.query('SELECT * FROM public.session_time_revisions WHERE entry_id=$1',[e.id])).rows.length,0);
 }finally{await f.pg.exec('ROLLBACK');}
 // Even a valid update cannot commit without the matching immutable revision.
 await f.pg.exec('BEGIN');await f.pg.query("SELECT set_config('app.academy_id',$1,true)",[f.a]);await f.pg.exec('SET LOCAL ROLE kavosh_runtime');
 await f.pg.query('UPDATE public.session_time_entries SET version=version+1 WHERE id=$1',[e.id]);await assert.rejects(f.pg.exec('COMMIT'),/TIME_REVISION_MISSING/);await f.pg.exec('ROLLBACK');
 assert.equal((await f.request(f.path,undefined,'staff')).body.data.version,1);
 const correction={expectedVersion:1,sessionVersion:1,startsAt:'2026-01-02T15:00:00Z',endsAt:'2026-01-02T16:00:00Z',reason:'Cannot commit an undecided native correction'},p=await f.request('session-time-entries/'+e.id+'/change',correction,'manager');assert.equal(p.response.status,202);
 await f.pg.exec('BEGIN');await f.pg.query("SELECT set_config('app.academy_id',$1,true)",[f.a]);await f.pg.exec('SET LOCAL ROLE kavosh_runtime');
 await f.pg.query('UPDATE public.session_time_entries SET starts_at=$2,ends_at=$3,reason=$4,version=version+1,changed_by=$5,approval_id=$6 WHERE id=$1',[e.id,correction.startsAt,correction.endsAt,correction.reason,f.actors.master.person,p.body.approval.id]);
 await f.pg.query('INSERT INTO public.session_time_revisions(academy_id,entry_id,version,definition) SELECT academy_id,id,version,to_jsonb(e) FROM public.session_time_entries e WHERE id=$1',[e.id]);
 await assert.rejects(f.pg.exec('COMMIT'),/TIME_CORRECTION_NOT_APPLIED/);await f.pg.exec('ROLLBACK');assert.equal((await f.approve(p.body.approval.id)).response.status,200);
});
test('two simultaneous personal time submissions cannot overwrite one another',async t=>{
 const f=await fixture();try{
  if(!f.pg.runtime){t.skip('Requires independent native PostgreSQL connections');return;}
  const started=performance.now(),results=await Promise.all([f.save(),f.save({...f.input,reason:'Concurrent competing source'})]);
  assert.deepEqual(results.map(r=>r.response.status).sort(),[201,409]);assert.equal((await f.pg.query('SELECT * FROM public.session_time_revisions')).rows.length,1);
  console.log(JSON.stringify({measurement:'brief-session-time-race',requests:2,winners:1,elapsedMs:Math.ceil(performance.now()-started)}));
 }finally{await f.pg.close();}
});
