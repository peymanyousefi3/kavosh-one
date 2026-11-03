import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { operationsFixture } from './operations-fixture.ts';

async function fixture() {
  const f=await operationsFixture(),country=randomUUID(),region=randomUUID(),city=randomUUID();
  await f.pg.query("INSERT INTO public.countries(academy_id,id,code,name) VALUES($1,$2,'CA','Canada')",[f.a,country]);
  await f.pg.query("INSERT INTO public.regions(academy_id,id,country_id,code,name) VALUES($1,$2,$3,'ON','Ontario')",[f.a,region,country]);
  await f.pg.query("INSERT INTO public.cities(academy_id,id,region_id,name) VALUES($1,$2,$3,'Toronto')",[f.a,city,region]);
  await f.pg.query("UPDATE public.hubs SET city_id=$1,time_zone='America/Toronto',currency='CAD' WHERE academy_id=$2",[city,f.a]);
  for(const capability of ['classes.view','classes.edit','courses.view','sessions.request'])await f.pg.query("INSERT INTO public.role_permissions VALUES($1,$2,$3,'allow')",[f.a,f.managerRole,capability]);
  const course=await f.request('courses',{code:'ROB-101',name:'Robotics',modules:[{code:'M01',title:'Sensors'}]});assert.equal(course.response.status,201);
  const schedule={weekly:{from:'2027-03-07',through:'2027-03-21',weekdays:[7],startTime:'10:00',endTime:'11:00'},exclude:[{date:'2027-03-14',reason:'Holiday'}]};
  const input={hubId:f.hub,courseId:course.body.data.id,courseVersion:1,name:'Sunday robotics',mode:'in_person',schedule};
  async function create(overrides:Record<string,unknown>={}) {const result=await f.request('classes',{...input,...overrides});assert.equal(result.response.status,201,JSON.stringify(result.body));return result.body.data;}
  return {...f,course:course.body.data,input,create};
}
type Fixture=Awaited<ReturnType<typeof fixture>>;
function check(name:string,run:(f:Fixture)=>Promise<void>){test(name,async()=>{const f=await fixture();try{await run(f);}finally{await f.pg.close();}});}
const one=(day:string,start='10:00',end='11:00')=>({oneOff:[{start:day+'T'+start,end:day+'T'+end}]});

