import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { operationsFixture } from './operations-fixture.ts';

async function fixture() {
  let connectionAvailable=true;
  const f=await operationsFixture({connections:()=>connectionAvailable?{accountId:'a'.repeat(32),jurisdiction:'default',bucket:'synthetic-private-quarantine',accessKeyId:'synthetic-access-id',secretAccessKey:'synthetic-r2-secret-not-a-real-key',maximumUploadBytes:1000}:null});
  for(const role of [f.staffRole,f.managerRole])for(const cap of ['files.view','files.edit','files.upload'])await f.pg.query("INSERT INTO public.role_permissions VALUES($1,$2,$3,'allow')",[f.a,role,cap]);
  assert.equal((await f.request('storage-policy',{expectedVersion:0,uploadsEnabled:true,maximumFileBytes:100,maximumReservedBytes:300,maximumFiles:10,reason:'Synthetic file inspection budget'})).response.status,200);
  async function file(hub=f.hub) {const r=await f.request('files',{anchor:{kind:'hub',id:hub},name:'Synthetic upload.txt',claimedMimeType:'text/plain',expectedBytes:30});assert.equal(r.response.status,201);return r.body.data;}
  async function grant(id:string,as='staff',key=randomUUID()) {const r=await f.request('files/'+id+'/upload-link',{expectedMetadataVersion:1},as,{key});assert.equal(r.response.status,201,JSON.stringify(r.body));return {...r.body.data,key};}
  async function inspect(id:string,grantId:string,as='staff',key=randomUUID(),expectedMetadataVersion=1) {return f.request('files/'+id+'/inspection',{grantId,expectedMetadataVersion},as,{key});}
  return {...f,file,grant,inspect,disableConnection:()=>{connectionAvailable=false;}};
}
type Fixture=Awaited<ReturnType<typeof fixture>>;
function check(name:string,run:(f:Fixture)=>Promise<void>){test(name,async()=>{const f=await fixture();try{await run(f);}finally{await f.pg.close();}});}

