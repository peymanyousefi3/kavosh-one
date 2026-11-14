import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { operationsFixture } from './operations-fixture.ts';

async function fixture() {
  const f=await operationsFixture();
  for(const role of [f.staffRole,f.managerRole])for(const cap of ['files.view','files.edit'])await f.pg.query("INSERT INTO public.role_permissions VALUES($1,$2,$3,'allow')",[f.a,role,cap]);
  const student=f.actors.staff.person;assert.equal((await f.request('students',{personId:student,legalName:'Private student name',dateOfBirth:'2000-01-01',recruiter:{kind:'academy'}})).response.status,201);
  const input={anchor:{kind:'hub',id:f.hub},name:'机器人_photo_100%.jpg',description:'Private progress description',tags:['Robotics','Focus'],claimedMimeType:'image/jpeg',expectedBytes:1000,reason:'Private file reservation note'};
  async function create(body:unknown=input,as='master',key?:string){return f.request('files',body,as,key?{key}:{});}
  async function role(permissions:{capability:string;effect:string}[]){const r=await f.request('roles',{name:'File preset '+randomUUID(),permissions});assert.equal(r.response.status,201);return r.body.data.id as string;}
  async function assign(person:string,assignments:unknown[]){const current=await f.request('people/'+person+'/access');return f.request('people/'+person+'/access',{expectedVersion:current.body.data.version,assignments});}
  return {...f,student,input,create,role,assign};
}
type Fixture=Awaited<ReturnType<typeof fixture>>;
function check(name:string,run:(f:Fixture)=>Promise<void>){test(name,async()=>{const f=await fixture();try{await run(f);}finally{await f.pg.close();}});}

