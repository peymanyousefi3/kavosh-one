import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { operationsFixture } from './operations-fixture.ts';

async function fixture() {
  const f=await operationsFixture(),guardian=f.actors.staff.person;
  const input={personId:guardian,legalName:'Synthetic guardian legal name',wechatId:'Synthetic_Private_WeChat',reason:'Private guardian correction note'};
  async function add(body:unknown=input,as='master',key?:string){return f.request('guardians',body,as,key?{key}:{});}
  const created=await add();assert.equal(created.response.status,201,JSON.stringify(created.body));
  async function grant(person:string,caps:string[],selection:Record<string,unknown>={personIds:[guardian]}) {
    const r=await f.request('roles',{name:'Guardian rights '+randomUUID(),permissions:caps.map(capability=>({capability,effect:'allow'}))});assert.equal(r.response.status,201);
    const before=await f.request('people/'+person+'/access');
    const result=await f.request('people/'+person+'/access',{expectedVersion:before.body.data.version,assignments:[{roleId:r.body.data.id,allHubs:false,...selection}]});assert.equal(result.response.status,200,JSON.stringify(result.body));
  }
  return {...f,guardian,input,add,grant};
}
type Fixture=Awaited<ReturnType<typeof fixture>>;
function check(name:string,run:(f:Fixture)=>Promise<void>){test(name,async()=>{const f=await fixture();try{await run(f);}finally{await f.pg.close();}});}

