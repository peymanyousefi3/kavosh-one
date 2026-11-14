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
 const course=await f.request('courses',{code:'ATT',name:'Attendance test'});assert.equal(course.response.status,201);
 const c=await f.request('classes',{hubId:f.hub,courseId:course.body.data.id,courseVersion:1,name:'Shared attendance',mode:'in_person',schedule:{oneOff:[{start:'2026-01-02T23:30',end:'2026-01-03T00:30'}]}});assert.equal(c.response.status,201);
 const session=(await f.request('classes/'+c.body.data.id+'/sessions')).body.data[0];
 const a=await f.request('classes/'+c.body.data.id+'/staff',{personId:f.actors.staff.person,role:'teacher',startsOn:'2026-01-02',endsOn:'2026-01-02',reason:'Synthetic accepted assignment'});assert.equal(a.response.status,201);
 const enrollments=[] as {id:string;student_id:string}[];
 for(const [who,joinsOn] of [['peer','2026-01-02'],['manager','2026-01-03']] as const){
  const studentId=f.actors[who].person;
  assert.equal((await f.request('students',{personId:studentId,legalName:'PRIVATE student '+who,dateOfBirth:'2014-03-20',recruiter:{kind:'academy'}})).response.status,201);
  const e=await f.request('classes/'+c.body.data.id+'/enrollments',{studentId,studentProfileVersion:1,joinsOn,reason:'PRIVATE dated membership'});assert.equal(e.response.status,201);enrollments.push(e.body.data);
 }
 for(const role of [f.staffRole,f.managerRole])for(const cap of ['attendance.view','attendance.record','attendance.edit','rosters.view'])await f.pg.query("INSERT INTO public.role_permissions VALUES($1,$2,$3,'allow')",[f.a,role,cap]);
 const path='sessions/'+session.id+'/attendance',input={expectedVersion:0,sessionVersion:1,assignmentId:a.body.data.id,assignmentVersion:1,entries:[{enrollmentId:enrollments[0].id,enrollmentVersion:1,status:'present',note:'PRIVATE observed doing robotics'}],reason:'PRIVATE shared session register'};
 const save=(value:unknown=input,as='staff',key?:string)=>f.request(path,value,as,key?{key}:{});
 const correction=(value:unknown,as='manager',key?:string)=>f.request(path+'/change',value,as,key?{key}:{});
 const {assignmentId,assignmentVersion,...change}=input;
 return {...f,c:c.body.data,session,assignment:a.body.data,enrollments,path,input,save,correction,change};
}
type Fixture=Awaited<ReturnType<typeof fixture>>;
function check(name:string,run:(f:Fixture)=>Promise<void>,nativeOnly=false){test(name,{skip:nativeOnly&&!process.env.TEST_DATABASE_URL},async()=>{const f=await fixture();try{await run(f);}finally{await f.pg.close();}});}

