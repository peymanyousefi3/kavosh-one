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
  const course=await f.request('courses',{code:'STAFF',name:'Staff test curriculum'});assert.equal(course.response.status,201);
  async function createClass(hubId=f.hub) {
    const r=await f.request('classes',{hubId,courseId:course.body.data.id,courseVersion:1,name:'Staff test class',mode:'in_person',schedule:{oneOff:[{start:'2027-01-01T10:00',end:'2027-01-01T11:00'}]}});
    assert.equal(r.response.status,201);return r.body.data;
  }
  const first=await createClass(),second=await createClass(),other=await createClass(f.otherHub);
  const input={personId:f.actors.staff.person,role:'teacher',startsOn:'2027-01-01',endsOn:'2027-01-31',reason:'Initial staffing'};
  async function add(body:unknown=input,classId=first.id,as='master') {return f.request('classes/'+classId+'/staff',body,as);}
  return {...f,first,second,other,input,add};
}
type Fixture=Awaited<ReturnType<typeof fixture>>;
function check(name:string,run:(f:Fixture)=>Promise<void>){test(name,async()=>{const f=await fixture();try{await run(f);}finally{await f.pg.close();}});}

check('dated teacher, TA and volunteer assignments persist, filter inclusively and retain immutable reasons/revisions',async f=>{
  const added=await f.add();assert.equal(added.response.status,201,JSON.stringify(added.body));const id=added.body.data.id;
  for(const on of ['2027-01-01','2027-01-31'])assert.equal((await f.request('classes/'+f.first.id+'/staff?on='+on)).body.data.length,1);
  for(const on of ['2026-12-31','2027-02-01'])assert.equal((await f.request('classes/'+f.first.id+'/staff?on='+on)).body.data.length,0);
  const changed=await f.request('class-staff/'+id+'/update',{expectedVersion:1,role:'ta',reason:'Changed teaching duty'});assert.equal(changed.response.status,200);
  assert.equal(changed.body.data.starts_on,'2027-01-01');assert.equal(changed.body.data.ends_on,'2027-01-31');
  const history=await f.request('class-staff/'+id+'/history?limit=1');assert.equal(history.body.data[0].definition.role,'teacher');assert.equal(history.body.nextVersion,1);
  const next=await f.request('class-staff/'+id+'/history?afterVersion=1');assert.equal(next.body.data[0].definition.role,'ta');assert.equal(next.body.data[0].reason,'Changed teaching duty');
  assert.equal((await f.request('class-staff/'+id+'/update',{expectedVersion:1,role:'volunteer',reason:'Stale edit'})).response.status,409);
  assert.equal((await f.request('class-staff/'+id+'/update',{expectedVersion:2,active:false,reason:'Cancelled assignment'})).response.status,200);
  const inactive=await f.request('class-staff/'+id+'/update',{expectedVersion:3,role:'volunteer',reason:'Correct archived duty'});assert.equal(inactive.body.data.active,false,'a partial edit must not reactivate an assignment');
  assert.equal((await f.request('classes/'+f.first.id+'/staff?active=false&role=volunteer')).body.data.length,1);
});
check('native staff ranges reject duplicate/overlapping roles but allow adjacent dates and simultaneous different classes',async f=>{
  assert.equal((await f.add()).response.status,201);
  const overlap=await f.add({...f.input,role:'ta',startsOn:'2027-01-31',endsOn:'2027-02-28'});assert.equal(overlap.response.status,409);assert.equal(overlap.body.error.code,'STAFF_ASSIGNMENT_OVERLAP');
  assert.equal((await f.add({...f.input,startsOn:'2027-02-01',endsOn:null})).response.status,201);
  assert.equal((await f.add(f.input,f.second.id)).response.status,201);
  assert.equal((await f.add({...f.input,personId:f.actors.manager.person})).response.status,201);
  assert.equal((await f.request('classes/'+f.first.id+'/staff?personId='+f.actors.staff.person)).body.data.length,2);
});
check('staff rights are separate from class editing and selected-class grants expose no neighbouring roster or personal contacts',async f=>{
  const added=await f.add();assert.equal(added.response.status,201);const id=added.body.data.id;
  assert.equal((await f.request('classes/'+f.first.id+'/staff',undefined,'manager')).response.status,403);
  const role=await f.request('roles',{name:'Selected roster editor',permissions:[{capability:'staff.view',effect:'allow'},{capability:'staff.edit',effect:'allow'}]});assert.equal(role.response.status,201);
  const current=await f.request('people/'+f.actors.manager.person+'/access');
  assert.equal((await f.request('people/'+f.actors.manager.person+'/access',{expectedVersion:current.body.data.version,assignments:[{roleId:role.body.data.id,allHubs:false,classIds:[f.first.id]}]})).response.status,200);
  const own=await f.request('classes/'+f.first.id+'/staff',undefined,'manager');assert.equal(own.response.status,200);assert.equal(own.body.data[0].person_id,f.actors.staff.person);assert.equal(own.body.data[0].email,undefined);
  assert.equal((await f.request('classes/'+f.other.id+'/staff',undefined,'manager')).response.status,404);
  assert.equal((await f.request('class-staff/'+id+'/update',{expectedVersion:1,role:'ta',reason:'Permitted roster change'},'manager')).response.status,200);
  assert.equal((await f.add({...f.input,personId:f.actors.peer.person,startsOn:'2027-02-01',endsOn:null},f.first.id,'manager')).response.status,404,'assignment creation separately requires permission to select that person');
  assert.equal((await f.request('classes/'+f.first.id,undefined,'manager')).response.status,403,'roster rights do not grant class content');
});
check('staff validation rejects invalid dates, unknown fields, foreign people, bots and disabled humans',async f=>{
  for(const patch of [{startsOn:'2027-02-30'},{startsOn:'1899-12-31'},{endsOn:'2026-12-31'},{role:'admin'},{personId:f.bot},{personId:f.actors.foreignMaster.person},{unexpected:true}])
    assert.ok([400,404].includes((await f.add({...f.input,...patch})).response.status),JSON.stringify(patch));
  await f.pg.query("UPDATE public.people SET status='disabled' WHERE id=$1",[f.actors.staff.person]);
  assert.equal((await f.add()).response.status,400);
  assert.equal((await f.request('classes/'+f.first.id+'/staff?unknown=true')).response.status,400);
  assert.equal((await f.request('classes/'+f.first.id+'/staff?on=2027-02-30')).response.status,400);
});
check('assignment retries are durable and an outbox failure rolls back staff, revisions, audit and request key',async f=>{
  const key=randomUUID(),path='classes/'+f.first.id+'/staff';
  const one=await f.request(path,f.input,'master',{key}),two=await f.request(path,f.input,'master',{key});assert.equal(one.response.status,201);assert.deepEqual(two.body,one.body);
  await f.pg.exec('REVOKE INSERT ON public.outbox_events FROM kavosh_runtime');
  try{assert.equal((await f.add({...f.input,personId:f.actors.manager.person})).response.status,503);}finally{await f.pg.exec('GRANT INSERT ON public.outbox_events TO kavosh_runtime');}
  assert.equal((await f.pg.query('SELECT * FROM public.class_staff')).rows.length,1);assert.equal((await f.pg.query('SELECT * FROM public.class_staff_revisions')).rows.length,1);
  assert.equal((await f.add({...f.input,personId:f.actors.manager.person})).response.status,201);
});
check('staff tables enforce tenant/person kind constraints and runtime cannot rewrite revisions or reparent assignments',async f=>{
  const added=await f.add();assert.equal(added.response.status,201);const id=added.body.data.id;
  await assert.rejects(f.pg.query("INSERT INTO public.class_staff(academy_id,id,class_id,person_id,role,starts_on) VALUES($1,$2,$3,$4,'teacher','2027-01-01')",[f.a,randomUUID(),f.first.id,f.actors.foreignMaster.person]),/foreign key/i);
  await f.pg.exec('SET ROLE kavosh_runtime');
  try {
    await f.pg.query("SELECT set_config('app.academy_id',$1,false)",[f.b]);assert.equal((await f.pg.query('SELECT * FROM public.class_staff')).rows.length,0);assert.equal((await f.pg.query('SELECT * FROM public.class_staff_revisions')).rows.length,0);
    await f.pg.query("SELECT set_config('app.academy_id',$1,false)",[f.a]);
    await assert.rejects(f.pg.query('UPDATE public.class_staff SET class_id=$2 WHERE id=$1',[id,f.other.id]),/permission denied/i);
    await assert.rejects(f.pg.query("UPDATE public.class_staff_revisions SET reason='forged' WHERE assignment_id=$1",[id]),/permission denied/i);
    await assert.rejects(f.pg.query('DELETE FROM public.class_staff WHERE id=$1',[id]),/permission denied/i);
  }finally{await f.pg.exec('RESET ROLE');}
});
check('staff assignments do not grant unrelated access and disabled people cannot be reactivated into teaching',async f=>{
  const before=await f.request('me/access',undefined,'staff'),added=await f.add();assert.equal(added.response.status,201);
  assert.deepEqual((await f.request('me/access',undefined,'staff')).body,before.body);
  const id=added.body.data.id;assert.equal((await f.request('class-staff/'+id+'/update',{expectedVersion:1,active:false,reason:'Teaching assignment ended'})).response.status,200);
  await f.pg.query("UPDATE public.people SET status='disabled' WHERE id=$1",[f.actors.staff.person]);
  assert.equal((await f.request('class-staff/'+id+'/update',{expectedVersion:2,active:true,reason:'Attempt reactivation'})).response.status,400);
  assert.equal((await f.request('classes/'+f.first.id+'/staff?unexpected=true',f.input)).response.status,400);
  await f.pg.query('UPDATE public.classes SET active=false WHERE id=$1',[f.second.id]);
  assert.equal((await f.add({...f.input,personId:f.actors.manager.person},f.second.id)).response.status,409);
});
if(process.env.TEST_DATABASE_URL) {
  check('concurrent staff updates cannot lose a revision or silently replace another change',async f=>{
    const added=await f.add();assert.equal(added.response.status,201);const id=added.body.data.id;
    const results=await Promise.all(['ta','volunteer'].map(role=>f.request('class-staff/'+id+'/update',{expectedVersion:1,role,reason:'Concurrent edit '+role})));
    assert.deepEqual(results.map(r=>r.response.status).sort(),[200,409]);
    assert.equal((await f.pg.query('SELECT * FROM public.class_staff_revisions WHERE assignment_id=$1',[id])).rows.length,2);
  });
  check('concurrent overlapping staff creates leave exactly one assignment and one revision',async f=>{
    const results=await Promise.all([f.add(),f.add()]);assert.deepEqual(results.map(r=>r.response.status).sort(),[201,409]);
    assert.equal((await f.pg.query('SELECT * FROM public.class_staff')).rows.length,1);assert.equal((await f.pg.query('SELECT * FROM public.class_staff_revisions')).rows.length,1);
  });
}
