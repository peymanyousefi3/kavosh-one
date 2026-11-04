import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { workFixture } from './work-fixture.ts';

test('salary-policy migration preserves actual old terms and pending payloads instead of inventing historical allocation settings',async()=>{
 const f=await workFixture({throughSchema:57});try{
  const salary=f.components.find(c=>c.code==='ADMIN')!,created=await f.create({components:[salary]});assert.equal(created.response.status,201,JSON.stringify(created.body));const id=created.body.data.id;
  const pending=await f.amend(id,{components:[salary],effectiveOn:'2027-01-01'},'staff');assert.equal(pending.response.status,202,JSON.stringify(pending.body));
  const before=(await f.pg.query('SELECT * FROM public.work_engagement_revisions ORDER BY version')).rows,payload=(await f.pg.query('SELECT payload FROM public.approval_requests WHERE id=$1',[pending.body.approval.id])).rows;
  await f.pg.exec(await readFile(new URL('../db/migrations/058_salary_forecast_allocation.sql',import.meta.url),'utf8'));
  assert.deepEqual((await f.pg.query('SELECT * FROM public.work_engagement_revisions ORDER BY version')).rows,before);assert.deepEqual((await f.pg.query('SELECT payload FROM public.approval_requests WHERE id=$1',[pending.body.approval.id])).rows,payload);
  assert.equal((await f.approve(pending.body.approval.id,'manager')).response.status,200);
  const changed=await f.amend(id,{expectedVersion:2,effectiveOn:'2027-01-01',components:[{...salary,frequency:'year',forecastAllocation:{kind:'calendar_pay_dates'}}]});assert.equal(changed.response.status,200,JSON.stringify(changed.body));
  assert.equal((await f.request('payroll/engagements/'+id+'?version=1')).body.data.components[0].forecastAllocation,undefined);assert.equal(changed.body.data.components[0].forecastAllocation.kind,'calendar_pay_dates');
 }finally{await f.pg.close();}
});

test('native salary policy validation rejects malformed exact pending payloads independently of API validation',async()=>{
 const f=await workFixture();try{
  const salary=f.components.find(c=>c.code==='ADMIN')!,pending=await f.create({components:[salary]},'staff');assert.equal(pending.response.status,202);
  const p=(await f.pg.query<{payload:Record<string,unknown>}>('SELECT payload FROM public.approval_requests WHERE id=$1',[pending.body.approval.id])).rows[0];
  for(const allocation of [{kind:'fixed_divisor',divisor:0,proration:'none'},{kind:'fixed_divisor',divisor:1.5,proration:'none'},{kind:'calendar_pay_dates',proration:null},{kind:'calendar_pay_dates',proration:'none',unexpected:true}]){
   const id=randomUUID(),approval=randomUUID(),payload:Record<string,unknown>={...p.payload,components:[{...(p.payload.components as Record<string,unknown>[])[0],forecastAllocation:allocation}]};
   await f.pg.exec('BEGIN');try{
    await f.pg.query("SELECT set_config('app.academy_id',$1,true)",[f.a]);await f.pg.exec('SET LOCAL ROLE kavosh_runtime');
    await f.pg.query(`INSERT INTO public.approval_requests(academy_id,id,requester_id,requester_kind,credential_snapshot,grants_hash,action,target_id,target_version,payload,scope,dependency_hash,review_context,privacy_capability)
     SELECT academy_id,$2,requester_id,requester_kind,credential_snapshot,grants_hash,action,$3,target_version,$4::jsonb,scope,dependency_hash,review_context,privacy_capability FROM public.approval_requests WHERE id=$1`,[pending.body.approval.id,approval,id,JSON.stringify(payload)]);
    await f.pg.query('INSERT INTO public.work_engagements(academy_id,id,person_id,hub_id,code) VALUES($1,$2,$3,$4,$5)',[f.a,id,f.actors.staff.person,f.hub,payload.code]);
    await assert.rejects(f.pg.query(`INSERT INTO public.work_engagement_revisions(academy_id,engagement_id,version,effective_on,currency_id,currency_version,unit_scale,employer_id,employer_version,payee_id,payee_version,definition,components,source_snapshot,changed_by,approval_id,reason) VALUES($1,$2,1,$3,$4,1,2,$5,1,$6,1,$7::jsonb,$8::jsonb,'{}'::jsonb,$9,$10,$11)`,[f.a,id,payload.effectiveOn,f.currency.id,f.employer.id,f.payee.id,JSON.stringify(payload.definition),JSON.stringify(payload.components),f.actors.master.person,approval,payload.reason]),/WORK_SALARY_ALLOCATION_INVALID/);
   }finally{await f.pg.exec('ROLLBACK');}
  }
 }finally{await f.pg.close();}
});
