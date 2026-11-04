import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { operationsFixture } from './operations-fixture.ts';

async function fixture() {
  const f=await operationsFixture();
  for(const r of [f.staffRole,f.managerRole])for(const cap of ['files.view','files.edit','files.upload'])await f.pg.query("INSERT INTO public.role_permissions VALUES($1,$2,$3,'allow')",[f.a,r,cap]);
  const role=await f.request('roles',{name:'Storage policy administrator',permissions:['storage.view','storage.edit'].map(capability=>({capability,effect:'allow'}))});assert.equal(role.response.status,201);
  const prior=await f.request('people/'+f.actors.manager.person+'/access');assert.equal((await f.request('people/'+f.actors.manager.person+'/access',{expectedVersion:prior.body.data.version,assignments:[{roleId:f.managerRole,allHubs:false,hubIds:[f.hub]},{roleId:f.policyRole,allHubs:true},{roleId:role.body.data.id,allHubs:true}]})).response.status,200);
  async function file(bytes=10,hub=f.hub) {const r=await f.request('files',{anchor:{kind:'hub',id:hub},name:'Synthetic upload.txt',claimedMimeType:'text/plain',expectedBytes:bytes});assert.equal(r.response.status,201);return r.body.data;}
  async function configure(body:unknown={expectedVersion:0,uploadsEnabled:true,maximumFileBytes:100,maximumReservedBytes:150,maximumFiles:2,reason:'Explicit upload budget'},as='master'){return f.request('storage-policy',body,as);}
  async function reserve(id:string,as='staff',key?:string,expectedMetadataVersion=1){return f.request('files/'+id+'/upload-reservation',{expectedMetadataVersion},as,key?{key}:{});}
  return {...f,file,configure,reserve};
}
type Fixture=Awaited<ReturnType<typeof fixture>>;
function check(name:string,run:(f:Fixture)=>Promise<void>){test(name,async()=>{const f=await fixture();try{await run(f);}finally{await f.pg.close();}});}

