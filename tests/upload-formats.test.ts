import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { operationsFixture } from './operations-fixture.ts';
import { defaultUploadMimeTypes } from '../src/modules/storage.ts';

async function fixture() {
  const f=await operationsFixture({connections:()=>({accountId:'a'.repeat(32),jurisdiction:'default',bucket:'synthetic-format-policy',accessKeyId:'synthetic-id',secretAccessKey:'synthetic-not-real-secret',maximumUploadBytes:1000})});
  for(const capability of ['storage.view','storage.edit'])await f.pg.query("INSERT INTO public.role_permissions VALUES($1,$2,$3,'allow')",[f.a,f.policyRole,capability]);
  const configure=(patch:Record<string,unknown>={},as='master')=>f.request('storage-policy',{expectedVersion:0,uploadsEnabled:true,maximumFileBytes:100,maximumReservedBytes:1000,maximumFiles:20,reason:'Synthetic format configuration',...patch},as);
  const change=(allowedMimeTypes:string[],expectedVersion=1,as='master')=>f.request('storage-policy',{expectedVersion,allowedMimeTypes,reason:'Synthetic format restriction'},as);
  async function file(claimedMimeType='text/plain'){const r=await f.request('files',{anchor:{kind:'hub',id:f.hub},name:'Synthetic attachment.any',claimedMimeType,expectedBytes:10});assert.equal(r.response.status,201);return r.body.data.id as string;}
  const link=(id:string,key=randomUUID())=>f.request('files/'+id+'/upload-link',{expectedMetadataVersion:1},'master',{key});
  return {...f,configure,change,file,link};
}
type Fixture=Awaited<ReturnType<typeof fixture>>;
function check(name:string,run:(f:Fixture)=>Promise<void>){test(name,async()=>{const f=await fixture();try{await run(f);}finally{await f.pg.close();}});}

