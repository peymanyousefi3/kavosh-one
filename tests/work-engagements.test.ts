import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { invoiceFixture } from './invoice-fixture.ts';
import { scopeContains,type Scope } from '../src/core/policy.ts';

async function fixture(){const f=await invoiceFixture();try{
 const employer=await f.made('finance/payees',{kind:'academy',code:'EMPLOYER',name:'Synthetic academy',legalName:'Synthetic Academy Inc.',reason:'Configured legal employer'}),payee=await f.made('finance/payees',{kind:'person',personId:f.actors.staff.person,code:'EMPLOYEE',name:'Synthetic worker',legalName:'Private legal worker',reason:'Configured worker payee'}),assignment=await f.made('classes/'+f.c.id+'/staff',{personId:f.actors.staff.person,role:'teacher',startsOn:'2026-01-01',reason:'Accepted class staff assignment'});
 for(const role of [f.staffRole,f.managerRole])for(const cap of ['work-pay.view','work-pay.edit','staff.view','payees.view','payment-methods.view'])await f.pg.query("INSERT INTO public.role_permissions VALUES($1,$2,$3,'allow') ON CONFLICT DO NOTHING",[f.a,role,cap]);
 const labels=await f.made('roles',{name:'Currency labels only',permissions:[{capability:'currencies.view',effect:'allow'}]});for(const person of [f.actors.staff.person,f.actors.manager.person,f.bot])await f.pg.query('INSERT INTO public.role_assignments(academy_id,id,person_id,role_id,all_hubs) VALUES($1,$2,$3,$4,true)',[f.a,randomUUID(),person,labels.id]);
 const shared={from:'2026-01-01',assignment:{id:assignment.id,version:1},method:{id:f.method.id,version:1}},components=[{code:'ADMIN',kind:'salary',from:'2026-01-01',amount:'3000',frequency:'month'},{...shared,code:'TEACH',kind:'hourly',amount:'20'},{...shared,code:'HEAD',kind:'headcount_hourly',amount:'25',minimumStudents:3,includedStudents:5,increment:'2.50',headcountBasis:'enrolled'},{...shared,code:'FEE',kind:'tuition_percentage',percent:'12.5',basis:'session_net'},{code:'PROJECT',kind:'project',from:'2026-01-01',amount:'125',projectCode:'COACHING'}];
 const definition={legalWorkerName:'Private legal worker',jobTitle:'Teaching and administration',classification:'employee',workPattern:'part_time',countryCode:'CA',region:'Ontario',timeZone:'America/Toronto',startsOn:'2026-01-01',reportingForm:'T4',classificationBasis:'Declared facts require employment-status review',taxReview:'Configured choice is not a CRA determination',payCycle:{kind:'monthly',day:31}};
 const input={personId:f.actors.staff.person,hubId:f.hub,code:'WORK-ON',effectiveOn:'2026-01-01',currency:{id:f.currency.id,version:1},employer:{id:employer.id,version:1},payee:{id:payee.id,version:1},definition,components,reason:'Private work terms and rate review'};
 const create=(patch:Record<string,unknown>={},as='master',key?:string)=>f.request('payroll/engagements',{...input,...patch},as,{key});
 const amend=(id:string,patch:Record<string,unknown>={},as='master',key?:string)=>{const {personId,hubId,code,...body}=input;return f.request('payroll/engagements/'+id+'/change',{...body,expectedVersion:1,...patch},as,{key});};
 return {...f,employer,payee,assignment,input,components,definition,create,amend};
}catch(error){await f.pg.close();throw error;}}
type Fixture=Awaited<ReturnType<typeof fixture>>;
function check(name:string,run:(f:Fixture)=>Promise<void>){test(name,async()=>{const f=await fixture();try{await run(f);}finally{await f.pg.close();}});}

