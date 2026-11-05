import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Temporal } from '@js-temporal/polyfill';
import { salaryServiceEarnings } from '../src/core/salary-service-earnings.ts';
import { validateCompensationRules,type CompensationRule } from '../src/core/work-compensation.ts';
import { payrollSalaryPlan } from '../src/modules/payroll-salary-plan.ts';
import type { PayrollPreparationSource } from '../src/modules/payroll-preparations.ts';
import { sessionEvidenceCapabilities } from '../src/modules/session-evidence-report.ts';
import { workFixture } from './work-fixture.ts';

function rule(patch:Record<string,unknown>={}){return validateCompensationRules([{code:'ADMIN',kind:'salary',from:'1900-01-01',amount:'3000',frequency:'month',earningBasis:'calendar_days',...patch}],2)[0] as Extract<CompensationRule,{kind:'salary'}>;}
const amount=(r:ReturnType<typeof rule>,from:string,through:string)=>salaryServiceEarnings(r,{from,through},2).gross.amount;
test('salary earning basis is explicit and independent of forecast slots or configured pay dates',()=>{
 assert.throws(()=>amount(rule({earningBasis:undefined,forecastAllocation:{kind:'fixed_divisor',divisor:2}}),'2026-01-01','2026-01-31'),/SALARY_EARNING_POLICY_REQUIRED/);
 for(const earningBasis of [null,'guess','working_days',{},1])assert.throws(()=>rule({earningBasis}));
 for(const [frequency,earningBasis] of [['pay_period','calendar_days'],['pay_period','whole_reference_period'],['year','whole_service_period'],['month','whole_service_period']])assert.throws(()=>rule({frequency,earningBasis}));
 const r=rule({forecastAllocation:{kind:'fixed_divisor',divisor:99}}),v=salaryServiceEarnings(r,{from:'2026-01-01',through:'2026-01-31'},2);assert.equal(v.gross.amount,'3000.00');assert.equal(v.forecastAllocationUsed,false);assert.equal(v.claimsPersisted,false);assert.equal(v.wagesAccrued,false);assert.equal(v.earnedEntitlementDetermined,false);
});
test('monthly salary cumulative fractions conserve pennies across every adjacent daily split',()=>{
 for(const month of ['2026-01','2026-02','2028-02','2026-11']){
  const first=Temporal.PlainDate.from(month+'-01'),last=first.with({day:first.daysInMonth}).toString();
  for(const n of ['0.01','0.02','1','3000','999999999999999999999999999999999999.99']){
   const r=rule({amount:n}),full=salaryServiceEarnings(r,{from:first.toString(),through:last},2);
   const daily=Array.from({length:first.daysInMonth},(_,i)=>{const on=first.add({days:i}).toString();return BigInt(salaryServiceEarnings(r,{from:on,through:on},2).gross.minor);});
   assert.equal(daily.reduce((n,v)=>n+v,0n).toString(),full.gross.minor);
  }
 }
 assert.equal(amount(rule(),'2026-01-01','2026-01-15'),'1451.61');assert.equal(amount(rule(),'2026-01-16','2026-01-31'),'1548.39');
});
test('annual salary uses leap-aware civil days and exact endpoint differences, including final supported year',()=>{
 const r=rule({amount:'366',frequency:'year'});assert.equal(amount(r,'2028-02-29','2028-02-29'),'1.00');assert.equal(amount(r,'2028-01-01','2028-12-31'),'366.00');assert.equal(amount(r,'2026-01-01','2026-12-31'),'366.00');assert.equal(amount(r,'9999-01-01','9999-12-31'),'366.00');
 const zero=rule({amount:'0'});assert.equal(amount(zero,'2026-03-08','2026-03-08'),'0.00');
});
test('whole reference and whole service policies refuse to silently prorate their indivisible earning basis',()=>{
 const r=rule({earningBasis:'whole_reference_period'});assert.equal(amount(r,'2026-01-01','2026-02-28'),'6000.00');assert.throws(()=>amount(r,'2026-01-02','2026-01-31'),/SALARY_FULL_REFERENCE_PERIOD_REQUIRED/);
 assert.throws(()=>amount(rule({frequency:'year',earningBasis:'whole_reference_period'}),'2026-01-01','2026-01-31'),/SALARY_FULL_REFERENCE_PERIOD_REQUIRED/);
 const p=rule({frequency:'pay_period',earningBasis:'whole_service_period'});assert.equal(amount(p,'2026-01-01','2026-01-15'),'3000.00');
 assert.throws(()=>amount(rule({from:'2026-01-05'}),'2026-01-01','2026-01-31'),/SALARY_COMPONENT_NOT_EFFECTIVE/);assert.throws(()=>amount(rule({through:'2026-01-15'}),'2026-01-01','2026-01-31'),/SALARY_COMPONENT_NOT_EFFECTIVE/);
 for(const range of [['2026-02-30','2026-03-01'],['2026-02-01','2026-01-01'],['2026-01-01','2028-01-01']])assert.throws(()=>amount(rule(),range[0],range[1]));
});
function source():PayrollPreparationSource{return {sourceVersion:1,personId:'worker',from:'2026-01-01',through:'2026-01-31',timeZone:'America/Toronto',windowStartMilliseconds:'0',windowEndMilliseconds:'1',oversized:false,work:[{id:'work',person_id:'worker',hub_id:null,version:1}],entries:[],terms:[{engagement_id:'work',person_id:'worker',version:1,effective_on:'2026-01-01',currency_id:'CAD',currency_code:'CAD',unit_scale:2,active:true,starts_on:'2026-01-01',ends_on:null,time_zone:'America/Toronto',components:[rule()]}],periods:[{id:'period',engagement_id:'work',version:1,work_version:1,definition:{from:'2026-01-01',through:'2026-01-31',payOn:'2026-02-15',active:true}}]};}
test('source salary plans follow effective service-day revisions rather than payment date terms',()=>{
 const s=source();s.work[0].version=2;s.periods[0].work_version=2;s.terms.push({...s.terms[0],version:2,effective_on:'2026-01-16',components:[rule({amount:'6000'})]});
 const p=payrollSalaryPlan(s);assert.deepEqual(p.plans.map(p=>p.termsVersion),[1,2]);assert.deepEqual(p.plans.map(p=>p.calculation.gross.amount),['1451.61','3096.77']);assert.equal(p.currencies[0].configuredTotal?.amount,'4548.38');assert.equal(p.plans[0].payOn,'2026-02-15');assert.equal(p.sourceCapacityVerified,false);
 s.terms.push({...s.terms[0],version:3,effective_on:'2026-02-01',unit_scale:18,components:[rule({amount:'9000'})]});assert.deepEqual(payrollSalaryPlan(s),p);
 const reversed={...s,terms:[...s.terms].reverse()};assert.deepEqual(payrollSalaryPlan(reversed),p);
});
test('salary plans retain per-currency precision and require fresh reviewed periods with no incomplete totals',()=>{
 const s=source();s.work[0].version=2;s.periods[0].work_version=2;s.terms.push({...s.terms[0],version:2,effective_on:'2026-01-16',currency_id:'USD',currency_code:'USD',unit_scale:3,components:[rule({amount:'6000'})]});
 const p=payrollSalaryPlan(s);assert.equal(p.currencies.find(c=>c.currencyId==='CAD')!.configuredTotal?.amount,'1451.61');assert.equal(p.currencies.find(c=>c.currencyId==='USD')!.configuredTotal?.amount,'3096.774');
 s.periods[0].work_version=1;const stale=payrollSalaryPlan(s);assert.equal(stale.plans.length,0);assert.equal(stale.unpricedComponents[0].reason,'SALARY_SERVICE_PERIOD_WORK_REVIEW_REQUIRED');assert.equal(stale.completeSalaryCoverage,false);
 s.periods[0].work_version=2;s.terms[1].components=[rule({earningBasis:undefined})];const unresolved=payrollSalaryPlan(s);assert.equal(unresolved.currencies.find(c=>c.currencyId==='USD')!.configuredTotal,null);assert.equal(unresolved.unpricedComponents[0].reason,'SALARY_EARNING_POLICY_REQUIRED');
});
test('salary service and full-reference components cannot be duplicated by splitting revisions, report windows or inactive periods',()=>{
 const s=source();s.terms[0].components=[rule({frequency:'pay_period',earningBasis:'whole_service_period'})];assert.equal(payrollSalaryPlan(s).plans[0].calculation.gross.amount,'3000.00');
 s.from='2026-01-02';assert.equal(payrollSalaryPlan(s).unpricedComponents[0].reason,'SALARY_FULL_SERVICE_PERIOD_REQUIRED');s.from='2026-01-01';
 s.terms.push({...s.terms[0],version:2,effective_on:'2026-01-16'});assert.equal(payrollSalaryPlan(s).plans.length,0);assert.equal(payrollSalaryPlan(s).unpricedComponents.length,2);
 s.periods[0].definition.active=false;assert.equal(payrollSalaryPlan(s).plans.length,0);assert.ok(payrollSalaryPlan(s).unpricedComponents.every(i=>i.reason==='SALARY_SERVICE_PERIOD_REQUIRED'));
});
test('bounded synchronous salary plans reject excess work instead of silently truncating payable sources',()=>{
 const s=source();s.through='2026-12-31';s.periods=Array.from({length:111},(_,i)=>({...s.periods[0],id:'p'+i,definition:{...s.periods[0].definition,through:'2026-12-31'}}));assert.throws(()=>payrollSalaryPlan(s),/PAYROLL_PREPARATION_REQUIRES_BACKGROUND_JOB/);
});
test('gaps between service periods and another unperiodized salary never masquerade as complete currency totals',()=>{
 const s=source();s.periods[0].definition.through='2026-01-15';const first=payrollSalaryPlan(s);assert.equal(first.plans[0].calculation.gross.amount,'1451.61');assert.equal(first.unpricedComponents[0].reason,'SALARY_SERVICE_PERIOD_REQUIRED');assert.equal(first.currencies[0].configuredTotal,null);
 s.periods.push({...s.periods[0],id:'second',definition:{...s.periods[0].definition,from:'2026-01-16',through:'2026-01-31'}});assert.equal(payrollSalaryPlan(s).currencies[0].configuredTotal?.amount,'3000.00');assert.equal(payrollSalaryPlan(s).unpricedComponents.length,0);
 s.work.push({...s.work[0],id:'other'});s.terms.push({...s.terms[0],engagement_id:'other'});const missing=payrollSalaryPlan(s);assert.equal(missing.plans.length,2);assert.equal(missing.unpricedComponents[0].engagementId,'other');assert.equal(missing.currencies[0].configuredTotal,null);
});
test('same-day later revisions win, separate salary codes add, and hourly-only periods generate no false salary issues',()=>{
 const s=source();s.terms.push({...s.terms[0],version:2,components:[rule({amount:'4000'}),rule({code:'EXTRA',amount:'100'})]});const p=payrollSalaryPlan(s);assert.equal(p.plans.length,2);assert.deepEqual(p.plans.map(p=>p.termsVersion),[2,2]);assert.equal(p.currencies[0].configuredTotal?.amount,'4100.00');
 s.terms=s.terms.map(t=>({...t,components:validateCompensationRules([{code:'H',kind:'hourly',from:'2026-01-01',amount:'20'}],2)}));s.work[0].version=99;const hourly=payrollSalaryPlan(s);assert.equal(hourly.plans.length,0);assert.equal(hourly.unpricedComponents.length,0);
});

