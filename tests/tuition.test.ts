import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { operationsFixture } from './operations-fixture.ts';
import { scopeContains } from '../src/core/policy.ts';

async function fixture(options:{throughSchema?:number}={}){
 const f=await operationsFixture(options),country=randomUUID(),region=randomUUID(),city=randomUUID();
 await f.pg.query("INSERT INTO public.countries(academy_id,id,code,name) VALUES($1,$2,'CA','Canada')",[f.a,country]);
 await f.pg.query("INSERT INTO public.regions(academy_id,id,country_id,code,name) VALUES($1,$2,$3,'ON','Ontario')",[f.a,region,country]);
 await f.pg.query("INSERT INTO public.cities(academy_id,id,region_id,name) VALUES($1,$2,$3,'Toronto')",[f.a,city,region]);
 await f.pg.query("UPDATE public.hubs SET city_id=$2,time_zone='America/Toronto',currency='CAD' WHERE academy_id=$1",[f.a,city]);
 const course=await f.request('courses',{code:'TUITION',name:'Tuition curriculum'});assert.equal(course.response.status,201,JSON.stringify(course.body));
 const student=async(name:string,hubId=f.hub)=>{const p=await f.request('people',{name,hubId});assert.equal(p.response.status,201);const id=p.body.data.id;
  assert.equal((await f.request('students',{personId:id,legalName:'Private '+name,dateOfBirth:'2014-01-01',recruiter:{kind:'academy'}})).response.status,201);return id as string;};
 const createEnrollment=async(studentId:string,hubId=f.hub)=>{const c=await f.request('classes',{hubId,courseId:course.body.data.id,courseVersion:1,name:'Tuition class',mode:'in_person',schedule:{oneOff:[{start:'2030-01-01T10:00',end:'2030-01-01T11:00',disambiguation:'reject'}]}});assert.equal(c.response.status,201,JSON.stringify(c.body));
  const e=await f.request('classes/'+c.body.data.id+'/enrollments',{studentId,studentProfileVersion:1,joinsOn:'2030-01-01',reason:'Synthetic pre-signing enrollment'});assert.equal(e.response.status,201,JSON.stringify(e.body));return {...e.body.data};};
 const one=await student('Student One'),two=await student('Student Two'),own=await createEnrollment(one),peer=await createEnrollment(two),other=await createEnrollment(one,f.otherHub);
 const currency=await f.request('finance/currencies',{code:'CAD',name:'Canadian dollar',unitScale:2,reason:'Synthetic units'});assert.equal(currency.response.status,201);
 const tax=await f.request('finance/tax-codes',{code:'HST',name:'Synthetic reviewed tax',hubId:f.hub,countryCode:'CA',classification:'taxable',ratePercent:'13',startsOn:'2026-01-01',legalBasis:'Synthetic example, not an actual tuition exemption determination',reason:'Synthetic setup'});assert.equal(tax.response.status,201,JSON.stringify(tax.body));
 const method=await f.request('finance/payment-methods',{code:'ET',name:'Synthetic transfer',category:'e_transfer',hubId:f.hub,reason:'Synthetic preferred method'});assert.equal(method.response.status,201);
 for(const cap of ['tuition.view','tuition.edit','enrollments.view','tax-codes.view','payment-methods.view'])await f.pg.query("INSERT INTO public.role_permissions VALUES($1,$2,$3,'allow')",[f.a,f.managerRole,cap]);
 await f.pg.query("INSERT INTO public.role_permissions VALUES($1,$2,'tuition.view','allow')",[f.a,f.staffRole]);await f.pg.query("INSERT INTO public.role_permissions VALUES($1,$2,'currencies.view','allow')",[f.a,f.policyRole]);
 const base={enrollmentVersion:1,currencyId:currency.body.data.id,currencyVersion:1,taxCodeId:tax.body.data.id,taxCodeVersion:1,supplyOn:'2030-01-01',originalAmount:'120.00',agreedAmount:'100.00',pricing:'tax_exclusive',
  installments:[{dueOn:'2029-12-15',amount:'50.00',methodId:method.body.data.id,methodVersion:1},{dueOn:'2030-01-15',amount:'63.00',methodId:method.body.data.id,methodVersion:1}],reason:'Private tuition terms'};
 const create=(patch:Record<string,unknown>={},as='master',e=own,key?:string)=>f.request('enrollments/'+e.id+'/tuition-plan',{...base,...patch},as,{key});
 const setAccess=async(as:string,assignments:unknown[])=>{const id=as==='bot'?f.bot:f.actors[as].person,path='people/'+id+'/access',old=await f.request(path);const r=await f.request(path,{expectedVersion:old.body.data.version,assignments});assert.equal(r.response.status,200,JSON.stringify(r.body));};
 return {...f,student,createEnrollment,one,two,own,peer,other,currency:currency.body.data.id,tax:tax.body.data.id,method:method.body.data.id,base,create,setAccess};
}
type Fixture=Awaited<ReturnType<typeof fixture>>;
async function familyAccess(f:Fixture,as='staff',selection:Record<string,unknown>={allHubs:true}){
 const r=await f.request('roles',{name:'Private family tuition '+randomUUID(),permissions:[{capability:'received-tuition.view',effect:'allow'}]});assert.equal(r.response.status,201,JSON.stringify(r.body));await f.setAccess(as,[{roleId:r.body.data.id,...selection}]);return r.body.data.id as string;
}
async function familyLink(f:Fixture,studentId=f.one,as='staff',patch:Record<string,unknown>={}){
 assert.equal((await f.request('guardians',{personId:f.actors[as].person,legalName:'Private guardian '+as})).response.status,201);
 const r=await f.request('students/'+studentId+'/guardians',{guardianId:f.actors[as].person,relationship:'parent',reason:'Reviewed synthetic family',...patch});assert.equal(r.response.status,201,JSON.stringify(r.body));return r.body.data.id as string;
}
function check(name:string,run:(f:Fixture)=>Promise<void>,nativeOnly=false){test(name,{skip:nativeOnly&&!process.env.TEST_DATABASE_URL},async()=>{const f=await fixture();try{await run(f);}finally{await f.pg.close();}});}

