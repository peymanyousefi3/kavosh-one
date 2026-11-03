import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { operationsFixture } from './operations-fixture.ts';
import { scopeFor,scopeContains,scopeAllowsRef,type Scope,type ResourceRef,type Capability } from '../src/core/policy.ts';

async function fixture() {
  const f=await operationsFixture(),country=randomUUID(),region=randomUUID(),city=randomUUID();
  await f.pg.query("INSERT INTO public.countries(academy_id,id,code,name) VALUES($1,$2,'CA','Canada')",[f.a,country]);
  await f.pg.query("INSERT INTO public.regions(academy_id,id,country_id,code,name) VALUES($1,$2,$3,'ON','Ontario')",[f.a,region,country]);
  await f.pg.query("INSERT INTO public.cities(academy_id,id,region_id,name) VALUES($1,$2,$3,'Toronto')",[f.a,city,region]);
  await f.pg.query("UPDATE public.hubs SET city_id=$1,time_zone='America/Toronto',currency='CAD' WHERE academy_id=$2",[city,f.a]);
  for(const cap of ['classes.view','classes.edit','sessions.request','courses.view'])await f.pg.query("INSERT INTO public.role_permissions VALUES($1,$2,$3,'allow')",[f.a,f.managerRole,cap]);
  const course=await f.request('courses',{code:'ROB-101',name:'Robotics'});assert.equal(course.response.status,201);
  async function createClass(hubId=f.hub) {
    const result=await f.request('classes',{hubId,courseId:course.body.data.id,courseVersion:1,name:'Selected class',mode:'in_person',schedule:{oneOff:[{start:'2027-01-01T10:00',end:'2027-01-01T11:00'}]}});
    assert.equal(result.response.status,201,JSON.stringify(result.body));return result.body.data;
  }
  const first=await createClass(),second=await createClass(),other=await createClass(f.otherHub);
  async function role(caps:Capability[],effect='allow') {
    const result=await f.request('roles',{name:'Scope preset '+randomUUID(),permissions:caps.map(capability=>({capability,effect}))});assert.equal(result.response.status,201);return result.body.data;
  }
  async function assign(person:string,assignments:unknown[],as='master') {
    const current=await f.request('people/'+person+'/access');assert.equal(current.response.status,200);
    return f.request('people/'+person+'/access',{expectedVersion:current.body.data.version,assignments},as);
  }
  return {...f,first,second,other,role,assign,createClass};
}
type Fixture=Awaited<ReturnType<typeof fixture>>;
function check(name:string,run:(f:Fixture)=>Promise<void>){test(name,async()=>{const f=await fixture();try{await run(f);}finally{await f.pg.close();}});}

test('record scopes intersect bot ceilings and explicit denials without becoming hub-wide',()=>{
  const ref={id:'class-one',hubId:'one'},second={id:'class-two',hubId:'two'},person={id:'person',hubId:'one'};
  const c={token_id:'t',academy_id:'a',person_id:'p',capabilities:['classes.view','people.view'] as Capability[],all_hubs:false,hub_ids:['one'],allowed:true};
  const selected={capability:'classes.view' as const,effect:'allow' as const,allHubs:false,hubIds:[],classRefs:[ref,second]};
  assert.deepEqual(scopeFor(c,[selected],'classes.view'),{all:false,hubs:[],classes:[ref]});
  const denied={...selected,effect:'deny' as const,classRefs:[ref]};
  assert.deepEqual(scopeFor(c,[selected,denied],'classes.view'),{all:false,hubs:[],excludedClasses:[ref]});
  assert.deepEqual(scopeFor(c,[selected,{...denied,classRefs:[second]}],'classes.view'),{all:false,hubs:[],classes:[ref]},'effective metadata must not expose excluded IDs outside the credential ceiling');
  const broad={...selected,allHubs:true,classRefs:[]};
  assert.equal(scopeAllowsRef(scopeFor(c,[broad,denied],'classes.view'),ref,'classes'),false);
  assert.equal(scopeAllowsRef(scopeFor(c,[broad,denied],'classes.view'),{id:'different',hubId:'one'},'classes'),true);
  assert.deepEqual(scopeFor(c,[{...selected,capability:'people.view',classRefs:[ref],personRefs:[person]}],'people.view'),{all:false,hubs:[],people:[person]});
});
test('containment is sound across deterministic mixed resource and denial combinations',()=>{
  const classes:ResourceRef[]=[{id:'a',hubId:'one'},{id:'b',hubId:'one'},{id:'c',hubId:'two'},{id:'future',hubId:'future-hub'}];
  const people:ResourceRef[]=[{id:'p',hubId:'one'},{id:'q',hubId:'two'},{id:'unassigned',hubId:null},{id:'future-person',hubId:'future-hub'}];
  let seed=195718;
  const bit=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return (seed>>>24)%2===1;};
  const cases:Scope[]=Array.from({length:100},()=>({all:bit(),hubs:['one','two'].filter(bit),excludedHubs:['one','two'].filter(bit),
    classes:classes.slice(0,3).filter(bit),people:people.slice(0,3).filter(bit),excludedClasses:classes.slice(0,3).filter(bit),excludedPeople:people.slice(0,3).filter(bit)}));
  for(const source of cases)for(const target of cases)if(scopeContains(source,target)) {
    for(const [kind,refs] of [['classes',classes],['people',people]] as const)for(const ref of refs)
      if(scopeAllowsRef(target,ref,kind))assert.equal(scopeAllowsRef(source,ref,kind),true,JSON.stringify({source,target,kind,ref}));
  }
});