check('assigned teacher saves one shared observed list with immutable history but unverified students remain operationally absent',async f=>{
 await f.pg.query("SELECT set_config('app.academy_id',$1,false)",[f.a]);await f.pg.query('SELECT public.session_attendance_source($1)',[f.session.id]);
 const before=await f.request(f.path,undefined,'staff');assert.equal(before.response.status,200);assert.equal(before.body.data,null);assert.equal(before.body.currentSource.on,'2026-01-02');assert.equal(before.body.roster.length,1);assert.equal(before.body.roster[0].studentId,f.actors.peer.person);
 const key=randomUUID(),start=performance.now(),queries=f.metrics.businessQueries,made=await f.save(f.input,'staff',key);assert.equal(made.response.status,201,JSON.stringify(made.body));console.log(JSON.stringify({case:'shared-attendance-save',elapsedMs:Math.round(performance.now()-start),clientQueries:f.metrics.businessQueries-queries}));
 assert.equal(made.body.data.version,1);assert.equal(made.body.data.observedCounts.present,1);assert.equal(made.body.data.entries[0].observedStatus,'present');assert.equal(made.body.data.entries[0].effectiveAttendance,'absent');assert.equal(made.body.data.admissionClearanceVerified,false);assert.equal(made.body.data.payrollApproved,false);
 assert.deepEqual((await f.save(f.input,'staff',key)).body,made.body);assert.equal((await f.save()).response.status,409);
 assert.equal((await f.save({...f.input,expectedVersion:1,entries:[{...f.input.entries[0],status:'late'}]})).response.status,200);
 const h=await f.request(f.path+'/history?limit=1',undefined,'staff');assert.equal(h.body.nextVersion,1);assert.equal(h.body.data[0].definition.entries[0].observedStatus,'present');
 const next=await f.request(f.path+'/history?afterVersion=1',undefined,'staff');assert.equal(next.body.data[0].definition.version,2);
 assert.equal((await f.pg.query('SELECT * FROM public.session_attendance')).rows.length,1);assert.equal((await f.pg.query('SELECT * FROM public.finance_journals')).rows.length,0);
 const audit=(await f.pg.query("SELECT changes FROM public.audit_events WHERE action='session.attendance.recorded'")).rows;assert.doesNotMatch(JSON.stringify(audit),/PRIVATE|present|robotics/);
});
check('date-filtered full roster rejects pre-join, missing, duplicate, foreign and stale membership without partial attendance',async f=>{
 for(const entries of [[],[...f.input.entries,{...f.input.entries[0],enrollmentId:f.enrollments[1].id}],[...f.input.entries,...f.input.entries],[{...f.input.entries[0],enrollmentVersion:2}],[{...f.input.entries[0],enrollmentId:randomUUID()}]])assert.ok([400,409].includes((await f.save({...f.input,entries})).response.status));
 assert.equal((await f.pg.query('SELECT * FROM public.session_attendance')).rows.length,0);
 const changed=await f.request('enrollments/'+f.enrollments[1].id+'/change',{expectedVersion:1,joinsOn:'2026-01-02',reason:'PRIVATE joined on local start day'});assert.equal(changed.response.status,200);
 assert.equal((await f.save()).body.error.code,'ATTENDANCE_ROSTER_CHANGED');
 const both=await f.save({...f.input,entries:[...f.input.entries,{enrollmentId:f.enrollments[1].id,enrollmentVersion:2,status:'absent',note:''}]});assert.equal(both.response.status,201,JSON.stringify(both.body));assert.equal(both.body.data.entries.length,2);
});
check('one list serves all assigned staff; inactive, unassigned and bot actors cannot impersonate a teacher',async f=>{
 assert.equal((await f.save(f.input,'manager')).body.error.code,'STAFF_ASSIGNMENT_CHANGED');assert.equal((await f.save(f.input,'bot')).response.status,403);
 const made=await f.save();assert.equal(made.response.status,201);
 const a=await f.request('classes/'+f.c.id+'/staff',{personId:f.actors.manager.person,role:'ta',startsOn:'2026-01-02',endsOn:'2026-01-02',reason:'Second assigned teacher shares the attendance list'});assert.equal(a.response.status,201);
 const shared=await f.save({...f.input,expectedVersion:1,assignmentId:a.body.data.id},'manager');assert.equal(shared.response.status,200);assert.equal(shared.body.data.version,2);
 assert.equal((await f.pg.query('SELECT * FROM public.session_attendance')).rows.length,1);
 await f.pg.query('UPDATE public.class_staff SET active=false WHERE id=$1',[a.body.data.id]);assert.equal((await f.save({...f.input,expectedVersion:2,assignmentId:a.body.data.id},'manager')).body.error.code,'STAFF_ASSIGNMENT_CHANGED');
});
check('administrative initial entry and corrections need upper human review, retain private source bindings and never approve payroll',async f=>{
 const initial=await f.correction(f.change);assert.equal(initial.response.status,202,JSON.stringify(initial.body));assert.equal((await f.approve(initial.body.approval.id,'manager')).response.status,403);
 const applied=await f.approve(initial.body.approval.id);assert.equal(applied.response.status,200,JSON.stringify(applied.body));assert.equal(applied.body.data.version,1);assert.equal(applied.body.data.payrollApproved,false);
 const change=await f.correction({...f.change,expectedVersion:1,entries:[{...f.change.entries[0],status:'excused'}]},'bot');assert.equal(change.response.status,202);assert.equal((await f.approve(change.body.approval.id,'bot')).response.status,403);assert.equal((await f.approve(change.body.approval.id)).response.status,200);
 const notices=(await f.pg.query("SELECT n.id FROM public.portal_notifications n JOIN public.automation_event_sources s ON s.academy_id=n.academy_id AND s.event_id=n.event_id WHERE s.approval_id=$1 AND n.origin='mandatory'",[change.body.approval.id])).rows;assert.ok(notices.length>0);
 assert.equal((await f.request(f.path+'/history',undefined,'staff')).body.data.length,2);
});
check('a teacher or roster change invalidates pending corrections without erasing the submitted sheet',async f=>{
 await f.save();const pending=await f.correction({...f.change,expectedVersion:1});assert.equal(pending.response.status,202);
 assert.equal((await f.save({...f.input,expectedVersion:1})).response.status,200);
 const stale=await f.approve(pending.body.approval.id);assert.equal(stale.response.status,409);assert.equal(stale.body.approval.status,'stale');
 const next=await f.correction({...f.change,expectedVersion:2});assert.equal(next.response.status,202);
 await f.request('enrollments/'+f.enrollments[0].id+'/change',{expectedVersion:1,joinsOn:'2026-01-03',reason:'PRIVATE corrected join date'});
 assert.equal((await f.approve(next.body.approval.id)).body.approval.status,'stale');const old=await f.request(f.path,undefined,'staff');assert.equal(old.body.data.version,2);assert.equal(old.body.recordedSourceCurrent,false);assert.equal(old.body.roster.length,0);
});
check('cancelled or rescheduled sessions retain evidence; only upper-reviewed correction can edit cancelled history',async f=>{
 await f.save();assert.equal((await f.request('sessions/'+f.session.id+'/change',{expectedVersion:1,reason:'Historical calendar correction',change:{kind:'cancel'}})).response.status,200);
 const old=await f.request(f.path,undefined,'staff');assert.equal(old.body.data.version,1);assert.equal(old.body.currentSessionStatus,'cancelled');assert.equal(old.body.recordedSourceCurrent,false);
 assert.equal((await f.save({...f.input,expectedVersion:1,sessionVersion:2})).body.error.code,'INACTIVE_SESSION_ATTENDANCE_REQUIRES_REVIEW');
 const corrected=await f.correction({...f.change,expectedVersion:1,sessionVersion:2},'master');assert.equal(corrected.response.status,200,JSON.stringify(corrected.body));assert.equal(corrected.body.data.version,2);assert.equal(corrected.body.data.entries[0].effectiveAttendance,'absent');
});
check('current attendance and roster rights protect private history and approval cases, including replay after revocation and school isolation',async f=>{
 const key=randomUUID();await f.save(f.input,'staff',key);const pending=await f.correction({...f.change,expectedVersion:1});assert.equal(pending.response.status,202);
 for(const cap of ['attendance.view','rosters.view']){
  await f.pg.query('DELETE FROM public.role_permissions WHERE role_id=$1 AND capability=$2',[f.staffRole,cap]);
  for(const path of [f.path,f.path+'/history'])assert.ok([403,404].includes((await f.request(path,undefined,'staff')).response.status));assert.ok([403,404].includes((await f.save(f.input,'staff',key)).response.status));
  await f.pg.query("INSERT INTO public.role_permissions VALUES($1,$2,$3,'allow')",[f.a,f.staffRole,cap]);
  await f.pg.query('DELETE FROM public.role_permissions WHERE role_id=$1 AND capability=$2',[f.managerRole,cap]);assert.equal((await f.request('approvals/'+pending.body.approval.id,undefined,'manager')).response.status,404);await f.pg.query("INSERT INTO public.role_permissions VALUES($1,$2,$3,'allow')",[f.a,f.managerRole,cap]);
 }
 assert.equal((await f.request(f.path,undefined,'foreignMaster',{academy:f.b})).response.status,404);
});
check('strict inputs cannot set admission, payroll or actor identity and a broken event rolls back attendance, revision and idempotency receipt',async f=>{
 for(const patch of [{payrollApproved:true},{signed:true},{changedBy:f.actors.master.person},{sessionVersion:99},{reason:'\0'},{entries:[{...f.input.entries[0],status:'signed'}]}])assert.ok([400,409].includes((await f.save({...f.input,...patch})).response.status));
 assert.equal((await f.request(f.path+'?studentId='+f.actors.peer.person,f.input,'staff')).response.status,400);
 const key=randomUUID(),counts=async()=>(await f.pg.query('SELECT(SELECT count(*)::int FROM public.audit_events) audits,(SELECT count(*)::int FROM public.outbox_events) events,(SELECT count(*)::int FROM public.request_keys) keys')).rows[0],before=await counts();
 await f.pg.exec('REVOKE INSERT ON public.outbox_events FROM kavosh_runtime');try{assert.equal((await f.save(f.input,'staff',key)).response.status,503);}finally{await f.pg.exec('GRANT INSERT ON public.outbox_events TO kavosh_runtime');}
 assert.equal((await f.pg.query('SELECT * FROM public.session_attendance_revisions')).rows.length,0);assert.equal((await f.pg.query('SELECT * FROM public.session_attendance')).rows.length,0);assert.deepEqual(await counts(),before);assert.equal((await f.save(f.input,'staff',key)).response.status,201);
});
check('native append-only history, version identity, tenant boundary and deferred exact revision are enforced independently of the API',async f=>{
 await f.save();await f.pg.exec('SET ROLE kavosh_runtime');try{
  await f.pg.query("SELECT set_config('app.academy_id',$1,false)",[f.a]);
  for(const sql of ['DELETE FROM public.session_attendance','DELETE FROM public.session_attendance_revisions',"UPDATE public.session_attendance_revisions SET definition='{}'",'UPDATE public.session_attendance SET created_at=now()','UPDATE public.session_attendance SET version=version+2'])await assert.rejects(f.pg.exec(sql));
  await f.pg.query("SELECT set_config('app.academy_id',$1,false)",[f.b]);assert.equal((await f.pg.query('SELECT * FROM public.session_attendance')).rows.length,0);assert.equal((await f.pg.query('SELECT * FROM public.session_attendance_revisions')).rows.length,0);
 }finally{await f.pg.exec('RESET ROLE');}
 await f.pg.exec('BEGIN');await f.pg.exec('SET LOCAL ROLE kavosh_runtime');await f.pg.query("SELECT set_config('app.academy_id',$1,true)",[f.a]);await f.pg.query('UPDATE public.session_attendance SET version=version+1 WHERE session_id=$1',[f.session.id]);await assert.rejects(f.pg.exec('COMMIT'),/ATTENDANCE_REVISION_MISSING/);await f.pg.exec('ROLLBACK');
 assert.equal((await f.request(f.path,undefined,'staff')).body.data.version,1);
});
check('two simultaneous submissions produce one complete sheet and one clear version conflict',async f=>{
 const start=performance.now(),race=await Promise.all([f.save(),f.save({...f.input,reason:'PRIVATE competing attendance'})]);assert.deepEqual(race.map(r=>r.response.status).sort(),[201,409]);assert.equal((await f.pg.query('SELECT * FROM public.session_attendance_revisions')).rows.length,1);console.log(JSON.stringify({case:'two-attendance-submissions',elapsedMs:Math.round(performance.now()-start),winners:1}));
},true);
check('local-day evidence is independent of a later hub-zone change and malformed or future session facts cannot be recorded',async f=>{
 await f.pg.query("UPDATE public.hubs SET time_zone='Pacific/Kiritimati' WHERE id=$1",[f.hub]);assert.equal((await f.request(f.path,undefined,'staff')).body.currentSource.on,'2026-01-02');assert.equal((await f.save()).response.status,201);
 await f.pg.query("UPDATE public.class_sessions SET time_info=time_info-'localStart' WHERE id=$1",[f.session.id]);assert.equal((await f.save({...f.input,expectedVersion:1})).body.error.code,'SESSION_TIME_EVIDENCE_INVALID');
 const made=await f.request('classes',{hubId:f.hub,courseId:f.c.course_id,courseVersion:1,name:'Future attendance',mode:'in_person',schedule:{oneOff:[{start:'2099-01-01T10:00',end:'2099-01-01T11:00'}]}});assert.equal(made.response.status,201);
 const future=(await f.request('classes/'+made.body.data.id+'/sessions')).body.data[0];const denied=await f.request('sessions/'+future.id+'/attendance/change',{...f.change,entries:[]},'master');assert.equal(denied.body.error.code,'FUTURE_ATTENDANCE_FORBIDDEN');
});
check('class-selected attendance grants work and explicit class denial overrides a broad grant',async f=>{
 const permissions=['attendance.view','attendance.record','rosters.view'].map(capability=>({capability,effect:'allow'})),role=await f.request('roles',{name:'One class attendance',permissions});assert.equal(role.response.status,201);
 const target='people/'+f.actors.staff.person+'/access',v=(await f.request(target)).body.data.version;
 assert.equal((await f.request(target,{expectedVersion:v,assignments:[{roleId:role.body.data.id,allHubs:false,classIds:[f.c.id]}]})).response.status,200);assert.equal((await f.save()).response.status,201);
 const deny=await f.request('roles',{name:'Attendance class blocked',permissions:[{capability:'attendance.view',effect:'deny'}]});assert.equal(deny.response.status,201);
 const current=(await f.request(target)).body.data.version;assert.equal((await f.request(target,{expectedVersion:current,assignments:[{roleId:role.body.data.id,allHubs:true},{roleId:deny.body.data.id,allHubs:false,classIds:[f.c.id]}]})).response.status,200);
 assert.equal((await f.request(f.path,undefined,'staff')).response.status,404);
});
check('native guard catches an actual enrollment change during INSERT and rolls back all effects before the same-key retry',async f=>{
 const counts=async()=>(await f.pg.query('SELECT(SELECT count(*)::int FROM public.audit_events) audits,(SELECT count(*)::int FROM public.outbox_events) events,(SELECT count(*)::int FROM public.request_keys) keys')).rows[0],before=await counts(),key=randomUUID();
 // Only a disposable fixture-owner trigger; production grants are unchanged.
 await f.pg.exec(`CREATE FUNCTION public.synthetic_attendance_roster_change() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN UPDATE public.class_enrollments SET joins_on='2026-01-03',version=version+1 WHERE id='${f.enrollments[0].id}';RETURN NEW;END $$;CREATE TRIGGER aa_synthetic_roster_change BEFORE INSERT ON public.session_attendance FOR EACH ROW EXECUTE FUNCTION public.synthetic_attendance_roster_change()`);
 try{const blocked=await f.save(f.input,'staff',key);assert.equal(blocked.response.status,409,JSON.stringify(blocked.body));assert.equal(blocked.body.error.code,'ATTENDANCE_SOURCE_CHANGED');}
 finally{await f.pg.exec('DROP TRIGGER aa_synthetic_roster_change ON public.session_attendance;DROP FUNCTION public.synthetic_attendance_roster_change()');}
 assert.equal((await f.pg.query('SELECT version FROM public.class_enrollments WHERE id=$1',[f.enrollments[0].id])).rows[0].version,1);assert.equal((await f.pg.query('SELECT * FROM public.session_attendance')).rows.length,0);assert.deepEqual(await counts(),before);assert.equal((await f.save(f.input,'staff',key)).response.status,201);
},true);
check('native exact correction cannot commit a pending approval even with its matching saved revision',async f=>{
 assert.equal((await f.save()).response.status,201);const change={...f.change,expectedVersion:1,entries:[{...f.change.entries[0],status:'late'}]},pending=await f.correction(change);assert.equal(pending.response.status,202);
 await f.pg.exec('BEGIN');await f.pg.exec('SET LOCAL ROLE kavosh_runtime');await f.pg.query("SELECT set_config('app.academy_id',$1,true)",[f.a]);
 await f.pg.query('UPDATE public.session_attendance SET entries=$2::jsonb,version=version+1,changed_by=$3,assignment_id=NULL,assignment_version=NULL,approval_id=$4,reason=$5 WHERE session_id=$1',[f.session.id,JSON.stringify(change.entries),f.actors.master.person,pending.body.approval.id,change.reason]);
 await f.pg.query('INSERT INTO public.session_attendance_revisions(academy_id,session_id,version,definition) SELECT academy_id,session_id,version,to_jsonb(a) FROM public.session_attendance a WHERE session_id=$1',[f.session.id]);
 await assert.rejects(f.pg.exec('COMMIT'),/ATTENDANCE_REVIEW_NOT_APPLIED/);await f.pg.exec('ROLLBACK');assert.equal((await f.request(f.path,undefined,'staff')).body.data.version,1);assert.equal((await f.approve(pending.body.approval.id)).response.status,200);
},true);
check('a complete declared roster limit saves once; an oversized actual roster fails explicitly without truncation',async f=>{
 // Synthetic fixture-owner bulk setup, not imported production identities or
 // an assertion that these fake records have external enrollment evidence.
 const rows=Array.from({length:1000},()=>({person:randomUUID(),enrollment:randomUUID()}));
 const add=async(items:typeof rows)=>{
  const json=JSON.stringify(items);
  await f.pg.query("INSERT INTO public.people(academy_id,id,kind,name,hub_id) SELECT $1,(x->>'person')::uuid,'human','Synthetic boundary student',$2 FROM jsonb_array_elements($3::jsonb) x",[f.a,f.hub,json]);
  await f.pg.query("INSERT INTO public.student_profiles(academy_id,person_id,legal_name,date_of_birth,recruiter_kind) SELECT $1,(x->>'person')::uuid,'Synthetic boundary student','2014-01-01','academy' FROM jsonb_array_elements($2::jsonb) x",[f.a,json]);
  await f.pg.query("INSERT INTO public.student_profile_revisions(academy_id,person_id,version,definition,changed_by,reason) SELECT p.academy_id,p.person_id,p.version,to_jsonb(p),$3,'Synthetic boundary fixture' FROM public.student_profiles p WHERE p.academy_id=$1 AND p.person_id IN(SELECT(x->>'person')::uuid FROM jsonb_array_elements($2::jsonb) x)",[f.a,json,f.actors.master.person]);
  await f.pg.query("INSERT INTO public.class_enrollments(academy_id,id,class_id,hub_id,student_id,student_profile_version,joins_on,last_approval_id) SELECT $1,(x->>'enrollment')::uuid,$2,$3,(x->>'person')::uuid,1,'2026-01-02',e.last_approval_id FROM jsonb_array_elements($4::jsonb) x CROSS JOIN public.class_enrollments e WHERE e.id=$5",[f.a,f.c.id,f.hub,json,f.enrollments[0].id]);
 };
 await add(rows.slice(0,999));const entries=[...f.input.entries,...rows.slice(0,999).map(r=>({enrollmentId:r.enrollment,enrollmentVersion:1,status:'absent',note:''}))];
 const start=performance.now(),saved=await f.save({...f.input,entries});assert.equal(saved.response.status,201,JSON.stringify(saved.body));assert.equal(saved.body.data.entries.length,1000);const elapsedMs=Math.round(performance.now()-start);
 // A few large retained revisions exercise byte-budget pagination, not a
 // prolonged load run. Every revision must remain reachable without gaps.
 const rich=entries.map(e=>({...e,note:'界'.repeat(80)}));
 for(let v=1;v<5;v++)assert.equal((await f.save({...f.input,expectedVersion:v,entries:rich})).response.status,200);
 const firstPage=await f.request(f.path+'/history?limit=20',undefined,'staff');assert.equal(firstPage.response.status,200);assert.ok(firstPage.body.data.length<5);assert.ok(firstPage.body.nextVersion);assert.ok(Buffer.byteLength(JSON.stringify(firstPage.body),'utf8')<4000000);
 const versions=firstPage.body.data.map((r:{version:number})=>r.version);let after=firstPage.body.nextVersion;
 while(after!==null){const page=await f.request(f.path+'/history?limit=20&afterVersion='+after,undefined,'staff');assert.equal(page.response.status,200);versions.push(...page.body.data.map((r:{version:number})=>r.version));after=page.body.nextVersion;}
 assert.deepEqual(versions,[1,2,3,4,5]);
 await add(rows.slice(999));const blocked=await f.request(f.path,undefined,'staff');assert.equal(blocked.response.status,409);assert.equal(blocked.body.error.code,'ATTENDANCE_REQUIRES_BACKGROUND_JOB');
 assert.equal((await f.pg.query('SELECT jsonb_array_length(entries) count,version FROM public.session_attendance')).rows[0].count,1000);assert.equal((await f.pg.query('SELECT * FROM public.session_attendance_revisions')).rows.length,5);
 console.log(JSON.stringify({case:'declared-attendance-boundary',savedMembers:1000,oversizedMembers:1001,saveElapsedMs:elapsedMs,partialSuccess:false}));
},true);
