import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { operationsFixture } from './operations-fixture.ts';

async function fixture() {
  const f=await operationsFixture();
  const input={personId:f.actors.staff.person,legalName:'Synthetic legal student',preferredName:'Synthetic nickname',dateOfBirth:'2014-03-20',shirtSize:'Youth L',recruiter:{kind:'academy'},reason:'Private administrative note: DOB 2014-03-20'};
  async function add(body:unknown=input,as='master',key?:string){return f.request('students',body,as,key?{key}:{});}
  const created=await add();assert.equal(created.response.status,201,JSON.stringify(created.body));
  async function grant(person:string,caps:string[],selection:Record<string,unknown>={hubIds:[f.hub]}) {
    const r=await f.request('roles',{name:'Private profile rights '+randomUUID(),permissions:caps.map(capability=>({capability,effect:'allow'}))});assert.equal(r.response.status,201);
    const before=await f.request('people/'+person+'/access');
    const result=await f.request('people/'+person+'/access',{expectedVersion:before.body.data.version,assignments:[{roleId:r.body.data.id,allHubs:false,...selection}]});assert.equal(result.response.status,200,JSON.stringify(result.body));return r.body.data;
  }
  return {...f,input,add,grant,student:f.actors.staff.person};
}
type Fixture=Awaited<ReturnType<typeof fixture>>;
function check(name:string,run:(f:Fixture)=>Promise<void>){test(name,async()=>{const f=await fixture();try{await run(f);}finally{await f.pg.close();}});}

