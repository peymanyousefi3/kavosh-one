import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Temporal } from '@js-temporal/polyfill';
import { operationsFixture } from './operations-fixture.ts';

async function fixture() {
  const f=await operationsFixture(),country=randomUUID(),region=randomUUID(),city=randomUUID();
  await f.pg.query("INSERT INTO public.countries(academy_id,id,code,name) VALUES($1,$2,'CA','Canada')",[f.a,country]);
  await f.pg.query("INSERT INTO public.regions(academy_id,id,country_id,code,name) VALUES($1,$2,$3,'ON','Ontario')",[f.a,region,country]);
  await f.pg.query("INSERT INTO public.cities(academy_id,id,region_id,name) VALUES($1,$2,$3,'Toronto')",[f.a,city,region]);
  await f.pg.query("UPDATE public.hubs SET city_id=$1,time_zone='America/Toronto',currency='CAD' WHERE academy_id=$2",[city,f.a]);
  const course=await f.request('courses',{code:'ENROL',name:'Enrollment curriculum'});assert.equal(course.response.status,201);
  async function createClass(hubId=f.hub,start='2027-01-01T23:30',end='2027-01-02T00:30',disambiguation='reject') {
    const result=await f.request('classes',{hubId,courseId:course.body.data.id,courseVersion:1,name:'Enrollment test class',mode:'in_person',schedule:{oneOff:[{start,end,disambiguation}]}});
    assert.equal(result.response.status,201,JSON.stringify(result.body));const session=(await f.request('classes/'+result.body.data.id+'/sessions')).body.data[0];return {...result.body.data,session};
  }
  async function student(name:string,hubId=f.hub) {
    const p=await f.request('people',{name,hubId});assert.equal(p.response.status,201);
    assert.equal((await f.request('students',{personId:p.body.data.id,legalName:'Private legal '+name,preferredName:name,dateOfBirth:'2014-03-20',shirtSize:'Private size',recruiter:{kind:'academy'}})).response.status,201);return p.body.data.id as string;
  }
  const first=await createClass(),second=await createClass(),other=await createClass(f.otherHub),one=await student('One'),two=await student('Two');
  for(const role of [f.staffRole,f.managerRole])for(const cap of ['enrollments.view','enrollments.edit','rosters.view','students.view'])await f.pg.query("INSERT INTO public.role_permissions VALUES($1,$2,$3,'allow')",[f.a,role,cap]);
  const input={studentId:one,studentProfileVersion:1,joinsOn:'2027-01-01',leavesOn:'2027-01-31',reason:'Private enrollment evidence note'};
  async function add(body:unknown=input,classId=first.id,as='master',key?:string){return f.request('classes/'+classId+'/enrollments',body,as,key?{key}:{});}
  return {...f,first,second,other,one,two,input,add,student,createClass};
}
type Fixture=Awaited<ReturnType<typeof fixture>>;
function check(name:string,run:(f:Fixture)=>Promise<void>){test(name,async()=>{const f=await fixture();try{await run(f);}finally{await f.pg.close();}});}