check('SQL and application containment agree across mixed scopes and cannot delegate denied records',async f=>{
  const a={id:f.first.id,hubId:f.hub},b={id:f.other.id,hubId:f.otherHub},p={id:f.actors.staff.person,hubId:f.hub},unassigned={id:f.actors.master.person,hubId:null};
  const cases:Scope[]=[{all:true,hubs:[]},{all:false,hubs:[]},{all:false,hubs:[f.hub]},{all:false,hubs:[f.otherHub]},
    {all:true,hubs:[],excludedHubs:[f.hub]},{all:false,hubs:[],classes:[a]},{all:false,hubs:[],classes:[b]},{all:false,hubs:[],people:[p]},
    {all:false,hubs:[],people:[unassigned]},{all:true,hubs:[],excludedClasses:[a]},{all:true,hubs:[],excludedPeople:[p]},
    {all:false,hubs:[f.hub],excludedClasses:[a]},{all:false,hubs:[],classes:[a,b],people:[p,unassigned]},
    {all:true,hubs:[],excludedHubs:[f.hub],excludedClasses:[a]},{all:true,hubs:[],excludedHubs:[f.hub],people:[unassigned]}];
  const pairs=cases.flatMap(source=>cases.map(target=>({source,target,expected:scopeContains(source,target)})));
  const result=await f.pg.query<{pair:{source:Scope;target:Scope;expected:boolean};actual:boolean}>('SELECT value AS pair,public.scope_contains(value->\'source\',value->\'target\') AS actual FROM jsonb_array_elements($1::jsonb)',[JSON.stringify(pairs)]);
  for(const {pair,actual} of result.rows){assert.equal(actual,pair.expected,JSON.stringify(pair));assert.equal(scopeContains(pair.source,pair.source),true);}
  assert.equal(scopeContains({all:true,hubs:[],excludedClasses:[a]},{all:false,hubs:[f.hub]}),false);
  assert.equal(scopeContains({all:false,hubs:[],classes:[a]},{all:false,hubs:[f.hub]}),false);
  assert.equal(scopeContains({all:false,hubs:[f.hub]},{all:false,hubs:[],classes:[a]}),true);
});
check('class-only role sees and edits only selected classes and cannot create or expose other hub data',async f=>{
  const r=await f.role(['classes.view','classes.edit','sessions.request']);
  const assigned=await f.assign(f.actors.staff.person,[{roleId:r.id,allHubs:false,classIds:[f.first.id]}]);assert.equal(assigned.response.status,200);
  const list=await f.request('classes',undefined,'staff');assert.equal(list.response.status,200);assert.deepEqual(list.body.data.map((c:{id:string})=>c.id),[f.first.id]);
  assert.equal((await f.request('classes?hubId='+f.hub,undefined,'staff')).body.data.length,1);
  assert.equal((await f.request('classes?hubId='+f.otherHub,undefined,'staff')).body.data.length,0);
  assert.equal((await f.request('classes/'+f.second.id,undefined,'staff')).response.status,404);
  assert.equal((await f.request('classes/'+f.other.id+'/sessions',undefined,'staff')).response.status,404);
  assert.equal((await f.request('classes/'+f.first.id+'/update',{expectedVersion:1,name:'Authorized class edit'},'staff')).response.status,200);
  assert.equal((await f.request('hubs',undefined,'staff')).response.status,403);assert.equal((await f.request('people',undefined,'staff')).response.status,403);
  const effective=await f.request('me/access',undefined,'staff');assert.deepEqual(effective.body.data.find((x:{capability:string})=>x.capability==='classes.view').scope,{all:false,hubs:[],classes:[{id:f.first.id,hubId:f.hub}]});
});
check('selected-person access filters both list and detail without disclosing neighbouring records',async f=>{
  const r=await f.role(['people.view']);
  assert.equal((await f.assign(f.actors.staff.person,[{roleId:r.id,allHubs:false,personIds:[f.actors.manager.person]}])).response.status,200);
  const list=await f.request('people',undefined,'staff');assert.equal(list.response.status,200);assert.deepEqual(list.body.data.map((p:{id:string})=>p.id),[f.actors.manager.person]);
  assert.equal((await f.request('people/'+f.actors.manager.person,undefined,'staff')).response.status,200);
  assert.equal((await f.request('people/'+f.actors.peer.person,undefined,'staff')).response.status,404);
  assert.equal((await f.request('people/'+f.actors.foreignMaster.person,undefined,'staff')).response.status,404);
  assert.equal((await f.request('people/'+f.actors.manager.person+'?unknown=yes',undefined,'staff')).response.status,400);
});
check('record denials subtract from broad rights and cannot be overridden by an additional allow preset',async f=>{
  const allow=await f.role(['classes.view','people.view']),denyClass=await f.role(['classes.view'],'deny'),denyPerson=await f.role(['people.view'],'deny'),extra=await f.role(['classes.view']);
  assert.equal((await f.assign(f.actors.staff.person,[{roleId:allow.id,allHubs:true},{roleId:denyClass.id,allHubs:false,classIds:[f.first.id]},
    {roleId:denyPerson.id,allHubs:false,personIds:[f.actors.manager.person]},{roleId:extra.id,allHubs:false,classIds:[f.first.id]}])).response.status,200);
  const classes=await f.request('classes',undefined,'staff');assert.equal(classes.body.data.length,2);assert.ok(!classes.body.data.some((r:{id:string})=>r.id===f.first.id));
  assert.equal((await f.request('classes/'+f.first.id,undefined,'staff')).response.status,404);
  const people=await f.request('people',undefined,'staff');assert.ok(!people.body.data.some((p:{id:string})=>p.id===f.actors.manager.person));
});
check('scoped administrators propose exact class assignments but cannot grant another hub or remove hidden access',async f=>{
  const r=await f.role(['classes.view','sessions.request']);
  assert.equal((await f.assign(f.actors.staff.person,[{roleId:r.id,allHubs:false,classIds:[f.other.id]}],'manager')).response.status,403);
  const pending=await f.assign(f.actors.staff.person,[{roleId:r.id,allHubs:false,classIds:[f.first.id]}],'manager');assert.equal(pending.response.status,202);
  assert.equal((await f.approve(pending.body.approval.id)).response.status,200);
  assert.equal((await f.request('classes',undefined,'staff')).body.data.length,1);
  assert.equal((await f.assign(f.actors.staff.person,[{roleId:r.id,allHubs:false,classIds:[f.first.id,f.other.id]}])).response.status,200);
  const visible=await f.request('people/'+f.actors.staff.person+'/access',undefined,'manager');assert.deepEqual(visible.body.data.assignments[0].class_ids,[f.first.id]);
  assert.equal(visible.body.data.partiallyHidden,true);
  assert.equal((await f.assign(f.actors.staff.person,[],'manager')).response.status,403);
});
check('class-scoped human reviewer sees and approves only subordinate cases for the selected class',async f=>{
  const teacher=await f.role(['classes.view','sessions.request']),reviewer=await f.role(['classes.view','classes.edit','approvals.view','approvals.review']);
  assert.equal((await f.assign(f.actors.staff.person,[{roleId:teacher.id,allHubs:false,classIds:[f.first.id,f.second.id]}])).response.status,200);
  assert.equal((await f.assign(f.actors.manager.person,[{roleId:reviewer.id,allHubs:false,classIds:[f.first.id]}])).response.status,200);
  const firstSession=(await f.request('classes/'+f.first.id+'/sessions')).body.data[0],secondSession=(await f.request('classes/'+f.second.id+'/sessions')).body.data[0];
  const first=await f.request('sessions/'+firstSession.id+'/change',{expectedVersion:1,reason:'Teacher unavailable',change:{kind:'cancel'}},'staff');assert.equal(first.response.status,202);
  const second=await f.request('sessions/'+secondSession.id+'/change',{expectedVersion:1,reason:'Teacher unavailable',change:{kind:'cancel'}},'staff');assert.equal(second.response.status,202);
  const list=await f.request('approvals',undefined,'manager');assert.deepEqual(list.body.data.map((p:{id:string})=>p.id),[first.body.approval.id]);
  assert.equal((await f.approve(second.body.approval.id,'manager')).response.status,404);
  assert.equal((await f.approve(first.body.approval.id,'manager')).response.status,200);
});
check('record grants are subject to bot hub ceilings and revocation applies immediately',async f=>{
  const r=await f.role(['classes.view','sessions.request']);
  assert.equal((await f.assign(f.bot,[{roleId:r.id,allHubs:false,classIds:[f.first.id,f.other.id]}])).response.status,200);
  await f.pg.query('UPDATE auth_private.credentials SET all_hubs=false WHERE id=$1',[f.credential]);
  await f.pg.query('INSERT INTO auth_private.credential_hubs(credential_id,academy_id,hub_id) VALUES($1,$2,$3)',[f.credential,f.a,f.hub]);
  assert.deepEqual((await f.request('classes',undefined,'bot')).body.data.map((c:{id:string})=>c.id),[f.first.id]);
  assert.equal((await f.request('classes/'+f.other.id,undefined,'bot')).response.status,404);
  assert.equal((await f.assign(f.bot,[])).response.status,200);assert.equal((await f.request('classes',undefined,'bot')).response.status,403);
});
check('class-only selectors never activate unrelated feature rights and hostile scope data is rejected',async f=>{
  const unsupported=await f.role(['roles.view']);
  assert.equal((await f.assign(f.actors.staff.person,[{roleId:unsupported.id,allHubs:false,classIds:[f.first.id]}])).response.status,400);
  const r=await f.role(['classes.view']);
  for(const item of [{roleId:r.id,allHubs:true,classIds:[f.first.id]},{roleId:r.id,allHubs:false,classIds:[f.first.id,f.first.id]},
    {roleId:r.id,allHubs:false,classIds:[randomUUID()]},{roleId:r.id,allHubs:false,classIds:[f.first.id],hubId:f.otherHub},
    {roleId:r.id,allHubs:false,classIds:[f.first.id],classRefs:[{id:f.first.id,hubId:f.otherHub}]}])
    assert.equal((await f.assign(f.actors.staff.person,[item])).response.status,400);
  const caps=await f.request('capabilities');assert.deepEqual(caps.body.data.find((c:{name:string})=>c.name==='classes.view').scope_kinds,['hub','class']);
});
check('record-selector tables enforce tenant foreign keys, RLS and cleanup on access replacement',async f=>{
  const r=await f.role(['classes.view','people.view']);
  assert.equal((await f.assign(f.actors.staff.person,[{roleId:r.id,allHubs:false,classIds:[f.first.id],personIds:[f.actors.manager.person]}])).response.status,200);
  const assignment=(await f.request('people/'+f.actors.staff.person+'/access')).body.data.assignments[0].id;
  await assert.rejects(f.pg.query('INSERT INTO public.assignment_people VALUES($1,$2,$3)',[f.a,assignment,f.actors.foreignMaster.person]),/foreign key/);
  const foreignRequest=(path:string,body:unknown)=>f.request(path,body,'foreignMaster',{academy:f.b});
  const country=await foreignRequest('locations/countries',{code:'CA',name:'Canada'});assert.equal(country.response.status,201);
  const region=await foreignRequest('locations/regions',{countryId:country.body.data.id,code:'ON',name:'Ontario'});assert.equal(region.response.status,201);
  const city=await foreignRequest('locations/cities',{regionId:region.body.data.id,name:'Toronto'});assert.equal(city.response.status,201);
  assert.equal((await foreignRequest('hubs/'+f.foreignHub+'/update',{expectedVersion:1,cityId:city.body.data.id,timeZone:'America/Toronto',currency:'CAD'})).response.status,200);
  const course=await foreignRequest('courses',{code:'FOREIGN',name:'Foreign academy curriculum'});assert.equal(course.response.status,201);
  const foreign=await foreignRequest('classes',{hubId:f.foreignHub,courseId:course.body.data.id,courseVersion:1,name:'Foreign academy class',mode:'in_person',
    schedule:{oneOff:[{start:'2027-01-01T10:00',end:'2027-01-01T11:00'}]}});assert.equal(foreign.response.status,201);
  await assert.rejects(f.pg.query('INSERT INTO public.assignment_classes VALUES($1,$2,$3)',[f.a,assignment,foreign.body.data.id]),/foreign key/);
  assert.equal((await f.assign(f.actors.staff.person,[{roleId:r.id,allHubs:false,classIds:[foreign.body.data.id]}])).response.status,400);
  await f.pg.exec('SET ROLE kavosh_runtime');
  try {
    await f.pg.query("SELECT set_config('app.academy_id',$1,false)",[f.a]);
    await assert.rejects(f.pg.query('INSERT INTO public.assignment_classes VALUES($1,$2,$3)',[f.b,assignment,f.first.id]),/row-level security/);
    assert.equal((await f.pg.query('SELECT * FROM public.assignment_people WHERE academy_id=$1',[f.b])).rows.length,0);
  }finally{await f.pg.exec('RESET ROLE');}
  assert.equal((await f.assign(f.actors.staff.person,[])).response.status,200);
  for(const table of ['assignment_classes','assignment_people'])assert.equal((await f.pg.query('SELECT * FROM public.'+table+' WHERE assignment_id=$1',[assignment])).rows.length,0);
});
check('master preset editing handles 5,000 assigned people without per-recipient authorization queries',async f=>{
  const r=await f.role(['people.view']);
  await f.pg.query(`INSERT INTO public.people(academy_id,id,kind,name,hub_id) SELECT $1,gen_random_uuid(),'human','Synthetic bulk recipient',$2 FROM generate_series(1,5000)`,[f.a,f.hub]);
  await f.pg.query("INSERT INTO public.role_assignments SELECT $1,gen_random_uuid(),id,$2,true FROM public.people WHERE academy_id=$1 AND name='Synthetic bulk recipient'",[f.a,r.id]);
  const beforeQueries=f.metrics.businessQueries;
  const changed=await f.request('roles/'+r.id+'/update',{expectedVersion:1,name:r.name,permissions:[{capability:'people.view',effect:'allow'},{capability:'classes.view',effect:'allow'}]});
  assert.equal(changed.response.status,200);assert.equal(changed.body.data.version,2);
  assert.ok(f.metrics.businessQueries-beforeQueries<60,'query count must be bounded independently of 5000 recipients');
  const review=await f.request('approvals/'+changed.body.approval.id);assert.equal(review.body.data.reviewContext.affected.length,5000);
});
check('a scoped denial cannot be delegated away through a broad new assignment, while an unrelated class stays delegable',async f=>{
  const deny=await f.role(['classes.view'],'deny'),view=await f.role(['classes.view']);
  assert.equal((await f.assign(f.actors.manager.person,[{roleId:f.managerRole,allHubs:false,hubIds:[f.hub]},
    {roleId:f.policyRole,allHubs:true},{roleId:deny.id,allHubs:false,classIds:[f.first.id]}])).response.status,200);
  assert.equal((await f.assign(f.actors.staff.person,[{roleId:view.id,allHubs:false,hubIds:[f.hub]}],'manager')).response.status,403);
  const pending=await f.assign(f.actors.staff.person,[{roleId:view.id,allHubs:false,classIds:[f.second.id]}],'manager');assert.equal(pending.response.status,202);
  assert.equal((await f.approve(pending.body.approval.id)).response.status,200);
  assert.deepEqual((await f.request('classes',undefined,'staff')).body.data.map((c:{id:string})=>c.id),[f.second.id]);
  const bounded=await f.assign(f.actors.staff.person,[{roleId:view.id,allHubs:false,hubIds:[f.hub]},{roleId:deny.id,allHubs:false,classIds:[f.first.id]}],'manager');assert.equal(bounded.response.status,202);
  assert.equal((await f.approve(bounded.body.approval.id)).response.status,200);
  assert.deepEqual((await f.request('classes',undefined,'staff')).body.data.map((c:{id:string})=>c.id),[f.second.id]);
});
check('changing a requester selected class invalidates an unexecuted session approval',async f=>{
  const r=await f.role(['classes.view','sessions.request']);
  assert.equal((await f.assign(f.actors.staff.person,[{roleId:r.id,allHubs:false,classIds:[f.first.id]}])).response.status,200);
  const session=(await f.request('classes/'+f.first.id+'/sessions')).body.data[0];
  const pending=await f.request('sessions/'+session.id+'/change',{expectedVersion:1,reason:'Teacher request',change:{kind:'cancel'}},'staff');assert.equal(pending.response.status,202);
  assert.equal((await f.assign(f.actors.staff.person,[{roleId:r.id,allHubs:false,classIds:[f.second.id]}])).response.status,200);
  const result=await f.approve(pending.body.approval.id);assert.equal(result.response.status,409);assert.equal(result.body.approval.status,'stale');
  assert.equal((await f.request('sessions/'+session.id)).body.data.status,'scheduled');
});