check('class creation atomically persists pinned curriculum, generated code, holiday evidence and DST-safe sessions',async f=>{
  const c=await f.create();assert.ok(c.code.startsWith('ROB-101-'+f.hub.slice(0,8).toUpperCase()+'-202703071000-'));assert.equal(c.time_zone,'America/Toronto');
  const result=await f.request('classes/'+c.id);assert.equal(result.response.status,200);assert.equal(result.body.curriculum.definition.modules[0].title,'Sensors');
  const sessions=await f.request('classes/'+c.id+'/sessions');assert.equal(sessions.body.data.length,2);
  assert.deepEqual(sessions.body.data.map((s:{starts_at:string})=>s.starts_at),['2027-03-07T15:00:00.000Z','2027-03-21T14:00:00.000Z']);
  const schedules=await f.request('classes/'+c.id+'/schedules');assert.equal(schedules.body.data.length,1);assert.equal(schedules.body.data[0].compiled.excluded[0].reason,'Holiday');
  assert.equal((await f.pg.query("SELECT * FROM public.audit_events WHERE action IN ('class.created','class.schedule.created')")).rows.length,2);
  const changed=await f.request('courses/'+f.course.id+'/update',{expectedVersion:1,modules:[{code:'M01',title:'New curriculum'}]});assert.equal(changed.response.status,200);
  assert.equal((await f.request('classes/'+c.id)).body.curriculum.definition.modules[0].title,'Sensors');
});
check('class creation requires explicit hub setup, current active course and compatible hub assignment',async f=>{
  await f.pg.query('UPDATE public.hubs SET time_zone=NULL WHERE id=$1',[f.hub]);assert.equal((await f.request('classes',f.input)).response.status,409);
  await f.pg.query("UPDATE public.hubs SET time_zone='America/Toronto',active=false WHERE id=$1",[f.hub]);assert.equal((await f.request('classes',f.input)).response.status,400);
  await f.pg.query('UPDATE public.hubs SET active=true WHERE id=$1',[f.hub]);
  assert.equal((await f.request('classes',{...f.input,courseVersion:9})).response.status,409);
  const local=await f.request('courses',{code:'HUB-ONLY',name:'Other hub curriculum',hubId:f.otherHub});
  assert.equal((await f.request('classes',{...f.input,courseId:local.body.data.id})).response.status,400);
  await f.pg.query('UPDATE public.courses SET active=false WHERE id=$1',[f.course.id]);assert.equal((await f.request('classes',f.input)).response.status,400);
});
check('class and curriculum rights are independently enforced and cross-academy references stay blocked',async f=>{
  const own=await f.create(),other=await f.create({hubId:f.otherHub});
  const list=await f.request('classes',undefined,'manager');assert.deepEqual(list.body.data.map((c:{id:string})=>c.id),[own.id]);
  assert.equal((await f.request('classes/'+other.id,undefined,'manager')).response.status,404);
  assert.equal((await f.request('classes/'+other.id+'/sessions',undefined,'manager')).response.status,404);
  assert.equal((await f.request('classes',{...f.input,hubId:f.otherHub},'manager')).response.status,403);
  assert.equal((await f.request('classes',f.input,'staff')).response.status,403);
  assert.equal((await f.request('classes/'+own.id,undefined,'foreignMaster',{academy:f.b})).response.status,404);
  assert.equal((await f.request('classes',{...f.input,hubId:f.foreignHub})).response.status,400);
  await f.pg.query("DELETE FROM public.role_permissions WHERE role_id=$1 AND capability='courses.view'",[f.managerRole]);
  assert.equal((await f.request('classes',f.input,'manager')).response.status,403);
  assert.equal((await f.request('classes/'+own.id,undefined,'manager')).response.status,200,'assigned curriculum remains available through the permitted class');
});
check('metadata patches preserve omitted fields and default delivery changes do not rewrite old sessions',async f=>{
  const c=await f.create(),url='https://meeting.example.test/robotics';
  const changed=await f.request('classes/'+c.id+'/update',{expectedVersion:1,name:'Renamed',mode:'online',onlineUrl:url});assert.equal(changed.response.status,200);assert.equal(changed.body.data.code,c.code);
  assert.equal((await f.request('classes/'+c.id+'/sessions')).body.data[0].mode,'in_person');
  const append=await f.request('classes/'+c.id+'/schedules',{expectedVersion:2,schedule:one('2027-04-01')});assert.equal(append.response.status,201);
  const all=await f.request('classes/'+c.id+'/sessions');assert.equal(all.body.data.at(-1).online_url,url);assert.equal(all.body.data.at(-1).mode,'online');
  assert.equal((await f.request('classes/'+c.id+'/update',{expectedVersion:3,mode:'in_person'})).response.status,400);
  assert.equal((await f.request('classes/'+c.id+'/update',{expectedVersion:3,mode:'in_person',onlineUrl:null})).response.status,200);
  assert.equal((await f.request('classes/'+c.id+'/update',{expectedVersion:1,name:'Stale'})).response.status,409);
  assert.equal((await f.request('classes/'+c.id+'/update',{expectedVersion:4})).response.status,400);
});
check('existing class time zone and course snapshot do not change with later hub/course metadata',async f=>{
  const c=await f.create();
  assert.equal((await f.request('hubs/'+f.hub+'/update',{expectedVersion:1,timeZone:'Asia/Shanghai'})).response.status,200);
  const append=await f.request('classes/'+c.id+'/schedules',{expectedVersion:1,schedule:one('2027-04-01')});assert.equal(append.response.status,201);
  const all=await f.request('classes/'+c.id+'/sessions');assert.equal(all.body.data.at(-1).starts_at,'2027-04-01T14:00:00.000Z');
  assert.equal(all.body.data.at(-1).time_info.timeZone,'America/Toronto');
});
check('overlapping appended sessions roll back their entire batch, version and idempotency key',async f=>{
  const c=await f.create(),key=randomUUID();
  const invalid={expectedVersion:1,schedule:{oneOff:[{start:'2027-04-01T10:00',end:'2027-04-01T11:00'},{start:'2027-03-21T10:30',end:'2027-03-21T11:30'}]}};
  assert.equal((await f.request('classes/'+c.id+'/schedules',invalid,'master',{key})).response.status,409);
  assert.equal((await f.request('classes/'+c.id)).body.data.version,1);assert.equal((await f.request('classes/'+c.id+'/sessions')).body.data.length,2);
  assert.equal((await f.request('classes/'+c.id+'/schedules')).body.data.length,1);
  const input={expectedVersion:1,schedule:one('2027-04-01')},valid=await f.request('classes/'+c.id+'/schedules',input,'master',{key});assert.equal(valid.response.status,201);
  assert.deepEqual((await f.request('classes/'+c.id+'/schedules',input,'master',{key})).body,valid.body);
});
check('creation retries are durable and empty or invalid schedules never leave a partial class',async f=>{
  const key=randomUUID(),created=await f.request('classes',f.input,'master',{key});assert.equal(created.response.status,201);
  assert.deepEqual((await f.request('classes',f.input,'master',{key})).body,created.body);
  assert.equal((await f.request('classes',{...f.input,schedule:{weekly:{from:'2027-01-01',through:'2027-01-01',weekdays:[1],startTime:'10:00',endTime:'11:00'}}})).response.status,400);
  assert.equal((await f.request('classes',{...f.input,schedule:one('2027-03-14','02:00','03:30')})).response.status,400);
  assert.equal((await f.pg.query('SELECT * FROM public.classes')).rows.length,1);
});
check('a bounded 500-session irregular batch persists atomically and distinct classes may meet simultaneously',async f=>{
  const oneOff=Array.from({length:500},(_,n)=>{const day=new Date(Date.UTC(2027,0,n+1)).toISOString().slice(0,10);return {start:day+'T10:00',end:day+'T11:00'};});
  const created=await f.request('classes',{...f.input,schedule:{oneOff}});assert.equal(created.response.status,201);assert.equal(created.body.schedule.sessionCount,500);
  assert.equal((await f.pg.query('SELECT count(*)::int AS count FROM public.class_sessions WHERE class_id=$1',[created.body.data.id])).rows[0].count,500);
  const second=await f.create({schedule:one('2027-01-01')});assert.notEqual(second.id,created.body.data.id);assert.notEqual(second.code,created.body.data.code);
  assert.equal((await f.request('classes/'+second.id+'/sessions')).body.data.length,1);
});
check('native constraints and column privileges prevent overlaps, reparenting and immutable schedule rewrites',async f=>{
  const c=await f.create();
  await assert.rejects(f.pg.query(`INSERT INTO public.class_sessions SELECT academy_id,$2,class_id,hub_id,schedule_id,course_id,course_version,starts_at,ends_at,time_info,mode,online_url,status,version,created_at FROM public.class_sessions WHERE class_id=$1 LIMIT 1`,[c.id,randomUUID()]),/exclusion constraint/);
  await f.pg.exec('SET ROLE kavosh_runtime');
  try {
    await f.pg.query("SELECT set_config('app.academy_id',$1,false)",[f.a]);
    await assert.rejects(f.pg.query("UPDATE public.class_schedules SET definition='{}' WHERE class_id=$1",[c.id]),/permission denied/);
    await assert.rejects(f.pg.query('DELETE FROM public.class_sessions WHERE class_id=$1',[c.id]),/permission denied/);
    await assert.rejects(f.pg.query('UPDATE public.class_sessions SET hub_id=$2 WHERE class_id=$1',[c.id,f.otherHub]),/permission denied/);
    await assert.rejects(f.pg.query('UPDATE public.classes SET course_version=2 WHERE id=$1',[c.id]),/permission denied/);
    assert.equal((await f.pg.query('SELECT * FROM public.classes WHERE academy_id=$1',[f.b])).rows.length,0);
  }finally{await f.pg.exec('RESET ROLE');}
});
check('session pagination is chronological with bounded time filters and class-local cursors',async f=>{
  const c=await f.create({schedule:{oneOff:[{start:'2027-01-03T10:00',end:'2027-01-03T11:00'},{start:'2027-01-01T10:00',end:'2027-01-01T11:00'},{start:'2027-01-02T10:00',end:'2027-01-02T11:00'}]}});
  const page=await f.request('classes/'+c.id+'/sessions?limit=2');assert.equal(page.body.data.length,2);assert.ok(page.body.data[0].starts_at<page.body.data[1].starts_at);
  const last=await f.request('classes/'+c.id+'/sessions?limit=2&after='+page.body.nextCursor);assert.equal(last.body.data.length,1);assert.ok(last.body.data[0].starts_at>page.body.data[1].starts_at);
  const filtered=await f.request('classes/'+c.id+'/sessions?from=2027-01-02T15:30:00Z&through=2027-01-03T15:00:00Z');assert.equal(filtered.body.data.length,1);
  assert.equal((await f.request('classes/'+c.id+'/sessions?after='+randomUUID())).response.status,400);
  assert.equal((await f.request('classes/'+c.id+'/sessions?from=2027-01-03T00:00:00Z&through=2027-01-02T00:00:00Z')).response.status,400);
  assert.equal((await f.request('classes/'+c.id+'/sessions?limit=101')).response.status,400);
  assert.equal((await f.request('classes?q='+encodeURIComponent("';DROP TABLE public.classes;--"))).body.data.length,0);
});
check('hub/class archival retains history and prevents new sessions or active-child contradictions',async f=>{
  const c=await f.create();
  assert.equal((await f.request('classes/'+c.id+'/update',{expectedVersion:1,active:false})).response.status,409);
  assert.equal((await f.request('hubs/'+f.hub+'/update',{expectedVersion:1,active:false})).response.status,409);
  await f.pg.query("UPDATE public.class_sessions SET status='cancelled' WHERE class_id=$1",[c.id]);
  assert.equal((await f.request('classes/'+c.id+'/update',{expectedVersion:1,active:false})).response.status,200);
  assert.equal((await f.request('classes/'+c.id+'/schedules',{expectedVersion:2,schedule:one('2027-04-01')})).response.status,409);
  assert.equal((await f.request('hubs/'+f.hub+'/update',{expectedVersion:1,active:false})).response.status,200);
  assert.equal((await f.request('classes/'+c.id+'/update',{expectedVersion:2,active:true})).response.status,400);
  assert.equal((await f.request('classes/'+c.id+'/sessions?status=cancelled')).body.data.length,2);
});
check('delivery-link validation, input bounds and audit failures cannot create partial class data',async f=>{
  for(const extra of [{mode:'online'},{mode:'in_person',onlineUrl:'https://meeting.example.test'},{mode:'online',onlineUrl:'http://meeting.example.test'},{mode:'online',onlineUrl:'https://user:pass@meeting.example.test'},{unexpected:true}])
    assert.equal((await f.request('classes',{...f.input,...extra})).response.status,400);
  await f.pg.exec(`CREATE FUNCTION public.synthetic_class_outage() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Synthetic outage'; END $$;
    CREATE TRIGGER synthetic_class_outage BEFORE INSERT ON public.outbox_events FOR EACH ROW EXECUTE FUNCTION public.synthetic_class_outage()`);
  const key=randomUUID();assert.equal((await f.request('classes',f.input,'master',{key})).response.status,503);
  for(const table of ['classes','class_sessions','class_schedules'])assert.equal((await f.pg.query('SELECT * FROM public.'+table)).rows.length,0);
  await f.pg.exec('DROP TRIGGER synthetic_class_outage ON public.outbox_events; DROP FUNCTION public.synthetic_class_outage()');
  assert.equal((await f.request('classes',f.input,'master',{key})).response.status,201);
});

