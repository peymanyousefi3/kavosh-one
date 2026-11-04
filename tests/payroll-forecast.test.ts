import assert from 'node:assert/strict';
import { test } from 'node:test';
import { workFixture } from './work-fixture.ts';
import { payrollForecast } from '../src/modules/payroll-forecast.ts';
import type { ApiContext } from '../src/core/api.ts';

async function fixture(){const f=await workFixture();try{
 for(const role of [f.staffRole,f.managerRole])for(const cap of ['financial-reports.view','classes.view','rosters.view'])await f.pg.query("INSERT INTO public.role_permissions VALUES($1,$2,$3,'allow') ON CONFLICT DO NOTHING",[f.a,role,cap]);
 const forecast=(query='from=2027-01-01&through=2027-01-31&timeZone=America%2FToronto',as='master')=>f.request('reports/payroll/scheduled-costs?'+query,undefined,as);
 const hourly=f.components.find(c=>c.code==='TEACH')!,salary=f.components.find(c=>c.code==='ADMIN')!;
 return {...f,forecast,hourly,salary};
}catch(error){await f.pg.close();throw error;}}
type Fixture=Awaited<ReturnType<typeof fixture>>;
function check(name:string,run:(f:Fixture)=>Promise<void>){test(name,async()=>{const f=await fixture();try{await run(f);}finally{await f.pg.close();}});}

