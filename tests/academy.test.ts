import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { operationsFixture } from './operations-fixture.ts';

async function fixture() {
  const f=await operationsFixture();
  for(const cap of ['locations.view','courses.view','courses.edit'])await f.pg.query("INSERT INTO public.role_permissions VALUES($1,$2,$3,'allow')",[f.a,f.managerRole,cap]);
  async function location(countryCode='CA',regionCode='ON',cityName='Toronto') {
    const country=await f.request('locations/countries',{code:countryCode,name:countryCode==='CA'?'Canada':'Synthetic country',translations:{fr:'Pays', 'zh-CN':'国家'}});
    assert.equal(country.response.status,201,'country creation');
    const region=await f.request('locations/regions',{countryId:country.body.data.id,code:regionCode,name:regionCode==='ON'?'Ontario':'Synthetic region'});
    assert.equal(region.response.status,201,'region creation');
    const city=await f.request('locations/cities',{regionId:region.body.data.id,name:cityName});assert.equal(city.response.status,201,'city creation');
    return {country:country.body.data,region:region.body.data,city:city.body.data};
  }
  function hubInput(cityId:string) {return {name:'Configured hub',cityId,timeZone:'America/Toronto',currency:'CAD',contactEmail:'hub@example.test',contactPhone:'+1 647 555 0100 ext 2',
    website:'https://example.test/hub',address:{line1:'Synthetic address',line2:'Unit 2',postalCode:'A1A 1A1'},coordinates:{latitude:0,longitude:0},translations:{fr:'Centre', 'zh-CN':'教学中心'}};}
  const courseInput={code:'ROB-101',name:'Robotics foundations',description:'Synthetic curriculum',translations:{fr:'Robotique','zh-CN':'机器人'},
    modules:[{code:'M01',title:'Sensors',summary:'Read a distance sensor'},{code:'M02',title:'Motors',summary:'Build and test a drive'}]};
  return {...f,location,hubInput,courseInput};
}
type Fixture=Awaited<ReturnType<typeof fixture>>;
function check(name:string,run:(f:Fixture)=>Promise<void>) {test(name,async()=>{const f=await fixture();try{await run(f);}finally{await f.pg.close();}});}