test('family tuition: actual schema200 upgrade preserves original plans,approvals,installments and assignments without auto-grants',async()=>{
 const f=await fixture({throughSchema:200});try{const p=await f.create();assert.equal(p.response.status,201);const sql="SELECT jsonb_build_object('plans',(SELECT jsonb_agg(to_jsonb(x) ORDER BY id) FROM public.tuition_plans x),'revisions',(SELECT jsonb_agg(to_jsonb(x) ORDER BY plan_id,version) FROM public.tuition_plan_revisions x),'installments',(SELECT jsonb_agg(to_jsonb(x) ORDER BY plan_id,version,ordinal) FROM public.tuition_installments x),'permissions',(SELECT jsonb_agg(to_jsonb(x) ORDER BY role_id,capability) FROM public.role_permissions x),'assignments',(SELECT jsonb_agg(to_jsonb(x) ORDER BY id) FROM public.role_assignments x)) snapshot",before=(await f.pg.query(sql)).rows;await f.pg.exec(await readFile(new URL('../db/migrations/201_received_tuition.sql',import.meta.url),'utf8'));assert.deepEqual((await f.pg.query(sql)).rows,before);assert.equal((await f.pg.query('SELECT public.schema_revision() n')).rows[0].n,201);assert.equal((await f.pg.query("SELECT 1 FROM public.role_permissions WHERE capability='received-tuition.view'")).rows.length,0);await familyLink(f);assert.equal((await f.request('students/'+f.one+'/tuition-plans',undefined,'staff')).response.status,403);await familyAccess(f);assert.equal((await f.request('students/'+f.one+'/tuition-plans/'+p.body.data.id,undefined,'staff')).response.status,200);}finally{await f.pg.close();}
});

check('family tuition: concurrent family suspension and reads leave no access after the approved revocation commits',async f=>{
 const p=await f.create();assert.equal(p.response.status,201);const relationship=await familyLink(f);await familyAccess(f);const path='students/'+f.one+'/tuition-plans/'+p.body.data.id,t=performance.now();
 const [read,revoked]=await Promise.all([f.request(path,undefined,'staff'),f.request('family-relationships/'+relationship+'/suspend',{expectedVersion:1,reason:'Synthetic revoke during a family read'})]);assert.ok([200,404].includes(read.response.status),JSON.stringify(read.body));assert.equal(revoked.response.status,200,JSON.stringify(revoked.body));assert.equal((await f.request(path,undefined,'staff')).response.status,404);assert.equal((await f.request('students/'+f.one+'/tuition-plans',undefined,'staff')).response.status,404);console.log(JSON.stringify({case:'two-request-family-tuition-revocation',elapsedMs:Math.round(performance.now()-t),capacityClaim:false}));
},true);