check('scheduled cost forecasts persist sources, price unambiguous salary/hourly units exactly and never post earned payroll or payments',async f=>{
 const created=await f.create({components:[f.hourly,f.salary]});assert.equal(created.response.status,201,JSON.stringify(created.body));
 const keys=(await f.pg.query('SELECT * FROM public.request_keys')).rows.length,report=await f.forecast();assert.equal(report.response.status,200,JSON.stringify(report.body));
 const data=report.body.data,c=data.currencies[0];assert.equal(c.knownHourlySubtotal.amount,'20.00');assert.equal(c.knownSalarySubtotal.amount,'3000.00');assert.equal(c.estimatedTotal.amount,'3020.00');assert.equal(c.hourlyPlans[0].scheduledMilliseconds,'3600000');assert.equal(c.salaryPayments[0].on,'2027-01-31');assert.equal(data.payrollApproved,false);assert.equal(data.earnedEntitlementDetermined,false);assert.equal(data.completeAcademyForecast,false);
 assert.equal((await f.pg.query('SELECT * FROM public.request_keys')).rows.length,keys);assert.equal((await f.pg.query('SELECT * FROM public.finance_journals')).rows.length,0);
 await f.pg.query("UPDATE public.academies SET status='read_only' WHERE id=$1",[f.a]);assert.equal((await f.forecast()).response.status,200);
});
check('scheduled overlapping classes choose only the highest hourly rate across separate work arrangements for the same worker',async f=>{
 assert.equal((await f.create({components:[f.hourly]})).response.status,201);
 const c=await f.made('classes',{hubId:f.hub,courseId:f.c.course_id,courseVersion:1,name:'Overlapping planned class',mode:'in_person',schedule:{oneOff:[{start:'2027-01-05T10:30',end:'2027-01-05T11:30',disambiguation:'reject'}]}}),a=await f.made('classes/'+c.id+'/staff',{personId:f.actors.staff.person,role:'teacher',startsOn:'2026-01-01',reason:'Configured future staffing'});
 assert.equal((await f.create({code:'SECOND',components:[{...f.hourly,assignment:{id:a.id,version:1},amount:'30'}]})).response.status,201);
 const result=await f.forecast();assert.equal(result.response.status,200,JSON.stringify(result.body));const ccy=result.body.data.currencies[0];assert.equal(ccy.estimatedTotal.amount,'40.00');assert.equal(ccy.hourlyPlans.length,1);assert.equal(ccy.hourlyPlans[0].scheduledMilliseconds,'5400000');assert.equal(ccy.hourlyPlans[0].segments.length,2);
});
check('enrollment-date headcount forecasts use authorized enrollment counts and do not turn missing attendance/project/tuition bases into zero costs',async f=>{
 const head=f.components.find(c=>c.code==='HEAD')!;assert.equal((await f.create({components:[{...head,minimumStudents:1,includedStudents:0},f.components.find(c=>c.code==='FEE'),f.components.find(c=>c.code==='PROJECT')]})).response.status,201);
 const result=await f.forecast();assert.equal(result.response.status,200,JSON.stringify(result.body));const c=result.body.data.currencies[0];assert.equal(c.knownHourlySubtotal.amount,'27.50');assert.equal(c.estimatedTotal,null);assert.deepEqual(c.unpricedComponents.map((i:{reason:string})=>i.reason).sort(),['PROJECT_PAYMENT_DATE_REQUIRED','TUITION_ALLOCATION_BASIS_REQUIRED']);
 await f.pg.query("DELETE FROM public.role_permissions WHERE role_id=$1 AND capability='rosters.view'",[f.staffRole]);const limited=await f.forecast(undefined,'staff');assert.equal(limited.response.status,200,JSON.stringify(limited.body));assert.equal(limited.body.data.currencies[0].knownHourlySubtotal.amount,'0.00');assert.equal(limited.body.data.currencies[0].estimatedTotal,null);assert.ok(limited.body.data.currencies[0].unpricedComponents.some((i:{reason:string})=>i.reason==='ROSTER_SOURCE_NOT_AVAILABLE'));
});
check('forecast scopes intersect report/pay/class rights before sources and explicit filters never broaden them',async f=>{
 assert.equal((await f.create({components:[f.hourly,f.salary]})).response.status,201);
 assert.equal((await f.create({hubId:f.otherHub,code:'OTHER',components:[{...f.salary,amount:'9000'}]})).response.status,201);
 const visible=await f.forecast(undefined,'staff');assert.equal(visible.response.status,200,JSON.stringify(visible.body));assert.equal(visible.body.data.currencies[0].knownSalarySubtotal.amount,'3000.00');
 const hidden=await f.forecast('from=2027-01-01&through=2027-01-31&timeZone=UTC&hubId='+f.otherHub,'staff');assert.equal(hidden.response.status,200);assert.equal(hidden.body.data.currencies.length,0);
 await f.pg.query('UPDATE auth_private.credentials SET all_hubs=false WHERE id=$1',[f.credential]);await f.pg.query('INSERT INTO auth_private.credential_hubs(credential_id,academy_id,hub_id) VALUES($1,$2,$3)',[f.credential,f.a,f.hub]);
 assert.equal((await f.forecast(undefined,'bot')).body.data.currencies[0].knownSalarySubtotal.amount,'3000.00');
 await f.pg.query("DELETE FROM public.role_permissions WHERE role_id=$1 AND capability='classes.view'",[f.staffRole]);const noClass=await f.forecast(undefined,'staff');assert.equal(noClass.response.status,200);assert.equal(noClass.body.data.currencies[0].estimatedTotal,null);assert.ok(noClass.body.data.currencies[0].unpricedComponents.some((i:{reason:string})=>i.reason==='SCHEDULE_SOURCE_NOT_AVAILABLE'));assert.equal(noClass.body.data.currencies[0].hourlyPlans.length,0);
 await f.pg.query("DELETE FROM public.role_permissions WHERE role_id=$1 AND capability='work-pay.view'",[f.staffRole]);assert.equal((await f.forecast(undefined,'staff')).response.status,403);
 assert.equal((await f.request('reports/payroll/scheduled-costs?from=2027-01-01&through=2027-01-31&timeZone=UTC',undefined,'foreignMaster',{academy:f.b})).body.data.currencies.length,0);
});
check('cancelled sessions cost no scheduled hours while changed staff sources remain explicitly unpriced',async f=>{
 assert.equal((await f.create({components:[f.hourly]})).response.status,201);const session=(await f.request('classes/'+f.c.id+'/sessions')).body.data[0];
 assert.equal((await f.request('sessions/'+session.id+'/change',{expectedVersion:1,reason:'Cancelled future teaching',change:{kind:'cancel'}})).response.status,200);
 const result=await f.forecast();assert.equal(result.response.status,200,JSON.stringify(result.body));assert.equal(result.body.data.currencies[0].estimatedTotal.amount,'0.00');
 assert.equal((await f.request('class-staff/'+f.assignment.id+'/update',{expectedVersion:1,role:'ta',reason:'Staff revision requires pay review'})).response.status,200);const stale=await f.forecast();assert.equal(stale.body.data.currencies[0].estimatedTotal,null);assert.equal(stale.body.data.currencies[0].unpricedComponents[0].reason,'STAFF_ASSIGNMENT_CHANGED');
});
check('semimonthly salary allocations conserve cents and unsupported salary allocation or proration is explicit',async f=>{
 assert.equal((await f.create({definition:{...f.definition,payCycle:{kind:'semimonthly',days:[15,31]}},components:[{...f.salary,amount:'3000.01'}]})).response.status,201);
 const report=await f.forecast();assert.equal(report.response.status,200,JSON.stringify(report.body));const c=report.body.data.currencies[0];assert.equal(c.estimatedTotal.amount,'3000.01');assert.deepEqual(c.salaryPayments.map((s:{estimatedCost:{amount:string}})=>s.estimatedCost.amount),['1500.01','1500.00']);
 assert.equal((await f.create({code:'ANNUAL',components:[{...f.salary,frequency:'year',amount:'36000'}]})).response.status,201);const unpriced=await f.forecast();assert.equal(unpriced.body.data.currencies[0].estimatedTotal,null);assert.ok(unpriced.body.data.currencies[0].unpricedComponents.some((i:{reason:string})=>i.reason==='SALARY_ALLOCATION_POLICY_REQUIRED'));
 assert.equal((await f.create({code:'MIDMONTH',effectiveOn:'2027-01-10',components:[f.salary]})).response.status,201);
 assert.equal((await f.create({code:'CLASS-SALARY',components:[{...f.salary,assignment:{id:f.assignment.id,version:1}}]})).response.status,201);
 const reasons=(await f.forecast()).body.data.currencies[0].unpricedComponents.map((i:{reason:string})=>i.reason);assert.ok(reasons.includes('SALARY_PRORATION_POLICY_REQUIRED'));assert.ok(reasons.includes('SALARY_ASSIGNMENT_POLICY_REQUIRED'));
});
check('forecast range validation is bounded and brief parallel native reads stay consistent',async f=>{
 assert.equal((await f.create({components:[f.hourly]})).response.status,201);
 assert.equal((await f.forecast('from=2026-01-01&through=2027-12-31&timeZone=UTC')).response.status,422);
 assert.equal((await f.forecast('from=2027-01-01&through=2027-01-31&timeZone=%2B05%3A00')).response.status,400);
 if(f.pg.runtime){const start=performance.now();const r=await Promise.all([f.forecast(),f.forecast(),f.forecast()]);assert.ok(r.every(r=>r.response.status===200&&r.body.data.currencies[0].estimatedTotal.amount==='20.00'));console.log(JSON.stringify({measurement:'brief-scheduled-payroll-forecast',requests:3,elapsedMs:Math.ceil(performance.now()-start)}));}
});
check('overlapping currencies stay unpriced without an FX policy even when a currency filter hides one output group',async f=>{
 assert.equal((await f.create({components:[f.hourly]})).response.status,201);
 const usd=await f.made('finance/currencies',{code:'USD',name:'US dollar',unitScale:2,reason:'Synthetic distinct currency'});
 assert.equal((await f.create({code:'USD-WORK',currency:{id:usd.id,version:1},components:[{...f.hourly,amount:'30'}]})).response.status,201);
 const report=await f.forecast();assert.equal(report.response.status,200,JSON.stringify(report.body));assert.equal(report.body.data.currencies.length,2);for(const c of report.body.data.currencies){assert.equal(c.estimatedTotal,null);assert.equal(c.knownHourlySubtotal.amount,'0.00');assert.ok(c.unpricedComponents.some((i:{reason:string})=>i.reason==='OVERLAPPING_CURRENCIES_REQUIRE_FX_POLICY'));}
 const filtered=await f.forecast('from=2027-01-01&through=2027-01-31&timeZone=UTC&currencyId='+f.currency.id);assert.equal(filtered.body.data.currencies.length,1);assert.equal(filtered.body.data.currencies[0].estimatedTotal,null);
});
check('future and later-recorded backdated terms select the effective scheduled rate rather than the largest version number',async f=>{
 const e=(await f.create({components:[f.hourly]})).body.data;
 assert.equal((await f.amend(e.id,{effectiveOn:'2027-01-01',components:[{...f.hourly,amount:'30'}]})).response.status,200);
 assert.equal((await f.amend(e.id,{expectedVersion:2,effectiveOn:'2026-12-01',components:[{...f.hourly,amount:'25'}]})).response.status,200);
 const report=await f.forecast();assert.equal(report.response.status,200,JSON.stringify(report.body));assert.equal(report.body.data.currencies[0].estimatedTotal.amount,'30.00');assert.equal(report.body.data.currencies[0].hourlyPlans[0].segments[0].source.termsVersion,2);
 assert.equal((await f.amend(e.id,{expectedVersion:3,effectiveOn:'2027-01-01',definition:{...f.definition,active:false},components:[f.hourly]})).response.status,200);
 assert.equal((await f.forecast()).body.data.currencies[0].estimatedTotal.amount,'0.00');
});
check('forecast handles the final supported civil date without PostgreSQL extended-year parsing errors',async f=>{
 assert.equal((await f.create({components:[f.salary]})).response.status,201);
 const report=await f.forecast('from=9999-12-31&through=9999-12-31&timeZone=America%2FToronto');assert.equal(report.response.status,200,JSON.stringify(report.body));assert.equal(report.body.data.currencies[0].knownSalarySubtotal.amount,'3000.00');
});
test('forecast handler fails explicitly on injected source-budget overflow instead of returning partial estimated totals',async()=>{
 const capabilities=['financial-reports.view','work-pay.view'] as const;
 for(const oversized of [{engagement_count:101},{terms:Array(1001).fill({})},{assignments:Array(201).fill({})},{sessions:Array(201).fill({})}]){
  const ctx:ApiContext={path:'reports/payroll/scheduled-costs',request:new Request('https://academy.example/api/v1/reports/payroll/scheduled-costs?from=2027-01-01&through=2027-01-31&timeZone=UTC'),requestId:'synthetic-source-budget-check',credential:{token_id:'synthetic',academy_id:'synthetic',person_id:'synthetic',capabilities:[...capabilities],all_hubs:true,hub_ids:[],allowed:true,kind:'human'},grants:capabilities.map(capability=>({capability,effect:'allow',allHubs:true,hubIds:[]})),db:{async query<Row>(){return {rows:[{snapshot_at:'synthetic',engagement_count:0,terms:[],assignments:[],sessions:[],...oversized}] as unknown as Row[]};},release(){}}};
  await assert.rejects(payrollForecast(ctx),/PAYROLL_FORECAST_REQUIRES_BACKGROUND_JOB/);
 }
});
