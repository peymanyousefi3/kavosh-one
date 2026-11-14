import assert from 'node:assert/strict';
import { randomUUID,createHash } from 'node:crypto';
import { readFile,readdir } from 'node:fs/promises';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { operationsFixture } from './operations-fixture.ts';

const connection={accountId:'a'.repeat(32),jurisdiction:'default' as const,bucket:'synthetic-provenance',accessKeyId:'synthetic-id',secretAccessKey:'synthetic-not-real-secret',maximumUploadBytes:1000};
async function fixture() {
  const f=await operationsFixture({connections:()=>connection});
  const configured=await f.request('storage-policy',{expectedVersion:0,uploadsEnabled:true,maximumFileBytes:100,maximumReservedBytes:1000,maximumFiles:20,allowedMimeTypes:['text/plain','application/pdf'],reason:'Synthetic format evidence'});assert.equal(configured.response.status,200);
  async function file(hub=f.hub){const r=await f.request('files',{anchor:{kind:'hub',id:hub},name:'Synthetic grant.txt',claimedMimeType:'text/plain',expectedBytes:10});assert.equal(r.response.status,201);return r.body.data.id as string;}
  const link=(id:string,key=randomUUID())=>f.request('files/'+id+'/upload-link',{expectedMetadataVersion:1},'master',{key});
  return {...f,file,link};
}
type Fixture=Awaited<ReturnType<typeof fixture>>;
function check(name:string,run:(f:Fixture)=>Promise<void>){test(name,async()=>{const f=await fixture();try{await run(f);}finally{await f.pg.close();}});}