check('family tuition: current verified parent reads approved pre-admission terms without administrative finance or peer data',async f=>{
 const own=await f.create(),peer=await f.create({},'master',f.peer);assert.equal(own.response.status,201);assert.equal(peer.response.status,201);await familyLink(f);
 const path='students/'+f.one+'/tuition-plans';assert.equal((await f.request(path,undefined,'staff')).response.status,403);await familyAccess(f);
 const list=await f.request(path,undefined,'staff');assert.equal(list.response.status,200,JSON.stringify(list.body));assert.deepEqual(list.body.data.map((r:{id:string})=>r.id),[own.body.data.id]);assert.equal(list.response.headers.get('cache-control'),'no-store');
 const detail=await f.request(path+'/'+own.body.data.id,undefined,'staff');assert.equal(detail.response.status,200,JSON.stringify(detail.body));assert.equal(detail.body.data.plannedGross,'113.00');assert.equal(detail.body.data.installments[0].amount,'50.00');assert.equal(detail.body.data.admissionGranted,false);assert.equal(detail.body.data.paymentStatus,'not_tracked_here');assert.equal(detail.body.data.joinsOn,'2030-01-01');
 assert.doesNotMatch(JSON.stringify(detail.body),/Private tuition terms|sourceSnapshot|reason|approvalId|changedBy|recruiter|dateOfBirth|Private Student/);
 assert.equal((await f.request('finance/tuition-plans/'+own.body.data.id,undefined,'staff')).response.status,403);assert.equal((await f.request('classes/'+f.own.class_id+'/roster',undefined,'staff')).response.status,403);
 assert.equal((await f.request('students/'+f.two+'/tuition-plans',undefined,'staff')).response.status,404);assert.equal((await f.request(path+'/'+peer.body.data.id,undefined,'staff')).response.status,404);assert.equal((await f.request(path+'/'+own.body.data.id,undefined,'foreignMaster',{academy:f.b})).response.status,404);
 const before=(await f.pg.query('SELECT count(*) n FROM public.finance_journals')).rows[0];await f.request(path,undefined,'staff');assert.deepEqual((await f.pg.query('SELECT count(*) n FROM public.finance_journals')).rows[0],before);
});
check('family tuition: separate grants cannot be delegated beyond a primary hub or shed class denials',async f=>{
 const viewer=await f.request('roles',{name:'Family tuition delegation',permissions:[{capability:'received-tuition.view',effect:'allow'}]}),deny=await f.request('roles',{name:'Family tuition excluded class',permissions:[{capability:'received-tuition.view',effect:'deny'}]}),access=await f.request('roles',{name:'Family delegation administrator',permissions:[{capability:'access.edit',effect:'allow'}]});
 const path='people/'+f.actors.staff.person+'/access',old=(await f.request(path)).body.data.version,selected={roleId:viewer.body.data.id,allHubs:false,personIds:[f.one]},blocked={roleId:deny.body.data.id,allHubs:false,classIds:[f.own.class_id]};
 // Existing administrative tuition authority is not family-feature authority.
 assert.equal((await f.request(path,{expectedVersion:old,assignments:[selected]},'manager')).response.status,403);
 await f.setAccess('manager',[{roleId:viewer.body.data.id,allHubs:false,hubIds:[f.hub]},{roleId:access.body.data.id,allHubs:true},{roleId:f.managerRole,allHubs:false,hubIds:[f.hub]}]);assert.equal((await f.request(path,{expectedVersion:old,assignments:[selected]},'manager')).body.error.code,'DELEGATION_EXCEEDS_AUTHORITY');
 await f.setAccess('manager',[selected,blocked,{roleId:access.body.data.id,allHubs:true},{roleId:f.managerRole,allHubs:false,hubIds:[f.hub]}]);assert.equal((await f.request(path,{expectedVersion:old,assignments:[selected]},'manager')).body.error.code,'DELEGATION_EXCEEDS_AUTHORITY');
 const safe=await f.request(path,{expectedVersion:old,assignments:[selected,blocked]},'manager');assert.equal(safe.response.status,202,JSON.stringify(safe.body));assert.equal((await f.approve(safe.body.approval.id)).response.status,200);
});
check('family tuition: own student is separately configurable and a fully permitted machine still cannot impersonate family',async f=>{
 const studentId=f.actors.manager.person;assert.equal((await f.request('students',{personId:studentId,legalName:'Private own student',dateOfBirth:'2014-01-01',recruiter:{kind:'academy'}})).response.status,201);const e=await f.createEnrollment(studentId),p=await f.create({},'master',e);assert.equal(p.response.status,201);await familyAccess(f,'manager',{allHubs:false,personIds:[studentId]});
 const path='students/'+studentId+'/tuition-plans';assert.equal((await f.request(path+'/'+p.body.data.id,undefined,'manager')).response.status,200);assert.equal((await f.request('students/'+f.one+'/tuition-plans',undefined,'manager')).response.status,404);
 await familyAccess(f,'bot');assert.equal((await f.request(path,undefined,'bot')).response.status,403);assert.equal((await f.request(path,undefined,'bot')).body.error.code,'HUMAN_RECIPIENT_REQUIRED');
 await f.pg.query('UPDATE identity."user" SET "phoneNumberVerified"=false WHERE id=$1',[f.actors.manager.user]);assert.notEqual((await f.request(path,undefined,'manager')).response.status,200);
});
check('family tuition: live legal relationship,expiry,student status and grants are rechecked on every read',async f=>{
 const p=await f.create();assert.equal(p.response.status,201);const relationship=await familyLink(f);await familyAccess(f);const path='students/'+f.one+'/tuition-plans/'+p.body.data.id;
 assert.equal((await f.request(path,undefined,'staff')).response.status,200);
 for(const change of [{relationship:'authorized_contact'},{relationship:'parent',state:'suspended'},{state:'approved',validFrom:'2090-01-01T00:00:00Z'},{validFrom:'2000-01-01T00:00:00Z',validUntil:'2001-01-01T00:00:00Z'}]){
  const v=(await f.pg.query<{version:number}>('SELECT version FROM public.family_relationships WHERE id=$1',[relationship])).rows[0].version;const changed=await f.request('family-relationships/'+relationship+'/change',{expectedVersion:v,...change,reason:'Synthetic current authority change'});assert.equal(changed.response.status,200,JSON.stringify(changed.body));assert.equal((await f.request(path,undefined,'staff')).response.status,404);
 }
 const v=(await f.pg.query<{version:number}>('SELECT version FROM public.family_relationships WHERE id=$1',[relationship])).rows[0].version;assert.equal((await f.request('family-relationships/'+relationship+'/change',{expectedVersion:v,validFrom:'2000-01-01T00:00:00Z',validUntil:null,reason:'Synthetic restored guardian'})).response.status,200);
 assert.equal((await f.request(path,undefined,'staff')).response.status,200);await f.pg.query("UPDATE public.people SET status='disabled' WHERE id=$1",[f.one]);assert.equal((await f.request(path,undefined,'staff')).response.status,404);await f.pg.query("UPDATE public.people SET status='active' WHERE id=$1",[f.one]);await f.setAccess('staff',[]);assert.equal((await f.request(path,undefined,'staff')).response.status,403);
});
check('family tuition: actual record hub and class denials apply before paging despite a selected-student grant',async f=>{
 const a=await f.create(),b=await f.create({...f.base,taxCodeId:f.tax},'master',f.other);assert.equal(a.response.status,201);assert.equal(b.response.status,409,'Hub-specific tax cannot fund another hub');
 const tax=await f.request('finance/tax-codes',{code:'GLOBAL',name:'Synthetic global tax',countryCode:'CA',classification:'taxable',ratePercent:'13',startsOn:'2026-01-01',legalBasis:'Synthetic reviewed classification',reason:'Synthetic setup'}),method=await f.request('finance/payment-methods',{code:'GLOBAL',name:'Synthetic global method',category:'e_transfer',reason:'Synthetic setup'});assert.equal(tax.response.status,201);assert.equal(method.response.status,201);
 const other=await f.create({taxCodeId:tax.body.data.id,installments:f.base.installments.map(i=>({...i,methodId:method.body.data.id}))},'master',f.other);assert.equal(other.response.status,201,JSON.stringify(other.body));await familyLink(f);const allow=await familyAccess(f,'staff',{allHubs:false,personIds:[f.one]}),deny=await f.request('roles',{name:'Family forbidden record hub',permissions:[{capability:'received-tuition.view',effect:'deny'}]});assert.equal(deny.response.status,201);await f.setAccess('staff',[{roleId:allow,allHubs:false,personIds:[f.one]},{roleId:deny.body.data.id,allHubs:false,hubIds:[f.otherHub]}]);
 const path='students/'+f.one+'/tuition-plans',list=await f.request(path+'?limit=1',undefined,'staff');assert.equal(list.response.status,200,JSON.stringify(list.body));assert.deepEqual(list.body.data.map((r:{id:string})=>r.id),[a.body.data.id]);assert.equal(list.body.nextCursor,null);assert.equal((await f.request(path+'/'+other.body.data.id,undefined,'staff')).response.status,404);
 await f.setAccess('staff',[{roleId:allow,allHubs:false,personIds:[f.one]},{roleId:deny.body.data.id,allHubs:false,classIds:[f.own.class_id]}]);const second=await f.request(path+'?limit=1',undefined,'staff');assert.equal(second.response.status,200,JSON.stringify(second.body));assert.deepEqual(second.body.data.map((r:{id:string})=>r.id),[other.body.data.id]);assert.equal(second.body.nextCursor,null);assert.equal((await f.request(path+'/'+a.body.data.id,undefined,'staff')).response.status,404);
});
check('family tuition: canonical replacement,cancellation,pinned method labels and strict pagination never invent paid status',async f=>{
 const p=await f.create(),id=p.body.data.id;assert.equal(p.response.status,201);await familyLink(f);await familyAccess(f);const path='students/'+f.one+'/tuition-plans';
 await f.request('finance/payment-methods/'+f.method+'/change',{expectedVersion:1,name:'New method name',reason:'Synthetic rename'});assert.equal((await f.request(path+'/'+id,undefined,'staff')).body.data.installments[0].methodName,'Synthetic transfer');
 const replacement=await f.request('finance/tuition-plans/'+id+'/change',{...f.base,expectedVersion:1,agreedAmount:'90',installments:[{dueOn:'2030-02-01',amount:'101.70',methodId:f.method,methodVersion:2}]});assert.equal(replacement.response.status,200,JSON.stringify(replacement.body));const changed=await f.request(path+'/'+id,undefined,'staff');assert.equal(changed.body.data.version,2);assert.equal(changed.body.data.plannedGross,'101.70');assert.equal(changed.body.data.installments[0].methodName,'New method name');
 assert.equal((await f.request('finance/tuition-plans/'+id+'/cancel',{expectedVersion:2,reason:'Stop future planning'})).response.status,200);assert.equal((await f.request(path+'?state=active',undefined,'staff')).body.data.length,0);assert.equal((await f.request(path+'/'+id,undefined,'staff')).body.data.state,'cancelled');assert.equal((await f.request(path+'?state=cancelled',undefined,'staff')).body.data[0].paymentStatus,'not_tracked_here');
 for(const suffix of ['?limit=51','?limit=1&limit=2','?after=bad','?paid=true'])assert.equal((await f.request(path+suffix,undefined,'staff')).response.status,400);
 assert.equal((await f.request(path+'/'+id+'?version=1',undefined,'staff')).response.status,400);assert.equal((await f.request(path+'/'+id,{},'staff')).response.status,405);
});

