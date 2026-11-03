import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { operationsFixture } from './operations-fixture.ts';
import { areaContains,scopeContains,type Scope,type AreaRef,type Capability } from '../src/core/policy.ts';

async function fixture() {
  const f=await operationsFixture();
  async function create(path:string,input:unknown) {const result=await f.request(path,input);assert.equal(result.response.status,201,JSON.stringify(result.body));return result.body.data;}
  const ca=await create('locations/countries',{code:'CA',name:'Canada'}),us=await create('locations/countries',{code:'US',name:'United States'});
  const on=await create('locations/regions',{countryId:ca.id,code:'ON',name:'Ontario'}),bc=await create('locations/regions',{countryId:ca.id,code:'BC',name:'British Columbia'}),ny=await create('locations/regions',{countryId:us.id,code:'NY',name:'New York'});
  const toronto=await create('locations/cities',{regionId:on.id,name:'Toronto'}),ottawa=await create('locations/cities',{regionId:on.id,name:'Ottawa'}),vancouver=await create('locations/cities',{regionId:bc.id,name:'Vancouver'}),newYork=await create('locations/cities',{regionId:ny.id,name:'New York City'});
  for(const [id,city] of [[f.hub,toronto],[f.otherHub,vancouver]])assert.equal((await f.request('hubs/'+id+'/update',{expectedVersion:1,cityId:city.id,timeZone:'America/Toronto',currency:'CAD'})).response.status,200);
  const hubInput=(cityId:string)=>({name:'Configured area hub',cityId,timeZone:'America/Toronto',currency:'CAD'});
  const ottawaHub=await create('hubs',hubInput(ottawa.id)),usHub=await create('hubs',hubInput(newYork.id));
  async function role(caps:Capability[],effect='allow'){return create('roles',{name:'Geographic preset '+randomUUID(),permissions:caps.map(capability=>({capability,effect}))});}
  async function assign(person:string,assignments:unknown[],as='master') {
    const current=await f.request('people/'+person+'/access');assert.equal(current.response.status,200);
    return f.request('people/'+person+'/access',{expectedVersion:current.body.data.version,assignments},as);
  }
  const refs=(await f.pg.query<{ref:AreaRef}>('SELECT ref FROM public.geographic_areas WHERE academy_id=$1 ORDER BY kind,id',[f.a])).rows.map(r=>r.ref);
  return {...f,ca,us,on,bc,ny,toronto,ottawa,vancouver,newYork,ottawaHub,usHub,hubInput,role,assign,create,refs};
}
type Fixture=Awaited<ReturnType<typeof fixture>>;
function check(name:string,run:(f:Fixture)=>Promise<void>){test(name,async()=>{const f=await fixture();try{await run(f);}finally{await f.pg.close();}});}