check('completion records a durable inspection request with an existing grant, without treating browser claims as physical or safe evidence',async f=>{
  const item=await f.file();assert.equal((await f.request('files/'+item.id+'/inspection',undefined,'staff')).body.error.code,'FILE_INSPECTION_NOT_REQUESTED');
  const g=await f.grant(item.id),r=await f.inspect(item.id,g.id);assert.equal(r.response.status,202,JSON.stringify(r.body));const d=r.body.data;
  assert.equal(d.fileId,item.id);assert.equal(d.grantId,g.id);assert.equal(d.metadataVersionAtRequest,1);assert.equal(d.requestedBy,f.actors.staff.person);assert.equal(d.stage,'inspection_requested');assert.equal(d.uploadVerified,false);assert.equal(d.physicalStorageVerified,false);assert.equal(d.url,undefined);assert.equal(d.storageTargetId,undefined);
  assert.equal((await f.request('files/'+item.id+'/inspection',undefined,'staff')).body.data.id,d.id);assert.equal((await f.request('files/'+item.id,undefined,'staff')).body.data.upload_state,'inspection_requested');
  assert.equal((await f.request('files?limit=10',undefined,'staff')).body.data.find((r:{id:string})=>r.id===item.id).upload_state,'inspection_requested');
  const p=(await f.request('storage-policy')).body.data;assert.equal(p.reservedBytes,30);assert.equal(p.reservedFiles,1);assert.equal((await f.pg.query("SELECT * FROM public.outbox_events WHERE event_type='file.inspection.requested'")).rows.length,1);
});
check('inspection closes new and cached upload-link issuance without erasing existing grant lifetimes or reserved capacity',async f=>{
  const item=await f.file(),g=await f.grant(item.id);assert.equal((await f.inspect(item.id,g.id)).response.status,202);
  for(const key of [g.key,randomUUID()]) {const r=await f.request('files/'+item.id+'/upload-link',{expectedMetadataVersion:1},'staff',{key});assert.equal(r.response.status,409);assert.equal(r.body.error.code,'UPLOAD_CLOSED_FOR_INSPECTION');}
  const limits=await f.request('files/'+item.id+'/upload-limits',undefined,'staff');assert.equal(limits.body.uploadClosed,true);assert.equal(limits.body.serviceConfigured,true);
  assert.equal((await f.pg.query('SELECT * FROM public.file_upload_grants')).rows.length,1);assert.equal((await f.request('storage-policy')).body.data.reservedBytes,30);
});
check('same-key and different-grant completion retries preserve the first immutable request and emit exactly one event',async f=>{
  const item=await f.file(),a=await f.grant(item.id),b=await f.grant(item.id),key=randomUUID(),first=await f.inspect(item.id,a.id,'staff',key);assert.equal(first.response.status,202);
  assert.deepEqual((await f.inspect(item.id,a.id,'staff',key)).body,first.body);
  const next=await f.inspect(item.id,b.id,'bot');assert.equal(next.response.status,200);assert.equal(next.body.data.id,first.body.data.id);assert.equal(next.body.data.grantId,a.id);assert.equal(next.body.data.requestedBy,f.actors.staff.person);assert.equal(next.body.data.newlyRequested,false);
  assert.equal((await f.pg.query('SELECT * FROM public.file_inspection_requests')).rows.length,1);assert.equal((await f.pg.query("SELECT * FROM public.audit_events WHERE action='file.inspection.requested'")).rows.length,1);
});
check('completion requires a grant for the same file and school; unknown/cross-file grants are rejected before policy locks',async f=>{
  const a=await f.file(),b=await f.file(),ga=await f.grant(a.id),gb=await f.grant(b.id),locks=f.metrics.sharedPolicyLocks;
  for(const id of [randomUUID(),gb.id]) {const r=await f.inspect(a.id,id);assert.equal(r.response.status,404);assert.equal(r.body.error.code,'UPLOAD_GRANT_NOT_FOUND');}assert.equal(f.metrics.sharedPolicyLocks,locks);
  assert.equal((await f.inspect(a.id,ga.id)).response.status,202);assert.equal((await f.inspect(a.id,gb.id)).response.status,404);
  const foreign=await f.request('files',{anchor:{kind:'hub',id:f.foreignHub},name:'Other school.txt',claimedMimeType:'text/plain',expectedBytes:10},'foreignMaster',{academy:f.b});assert.equal(foreign.response.status,201);
  assert.equal((await f.inspect(foreign.body.data.id,ga.id)).response.status,404);assert.equal((await f.pg.query('SELECT * FROM public.file_inspection_requests')).rows.length,1);
});
check('completion and tracking use current scoped file/domain rights, with a viewer allowed to track but not submit or replay',async f=>{
  const own=await f.file(),g=await f.grant(own.id),key=randomUUID();assert.equal((await f.inspect(own.id,g.id,'staff',key)).response.status,202);
  await f.pg.query("DELETE FROM public.role_permissions WHERE role_id=$1 AND capability='files.upload'",[f.staffRole]);assert.equal((await f.inspect(own.id,g.id,'staff',key)).response.status,403);assert.equal((await f.request('files/'+own.id+'/inspection',undefined,'staff')).response.status,200);
  await f.pg.query("INSERT INTO public.role_permissions VALUES($1,$2,'files.upload','allow')",[f.a,f.staffRole]);
  const other=await f.file(f.otherHub),og=await f.grant(other.id,'master');assert.equal((await f.inspect(other.id,og.id)).response.status,404);assert.equal((await f.request('files/'+other.id+'/inspection',undefined,'staff')).response.status,404);
  assert.equal((await f.request('students',{personId:f.actors.staff.person,legalName:'Synthetic private enrollee',dateOfBirth:'2000-01-01',recruiter:{kind:'academy'}})).response.status,201);
  const pf=await f.request('files',{anchor:{kind:'person',id:f.actors.staff.person},domain:'student_private',name:'Private.txt',claimedMimeType:'text/plain',expectedBytes:10});assert.equal(pf.response.status,201);const pg=await f.grant(pf.body.data.id,'master');assert.equal((await f.inspect(pf.body.data.id,pg.id,'master')).response.status,202);
  assert.equal((await f.request('files/'+pf.body.data.id+'/inspection',undefined,'staff')).response.status,404);
  await f.pg.query("INSERT INTO public.role_permissions VALUES($1,$2,'students.view','allow')",[f.a,f.staffRole]);assert.equal((await f.request('files/'+pf.body.data.id+'/inspection',undefined,'staff')).response.status,200);assert.equal((await f.inspect(pf.body.data.id,pg.id)).response.status,404);
  await f.pg.query("INSERT INTO public.role_permissions VALUES($1,$2,'students.edit','allow')",[f.a,f.staffRole]);assert.equal((await f.inspect(pf.body.data.id,pg.id)).response.status,200);
});
check('completion accepts an existing older grant after a rename or upload-disable but requires current metadata version and never renews expiry',async f=>{
  const item=await f.file(),g=await f.grant(item.id);assert.equal((await f.request('files/'+item.id+'/change',{expectedVersion:1,name:'Renamed before completion.txt'})).response.status,200);
  assert.equal((await f.inspect(item.id,g.id)).body.error.code,'TARGET_CHANGED');assert.equal((await f.request('storage-policy',{expectedVersion:1,uploadsEnabled:false,reason:'Stop new uploads, allow safety inspection'})).response.status,200);
  f.disableConnection();
  const r=await f.inspect(item.id,g.id,'staff',randomUUID(),2);assert.equal(r.response.status,202,JSON.stringify(r.body));assert.equal(r.body.data.metadataVersionAtRequest,2);assert.equal(r.body.data.grantId,g.id);
  const grant=(await f.pg.query<{expires_at:Date|string}>('SELECT expires_at FROM public.file_upload_grants WHERE id=$1',[g.id])).rows[0];assert.equal(new Date(grant.expires_at).toISOString(),g.expiresAt);
});
check('a historical expired grant can identify a completion request without renewing its timestamp or proving any physical upload',async f=>{
  const item=await f.file(),g=await f.grant(item.id);
  // Test-only owner write models elapsed history while preserving the native
  // five-minute lifetime constraint; runtime grant rewrites remain forbidden.
  await f.pg.query("UPDATE public.file_upload_grants SET issued_at=issued_at-interval '10 minutes',expires_at=expires_at-interval '10 minutes' WHERE id=$1",[g.id]);
  const before=(await f.pg.query<{expires_at:Date|string;expired:boolean}>('SELECT expires_at,expires_at<clock_timestamp() AS expired FROM public.file_upload_grants WHERE id=$1',[g.id])).rows[0];assert.equal(before.expired,true);
  const r=await f.inspect(item.id,g.id);assert.equal(r.response.status,202);assert.equal(r.body.data.uploadVerified,false);assert.equal(r.body.data.physicalStorageVerified,false);
  const after=(await f.pg.query<{expires_at:Date|string}>('SELECT expires_at FROM public.file_upload_grants WHERE id=$1',[g.id])).rows[0];assert.equal(new Date(after.expires_at).toISOString(),new Date(before.expires_at).toISOString());assert.equal((await f.request('storage-policy')).body.data.reservedBytes,30);
});
check('completion input cannot declare uploaded/clean status, supply evidence/URLs, change scope or bypass archive/read-only restrictions',async f=>{
  const item=await f.file(),g=await f.grant(item.id);
  for(const extra of [{clean:true},{uploaded:true},{sha256:'0'.repeat(64)},{url:'http://localhost'},{status:'verified'},{storageTargetId:'0'.repeat(64)},{academyId:f.b}])assert.equal((await f.request('files/'+item.id+'/inspection',{grantId:g.id,expectedMetadataVersion:1,...extra},'staff')).response.status,400);
  assert.equal((await f.request('files/'+item.id+'/change',{expectedVersion:1,archived:true})).response.status,200);assert.equal((await f.inspect(item.id,g.id,'staff',randomUUID(),2)).body.error.code,'FILE_ARCHIVED');
  assert.equal((await f.request('files/'+item.id+'/change',{expectedVersion:2,archived:false})).response.status,200);await f.pg.query("UPDATE public.academies SET status='read_only' WHERE id=$1",[f.a]);assert.equal((await f.inspect(item.id,g.id,'staff',randomUUID(),3)).body.error.code,'ACADEMY_READ_ONLY');
  assert.equal((await f.pg.query('SELECT * FROM public.file_inspection_requests')).rows.length,0);
});
check('inspection requests, audit, outbox and retry intent roll back together so failed persistence cannot accidentally close uploads',async f=>{
  const item=await f.file(),g=await f.grant(item.id),key=randomUUID();await f.pg.exec('REVOKE INSERT ON public.outbox_events FROM kavosh_runtime');
  try{assert.equal((await f.inspect(item.id,g.id,'staff',key)).response.status,503);}finally{await f.pg.exec('GRANT INSERT ON public.outbox_events TO kavosh_runtime');}
  assert.equal((await f.pg.query('SELECT * FROM public.file_inspection_requests')).rows.length,0);assert.equal((await f.request('files/'+item.id+'/upload-limits',undefined,'staff')).body.uploadClosed,false);await f.grant(item.id);
  assert.equal((await f.inspect(item.id,g.id,'staff',key)).response.status,202);assert.equal((await f.pg.query("SELECT * FROM public.outbox_events WHERE event_type='file.inspection.requested'")).rows.length,1);
});
check('native inspection requests are tenant-bound and immutable, and the grant trigger independently prevents post-request issuance',async f=>{
  const item=await f.file(),g=await f.grant(item.id);assert.equal((await f.inspect(item.id,g.id)).response.status,202);
  const other=await f.file(),og=await f.grant(other.id);
  const target=(await f.pg.query<{storage_target_id:string}>('SELECT storage_target_id FROM public.file_upload_reservations WHERE file_id=$1',[item.id])).rows[0].storage_target_id;
  for(const [fileId,grantId,metadataVersion,storageTarget,actor] of [[other.id,g.id,1,target,f.actors.staff.person],[other.id,og.id,99,target,f.actors.staff.person],[other.id,og.id,1,'0'.repeat(64),f.actors.staff.person],[other.id,og.id,1,target,f.actors.foreignMaster.person]])
    await assert.rejects(f.pg.query('INSERT INTO public.file_inspection_requests(academy_id,file_id,grant_id,metadata_version,storage_target_id,requested_by) VALUES($1,$2,$3,$4,$5,$6)',[f.a,fileId,grantId,metadataVersion,storageTarget,actor]),/foreign key/i);
  await f.pg.exec('SET ROLE kavosh_runtime');try {
    await f.pg.query("SELECT set_config('app.academy_id',$1,false)",[f.b]);assert.equal((await f.pg.query('SELECT * FROM public.file_inspection_requests')).rows.length,0);
    await f.pg.query("SELECT set_config('app.academy_id',$1,false)",[f.a]);
    await assert.rejects(f.pg.query('DELETE FROM public.file_inspection_requests'),/permission denied/i);await assert.rejects(f.pg.query('UPDATE public.file_inspection_requests SET requested_at=now()'),/permission denied/i);await assert.rejects(f.pg.query('INSERT INTO public.file_inspection_requests SELECT * FROM public.file_inspection_requests'),/permission denied/i);
    await assert.rejects(f.pg.query('SELECT * FROM public.issue_file_upload_grant($1,$2,1,$3)',[item.id,f.actors.staff.person,target]),/UPLOAD_CLOSED_FOR_INSPECTION/);
  }finally{await f.pg.exec('RESET ROLE');}
  assert.equal((await f.pg.query('SELECT * FROM public.file_upload_grants')).rows.length,2);assert.equal((await f.pg.query('SELECT * FROM public.file_inspection_requests')).rows.length,1);
});
if(process.env.TEST_DATABASE_URL)check('simultaneous completion requests collapse to one immutable request and one event without double-charging',async f=>{
  const item=await f.file(),a=await f.grant(item.id),b=await f.grant(item.id),results=await Promise.all([f.inspect(item.id,a.id),f.inspect(item.id,b.id,'bot')]);assert.deepEqual(results.map(r=>r.response.status).sort(),[200,202]);assert.equal(results[0].body.data.id,results[1].body.data.id);
  assert.equal((await f.pg.query('SELECT * FROM public.file_inspection_requests')).rows.length,1);assert.equal((await f.pg.query("SELECT * FROM public.outbox_events WHERE event_type='file.inspection.requested'")).rows.length,1);assert.equal((await f.request('storage-policy')).body.data.reservedBytes,30);
});
if(process.env.TEST_DATABASE_URL)check('a completion holding the policy lock closes a cached upload response waiting behind it',async f=>{
  const item=await f.file(),g=await f.grant(item.id);await f.pg.exec('BEGIN');let open=true;await f.pg.query('SELECT id FROM public.file_records WHERE id=$1 FOR UPDATE',[item.id]);
  const completion=f.inspect(item.id,g.id);let replay:ReturnType<typeof f.request>|undefined;
  async function waitFor(table:string) {
    for(let attempt=0;attempt<200;attempt++){await f.pg.query('SELECT pg_stat_clear_snapshot()');const r=await f.pg.query<{count:number}>(`SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND wait_event_type='Lock' AND query LIKE $1 AND query LIKE '%FOR UPDATE%'`,['%'+table+'%']);if(r.rows[0].count>0)return;await new Promise(resolve=>setTimeout(resolve,5));}assert.fail('Expected a proven '+table+' row-lock wait');
  }
  try {
    await waitFor('file_records');replay=f.request('files/'+item.id+'/upload-link',{expectedMetadataVersion:1},'staff',{key:g.key});await waitFor('file_storage_policies');await f.pg.exec('COMMIT');open=false;
    assert.equal((await completion).response.status,202);const blocked=await replay;assert.equal(blocked.response.status,409,JSON.stringify(blocked.body));assert.equal(blocked.body.error.code,'UPLOAD_CLOSED_FOR_INSPECTION');assert.equal((await f.pg.query('SELECT * FROM public.file_upload_grants')).rows.length,1);
  }finally{if(open)await f.pg.exec('ROLLBACK');await completion;if(replay)await replay;}
});
