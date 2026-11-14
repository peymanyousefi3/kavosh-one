import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { featureScope,scopeFor,type Scope,type Capability } from '../src/core/policy.ts';
import { operationsFixture } from './operations-fixture.ts';
import { upgradeToCurrent } from './migration-upgrade.ts';

test('retry permissions preserve exact source scopes without borrowing review authority',()=>{
 const hub=randomUUID(),person=randomUUID(),scope:Scope={all:false,hubs:[],people:[{id:person,hubId:hub}],classes:[{id:randomUUID(),hubId:hub}],excludedPeople:[{id:randomUUID(),hubId:hub}]};
 for(const [retry,review] of [['signature-completions.retry','signature-completions.review'],['work-signature-completions.retry','work-signature-completions.review']] as [Capability,Capability][]){
  assert.deepEqual(featureScope(scope,retry),featureScope(scope,review));
  const credential={person_id:person,capabilities:[retry,review],all_hubs:true,hub_ids:[]},grant={capability:retry,effect:'allow' as const,allHubs:false,hubIds:[],personRefs:[{id:person,hubId:hub}]};
  assert.deepEqual(scopeFor(credential,[grant],retry).people,[{id:person,hubId:hub}]);assert.deepEqual(scopeFor(credential,[grant],review),{all:false,hubs:[]});
 }
});
test('retry contracts require an explicit operational window and forbid signer,approval or resend overrides',()=>{
 const api=JSON.parse(readFileSync(new URL('../public/openapi.json',import.meta.url),'utf8'));
 for(const prefix of ['signature-send-requests','payroll/work-signature-send-requests']){
  const path=api.paths['/api/v1/'+prefix+'/{id}/completion-check/retries'],schema=path.post.requestBody.content['application/json'].schema;
  assert.equal(schema.additionalProperties,false);assert.deepEqual(Object.keys(schema.properties).sort(),['checkWindowDays','expectedVersion','reason']);assert.equal(schema.properties.checkWindowDays.maximum,30);assert.ok(schema.required.includes('checkWindowDays'));assert.ok(path.get);
 }
});
test('actual391to392 preserves queue history and private broker identity without inventing approved retries',async()=>{
 const f=await operationsFixture({throughSchema:391});try{
  const connection=randomUUID(),start=randomUUID();await f.pg.query("INSERT INTO public.signature_connections(academy_id,id,region,environment,enabled) VALUES($1,$2,'CA','Test',true)",[f.a,connection]);
  await f.pg.query("INSERT INTO public.signature_completion_jobs(academy_id,purpose,start_id,connection_id,document_id,source_fingerprint,poll_until) VALUES($1,'worker_services',$2,$3,$4,$5,clock_timestamp()+interval '1 day')",[f.a,start,connection,randomUUID(),'a'.repeat(64)]);
  const before=(await f.pg.query('SELECT to_jsonb(j) value FROM public.signature_completion_jobs j')).rows;
  const identity=()=>f.pg.query("SELECT oid,proowner,proacl FROM pg_proc WHERE oid IN('public.claim_signature_completion_job(uuid[],uuid,integer)'::regprocedure,'public.finish_signature_completion_job(uuid,text,uuid,uuid,text,uuid,integer)'::regprocedure) ORDER BY oid"),functions=(await identity()).rows;
  await f.pg.exec(readFileSync(new URL('../db/migrations/392_signature_completion_retries.sql',import.meta.url),'utf8'));assert.deepEqual((await f.pg.query("SELECT to_jsonb(j)-'retry_version' value FROM public.signature_completion_jobs j")).rows,before);assert.deepEqual((await identity()).rows,functions);await upgradeToCurrent(f.pg);
  assert.deepEqual((await f.pg.query('SELECT retry_version FROM public.signature_completion_jobs')).rows,[{retry_version:0}]);assert.equal((await f.pg.query('SELECT * FROM public.signature_completion_retries')).rows.length,0);
  await f.pg.exec('SET ROLE kavosh_runtime');try{
   await f.pg.query("SELECT set_config('app.academy_id',$1,false)",[f.a]);assert.equal((await f.pg.query('SELECT public.signature_completion_retry_source($1,$2) source',['worker_services',start])).rows[0].source,null,'unbound fixture metadata is not retry authority');
   await assert.rejects(f.pg.query("UPDATE public.signature_completion_jobs SET state='queued'"),/permission denied/);
   await assert.rejects(f.pg.query('SELECT source FROM public.signature_completion_retries'),/permission denied/);
   await assert.rejects(f.pg.query('INSERT INTO public.signature_completion_retries(academy_id,purpose,start_id,version,approval_id,input,source,requested_by,changed_by) VALUES($1,$2,$3,1,$4,$5::jsonb,$6::jsonb,$7,$7)',[f.a,'worker_services',start,randomUUID(),'{}','{}',f.actors.master.person]),/SIGNATURE_COMPLETION_RETRY_EXACT_APPROVAL_REQUIRED/);
   assert.equal((await f.pg.query('SELECT retry_version FROM public.signature_completion_jobs')).rows[0].retry_version,0);
  }finally{await f.pg.exec('RESET ROLE');}
 }finally{await f.pg.close();}
});