check('session requests wait for upper review, reject self-approval and apply exact cancellation/restoration',async f=>{
  const c=await f.create(),s=(await f.request('classes/'+c.id+'/sessions')).body.data[0];
  const request=await f.request('sessions/'+s.id+'/change',{expectedVersion:1,reason:'Teacher unavailable',change:{kind:'cancel'}},'manager');assert.equal(request.response.status,202);
  assert.equal((await f.request('sessions/'+s.id)).body.data.status,'scheduled');
  assert.equal((await f.approve(request.body.approval.id,'manager')).response.status,403);
  const approved=await f.approve(request.body.approval.id);assert.equal(approved.response.status,200);assert.equal(approved.body.data.status,'cancelled');assert.equal(approved.body.data.version,2);
  const restore=await f.request('sessions/'+s.id+'/change',{expectedVersion:2,reason:'Replacement teacher arranged',change:{kind:'restore'}});assert.equal(restore.response.status,200);assert.equal(restore.body.data.status,'scheduled');
  assert.equal((await f.request('classes/'+c.id+'/sessions')).body.data.length,2,'cancelled/restored session keeps its identity');
});
check('approved rescheduling uses frozen class time zone and stale/conflicting changes retain review history',async f=>{
  const c=await f.create(),s=(await f.request('classes/'+c.id+'/sessions')).body.data[0];
  const p=await f.request('sessions/'+s.id+'/change',{expectedVersion:1,reason:'Family schedule change',change:{kind:'reschedule',start:'2027-03-22T09:00',end:'2027-03-22T10:00'}},'manager');assert.equal(p.response.status,202);
  const applied=await f.approve(p.body.approval.id);assert.equal(applied.response.status,200);assert.equal(applied.body.data.starts_at,'2027-03-22T13:00:00.000Z');
  const pending=await f.request('sessions/'+s.id+'/change',{expectedVersion:2,reason:'New online arrangement',change:{kind:'delivery',mode:'online',onlineUrl:'https://meeting.example.test/class'}},'manager');assert.equal(pending.response.status,202);
  assert.equal((await f.request('sessions/'+s.id+'/change',{expectedVersion:2,reason:'Master cancellation',change:{kind:'cancel'}})).response.status,200);
  const stale=await f.approve(pending.body.approval.id);assert.equal(stale.response.status,409);assert.equal(stale.body.approval.status,'stale');
  assert.equal((await f.request('sessions/'+s.id)).body.data.status,'cancelled');
});
check('conflicting approved reschedule rolls back and closes as stale without losing either session',async f=>{
  const c=await f.create(),s=(await f.request('classes/'+c.id+'/sessions')).body.data[0];
  const pending=await f.request('sessions/'+s.id+'/change',{expectedVersion:1,reason:'Move lesson',change:{kind:'reschedule',start:'2027-03-21T10:30',end:'2027-03-21T11:30'}},'manager');assert.equal(pending.response.status,202);
  const result=await f.approve(pending.body.approval.id);assert.equal(result.response.status,409);assert.equal(result.body.approval.status,'stale');assert.equal(result.body.approval.decisionCode,'SESSION_OVERLAP');
  const original=await f.request('sessions/'+s.id);assert.equal(original.body.data.version,1);assert.equal(original.body.data.starts_at,s.starts_at);
  assert.equal((await f.request('classes/'+c.id+'/sessions')).body.data.length,2);
});
check('session requests enforce separate scope, revocation, DST validation, delivery safety and durable master retries',async f=>{
  const c=await f.create(),s=(await f.request('classes/'+c.id+'/sessions')).body.data[0];
  assert.equal((await f.request('sessions/'+s.id+'/change',{expectedVersion:1,reason:'Not allowed',change:{kind:'cancel'}},'staff')).response.status,403);
  assert.equal((await f.request('sessions/'+s.id,undefined,'peer')).response.status,404);
  assert.equal((await f.request('sessions/'+s.id+'/change',{expectedVersion:1,reason:'Wrong hub',change:{kind:'cancel'}},'peer')).response.status,404);
  assert.equal((await f.request('sessions/'+s.id+'/change',{expectedVersion:1,reason:'Missing local hour',change:{kind:'reschedule',start:'2027-03-14T02:00',end:'2027-03-14T04:00'}},'manager')).response.status,400);
  assert.equal((await f.request('sessions/'+s.id+'/change',{expectedVersion:1,reason:'Unsafe link',change:{kind:'delivery',mode:'online',onlineUrl:'javascript:alert(1)'}},'manager')).response.status,400);
  const key=randomUUID(),input={expectedVersion:1,reason:'Master cancellation',change:{kind:'cancel'}};
  const result=await f.request('sessions/'+s.id+'/change',input,'master',{key});assert.equal(result.response.status,200);
  assert.deepEqual((await f.request('sessions/'+s.id+'/change',input,'master',{key})).body,result.body);
  const pending=await f.request('sessions/'+s.id+'/change',{expectedVersion:2,reason:'Restore after staffing change',change:{kind:'restore'}},'manager');assert.equal(pending.response.status,202);
  await f.pg.query("DELETE FROM public.role_permissions WHERE role_id=$1 AND capability='sessions.request'",[f.managerRole]);
  const review=await f.approve(pending.body.approval.id);assert.equal(review.response.status,409);assert.equal(review.body.approval.status,'stale');assert.equal((await f.request('sessions/'+s.id)).body.data.status,'cancelled');
});

