import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { operationsFixture } from './operations-fixture.ts';
import { configuredR2Upload,type R2Connection } from '../src/integrations/r2-config.ts';

const synthetic:R2Connection={accountId:'a'.repeat(32),jurisdiction:'default',bucket:'synthetic-private-quarantine',accessKeyId:'synthetic-access-id',secretAccessKey:'synthetic-r2-secret-not-a-real-key',maximumUploadBytes:80};
async function fixture() {
  let academy='',connection:R2Connection|null={...synthetic};
  const f=await operationsFixture({connections:id=>id===academy?connection:null});academy=f.a;
  for(const role of [f.staffRole,f.managerRole])for(const cap of ['files.view','files.edit','files.upload'])await f.pg.query("INSERT INTO public.role_permissions VALUES($1,$2,$3,'allow')",[f.a,role,cap]);
  async function file(bytes=30,hub=f.hub) {const r=await f.request('files',{anchor:{kind:'hub',id:hub},name:'Synthetic private attachment.txt',claimedMimeType:'text/plain',expectedBytes:bytes});assert.equal(r.response.status,201);return r.body.data;}
  async function configure(patch:Record<string,unknown>={}) {const r=await f.request('storage-policy',{expectedVersion:0,uploadsEnabled:true,maximumFileBytes:100,maximumReservedBytes:150,maximumFiles:2,reason:'Synthetic test budget',...patch});assert.equal(r.response.status,200,JSON.stringify(r.body));return r;}
  async function link(id:string,as='staff',key=randomUUID(),expectedMetadataVersion=1) {return f.request('files/'+id+'/upload-link',{expectedMetadataVersion},as,{key});}
  return {...f,file,configure,link,setConnection:(next:R2Connection|null)=>{connection=next;}};
}
type Fixture=Awaited<ReturnType<typeof fixture>>;
function check(name:string,run:(f:Fixture)=>Promise<void>){test(name,async()=>{const f=await fixture();try{await run(f);}finally{await f.pg.close();}});}

