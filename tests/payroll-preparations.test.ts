import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { workFixture } from './work-fixture.ts';
import { sessionEvidenceCapabilities } from '../src/modules/session-evidence-report.ts';

const workCaps=['work-pay.view','pay-periods.view','payroll-preparations.view','payroll-preparations.edit'],sessionCaps=[...sessionEvidenceCapabilities,'session-evidence.view'];
async function fixture(){const f=await workFixture();try{
 for(const role of [f.staffRole,f.managerRole])for(const cap of [...workCaps,...sessionCaps,'session-time.record'])await f.pg.query("INSERT INTO public.role_permissions VALUES($1,$2,$3,'allow') ON CONFLICT DO NOTHING",[f.a,role,cap]);
 const session=(await f.request('classes/'+f.c.id+'/sessions')).body.data[0];assert.equal((await f.request('sessions/'+session.id+'/change',{expectedVersion:1,reason:'Synthetic past teaching session',change:{kind:'reschedule',start:'2026-01-05T10:00',end:'2026-01-05T11:00'}})).response.status,200);
 const hourly=f.components.find(c=>c.code==='TEACH')!,engagement=(await f.create({components:[hourly]}));assert.equal(engagement.response.status,201);
 const timeInput={expectedVersion:0,assignmentId:f.assignment.id,assignmentVersion:1,sessionVersion:2,startsAt:'2026-01-05T15:00:00Z',endsAt:'2026-01-05T16:02:00Z',reason:'PRIVATE delivered time'};
 const save=(patch:Record<string,unknown>={})=>f.request('sessions/'+session.id+'/my-time',{...timeInput,...patch},'staff');assert.equal((await save()).response.status,201);
 const input={personId:f.actors.staff.person,from:'2026-01-01',through:'2026-01-31',timeZone:'America/Toronto',label:'January payroll preparation'},prepare=(patch:Record<string,unknown>={},as='master',key?:string)=>f.request('payroll/preparations',{...input,...patch},as,{key});
 return {...f,engagement:engagement.body.data,hourly,session,save,preparationInput:input,prepare};
}catch(e){await f.pg.close();throw e;}}
type Fixture=Awaited<ReturnType<typeof fixture>>;
function check(name:string,run:(f:Fixture)=>Promise<void>,nativeOnly=false){test(name,{skip:nativeOnly&&!process.env.TEST_DATABASE_URL},async()=>{const f=await fixture();try{await run(f);}finally{await f.pg.close();}});}
async function made(f:Fixture){const r=await f.prepare();assert.equal(r.response.status,201,JSON.stringify({body:r.body,failures:f.metrics.queryFailures}));return r.body.data;}