check('private student profile persists Unicode names, free-form shirt sizes and exact birth date while partial patches preserve omitted data',async f=>{
  let detail=await f.request('students/'+f.student);assert.equal(detail.response.status,200);assert.equal(detail.body.data.date_of_birth,'2014-03-20');
  const changed=await f.request('students/'+f.student+'/update',{expectedVersion:1,legalName:'学生 Élodie',reason:'Correction'});assert.equal(changed.response.status,200,JSON.stringify(changed.body));assert.deepEqual(changed.body.data,{personId:f.student,version:2});
  detail=await f.request('students/'+f.student);assert.equal(detail.body.data.legal_name,'学生 Élodie');assert.equal(detail.body.data.preferred_name,f.input.preferredName);assert.equal(detail.body.data.shirt_size,'Youth L');assert.equal(detail.body.data.date_of_birth,'2014-03-20');
  assert.equal((await f.request('students/'+f.student+'/update',{expectedVersion:2,preferredName:null,shirtSize:null})).response.status,200);
  detail=await f.request('students/'+f.student);assert.equal(detail.body.data.preferred_name,null);assert.equal(detail.body.data.shirt_size,null);
  const history=await f.request('students/'+f.student+'/history?limit=1');assert.equal(history.body.data[0].definition.legal_name,f.input.legalName);assert.equal(history.body.nextVersion,1);
  const next=await f.request('students/'+f.student+'/history?afterVersion=1');assert.equal(next.body.data.length,2);assert.equal(next.body.data[0].definition.legal_name,'学生 Élodie');
});
check('private profile rights do not follow generic people rights; selected-student scopes and explicit denials filter list and detail',async f=>{
  assert.equal((await f.request('students',undefined,'manager')).response.status,403);
  assert.equal((await f.add({...f.input,personId:f.actors.peer.person,legalName:'Outside private profile'})).response.status,201);
  await f.grant(f.actors.manager.person,['students.view','students.edit'],{personIds:[f.student]});
  const list=await f.request('students',undefined,'manager');assert.equal(list.response.status,200);assert.deepEqual(list.body.data.map((r:{person_id:string})=>r.person_id),[f.student]);assert.equal(list.body.data[0].date_of_birth,undefined);assert.equal(list.body.data[0].recruiter_kind,undefined);
  assert.equal((await f.request('students/'+f.actors.peer.person,undefined,'manager')).response.status,404);
  assert.equal((await f.request('students/'+f.actors.peer.person+'/history',undefined,'manager')).response.status,404);
  assert.equal((await f.request('students/'+f.student+'/update',{expectedVersion:1,shirtSize:'Custom size'},'manager')).response.status,200);
  const allow=await f.request('roles',{name:'All students',permissions:[{capability:'students.view',effect:'allow'}]}),deny=await f.request('roles',{name:'Hidden student',permissions:[{capability:'students.view',effect:'deny'}]});
  const prior=await f.request('people/'+f.actors.manager.person+'/access');
  assert.equal((await f.request('people/'+f.actors.manager.person+'/access',{expectedVersion:prior.body.data.version,assignments:[{roleId:allow.body.data.id,allHubs:true},{roleId:deny.body.data.id,allHubs:false,personIds:[f.student]}]})).response.status,200);
  assert.equal((await f.request('students/'+f.student,undefined,'manager')).response.status,404);
  assert.deepEqual((await f.request('students',undefined,'manager')).body.data.map((r:{person_id:string})=>r.person_id),[f.actors.peer.person]);
});
check('student directory omits sensitive fields, supports filters/pagination and ordinary audit does not expose profile values or private reasons',async f=>{
  for(const actor of ['manager','peer'])assert.equal((await f.add({...f.input,personId:f.actors[actor].person,legalName:'Another '+actor})).response.status,201);
  const one=await f.request('students?limit=1');assert.equal(one.body.data.length,1);assert.ok(one.body.nextCursor);
  const two=await f.request('students?after='+one.body.nextCursor);assert.equal(two.body.data.length,2);
  assert.equal((await f.request('students?q=nickname')).body.data.length,3);assert.equal((await f.request('students?hubId='+f.otherHub)).body.data.length,1);
  for(const row of [...one.body.data,...two.body.data])assert.deepEqual(Object.keys(row).sort(),['person_id','legal_name','preferred_name','hub_id','status','version'].sort());
  const events=(await f.request('audit-events')).body.data.filter((e:{action:string})=>e.action.startsWith('student.profile.'));
  assert.equal(events.length,3);const serialized=JSON.stringify(events);assert.ok(!serialized.includes(f.input.legalName));assert.ok(!serialized.includes(f.input.dateOfBirth));assert.ok(!serialized.includes('Private administrative note'));
  const history=await f.request('students/'+f.student+'/history');assert.equal(history.body.data[0].reason,f.input.reason);
});
check('recruiter source uses selectable academy, hub or human references without accepting hidden, foreign, bot or free-text replacements',async f=>{
  let result=await f.request('students/'+f.student+'/update',{expectedVersion:1,recruiter:{kind:'hub',id:f.hub}});assert.equal(result.response.status,200);
  result=await f.request('students/'+f.student+'/update',{expectedVersion:2,recruiter:{kind:'person',id:f.actors.manager.person}});assert.equal(result.response.status,200);
  let detail=await f.request('students/'+f.student);assert.equal(detail.body.data.recruiter_person_id,f.actors.manager.person);assert.equal(detail.body.data.recruiter_hub_id,null);
  for(const value of [{kind:'person',id:f.bot},{kind:'person',id:f.actors.foreignMaster.person},{kind:'hub',id:f.foreignHub},{kind:'person',name:'Unregistered collector'}])
    assert.ok([400,404].includes((await f.request('students/'+f.student+'/update',{expectedVersion:3,recruiter:value})).response.status));
  await f.grant(f.actors.manager.person,['students.edit'],{personIds:[f.student]});
  assert.equal((await f.request('students/'+f.student+'/update',{expectedVersion:3,recruiter:{kind:'person',id:f.actors.peer.person}},'manager')).response.status,403);
  result=await f.request('students/'+f.student+'/update',{expectedVersion:3,recruiter:{kind:'academy'}});assert.equal(result.response.status,200);
  detail=await f.request('students/'+f.student);assert.equal(detail.body.data.recruiter_kind,'academy');assert.equal(detail.body.data.recruiter_person_id,null);
});
check('student profile creation cannot activate a pending account, enrollment or public profile and requires a human reference',async f=>{
  const pending=await f.request('people',{name:'Pending child',hubId:f.hub});assert.equal(pending.response.status,201);
  const added=await f.add({...f.input,personId:pending.body.data.id});assert.equal(added.response.status,201);
  assert.deepEqual((await f.pg.query('SELECT status,auth_user_id FROM public.people WHERE id=$1',[pending.body.data.id])).rows[0],{status:'pending',auth_user_id:null});
  assert.equal((await f.pg.query('SELECT * FROM public.role_assignments WHERE person_id=$1',[pending.body.data.id])).rows.length,0);
  assert.equal((await f.add({...f.input,personId:f.bot})).response.status,400);assert.equal((await f.add({...f.input,personId:f.actors.foreignMaster.person})).response.status,404);
  assert.equal((await f.request('students/'+pending.body.data.id)).body.data.publicProfile,undefined);
});
check('profile validation, optimistic versions and retry keys prevent erasure or partial records',async f=>{
  for(const patch of [{dateOfBirth:'2999-01-01'},{dateOfBirth:'2014-02-30'},{preferredName:''},{shirtSize:' '},{allergies:'Not a generic profile field'},{personId:f.actors.peer.person}])
    assert.equal((await f.request('students/'+f.student+'/update',{expectedVersion:1,...patch})).response.status,400,JSON.stringify(patch));
  assert.equal((await f.request('students/'+f.student+'/update',{expectedVersion:1})).response.status,400);
  assert.equal((await f.request('students/'+f.student+'?q=private')).response.status,400);
  assert.equal((await f.request('students/'+f.student+'/history?limit=101')).response.status,400);
  assert.equal((await f.request('students/'+f.student+'/history?afterVersion=2147483648')).response.status,400);
  assert.equal((await f.request('students/'+f.student+'/update',{expectedVersion:2147483648,shirtSize:'M'})).response.status,400);
  const key=randomUUID(),input={...f.input,personId:f.actors.manager.person};const one=await f.add(input,'master',key),retry=await f.add(input,'master',key);assert.equal(one.response.status,201);assert.deepEqual(retry.body,one.body);
  assert.equal((await f.add(input)).response.status,409);assert.equal((await f.request('students/'+f.student+'/update',{expectedVersion:2,shirtSize:'M'})).response.status,409);
  await f.pg.exec('REVOKE INSERT ON public.outbox_events FROM kavosh_runtime');
  try{assert.equal((await f.add({...f.input,personId:f.actors.peer.person})).response.status,503);}finally{await f.pg.exec('GRANT INSERT ON public.outbox_events TO kavosh_runtime');}
  assert.equal((await f.pg.query('SELECT * FROM public.student_profiles WHERE person_id=$1',[f.actors.peer.person])).rows.length,0);assert.equal((await f.pg.query('SELECT * FROM public.student_profile_revisions WHERE person_id=$1',[f.actors.peer.person])).rows.length,0);
});
check('student storage enforces tenant/human/recruiter boundaries and immutable identifiers/history',async f=>{
  await assert.rejects(f.pg.query("INSERT INTO public.student_profiles(academy_id,person_id,legal_name,date_of_birth,recruiter_kind) VALUES($1,$2,'Foreign','2014-03-20','academy')",[f.a,f.actors.foreignMaster.person]),/foreign key/i);
  await assert.rejects(f.pg.query('UPDATE public.student_profiles SET recruiter_kind=\'hub\',recruiter_hub_id=$2 WHERE person_id=$1',[f.student,f.foreignHub]),/foreign key/i);
  await f.pg.exec('SET ROLE kavosh_runtime');
  try {
    await f.pg.query("SELECT set_config('app.academy_id',$1,false)",[f.b]);assert.equal((await f.pg.query('SELECT * FROM public.student_profiles')).rows.length,0);assert.equal((await f.pg.query('SELECT * FROM public.student_profile_revisions')).rows.length,0);
    await f.pg.query("SELECT set_config('app.academy_id',$1,false)",[f.a]);
    await assert.rejects(f.pg.query('UPDATE public.student_profiles SET person_id=$2 WHERE person_id=$1',[f.student,f.actors.peer.person]),/permission denied/i);
    await assert.rejects(f.pg.query("UPDATE public.student_profile_revisions SET definition='{}' WHERE person_id=$1",[f.student]),/permission denied/i);
    await assert.rejects(f.pg.query('DELETE FROM public.student_profiles WHERE person_id=$1',[f.student]),/permission denied/i);
  }finally{await f.pg.exec('RESET ROLE');}
});
if(process.env.TEST_DATABASE_URL) {
  check('concurrent student corrections keep one winner and the complete version history',async f=>{
    const results=await Promise.all(['S','M'].map(shirtSize=>f.request('students/'+f.student+'/update',{expectedVersion:1,shirtSize})));
    assert.deepEqual(results.map(r=>r.response.status).sort(),[200,409]);assert.equal((await f.pg.query('SELECT * FROM public.student_profile_revisions WHERE person_id=$1',[f.student])).rows.length,2);
  });
}
test('international birth-date validation does not confuse a local calendar date with the server UTC date',async t=>{
  const f=await fixture();try {
    t.mock.method(Date,'now',()=>Date.parse('2026-11-03T10:30:00Z'));
    const todayAhead=await f.add({...f.input,personId:f.actors.manager.person,dateOfBirth:'2026-11-04'});assert.equal(todayAhead.response.status,201,JSON.stringify(todayAhead.body));
    assert.equal((await f.request('students/'+f.actors.manager.person)).body.data.date_of_birth,'2026-11-04');
    assert.equal((await f.add({...f.input,personId:f.actors.peer.person,dateOfBirth:'2026-11-05'})).response.status,400);
    t.mock.method(Date,'now',()=>Date.parse('2026-11-03T09:30:00Z'));
    assert.equal((await f.add({...f.input,personId:f.actors.peer.person,dateOfBirth:'2026-11-04'})).response.status,400,'a date that is still in the future everywhere is rejected');
  }finally{await f.pg.close();}
});