check('joining/leaving dates are inclusive and pre-join, post-leave and disabled enrollment periods never appear in roster candidates',async f=>{
  const added=await f.add();assert.equal(added.response.status,201,JSON.stringify(added.body));const id=added.body.data.id;
  for(const on of ['2027-01-01','2027-01-31'])assert.equal((await f.request('classes/'+f.first.id+'/roster?on='+on)).body.data.length,1);
  for(const on of ['2026-12-31','2027-02-01'])assert.equal((await f.request('classes/'+f.first.id+'/roster?on='+on)).body.data.length,0);
  assert.equal((await f.request('enrollments/'+id+'/change',{expectedVersion:1,enabled:false,reason:'Void mistaken membership'})).response.status,200);
  assert.equal((await f.request('classes/'+f.first.id+'/roster?on=2027-01-01')).body.data.length,0);
  const correction=await f.request('enrollments/'+id+'/change',{expectedVersion:2,leavesOn:null,reason:'Correct held period'});assert.equal(correction.response.status,200);assert.equal(correction.body.data.enabled,false,'partial corrections must not reactivate the period');
  const history=await f.request('enrollments/'+id+'/history?limit=1');assert.equal(history.body.data[0].definition.joins_on,'2027-01-01');assert.equal(history.body.nextVersion,1);
  assert.equal((await f.request('enrollments/'+id+'/history?afterVersion=1')).body.data.length,2);
});
check('session roster uses preserved local start day, not UTC or end day, and request parameters cannot override that day',async f=>{
  assert.match(f.first.session.starts_at,/2027-01-02T/);assert.equal(f.first.session.time_info.localStart,'2027-01-01T23:30');
  assert.equal((await f.add({...f.input,studentId:f.two,joinsOn:'2027-01-02'})).response.status,201);assert.equal((await f.add()).response.status,201);
  const roster=await f.request('sessions/'+f.first.session.id+'/roster');assert.equal(roster.response.status,200,JSON.stringify(roster.body));assert.equal(roster.body.on,'2027-01-01');assert.deepEqual(roster.body.data.map((r:{student_id:string})=>r.student_id),[f.one]);
  assert.deepEqual(Object.keys(roster.body.data[0]).sort(),['enrollment_id','student_id','display_name'].sort());
  assert.equal((await f.request('sessions/'+f.first.session.id+'/roster?on=2027-01-02')).response.status,400);
  await f.pg.query("UPDATE public.hubs SET time_zone='Pacific/Kiritimati' WHERE id=$1",[f.hub]);
  const ahead=await f.createClass(f.hub,'2027-01-02T00:30','2027-01-02T01:30');assert.match(ahead.session.starts_at,/2027-01-01T/);
  assert.equal((await f.add({...f.input,studentId:f.two,joinsOn:'2027-01-02'},ahead.id)).response.status,201);
  const nextDay=await f.request('sessions/'+ahead.session.id+'/roster');assert.equal(nextDay.body.on,'2027-01-02');assert.equal(nextDay.body.data[0].student_id,f.two);
  assert.equal((await f.request('sessions/'+f.first.session.id+'/roster')).body.timeZone,'America/Toronto','hub changes never reinterpret a saved class');
});
check('skipped civil dates use resolved session evidence and malformed or contradictory evidence fails closed',async f=>{
  await f.pg.query("UPDATE public.hubs SET time_zone='Pacific/Apia' WHERE id=$1",[f.hub]);
  const shifted=await f.createClass(f.hub,'2011-12-30T10:00','2011-12-30T11:00','later');assert.equal(shifted.session.time_info.localStart,'2011-12-31T10:00');
  assert.equal((await f.request('students/'+f.one+'/update',{expectedVersion:1,dateOfBirth:'2004-03-20'})).response.status,200);
  assert.equal((await f.add({...f.input,studentProfileVersion:2,joinsOn:'2011-12-31',leavesOn:'2011-12-31'},shifted.id)).response.status,201);
  const roster=await f.request('sessions/'+shifted.session.id+'/roster');assert.equal(roster.body.on,'2011-12-31');assert.equal(roster.body.data[0].student_id,f.one);
  const original=shifted.session.time_info;
  for(const patch of [{localStart:'2011-12-30T10:00'},{startOffset:'+12:00'},{timeZone:'UTC'},{start:'2011-12-30T00:00:00Z'},{localStart:undefined}]) {
    await f.pg.query('UPDATE public.class_sessions SET time_info=$2::jsonb WHERE id=$1',[shifted.session.id,JSON.stringify({...original,...patch})]);
    const bad=await f.request('sessions/'+shifted.session.id+'/roster');assert.equal(bad.response.status,409);assert.equal(bad.body.error.code,'SESSION_TIME_EVIDENCE_INVALID');
  }
});
check('session cancellation and approved rescheduling update roster date selection without rewriting enrollment history',async f=>{
  assert.equal((await f.add({...f.input,joinsOn:'2027-01-02'})).response.status,201);
  assert.equal((await f.request('sessions/'+f.first.session.id+'/roster')).body.data.length,0);
  assert.equal((await f.request('sessions/'+f.first.session.id+'/change',{expectedVersion:1,reason:'Move actual class day',change:{kind:'reschedule',start:'2027-01-02T10:00',end:'2027-01-02T11:00'}})).response.status,200);
  assert.equal((await f.request('sessions/'+f.first.session.id+'/roster')).body.data.length,1);
  assert.equal((await f.request('sessions/'+f.first.session.id+'/change',{expectedVersion:2,reason:'Cancel class',change:{kind:'cancel'}})).response.status,200);
  const cancelled=await f.request('sessions/'+f.first.session.id+'/roster');assert.equal(cancelled.body.sessionStatus,'cancelled');assert.equal(cancelled.body.data.length,0);
  assert.equal((await f.pg.query('SELECT * FROM public.class_enrollment_revisions')).rows.length,1);
});
check('administrative enrollment approval is private, upper-reviewed and cannot be decided by the student or a linked guardian beneficiary',async f=>{
  const pending=await f.add(f.input,f.first.id,'staff');assert.equal(pending.response.status,202,JSON.stringify(pending.body));assert.equal((await f.request('classes/'+f.first.id+'/roster?on=2027-01-01')).body.data.length,0);
  assert.equal((await f.approve(pending.body.approval.id,'staff')).response.status,403);assert.equal((await f.approve(pending.body.approval.id,'manager')).response.status,200);
  const parent=await f.request('guardians',{personId:f.actors.manager.person,legalName:'Reviewing guardian'});assert.equal(parent.response.status,201);
  assert.equal((await f.request('students/'+f.two+'/guardians',{guardianId:f.actors.manager.person,relationship:'parent',reason:'Administrative family relationship'})).response.status,201);
  const ownChild=await f.add({...f.input,studentId:f.two},f.first.id,'staff');assert.equal(ownChild.response.status,202);
  const locks=f.metrics.exclusivePolicyLocks,denied=await f.approve(ownChild.body.approval.id,'manager');assert.equal(denied.response.status,403);assert.equal(denied.body.error.code,'BENEFICIARY_REVIEW_FORBIDDEN');assert.equal(f.metrics.exclusivePolicyLocks,locks);
  assert.equal((await f.request('approvals/'+ownChild.body.approval.id)).body.data.status,'pending');assert.equal((await f.approve(ownChild.body.approval.id)).response.status,200);
  const more=await f.add({...f.input,joinsOn:'2027-02-01',leavesOn:null},f.first.id,'staff');assert.equal(more.response.status,202);
  await f.pg.query("DELETE FROM public.role_permissions WHERE role_id=$1 AND capability='enrollments.view'",[f.managerRole]);
  assert.equal((await f.request('approvals/'+more.body.approval.id,undefined,'manager')).response.status,404);
  assert.ok(!(await f.request('approvals',undefined,'manager')).body.data.some((r:{id:string})=>r.id===more.body.approval.id));
});
check('class roster rights reveal only scoped minimal names and cannot select hidden students or expose private profiles or other classes',async f=>{
  assert.equal((await f.add()).response.status,201);assert.equal((await f.add(f.input,f.other.id)).response.status,201);
  const r=await f.request('roles',{name:'One class roster only',permissions:[{capability:'rosters.view',effect:'allow'}]});assert.equal(r.response.status,201);
  const current=await f.request('people/'+f.actors.staff.person+'/access');assert.equal((await f.request('people/'+f.actors.staff.person+'/access',{expectedVersion:current.body.data.version,assignments:[{roleId:r.body.data.id,allHubs:false,classIds:[f.first.id]}]})).response.status,200);
  assert.equal((await f.request('classes/'+f.first.id+'/roster?on=2027-01-01',undefined,'staff')).response.status,200);
  assert.equal((await f.request('classes/'+f.other.id+'/roster?on=2027-01-01',undefined,'staff')).response.status,404);
  assert.equal((await f.request('classes/'+f.first.id+'/enrollments',undefined,'staff')).response.status,403);
  assert.equal((await f.request('students/'+f.one,undefined,'staff')).response.status,403);
  assert.equal((await f.request('classes/'+f.first.id,undefined,'staff')).response.status,403);
  const before=f.metrics.exclusivePolicyLocks;
  assert.equal((await f.add(f.input,f.other.id,'staff')).response.status,403);assert.equal(f.metrics.exclusivePolicyLocks,before);
});
check('selected-student registration views expose that student only, not peers, private profiles, lesson links or internal approval history',async f=>{
  for(const classId of [f.first.id,f.other.id])assert.equal((await f.add(f.input,classId)).response.status,201);
  assert.equal((await f.add({...f.input,studentId:f.two})).response.status,201);
  const r=await f.request('roles',{name:'One student registration viewer',permissions:[{capability:'registrations.view',effect:'allow'}]});assert.equal(r.response.status,201);
  const prior=await f.request('people/'+f.actors.staff.person+'/access');assert.equal((await f.request('people/'+f.actors.staff.person+'/access',{expectedVersion:prior.body.data.version,assignments:[{roleId:r.body.data.id,allHubs:false,personIds:[f.one]}]})).response.status,200);
  const own=await f.request('students/'+f.one+'/enrollments',undefined,'staff');assert.equal(own.response.status,200,JSON.stringify(own.body));assert.equal(own.body.data.length,2);assert.equal(own.body.data[0].course_name,'Enrollment curriculum');
  for(const row of own.body.data)for(const hidden of ['date_of_birth','student_profile_version','online_url','reason','last_approval_id'])assert.equal(row[hidden],undefined);
  assert.equal((await f.request('students/'+f.two+'/enrollments',undefined,'staff')).response.status,404);
  assert.equal((await f.request('students/'+f.one,undefined,'staff')).response.status,403);
  assert.equal((await f.request('classes/'+f.first.id+'/roster?on=2027-01-01',undefined,'staff')).response.status,403);
  assert.equal((await f.request('enrollments/'+own.body.data[0].id+'/history',undefined,'staff')).response.status,403);
});
check('student registration views honor record-hub denials and limited bot ceilings even for explicitly selected students',async f=>{
  for(const classId of [f.first.id,f.other.id])assert.equal((await f.add(f.input,classId)).response.status,201);
  const role=await f.request('roles',{name:'Student registration source',permissions:[{capability:'registrations.view',effect:'allow'}]}),deny=await f.request('roles',{name:'Registration hub restriction',permissions:[{capability:'registrations.view',effect:'deny'}]});
  const prior=await f.request('people/'+f.actors.staff.person+'/access');assert.equal((await f.request('people/'+f.actors.staff.person+'/access',{expectedVersion:prior.body.data.version,assignments:[{roleId:role.body.data.id,allHubs:false,personIds:[f.one]},{roleId:deny.body.data.id,allHubs:false,hubIds:[f.otherHub]}]})).response.status,200);
  let own=await f.request('students/'+f.one+'/enrollments',undefined,'staff');assert.equal(own.body.data.length,1);assert.equal(own.body.data[0].hub_id,f.hub);
  const botPrior=await f.request('people/'+f.bot+'/access');assert.equal((await f.request('people/'+f.bot+'/access',{expectedVersion:botPrior.body.data.version,assignments:[{roleId:role.body.data.id,allHubs:false,personIds:[f.one]}]})).response.status,200);
  assert.equal((await f.request('students/'+f.one+'/enrollments',undefined,'bot')).body.data.length,2);
  await f.pg.query('UPDATE auth_private.credentials SET all_hubs=false WHERE id=$1',[f.credential]);await f.pg.query('INSERT INTO auth_private.credential_hubs VALUES($1,$2,$3)',[f.credential,f.a,f.hub]);
  own=await f.request('students/'+f.one+'/enrollments',undefined,'bot');assert.equal(own.response.status,200);assert.equal(own.body.data.length,1);assert.equal(own.body.data[0].hub_id,f.hub);
});
check('registration delegation cannot expand primary-hub rights into all student registrations or drop record-hub denials',async f=>{
  const viewer=await f.request('roles',{name:'Registration delegation viewer',permissions:[{capability:'registrations.view',effect:'allow'}]}),deny=await f.request('roles',{name:'Registration delegation deny',permissions:[{capability:'registrations.view',effect:'deny'}]}),access=await f.request('roles',{name:'Registration delegation administration',permissions:[{capability:'access.edit',effect:'allow'}]});
  for(const result of [viewer,deny,access])assert.equal(result.response.status,201);
  const target='people/'+f.actors.staff.person+'/access',version=(await f.request(target)).body.data.version;
  const selected={roleId:viewer.body.data.id,allHubs:false,personIds:[f.one]},blocked={roleId:deny.body.data.id,allHubs:false,hubIds:[f.otherHub]};
  await f.pg.query("INSERT INTO public.role_permissions VALUES($1,$2,'registrations.view','allow')",[f.a,f.managerRole]);
  let result=await f.request(target,{expectedVersion:version,assignments:[selected]},'manager');assert.equal(result.response.status,403);assert.equal(result.body.error.code,'DELEGATION_EXCEEDS_AUTHORITY','primary-hub authority is not all registrations authority');
  const managerPath='people/'+f.actors.manager.person+'/access',current=await f.request(managerPath);
  assert.equal((await f.request(managerPath,{expectedVersion:current.body.data.version,assignments:[selected,blocked,{roleId:access.body.data.id,allHubs:true},{roleId:f.managerRole,allHubs:false,hubIds:[f.hub]}]})).response.status,200);
  result=await f.request(target,{expectedVersion:version,assignments:[selected]},'manager');assert.equal(result.response.status,403);assert.equal(result.body.error.code,'DELEGATION_EXCEEDS_AUTHORITY','selected-student authority must preserve record-hub exclusions');
  result=await f.request(target,{expectedVersion:version,assignments:[selected,blocked]},'manager');assert.equal(result.response.status,202,JSON.stringify(result.body));assert.equal((await f.approve(result.body.approval.id)).response.status,200);
  await f.pg.query('UPDATE auth_private.credentials SET all_hubs=false WHERE id=$1',[f.credential]);await f.pg.query('INSERT INTO auth_private.credential_hubs VALUES($1,$2,$3)',[f.credential,f.a,f.hub]);
  const botPath='people/'+f.bot+'/access',botCurrent=await f.request(botPath);
  assert.equal((await f.request(botPath,{expectedVersion:botCurrent.body.data.version,assignments:[selected,{roleId:f.managerRole,allHubs:false,hubIds:[f.hub]}]})).response.status,200);
  const staffCurrent=await f.request(target);
  result=await f.request(target,{expectedVersion:staffCurrent.body.data.version,assignments:[selected]},'bot');assert.equal(result.response.status,403);assert.equal(result.body.error.code,'DELEGATION_EXCEEDS_AUTHORITY','finite bot hub ceiling cannot delegate unbounded future registrations');
});
check('student and guardian beneficiaries cannot review enrollment benefits while the master retains self-approval',async f=>{
  for(const personId of [f.actors.manager.person,f.actors.master.person])assert.equal((await f.request('students',{personId,legalName:'Adult learner',dateOfBirth:'1990-01-01',recruiter:{kind:'academy'}})).response.status,201);
  const pending=await f.add({...f.input,studentId:f.actors.manager.person},f.first.id,'staff');assert.equal(pending.response.status,202);
  assert.equal((await f.approve(pending.body.approval.id,'manager')).response.status,403);assert.equal((await f.request('approvals/'+pending.body.approval.id)).body.data.status,'pending');assert.equal((await f.approve(pending.body.approval.id)).response.status,200);
  const master=await f.add({...f.input,studentId:f.actors.master.person});assert.equal(master.response.status,201);assert.equal(master.body.approval.selfApproved,true);
});
check('profile-basis snapshots stay pinned unless explicitly refreshed and pending profile or period changes invalidate approval',async f=>{
  const added=await f.add();assert.equal(added.response.status,201);const id=added.body.data.id;
  assert.equal((await f.request('students/'+f.one+'/update',{expectedVersion:1,preferredName:'New nickname'})).response.status,200);
  const changed=await f.request('enrollments/'+id+'/change',{expectedVersion:1,leavesOn:null,reason:'Update period only'});assert.equal(changed.response.status,200);assert.equal(changed.body.data.student_profile_version,1);
  assert.equal((await f.request('enrollments/'+id+'/change',{expectedVersion:2,studentProfileVersion:1,reason:'Stale profile reference'})).response.status,409);
  assert.equal((await f.request('enrollments/'+id+'/change',{expectedVersion:2,studentProfileVersion:2,reason:'Refresh explicitly'})).response.status,200);
  const pending=await f.add({...f.input,studentId:f.two},f.second.id,'staff');assert.equal(pending.response.status,202);
  assert.equal((await f.request('students/'+f.two+'/update',{expectedVersion:1,shirtSize:'Changed'})).response.status,200);
  const stale=await f.approve(pending.body.approval.id);assert.equal(stale.response.status,409);assert.equal(stale.body.approval.decisionCode,'DEPENDENCIES_CHANGED');
  const future=await f.add({...f.input,studentProfileVersion:2,joinsOn:'2028-01-01',leavesOn:null},f.first.id,'staff');assert.equal(future.response.status,202);
  assert.equal((await f.request('enrollments/'+id+'/change',{expectedVersion:3,enabled:false,reason:'Void current membership'})).response.status,200);
  assert.equal((await f.approve(future.body.approval.id)).response.status,409);
});
check('native enrollment ranges reject duplicates, allow adjacent dates and allow simultaneous different classes',async f=>{
  assert.equal((await f.add()).response.status,201);
  const overlap=await f.add({...f.input,joinsOn:'2027-01-31',leavesOn:'2027-02-28'});assert.equal(overlap.response.status,409);assert.equal(overlap.body.error.code,'ENROLLMENT_PERIOD_OVERLAP');
  assert.equal((await f.add({...f.input,joinsOn:'2027-02-01',leavesOn:null})).response.status,201);
  assert.equal((await f.add(f.input,f.second.id)).response.status,201);
  assert.equal((await f.request('classes/'+f.first.id+'/enrollments?studentId='+f.one+'&on=2027-02-01&enabled=true')).body.data.length,1);
});
check('enabled membership cannot precede its pinned birth-date evidence, while void records never become roster candidates',async f=>{
  const impossible=await f.add({...f.input,joinsOn:'2014-03-19',leavesOn:'2014-03-19'});assert.equal(impossible.response.status,409);assert.equal(impossible.body.error.code,'JOINS_BEFORE_BIRTH');
  const voided=await f.add({...f.input,joinsOn:'2014-03-19',leavesOn:'2014-03-19',enabled:false});assert.equal(voided.response.status,201);
  assert.equal((await f.request('enrollments/'+voided.body.data.id+'/change',{expectedVersion:1,enabled:true,reason:'Invalid reactivation'})).response.status,409);
  assert.equal((await f.request('classes/'+f.first.id+'/roster?on=2014-03-19')).body.data.length,0);
});
check('roster default day is class-local, pagination preserves date filtering and requests cannot manufacture signed admission',async f=>{
  const before=Temporal.Now.plainDateISO('America/Toronto').toString(),defaulted=await f.request('classes/'+f.first.id+'/roster'),after=Temporal.Now.plainDateISO('America/Toronto').toString();assert.ok(defaulted.body.on>=before&&defaulted.body.on<=after);
  assert.equal((await f.add()).response.status,201);assert.equal((await f.add({...f.input,studentId:f.two})).response.status,201);
  const first=await f.request('classes/'+f.first.id+'/roster?on=2027-01-01&limit=1');assert.ok(first.body.nextCursor);const next=await f.request('classes/'+f.first.id+'/roster?on=2027-01-01&after='+first.body.nextCursor);assert.equal(next.body.data.length,1);assert.notEqual(next.body.data[0].student_id,first.body.data[0].student_id);
  for(const patch of [{agreementSigned:true},{admitted:true},{eligible:true},{joinsOn:'2027-02-30'},{studentProfileVersion:2147483648},{classId:f.other.id}])assert.equal((await f.add({...f.input,...patch})).response.status,400,JSON.stringify(patch));
  assert.equal(first.body.data[0].eligible,undefined,'this administrative roster is not an admission clearance claim');
  assert.equal((await f.request('classes/'+f.first.id+'/roster?on=2027-01-01&limit=101')).response.status,400);
});
check('enrollment writes are durable on retry, atomic on outbox failure, and raw storage protects identities and cross-school references',async f=>{
  const key=randomUUID(),one=await f.add(f.input,f.first.id,'master',key),two=await f.add(f.input,f.first.id,'master',key);assert.equal(one.response.status,201);assert.deepEqual(two.body,one.body);const id=one.body.data.id;
  await f.pg.exec('REVOKE INSERT ON public.outbox_events FROM kavosh_runtime');
  try{assert.equal((await f.add({...f.input,studentId:f.two})).response.status,503);}finally{await f.pg.exec('GRANT INSERT ON public.outbox_events TO kavosh_runtime');}
  assert.equal((await f.pg.query('SELECT * FROM public.class_enrollments')).rows.length,1);assert.equal((await f.pg.query('SELECT * FROM public.class_enrollment_revisions')).rows.length,1);
  await assert.rejects(f.pg.query('UPDATE public.class_enrollments SET hub_id=$2 WHERE id=$1',[id,f.foreignHub]),/foreign key/i);
  await f.pg.exec('SET ROLE kavosh_runtime');
  try{await f.pg.query("SELECT set_config('app.academy_id',$1,false)",[f.b]);assert.equal((await f.pg.query('SELECT * FROM public.class_enrollments')).rows.length,0);assert.equal((await f.pg.query('SELECT * FROM public.class_enrollment_revisions')).rows.length,0);
    await f.pg.query("SELECT set_config('app.academy_id',$1,false)",[f.a]);await assert.rejects(f.pg.query('UPDATE public.class_enrollments SET student_id=$2 WHERE id=$1',[id,f.two]),/permission denied/i);await assert.rejects(f.pg.query("UPDATE public.class_enrollment_revisions SET definition='{}' WHERE enrollment_id=$1",[id]),/permission denied/i);
  }finally{await f.pg.exec('RESET ROLE');}
  const events=(await f.request('audit-events')).body.data.filter((e:{action:string})=>e.action.startsWith('class.enrollment.'));const text=JSON.stringify(events);assert.ok(!text.includes(f.input.reason));assert.ok(!text.includes(f.one));assert.ok(!text.includes('Private legal'));
});
if(process.env.TEST_DATABASE_URL)check('concurrent enrollment creates and corrections cannot overlap or lose history',async f=>{
  const added=await Promise.all([f.add(),f.add()]);assert.deepEqual(added.map(r=>r.response.status).sort(),[201,409]);const id=added.find(r=>r.response.status===201)!.body.data.id;
  const changed=await Promise.all(['2027-01-30','2027-01-29'].map(leavesOn=>f.request('enrollments/'+id+'/change',{expectedVersion:1,leavesOn,reason:'Concurrent correction'})));assert.deepEqual(changed.map(r=>r.response.status).sort(),[200,409]);assert.equal((await f.pg.query('SELECT * FROM public.class_enrollment_revisions')).rows.length,2);
});