check('employee and contractor work terms persist with configured cycles, sources and compensation without payroll, tax certification or payments',async f=>{
 const key=randomUUID(),created=await f.create({},'master',key);assert.equal(created.response.status,201,JSON.stringify(created.body));const e=created.body.data;assert.equal(e.definition.payCycle.day,31);assert.equal(e.components.length,5);assert.equal(e.components[1].rounding,'nearest_5');assert.equal(e.components[1].excessToleranceMinutes,5);assert.equal(e.payrollReady,false);assert.equal(e.classificationCertified,false);assert.equal(e.earningsOrPaymentsPosted,false);assert.equal((await f.create({},'master',key)).body.data.id,e.id);
 const changed=await f.amend(e.id,{effectiveOn:'2026-07-01',definition:{...f.definition,classification:'contractor',workPattern:'fixed_term_services',reportingForm:'T4A',payCycle:{kind:'biweekly',anchorOn:'2026-07-03'}}});assert.equal(changed.response.status,200,JSON.stringify(changed.body));assert.equal(changed.body.data.definition.classification,'contractor');assert.equal(changed.body.data.version,2);
 assert.equal((await f.pg.query('SELECT * FROM public.finance_journals')).rows.length,0);assert.equal((await f.pg.query('SELECT * FROM public.work_engagement_revisions')).rows.length,2);
 const audit=JSON.stringify((await f.pg.query("SELECT changes FROM public.audit_events WHERE action LIKE 'work.%'")).rows);assert.doesNotMatch(audit,/Private legal|3000|taxReview/);
});
check('work changes require an upper human and the worker cannot approve their own rate, while master self-approval remains allowed',async f=>{
 const pending=await f.create({},'staff');assert.equal(pending.response.status,202,JSON.stringify(pending.body));assert.equal((await f.pg.query('SELECT * FROM public.work_engagements')).rows.length,0);assert.equal((await f.approve(pending.body.approval.id,'staff')).response.status,403);assert.equal((await f.approve(pending.body.approval.id,'manager')).response.status,200);
 const payee=await f.made('finance/payees',{kind:'person',personId:f.actors.manager.person,code:'MANAGER',name:'Manager beneficiary',reason:'Synthetic named payee'}),own=await f.create({personId:f.actors.manager.person,payee:{id:payee.id,version:1},components:[f.components[0]]},'staff');assert.equal(own.response.status,202,JSON.stringify(own.body));const conflict=await f.approve(own.body.approval.id,'manager');assert.equal(conflict.response.status,403);assert.equal(conflict.body.error.code,'BENEFICIARY_REVIEW_FORBIDDEN');assert.equal((await f.approve(own.body.approval.id)).response.status,200);
});
check('effective-date selection and explicit historical versions retain earlier rates instead of rewriting them with a future amendment',async f=>{
 const e=(await f.create()).body.data,components=f.components.map(c=>c.code==='TEACH'?{...c,amount:'30'}:c);assert.equal((await f.amend(e.id,{effectiveOn:'2026-07-01',components})).response.status,200);
 for(const [on,expected] of [['2026-03-01',1],['2026-08-01',2]])assert.equal((await f.request('payroll/engagements/'+e.id+'?on='+on)).body.data.version,expected);
 const old=await f.request('payroll/engagements/'+e.id+'?version=1');assert.equal(old.body.data.components.find((c:{code:string})=>c.code==='TEACH').amount,'20');assert.equal(old.body.data.latestRecordedVersion,2);
 const history=await f.request('payroll/engagements/'+e.id+'/history?limit=1');assert.equal(history.body.data[0].reason,f.input.reason);assert.equal(history.body.nextVersion,1);assert.equal((await f.request('payroll/engagements/'+e.id+'/history?afterVersion=1')).body.data.length,1);
 assert.equal((await f.request('payroll/engagements/'+e.id+'?on=2025-12-31')).response.status,404);assert.equal((await f.request('payroll/engagements/'+e.id+'?on=2026-03-01&version=1')).response.status,400);
});
check('configured previews deduplicate highest hourly overlaps, retain salary/percentage/project parts and remain read-only even in a read-only academy',async f=>{
 const e=(await f.create()).body.data,body={on:'2026-01-02',scenarios:[{key:'salary',componentCode:'ADMIN'},{key:'low',componentCode:'TEACH',startsAt:'2026-01-02T13:00:00Z',endsAt:'2026-01-02T15:00:00Z'},{key:'high',componentCode:'HEAD',headcount:7,startsAt:'2026-01-02T14:00:00Z',endsAt:'2026-01-02T16:00:00Z'},{key:'fee',componentCode:'FEE',tuitionAmount:'100'},{key:'project',componentCode:'PROJECT'}]};
 const keys=(await f.pg.query('SELECT * FROM public.request_keys')).rows.length;
 await f.pg.query("UPDATE public.academies SET status='read_only' WHERE id=$1",[f.a]);const r=await f.request('payroll/engagements/'+e.id+'/preview',body);assert.equal(r.response.status,200,JSON.stringify(r.body));assert.equal(r.body.data.actualHourly.value.amount,'80.00');assert.equal(r.body.data.configuredScenarioTotal.amount,'3217.50');assert.equal(r.body.data.payrollApproved,false);assert.equal(r.body.data.complianceReviewRequired,true);assert.equal(r.body.data.scenarioInputsVerified,false);assert.equal((await f.pg.query('SELECT * FROM public.request_keys')).rows.length,keys);assert.equal((await f.create({code:'BLOCKED'})).response.status,403);
});
check('selected-person pay rights follow engagement ownership rather than mutable primary hub and still preserve record-hub and person denials',async f=>{
 const a=await f.create();assert.equal(a.response.status,201);const b=await f.create({hubId:f.otherHub,code:'OTHER',components:[f.components[0]]});assert.equal(b.response.status,201);
 await f.pg.query('UPDATE public.people SET hub_id=$2 WHERE id=$1',[f.actors.staff.person,f.otherHub]);
 const allow=await f.made('roles',{name:'Selected private worker',permissions:[{capability:'work-pay.view',effect:'allow'}]}),deny=await f.made('roles',{name:'Pay records from hub B denied',permissions:[{capability:'work-pay.view',effect:'deny'}]}),path='people/'+f.actors.staff.person+'/access';
 assert.equal((await f.request(path,{expectedVersion:(await f.request(path)).body.data.version,assignments:[{roleId:allow.id,allHubs:false,personIds:[f.actors.staff.person]},{roleId:deny.id,allHubs:false,hubIds:[f.otherHub]}]})).response.status,200);
 const selected=await f.request('payroll/engagements?limit=1',undefined,'staff');assert.equal(selected.response.status,200,JSON.stringify(selected.body));assert.equal(selected.body.data.length,1);assert.equal(selected.body.data[0].id,a.body.data.id);assert.equal(selected.body.nextCursor,null);assert.equal((await f.request('payroll/engagements/'+b.body.data.id,undefined,'staff')).response.status,404);assert.equal((await f.request('payroll/engagements/'+a.body.data.id+'/history',undefined,'staff')).response.status,403);
});
check('stale staff sources and revoked private payroll viewing invalidate or hide submitted work proposals',async f=>{
 const p=await f.create({},'staff');assert.equal(p.response.status,202);
 assert.equal((await f.request('class-staff/'+f.assignment.id+'/update',{expectedVersion:1,role:'ta',reason:'Amend source assignment'})).response.status,200);assert.equal((await f.approve(p.body.approval.id)).response.status,409);
 const next=await f.create({components:[f.components[0]]},'staff');assert.equal(next.response.status,202);await f.pg.query("DELETE FROM public.role_permissions WHERE role_id=$1 AND capability='work-pay.view'",[f.staffRole]);assert.equal((await f.request('approvals/'+next.body.approval.id,undefined,'staff')).response.status,404);assert.ok(!(await f.request('approvals',undefined,'staff')).body.data.some((a:{id:string})=>a.id===next.body.approval.id));
});
check('selected-worker bot access respects the record hub ceiling even when the worker primary hub changes',async f=>{
 const first=(await f.create()).body.data,second=(await f.create({hubId:f.otherHub,code:'OTHER',components:[f.components[0]]})).body.data;
 await f.pg.query('UPDATE public.people SET hub_id=$2 WHERE id=$1',[f.actors.staff.person,f.otherHub]);
 const role=await f.made('roles',{name:'Selected worker pay records',permissions:[{capability:'work-pay.view',effect:'allow'}]}),path='people/'+f.bot+'/access';
 assert.equal((await f.request(path,{expectedVersion:(await f.request(path)).body.data.version,assignments:[{roleId:role.id,allHubs:false,personIds:[f.actors.staff.person]}]})).response.status,200);
 await f.pg.query('UPDATE auth_private.credentials SET all_hubs=false WHERE id=$1',[f.credential]);
 await f.pg.query('INSERT INTO auth_private.credential_hubs(credential_id,academy_id,hub_id) VALUES($1,$2,$3)',[f.credential,f.a,f.hub]);
 assert.deepEqual((await f.request('payroll/engagements',undefined,'bot')).body.data.map((e:{id:string})=>e.id),[first.id]);
 assert.equal((await f.request('payroll/engagements/'+first.id,undefined,'bot')).response.status,200);
 assert.equal((await f.request('payroll/engagements/'+second.id,undefined,'bot')).response.status,404);
 const source:Scope={all:false,hubs:[],people:[{id:f.actors.staff.person,hubId:f.otherHub}],recordHubIds:[f.hub]};
 for(const [hubId,expected] of [[f.hub,true],[f.otherHub,false],[null,false]] as const){
  const target:Scope={all:false,hubs:[],people:[{id:f.actors.staff.person,hubId}],workContext:{personId:f.actors.staff.person,hubId}};
  assert.equal(scopeContains(source,target),expected);
  assert.equal((await f.pg.query<{ok:boolean}>('SELECT public.scope_contains($1::jsonb,$2::jsonb) AS ok',[JSON.stringify(source),JSON.stringify(target)])).rows[0].ok,expected);
 }
 const target:Scope={all:false,hubs:[],people:[{id:f.actors.staff.person,hubId:f.hub}],workContext:{personId:f.actors.staff.person,hubId:f.hub}},recordContext={hubId:f.hub,classId:f.c.id,studentId:f.actors.staff.person};
 for(const [s,t] of [[{...source,excludedPeople:[{id:f.actors.staff.person,hubId:f.otherHub}]},target],[{...source,recordContext},target],[source,{...target,recordContext}],[source,{...target,recordHubIds:[f.hub]}],[source,{...target,people:[...target.people!,{id:f.actors.manager.person,hubId:f.hub}]}]] as [Scope,Scope][]){
  assert.equal(scopeContains(s,t),false);
  assert.equal((await f.pg.query<{ok:boolean}>('SELECT public.scope_contains($1::jsonb,$2::jsonb) AS ok',[JSON.stringify(s),JSON.stringify(t)])).rows[0].ok,false);
 }
});
check('class staff visibility alone never grants private compensation access',async f=>{
 const e=(await f.create()).body.data;
 await f.pg.query("DELETE FROM public.role_permissions WHERE role_id=$1 AND capability IN('work-pay.view','work-pay.edit')",[f.staffRole]);
 for(const path of ['payroll/engagements','payroll/engagements/'+e.id])assert.equal((await f.request(path,undefined,'staff')).response.status,403);
 assert.equal((await f.request('payroll/engagements/'+e.id+'/preview',{on:'2026-01-02',scenarios:[{key:'salary',componentCode:'ADMIN'}]},'staff')).response.status,403);
});
check('hub-only pay authority cannot delegate an unbounded selected-worker grant across future work hubs',async f=>{
 const role=await f.made('roles',{name:'Selected-worker pay viewer',permissions:[{capability:'work-pay.view',effect:'allow'}]}),path='people/'+f.actors.staff.person+'/access';
 const result=await f.request(path,{expectedVersion:(await f.request(path)).body.data.version,assignments:[{roleId:role.id,allHubs:false,personIds:[f.actors.staff.person]}]},'manager');
 assert.equal(result.response.status,403,JSON.stringify(result.body));assert.equal(result.body.error.code,'DELEGATION_EXCEEDS_AUTHORITY');
});
check('unexpected sensitive identifiers, invalid money, duplicate components and cross-hub class assignments do not enter payroll configuration',async f=>{
 for(const patch of [{definition:{...f.definition,sin:'not-collected'}},{components:[{...f.components[1],amount:'1.001'}]},{components:[f.components[0],f.components[0]]},{hubId:f.otherHub}])assert.equal((await f.create(patch)).response.status,400,JSON.stringify(patch));
 assert.equal((await f.pg.query('SELECT * FROM public.work_engagements')).rows.length,0);
});
check('closing work terms preserves pinned sources after staff, payment method and payee retirement',async f=>{
 const e=(await f.create()).body.data;
 for(const [path,input] of [
  ['class-staff/'+f.assignment.id+'/update',{expectedVersion:1,active:false,reason:'Staff assignment ended'}],
  ['finance/payment-methods/'+f.method.id+'/change',{expectedVersion:1,active:false,reason:'Method retired'}],
  ['finance/payees/'+f.payee.id+'/change',{expectedVersion:1,name:'Retired worker payee',active:false,reason:'Payee retired'}]
 ] as const)assert.equal((await f.request(path,input)).response.status,200);
 assert.equal((await f.amend(e.id)).response.status,409,'active terms must not silently accept stale source versions');
 const closed=await f.amend(e.id,{definition:{...f.definition,active:false}});assert.equal(closed.response.status,200,JSON.stringify(closed.body));
 assert.equal(closed.body.data.definition.active,false);
 const original=await f.request('payroll/engagements/'+e.id+'?version=1');assert.equal(original.body.data.definition.active,true);assert.equal(original.body.data.components[1].amount,'20');
});
check('native payroll configuration is tenant-bound, append-only and cannot forge audits, reparent workers or accept a bot as a worker',async f=>{
 const result=await f.create();assert.equal(result.response.status,201,JSON.stringify(result.body));const id=result.body.data.id;
 await f.pg.exec('BEGIN');await f.pg.query("SELECT set_config('app.academy_id',$1,true)",[f.a]);await f.pg.exec('SET LOCAL ROLE kavosh_runtime');try{
  for(const [sql,params] of [['DELETE FROM public.work_engagements WHERE id=$1',[id]],['UPDATE public.work_engagements SET person_id=$2 WHERE id=$1',[id,f.actors.manager.person]],['UPDATE public.work_engagement_revisions SET reason=\'overwritten\' WHERE engagement_id=$1',[id]],['UPDATE public.work_engagement_revisions SET created_at=now() WHERE engagement_id=$1',[id]],['UPDATE public.work_engagements SET version=version WHERE id=$1',[id]] ]as [string,unknown[]][]){await f.pg.exec('SAVEPOINT hostile');await assert.rejects(f.pg.query(sql,params));await f.pg.exec('ROLLBACK TO SAVEPOINT hostile');}
  await f.pg.exec('SAVEPOINT bot');await assert.rejects(f.pg.query("INSERT INTO public.work_engagements(academy_id,id,person_id,hub_id,code) VALUES($1,$2,$3,$4,'BOT')",[f.a,randomUUID(),f.bot,f.hub]));await f.pg.exec('ROLLBACK TO SAVEPOINT bot');
  await f.pg.query("SELECT set_config('app.academy_id',$1,true)",[f.b]);assert.equal((await f.pg.query('SELECT * FROM public.work_engagements')).rows.length,0);assert.equal((await f.pg.query('SELECT * FROM public.work_engagement_revisions')).rows.length,0);
 }finally{await f.pg.exec('ROLLBACK');}
});
check('work revisions roll back with critical event failure and bot credentials can propose but cannot approve pay terms',async f=>{
 const p=await f.create({components:[f.components[0]]},'bot');assert.equal(p.response.status,202,JSON.stringify(p.body));assert.equal((await f.approve(p.body.approval.id,'bot')).response.status,403);assert.equal((await f.approve(p.body.approval.id)).response.status,200);
 await f.pg.exec("CREATE FUNCTION public.reject_work_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.event_type='work.engagement.change' THEN RAISE EXCEPTION 'synthetic event failure';END IF;RETURN NEW;END $$;CREATE TRIGGER reject_work_event BEFORE INSERT ON public.outbox_events FOR EACH ROW EXECUTE FUNCTION public.reject_work_event()");
 const id=(await f.pg.query<{id:string}>('SELECT id FROM public.work_engagements')).rows[0].id;assert.equal((await f.amend(id,{components:[f.components[0]],effectiveOn:'2026-02-01'})).response.status,503);assert.equal((await f.pg.query('SELECT * FROM public.work_engagement_revisions')).rows.length,1);
});
test('brief concurrent work amendments retain one exact revision and cannot overwrite one another',async t=>{
 const f=await fixture();try{if(!f.pg.runtime){t.skip('Requires independent native PostgreSQL connections');return;}const id=(await f.create()).body.data.id,start=performance.now(),results=await Promise.all([f.amend(id,{definition:{...f.definition,jobTitle:'First edit'}}),f.amend(id,{definition:{...f.definition,jobTitle:'Second edit'}})]);assert.deepEqual(results.map(r=>r.response.status).sort(),[200,409]);assert.equal((await f.pg.query('SELECT * FROM public.work_engagement_revisions')).rows.length,2);console.log(JSON.stringify({measurement:'brief-work-amendment-race',requests:2,winners:1,elapsedMs:Math.ceil(performance.now()-start)}));}finally{await f.pg.close();}
});