check('country, province and city scopes filter records and include newly created hubs only within the selected hierarchy',async f=>{
  const r=await f.role(['hubs.view','locations.view','people.view']);
  assert.equal((await f.assign(f.actors.staff.person,[{roleId:r.id,allHubs:false,countryIds:[f.ca.id]}])).response.status,200);
  assert.equal((await f.request('hubs',undefined,'staff')).body.data.length,3);
  assert.equal((await f.request('locations/countries',undefined,'staff')).body.data.length,1);
  const newHub=await f.create('hubs',f.hubInput(f.toronto.id));
  assert.ok((await f.request('hubs',undefined,'staff')).body.data.some((h:{id:string})=>h.id===newHub.id));
  assert.equal((await f.assign(f.actors.staff.person,[{roleId:r.id,allHubs:false,regionIds:[f.on.id]}])).response.status,200);
  assert.equal((await f.request('hubs',undefined,'staff')).body.data.length,3);
  assert.equal((await f.request('locations/regions',undefined,'staff')).body.data.length,1);
  assert.equal((await f.assign(f.actors.staff.person,[{roleId:r.id,allHubs:false,cityIds:[f.ottawa.id]}])).response.status,200);
  assert.deepEqual((await f.request('hubs',undefined,'staff')).body.data.map((h:{id:string})=>h.id),[f.ottawaHub.id]);
  assert.equal((await f.request('locations/cities',undefined,'staff')).body.data.length,1);
  assert.equal((await f.request('locations/cities/'+f.toronto.id,undefined,'staff')).response.status,404);
  assert.equal((await f.request('locations/countries/'+f.ca.id,undefined,'staff')).response.status,200,'a selected city may expose its ancestor label');
});
check('empty geographic selections remain useful and new hubs do not require reconfiguring the role',async f=>{
  const empty=await f.create('locations/cities',{regionId:f.on.id,name:'Empty future city'}),r=await f.role(['hubs.view','hubs.edit','locations.view']);
  assert.equal((await f.assign(f.actors.staff.person,[{roleId:r.id,allHubs:false,cityIds:[empty.id]}])).response.status,200);
  assert.equal((await f.request('hubs',undefined,'staff')).body.data.length,0);
  assert.equal((await f.request('locations/cities',undefined,'staff')).body.data[0].id,empty.id);
  const own=await f.request('hubs',f.hubInput(empty.id),'staff');assert.equal(own.response.status,201,JSON.stringify(own.body));
  assert.equal((await f.request('hubs',f.hubInput(f.toronto.id),'staff')).response.status,403);
  assert.equal((await f.request('hubs/'+own.body.data.id+'/update',{expectedVersion:1,cityId:f.toronto.id},'staff')).response.status,403,'geographic editors cannot transfer a hub outside their area');
  assert.equal((await f.request('hubs/'+own.body.data.id+'/update',{expectedVersion:1,contactPhone:'+1 555 000 0000'},'staff')).response.status,200);
});
check('geographic denials override broad and explicit hub rights and safely hide ambiguous legacy addresses',async f=>{
  const allow=await f.role(['hubs.view','locations.view']),deny=await f.role(['hubs.view','locations.view'],'deny'),extra=await f.role(['hubs.view']);
  const legacy=await f.create('hubs',{name:'Incomplete legacy address',city:'Toronto',countryCode:'CA'});
  assert.equal((await f.assign(f.actors.staff.person,[{roleId:allow.id,allHubs:true},{roleId:deny.id,allHubs:false,regionIds:[f.on.id]},
    {roleId:extra.id,allHubs:false,hubIds:[f.hub]}])).response.status,200);
  const visible=await f.request('hubs',undefined,'staff');assert.equal(visible.body.data.length,2);
  assert.ok(!visible.body.data.some((h:{id:string})=>h.id===legacy.id||h.id===f.hub));
  assert.equal((await f.request('locations/regions/'+f.on.id,undefined,'staff')).response.status,404);
  assert.equal((await f.request('locations/cities/'+f.toronto.id,undefined,'staff')).response.status,404);
  const future=await f.create('hubs',f.hubInput(f.toronto.id));assert.ok(!(await f.request('hubs',undefined,'staff')).body.data.some((h:{id:string})=>h.id===future.id));
});
check('geographic grants constrain courses, classes and people through their actual hubs',async f=>{
  const r=await f.role(['hubs.view','people.view','courses.view','classes.view']),course=await f.create('courses',{code:'GEO',name:'Geographic curriculum'});
  const classes=[];
  for(const hubId of [f.hub,f.otherHub,f.usHub.id])classes.push(await f.create('classes',{hubId,courseId:course.id,courseVersion:1,name:'Area class',mode:'in_person',schedule:{oneOff:[{start:'2027-01-01T10:00',end:'2027-01-01T11:00'}]}}));
  assert.equal((await f.assign(f.actors.staff.person,[{roleId:r.id,allHubs:false,regionIds:[f.on.id]}])).response.status,200);
  assert.deepEqual((await f.request('classes',undefined,'staff')).body.data.map((c:{id:string})=>c.id),[classes[0].id]);
  assert.equal((await f.request('classes/'+classes[1].id+'/sessions',undefined,'staff')).response.status,404);
  assert.ok(!(await f.request('people',undefined,'staff')).body.data.some((p:{id:string})=>p.id===f.actors.peer.person));
  assert.equal((await f.request('courses',undefined,'staff')).body.data.length,1,'shared curriculum is visible without granting another hub');
});
check('finite hub authority cannot become a dynamic geographic grant even when all present hubs match',async f=>{
  const view=await f.role(['hubs.view']);
  assert.equal((await f.assign(f.actors.staff.person,[{roleId:view.id,allHubs:false,cityIds:[f.toronto.id]}],'manager')).response.status,403);
  const geographic=await f.role(['hubs.view','people.view','access.edit','access.view','approvals.view','approvals.review']);
  assert.equal((await f.assign(f.actors.manager.person,[{roleId:geographic.id,allHubs:false,countryIds:[f.ca.id]}])).response.status,200);
  const pending=await f.assign(f.actors.staff.person,[{roleId:view.id,allHubs:false,cityIds:[f.toronto.id]}],'manager');assert.equal(pending.response.status,202);
  assert.equal((await f.approve(pending.body.approval.id)).response.status,200);
  const future=await f.create('hubs',f.hubInput(f.toronto.id));assert.ok((await f.request('hubs',undefined,'staff')).body.data.some((h:{id:string})=>h.id===future.id));
});
check('dynamic delegation preserves geographic exclusions rather than discarding them',async f=>{
  const allow=await f.role(['hubs.view','people.view','access.edit','access.view']),deny=await f.role(['hubs.view'],'deny'),view=await f.role(['hubs.view']);
  assert.equal((await f.assign(f.actors.manager.person,[{roleId:allow.id,allHubs:false,countryIds:[f.ca.id]},{roleId:deny.id,allHubs:false,cityIds:[f.toronto.id]}])).response.status,200);
  assert.equal((await f.assign(f.actors.staff.person,[{roleId:view.id,allHubs:false,cityIds:[f.ottawa.id]}],'manager')).response.status,403,'an inherited exclusion cannot silently disappear');
  const pending=await f.assign(f.actors.staff.person,[{roleId:view.id,allHubs:false,cityIds:[f.ottawa.id]},{roleId:deny.id,allHubs:false,cityIds:[f.toronto.id]}],'manager');assert.equal(pending.response.status,202);
  assert.equal((await f.approve(pending.body.approval.id)).response.status,200);
  assert.deepEqual((await f.request('hubs',undefined,'staff')).body.data.map((h:{id:string})=>h.id),[f.ottawaHub.id]);
});
check('fixed hub denials remain mandatory when delegating an empty area that could later receive that hub',async f=>{
  const empty=await f.create('locations/cities',{regionId:f.on.id,name:'Future transfer city'}),allow=await f.role(['hubs.view','access.edit','access.view','people.view']),deny=await f.role(['hubs.view'],'deny'),view=await f.role(['hubs.view']);
  assert.equal((await f.assign(f.actors.manager.person,[{roleId:allow.id,allHubs:false,countryIds:[f.ca.id]},{roleId:deny.id,allHubs:false,hubIds:[f.hub]}])).response.status,200);
  assert.equal((await f.assign(f.actors.staff.person,[{roleId:view.id,allHubs:false,cityIds:[empty.id]}],'manager')).response.status,403);
  const pending=await f.assign(f.actors.staff.person,[{roleId:view.id,allHubs:false,cityIds:[empty.id]},{roleId:deny.id,allHubs:false,hubIds:[f.hub]}],'manager');assert.equal(pending.response.status,202);
  assert.equal((await f.approve(pending.body.approval.id)).response.status,200);
  assert.equal((await f.request('hubs/'+f.hub+'/update',{expectedVersion:2,cityId:empty.id})).response.status,200);
  assert.equal((await f.request('hubs',undefined,'staff')).body.data.length,0);
});
check('bot ceilings prevent future geographic expansion and omit out-of-ceiling geographic metadata',async f=>{
  const r=await f.role(['hubs.view']);assert.equal((await f.assign(f.bot,[{roleId:r.id,allHubs:false,countryIds:[f.ca.id]}])).response.status,200);
  await f.pg.query('UPDATE auth_private.credentials SET all_hubs=false WHERE id=$1',[f.credential]);
  await f.pg.query('INSERT INTO auth_private.credential_hubs VALUES($1,$2,$3)',[f.credential,f.a,f.hub]);
  const future=await f.create('hubs',f.hubInput(f.toronto.id));
  assert.deepEqual((await f.request('hubs',undefined,'bot')).body.data.map((h:{id:string})=>h.id),[f.hub]);
  const access=await f.request('me/access',undefined,'bot');const scoped=access.body.data.find((p:{capability:string})=>p.capability==='hubs.view').scope;
  assert.equal(scoped.areas,undefined);assert.ok(!scoped.hubs.includes(future.id));
});
check('geographic hierarchy changes invalidate pending delegation and visibility follows the new saved parent',async f=>{
  const manage=await f.role(['hubs.view','access.edit','access.view','people.view']),view=await f.role(['hubs.view']);
  assert.equal((await f.assign(f.actors.manager.person,[{roleId:manage.id,allHubs:false,countryIds:[f.ca.id]}])).response.status,200);
  const pending=await f.assign(f.actors.staff.person,[{roleId:view.id,allHubs:false,cityIds:[f.toronto.id]}],'manager');assert.equal(pending.response.status,202);
  assert.equal((await f.request('locations/cities/'+f.toronto.id+'/update',{expectedVersion:1,regionId:f.ny.id})).response.status,200);
  assert.ok(!(await f.request('hubs',undefined,'manager')).body.data.some((h:{id:string})=>h.id===f.hub));
  const result=await f.approve(pending.body.approval.id);assert.equal(result.response.status,409);assert.equal(result.body.approval.status,'stale');
});
check('limited assignment viewers cannot see or remove hidden dynamic scopes',async f=>{
  const view=await f.role(['hubs.view']);assert.equal((await f.assign(f.actors.staff.person,[{roleId:view.id,allHubs:false,countryIds:[f.ca.id]}])).response.status,200);
  const local=await f.request('people/'+f.actors.staff.person+'/access',undefined,'manager');assert.equal(local.response.status,200);
  assert.deepEqual(local.body.data.assignments[0].country_ids,[]);assert.deepEqual(local.body.data.assignments[0].hub_ids,[f.hub]);
  assert.equal((await f.assign(f.actors.staff.person,[],'manager')).response.status,403);
});
check('geographic IDs and invoker views retain tenant boundaries and only compatible scope kinds activate rights',async f=>{
  const view=await f.role(['hubs.view']),global=await f.role(['roles.view']);
  assert.equal((await f.assign(f.actors.staff.person,[{roleId:global.id,allHubs:false,countryIds:[f.ca.id]}])).response.status,400);
  assert.equal((await f.assign(f.actors.staff.person,[{roleId:view.id,allHubs:false,countryIds:[randomUUID()]}])).response.status,400);
  assert.equal((await f.assign(f.actors.staff.person,[{roleId:view.id,allHubs:false,regionIds:[f.ca.id]}])).response.status,400);
  const wrong=await f.request('locations/countries',{code:'CN',name:'Foreign country'},'foreignMaster',{academy:f.b});assert.equal(wrong.response.status,201);
  assert.equal((await f.assign(f.actors.staff.person,[{roleId:view.id,allHubs:false,countryIds:[wrong.body.data.id]}])).response.status,400);
  const foreignRegion=await f.request('locations/regions',{countryId:wrong.body.data.id,code:'BJ',name:'Foreign region'},'foreignMaster',{academy:f.b});assert.equal(foreignRegion.response.status,201);
  const foreignCity=await f.request('locations/cities',{regionId:foreignRegion.body.data.id,name:'Foreign city'},'foreignMaster',{academy:f.b});assert.equal(foreignCity.response.status,201);
  const assignment=(await f.pg.query<{id:string}>('SELECT id FROM public.role_assignments WHERE academy_id=$1 AND person_id=$2',[f.a,f.actors.staff.person])).rows[0].id;
  for(const [table,column,foreign] of [['assignment_countries','country_id',wrong.body.data.id],['assignment_regions','region_id',foreignRegion.body.data.id],['assignment_cities','city_id',foreignCity.body.data.id]])
    await assert.rejects(f.pg.query(`INSERT INTO public.${table}(academy_id,assignment_id,${column}) VALUES($1,$2,$3)`,[f.a,assignment,foreign]),/foreign key/i);
  await f.pg.exec('SET ROLE kavosh_runtime');
  try{await f.pg.query("SELECT set_config('app.academy_id',$1,false)",[f.a]);
    assert.equal((await f.pg.query('SELECT * FROM public.geographic_areas WHERE academy_id=$1',[f.b])).rows.length,0);
    assert.equal((await f.pg.query('SELECT * FROM public.hub_geography WHERE academy_id=$1',[f.b])).rows.length,0);
  }finally{await f.pg.exec('RESET ROLE');}
});
check('geographic containment agrees in SQL and application including empty areas and inherited guards',async f=>{
  const country=f.refs.find(r=>r.id===f.ca.id)!,region=f.refs.find(r=>r.id===f.on.id)!,city=f.refs.find(r=>r.id===f.toronto.id)!;
  assert.equal(areaContains(country,city),true);assert.equal(areaContains(region,city),true);assert.equal(areaContains(city,region),false);
  const cases:Scope[]=[{all:true,hubs:[]},{all:false,hubs:[]},{all:false,hubs:[f.hub]},
    {all:false,hubs:[],areas:[country]},{all:false,hubs:[],areas:[region]},{all:false,hubs:[],areas:[city]},
    {all:true,hubs:[],excludedAreas:[city]},{all:false,hubs:[],areas:[country],excludedAreas:[city]},
    {all:false,hubs:[],areas:[region],excludedAreas:[city]},{all:false,hubs:[],areas:[city],excludedHubs:[f.hub]},
    {all:false,hubs:[],areas:[country],excludedHubs:[f.hub]},{all:false,hubs:[],areas:[country],excludedClasses:[{id:randomUUID(),hubId:f.hub}]}];
  const pairs=cases.flatMap(source=>cases.map(target=>({source,target,expected:scopeContains(source,target)})));
  const rows=(await f.pg.query<{pair:{expected:boolean};actual:boolean}>(`SELECT value AS pair,public.scope_contains(value->'source',value->'target') AS actual FROM jsonb_array_elements($1::jsonb)`,[JSON.stringify(pairs)])).rows;
  for(const row of rows)assert.equal(row.actual,row.pair.expected,JSON.stringify(row));
});