check('session approval outbox failure rolls back both the time change and approval decision for a safe retry',async f=>{
  const c=await f.create(),s=(await f.request('classes/'+c.id+'/sessions')).body.data[0];
  const pending=await f.request('sessions/'+s.id+'/change',{expectedVersion:1,reason:'Teacher unavailable',change:{kind:'cancel'}},'manager');assert.equal(pending.response.status,202);
  await f.pg.exec(`CREATE FUNCTION public.synthetic_session_outage() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Synthetic outage'; END $$;
    CREATE TRIGGER synthetic_session_outage BEFORE INSERT ON public.outbox_events FOR EACH ROW EXECUTE FUNCTION public.synthetic_session_outage()`);
  const key=randomUUID(),decision={expectedVersion:1,decision:'approve',reason:'Reviewed'};
  assert.equal((await f.request('approvals/'+pending.body.approval.id+'/decide',decision,'master',{key})).response.status,503);
  assert.equal((await f.request('sessions/'+s.id)).body.data.status,'scheduled');assert.equal((await f.request('approvals/'+pending.body.approval.id)).body.data.status,'pending');
  await f.pg.exec('DROP TRIGGER synthetic_session_outage ON public.outbox_events; DROP FUNCTION public.synthetic_session_outage()');
  assert.equal((await f.request('approvals/'+pending.body.approval.id+'/decide',decision,'master',{key})).response.status,200);
  assert.equal((await f.request('sessions/'+s.id)).body.data.status,'cancelled');
});