check('upload link atomically reserves capacity and returns only a short-lived conditional quarantine PUT, never upload or clean proof',async f=>{
  await f.configure();const item=await f.file(),r=await f.link(item.id);assert.equal(r.response.status,201,JSON.stringify(r.body));
  const d=r.body.data,u=new URL(d.upload.url);assert.equal(r.response.headers.get('cache-control'),'no-store');assert.equal(d.stage,'awaiting_upload');assert.equal(d.uploadVerified,false);assert.equal(d.physicalStorageVerified,false);assert.equal(d.storageTargetId,undefined);
  assert.equal(d.upload.method,'PUT');assert.equal(u.pathname,'/'+synthetic.bucket+'/academies/'+f.a+'/quarantine/'+item.id);assert.equal(u.searchParams.get('X-Amz-Expires'),'300');assert.equal(d.upload.expiresAt,d.expiresAt);
  assert.deepEqual(d.upload.headers,{'content-type':'text/plain','content-length':'30','if-none-match':'*'});assert.equal(Date.parse(d.expiresAt)-Date.parse(d.issuedAt),300000);
  assert.ok(!JSON.stringify(r.body).includes(synthetic.secretAccessKey));const p=(await f.request('storage-policy')).body.data;assert.equal(p.reservedBytes,30);assert.equal(p.reservedFiles,1);
  assert.equal((await f.request('files/'+item.id)).body.data.upload_state,'awaiting_upload');assert.equal((await f.pg.query('SELECT * FROM public.file_upload_grants')).rows.length,1);
});
check('upload retries reconstruct the same bounded link without storing bearer URLs, keys or private filenames in grant intents or audit',async f=>{
  await f.configure();const item=await f.file(),key=randomUUID(),one=await f.link(item.id,'staff',key);assert.equal(one.response.status,201);
  assert.deepEqual((await f.link(item.id,'staff',key)).body,one.body);
  const cached=(await f.pg.query<{response:unknown}>('SELECT response FROM public.request_keys WHERE credential_id=$1 AND key=$2',[f.actors.staff.session,key])).rows[0].response,text=JSON.stringify(cached);
  assert.ok(!text.includes('https:'));assert.ok(!text.includes('X-Amz'));assert.ok(!text.includes(synthetic.accessKeyId));assert.ok(!text.includes(synthetic.secretAccessKey));assert.ok(!text.includes(item.name));
  const audit=(await f.request('audit-events')).body.data.filter((e:{action:string})=>e.action==='file.upload.link.issued');assert.equal(audit.length,1);assert.equal(audit[0].changes.grantId,one.body.data.id);assert.ok(!JSON.stringify(audit).includes('https:'));
  const fresh=await f.link(item.id);assert.equal(fresh.response.status,201);assert.notEqual(fresh.body.data.id,one.body.data.id);assert.equal((await f.request('storage-policy')).body.data.reservedFiles,1);
});
check('upload links require configured storage, an enabled school policy and the smaller provider/school file limit',async f=>{
  const item=await f.file();f.setConnection(null);const locks=f.metrics.sharedPolicyLocks;assert.equal((await f.link(item.id)).body.error.code,'R2_NOT_CONFIGURED');assert.equal(f.metrics.sharedPolicyLocks,locks);
  f.setConnection({...synthetic});assert.equal((await f.link(item.id)).body.error.code,'STORAGE_POLICY_NOT_CONFIGURED');await f.configure({uploadsEnabled:false});assert.equal((await f.link(item.id)).body.error.code,'UPLOADS_DISABLED');
  assert.equal((await f.request('storage-policy',{expectedVersion:1,uploadsEnabled:true,reason:'Enable synthetic link tests'})).response.status,200);
  const limits=await f.request('files/'+item.id+'/upload-limits',undefined,'staff');assert.equal(limits.body.serviceConfigured,true);assert.deepEqual(limits.body.data,{uploadsEnabled:true,maximumFileBytes:100,allowedMimeTypes:(await f.request('storage-policy')).body.data.allowedMimeTypes,effectiveMaximumFileBytes:80});
  const big=await f.file(81);assert.equal((await f.link(big.id)).body.error.code,'FILE_EXCEEDS_STORAGE_LIMIT');assert.equal((await f.request('storage-policy')).body.data.reservedBytes,0);
});
check('current upload rights, private-domain rights, file versions and archive state are rechecked even on stored intent replays',async f=>{
  await f.configure();const item=await f.file(),key=randomUUID();assert.equal((await f.link(item.id,'staff',key)).response.status,201);
  await f.pg.query("DELETE FROM public.role_permissions WHERE role_id=$1 AND capability='files.upload'",[f.staffRole]);assert.equal((await f.link(item.id,'staff',key)).response.status,403);
  await f.pg.query("INSERT INTO public.role_permissions VALUES($1,$2,'files.upload','allow')",[f.a,f.staffRole]);assert.equal((await f.request('files/'+item.id+'/change',{expectedVersion:1,archived:true})).response.status,200);
  assert.equal((await f.link(item.id,'staff',key)).body.error.code,'TARGET_CHANGED');assert.equal((await f.link(item.id,'staff',randomUUID(),2)).body.error.code,'FILE_ARCHIVED');
  const other=await f.file(10,f.otherHub),locks=f.metrics.sharedPolicyLocks;assert.equal((await f.link(other.id)).response.status,404);assert.equal(f.metrics.sharedPolicyLocks,locks);
  const foreign=await f.request('files',{anchor:{kind:'hub',id:f.foreignHub},name:'Another school.txt',claimedMimeType:'text/plain',expectedBytes:10},'foreignMaster',{academy:f.b});assert.equal(foreign.response.status,201);
  assert.equal((await f.link(foreign.body.data.id)).response.status,404);assert.equal((await f.request('files/'+foreign.body.data.id+'/upload-link',{expectedMetadataVersion:1},'staff',{academy:f.b})).response.status,401);
  assert.equal((await f.request('students',{personId:f.actors.staff.person,legalName:'Synthetic private enrollee',dateOfBirth:'2000-01-01',recruiter:{kind:'academy'}})).response.status,201);
  const protectedFile=await f.request('files',{anchor:{kind:'person',id:f.actors.staff.person},domain:'student_private',name:'Protected.txt',claimedMimeType:'text/plain',expectedBytes:10});assert.equal(protectedFile.response.status,201);
  assert.equal((await f.link(protectedFile.body.data.id)).response.status,404);
  for(const cap of ['students.view','students.edit'])await f.pg.query("INSERT INTO public.role_permissions VALUES($1,$2,$3,'allow')",[f.a,f.staffRole,cap]);
  const privateKey=randomUUID();assert.equal((await f.link(protectedFile.body.data.id,'staff',privateKey)).response.status,201);
  await f.pg.query("DELETE FROM public.role_permissions WHERE role_id=$1 AND capability='students.edit'",[f.staffRole]);assert.equal((await f.link(protectedFile.body.data.id,'staff',privateKey)).response.status,404);
});
check('school disable and storage destination changes block replays; key rotation cannot extend the stored grant expiry',async f=>{
  await f.configure();const item=await f.file(),key=randomUUID(),one=await f.link(item.id,'staff',key);assert.equal(one.response.status,201);
  f.setConnection({...synthetic,bucket:'another-synthetic-private-quarantine'});assert.equal((await f.link(item.id,'staff',key)).body.error.code,'STORAGE_TARGET_CHANGED');assert.equal((await f.link(item.id)).body.error.code,'STORAGE_TARGET_CHANGED');
  f.setConnection({...synthetic,accessKeyId:'rotated-synthetic-id',secretAccessKey:'rotated-synthetic-r2-secret-key'});const rotated=await f.link(item.id,'staff',key);assert.equal(rotated.response.status,201);assert.equal(rotated.body.data.id,one.body.data.id);assert.equal(rotated.body.data.expiresAt,one.body.data.expiresAt);assert.notEqual(rotated.body.data.upload.url,one.body.data.upload.url);
  assert.equal((await f.request('storage-policy',{expectedVersion:1,uploadsEnabled:false,reason:'Stop new link issuance'})).response.status,200);assert.equal((await f.link(item.id,'staff',key)).body.error.code,'UPLOADS_DISABLED');
  assert.equal((await f.request('storage-policy')).body.data.reservedBytes,30);assert.equal((await f.pg.query('SELECT * FROM public.file_upload_grants')).rows.length,1);
});
test('expired stored intent cannot be renewed with the same key or acquire a later expiry',async t=>{
  const f=await fixture();try {
    await f.configure();const item=await f.file(),key=randomUUID(),one=await f.link(item.id,'staff',key);assert.equal(one.response.status,201);
    const clock=t.mock.method(Date,'now',()=>Date.parse(one.body.data.expiresAt)+1000);
    try{const expired=await f.link(item.id,'staff',key);assert.equal(expired.response.status,410,JSON.stringify(expired.body));assert.equal(expired.body.error.code,'FILE_LINK_EXPIRED');}finally{clock.mock.restore();}
    assert.equal((await f.pg.query('SELECT * FROM public.file_upload_grants')).rows.length,1);assert.equal((await f.request('storage-policy')).body.data.reservedFiles,1);
  }finally{await f.pg.close();}
});
check('upload bot calls retain their credential ceiling and cannot select another school, hub, target, expiry, clean state or provider settings',async f=>{
  await f.configure();const own=await f.file(),other=await f.file(10,f.otherHub);assert.equal((await f.link(own.id,'bot')).response.status,201);assert.equal((await f.link(other.id,'bot')).response.status,404);
  await f.pg.query("UPDATE auth_private.credentials SET capabilities=array_remove(capabilities,'files.upload') WHERE id=$1",[f.credential]);assert.equal((await f.link(own.id,'bot')).response.status,403);
  for(const extra of [{expiresAt:'2099-01-01T00:00:00Z'},{storageTargetId:'0'.repeat(64)},{clean:true},{configuration:synthetic},{academyId:f.b},{key:'clean/override'}])assert.equal((await f.request('files/'+own.id+'/upload-link',{expectedMetadataVersion:1,...extra},'staff')).response.status,400);
  assert.equal((await f.request('files/'+own.id+'/upload-link',undefined,'staff')).response.status,405);
});
check('upload grant, quota charge, destination pin, audit and intent roll back together when event persistence fails',async f=>{
  await f.configure();const item=await f.file(),key=randomUUID();await f.pg.exec('REVOKE INSERT ON public.outbox_events FROM kavosh_runtime');
  try{assert.equal((await f.link(item.id,'staff',key)).response.status,503);}finally{await f.pg.exec('GRANT INSERT ON public.outbox_events TO kavosh_runtime');}
  assert.equal((await f.request('storage-policy')).body.data.reservedBytes,0);assert.equal((await f.pg.query('SELECT * FROM public.file_upload_grants')).rows.length,0);assert.equal((await f.pg.query('SELECT * FROM public.file_upload_reservations')).rows.length,0);
  assert.equal((await f.link(item.id,'staff',key)).response.status,201);assert.equal((await f.request('storage-policy')).body.data.reservedBytes,30);
});
check('a read-only school cannot issue or replay upload links even when the person and existing grant remain authorized',async f=>{
  await f.configure();const item=await f.file(),key=randomUUID();assert.equal((await f.link(item.id,'staff',key)).response.status,201);
  await f.pg.query("UPDATE public.academies SET status='read_only' WHERE id=$1",[f.a]);const replay=await f.link(item.id,'staff',key);assert.equal(replay.response.status,403);assert.equal(replay.body.error.code,'ACADEMY_READ_ONLY');
  assert.equal((await f.request('storage-policy')).body.data.reservedFiles,1);assert.equal((await f.pg.query('SELECT * FROM public.file_upload_grants')).rows.length,1);
});
check('upload grant lifetime and destination records are tenant-bound and cannot be fabricated, rewritten or erased by ordinary SQL',async f=>{
  await f.configure();const item=await f.file();assert.equal((await f.link(item.id)).response.status,201);
  await f.pg.exec('SET ROLE kavosh_runtime');try {
    await f.pg.query("SELECT set_config('app.academy_id',$1,false)",[f.b]);assert.equal((await f.pg.query('SELECT * FROM public.file_upload_grants')).rows.length,0);
    await assert.rejects(f.pg.query('SELECT * FROM public.issue_file_upload_grant($1,$2,1,$3)',[item.id,f.actors.staff.person,'0'.repeat(64)]),/STORAGE_POLICY_NOT_CONFIGURED/);
    await f.pg.query("SELECT set_config('app.academy_id',$1,false)",[f.a]);
    await assert.rejects(f.pg.query('UPDATE public.file_upload_grants SET expires_at=expires_at+interval \'1 day\''),/permission denied/i);await assert.rejects(f.pg.query('DELETE FROM public.file_upload_grants'),/permission denied/i);
    await assert.rejects(f.pg.query("UPDATE public.file_upload_reservations SET storage_target_id=repeat('0',64)"),/permission denied/i);
    await assert.rejects(f.pg.query('INSERT INTO public.file_upload_grants SELECT * FROM public.file_upload_grants'),/permission denied/i);
  }finally{await f.pg.exec('RESET ROLE');}
});
test('operator storage registry defaults off, is explicitly academy-bound, validates selected secrets and fails without disclosing them',()=>{
  const academy=randomUUID(),other=randomUUID(),registry=JSON.stringify([{academyId:academy,configuration:synthetic}]);
  assert.equal(configuredR2Upload(academy,{}),null);assert.equal(configuredR2Upload(academy,{R2_UPLOAD_CONNECTIONS:registry}),null);
  const env={R2_UPLOAD_LINKS_ENABLED:'true',R2_UPLOAD_CONNECTIONS:registry};assert.deepEqual(configuredR2Upload(academy,env),synthetic);assert.equal(configuredR2Upload(other,env),null);
  for(const value of ['invalid JSON',JSON.stringify([{academyId:academy,configuration:{...synthetic,endpoint:'http://localhost'}}]),JSON.stringify([{academyId:academy,configuration:synthetic},{academyId:academy,configuration:synthetic}]),' '.repeat(1_048_577)])
    assert.throws(()=>configuredR2Upload(academy,{...env,R2_UPLOAD_CONNECTIONS:value}),{code:'R2_NOT_CONFIGURED',status:503});
});
if(process.env.TEST_DATABASE_URL)check('concurrent upload grants share one capacity charge and same-key intents keep exactly one native grant',async f=>{
  await f.configure({maximumFileBytes:80,maximumReservedBytes:100,maximumFiles:1});const item=await f.file(60),key=randomUUID();
  const same=await Promise.all([f.link(item.id,'staff',key),f.link(item.id,'staff',key)]);assert.deepEqual(same.map(r=>r.response.status),[201,201]);assert.deepEqual(same[0].body,same[1].body);assert.equal((await f.pg.query('SELECT * FROM public.file_upload_grants')).rows.length,1);
  const fresh=await Promise.all([f.link(item.id),f.link(item.id)]);assert.deepEqual(fresh.map(r=>r.response.status),[201,201]);assert.equal((await f.pg.query('SELECT * FROM public.file_upload_grants')).rows.length,3);assert.equal((await f.request('storage-policy')).body.data.reservedBytes,60);
  const next=await f.file(60);assert.equal((await f.link(next.id)).body.error.code,'STORAGE_QUOTA_EXCEEDED');
});
if(process.env.TEST_DATABASE_URL)check('an upload replay waiting for policy serialization rejects a committed archive instead of issuing a fresh bearer response',async f=>{
  await f.configure();const item=await f.file(),key=randomUUID();assert.equal((await f.link(item.id,'staff',key)).response.status,201);
  await f.pg.exec('BEGIN');let open=true;await f.pg.query('SELECT academy_id FROM public.file_storage_policies WHERE academy_id=$1 FOR UPDATE',[f.a]);
  const pending=f.link(item.id,'staff',key);
  try {
    let waiting=false;
    for(let attempt=0;attempt<200;attempt++) {
      await f.pg.query('SELECT pg_stat_clear_snapshot()');const blocked=await f.pg.query<{count:number}>(`SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid()
        AND wait_event_type='Lock' AND query LIKE '%file_storage_policies%' AND query LIKE '%FOR UPDATE%'`);
      if(blocked.rows[0].count>0){waiting=true;break;}await new Promise(resolve=>setTimeout(resolve,5));
    }
    assert.equal(waiting,true,'prove the replay reached the policy-row lock before archival');
    assert.equal((await f.request('files/'+item.id+'/change',{expectedVersion:1,archived:true})).response.status,200);
    await f.pg.exec('COMMIT');open=false;const result=await pending;assert.equal(result.response.status,409,JSON.stringify(result.body));assert.equal(result.body.error.code,'TARGET_CHANGED');
    assert.equal((await f.pg.query('SELECT * FROM public.file_upload_grants')).rows.length,1);assert.equal((await f.request('storage-policy')).body.data.reservedBytes,30);
  }finally{if(open)await f.pg.exec('ROLLBACK');await pending;}
});
if(process.env.TEST_DATABASE_URL)check('one hundred parallel synthetic upload-link requests preserve correct grant and capacity accounting without physical uploads',async f=>{
  await f.configure();const item=await f.file(),before=f.metrics.businessQueries;
  const measurements=await Promise.all(Array.from({length:100},async()=>{const started=performance.now(),r=await f.link(item.id);assert.equal(r.response.status,201,JSON.stringify(r.body));assert.equal(r.body.data.fileId,item.id);assert.equal(r.body.data.uploadVerified,false);assert.equal(new URL(r.body.data.upload.url).searchParams.get('X-Amz-Expires'),'300');return performance.now()-started;}));
  const businessQueries=f.metrics.businessQueries-before;measurements.sort((a,b)=>a-b);
  assert.equal((await f.pg.query('SELECT * FROM public.file_upload_grants')).rows.length,100);assert.equal((await f.request('storage-policy')).body.data.reservedFiles,1);assert.equal((await f.request('storage-policy')).body.data.reservedBytes,30);
  console.log(JSON.stringify({check:'synthetic-upload-link-issuance',concurrentRequests:100,principals:1,databasePoolLimit:4,validatedResponses:100,physicalUploads:0,p99Ms:Math.ceil(measurements[98]),businessQueries}));
});
