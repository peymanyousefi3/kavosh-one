import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { operationsFixture } from './operations-fixture.ts';

test('completion status contracts are read-only and accept only bounded history paging',()=>{
 const api=JSON.parse(readFileSync(new URL('../public/openapi.json',import.meta.url),'utf8'));
 for(const prefix of ['signature-send-requests','payroll/work-signature-send-requests']){
  const path=api.paths['/api/v1/'+prefix+'/{id}/completion-check'];assert.deepEqual(Object.keys(path),['get']);
  const params=path.get.parameters.filter((p:{in:string})=>p.in==='query');assert.deepEqual(params.map((p:{name:string})=>p.name).sort(),['afterAttempt','limit']);
  assert.equal(params.find((p:{name:string})=>p.name==='limit').schema.maximum,50);
  assert.equal(params.find((p:{name:string})=>p.name==='afterAttempt').schema.minimum,0);
 }
});

test('completion status has no service identity/lease grants and cannot cross the tenant boundary',async()=>{
 const f=await operationsFixture();try{
  const connection=randomUUID(),start=randomUUID();
  await f.pg.query("INSERT INTO public.signature_connections(academy_id,id,region,environment,enabled) VALUES($1,$2,'CA','Test',true)",[f.b,connection]);
  // A fake fixture-only unbound job must never become an API-owned intention.
  await f.pg.query("INSERT INTO public.signature_completion_jobs(academy_id,purpose,start_id,connection_id,document_id,source_fingerprint,poll_until) VALUES($1,'unified_enrollment',$2,$3,$4,$5,clock_timestamp()+interval '1 day')",[f.b,start,connection,randomUUID(),'a'.repeat(64)]);
  await f.pg.exec('SET ROLE kavosh_runtime');try{
   await f.pg.query("SELECT set_config('app.academy_id',$1,false)",[f.a]);
   assert.equal((await f.pg.query('SELECT start_id,state FROM public.signature_completion_jobs')).rows.length,0);
   for(const column of ['worker_id','lease_token','source_fingerprint','connection_id','document_id','priority'])await assert.rejects(f.pg.query('SELECT '+column+' FROM public.signature_completion_jobs'),/permission denied/i);
   await assert.rejects(f.pg.query('SELECT * FROM public.signature_completion_jobs'),/permission denied/i);
   await assert.rejects(f.pg.query("UPDATE public.signature_completion_jobs SET state='blocked'"),/permission denied/i);
   await assert.rejects(f.pg.query('SELECT public.finish_signature_completion_job($1,$2,$3,$4,$5,$6,60)',[f.a,'unified_enrollment',start,randomUUID(),'not_completed',null]),/permission denied/i);
  }finally{await f.pg.exec('RESET ROLE');}
  for(const prefix of ['signature-send-requests','payroll/work-signature-send-requests']){
   const path=prefix+'/'+start+'/completion-check';assert.equal((await f.request(path)).response.status,404);
   for(const suffix of ['?limit=0','?limit=1&limit=2','?afterAttempt=-1','?actorId='+randomUUID()])assert.equal((await f.request(path+suffix)).response.status,400);
   assert.equal((await f.request(path,{})).response.status,405);
  }
 }finally{await f.pg.close();}
});