check('format presets are explicit editable MIME claims and database/application defaults agree without declaring valid content',async f=>{
  const r=await f.configure();assert.equal(r.response.status,200);assert.deepEqual(r.body.data.allowedMimeTypes,defaultUploadMimeTypes);assert.equal(r.body.data.physicalStorageVerified,false);
  await f.pg.query('UPDATE public.file_storage_policies SET allowed_mime_types=DEFAULT WHERE academy_id=$1',[f.a]);assert.deepEqual((await f.request('storage-policy')).body.data.allowedMimeTypes,defaultUploadMimeTypes);
  const id=await f.file('image/png'),limits=await f.request('files/'+id+'/upload-limits');assert.deepEqual(limits.body.data.allowedMimeTypes,defaultUploadMimeTypes);assert.equal(limits.body.data.maximumReservedBytes,undefined);
  for(const values of [['image/*'],['Image/PNG'],['text/plain','text/plain'],Array.from({length:65},(_,i)=>'application/x-type-'+i),['text/plain\nimage/png']])assert.equal((await f.configure({expectedVersion:1,allowedMimeTypes:values})).response.status,400);
  for(const values of [['image/*'],['text/plain','text/plain'],[null],Array.from({length:65},(_,i)=>'application/x-type-'+i)])await assert.rejects(f.pg.query('UPDATE public.file_storage_policies SET allowed_mime_types=$2 WHERE academy_id=$1',[f.a,values]),/valid_upload_mime_types|check constraint/i);
  const custom=await f.change(['application/x-robotics-homework']);assert.equal(custom.response.status,200);assert.deepEqual(custom.body.data.allowedMimeTypes,['application/x-robotics-homework']);
});
check('format changes require exact upper-human approval and block fresh/cached issuance without releasing old capacity',async f=>{
  await f.configure();const id=await f.file(),key=randomUUID(),first=await f.link(id,key);assert.equal(first.response.status,201);
  const pending=await f.change(['application/pdf'],1,'manager');assert.equal(pending.response.status,202);assert.equal((await f.link(id,key)).response.status,201);
  assert.equal((await f.approve(pending.body.approval.id,'manager')).response.status,403);assert.equal((await f.approve(pending.body.approval.id)).response.status,200);
  for(const retry of [key,randomUUID()]){const denied=await f.link(id,retry);assert.equal(denied.response.status,409);assert.equal(denied.body.error.code,'FILE_TYPE_NOT_ALLOWED');}
  const policy=(await f.request('storage-policy')).body.data;assert.equal(policy.reservedBytes,10);assert.equal(policy.reservedFiles,1);assert.equal((await f.pg.query('SELECT * FROM public.file_upload_grants')).rows.length,1);
  const history=await f.request('storage-policy/history');assert.deepEqual(history.body.data.map((r:{definition:{allowedMimeTypes:string[]}})=>r.definition.allowedMimeTypes),[defaultUploadMimeTypes,['application/pdf']]);
});
check('an empty allowlist closes all new issuance and cached capacity receipts but still permits inspection of a past grant',async f=>{
  await f.configure();const id=await f.file(),grant=await f.link(id),key=randomUUID();assert.equal(grant.response.status,201);
  assert.equal((await f.request('files/'+id+'/upload-reservation',{expectedMetadataVersion:1},'master',{key})).response.status,200);
  assert.equal((await f.change([])).response.status,200);
  const receipt=await f.request('files/'+id+'/upload-reservation',{expectedMetadataVersion:1},'master',{key});assert.equal(receipt.body.error.code,'FILE_TYPE_NOT_ALLOWED');assert.equal((await f.link(id)).body.error.code,'FILE_TYPE_NOT_ALLOWED');
  const inspection=await f.request('files/'+id+'/inspection',{expectedMetadataVersion:1,grantId:grant.body.data.id});assert.equal(inspection.response.status,202);assert.equal(inspection.body.data.safeToServe,false);
  const newFile=await f.file();assert.equal((await f.link(newFile)).body.error.code,'FILE_TYPE_NOT_ALLOWED');assert.equal((await f.request('storage-policy')).body.data.reservedFiles,1);
});
check('native issuers cannot allocate a disallowed claim or bypass a changed format policy using an existing reservation',async f=>{
  await f.configure();const id=await f.file(),grant=await f.link(id);assert.equal(grant.response.status,201);const target=(await f.pg.query<{storage_target_id:string}>('SELECT storage_target_id FROM public.file_upload_grants')).rows[0].storage_target_id;
  await f.change(['application/pdf']);const blocked=await f.file();await f.pg.exec('SET ROLE kavosh_runtime');
  try {
    await f.pg.query("SELECT set_config('app.academy_id',$1,false)",[f.a]);
    await assert.rejects(f.pg.query('SELECT * FROM public.reserve_file_upload($1,$2,1)',[blocked,f.actors.master.person]),/FILE_TYPE_NOT_ALLOWED/);
    await assert.rejects(f.pg.query('SELECT * FROM public.issue_file_upload_grant($1,$2,1,$3)',[id,f.actors.master.person,target]),/FILE_TYPE_NOT_ALLOWED/);
  }finally{await f.pg.exec('RESET ROLE');}
  assert.equal((await f.pg.query('SELECT * FROM public.file_upload_grants')).rows.length,1);assert.equal((await f.pg.query('SELECT * FROM public.file_upload_reservations')).rows.length,1);assert.equal((await f.request('storage-policy')).body.data.reservedBytes,10);
  const allowed=await f.file('application/pdf');assert.equal((await f.link(allowed)).response.status,201);
});
check('failed format-history persistence rolls back restrictions and generic audit cannot expose the chosen private policy values',async f=>{
  await f.configure();const marker='application/x-private-'+randomUUID();await f.pg.exec('REVOKE INSERT ON public.file_storage_policy_revisions FROM kavosh_runtime');
  try{assert.equal((await f.change([marker])).response.status,503);}finally{await f.pg.exec('GRANT INSERT ON public.file_storage_policy_revisions TO kavosh_runtime');}
  assert.deepEqual((await f.request('storage-policy')).body.data.allowedMimeTypes,defaultUploadMimeTypes);assert.equal((await f.change([marker])).response.status,200);
  const audit=await f.request('audit-events');assert.equal(audit.response.status,200);assert.ok(!JSON.stringify(audit.body).includes(marker));assert.deepEqual((await f.request('storage-policy/history')).body.data.at(-1).definition.allowedMimeTypes,[marker]);
});
if(process.env.TEST_DATABASE_URL)check('a cached upload waiting on the policy lock sees a committed format restriction before reconstructing its URL',async f=>{
  await f.configure();const id=await f.file(),key=randomUUID();assert.equal((await f.link(id,key)).response.status,201);
  await f.pg.exec('BEGIN');let open=true,pending:ReturnType<typeof f.link>|undefined;
  try {
    await f.pg.query('SELECT academy_id FROM public.file_storage_policies WHERE academy_id=$1 FOR UPDATE',[f.a]);pending=f.link(id,key);let waiting=false;
    for(let attempt=0;attempt<500;attempt++) {
      await f.pg.query('SELECT pg_stat_clear_snapshot()');
      const rows=await f.pg.query("SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND wait_event_type='Lock' AND query LIKE '%file_storage_policies%'");
      if(rows.rows.length){waiting=true;break;}await delay(10);
    }
    assert.ok(waiting,'the cached request must actually wait on the policy row');
    // Test-owner transaction simulates the committed policy field change. The
    // ordinary approved API and immutable history are exercised above.
    await f.pg.query("UPDATE public.file_storage_policies SET allowed_mime_types=ARRAY['application/pdf'] WHERE academy_id=$1",[f.a]);await f.pg.exec('COMMIT');open=false;
    const result=await pending;assert.equal(result.response.status,409);assert.equal(result.body.error.code,'FILE_TYPE_NOT_ALLOWED');assert.equal(JSON.stringify(result.body).includes('X-Amz'),false);
    assert.equal((await f.pg.query('SELECT * FROM public.file_upload_grants')).rows.length,1);
  }finally{if(open)await f.pg.exec('ROLLBACK');await pending;}
});