check('storage policy starts unconfigured, defaults disabled and retains reviewed configuration history without inventing physical usage',async f=>{
  const empty=await f.request('storage-policy');assert.equal(empty.response.status,200);assert.equal(empty.body.configured,false);assert.equal(empty.body.data,null);
  const made=await f.configure({expectedVersion:0,reason:'Create conservative disabled policy'});assert.equal(made.response.status,200,JSON.stringify(made.body));assert.equal(made.body.data.uploadsEnabled,false);assert.equal(made.body.data.reservedBytes,0);assert.equal(made.body.data.usageBasis,'reserved_claims');assert.equal(made.body.data.physicalStorageVerified,false);
  const item=await f.file();const denied=await f.reserve(item.id);assert.equal(denied.response.status,409);assert.equal(denied.body.error.code,'UPLOADS_DISABLED');
  const changed=await f.configure({expectedVersion:1,uploadsEnabled:true,reason:'Enable configured reservations'});assert.equal(changed.response.status,200);assert.equal(changed.body.data.maximumFileBytes,made.body.data.maximumFileBytes);
  const history=await f.request('storage-policy/history?limit=1');assert.equal(history.body.data[0].definition.uploadsEnabled,false);assert.equal(history.body.nextVersion,1);
  assert.equal((await f.request('storage-policy/history?afterVersion=1')).body.data[0].definition.uploadsEnabled,true);
});
check('non-master policy changes require an upper human and counter activity does not invalidate an otherwise unchanged policy proposal',async f=>{
  const pending=await f.configure(undefined,'manager');assert.equal(pending.response.status,202,JSON.stringify(pending.body));assert.equal((await f.request('storage-policy')).body.configured,false);assert.equal((await f.approve(pending.body.approval.id,'manager')).response.status,403);assert.equal((await f.approve(pending.body.approval.id)).response.status,200);
  const change=await f.configure({expectedVersion:1,maximumReservedBytes:200,reason:'Increase reservation budget'},'manager');assert.equal(change.response.status,202);
  const item=await f.file(40);assert.equal((await f.reserve(item.id)).response.status,201);
  const accepted=await f.approve(change.body.approval.id);assert.equal(accepted.response.status,200,JSON.stringify(accepted.body));assert.equal(accepted.body.data.reservedBytes,40);assert.equal(accepted.body.data.maximumReservedBytes,200);
  assert.equal((await f.configure({expectedVersion:1,uploadsEnabled:false,reason:'Stale edit'})).response.status,409);
});
check('capacity reservation requires current file/domain/upload permissions and returns no signed link, object status or verified content',async f=>{
  const item=await f.file(30),missing=await f.reserve(item.id);assert.equal(missing.response.status,503);assert.equal(missing.body.error.code,'STORAGE_POLICY_NOT_CONFIGURED');
  assert.equal((await f.configure()).response.status,200);const reserved=await f.reserve(item.id);assert.equal(reserved.response.status,201,JSON.stringify(reserved.body));assert.equal(reserved.body.data.reservedBytes,30);assert.equal(reserved.body.data.stage,'capacity_reserved');assert.equal(reserved.body.data.uploadVerified,false);assert.equal(reserved.body.data.physicalStorageVerified,false);assert.equal(reserved.body.data.url,undefined);
  assert.equal((await f.request('files/'+item.id+'/upload-reservation',undefined,'staff')).body.data.reservedBytes,30);
  await f.pg.query("DELETE FROM public.role_permissions WHERE role_id=$1 AND capability='files.upload'",[f.staffRole]);assert.equal((await f.reserve(item.id)).response.status,403);
  await f.pg.query("INSERT INTO public.role_permissions VALUES($1,$2,'files.upload','allow')",[f.a,f.staffRole]);
  const elsewhere=await f.file(10,f.otherHub);assert.equal((await f.reserve(elsewhere.id)).response.status,404);
  assert.equal((await f.request('storage-policy',undefined,'staff')).response.status,403);
});
check('uploader-safe limits expose enabled/per-file rules without school capacity totals or access to other hub files',async f=>{
  const own=await f.file(),other=await f.file(10,f.otherHub);
  assert.equal((await f.request('files/'+own.id+'/upload-limits',undefined,'staff')).body.configured,false);
  assert.equal((await f.configure()).response.status,200);
  const limits=await f.request('files/'+own.id+'/upload-limits',undefined,'staff');assert.equal(limits.response.status,200);assert.deepEqual(limits.body.data,{uploadsEnabled:true,maximumFileBytes:100});
  assert.equal((await f.request('files/'+other.id+'/upload-limits',undefined,'staff')).response.status,404);assert.equal((await f.request('storage-policy',undefined,'staff')).response.status,403);
});
check('a protected file reservation requires domain editing as well as file upload authority',async f=>{
  const student=f.actors.staff.person;assert.equal((await f.request('students',{personId:student,legalName:'Private enrollee',dateOfBirth:'2000-01-01',recruiter:{kind:'academy'}})).response.status,201);
  const made=await f.request('files',{anchor:{kind:'person',id:student},domain:'student_private',name:'Private attachment.txt',claimedMimeType:'text/plain',expectedBytes:10});assert.equal(made.response.status,201);assert.equal((await f.configure()).response.status,200);
  const before=f.metrics.sharedPolicyLocks;assert.equal((await f.reserve(made.body.data.id)).response.status,404);assert.equal(f.metrics.sharedPolicyLocks,before);
  await f.pg.query("INSERT INTO public.role_permissions VALUES($1,$2,'students.view','allow')",[f.a,f.staffRole]);assert.equal((await f.reserve(made.body.data.id)).response.status,404);
  await f.pg.query("INSERT INTO public.role_permissions VALUES($1,$2,'students.edit','allow')",[f.a,f.staffRole]);assert.equal((await f.reserve(made.body.data.id)).response.status,201);
});
check('management bots can reserve within their file scope but cannot approve school policy or evade hub ceilings',async f=>{
  const before=f.metrics.exclusivePolicyLocks;assert.equal((await f.configure(undefined,'staff')).response.status,403);assert.equal(f.metrics.exclusivePolicyLocks,before);
  assert.equal((await f.configure()).response.status,200);assert.ok(f.metrics.exclusivePolicyLocks>before);
  const own=await f.file(20),other=await f.file(20,f.otherHub);assert.equal((await f.reserve(own.id,'bot')).response.status,201);assert.equal((await f.reserve(other.id,'bot')).response.status,404);
  assert.equal((await f.configure({expectedVersion:1,maximumFiles:3,reason:'No school policy grant'},'bot')).response.status,403);
});
check('quota accounting is durable and repeated intents cannot double-charge, free capacity or become verified uploads through metadata changes',async f=>{
  assert.equal((await f.configure()).response.status,200);const item=await f.file(80),key=randomUUID(),one=await f.reserve(item.id,'staff',key);assert.equal(one.response.status,201);
  assert.deepEqual((await f.reserve(item.id,'staff',key)).body,one.body);const again=await f.reserve(item.id);assert.equal(again.response.status,200);assert.equal(again.body.data.newlyReserved,false);
  assert.equal((await f.request('storage-policy')).body.data.reservedBytes,80);assert.equal((await f.request('storage-policy')).body.data.reservedFiles,1);
  assert.equal((await f.request('files/'+item.id+'/change',{expectedVersion:1,archived:true})).response.status,200);assert.equal((await f.reserve(item.id,'staff',undefined,2)).response.status,409);
  assert.equal((await f.request('storage-policy')).body.data.reservedBytes,80,'archiving is not proof of physical disposal');
  assert.equal((await f.request('files/'+item.id+'/change',{expectedVersion:2,archived:false})).response.status,200);assert.equal((await f.reserve(item.id,'staff',undefined,3)).response.status,200);
  const next=await f.file(80),over=await f.reserve(next.id);assert.equal(over.response.status,409);assert.equal(over.body.error.code,'STORAGE_QUOTA_EXCEEDED');assert.equal((await f.request('storage-policy')).body.data.reservedFiles,1);
});
check('per-file and count limits reject oversized or additional reservations and lowered budgets never silently erase existing allocations',async f=>{
  assert.equal((await f.configure({expectedVersion:0,uploadsEnabled:true,maximumFileBytes:40,maximumReservedBytes:100,maximumFiles:1,reason:'Small staging budget'})).response.status,200);
  const big=await f.file(41);assert.equal((await f.reserve(big.id)).body.error.code,'FILE_EXCEEDS_STORAGE_LIMIT');
  const one=await f.file(30),two=await f.file(30);assert.equal((await f.reserve(one.id)).response.status,201);assert.equal((await f.reserve(two.id)).body.error.code,'STORAGE_QUOTA_EXCEEDED');
  const lower=await f.configure({expectedVersion:1,maximumFileBytes:20,maximumReservedBytes:20,reason:'Lower future usage limit'});assert.equal(lower.response.status,200);assert.equal(lower.body.data.reservedBytes,30);assert.equal(lower.body.data.maximumReservedBytes,20);
});
check('policy and reservation input cannot overwrite counters, bypass protected domains or claim cleanup/signing outcomes',async f=>{
  for(const extra of [{reservedBytes:0},{reservedFiles:0},{maximumFileBytes:0},{maximumFiles:0},{maximumReservedBytes:1},{reason:''}])assert.equal((await f.configure({expectedVersion:0,uploadsEnabled:true,maximumFileBytes:10,maximumReservedBytes:100,maximumFiles:2,reason:'Validate input',...extra})).response.status,400);
  assert.equal((await f.configure()).response.status,200);const item=await f.file();
  for(const extra of [{released:true},{clean:true},{uploaded:true},{reservedBytes:1},{url:'https://localhost'},{expectedMetadataVersion:0}])assert.equal((await f.request('files/'+item.id+'/upload-reservation',{expectedMetadataVersion:1,...extra},'staff')).response.status,400);
  assert.equal((await f.reserve(item.id,'staff',undefined,2)).response.status,409);
  assert.equal((await f.request('files/'+item.id+'/upload-reservation',undefined,'staff')).response.status,404);
});
check('event failure rolls back native quota counters, allocation and idempotency together',async f=>{
  assert.equal((await f.configure()).response.status,200);const item=await f.file(50),key=randomUUID();
  await f.pg.exec('REVOKE INSERT ON public.outbox_events FROM kavosh_runtime');try{assert.equal((await f.reserve(item.id,'staff',key)).response.status,503);}finally{await f.pg.exec('GRANT INSERT ON public.outbox_events TO kavosh_runtime');}
  assert.equal((await f.request('storage-policy')).body.data.reservedBytes,0);assert.equal((await f.pg.query('SELECT * FROM public.file_upload_reservations')).rows.length,0);
  assert.equal((await f.reserve(item.id,'staff',key)).response.status,201);assert.equal((await f.request('storage-policy')).body.data.reservedBytes,50);
});
check('native quota bookkeeping is tenant-bound and cannot be reset or fabricated with ordinary business SQL privileges',async f=>{
  assert.equal((await f.configure()).response.status,200);const item=await f.file(30);assert.equal((await f.reserve(item.id)).response.status,201);
  await f.pg.exec('SET ROLE kavosh_runtime');try{
    await f.pg.query("SELECT set_config('app.academy_id',$1,false)",[f.b]);for(const t of ['file_storage_policies','file_storage_policy_revisions','file_upload_reservations'])assert.equal((await f.pg.query('SELECT * FROM public.'+t)).rows.length,0);
    await f.pg.query("SELECT set_config('app.academy_id',$1,false)",[f.a]);
    await assert.rejects(f.pg.query('SELECT * FROM public.reserve_file_upload($1,$2,$3)',[item.id,f.actors.staff.person,99]),/TARGET_CHANGED/);
    await assert.rejects(f.pg.query('UPDATE public.file_storage_policies SET reserved_bytes=0'),/permission denied/i);await assert.rejects(f.pg.query('UPDATE public.file_upload_reservations SET released_at=now()'),/permission denied/i);
    await assert.rejects(f.pg.query('DELETE FROM public.file_upload_reservations'),/permission denied/i);await assert.rejects(f.pg.query("UPDATE public.file_storage_policy_revisions SET definition='{}'"),/permission denied/i);
  }finally{await f.pg.exec('RESET ROLE');}
});
check('general audit readers cannot recover protected storage budget values or reasons through policy change events',async f=>{
  const why='Private capacity planning note';assert.equal((await f.configure({expectedVersion:0,uploadsEnabled:true,maximumFileBytes:100,maximumReservedBytes:1000,maximumFiles:10,reason:why})).response.status,200);
  const role=await f.request('roles',{name:'General activity reader',permissions:[{capability:'audit.view',effect:'allow'}]});assert.equal(role.response.status,201);
  const path='people/'+f.actors.peer.person+'/access',before=await f.request(path);assert.equal((await f.request(path,{expectedVersion:before.body.data.version,assignments:[{roleId:role.body.data.id,allHubs:true}]})).response.status,200);
  assert.equal((await f.request('storage-policy',undefined,'peer')).response.status,403);assert.equal((await f.request('storage-policy/history',undefined,'peer')).response.status,403);
  const audit=(await f.request('audit-events',undefined,'peer')).body.data,event=audit.find((r:{action:string})=>r.action==='file.storage.policy.updated');assert.ok(event);assert.equal(event.changes.before,undefined);assert.equal(event.changes.after,undefined);assert.equal(event.changes.maximumReservedBytes,undefined);assert.ok(event.changes.fields.includes('maximumReservedBytes'));assert.ok(!JSON.stringify(audit).includes(why));
  const history=await f.request('storage-policy/history');assert.equal(history.body.data[0].definition.maximumReservedBytes,1000);assert.equal(history.body.data[0].reason,why);
});
if(process.env.TEST_DATABASE_URL)check('concurrent reservations cannot exceed the last capacity slot or charge the same file twice',async f=>{
  assert.equal((await f.configure({expectedVersion:0,uploadsEnabled:true,maximumFileBytes:100,maximumReservedBytes:100,maximumFiles:1,reason:'Concurrent last-slot check'})).response.status,200);
  const a=await f.file(60),b=await f.file(60),results=await Promise.all([f.reserve(a.id),f.reserve(b.id)]);assert.deepEqual(results.map(r=>r.response.status).sort(),[201,409]);
  const winner=results.find(r=>r.response.status===201)!.body.data.fileId,retries=await Promise.all([f.reserve(winner),f.reserve(winner)]);assert.deepEqual(retries.map(r=>r.response.status),[200,200]);
  const p=(await f.request('storage-policy')).body.data;assert.equal(p.reservedFiles,1);assert.equal(p.reservedBytes,60);assert.equal((await f.pg.query('SELECT * FROM public.file_upload_reservations')).rows.length,1);
});
if(process.env.TEST_DATABASE_URL)check('a reservation waiting for its budget lock rechecks the committed metadata revision before charging capacity',async f=>{
  assert.equal((await f.configure()).response.status,200);const item=await f.file(30);
  await f.pg.exec('BEGIN');let open=true;
  await f.pg.query('SELECT academy_id FROM public.file_storage_policies WHERE academy_id=$1 FOR UPDATE',[f.a]);
  const pending=f.reserve(item.id);
  try {
    let waiting=false;
    for(let attempt=0;attempt<200;attempt++) {
      await f.pg.query('SELECT pg_stat_clear_snapshot()');
      const blocked=await f.pg.query<{count:number}>(`SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid()
        AND wait_event_type='Lock' AND query LIKE '%reserve_file_upload%'`);
      if(blocked.rows[0].count>0){waiting=true;break;}await new Promise(resolve=>setTimeout(resolve,5));
    }
    assert.equal(waiting,true,'prove the request waited for the capacity lock before the metadata correction');
    const changed=await f.request('files/'+item.id+'/change',{expectedVersion:1,name:'Corrected before reservation'});assert.equal(changed.response.status,200);
    await f.pg.exec('COMMIT');open=false;
    const result=await pending;assert.equal(result.response.status,409,JSON.stringify(result.body));assert.equal(result.body.error.code,'TARGET_CHANGED');
    assert.equal((await f.request('storage-policy')).body.data.reservedBytes,0);assert.equal((await f.pg.query('SELECT * FROM public.file_upload_reservations')).rows.length,0);
    assert.equal((await f.reserve(item.id,'staff',undefined,2)).response.status,201);
  }finally{if(open)await f.pg.exec('ROLLBACK');await pending;}
});