check('cancelled slots can be reused but conflicting restoration is blocked without erasing history',async f=>{
  const c=await f.create(),s=(await f.request('classes/'+c.id+'/sessions')).body.data[0];
  assert.equal((await f.request('sessions/'+s.id+'/change',{expectedVersion:1,reason:'Holiday',change:{kind:'cancel'}})).response.status,200);
  assert.equal((await f.request('classes/'+c.id+'/schedules',{expectedVersion:1,schedule:one('2027-03-07')})).response.status,201);
  const restore=await f.request('sessions/'+s.id+'/change',{expectedVersion:2,reason:'Reconsidered',change:{kind:'restore'}});assert.equal(restore.response.status,409);
  assert.equal((await f.request('sessions/'+s.id)).body.data.status,'cancelled');assert.equal((await f.request('classes/'+c.id+'/sessions')).body.data.length,3);
});
check('management bots use the same scoped session API and cannot approve their own requests',async f=>{
  const c=await f.create(),s=(await f.request('classes/'+c.id+'/sessions')).body.data[0];
  const pending=await f.request('sessions/'+s.id+'/change',{expectedVersion:1,reason:'Agent detected a staffing conflict',change:{kind:'cancel'}},'bot');assert.equal(pending.response.status,202);
  assert.equal((await f.approve(pending.body.approval.id,'bot')).response.status,403);
  assert.equal((await f.approve(pending.body.approval.id,'manager')).response.status,200);
  assert.equal((await f.request('sessions/'+s.id)).body.data.status,'cancelled');
  const other=await f.create({hubId:f.otherHub}),hidden=(await f.request('classes/'+other.id+'/sessions')).body.data[0];
  assert.equal((await f.request('sessions/'+hidden.id+'/change',{expectedVersion:1,reason:'Outside scope',change:{kind:'cancel'}},'bot')).response.status,404);
});

if(process.env.TEST_DATABASE_URL) {
  check('concurrent schedule appends cannot overwrite the class version or produce a duplicate batch',async f=>{
    const c=await f.create(),results=await Promise.all(['2027-04-01','2027-04-02'].map(day=>f.request('classes/'+c.id+'/schedules',{expectedVersion:1,schedule:one(day)})));
    assert.deepEqual(results.map(r=>r.response.status).sort(),[201,409]);assert.equal((await f.request('classes/'+c.id+'/schedules')).body.data.length,2);
  });
  check('hub archival racing class creation cannot leave an active class under an inactive hub',async f=>{
    const results=await Promise.all([f.request('hubs/'+f.hub+'/update',{expectedVersion:1,active:false}),f.request('classes',f.input)]),statuses=results.map(r=>r.response.status);
    assert.ok((statuses[0]===200&&statuses[1]===400)||(statuses[0]===409&&statuses[1]===201),JSON.stringify(statuses));
    assert.equal((await f.pg.query('SELECT c.id FROM public.classes c JOIN public.hubs h ON c.academy_id=h.academy_id AND c.hub_id=h.id WHERE c.active AND NOT h.active')).rows.length,0);
  });
}