check('payroll preparations retain actual source versions and exact hourly alternatives but create no claim, approval, wage or payment',async f=>{
 const d=await made(f);assert.equal(d.status,'prepared_draft');assert.equal(d.sourcesCurrent,true);assert.equal(d.calculation.currencies[0].hourly.actual.gross.amount,'20.67');assert.equal(d.calculation.currencies[0].hourly.configured.gross.amount,'20.00');assert.equal(d.calculation.currencies[0].hourly.configuredReductionRequiresReview,true);assert.equal(d.calculation.sessionEvidence[0].operationalReviewAccepted,false);
 for(const k of ['completePayroll','claimsPersisted','wagesAccrued','payrollApproved','statutoryDeductionsCalculated','paymentExecuted','mediaContentVerified'])assert.equal(d.calculation[k],false);
 assert.equal((await f.pg.query('SELECT * FROM public.payroll_preparations')).rows.length,1);assert.equal((await f.pg.query('SELECT * FROM public.finance_journals')).rows.length,0);assert.equal((await f.pg.query("SELECT * FROM public.approval_requests WHERE action LIKE 'work.preparation%'")).rows.length,0);assert.doesNotMatch(JSON.stringify(d),/PRIVATE delivered time|Private work terms|Private legal worker|taxReview|source_snapshot/);
 assert.equal((await f.request('payroll/preparations')).body.data[0].id,d.id);assert.equal((await f.request('payroll/preparations/'+d.id)).body.data.sourcesCurrent,true);
 const pinned=(await f.pg.query<{source_snapshot:{windowStartMilliseconds:string;windowEndMilliseconds:string}}>('SELECT source_snapshot FROM public.payroll_preparations WHERE id=$1',[d.id])).rows[0].source_snapshot;assert.equal(pinned.windowStartMilliseconds,String(Date.parse('2026-01-01T05:00:00Z')));assert.equal(pinned.windowEndMilliseconds,String(Date.parse('2026-02-01T05:00:00Z')));
});
check('later time and rate changes cannot rewrite retained source earnings and new drafts capture the new basis',async f=>{
 const d=await made(f);assert.equal((await f.save({expectedVersion:1,endsAt:'2026-01-05T16:01:00Z'})).response.status,200);assert.equal((await f.amend(f.engagement.id,{components:[{...f.hourly,amount:'30'}]})).response.status,200);
 const old=(await f.request('payroll/preparations/'+d.id)).body.data;assert.equal(old.sourcesCurrent,false);assert.equal(old.calculation.currencies[0].hourly.actual.gross.amount,'20.67');assert.equal(old.calculation.currencies[0].sourceRefs[0].termsVersion,1);
 const next=await made(f);assert.equal(next.calculation.currencies[0].hourly.actual.gross.amount,'30.50');assert.equal(next.calculation.currencies[0].sourceRefs[0].termsVersion,2);assert.equal(next.sourcesCurrent,true);
});
check('a crossing-midnight time entry is retained and clipped instead of disappearing from the next payroll day',async f=>{
 assert.equal((await f.save({expectedVersion:1,startsAt:'2026-01-05T23:30:00Z',endsAt:'2026-01-06T00:30:00Z'})).response.status,200);
 const r=await f.prepare({from:'2026-01-06',through:'2026-01-06',timeZone:'UTC'});assert.equal(r.response.status,201,JSON.stringify(r.body));assert.equal(r.body.data.calculation.currencies[0].hourly.actual.gross.amount,'10.00');assert.equal(r.body.data.calculation.currencies[0].hourly.actual.milliseconds,'1800000');
});
check('non-hourly work and missing evidence remain explicit unresolved sources rather than zero-valued completed payroll',async f=>{
 assert.equal((await f.amend(f.engagement.id,{components:f.components})).response.status,200);const d=await made(f);assert.deepEqual(d.calculation.nonHourlySources.map((s:{kind:string})=>s.kind).sort(),['project','salary','tuition_percentage']);assert.ok(d.calculation.unpricedComponents.some((s:{reason:string})=>s.reason==='NON_HOURLY_BASIS_REQUIRED'));assert.equal(d.calculation.completePayroll,false);assert.equal(d.calculation.sessionEvidence[0].reviewVersion,null);
});
check('complete worker authority is required before pricing and new hidden engagements also hide retained drafts',async f=>{
 const d=await made(f);const initial=await f.prepare({},'manager');assert.equal(initial.response.status,201,JSON.stringify(initial.body));
 const c=await f.made('classes',{hubId:f.otherHub,courseId:f.c.course_id,courseVersion:1,name:'Other hub concurrent teaching',mode:'in_person',schedule:{oneOff:[{start:'2026-01-05T10:00',end:'2026-01-05T11:00',disambiguation:'reject'}]}}),a=await f.made('classes/'+c.id+'/staff',{personId:f.actors.staff.person,role:'teacher',startsOn:'2026-01-01',reason:'Synthetic second hub staffing'});
 const recordRole=await f.made('roles',{name:'Staff records own assigned time',permissions:[{capability:'session-time.record',effect:'allow'}]});await f.pg.query('INSERT INTO public.role_assignments(academy_id,id,person_id,role_id,all_hubs) VALUES($1,$2,$3,$4,true)',[f.a,randomUUID(),f.actors.staff.person,recordRole.id]);const session=(await f.request('classes/'+c.id+'/sessions')).body.data[0];
 assert.equal((await f.request('sessions/'+session.id+'/my-time',{expectedVersion:0,assignmentId:a.id,assignmentVersion:1,sessionVersion:1,startsAt:'2026-01-05T15:00:00Z',endsAt:'2026-01-05T16:02:00Z',reason:'Synthetic other hub delivered time'},'staff')).response.status,201);
 const hidden=await f.create({hubId:f.otherHub,code:'OTHER-HUB',components:[{...f.hourly,assignment:{id:a.id,version:1},method:null,amount:'50'}]});assert.equal(hidden.response.status,201,JSON.stringify(hidden.body));
 assert.equal((await f.prepare({},'manager')).response.status,404);assert.equal((await f.request('payroll/preparations/'+d.id,undefined,'manager')).response.status,404);assert.deepEqual((await f.request('payroll/preparations',undefined,'manager')).body.data,[]);
 const master=await made(f);assert.equal(master.calculation.currencies[0].hourly.actual.gross.amount,'51.67');
});
check('feature/source revocations and cross-school records fail closed, including replayed creation receipts',async f=>{
 const key=randomUUID(),created=await f.prepare({},'manager',key);assert.equal(created.response.status,201);const id=created.body.data.id;
 await f.pg.query("DELETE FROM public.role_permissions WHERE role_id=$1 AND capability='session-time.view'",[f.managerRole]);assert.equal((await f.prepare({},'manager',key)).response.status,403);assert.equal((await f.request('payroll/preparations/'+id,undefined,'manager')).response.status,403);assert.equal((await f.request('payroll/preparations/'+randomUUID(),undefined,'manager')).response.status,403);
 assert.equal((await f.request('payroll/preparations/'+id,undefined,'foreignMaster',{academy:f.b})).response.status,404);assert.deepEqual((await f.request('payroll/preparations',undefined,'foreignMaster',{academy:f.b})).body.data,[]);
});
check('source-budget errors cannot disclose the presence of hidden worker arrangements',async f=>{
 assert.equal((await f.create({hubId:f.otherHub,code:'HIDDEN-SALARY',components:[f.components[0]]})).response.status,201);
 await f.pg.exec(`CREATE OR REPLACE FUNCTION public.payroll_preparation_source(p_person uuid,p_from date,p_through date,p_zone text) RETURNS jsonb LANGUAGE sql STABLE SET search_path=pg_catalog AS $$SELECT '{"oversized":true}'::jsonb$$`);
 assert.equal((await f.prepare({},'manager')).response.status,404);assert.equal((await f.prepare()).response.status,422);assert.equal((await f.pg.query('SELECT * FROM public.payroll_preparations')).rows.length,0);
});
check('exact retries survive later source edits but changed payloads cannot reuse the same receipt',async f=>{
 const key=randomUUID(),first=await f.prepare({},'master',key);assert.equal(first.response.status,201);assert.equal((await f.save({expectedVersion:1,endsAt:'2026-01-05T16:01:00Z'})).response.status,200);
 const retry=await f.prepare({},'master',key);assert.equal(retry.response.status,201);assert.deepEqual(retry.body,first.body);assert.equal((await f.prepare({label:'Changed'},'master',key)).response.status,409);assert.equal((await f.pg.query('SELECT * FROM public.payroll_preparations')).rows.length,1);
});
check('selected-worker access follows payroll record hubs instead of a mutable primary hub, while explicit hub denials win',async f=>{
 const work=await f.made('roles',{name:'Selected payroll worker',permissions:workCaps.map(capability=>({capability,effect:'allow'}))}),sessions=await f.made('roles',{name:'Selected payroll classes',permissions:sessionCaps.map(capability=>({capability,effect:'allow'}))}),path='people/'+f.actors.staff.person+'/access',old=(await f.request(path)).body.data;
 assert.equal((await f.request(path,{expectedVersion:old.version,assignments:[{roleId:work.id,allHubs:false,personIds:[f.actors.staff.person]},{roleId:sessions.id,allHubs:false,hubIds:[f.hub]}]})).response.status,200);
 await f.pg.query('UPDATE public.people SET hub_id=$2 WHERE id=$1',[f.actors.staff.person,f.otherHub]);const d=await f.prepare({},'staff');assert.equal(d.response.status,201,JSON.stringify(d.body));
 const deny=await f.made('roles',{name:'Explicit payroll hub denial',permissions:[{capability:'payroll-preparations.view',effect:'deny'}]}),assignment=randomUUID();await f.pg.query('INSERT INTO public.role_assignments(academy_id,id,person_id,role_id,all_hubs) VALUES($1,$2,$3,$4,false)',[f.a,assignment,f.actors.staff.person,deny.id]);await f.pg.query('INSERT INTO public.assignment_hubs(academy_id,assignment_id,hub_id) VALUES($1,$2,$3)',[f.a,assignment,f.hub]);assert.equal((await f.request('payroll/preparations/'+d.body.data.id,undefined,'staff')).response.status,404);
});
check('accepted evidence is pinned without treating media references as safe content or later time corrections as accepted',async f=>{
 assert.equal((await f.request('sessions/'+f.session.id+'/attendance/change',{expectedVersion:0,sessionVersion:2,entries:[],reason:'Synthetic complete empty historical roster'})).response.status,200);
 const review=await f.request('sessions/'+f.session.id+'/evidence-review',{expectedVersion:0,decision:'accepted',waiveReport:true,waiveMedia:true,reason:'Explicit session-only report/media exception'});assert.equal(review.response.status,200,JSON.stringify(review.body));
 const d=await made(f);assert.equal(d.calculation.sessionEvidence[0].reviewVersion,1);assert.equal(d.calculation.sessionEvidence[0].operationalReviewAccepted,true);assert.equal(d.calculation.mediaContentVerified,false);
 assert.equal((await f.save({expectedVersion:1,endsAt:'2026-01-05T16:01:00Z'})).response.status,200);const next=await made(f);assert.equal(next.calculation.sessionEvidence[0].operationalReviewAccepted,false);assert.equal(next.calculation.sessionEvidence[0].reviewedSourceCurrent,false);assert.equal((await f.request('payroll/preparations/'+d.id)).body.data.sourcesCurrent,false);
});
check('strict preparation inputs and bounded queries reject ambiguity, unused fields and invalid dates/zones',async f=>{
 for(const patch of [{from:'2026-02-30'},{through:'2025-12-31'},{timeZone:'+01:00'},{timeZone:'Unknown/Zone'},{label:''},{label:10},{rate:'50'},{priorClaims:[]},{personId:f.a}]){
  const r=await f.prepare(patch);assert.equal(r.response.status,patch.personId?404:400,JSON.stringify({patch,body:r.body}));
 }
 for(const path of ['payroll/preparations?limit=0','payroll/preparations?limit=1&limit=2','payroll/preparations?unknown=true'])assert.equal((await f.request(path)).response.status,400);
 assert.equal((await f.prepare({through:'2028-01-01'})).response.status,422);
 const last=await f.prepare({from:'9999-12-31',through:'9999-12-31'});assert.equal(last.response.status,201,JSON.stringify(last.body));assert.equal(last.body.data.calculation.currencies.length,0);
});
check('finite bot credentials cannot broaden school-wide draft roles into another payroll hub',async f=>{
 const role=await f.made('roles',{name:'Payroll preparation bot',permissions:[...workCaps,...sessionCaps].map(capability=>({capability,effect:'allow'}))}),path='people/'+f.bot+'/access',prior=(await f.request(path)).body.data;
 assert.equal((await f.request(path,{expectedVersion:prior.version,assignments:[{roleId:role.id,allHubs:true}]})).response.status,200);const d=await f.prepare({},'bot');assert.equal(d.response.status,201,JSON.stringify(d.body));
 await f.pg.query('UPDATE auth_private.credentials SET all_hubs=false WHERE id=$1',[f.credential]);await f.pg.query('INSERT INTO auth_private.credential_hubs(credential_id,academy_id,hub_id) VALUES($1,$2,$3)',[f.credential,f.a,f.otherHub]);assert.equal((await f.request('payroll/preparations/'+d.body.data.id,undefined,'bot')).response.status,404);assert.deepEqual((await f.request('payroll/preparations',undefined,'bot')).body.data,[]);assert.equal((await f.prepare({},'bot')).response.status,404);
});
check('overlapping currency alternatives stay unpriced instead of being compared as if exchange rates were one-to-one',async f=>{
 const usd=await f.made('finance/currencies',{code:'USD',name:'US dollar',unitScale:2,reason:'Synthetic independent currency'});assert.equal((await f.create({code:'USD',currency:{id:usd.id,version:1},components:[{...f.hourly,amount:'30'}]})).response.status,201);const d=await made(f);assert.equal(d.calculation.currencies.length,2);for(const c of d.calculation.currencies){assert.equal(c.requiresFXPolicy,true);assert.equal(c.hourly,null);}assert.equal(d.calculation.completePayroll,false);
});
check('native source guard rejects forged retained values and immutable drafts are tenant-isolated',async f=>{
 const d=await made(f),original=(await f.pg.query<{source_snapshot:any}>('SELECT source_snapshot FROM public.payroll_preparations WHERE id=$1',[d.id])).rows[0].source_snapshot,forged=structuredClone(original);forged.terms[0].components[0].amount='999';
 await f.pg.exec('BEGIN');try{await f.pg.query("SELECT set_config('app.academy_id',$1,true)",[f.a]);await f.pg.exec('SET LOCAL ROLE kavosh_runtime');await assert.rejects(f.pg.query('INSERT INTO public.payroll_preparations(academy_id,id,person_id,label,from_on,through_on,time_zone,source_snapshot,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)',[f.a,randomUUID(),f.actors.staff.person,'Forged',f.preparationInput.from,f.preparationInput.through,f.preparationInput.timeZone,JSON.stringify(forged),f.actors.master.person]),/PAYROLL_PREPARATION_SOURCE_CHANGED/);}finally{await f.pg.exec('ROLLBACK');}
 await f.pg.exec('BEGIN');try{await f.pg.query("SELECT set_config('app.academy_id',$1,true)",[f.a]);await f.pg.exec('SET LOCAL ROLE kavosh_runtime');await f.pg.query('INSERT INTO public.payroll_preparations(academy_id,id,person_id,label,from_on,through_on,time_zone,source_snapshot,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)',[f.a,randomUUID(),f.actors.staff.person,'Untraced draft',f.preparationInput.from,f.preparationInput.through,f.preparationInput.timeZone,JSON.stringify(original),f.actors.master.person]);await assert.rejects(f.pg.exec('COMMIT'),/PAYROLL_PREPARATION_AUDIT_REQUIRED/);}finally{await f.pg.exec('ROLLBACK');}
 for(const sql of ['UPDATE public.payroll_preparations SET label=\'Changed\'','DELETE FROM public.payroll_preparations']){await f.pg.exec('BEGIN');try{await f.pg.query("SELECT set_config('app.academy_id',$1,true)",[f.a]);await f.pg.exec('SET LOCAL ROLE kavosh_runtime');await assert.rejects(f.pg.exec(sql),/permission denied/);}finally{await f.pg.exec('ROLLBACK');}}
 await f.pg.exec('BEGIN');try{await f.pg.query("SELECT set_config('app.academy_id',$1,true)",[f.b]);await f.pg.exec('SET LOCAL ROLE kavosh_runtime');assert.equal((await f.pg.query('SELECT * FROM public.payroll_preparations')).rows.length,0);}finally{await f.pg.exec('ROLLBACK');}
});
check('audit/outbox failure rolls back the draft and receipt before the same key can succeed',async f=>{
 const key=randomUUID();await f.pg.exec("CREATE FUNCTION public.fail_preparation_test() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN IF NEW.event_type='work.preparation.created' THEN RAISE EXCEPTION 'injected preparation outbox failure';END IF;RETURN NEW;END$$;CREATE TRIGGER fail_preparation_test BEFORE INSERT ON public.outbox_events FOR EACH ROW EXECUTE FUNCTION public.fail_preparation_test()");
 assert.equal((await f.prepare({},'master',key)).response.status,503);assert.equal((await f.pg.query('SELECT * FROM public.payroll_preparations')).rows.length,0);await f.pg.exec('DROP TRIGGER fail_preparation_test ON public.outbox_events');assert.equal((await f.prepare({},'master',key)).response.status,201);assert.equal((await f.pg.query('SELECT * FROM public.payroll_preparations')).rows.length,1);
});
check('concurrent identical native submissions retain exactly one preparation and one source receipt',async f=>{
 const key=randomUUID(),results=await Promise.all([f.prepare({},'master',key),f.prepare({},'master',key)]);assert.deepEqual(results.map(r=>r.response.status),[201,201]);assert.equal(results[0].body.data.id,results[1].body.data.id);assert.equal((await f.pg.query('SELECT * FROM public.payroll_preparations')).rows.length,1);assert.equal((await f.pg.query("SELECT * FROM public.outbox_events WHERE event_type='work.preparation.created'")).rows.length,1);
},true);
test('schema95 to96 preserves existing work terms and creates no invented payroll preparations',async()=>{
 const f=await workFixture({throughSchema:95});try{
  assert.equal((await f.create({components:[f.components[1]]})).response.status,201);const before=(await f.pg.query('SELECT to_jsonb(r) value FROM public.work_engagement_revisions r ORDER BY engagement_id,version')).rows;
  await f.pg.exec(await readFile(new URL('../db/migrations/096_payroll_preparations.sql',import.meta.url),'utf8'));assert.equal((await f.pg.query('SELECT public.schema_revision() revision')).rows[0].revision,96);assert.deepEqual((await f.pg.query('SELECT to_jsonb(r) value FROM public.work_engagement_revisions r ORDER BY engagement_id,version')).rows,before);assert.equal((await f.pg.query('SELECT * FROM public.payroll_preparations')).rows.length,0);
  const r=await f.request('payroll/preparations',{personId:f.actors.staff.person,from:'2026-01-01',through:'2026-01-31',timeZone:'UTC',label:'Explicit first draft after upgrade'});assert.equal(r.response.status,201,JSON.stringify(r.body));assert.equal(r.body.data.calculation.currencies.length,0);assert.equal(r.body.data.calculation.payrollApproved,false);
 }finally{await f.pg.close();}
});