async function fixture(options:{throughSchema?:number}={}){const f=await workFixture(options);try{
 for(const role of [f.staffRole,f.managerRole])for(const cap of ['work-pay.view','pay-periods.view','payroll-preparations.view','payroll-preparations.edit',...sessionEvidenceCapabilities,'session-evidence.view'])await f.pg.query("INSERT INTO public.role_permissions VALUES($1,$2,$3,'allow') ON CONFLICT DO NOTHING",[f.a,role,cap]);
 const create=(earningBasis:unknown='calendar_days')=>f.create({components:[{...f.components[0],...earningBasis===undefined?{}:{earningBasis}}]});
 const period=(id:string,version=1,patch:Record<string,unknown>={})=>f.request('payroll/pay-periods',{engagementId:id,workVersion:version,code:'JAN',definition:{from:'2026-01-01',through:'2026-01-31',payOn:'2026-02-15',active:true,timingReview:'PRIVATE explicit service dates'},reason:'PRIVATE salary service review',...patch});
 const prepare=(as='master',key?:string,patch:Record<string,unknown>={})=>f.request('payroll/preparations',{personId:f.actors.staff.person,from:'2026-01-01',through:'2026-01-31',timeZone:'America/Toronto',label:'Salary source preparation',...patch},as,{key});
 return {...f,createSalary:create,period,prepare};
 }catch(e){await f.pg.close();throw e;}}