if(process.env.TEST_DATABASE_URL) {
  async function waitForTopologyReader(f:Fixture) {
    for(let attempt=0;attempt<100;attempt++) {
      // The lock-holder transaction otherwise keeps its first activity snapshot.
      // https://www.postgresql.org/docs/17/monitoring-stats.html
      await f.pg.query('SELECT pg_stat_clear_snapshot()');
      const row=(await f.pg.query<{count:number}>(`SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'
        AND query LIKE '%pg_advisory_xact_lock_shared%' AND query LIKE '%hashtextextended%9)%'`)).rows[0];
      if(row.count>0)return;
      await new Promise(resolve=>setTimeout(resolve,5));
    }
    assert.fail('request did not reach the verified topology-lock wait');
  }
  check('a waiting geographic read expands permissions only after the concurrent hub move commits',async f=>{
    const view=await f.role(['hubs.view']);assert.equal((await f.assign(f.actors.staff.person,[{roleId:view.id,allHubs:false,countryIds:[f.ca.id]}])).response.status,200);
    await f.pg.exec('BEGIN');let open=true;
    await f.pg.query('SELECT pg_advisory_xact_lock(hashtextextended($1,9))',[f.a]);
    const pending=f.request('hubs',undefined,'staff');
    try {
      await waitForTopologyReader(f);await f.pg.query('UPDATE public.hubs SET city_id=$2 WHERE id=$1',[f.hub,f.newYork.id]);
      await f.pg.exec('COMMIT');open=false;
      const result=await pending;assert.equal(result.response.status,200);assert.ok(!result.body.data.some((h:{id:string})=>h.id===f.hub));
    }finally{if(open)await f.pg.exec('ROLLBACK');await pending;}
  });
  check('a waiting geographic writer refreshes its grants after acquiring the topology lock',async f=>{
    const editor=await f.role(['classes.edit','classes.view','courses.view']);assert.equal((await f.assign(f.actors.staff.person,[{roleId:editor.id,allHubs:false,countryIds:[f.ca.id]}])).response.status,200);
    const course=await f.create('courses',{code:'CONCURRENT',name:'Concurrent curriculum'});
    await f.pg.exec('BEGIN');let open=true;
    await f.pg.query('SELECT pg_advisory_xact_lock(hashtextextended($1,9))',[f.a]);
    const pending=f.request('classes',{hubId:f.hub,courseId:course.id,courseVersion:1,name:'Must not be created outside scope',mode:'in_person',
      schedule:{oneOff:[{start:'2027-01-01T10:00',end:'2027-01-01T11:00'}]}},'staff');
    try {
      await waitForTopologyReader(f);await f.pg.query('UPDATE public.hubs SET city_id=$2 WHERE id=$1',[f.hub,f.newYork.id]);
      await f.pg.exec('COMMIT');open=false;
      const result=await pending;assert.equal(result.response.status,403);assert.equal((await f.pg.query('SELECT * FROM public.classes')).rows.length,0);
    }finally{if(open)await f.pg.exec('ROLLBACK');await pending;}
  });
  for(const preview of [false,true])check(`a waiting ${preview?'calendar preview':'person creation'} cannot use geography from before a hub move`,async f=>{
    const r=await f.role(['hubs.view','people.edit']);assert.equal((await f.assign(f.actors.staff.person,[{roleId:r.id,allHubs:false,countryIds:[f.ca.id]}])).response.status,200);
    await f.pg.exec('BEGIN');let open=true;
    await f.pg.query('SELECT pg_advisory_xact_lock(hashtextextended($1,9))',[f.a]);
    const pending=f.request(preview?'calendar/preview':'people',preview?{hubId:f.hub,schedule:{oneOff:[{start:'2027-01-01T10:00',end:'2027-01-01T11:00'}]}}:{hubId:f.hub,name:'Must not be created'},'staff');
    try {
      await waitForTopologyReader(f);await f.pg.query('UPDATE public.hubs SET city_id=$2 WHERE id=$1',[f.hub,f.newYork.id]);
      await f.pg.exec('COMMIT');open=false;
      const result=await pending;assert.equal(result.response.status,403,JSON.stringify(result.body));
      assert.equal((await f.pg.query("SELECT * FROM public.people WHERE name='Must not be created'")).rows.length,0);
    }finally{if(open)await f.pg.exec('ROLLBACK');await pending;}
  });
}