check('editable country/region/city hierarchy persists, filters and rejects invalid parent relations',async f=>{
  const data=await f.location();
  assert.equal((await f.request('locations/countries')).body.data.length,1);
  assert.equal((await f.request('locations/regions?countryId='+data.country.id)).body.data[0].id,data.region.id);
  assert.equal((await f.request('locations/cities?regionId='+data.region.id+'&q=ront')).body.data[0].id,data.city.id);
  assert.equal((await f.request('locations/cities?countryId='+randomUUID())).body.data.length,0);
  assert.equal((await f.request('locations/regions',{countryId:randomUUID(),code:'BAD',name:'Invalid'})).response.status,400);
  assert.equal((await f.request('locations/countries',{code:'CA',name:'Duplicate'})).response.status,409);
  assert.equal((await f.request('locations/cities',{regionId:data.region.id,name:'toronto'})).response.status,409,'case-insensitive city duplicate');
  assert.equal((await f.request('locations/countries',{code:'US',name:'Forbidden'},'manager')).response.status,403);
});
check('geographic patches preserve unmentioned state and locale values with explicit locale removal',async f=>{
  const country=await f.request('locations/countries',{code:'DE',name:'Original name',active:false,translations:{fr:'Français','zh-CN':'中文'}});
  const id=country.body.data.id;
  const changed=await f.request('locations/countries/'+id+'/update',{expectedVersion:1,name:'Updated name',translations:{en:'English'}});
  assert.equal(changed.response.status,200);assert.equal(changed.body.data.active,false);
  assert.deepEqual(changed.body.data.translations,{fr:'Français','zh-CN':'中文',en:'English'});
  const removed=await f.request('locations/countries/'+id+'/update',{expectedVersion:2,translations:{fr:null}});
  assert.equal(removed.response.status,200);assert.deepEqual(removed.body.data.translations,{'zh-CN':'中文',en:'English'});
  assert.equal((await f.request('locations/countries/'+id+'/update',{expectedVersion:1,name:'Stale edit'})).response.status,409);
  assert.equal((await f.request('locations/countries/'+id+'/update',{expectedVersion:3})).response.status,400,'empty patch rejected');
});
check('active descendants prevent location archival and inactive parents cannot acquire active descendants',async f=>{
  const data=await f.location();
  assert.equal((await f.request('locations/countries/'+data.country.id+'/update',{expectedVersion:1,active:false})).response.status,409);
  assert.equal((await f.request('locations/regions/'+data.region.id+'/update',{expectedVersion:1,active:false})).response.status,409);
  const created=await f.request('hubs',f.hubInput(data.city.id));assert.equal(created.response.status,201);
  assert.equal((await f.request('locations/cities/'+data.city.id+'/update',{expectedVersion:1,active:false})).response.status,409);
  assert.equal((await f.request('hubs/'+created.body.data.id+'/update',{expectedVersion:1,active:false})).response.status,200);
  assert.equal((await f.request('locations/cities/'+data.city.id+'/update',{expectedVersion:1,active:false})).response.status,200);
  assert.equal((await f.request('hubs',f.hubInput(data.city.id))).response.status,400);
  assert.equal((await f.request('locations/regions/'+data.region.id+'/update',{expectedVersion:1,active:false})).response.status,200);
  assert.equal((await f.request('locations/cities',{regionId:data.region.id,name:'Not active yet',active:true})).response.status,400);
  const archived=await f.request('locations/cities/'+data.city.id+'/update',{expectedVersion:2,name:'Historical city'});
  assert.equal(archived.response.status,200);assert.equal(archived.body.data.active,false);
});
check('hub profile derives location, retains zero coordinates and preserves address/settings on partial updates',async f=>{
  const data=await f.location();
  const created=await f.request('hubs',f.hubInput(data.city.id));assert.equal(created.response.status,201);
  const h=created.body.data;assert.equal(h.city,'Toronto');assert.equal(h.country_code,'CA');assert.equal(h.setup_complete,true);
  assert.equal(h.latitude,0);assert.equal(h.longitude,0);assert.equal(h.time_zone,'America/Toronto');assert.equal(h.currency,'CAD');
  const updated=await f.request('hubs/'+h.id+'/update',{expectedVersion:1,name:'Friendly new hub name',address:{line1:'Updated address'},translations:{en:'Main hub'}});
  assert.equal(updated.response.status,200);assert.deepEqual(updated.body.data.address,{line1:'Updated address',line2:'Unit 2',postalCode:'A1A 1A1'});
  assert.equal(updated.body.data.contact_email,'hub@example.test');assert.equal(updated.body.data.latitude,0);assert.equal(updated.body.data.currency,'CAD');
  assert.deepEqual(updated.body.data.translations,{en:'Main hub',fr:'Centre','zh-CN':'教学中心'});
  assert.equal((await f.request('hubs/'+h.id+'/update',{expectedVersion:1,name:'Stale'})).response.status,409);
  assert.equal((await f.request('hubs/'+h.id+'/update',{expectedVersion:2,city:'Different derived city'})).response.status,400);
  const renamed=await f.request('locations/cities/'+data.city.id+'/update',{expectedVersion:1,name:'Toronto North'});assert.equal(renamed.response.status,200);
  assert.equal((await f.request('hubs/'+h.id)).body.data.city,'Toronto North');
});
check('legacy hub input remains usable without inventing missing geography, time zone or currency',async f=>{
  const legacy=await f.request('hubs',{name:'Legacy import',city:'Reported city',countryCode:'CA'});assert.equal(legacy.response.status,201);
  assert.equal(legacy.body.data.setup_complete,false);assert.equal(legacy.body.data.city_id,null);assert.equal(legacy.body.data.time_zone,null);assert.equal(legacy.body.data.currency,null);
  const data=await f.location();
  const configured=await f.request('hubs/'+legacy.body.data.id+'/update',{expectedVersion:1,cityId:data.city.id,timeZone:'America/Toronto',currency:'CAD'});
  assert.equal(configured.response.status,200);assert.equal(configured.body.data.setup_complete,true);assert.equal(configured.body.data.name,'Legacy import');
});
check('hub input rejects invalid time zones, currencies, coordinates, URLs, unknown fields and media-side injection',async f=>{
  const data=await f.location(),input=f.hubInput(data.city.id);
  for(const patch of [{timeZone:'Not/AZone'},{currency:'NOTREAL'},{coordinates:{latitude:91,longitude:0}},{coordinates:{latitude:0}},
    {website:'javascript:alert(1)'},{website:'https://user:password@example.test/'},{logo_file_id:randomUUID()},{academy_id:f.b}])
    assert.equal((await f.request('hubs',{...input,...patch})).response.status,400);
  assert.equal((await f.pg.query("SELECT * FROM public.hubs WHERE name='Configured hub'")).rows.length,0);
});
check('hub-scoped location views expose only the relevant ancestors and hide unrelated and foreign records',async f=>{
  const own=await f.location();
  const otherRegion=await f.request('locations/regions',{countryId:own.country.id,code:'BC',name:'British Columbia'});
  const otherCity=await f.request('locations/cities',{regionId:otherRegion.body.data.id,name:'Vancouver'});
  assert.equal((await f.request('hubs/'+f.hub+'/update',{expectedVersion:1,...f.hubInput(own.city.id)})).response.status,200);
  assert.equal((await f.request('hubs/'+f.otherHub+'/update',{expectedVersion:1,...f.hubInput(otherCity.body.data.id),name:'Other area',timeZone:'America/Vancouver'})).response.status,200);
  const country=await f.request('locations/countries',{code:'US',name:'Unrelated country'});
  const regions=await f.request('locations/regions',undefined,'manager');assert.equal(regions.response.status,200);assert.deepEqual(regions.body.data.map((r:{id:string})=>r.id),[own.region.id]);
  const cities=await f.request('locations/cities',undefined,'manager');assert.deepEqual(cities.body.data.map((r:{id:string})=>r.id),[own.city.id]);
  assert.equal((await f.request('locations/countries/'+country.body.data.id,undefined,'manager')).response.status,404);
  assert.equal((await f.request('hubs?countryId='+own.country.id,undefined,'manager')).body.data.length,1);
  assert.equal((await f.request('hubs/'+f.otherHub,undefined,'manager')).response.status,403);
});
check('geographic and hub foreign keys reject cross-academy references even for privileged SQL',async f=>{
  const country=await f.request('locations/countries',{code:'US',name:'Foreign country'},'foreignMaster',{academy:f.b});
  const region=await f.request('locations/regions',{countryId:country.body.data.id,code:'NY',name:'Foreign region'},'foreignMaster',{academy:f.b});
  const city=await f.request('locations/cities',{regionId:region.body.data.id,name:'Foreign city'},'foreignMaster',{academy:f.b});
  assert.equal((await f.request('hubs',f.hubInput(city.body.data.id))).response.status,400);
  assert.equal((await f.request('locations/cities',{regionId:region.body.data.id,name:'Cross tenant',active:false})).response.status,400);
  await assert.rejects(f.pg.query("INSERT INTO public.cities(academy_id,id,region_id,name) VALUES($1,$2,$3,'Invalid link')",[f.a,randomUUID(),region.body.data.id]),/foreign key/);
  assert.equal((await f.request('locations/cities/'+city.body.data.id)).response.status,404);
});
check('course and ordered module revisions persist and partial edits cannot erase curriculum or archived state',async f=>{
  const created=await f.request('courses',f.courseInput);assert.equal(created.response.status,201);
  const c=created.body.data;assert.equal(c.version,1);assert.equal(c.modules.length,2);
  const update=await f.request('courses/'+c.id+'/update',{expectedVersion:1,name:'Renamed curriculum',translations:{en:'Robotics'}});
  assert.equal(update.response.status,200);assert.equal(update.body.data.modules.length,2);assert.equal(update.body.data.description,'Synthetic curriculum');
  assert.deepEqual(update.body.data.translations,{en:'Robotics',fr:'Robotique','zh-CN':'机器人'});
  assert.equal((await f.request('courses/'+c.id+'/update',{expectedVersion:2,active:false})).response.status,200);
  const inactive=await f.request('courses/'+c.id+'/update',{expectedVersion:3,description:'Archived reference'});assert.equal(inactive.response.status,200);assert.equal(inactive.body.data.active,false);
  const history=(await f.pg.query<{version:number;definition:{name:string;modules:unknown[]}}>('SELECT version,definition FROM public.course_revisions WHERE course_id=$1 ORDER BY version',[c.id])).rows;
  assert.equal(history.length,4);assert.equal(history[0].definition.name,'Robotics foundations');assert.equal(history[0].definition.modules.length,2);
  assert.equal((await f.request('courses/'+c.id+'/update',{expectedVersion:1,name:'Stale'})).response.status,409);
  assert.equal((await f.request('courses',{...f.courseInput,code:'DUP-MOD',modules:[f.courseInput.modules[0],f.courseInput.modules[0]]})).response.status,400);
});
check('course views and edits enforce shared-versus-hub scope, including explicit exclusion of shared entries',async f=>{
  const shared=await f.request('courses',f.courseInput);assert.equal(shared.response.status,201);
  const own=await f.request('courses',{...f.courseInput,code:'HUB-OWN',hubId:f.hub});assert.equal(own.response.status,201);
  const other=await f.request('courses',{...f.courseInput,code:'HUB-OTHER',hubId:f.otherHub});assert.equal(other.response.status,201);
  const visible=await f.request('courses',undefined,'manager');assert.equal(visible.response.status,200);assert.equal(visible.body.data.length,2);
  assert.ok(!visible.body.data.some((r:{id:string})=>r.id===other.body.data.id));
  assert.equal((await f.request('courses?includeShared=false')).body.data.length,2);
  assert.equal((await f.request('courses?hubId='+f.hub+'&includeShared=false',undefined,'manager')).body.data.length,1);
  assert.equal((await f.request('courses/'+other.body.data.id,undefined,'manager')).response.status,404);
  assert.equal((await f.request('courses',{...f.courseInput,code:'GLOBAL-FORBIDDEN'},'manager')).response.status,403);
  assert.equal((await f.request('courses',{...f.courseInput,code:'OWN-CREATED',hubId:f.hub},'manager')).response.status,201);
  assert.equal((await f.request('courses/'+own.body.data.id+'/update',{expectedVersion:1,hubId:f.otherHub},'manager')).response.status,403);
  assert.equal((await f.request('courses/'+shared.body.data.id+'/update',{expectedVersion:1,hubId:f.hub},'manager')).response.status,403);
});
check('course snapshot integrity is enforced by deferred foreign keys and revision write privileges',async f=>{
  const created=await f.request('courses',f.courseInput);assert.equal(created.response.status,201);const id=created.body.data.id;
  await assert.rejects(f.pg.query('UPDATE public.courses SET version=999 WHERE id=$1',[id]),/foreign key/);
  await f.pg.exec('SET ROLE kavosh_runtime');
  try {
    await f.pg.query("SELECT set_config('app.academy_id',$1,false)",[f.a]);
    await assert.rejects(f.pg.query("UPDATE public.course_revisions SET definition='{}'::jsonb WHERE course_id=$1",[id]),/permission denied/);
    await assert.rejects(f.pg.query('DELETE FROM public.course_revisions WHERE course_id=$1',[id]),/permission denied/);
  }finally{await f.pg.exec('RESET ROLE');}
  assert.equal((await f.request('courses/'+id)).body.data.version,1);
});
check('international course outlines support the stated module limits with a bounded payload',async f=>{
  const modules=Array.from({length:100},(_,n)=>({code:'M'+n,title:'模块'+n,summary:'机器学习课程'.repeat(250)}));
  const valid=await f.request('courses',{...f.courseInput,name:'N'.repeat(200),modules});assert.equal(valid.response.status,201);assert.equal(valid.body.data.modules.length,100);
  assert.equal((await f.request('courses',{...f.courseInput,code:'OVERSIZE',description:'x'.repeat(1024*1024+1)})).response.status,413);
  assert.equal((await f.request('courses',{...f.courseInput,code:'TOO-MANY',modules:[...modules,modules[0]]})).response.status,400);
});
check('failed course audit/outbox rolls back the new course, revision and idempotency together',async f=>{
  await f.pg.exec(`CREATE FUNCTION public.synthetic_course_outage() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Synthetic outbox failure'; END $$;
    CREATE TRIGGER synthetic_course_outage BEFORE INSERT ON public.outbox_events FOR EACH ROW EXECUTE FUNCTION public.synthetic_course_outage()`);
  const key=randomUUID();assert.equal((await f.request('courses',f.courseInput,'master',{key})).response.status,503);
  assert.equal((await f.pg.query('SELECT * FROM public.courses')).rows.length,0);assert.equal((await f.pg.query('SELECT * FROM public.course_revisions')).rows.length,0);
  await f.pg.exec('DROP TRIGGER synthetic_course_outage ON public.outbox_events; DROP FUNCTION public.synthetic_course_outage()');
  const retry=await f.request('courses',f.courseInput,'master',{key});assert.equal(retry.response.status,201);
  assert.deepEqual((await f.request('courses',f.courseInput,'master',{key})).body,retry.body);
});
check('catalogue pagination, search, validation and read-only school state work through the real dispatcher',async f=>{
  for(let n=0;n<3;n++)assert.equal((await f.request('courses',{...f.courseInput,code:'SEARCH-'+n,name:'Robotics '+n})).response.status,201);
  const page=await f.request('courses?limit=2&q=Robotics');assert.equal(page.body.data.length,2);assert.ok(page.body.nextCursor);
  const next=await f.request('courses?limit=2&q=Robotics&after='+page.body.nextCursor);assert.equal(next.body.data.length,1);
  assert.equal((await f.request('courses?unexpected=yes')).response.status,400);
  assert.equal((await f.request('courses?limit=101')).response.status,400);
  assert.equal((await f.request('courses?q='+encodeURIComponent("'; DROP TABLE public.courses; --"))).body.data.length,0);
  assert.equal((await f.pg.query('SELECT * FROM public.courses')).rows.length,3);
  await f.pg.query("UPDATE public.academies SET status='read_only' WHERE id=$1",[f.a]);
  assert.equal((await f.request('courses')).response.status,200);
  assert.equal((await f.request('courses',{...f.courseInput,code:'BLOCKED'})).response.status,403);
});