check('guardian private names/WeChat corrections preserve omitted fields, clear explicitly and retain immutable history',async f=>{
  let detail=await f.request('guardians/'+f.guardian);assert.equal(detail.response.status,200);assert.equal(detail.body.data.wechat_id,f.input.wechatId);
  assert.equal((await f.request('guardians/'+f.guardian+'/update',{expectedVersion:1,legalName:'监护人 Élodie'})).response.status,200);
  detail=await f.request('guardians/'+f.guardian);assert.equal(detail.body.data.legal_name,'监护人 Élodie');assert.equal(detail.body.data.wechat_id,f.input.wechatId);
  assert.equal((await f.request('guardians/'+f.guardian+'/update',{expectedVersion:2,wechatId:null})).response.status,200);
  assert.equal((await f.request('guardians/'+f.guardian)).body.data.wechat_id,null);
  const history=await f.request('guardians/'+f.guardian+'/history?limit=1');assert.equal(history.body.data[0].definition.wechat_id,f.input.wechatId);assert.equal(history.body.data[0].reason,f.input.reason);assert.equal(history.body.nextVersion,1);
  assert.equal((await f.request('guardians/'+f.guardian+'/history?afterVersion=1')).body.data.length,2);
  assert.equal((await f.request('guardians/'+f.guardian+'/update',{expectedVersion:1,legalName:'Stale edit'})).response.status,409);
});
check('guardian contact verification is read from actual identity state and cannot be forged through profile inputs',async f=>{
  let detail=await f.request('guardians/'+f.guardian);assert.equal(detail.body.contacts.verification_complete,true);assert.equal(detail.body.contacts.email,'staff@example.test');assert.match(detail.body.contacts.phone,/^\+1647/);
  for(const body of [{phone_verified:true},{emailVerified:true},{verification_complete:true},{phone:'+16475550000'},{email:'unverified@example.test'},{auth_user_id:randomUUID()}])
    assert.equal((await f.request('guardians/'+f.guardian+'/update',{expectedVersion:1,...body})).response.status,400);
  await f.pg.query('UPDATE identity."user" SET "phoneNumberVerified"=false WHERE id=$1',[f.actors.staff.user]);
  detail=await f.request('guardians/'+f.guardian);assert.equal(detail.body.contacts.phone_verified,false);assert.equal(detail.body.contacts.verification_complete,false);
  await f.pg.query('UPDATE identity."user" SET "phoneNumberVerified"=true,"emailVerified"=false WHERE id=$1',[f.actors.staff.user]);
  detail=await f.request('guardians/'+f.guardian);assert.equal(detail.body.contacts.email_verified,false);assert.equal(detail.body.contacts.verification_complete,false);
  await f.pg.query('UPDATE identity."user" SET "emailVerified"=true WHERE id=$1',[f.actors.staff.user]);
  for(const value of [null,'','6475550000','+1647','+1234567890123456'])await assert.rejects(f.pg.query('UPDATE identity."user" SET "phoneNumber"=$2,"phoneNumberVerified"=true WHERE id=$1',[f.actors.staff.user,value]),/verified_phone_present/i);
  await f.pg.query('UPDATE identity."user" SET "phoneNumber"=NULL,"phoneNumberVerified"=false WHERE id=$1',[f.actors.staff.user]);
  detail=await f.request('guardians/'+f.guardian);assert.equal(detail.body.contacts.phone_verified,false);assert.equal(detail.body.contacts.verification_complete,false);
  await f.pg.query("UPDATE public.people SET status='disabled' WHERE id=$1",[f.guardian]);
  assert.equal((await f.request('guardians/'+f.guardian)).body.contacts.verification_complete,false);
});
check('draft guardian profiles do not activate pending accounts or declare contact verification or family authority',async f=>{
  const pending=await f.request('people',{name:'Draft parent',email:'draft-parent@example.test',hubId:f.hub});assert.equal(pending.response.status,201);
  assert.equal((await f.add({...f.input,personId:pending.body.data.id})).response.status,201);
  const detail=await f.request('guardians/'+pending.body.data.id);assert.deepEqual(detail.body.contacts,{email:'draft-parent@example.test',phone:null,email_verified:false,phone_verified:false,account_active:false,verification_complete:false});
  assert.equal((await f.pg.query('SELECT status FROM public.people WHERE id=$1',[pending.body.data.id])).rows[0].status,'pending');
  assert.equal((await f.pg.query('SELECT * FROM public.role_assignments WHERE person_id=$1',[pending.body.data.id])).rows.length,0);
  assert.equal(detail.body.data.studentIds,undefined);
});
check('guardian scope is separate from basic people rights and directory/audit responses omit private contacts, handles and notes',async f=>{
  assert.equal((await f.request('guardians',undefined,'manager')).response.status,403);
  assert.equal((await f.add({...f.input,personId:f.actors.peer.person,legalName:'Outside guardian'})).response.status,201);
  await f.grant(f.actors.manager.person,['guardians.view','guardians.edit']);
  const list=await f.request('guardians',undefined,'manager');assert.equal(list.response.status,200);assert.deepEqual(list.body.data.map((r:{person_id:string})=>r.person_id),[f.guardian]);
  assert.deepEqual(Object.keys(list.body.data[0]).sort(),['person_id','legal_name','hub_id','status','version'].sort());
  assert.equal((await f.request('guardians/'+f.actors.peer.person,undefined,'manager')).response.status,404);
  assert.equal((await f.request('guardians/'+f.actors.peer.person+'/history',undefined,'manager')).response.status,404);
  assert.equal((await f.request('guardians/'+f.guardian,undefined,'manager')).body.contacts.verification_complete,true);
  const events=(await f.request('audit-events')).body.data.filter((e:{action:string})=>e.action.startsWith('guardian.profile.'));
  const serialized=JSON.stringify(events);for(const value of [f.input.legalName,f.input.wechatId,f.input.reason])assert.ok(!serialized.includes(value));
  assert.equal((await f.request('guardians?q=Outside&hubId='+f.otherHub)).body.data.length,1);
  const first=await f.request('guardians?limit=1');assert.ok(first.body.nextCursor);assert.equal((await f.request('guardians?after='+first.body.nextCursor)).body.data.length,1);
});
check('guardian create/update validation, idempotency and outbox rollback preserve a consistent private history',async f=>{
  for(const patch of [{legalName:''},{wechatId:''},{expectedVersion:2147483648},{dateOfBirth:'1990-01-01'}])assert.equal((await f.request('guardians/'+f.guardian+'/update',{expectedVersion:1,...patch})).response.status,400);
  assert.equal((await f.request('guardians/'+f.guardian+'/update',{expectedVersion:1})).response.status,400);
  assert.equal((await f.request('guardians/'+f.guardian+'/history?afterVersion=2147483648')).response.status,400);
  assert.equal((await f.request('guardians/'+f.guardian+'?unknown=true')).response.status,400);
  assert.equal((await f.add({...f.input,personId:f.bot})).response.status,400);assert.equal((await f.add({...f.input,personId:f.actors.foreignMaster.person})).response.status,404);
  const key=randomUUID(),body={...f.input,personId:f.actors.manager.person};const one=await f.add(body,'master',key),two=await f.add(body,'master',key);assert.equal(one.response.status,201);assert.deepEqual(two.body,one.body);
  assert.equal((await f.add(body)).response.status,409);
  await f.pg.exec('REVOKE INSERT ON public.outbox_events FROM kavosh_runtime');
  try{assert.equal((await f.add({...f.input,personId:f.actors.peer.person})).response.status,503);}finally{await f.pg.exec('GRANT INSERT ON public.outbox_events TO kavosh_runtime');}
  assert.equal((await f.pg.query('SELECT * FROM public.guardian_profiles WHERE person_id=$1',[f.actors.peer.person])).rows.length,0);assert.equal((await f.pg.query('SELECT * FROM public.guardian_profile_revisions WHERE person_id=$1',[f.actors.peer.person])).rows.length,0);
});
check('guardian contact helper is tenant-bound, exposes no identity secrets and retains native storage privileges',async f=>{
  const foreign=await f.request('guardians',{...f.input,personId:f.actors.foreignMaster.person},'foreignMaster',{academy:f.b});assert.equal(foreign.response.status,201);
  await f.pg.exec('SET ROLE kavosh_runtime');
  try {
    await f.pg.query("SELECT set_config('app.academy_id',$1,false)",[f.a]);
    assert.equal((await f.pg.query('SELECT * FROM public.guardian_contact_status($1)',[f.actors.foreignMaster.person])).rows.length,0);
    assert.equal((await f.pg.query('SELECT * FROM public.guardian_profiles WHERE academy_id=$1',[f.b])).rows.length,0);
    const contact=(await f.pg.query('SELECT * FROM public.guardian_contact_status($1)',[f.guardian])).rows[0];assert.deepEqual(Object.keys(contact).sort(),['email','phone','email_verified','phone_verified','account_active'].sort());
    await assert.rejects(f.pg.query('SELECT * FROM identity."user"'),/permission denied/i);
    await assert.rejects(f.pg.query('UPDATE public.guardian_profiles SET person_id=$2 WHERE person_id=$1',[f.guardian,f.actors.peer.person]),/permission denied/i);
    await assert.rejects(f.pg.query("UPDATE public.guardian_profile_revisions SET definition='{}' WHERE person_id=$1",[f.guardian]),/permission denied/i);
    await f.pg.query("SELECT set_config('app.academy_id','',false)");assert.equal((await f.pg.query('SELECT * FROM public.guardian_contact_status($1)',[f.guardian])).rows.length,0);
  }finally{await f.pg.exec('RESET ROLE');}
  const exposed=(await f.pg.query(`SELECT count(*)::int AS count FROM pg_proc p CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
    WHERE p.oid='public.guardian_contact_status(uuid)'::regprocedure AND a.grantee=0 AND a.privilege_type='EXECUTE'`)).rows[0];assert.equal(exposed.count,0);
  await assert.rejects(f.pg.query("INSERT INTO public.guardian_profiles(academy_id,person_id,legal_name) VALUES($1,$2,'Foreign')",[f.a,f.actors.foreignMaster.person]),/foreign key/i);
});
if(process.env.TEST_DATABASE_URL)check('concurrent guardian corrections retain one winner and complete private revision history',async f=>{
  const results=await Promise.all(['First legal correction','Other legal correction'].map(legalName=>f.request('guardians/'+f.guardian+'/update',{expectedVersion:1,legalName})));
  assert.deepEqual(results.map(r=>r.response.status).sort(),[200,409]);assert.equal((await f.pg.query('SELECT * FROM public.guardian_profile_revisions WHERE person_id=$1',[f.guardian])).rows.length,2);
});