check('approved pre-admission tuition preserves original/agreed prices, exact tax, joining context and gross installments without cash or journal postings',async f=>{
 const r=await f.create();assert.equal(r.response.status,201,JSON.stringify(r.body));assert.equal(r.body.approval.selfApproved,true);const v=r.body.data;
 assert.equal(v.originalAmount,'120.00');assert.equal(v.agreedAmount,'100.00');assert.equal(v.net,'100.00');assert.equal(v.tax,'13.00');assert.equal(v.plannedGross,'113.00');assert.equal(v.paymentStatus,'not_tracked_here');assert.equal(v.posted,false);assert.equal(v.planningOnly,true);
 assert.equal(v.sourceSnapshot.studentProfileVersion,1);assert.equal(v.installments[0].dueOn,'2029-12-15');assert.equal(v.installments[1].amount,'63.00');assert.equal(v.installments[0].methodName,'Synthetic transfer');
 assert.equal((await f.request('finance/tuition-plans/'+v.id)).body.data.plannedGross,'113.00');assert.equal((await f.pg.query('SELECT * FROM public.finance_journals')).rows.length,0);assert.equal((await f.pg.query('SELECT * FROM public.agreement_packages')).rows.length,0);
 assert.equal((await f.request('finance/tuition-plans?dueFrom=2030-01-15&dueThrough=2030-01-15&state=active')).body.data.length,1);assert.equal((await f.request('finance/tuition-plans?dueThrough=2029-12-14')).body.data.length,0);
});
check('tuition replacements preserve earlier money, source labels and payment-method revisions without marking an installment paid',async f=>{
 const created=await f.create(),id=created.body.data.id;assert.equal(created.response.status,201,JSON.stringify(created.body));
 await f.request('finance/payment-methods/'+f.method+'/change',{expectedVersion:1,name:'Renamed transfer',reason:'Synthetic new label'});
 assert.equal((await f.request('finance/tuition-plans/'+id)).body.data.installments[0].methodName,'Synthetic transfer');
 const changed=await f.request('finance/tuition-plans/'+id+'/change',{...f.base,expectedVersion:1,agreedAmount:'90',installments:[{dueOn:'2030-02-01',amount:'101.70',methodId:f.method,methodVersion:2}]});assert.equal(changed.response.status,200,JSON.stringify(changed.body));assert.equal(changed.body.data.tax,'11.70');assert.equal(changed.body.data.version,2);
 const old=await f.request('finance/tuition-plans/'+id+'?version=1');assert.equal(old.response.status,200);assert.equal(old.body.data.plannedGross,'113.00');assert.equal(old.body.data.installments[0].methodName,'Synthetic transfer');assert.equal((await f.request('finance/tuition-plans/'+id)).body.data.installments[0].methodName,'Renamed transfer');
 const history=await f.request('finance/tuition-plans/'+id+'/history?limit=1');assert.equal(history.body.nextVersion,1);assert.equal((await f.request('finance/tuition-plans/'+id+'/history?afterVersion=1')).body.data[0].version,2);
});
check('non-master tuition requires upper approval and beneficiary guardians cannot review their own student benefit',async f=>{
 const pending=await f.create({},'manager');assert.equal(pending.response.status,202,JSON.stringify(pending.body));assert.equal((await f.request('finance/tuition-plans')).body.data.length,0);assert.equal((await f.approve(pending.body.approval.id,'manager')).response.status,403);
 const accepted=await f.approve(pending.body.approval.id);assert.equal(accepted.response.status,200,JSON.stringify(accepted.body));
 await f.request('guardians',{personId:f.actors.manager.person,legalName:'Synthetic guardian'});assert.equal((await f.request('students/'+f.one+'/guardians',{guardianId:f.actors.manager.person,relationship:'parent',reason:'Synthetic current family'})).response.status,201);
 const writer=await f.request('roles',{name:'Tuition submitter',permissions:['tuition.view','tuition.edit','enrollments.view','tax-codes.view','payment-methods.view','currencies.view'].map(capability=>({capability,effect:'allow'}))});assert.equal(writer.response.status,201);
 await f.setAccess('staff',[{roleId:writer.body.data.id,allHubs:true}]);
 const change=await f.request('finance/tuition-plans/'+accepted.body.data.id+'/change',{...f.base,expectedVersion:1,reason:'Child benefit'},'staff');assert.equal(change.response.status,202,JSON.stringify(change.body));const denied=await f.approve(change.body.approval.id,'manager');assert.equal(denied.response.status,403);assert.equal(denied.body.error.code,'BENEFICIARY_REVIEW_FORBIDDEN');assert.equal((await f.approve(change.body.approval.id)).response.status,200);
});
check('selected-student tuition viewers see only their own terms, without class rosters, peer finances or private review history',async f=>{
 const a=await f.create(),b=await f.create({},'master',f.peer);assert.equal(a.response.status,201,JSON.stringify(a.body));assert.equal(b.response.status,201);
 const role=await f.request('roles',{name:'One student tuition viewer',permissions:[{capability:'tuition.view',effect:'allow'}]});await f.setAccess('staff',[{roleId:role.body.data.id,allHubs:false,personIds:[f.one]}]);
 assert.equal((await f.request('finance/tuition-plans/'+a.body.data.id,undefined,'staff')).response.status,200);assert.equal((await f.request('finance/tuition-plans/'+b.body.data.id,undefined,'staff')).response.status,404);
 const list=await f.request('finance/tuition-plans?limit=1',undefined,'staff');assert.deepEqual(list.body.data.map((p:{id:string})=>p.id),[a.body.data.id]);assert.equal(list.body.nextCursor,null);
 assert.equal((await f.request('classes/'+f.own.class_id+'/roster',undefined,'staff')).response.status,403);assert.equal((await f.request('finance/tuition-plans/'+a.body.data.id+'/history',undefined,'staff')).response.status,403);assert.equal((await f.request('finance/tuition-plans/'+a.body.data.id+'?version=1',undefined,'staff')).response.status,403);
 assert.equal((await f.request('finance/tuition-plans/'+a.body.data.id,undefined,'foreignMaster',{academy:f.b})).response.status,404);
});
check('exact half-cent, tax-inclusive, non-taxable, zero tuition and large decimal amounts retain every unit',async f=>{
 for(const [patch,tax,gross] of [
  [{originalAmount:'113',agreedAmount:'113',pricing:'tax_inclusive'},'13.00','113.00'],
  [{originalAmount:'0.05',agreedAmount:'0.05',installments:[{...f.base.installments[0],amount:'0.06'}]},'0.01','0.06'],
  [{originalAmount:'0',agreedAmount:'0',installments:[]},'0.00','0.00'],
  [{originalAmount:'9007199254740993.01',agreedAmount:'9007199254740993.01',pricing:'tax_inclusive',installments:[{...f.base.installments[0],amount:'9007199254740993.01'}]},'1036226462934804.51','9007199254740993.01']
 ] as [Record<string,unknown>,string,string][]){const e=await f.createEnrollment(f.one),r=await f.create(patch,'master',e);assert.equal(r.response.status,201,JSON.stringify(r.body));assert.equal(r.body.data.tax,tax);assert.equal(r.body.data.plannedGross,gross);}
 const exempt=await f.request('finance/tax-codes',{code:'EXEMPT',name:'Synthetic exempt supply',hubId:f.hub,countryCode:'CA',classification:'exempt',ratePercent:'0',startsOn:'2026-01-01',legalBasis:'Synthetic explicit classification',reason:'Synthetic test'});assert.equal(exempt.response.status,201);
 const e=await f.createEnrollment(f.one),r=await f.create({taxCodeId:exempt.body.data.id,pricing:'not_applicable',installments:[{...f.base.installments[0],amount:'100'}]},'master',e);assert.equal(r.response.status,201,JSON.stringify(r.body));assert.equal(r.body.data.classification,'exempt');assert.equal(r.body.data.tax,'0.00');
});
check('inexact schedules, ambiguous or unsafe amounts, unreviewed tax bypasses and fabricated paid states never create a plan',async f=>{
 for(const patch of [{agreedAmount:'-1'},{originalAmount:-1},{agreedAmount:'1e2'},{agreedAmount:'100.001'},
  {installments:[{...f.base.installments[0],amount:'112.99'}]},{installments:[{...f.base.installments[0],amount:'0'}]},{installments:[]},
  {pricing:'not_applicable'},{paid:true},{skipReporting:true},{cardNumber:'synthetic'},{currencyVersion:999},{taxCodeVersion:999},{enrollmentVersion:999}]){
  const r=await f.create(patch);assert.ok([400,409].includes(r.response.status),JSON.stringify({patch,body:r.body}));
 }
 assert.equal((await f.pg.query('SELECT * FROM public.tuition_plans')).rows.length,0);assert.equal((await f.request('finance/tuition-plans?dueFrom=2030-02-01&dueThrough=2030-01-01')).response.status,400);
});
check('cancellation keeps old schedules and can be reviewed after enrollment, tax, method or class retirement without forgiving posted money',async f=>{
 const r=await f.create(),id=r.body.data.id;assert.equal(r.response.status,201,JSON.stringify(r.body));await f.request('finance/payment-methods/'+f.method+'/change',{expectedVersion:1,active:false,reason:'Retired'});await f.request('finance/tax-codes/'+f.tax+'/change',{expectedVersion:1,active:false,reason:'Retired'});
 await f.request('enrollments/'+f.own.id+'/change',{expectedVersion:1,enabled:false,reason:'Enrollment ended'});
 const cancelled=await f.request('finance/tuition-plans/'+id+'/cancel',{expectedVersion:1,reason:'Stop future planning'});assert.equal(cancelled.response.status,200,JSON.stringify(cancelled.body));assert.equal(cancelled.body.data.state,'cancelled');assert.equal(cancelled.body.data.plannedGross,'113.00');assert.equal(cancelled.body.data.installments.length,2);assert.equal(cancelled.body.data.posted,false);
 assert.equal((await f.request('finance/tuition-plans?state=active')).body.data.length,0);assert.equal((await f.request('finance/tuition-plans/'+id+'?version=1')).body.data.state,'active');assert.equal((await f.request('finance/tuition-plans/'+id+'/cancel',{expectedVersion:2,reason:'Already cancelled'})).response.status,409);
});
check('tuition retries and event failures preserve one plan and atomically roll back revisions, installments and approvals',async f=>{
 const key=randomUUID(),r=await f.create({},'master',f.own,key);assert.equal(r.response.status,201,JSON.stringify(r.body));assert.deepEqual((await f.create({},'master',f.own,key)).body,r.body);assert.equal((await f.create()).body.error.code,'TUITION_PLAN_EXISTS');
 const before=(await f.pg.query('SELECT * FROM public.approval_requests')).rows.length,id=r.body.data.id;await f.pg.exec('REVOKE INSERT ON public.outbox_events FROM kavosh_runtime');try{assert.equal((await f.request('finance/tuition-plans/'+id+'/change',{...f.base,expectedVersion:1})).response.status,503);}finally{await f.pg.exec('GRANT INSERT ON public.outbox_events TO kavosh_runtime');}
 assert.equal((await f.request('finance/tuition-plans/'+id)).body.data.version,1);assert.equal((await f.pg.query('SELECT * FROM public.tuition_plan_revisions')).rows.length,1);assert.equal((await f.pg.query('SELECT * FROM public.tuition_installments')).rows.length,2);assert.equal((await f.pg.query('SELECT * FROM public.approval_requests')).rows.length,before);
});
check('pending tuition binds current enrollment, tax and method versions and cannot be applied or approved by a bot',async f=>{
 const pending=await f.create({},'manager');assert.equal(pending.response.status,202,JSON.stringify(pending.body));await f.request('finance/payment-methods/'+f.method+'/change',{expectedVersion:1,name:'Changed source',reason:'Synthetic source update'});
 const stale=await f.approve(pending.body.approval.id);assert.equal(stale.response.status,409,JSON.stringify(stale.body));assert.ok(['DEPENDENCIES_CHANGED','PAYMENT_METHOD_CHANGED'].includes(stale.body.approval?.decisionCode??stale.body.error?.code));assert.equal((await f.request('finance/tuition-plans')).body.data.length,0);
 const input={installments:f.base.installments.map(i=>({...i,methodVersion:2}))},bot=await f.create(input,'bot');assert.equal(bot.response.status,202,JSON.stringify(bot.body));assert.equal((await f.approve(bot.body.approval.id,'bot')).response.status,403);assert.equal((await f.approve(bot.body.approval.id)).response.status,200);
});
check('tuition record-context denials agree in JavaScript/native SQL and hide cross-facet approval payloads before pagination',async f=>{
 const all={all:true,hubs:[]},context={hubId:f.hub,classId:f.own.class_id,studentId:f.one},target={all:false,hubs:[],people:[{id:f.one,hubId:f.hub}],recordContext:context};
 for(const source of [all,{...all,excludedHubs:[f.hub]},{...all,excludedClasses:[{id:f.own.class_id,hubId:f.hub}]},{...all,excludedPeople:[{id:f.one,hubId:f.hub}]}]){
  const native=(await f.pg.query<{allowed:boolean}>('SELECT public.scope_contains($1::jsonb,$2::jsonb) AS allowed',[JSON.stringify(source),JSON.stringify(target)])).rows[0].allowed;assert.equal(native,scopeContains(source,target));assert.equal(native,source===all);
 }
 const selected=await f.request('roles',{name:'Selected student tuition editor',permissions:['tuition.view','tuition.edit'].map(capability=>({capability,effect:'allow'}))}),denied=await f.request('roles',{name:'Denied tuition class',permissions:['tuition.view','tuition.edit'].map(capability=>({capability,effect:'deny'}))});
 await f.setAccess('staff',[{roleId:selected.body.data.id,allHubs:false,personIds:[f.one]},{roleId:f.managerRole,allHubs:false,hubIds:[f.hub]},{roleId:f.policyRole,allHubs:true}]);
 // Remove broad tuition rights from the separately assigned source-support role.
 const support=await f.request('roles',{name:'Tuition source support',permissions:['enrollments.view','tax-codes.view','payment-methods.view','currencies.view'].map(capability=>({capability,effect:'allow'}))});
 await f.setAccess('staff',[{roleId:selected.body.data.id,allHubs:false,personIds:[f.one]},{roleId:support.body.data.id,allHubs:true}]);
 const pending=await f.create({},'staff');assert.equal(pending.response.status,202,JSON.stringify(pending.body));await f.setAccess('manager',[{roleId:f.managerRole,allHubs:false,hubIds:[f.hub]},{roleId:f.policyRole,allHubs:true},{roleId:denied.body.data.id,allHubs:false,classIds:[f.own.class_id]}]);
 assert.equal((await f.request('approvals/'+pending.body.approval.id,undefined,'manager')).response.status,404);assert.ok(!(await f.request('approvals?limit=1',undefined,'manager')).body.data.some((p:{id:string})=>p.id===pending.body.approval.id));
 assert.ok(!JSON.stringify((await f.request('audit-events')).body).includes('recordContext'));
});
check('native tuition preserves tenant binding, immutable identity/history, exact taxes and deferred installment conservation',async f=>{
 const r=await f.create();assert.equal(r.response.status,201,JSON.stringify(r.body));const id=r.body.data.id;
 await f.pg.exec('SET ROLE kavosh_runtime');try{await f.pg.query("SELECT set_config('app.academy_id',$1,false)",[f.b]);assert.equal((await f.pg.query('SELECT * FROM public.tuition_plans')).rows.length,0);await f.pg.query("SELECT set_config('app.academy_id',$1,false)",[f.a]);
  for(const sql of ['DELETE FROM public.tuition_plan_revisions','UPDATE public.tuition_installments SET amount_minor=1','UPDATE public.tuition_plans SET hub_id=NULL','DELETE FROM public.tuition_installments'])await assert.rejects(f.pg.exec(sql),/permission denied/i);
  await assert.rejects(f.pg.exec('UPDATE public.tuition_plans SET version=version+2'),/FINANCE_VERSION_SEQUENCE/);
 }finally{await f.pg.exec('RESET ROLE');}
 // An extra native installment cannot silently inflate an existing schedule.
 await assert.rejects(f.pg.query(`INSERT INTO public.tuition_installments(academy_id,plan_id,version,ordinal,due_on,amount_minor,method_id,method_version) VALUES($1,$2,1,3,'2030-01-01',1,$3,1)`,[f.a,id,f.method]),/TUITION_SCHEDULE_MISMATCH/);
 assert.equal((await f.pg.query('SELECT * FROM public.tuition_installments')).rows.length,2);
});
check('revoked tuition editing hides private pending terms and read-only schools cannot alter plans',async f=>{
 const pending=await f.create({},'manager');assert.equal(pending.response.status,202);await f.pg.query("DELETE FROM public.role_permissions WHERE role_id=$1 AND capability='tuition.edit'",[f.managerRole]);
 assert.equal((await f.request('approvals/'+pending.body.approval.id,undefined,'manager')).response.status,404);assert.equal((await f.approve(pending.body.approval.id)).body.approval.decisionCode,'AUTHORITY_CHANGED');
 const created=await f.create();assert.equal(created.response.status,201,JSON.stringify(created.body));await f.pg.query("UPDATE public.academies SET status='read_only' WHERE id=$1",[f.a]);
 assert.equal((await f.request('finance/tuition-plans/'+created.body.data.id)).response.status,200);assert.equal((await f.request('finance/tuition-plans/'+created.body.data.id+'/cancel',{expectedVersion:1,reason:'Must not mutate'})).response.status,403);
});
check('selected-person tuition authority cannot be delegated from only a primary hub or lose cross-facet denials',async f=>{
 const viewer=await f.request('roles',{name:'Student tuition delegation',permissions:[{capability:'tuition.view',effect:'allow'}]}),deny=await f.request('roles',{name:'Class tuition delegation exclusion',permissions:[{capability:'tuition.view',effect:'deny'}]}),access=await f.request('roles',{name:'Tuition delegation administrator',permissions:[{capability:'access.edit',effect:'allow'}]});
 const path='people/'+f.actors.staff.person+'/access',old=(await f.request(path)).body.data.version,selected={roleId:viewer.body.data.id,allHubs:false,personIds:[f.one]},blocked={roleId:deny.body.data.id,allHubs:false,classIds:[f.own.class_id]};
 const broadening=await f.request(path,{expectedVersion:old,assignments:[selected]},'manager');assert.equal(broadening.response.status,403);assert.equal(broadening.body.error.code,'DELEGATION_EXCEEDS_AUTHORITY');
 await f.setAccess('manager',[selected,blocked,{roleId:access.body.data.id,allHubs:true},{roleId:f.managerRole,allHubs:false,hubIds:[f.hub]}]);
 const dropping=await f.request(path,{expectedVersion:old,assignments:[selected]},'manager');assert.equal(dropping.response.status,403);assert.equal(dropping.body.error.code,'DELEGATION_EXCEEDS_AUTHORITY');
 const safe=await f.request(path,{expectedVersion:old,assignments:[selected,blocked]},'manager');assert.equal(safe.response.status,202,JSON.stringify(safe.body));assert.equal((await f.approve(safe.body.approval.id)).response.status,200);
});
check('student tuition across hubs respects explicit record-hub denials and the current bot credential ceiling',async f=>{
 const own=await f.create();assert.equal(own.response.status,201,JSON.stringify(own.body));
 const tax=await f.request('finance/tax-codes',{code:'GLOBAL',name:'Synthetic shared tax',hubId:null,countryCode:'CA',classification:'taxable',ratePercent:'13',startsOn:'2026-01-01',legalBasis:'Synthetic cross-hub example',reason:'Synthetic setup'}),method=await f.request('finance/payment-methods',{code:'GLOBAL',name:'Shared method',category:'cash',hubId:null,reason:'Synthetic setup'});
 assert.equal(tax.response.status,201);assert.equal(method.response.status,201);
 const other=await f.create({taxCodeId:tax.body.data.id,installments:f.base.installments.map(i=>({...i,methodId:method.body.data.id}))},'master',f.other);assert.equal(other.response.status,201,JSON.stringify(other.body));
 const viewer=await f.request('roles',{name:'Student tuition across hubs',permissions:[{capability:'tuition.view',effect:'allow'}]}),deny=await f.request('roles',{name:'Tuition record hub exclusion',permissions:[{capability:'tuition.view',effect:'deny'}]});
 const selected={roleId:viewer.body.data.id,allHubs:false,personIds:[f.one]};await f.setAccess('staff',[selected,{roleId:deny.body.data.id,allHubs:false,hubIds:[f.otherHub]}]);
 assert.equal((await f.request('finance/tuition-plans',undefined,'staff')).body.data.length,1);assert.equal((await f.request('finance/tuition-plans/'+other.body.data.id,undefined,'staff')).response.status,404);
 await f.setAccess('bot',[selected]);assert.equal((await f.request('finance/tuition-plans',undefined,'bot')).body.data.length,2);await f.pg.query('UPDATE auth_private.credentials SET all_hubs=false WHERE id=$1',[f.credential]);await f.pg.query('INSERT INTO auth_private.credential_hubs VALUES($1,$2,$3)',[f.credential,f.a,f.hub]);
 assert.equal((await f.request('finance/tuition-plans',undefined,'bot')).body.data.length,1);assert.equal((await f.request('finance/tuition-plans/'+other.body.data.id,undefined,'bot')).response.status,404);
});
check('selected-class tuition rights cannot reveal a denied student, even when a separate person grant exists',async f=>{
 const own=await f.create(),peer=await f.create({},'master',f.peer);assert.equal(own.response.status,201,JSON.stringify(own.body));assert.equal(peer.response.status,201);
 const allow=await f.request('roles',{name:'Class tuition view',permissions:[{capability:'tuition.view',effect:'allow'}]}),deny=await f.request('roles',{name:'Student tuition exclusion',permissions:[{capability:'tuition.view',effect:'deny'}]});
 await f.setAccess('staff',[{roleId:allow.body.data.id,allHubs:false,classIds:[f.own.class_id]}]);assert.equal((await f.request('finance/tuition-plans/'+own.body.data.id,undefined,'staff')).response.status,200);assert.equal((await f.request('finance/tuition-plans/'+peer.body.data.id,undefined,'staff')).response.status,404);
 await f.setAccess('staff',[{roleId:allow.body.data.id,allHubs:false,classIds:[f.own.class_id],personIds:[f.one]},{roleId:deny.body.data.id,allHubs:false,personIds:[f.one]}]);assert.equal((await f.request('finance/tuition-plans',undefined,'staff')).body.data.length,0);assert.equal((await f.request('finance/tuition-plans/'+own.body.data.id,undefined,'staff')).response.status,404);
 const source={all:false,hubs:[],classes:[{id:f.own.class_id,hubId:f.hub}],excludedPeople:[{id:f.one,hubId:f.hub}]},target={all:false,hubs:[],classes:[{id:f.own.class_id,hubId:f.hub}],recordContext:{classId:f.own.class_id,studentId:f.one,hubId:f.hub}};
 assert.equal(scopeContains(source,target),false);assert.equal((await f.pg.query<{allowed:boolean}>('SELECT public.scope_contains($1::jsonb,$2::jsonb) AS allowed',[JSON.stringify(source),JSON.stringify(target)])).rows[0].allowed,false);
});
check('retired methods and changed currency precision cannot silently reinterpret existing tuition terms',async f=>{
 const created=await f.create();assert.equal(created.response.status,201,JSON.stringify(created.body));const id=created.body.data.id;
 assert.equal((await f.request('finance/currencies/'+f.currency+'/change',{expectedVersion:1,unitScale:3,reason:'Synthetic prospective precision'})).response.status,200);
 const rejected=await f.request('finance/tuition-plans/'+id+'/change',{...f.base,expectedVersion:1,currencyVersion:2});assert.equal(rejected.response.status,409);assert.equal(rejected.body.error.code,'TUITION_CURRENCY_UNIT_CHANGE_FORBIDDEN');
 const unchanged=(await f.request('finance/tuition-plans/'+id)).body.data;assert.equal(unchanged.currencyVersion,1);assert.equal(unchanged.unitScale,2);assert.equal(unchanged.plannedGross,'113.00');
 assert.equal((await f.request('finance/tuition-plans/'+id+'/cancel',{expectedVersion:1,reason:'Cancel stored plan without changing units'})).response.status,200);
});
if(process.env.TEST_DATABASE_URL)check('simultaneous native tuition submissions and replacements retain exactly one winner and complete immutable schedules',async f=>{
 const results=await Promise.all([f.create(),f.create()]);assert.deepEqual(results.map(r=>r.response.status).sort(),[201,409]);const id=results.find(r=>r.response.status===201)!.body.data.id;
 const changes=await Promise.all(['A','B'].map(reason=>f.request('finance/tuition-plans/'+id+'/change',{...f.base,expectedVersion:1,reason})));assert.deepEqual(changes.map(r=>r.response.status).sort(),[200,409]);
 assert.equal((await f.pg.query('SELECT * FROM public.tuition_plans')).rows.length,1);assert.equal((await f.pg.query('SELECT * FROM public.tuition_plan_revisions')).rows.length,2);assert.equal((await f.pg.query('SELECT * FROM public.tuition_installments')).rows.length,4);
});
if(process.env.TEST_DATABASE_URL)check('one thousand exact installments persist in one bounded batch with native conservation under the unchanged statement limit',async f=>{
 const installments=Array.from({length:1000},()=>({...f.base.installments[0],amount:'0.01'})),before=f.metrics.businessQueries,started=performance.now(),r=await f.create({originalAmount:'10',agreedAmount:'10',pricing:'tax_inclusive',installments});
 assert.equal(r.response.status,201,JSON.stringify(r.body));assert.equal(r.body.data.installments.length,1000);assert.equal(r.body.data.tax,'1.15');assert.equal(r.body.data.plannedGross,'10.00');assert.equal((await f.pg.query('SELECT sum(amount_minor)::text AS total FROM public.tuition_installments')).rows[0].total,'1000');
 const queries=f.metrics.businessQueries-before;assert.ok(queries<60,JSON.stringify({queries}));console.log(JSON.stringify({measurement:'synthetic-tuition-installment-batch',installments:1000,elapsedMs:Math.ceil(performance.now()-started),clientQueries:queries,statementLimitMs:5000,actualPayments:0}));
});
if(process.env.TEST_DATABASE_URL)check('one hundred simultaneous tuition reads retain exact scoped terms with bounded query counts',async f=>{
 const created=await f.create();assert.equal(created.response.status,201,JSON.stringify(created.body));const before=f.metrics.businessQueries,times:number[]=[];
 await Promise.all(Array.from({length:100},async()=>{const started=performance.now(),r=await f.request('finance/tuition-plans/'+created.body.data.id,undefined,'staff');times.push(performance.now()-started);assert.equal(r.response.status,200,JSON.stringify(r.body));assert.equal(r.body.data.plannedGross,'113.00');assert.equal(r.body.data.installments.length,2);}));
 const queries=f.metrics.businessQueries-before;assert.ok(queries<=1600,JSON.stringify({queries}));console.log(JSON.stringify({measurement:'synthetic-tuition-read',requests:100,poolMaximum:4,clientQueries:queries,p99Ms:Math.ceil(times.sort((a,b)=>a-b)[98]),actualPayments:0}));
});
