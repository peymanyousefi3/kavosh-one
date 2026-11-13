import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { operationsFixture } from './operations-fixture.ts';
import { upgradeToCurrent } from './migration-upgrade.ts';

test('actual392to393 preserves old blocked queues and broker identity without reconstructing incidents or alerts',async()=>{
 const f=await operationsFixture({throughSchema:392});try{
  const connection=randomUUID(),start=randomUUID();await f.pg.query("INSERT INTO public.signature_connections(academy_id,id,region,environment,enabled) VALUES($1,$2,'CA','Test',true)",[f.a,connection]);
  await f.pg.query("INSERT INTO public.signature_completion_jobs(academy_id,purpose,start_id,connection_id,document_id,source_fingerprint,poll_until,state,last_outcome) VALUES($1,'worker_services',$2,$3,$4,$5,clock_timestamp()-interval '1 day','blocked','source_changed')",[f.a,start,connection,randomUUID(),'a'.repeat(64)]);
  const before=(await f.pg.query('SELECT to_jsonb(j) data FROM public.signature_completion_jobs j')).rows;
  const broker=()=>f.pg.query("SELECT oid,proowner,proacl FROM pg_proc WHERE oid IN('public.claim_signature_completion_job(uuid[],uuid,integer)'::regprocedure,'public.finish_signature_completion_job(uuid,text,uuid,uuid,text,uuid,integer)'::regprocedure) ORDER BY oid"),identity=(await broker()).rows;
  await f.pg.exec(readFileSync(new URL('../db/migrations/393_signature_completion_incidents.sql',import.meta.url),'utf8'));
  assert.deepEqual((await f.pg.query("SELECT to_jsonb(j)-'blocked_origin_transaction' data FROM public.signature_completion_jobs j")).rows,before);assert.deepEqual((await broker()).rows,identity);
  assert.equal((await f.pg.query('SELECT * FROM public.signature_completion_incidents')).rows.length,0);assert.equal((await f.pg.query('SELECT blocked_origin_transaction FROM public.signature_completion_jobs')).rows[0].blocked_origin_transaction,null);
  await upgradeToCurrent(f.pg);await f.pg.exec('SET ROLE kavosh_runtime');try{
   await f.pg.query("SELECT set_config('app.academy_id',$1,false)",[f.a]);
   await assert.rejects(f.pg.query('SELECT blocked_origin_transaction FROM public.signature_completion_jobs'),/permission denied/);
   await assert.rejects(f.pg.query('SELECT origin_transaction FROM public.signature_completion_incidents'),/permission denied/);
   await assert.rejects(f.pg.query("INSERT INTO public.outbox_events(academy_id,id,event_type,entity_id,request_id) VALUES($1,$2,'work.signature.completion.check.blocked.critical',$3,$3)",[f.a,randomUUID(),start]),/SIGNATURE_COMPLETION_INCIDENT_ORIGIN_REQUIRED/);
   await assert.rejects(f.pg.query('INSERT INTO public.signature_completion_incidents(academy_id,id,purpose,start_id,retry_version,attempt_no,reason_code) VALUES($1,$2,$3,$4,0,0,$5)',[f.a,randomUUID(),'worker_services',start,'source_changed']),/permission denied/);
  }finally{await f.pg.exec('RESET ROLE');}
  assert.equal((await f.pg.query('SELECT * FROM public.signature_completion_incidents')).rows.length,0);
 }finally{await f.pg.close();}
});
test('completion incident history is read-only, bounded and has no resolution or provider-authority overrides',()=>{
 const api=JSON.parse(readFileSync(new URL('../public/openapi.json',import.meta.url),'utf8'));
 for(const prefix of ['signature-send-requests','payroll/work-signature-send-requests']){
  const path=api.paths['/api/v1/'+prefix+'/{id}/completion-check/incidents'];assert.deepEqual(Object.keys(path),['get']);
  const query=path.get.parameters.filter((p:{in:string})=>p.in==='query');assert.deepEqual(query.map((p:{name:string})=>p.name).sort(),['after','limit']);assert.equal(query.find((p:{name:string})=>p.name==='limit').schema.maximum,50);
 }
});