check('file metadata reservations persist Unicode claims without pretending an upload, inspection or download exists',async f=>{
  const made=await f.create();assert.equal(made.response.status,201,JSON.stringify(made.body));const row=made.body.data;
  assert.equal(row.name,f.input.name);assert.equal(row.expected_bytes,1000);assert.equal(row.upload_state,'awaiting_upload');assert.equal(row.url,undefined);assert.equal(row.clean,undefined);assert.equal(row.content_sha256,undefined);
  const changed=await f.request('files/'+row.id+'/change',{expectedVersion:1,name:'Renamed file.jpg',archived:true,reason:'Private correction'});assert.equal(changed.response.status,200,JSON.stringify(changed.body));assert.equal(changed.body.data.description,f.input.description);assert.deepEqual(changed.body.data.tags,f.input.tags);assert.equal(changed.body.data.expected_bytes,1000);
  const restore=await f.request('files/'+row.id+'/change',{expectedVersion:2,description:'',tags:[],archived:false});assert.equal(restore.response.status,200);assert.equal(restore.body.data.description,'');assert.deepEqual(restore.body.data.tags,[]);assert.equal(restore.body.data.archived,false);
  const history=await f.request('files/'+row.id+'/history?limit=1');assert.equal(history.body.data[0].definition.name,f.input.name);assert.equal(history.body.nextVersion,1);
  assert.equal((await f.request('files/'+row.id+'/history?afterVersion=1')).body.data.length,2);
  const audit=JSON.stringify((await f.request('audit-events')).body.data.filter((e:{action:string})=>e.action.startsWith('file.metadata.')));for(const value of [f.input.name,f.input.description,f.input.reason,'Private correction'])assert.ok(!audit.includes(value));
});
check('private file search filters by permission before pagination and treats Unicode, percent and underscore as literal text',async f=>{
  for(const hub of [f.hub,f.otherHub])assert.equal((await f.create({...f.input,anchor:{kind:'hub',id:hub}})).response.status,201);
  assert.equal((await f.create({...f.input,name:'Ordinary invoice.pdf',tags:['FinanceLabel'],claimedMimeType:'application/pdf'})).response.status,201);
  for(const q of ['机器人','100%','photo_','FOCUS']){const r=await f.request('files?q='+encodeURIComponent(q),undefined,'staff');assert.equal(r.response.status,200,JSON.stringify(r.body));assert.equal(r.body.data.length,1);assert.equal(r.body.data[0].effective_hub_id,f.hub);}
  assert.equal((await f.request('files?q=%25',undefined,'staff')).body.data.length,1);
  assert.equal((await f.request('files?q=FinanceLabel',undefined,'staff')).body.data.length,1);
  const first=await f.request('files?limit=1',undefined,'staff');assert.ok(first.body.nextCursor);const next=await f.request('files?limit=1&after='+first.body.nextCursor,undefined,'staff');assert.equal(next.body.data.length,1);assert.notEqual(next.body.data[0].id,first.body.data[0].id);
});
check('file rights alone never disclose protected student/guardian/agreement domains or their revision history',async f=>{
  const studentFile=await f.create({...f.input,anchor:{kind:'person',id:f.student},domain:'student_private'});assert.equal(studentFile.response.status,201,JSON.stringify(studentFile.body));
  const agreementFile=await f.create({...f.input,domain:'agreement_definition'});assert.equal(agreementFile.response.status,201);
  assert.equal((await f.request('files',undefined,'staff')).body.data.length,0);
  for(const made of [studentFile,agreementFile])for(const suffix of ['', '/history'])assert.equal((await f.request('files/'+made.body.data.id+suffix,undefined,'staff')).response.status,404);
  assert.equal((await f.create({...f.input,anchor:{kind:'person',id:f.student},domain:'student_private'},'staff')).response.status,403);
  const view=await f.role([{capability:'files.view',effect:'allow'},{capability:'students.view',effect:'allow'}]);assert.equal((await f.assign(f.actors.staff.person,[{roleId:view,allHubs:false,personIds:[f.student]}])).response.status,200);
  const visible=await f.request('files',undefined,'staff');assert.deepEqual(visible.body.data.map((r:{id:string})=>r.id),[studentFile.body.data.id]);assert.equal((await f.request('files/'+studentFile.body.data.id+'/change',{expectedVersion:1,name:'Not allowed.jpg'},'staff')).response.status,403);
});
check('person-bound file visibility follows the current hub, including historical metadata, instead of retaining former-hub access',async f=>{
  const made=await f.create({...f.input,anchor:{kind:'person',id:f.student},domain:'student_private'});assert.equal(made.response.status,201);
  await f.pg.query("INSERT INTO public.role_permissions VALUES($1,$2,'students.view','allow')",[f.a,f.staffRole]);await f.pg.query("INSERT INTO public.role_permissions VALUES($1,$2,'students.view','allow')",[f.a,f.managerRole]);
  assert.equal((await f.request('files/'+made.body.data.id,undefined,'staff')).response.status,200);
  await f.pg.query('UPDATE public.people SET hub_id=$2 WHERE id=$1',[f.student,f.otherHub]);
  assert.equal((await f.request('files',undefined,'staff')).body.data.length,0);assert.equal((await f.request('files/'+made.body.data.id+'/history',undefined,'staff')).response.status,404);
  const moved=await f.request('files/'+made.body.data.id,undefined,'peer');assert.equal(moved.response.status,200,JSON.stringify(moved.body));assert.equal(moved.body.data.effective_hub_id,f.otherHub);
});
check('class-only file selectors, explicit class denial and bot hub ceilings cannot become hub-wide file access',async f=>{
  const country=randomUUID(),region=randomUUID(),city=randomUUID();
  await f.pg.query("INSERT INTO public.countries(academy_id,id,code,name) VALUES($1,$2,'CA','Canada')",[f.a,country]);
  await f.pg.query("INSERT INTO public.regions(academy_id,id,country_id,code,name) VALUES($1,$2,$3,'ON','Ontario')",[f.a,region,country]);
  await f.pg.query("INSERT INTO public.cities(academy_id,id,region_id,name) VALUES($1,$2,$3,'Toronto')",[f.a,city,region]);
  await f.pg.query("UPDATE public.hubs SET city_id=$1,time_zone='America/Toronto',currency='CAD' WHERE academy_id=$2",[city,f.a]);
  const course=await f.request('courses',{code:'FILE',name:'File test course'});assert.equal(course.response.status,201);
  const classes=[];
  for(const hubId of [f.hub,f.otherHub]){const c=await f.request('classes',{hubId,courseId:course.body.data.id,courseVersion:1,name:'File test class',mode:'in_person',schedule:{oneOff:[{start:'2027-01-01T10:00',end:'2027-01-01T11:00'}]}});assert.equal(c.response.status,201);classes.push(c.body.data.id);}
  const made=[];for(const id of classes){const r=await f.create({...f.input,anchor:{kind:'class',id}});assert.equal(r.response.status,201);made.push(r.body.data.id);}
  const view=await f.role([{capability:'files.view',effect:'allow'}]),deny=await f.role([{capability:'files.view',effect:'deny'}]);
  assert.equal((await f.assign(f.actors.staff.person,[{roleId:view,allHubs:false,classIds:[classes[0]]}])).response.status,200);
  assert.deepEqual((await f.request('files',undefined,'staff')).body.data.map((r:{id:string})=>r.id),[made[0]]);assert.equal((await f.request('files/'+made[1],undefined,'staff')).response.status,404);
  assert.equal((await f.assign(f.actors.staff.person,[{roleId:view,allHubs:true},{roleId:deny,allHubs:false,classIds:[classes[0]]}])).response.status,200);
  assert.deepEqual((await f.request('files',undefined,'staff')).body.data.map((r:{id:string})=>r.id),[made[1]]);
  assert.equal((await f.assign(f.bot,[{roleId:view,allHubs:true}])).response.status,200);await f.pg.query('UPDATE auth_private.credentials SET all_hubs=false WHERE id=$1',[f.credential]);await f.pg.query('INSERT INTO auth_private.credential_hubs VALUES($1,$2,$3)',[f.credential,f.a,f.hub]);
  assert.deepEqual((await f.request('files',undefined,'bot')).body.data.map((r:{id:string})=>r.id),[made[0]]);assert.equal((await f.request('files/'+made[1]+'/history',undefined,'bot')).response.status,404);
});
check('guardian-private metadata requires both file and guardian access rather than student rights or generic directory access',async f=>{
  const guardian=f.actors.manager.person;assert.equal((await f.request('guardians',{personId:guardian,legalName:'Private guardian name'})).response.status,201);
  const made=await f.create({...f.input,anchor:{kind:'person',id:guardian},domain:'guardian_private'});assert.equal(made.response.status,201);
  await f.pg.query("INSERT INTO public.role_permissions VALUES($1,$2,'students.view','allow')",[f.a,f.staffRole]);assert.equal((await f.request('files/'+made.body.data.id,undefined,'staff')).response.status,404);
  await f.pg.query("INSERT INTO public.role_permissions VALUES($1,$2,'guardians.view','allow')",[f.a,f.staffRole]);assert.equal((await f.request('files/'+made.body.data.id,undefined,'staff')).response.status,200);
  assert.equal((await f.request('files/'+made.body.data.id+'/change',{expectedVersion:1,name:'Still no guardian editing.jpg'},'staff')).response.status,404);
});
check('file metadata claims cannot be reparented, declared clean, converted to an unprotected domain or used as filesystem paths',async f=>{
  for(const patch of [{name:'../unsafe.jpg'},{name:'bad\0name'},{name:'bad\ud800'},{name:'bad\nheader'},{expectedBytes:0},{expectedBytes:4294967297},
    {claimedMimeType:'image/jpeg\r\nBad: yes'},{tags:['Same','same']},{domain:'student_private'},{url:'https://localhost'},{clean:true},{upload_state:'clean'},
    {content_sha256:'a'.repeat(64)},{anchor:{kind:'hub',id:f.foreignHub}}]) {
    const r=await f.create({...f.input,...patch});assert.ok([400,403,404].includes(r.response.status),JSON.stringify(patch)+JSON.stringify(r.body));
  }
  const made=await f.create();assert.equal(made.response.status,201);
  for(const patch of [{anchor:{kind:'hub',id:f.otherHub}},{domain:'general'},{expectedBytes:1},{claimedMimeType:'text/plain'},{expectedSha256:'a'.repeat(64)}])assert.equal((await f.request('files/'+made.body.data.id+'/change',{expectedVersion:1,...patch})).response.status,400);
  assert.equal((await f.request('files/'+made.body.data.id+'/download')).response.status,404);
});
check('wrong-scope file reservations fail before taking policy locks, with a valid reservation as a positive control',async f=>{
  const before=f.metrics.sharedPolicyLocks;
  assert.equal((await f.create({...f.input,anchor:{kind:'hub',id:f.otherHub}},'staff')).response.status,403);assert.equal(f.metrics.sharedPolicyLocks,before);
  assert.equal((await f.create({...f.input,anchor:{kind:'person',id:f.student},domain:'student_private'},'staff')).response.status,403);assert.equal(f.metrics.sharedPolicyLocks,before);
  assert.equal((await f.create(f.input,'staff')).response.status,201);assert.ok(f.metrics.sharedPolicyLocks>before);
});
check('file metadata retries and event failures remain atomic and native storage protects tenant references, immutable anchors and history',async f=>{
  const key=randomUUID(),made=await f.create(f.input,'master',key);assert.equal(made.response.status,201);assert.deepEqual((await f.create(f.input,'master',key)).body,made.body);const id=made.body.data.id;
  await f.pg.exec('REVOKE INSERT ON public.outbox_events FROM kavosh_runtime');try{assert.equal((await f.request('files/'+id+'/change',{expectedVersion:1,name:'Failed change.jpg'})).response.status,503);}finally{await f.pg.exec('GRANT INSERT ON public.outbox_events TO kavosh_runtime');}
  assert.equal((await f.request('files/'+id)).body.data.version,1);assert.equal((await f.pg.query('SELECT * FROM public.file_record_revisions')).rows.length,1);
  await assert.rejects(f.pg.query('UPDATE public.file_records SET hub_id=$2 WHERE id=$1',[id,f.foreignHub]),/foreign key/i);
  await f.pg.exec('SET ROLE kavosh_runtime');try{
    await f.pg.query("SELECT set_config('app.academy_id',$1,false)",[f.b]);for(const table of ['file_records','file_catalogue','file_record_revisions'])assert.equal((await f.pg.query('SELECT * FROM public.'+table)).rows.length,0);
    await f.pg.query("SELECT set_config('app.academy_id',$1,false)",[f.a]);await assert.rejects(f.pg.query('UPDATE public.file_records SET hub_id=$2 WHERE id=$1',[id,f.otherHub]),/permission denied/i);await assert.rejects(f.pg.query("UPDATE public.file_record_revisions SET definition='{}' WHERE file_id=$1",[id]),/permission denied/i);
  }finally{await f.pg.exec('RESET ROLE');}
});
if(process.env.TEST_DATABASE_URL)check('concurrent file metadata corrections leave one winner and complete immutable history',async f=>{
  const made=await f.create();assert.equal(made.response.status,201);const id=made.body.data.id;
  const results=await Promise.all(['One.jpg','Two.jpg'].map(name=>f.request('files/'+id+'/change',{expectedVersion:1,name})));assert.deepEqual(results.map(r=>r.response.status).sort(),[200,409]);assert.equal((await f.pg.query('SELECT * FROM public.file_record_revisions WHERE file_id=$1',[id])).rows.length,2);
});
if(process.env.TEST_DATABASE_URL)check('native file search remains permission-filtered and bounded across 5000 records and 100 concurrent requests',async f=>{
  await f.pg.exec('BEGIN');try{
    await f.pg.query(`INSERT INTO public.file_records(academy_id,id,anchor_kind,hub_id,domain,name,claimed_mime_type,expected_bytes,search_text,created_by)
      SELECT $1,gen_random_uuid(),'hub',$2,'general',CASE WHEN g=5000 THEN 'Synthetic distinctneedle file 5000' ELSE 'Synthetic file '||g END,'text/plain',10,
        CASE WHEN g=5000 THEN 'Synthetic distinctneedle file 5000' ELSE 'Synthetic file '||g END,$3 FROM generate_series(1,5000) g`,[f.a,f.hub,f.actors.master.person]);
    await f.pg.query(`INSERT INTO public.file_record_revisions(academy_id,file_id,version,definition,changed_by,reason)
      SELECT academy_id,id,1,jsonb_build_object('id',id,'name',name),$2,'Synthetic scale fixture' FROM public.file_records WHERE academy_id=$1`,[f.a,f.actors.master.person]);
    await f.pg.exec('COMMIT');
  }catch(error){await f.pg.exec('ROLLBACK');throw error;}
  await f.pg.exec('ANALYZE public.file_records');
  const before=f.metrics.businessQueries,times:number[]=[];
  const responses=await Promise.all(Array.from({length:100},async()=>{const start=performance.now(),r=await f.request('files?q=distinctneedle',undefined,'staff');times.push(performance.now()-start);return r;}));
  for(const r of responses){assert.equal(r.response.status,200,JSON.stringify(r.body));assert.equal(r.body.data.length,1);assert.equal(r.body.data[0].name,'Synthetic distinctneedle file 5000');assert.equal(r.body.nextCursor,null);}
  const queries=f.metrics.businessQueries-before;assert.ok(queries<5000,'SQL round trips must not scale per file');times.sort((a,b)=>a-b);
  console.log(JSON.stringify({check:'synthetic-file-metadata-search',records:5000,concurrentRequests:100,principals:1,validatedResponses:responses.length,rowsPerResponse:1,p99Ms:Math.ceil(times[98]),businessQueries:queries}));
});