type Fixture=Awaited<ReturnType<typeof fixture>>;
function check(name:string,run:(f:Fixture)=>Promise<void>){test(name,async()=>{const f=await fixture();try{await run(f);}finally{await f.pg.close();}});}
check('reviewed salary policy and service periods persist through real preparation APIs without sessions or duplicated wages',async f=>{
 const e=await f.createSalary();assert.equal(e.response.status,201,JSON.stringify(e.body));const id=e.body.data.id;assert.equal(e.body.data.components[0].earningBasis,'calendar_days');
 const period=await f.period(id);assert.equal(period.response.status,201);const p=await f.prepare('manager');assert.equal(p.response.status,201,JSON.stringify(p.body));const d=p.body.data,s=d.calculation.salary;
 assert.equal(s.plans[0].calculation.gross.amount,'3000.00');assert.equal(s.plans[0].serviceFrom,'2026-01-01');assert.equal(s.plans[0].payOn,'2026-02-15');assert.equal(s.currencies[0].knownConfiguredSubtotal.amount,'3000.00');assert.equal(d.calculation.currencies.length,0);assert.equal(d.calculation.wagesAccrued,false);assert.equal(s.sourceCapacityVerified,false);
 assert.doesNotMatch(JSON.stringify(s),/PRIVATE|Private legal|classificationBasis|taxReview|source_snapshot/);assert.equal((await f.pg.query('SELECT * FROM public.finance_journals')).rows.length,0);assert.equal((await f.pg.query('SELECT * FROM public.payroll_hourly_claims')).rows.length,0);
 const old=(await f.pg.query('SELECT source_snapshot FROM public.payroll_preparations WHERE id=$1',[d.id])).rows[0];assert.equal((await f.amend(id,{components:[{...f.components[0],amount:'6000',earningBasis:'calendar_days'}]})).response.status,200);
 const retained=(await f.request('payroll/preparations/'+d.id)).body.data;assert.equal(retained.sourcesCurrent,false);assert.equal(retained.calculation.salary.plans[0].calculation.gross.amount,'3000.00');assert.deepEqual((await f.pg.query('SELECT source_snapshot FROM public.payroll_preparations WHERE id=$1',[d.id])).rows[0],old);
 const next=await f.prepare();assert.equal(next.response.status,201);assert.equal(next.body.data.calculation.salary.plans.length,0);assert.equal(next.body.data.calculation.salary.unpricedComponents[0].reason,'SALARY_SERVICE_PERIOD_WORK_REVIEW_REQUIRED');
 const reviewed=await f.request('payroll/pay-periods/'+period.body.data.id+'/change',{expectedVersion:1,workVersion:2,definition:period.body.data.definition,reason:'PRIVATE review amended salary service sources'});assert.equal(reviewed.response.status,200,JSON.stringify(reviewed.body));const current=await f.prepare();assert.equal(current.response.status,201);assert.equal(current.body.data.calculation.salary.plans[0].calculation.gross.amount,'6000.00');assert.equal(current.body.data.calculation.salary.plans[0].servicePeriodVersion,2);
});
check('salary preparation clips approved calendar-day service while conserving the complete monthly amount',async f=>{
 const e=await f.createSalary();assert.equal(e.response.status,201);assert.equal((await f.period(e.body.data.id)).response.status,201);
 const left=await f.prepare('master',undefined,{through:'2026-01-15'}),right=await f.prepare('master',undefined,{from:'2026-01-16'});assert.equal(left.body.data.calculation.salary.plans[0].calculation.gross.amount,'1451.61');assert.equal(right.body.data.calculation.salary.plans[0].calculation.gross.amount,'1548.39');
});
check('missing policy or reviewed salary period stays explicitly unresolved rather than borrowing a forecast rule',async f=>{
 const e=await f.create({components:[{...f.components[0],forecastAllocation:{kind:'fixed_divisor',divisor:2}}]});assert.equal(e.response.status,201);const noPeriod=await f.prepare();assert.equal(noPeriod.response.status,201);assert.equal(noPeriod.body.data.calculation.salary.plans.length,0);assert.equal(noPeriod.body.data.calculation.salary.completeSalaryCoverage,false);assert.equal(noPeriod.body.data.calculation.salary.unpricedComponents[0].reason,'SALARY_SERVICE_PERIOD_REQUIRED');
 assert.equal((await f.period(e.body.data.id)).response.status,201);const r=await f.prepare();assert.equal(r.response.status,201);assert.equal(r.body.data.calculation.salary.unpricedComponents[0].reason,'SALARY_EARNING_POLICY_REQUIRED');assert.equal(r.body.data.calculation.salary.currencies[0].configuredTotal,null);
});
check('salary source scopes, finite bot ceilings and cross-school isolation remain enforced before calculation or receipt replay',async f=>{
 const e=await f.createSalary();assert.equal(e.response.status,201);assert.equal((await f.period(e.body.data.id)).response.status,201);const key=randomUUID(),p=await f.prepare('manager',key);assert.equal(p.response.status,201);
 assert.equal((await f.request('payroll/preparations/'+p.body.data.id,undefined,'foreignMaster',{academy:f.b})).response.status,404);
 const caps=['work-pay.view','pay-periods.view','payroll-preparations.view','payroll-preparations.edit',...sessionEvidenceCapabilities,'session-evidence.view'],role=await f.made('roles',{name:'Salary preparation bot',permissions:caps.map(capability=>({capability,effect:'allow'}))}),path='people/'+f.bot+'/access',previous=(await f.request(path)).body.data;
 assert.equal((await f.request(path,{expectedVersion:previous.version,assignments:[{roleId:role.id,allHubs:true}]})).response.status,200);const botKey=randomUUID();assert.equal((await f.prepare('bot',botKey)).response.status,201);
 await f.pg.query('UPDATE auth_private.credentials SET all_hubs=false WHERE id=$1',[f.credential]);await f.pg.query('INSERT INTO auth_private.credential_hubs(credential_id,academy_id,hub_id) VALUES($1,$2,$3)',[f.credential,f.a,f.otherHub]);assert.equal((await f.prepare('bot',botKey)).response.status,404);assert.deepEqual((await f.request('payroll/preparations',undefined,'bot')).body.data,[]);
 await f.pg.query("DELETE FROM public.role_permissions WHERE role_id=$1 AND capability='work-pay.view'",[f.managerRole]);assert.equal((await f.prepare('manager',key)).response.status,403);
 assert.equal((await f.create({hubId:f.otherHub,code:'HIDDEN-SALARY',components:[{...f.components[0],earningBasis:'calendar_days'}]})).response.status,201);await f.pg.query("INSERT INTO public.role_permissions VALUES($1,$2,'work-pay.view','allow')",[f.a,f.managerRole]);assert.equal((await f.prepare('manager')).response.status,404);
});
test('schema99 to100 preserves old salary and pending exact work terms without inventing an earned policy',async()=>{
 const f=await fixture({throughSchema:99});try{
  const e=await f.create({components:[f.components[0]]});assert.equal(e.response.status,201);const id=e.body.data.id;assert.equal((await f.period(id)).response.status,201);const p=await f.prepare();assert.equal(p.response.status,201);const pending=await f.amend(id,{components:[f.components[0]],effectiveOn:'2027-01-01'},'staff');assert.equal(pending.response.status,202);
  const snapshot=async()=>({work:(await f.pg.query('SELECT to_jsonb(r) r FROM public.work_engagement_revisions r ORDER BY engagement_id,version')).rows,pending:(await f.pg.query('SELECT payload,review_context FROM public.approval_requests WHERE id=$1',[pending.body.approval.id])).rows,preparation:(await f.pg.query('SELECT source_snapshot FROM public.payroll_preparations WHERE id=$1',[p.body.data.id])).rows});const before=await snapshot();
  await f.pg.exec(await readFile(new URL('../db/migrations/100_salary_earning_basis.sql',import.meta.url),'utf8'));assert.equal((await f.pg.query('SELECT public.schema_revision() n')).rows[0].n,100);assert.deepEqual(await snapshot(),before);
  assert.equal((await f.request('payroll/preparations/'+p.body.data.id)).body.data.calculation.salary.unpricedComponents[0].reason,'SALARY_EARNING_POLICY_REQUIRED');assert.equal((await f.approve(pending.body.approval.id)).response.status,200);
  assert.equal((await f.amend(id,{expectedVersion:2,components:[{...f.components[0],earningBasis:'calendar_days'}]})).response.status,200);
 }finally{await f.pg.close();}
});
check('native work terms independently reject invalid earning policy even with an exact pending salary payload',async f=>{
 const pending=await f.create({components:[f.components[0]]},'staff');assert.equal(pending.response.status,202);const prior=(await f.pg.query<{payload:any}>('SELECT payload FROM public.approval_requests WHERE id=$1',[pending.body.approval.id])).rows[0].payload;
 for(const policy of [{earningBasis:'guess'},{earningBasis:{}},{earningBasis:null},{frequency:'pay_period',earningBasis:'calendar_days'},{frequency:'month',earningBasis:'whole_service_period'}]){
  const id=randomUUID(),approval=randomUUID(),payload={...prior,components:[{...prior.components[0],...policy}]};
  await f.pg.exec('BEGIN');try{
   await f.pg.query("SELECT set_config('app.academy_id',$1,true)",[f.a]);await f.pg.exec('SET LOCAL ROLE kavosh_runtime');
   await f.pg.query(`INSERT INTO public.approval_requests(academy_id,id,requester_id,requester_kind,credential_snapshot,grants_hash,action,target_id,target_version,payload,scope,dependency_hash,review_context,privacy_capability) SELECT academy_id,$2,requester_id,requester_kind,credential_snapshot,grants_hash,action,$3,target_version,$4::jsonb,scope,dependency_hash,review_context,privacy_capability FROM public.approval_requests WHERE id=$1`,[pending.body.approval.id,approval,id,JSON.stringify(payload)]);
   await f.pg.query('INSERT INTO public.work_engagements(academy_id,id,person_id,hub_id,code) VALUES($1,$2,$3,$4,$5)',[f.a,id,f.actors.staff.person,f.hub,payload.code]);
   await assert.rejects(f.pg.query(`INSERT INTO public.work_engagement_revisions(academy_id,engagement_id,version,effective_on,currency_id,currency_version,unit_scale,employer_id,employer_version,payee_id,payee_version,definition,components,source_snapshot,changed_by,approval_id,reason) VALUES($1,$2,1,$3,$4,1,2,$5,1,$6,1,$7::jsonb,$8::jsonb,'{}'::jsonb,$9,$10,$11)`,[f.a,id,payload.effectiveOn,f.currency.id,f.employer.id,f.payee.id,JSON.stringify(payload.definition),JSON.stringify(payload.components),f.actors.master.person,approval,payload.reason]),/WORK_SALARY_EARNING_BASIS_INVALID|WORK_COMPONENT_DATES_INVALID/);
  }finally{await f.pg.exec('ROLLBACK');}
 }
 assert.equal((await f.pg.query('SELECT * FROM public.work_engagements')).rows.length,0);
});
test('two identical native salary preparations retain one immutable source and receipt without posting wages',async t=>{
 const f=await fixture();try{
  if(!f.pg.runtime){t.skip('Requires independent native connections');return;}
  const e=await f.createSalary();assert.equal(e.response.status,201);assert.equal((await f.period(e.body.data.id)).response.status,201);const key=randomUUID(),results=await Promise.all([f.prepare('master',key),f.prepare('master',key)]);assert.deepEqual(results.map(r=>r.response.status),[201,201]);assert.deepEqual(results[0].body,results[1].body);assert.equal((await f.pg.query('SELECT * FROM public.payroll_preparations')).rows.length,1);assert.equal((await f.pg.query('SELECT * FROM public.finance_journals')).rows.length,0);
 }finally{await f.pg.close();}
});