if(process.env.TEST_DATABASE_URL) {
  check('unauthorized metadata writers are rejected before waiting for policy locks',async f=>{
    await f.pg.exec('BEGIN');await f.pg.query('SELECT pg_advisory_xact_lock(hashtextextended($1,8))',[f.a]);
    try {
      assert.equal((await f.request('locations/countries',{code:'US',name:'Forbidden'},'staff')).response.status,403);
      assert.equal((await f.request('roles',f.roleInput,'staff')).response.status,403);
    }finally{await f.pg.exec('ROLLBACK');}
  });
  check('concurrent course edits preserve one exact revision and reject a stale writer',async f=>{
    const created=await f.request('courses',f.courseInput),id=created.body.data.id;
    const results=await Promise.all([f.request('courses/'+id+'/update',{expectedVersion:1,name:'Concurrent A'}),f.request('courses/'+id+'/update',{expectedVersion:1,name:'Concurrent B'})]);
    assert.deepEqual(results.map(r=>r.response.status).sort(),[200,409]);
    assert.equal((await f.pg.query('SELECT * FROM public.course_revisions WHERE course_id=$1',[id])).rows.length,2);
    const c=await f.request('courses/'+id);assert.equal(c.body.data.version,2);assert.ok(['Concurrent A','Concurrent B'].includes(c.body.data.name));
  });
  check('city archival cannot race an active hub creation into an invalid hierarchy',async f=>{
    const data=await f.location();
    const results=await Promise.all([f.request('locations/cities/'+data.city.id+'/update',{expectedVersion:1,active:false}),f.request('hubs',f.hubInput(data.city.id))]);
    const statuses=results.map(r=>r.response.status);
    assert.ok((statuses[0]===200&&statuses[1]===400)||(statuses[0]===409&&statuses[1]===201),'one of the conflicting operations must be rejected');
    const invalid=await f.pg.query('SELECT h.id FROM public.hubs h JOIN public.cities c ON c.academy_id=h.academy_id AND c.id=h.city_id WHERE h.active AND NOT c.active');assert.equal(invalid.rows.length,0);
  });
}