check('grants preserve the original reviewed format definition while replay checks current policy and new grants capture the new version',async f=>{
  const id=await f.file(),key=randomUUID(),first=await f.link(id,key);assert.equal(first.response.status,201);assert.equal(first.body.data.formatPolicyVersion,1);assert.equal(first.body.data.formatPolicyRecorded,true);
  assert.equal((await f.request('storage-policy',{expectedVersion:1,allowedMimeTypes:['text/plain'],reason:'Keep text, restrict new grants'})).response.status,200);
  const replay=await f.link(id,key);assert.deepEqual(replay.body,first.body);
  const second=await f.link(id);assert.equal(second.body.data.formatPolicyVersion,2);assert.equal(second.body.data.formatPolicyRecorded,true);
  const history=await f.request('files/'+id+'/upload-grants');assert.equal(history.response.status,200);assert.equal(history.body.data.length,2);
  const one=history.body.data.find((r:{id:string})=>r.id===first.body.data.id),two=history.body.data.find((r:{id:string})=>r.id===second.body.data.id);
  assert.deepEqual(one.formatPolicy,{snapshotVersion:1,allowedMimeTypes:['text/plain','application/pdf']});assert.deepEqual(two.formatPolicy,{snapshotVersion:1,allowedMimeTypes:['text/plain']});assert.equal(one.formatPolicyVersion,1);assert.equal(two.formatPolicyVersion,2);
  assert.equal((await f.request('files/'+id+'/upload-reservation')).body.data.policyVersion,1);assert.equal((await f.request('storage-policy')).body.data.reservedFiles,1);
  const text=JSON.stringify(history.body);for(const secret of ['X-Amz','storageTargetId','maximumReservedBytes','reason',connection.accessKeyId,connection.secretAccessKey])assert.equal(text.includes(secret),false);
  const events=(await f.request('audit-events')).body.data.filter((r:{action:string})=>r.action==='file.upload.link.issued');assert.deepEqual(events.map((r:{changes:{formatPolicyVersion:number}})=>r.changes.formatPolicyVersion).sort(),[1,2]);assert.equal(JSON.stringify(events).includes('application/pdf'),false);
});
check('uploader history is bounded, chronologically paginated and restricted by current edit/upload/file scopes',async f=>{
  for(const cap of ['files.view','files.edit','files.upload'])await f.pg.query("INSERT INTO public.role_permissions VALUES($1,$2,$3,'allow')",[f.a,f.staffRole,cap]);
  const own=await f.file(),other=await f.file(f.otherHub);await f.link(own);await f.link(own);await f.link(other);
  const first=await f.request('files/'+own+'/upload-grants?limit=1',undefined,'staff');assert.equal(first.response.status,200);assert.equal(first.body.data.length,1);assert.ok(first.body.nextCursor);
  const cursor=first.body.nextCursor,next=await f.request('files/'+own+'/upload-grants?limit=1&afterIssuedAt='+encodeURIComponent(cursor.issuedAt)+'&afterId='+cursor.id,undefined,'staff');assert.equal(next.response.status,200);assert.equal(next.body.data.length,1);assert.notEqual(next.body.data[0].id,first.body.data[0].id);assert.equal(next.body.nextCursor,null);
  assert.equal((await f.request('files/'+other+'/upload-grants',undefined,'staff')).response.status,404);
  await f.pg.query("DELETE FROM public.role_permissions WHERE role_id=$1 AND capability='files.upload'",[f.staffRole]);assert.equal((await f.request('files/'+own+'/upload-grants',undefined,'staff')).response.status,403);
  for(const query of ['limit=101','afterId='+randomUUID(),'afterIssuedAt=2026-11-04T00%3A00%3A00Z','extra=true'])assert.equal((await f.request('files/'+own+'/upload-grants?'+query)).response.status,400);
  assert.equal((await f.request('files/'+own+'/upload-grants',{})).response.status,405);
});
check('native format provenance cannot be rewritten or forged by runtime SQL or client-supplied receipt fields',async f=>{
  const id=await f.file();await f.link(id);
  for(const extra of [{formatPolicyVersion:99},{formatPolicySnapshot:{allowedMimeTypes:['text/html']}},{formatPolicyRecorded:true}])assert.equal((await f.request('files/'+id+'/upload-link',{expectedMetadataVersion:1,...extra})).response.status,400);
  await f.pg.exec('SET ROLE kavosh_runtime');try {
    await f.pg.query("SELECT set_config('app.academy_id',$1,false)",[f.b]);assert.equal((await f.pg.query('SELECT format_policy_snapshot FROM public.file_upload_grants')).rows.length,0);
    await f.pg.query("SELECT set_config('app.academy_id',$1,false)",[f.a]);await assert.rejects(f.pg.query('UPDATE public.file_upload_grants SET format_policy_version=99'),/permission denied/i);await assert.rejects(f.pg.query('UPDATE public.file_upload_grants SET format_policy_snapshot=NULL'),/permission denied/i);
    await assert.rejects(f.pg.query('INSERT INTO public.file_upload_grants SELECT * FROM public.file_upload_grants'),/permission denied/i);
  }finally{await f.pg.exec('RESET ROLE');}
});
check('private student grant history requires current protected-domain editing as well as file/upload rights',async f=>{
  for(const cap of ['files.view','files.edit','files.upload'])await f.pg.query("INSERT INTO public.role_permissions VALUES($1,$2,$3,'allow')",[f.a,f.staffRole,cap]);
  const person=f.actors.staff.person;assert.equal((await f.request('students',{personId:person,legalName:'Synthetic private enrollee',dateOfBirth:'2000-01-01',recruiter:{kind:'academy'}})).response.status,201);
  const made=await f.request('files',{anchor:{kind:'person',id:person},domain:'student_private',name:'Private.txt',claimedMimeType:'text/plain',expectedBytes:10});assert.equal(made.response.status,201);const id=made.body.data.id;await f.link(id);
  assert.equal((await f.request('files/'+id+'/upload-grants',undefined,'staff')).response.status,404);
  await f.pg.query("INSERT INTO public.role_permissions VALUES($1,$2,'students.view','allow')",[f.a,f.staffRole]);assert.equal((await f.request('files/'+id+'/upload-grants',undefined,'staff')).response.status,404);
  await f.pg.query("INSERT INTO public.role_permissions VALUES($1,$2,'students.edit','allow')",[f.a,f.staffRole]);assert.equal((await f.request('files/'+id+'/upload-grants',undefined,'staff')).response.status,200);
  await f.pg.query("DELETE FROM public.role_permissions WHERE role_id=$1 AND capability='students.edit'",[f.staffRole]);assert.equal((await f.request('files/'+id+'/upload-grants',undefined,'staff')).response.status,404);
  assert.equal((await f.request('files/'+id+'/upload-grants',undefined,'staff',{academy:f.b})).response.status,401);
});
check('legacy stored receipt shapes remain explicitly unknown rather than taking the current policy version',async f=>{
  const id=await f.file(),key=randomUUID(),first=await f.link(id,key);assert.equal(first.response.status,201);
  // Test-owner removes the new receipt field to model an older writer. Never
  // weaken application immutability privileges or infer history from settings.
  await f.pg.query("UPDATE public.request_keys SET response=jsonb_set(response,'{data}',(response->'data')-'formatPolicyVersion') WHERE key=$1",[key]);
  await f.request('storage-policy',{expectedVersion:1,allowedMimeTypes:['text/plain'],reason:'A later policy cannot fill missing historical evidence'});
  const replay=await f.link(id,key);assert.equal(replay.response.status,201);assert.equal(replay.body.data.id,first.body.data.id);assert.equal(replay.body.data.formatPolicyVersion,null);assert.equal(replay.body.data.formatPolicyRecorded,false);assert.equal(replay.body.data.expiresAt,first.body.data.expiresAt);
});
test('migration preserves a real schema-25 grant as unknown and subsequently issued grants carry native snapshots',async()=>{
  const f=await operationsFixture({connections:()=>connection,throughSchema:25});const policy=randomUUID(),file=randomUUID(),target=createHash('sha256').update(JSON.stringify([connection.accountId,connection.jurisdiction,connection.bucket])).digest('hex');
  try {
    await f.pg.exec('BEGIN');try {
      await f.pg.query(`INSERT INTO public.approval_requests(academy_id,id,requester_id,requester_kind,credential_snapshot,grants_hash,dependency_hash,review_context,action,target_id,target_version,payload,scope,status,reviewer_id,decided_at,privacy_capability)
       VALUES($1,$2,$3,'human','{}',$4,$4,'{}','storage.policy.set',$1,0,'{}','{}','applied',$3,clock_timestamp(),'storage.view')`,[f.a,policy,f.actors.master.person,'0'.repeat(64)]);
      await f.pg.query("INSERT INTO public.file_storage_policies(academy_id,uploads_enabled,maximum_file_bytes,maximum_reserved_bytes,maximum_files,last_approval_id,allowed_mime_types) VALUES($1,true,100,1000,20,$2,ARRAY['text/plain'])",[f.a,policy]);
      await f.pg.query("INSERT INTO public.file_storage_policy_revisions(academy_id,version,definition,changed_by,approval_id,reason) VALUES($1,1,$2::jsonb,$3,$4,'Synthetic legacy policy')",[f.a,JSON.stringify({uploadsEnabled:true,maximumFileBytes:100,maximumReservedBytes:1000,maximumFiles:20,allowedMimeTypes:['text/plain']}),f.actors.master.person,policy]);
      await f.pg.query("INSERT INTO public.file_records(academy_id,id,anchor_kind,hub_id,domain,name,claimed_mime_type,expected_bytes,search_text,created_by) VALUES($1,$2,'hub',$3,'general','Legacy.txt','text/plain',10,'Legacy',$4)",[f.a,file,f.hub,f.actors.master.person]);
      await f.pg.query("INSERT INTO public.file_record_revisions(academy_id,file_id,version,definition,changed_by,reason) SELECT academy_id,id,version,to_jsonb(f),created_by,'Synthetic legacy file' FROM public.file_records f WHERE id=$1",[file]);await f.pg.exec('COMMIT');
    }catch(error){await f.pg.exec('ROLLBACK');throw error;}
    await f.pg.exec('SET ROLE kavosh_runtime');let old:Record<string,unknown>;try {await f.pg.query("SELECT set_config('app.academy_id',$1,false)",[f.a]);old=(await f.pg.query('SELECT * FROM public.issue_file_upload_grant($1,$2,1,$3)',[file,f.actors.master.person,target])).rows[0];}finally{await f.pg.exec('RESET ROLE');}
    assert.equal('format_policy_version' in old,false);const before=(await f.pg.query('SELECT * FROM public.file_upload_grants')).rows[0];
    await f.pg.exec(await readFile(new URL('../db/migrations/026_upload_policy_provenance.sql',import.meta.url),'utf8'));
    const after=(await f.pg.query('SELECT * FROM public.file_upload_grants')).rows[0];assert.deepEqual(after,{...before,format_policy_version:null,format_policy_snapshot:null});
    // The preservation assertion above tests schema26 exactly. Bring the
    // fixture current before exercising today's API readiness boundary.
    for(const name of (await readdir(new URL('../db/migrations/',import.meta.url))).filter(n=>n.endsWith('.sql')&&Number.parseInt(n,10)>26).sort())await f.pg.exec(await readFile(new URL('../db/migrations/'+name,import.meta.url),'utf8'));
    const issued=await f.request('files/'+file+'/upload-link',{expectedMetadataVersion:1});assert.equal(issued.response.status,201,JSON.stringify(issued.body));assert.equal(issued.body.data.formatPolicyVersion,1);
    const history=await f.request('files/'+file+'/upload-grants');assert.equal(history.body.data.length,2);assert.equal(history.body.data.find((r:{id:unknown})=>r.id===old.id).formatPolicyRecorded,false);assert.deepEqual(history.body.data.find((r:{id:unknown})=>r.id===issued.body.data.id).formatPolicy,{snapshotVersion:1,allowedMimeTypes:['text/plain']});
  }finally{await f.pg.close();}
});
if(process.env.TEST_DATABASE_URL)check('grant policy evidence serializes with a real approved policy change while issuance is waiting on its file lock',async f=>{
  const id=await f.file();await f.pg.exec('BEGIN');let open=true,grant:ReturnType<typeof f.link>|undefined,change:ReturnType<typeof f.request>|undefined;
  async function waitForLocks(count:number){for(let attempt=0;attempt<500;attempt++){
    await f.pg.query('SELECT pg_stat_clear_snapshot()');const rows=await f.pg.query("SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND wait_event_type='Lock'");
    if(rows.rows.length>=count)return;await delay(10);
  }assert.fail('the real API requests must actually wait before release');}
  try {
    await f.pg.query('SELECT id FROM public.file_records WHERE id=$1 FOR UPDATE',[id]);grant=f.link(id);await waitForLocks(1);
    change=f.request('storage-policy',{expectedVersion:1,allowedMimeTypes:['text/plain'],reason:'Approved change waits for in-progress issuance'});await waitForLocks(2);
    await f.pg.exec('COMMIT');open=false;
    const issued=await grant,changed=await change;assert.equal(issued.response.status,201);assert.equal(changed.response.status,200);assert.equal(issued.body.data.formatPolicyVersion,1);
    const history=await f.request('files/'+id+'/upload-grants');assert.deepEqual(history.body.data[0].formatPolicy,{snapshotVersion:1,allowedMimeTypes:['text/plain','application/pdf']});assert.equal((await f.link(id)).body.data.formatPolicyVersion,2);
  }finally{if(open)await f.pg.exec('ROLLBACK');await Promise.allSettled([grant,change]);}
});
