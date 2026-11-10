import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile,readdir } from 'node:fs/promises';
import { workFixture } from './work-fixture.ts';
import { recordedWorkReport,recordedWorkCsv } from '../src/modules/recorded-work-report.ts';
import { parse } from 'csv-parse/sync';
import { spreadsheetRows } from './spreadsheet-reader.ts';
import type { ApiContext } from '../src/core/api.ts';

async function fixture(throughSchema?:number){const f=await workFixture({throughSchema});try{
 for(const role of [f.staffRole,f.managerRole])for(const cap of ['financial-reports.view','session-time.view','session-time.record'])await f.pg.query("INSERT INTO public.role_permissions VALUES($1,$2,$3,'allow') ON CONFLICT DO NOTHING",[f.a,role,cap]);
 const session=(await f.request('classes/'+f.c.id+'/sessions')).body.data[0];
 assert.equal((await f.request('sessions/'+session.id+'/change',{expectedVersion:1,reason:'Synthetic past teaching session',change:{kind:'reschedule',start:'2026-01-05T10:00',end:'2026-01-05T11:00'}})).response.status,200);
 const hourly=f.components.find(c=>c.code==='TEACH')!;
 const input={expectedVersion:0,assignmentId:f.assignment.id,assignmentVersion:1,sessionVersion:2,startsAt:'2026-01-05T15:00:00Z',endsAt:'2026-01-05T16:02:00Z',reason:'Private recorded-work note'};
 const save=(patch:Record<string,unknown>={})=>f.request('sessions/'+session.id+'/my-time',{...input,...patch},'staff');
 const report=(q='from=2026-01-01&through=2026-01-31&timeZone=America%2FToronto',as='master')=>f.request('reports/payroll/recorded-time?'+q,undefined,as);
 return {...f,session,hourly,input,save,report};
 }catch(error){await f.pg.close();throw error;}}
type Fixture=Awaited<ReturnType<typeof fixture>>;
test('actual230to231 retains populated teaching time history and pricing while adding isolated read-only agreement context',async()=>{
 const f=await fixture(230);try{
  const engagement=await f.create({components:[f.hourly]});assert.equal(engagement.response.status,201);const saved=await f.save();assert.equal(saved.response.status,201);
  const snapshot="SELECT jsonb_build_object('entries',(SELECT jsonb_agg(to_jsonb(e) ORDER BY id) FROM public.session_time_entries e),'history',(SELECT jsonb_agg(to_jsonb(e) ORDER BY entry_id,version) FROM public.session_time_revisions e),'terms',(SELECT jsonb_agg(to_jsonb(e) ORDER BY engagement_id,version) FROM public.work_engagement_revisions e),'roles',(SELECT jsonb_agg(to_jsonb(e) ORDER BY role_id,capability) FROM public.role_permissions e)) snapshot",before=(await f.pg.query(snapshot)).rows,reportBefore=await f.report();assert.equal(reportBefore.response.status,200);
  await f.pg.exec(await readFile(new URL('../db/migrations/231_work_activity_agreement_context.sql',import.meta.url),'utf8'));assert.equal((await f.pg.query('SELECT public.schema_revision() n')).rows[0].n,231);assert.deepEqual((await f.pg.query(snapshot)).rows,before);
  const reportAfter=await f.report();assert.equal(reportAfter.response.status,200);assert.deepEqual(reportAfter.body.data.currencies,reportBefore.body.data.currencies);assert.equal(reportAfter.body.data.currencies[0].actualHourlyTotal.amount,'20.67');
  const path='payroll/engagements/'+engagement.body.data.id+'/recorded-time/'+saved.body.data.id+'/agreement-context?entryVersion=1&termsVersion=1',context=await f.request(path);assert.equal(context.response.status,200,JSON.stringify({body:context.body,errors:f.metrics.queryFailures}));assert.equal(context.body.data.activityRecorded,true);assert.deepEqual(context.body.data.observations,[]);assert.equal(context.body.data.signatureRequiredToRetainRecordedWork,false);assert.equal((await f.request(context.body.data.workTermsPath.replace('/api/v1/',''))).response.status,200);
  for(const role of ['kavosh_file_worker','kavosh_signature_result_worker','kavosh_signature_completion_worker','kavosh_signature_evidence_worker','kavosh_identity','kavosh_delivery']){await f.pg.exec('SET ROLE '+role);try{await assert.rejects(f.pg.query('SELECT public.work_activity_agreement_context($1,$2,1)',[saved.body.data.id,saved.body.data.id]),/permission denied/i);}finally{await f.pg.exec('RESET ROLE');}}
  await f.pg.exec('SET ROLE kavosh_signature_evidence_policy');try{await assert.rejects(f.pg.exec('SELECT reason FROM public.session_time_entries'),/permission denied/i);}finally{await f.pg.exec('RESET ROLE');}
  await f.pg.query("UPDATE public.academies SET status='read_only' WHERE id=$1",[f.a]);assert.equal((await f.request(path)).response.status,200);assert.deepEqual((await f.pg.query(snapshot)).rows,before);
 }finally{await f.pg.close();}
});
function check(name:string,run:(f:Fixture)=>Promise<void>){test(name,async()=>{const f=await fixture();try{await run(f);}finally{await f.pg.close();}});}

check('recorded-time CSV and Excel include all entries,actual and rounded hours,review flags and source pins without approving pay',async f=>{
 await f.pg.query("INSERT INTO public.role_permissions VALUES($1,$2,'report-presets.view','allow')",[f.a,f.staffRole]);assert.equal((await f.create({components:[f.hourly]})).response.status,201);const saved=await f.save();assert.equal(saved.response.status,201);
 const parameters={from:'2026-01-01',through:'2026-01-31',timeZone:'America/Toronto'},path='reports/payroll/recorded-time/export?'+new URLSearchParams(parameters),csv=await f.request(path,undefined,'staff');assert.equal(csv.response.status,200,JSON.stringify(csv.body));const rows=parse(csv.body,{columns:true,bom:true}) as Record<string,string>[];
 assert.equal(rows.filter(r=>r.section==='entry').length,1);assert.equal(JSON.parse(rows.find(r=>r.section==='entry')!.details_json).outsideScheduleMilliseconds,'120000');assert.equal(rows.find(r=>r.section==='currency_total'&&r.field==='actualHourlyTotal')?.amount,'20.67');assert.equal(rows.find(r=>r.section==='currency_total'&&r.field==='configuredHourlyTotal')?.amount,'20.00');assert.equal(rows.filter(r=>r.section==='actual_segment').length,1);assert.equal(rows.filter(r=>r.section==='configured_segment').length,1);assert.match(rows.find(r=>r.section==='actual_segment')!.details_json,new RegExp(saved.body.data.id));assert.equal(JSON.parse(rows.find(r=>r.section==='worker')!.details_json).configuredReductionRequiresReview,true);assert.equal(rows.find(r=>r.field==='sessionEvidenceReviewed')?.value,'false');assert.equal(rows.find(r=>r.field==='payrollApproved')?.value,'false');assert.doesNotMatch(csv.body,/Private recorded-work note/);
 const excel=await f.request('reports/payroll/recorded-time/export.xlsx?'+new URLSearchParams(parameters),undefined,'staff');assert.equal(excel.response.status,200);const expected=parse(csv.body,{bom:true}) as string[][],normalize=(matrix:string[][])=>matrix.map((row,i)=>Array.from({length:expected[i].length},(_,j)=>expected[i][1]==='snapshotAt'&&j===2?'SNAPSHOT':row[j]??''));assert.deepEqual(normalize(spreadsheetRows(excel.body)),normalize(expected));
 const preset=await f.made('reports/presets',{anchor:{kind:'hub',id:f.hub},definition:{name:'Delivered teaching hours',reportId:'payroll.recorded-time',parameters},reason:'Reusable actual work report'}),presetPath='reports/presets/'+preset.id+'/export',file=await f.request(presetPath,undefined,'staff');assert.equal(file.response.status,200,JSON.stringify(file.body));assert.equal((parse(file.body,{columns:true,bom:true}) as Record<string,string>[]).find(r=>r.field==='presetId')?.value,preset.id);assert.equal((await f.request(presetPath+'.xlsx',undefined,'staff')).response.status,200);assert.equal((await f.pg.query('SELECT * FROM public.finance_journals')).rows.length,0);
 await f.pg.query("DELETE FROM public.role_permissions WHERE role_id=$1 AND capability='work-pay.view'",[f.staffRole]);for(const target of [path,presetPath,presetPath+'.xlsx']){const denied=await f.request(target,undefined,'staff');assert.equal(denied.response.status,403);assert.equal(denied.response.headers.get('content-disposition'),null);}
});
check('unpriced recorded hours still export their entries and review reasons when no currency can be priced',async f=>{
 assert.equal((await f.save()).response.status,201);const report=await f.report();assert.equal(report.response.status,200);assert.equal(report.body.data.currencies.length,0);const rows=parse(recordedWorkCsv(report.body.data).body as string,{columns:true,bom:true}) as Record<string,string>[];assert.equal(rows.filter(r=>r.section==='entry').length,1);assert.equal(rows.find(r=>r.section==='review')?.field,'NO_VISIBLE_APPLICABLE_COMPENSATION');assert.equal(rows.filter(r=>r.section==='currency_total').length,0);
});
test('recorded-time export holds the real permission fence while reading source rows',{skip:!process.env.TEST_DATABASE_URL},async()=>{
 const f=await fixture();let release!:()=>void;const gate=new Promise<void>(r=>{release=r;});let reader:ReturnType<typeof f.request>|undefined;const runtime=f.pg.runtime!,connect=runtime.connect.bind(runtime);
 try{assert.equal((await f.create({components:[f.hourly]})).response.status,201);assert.equal((await f.save()).response.status,201);let reached!:()=>void;const atSource=new Promise<void>(r=>{reached=r;});let held=false;
  runtime.connect=async()=>{const c=await connect(),query=c.query.bind(c);c.query=async<Row=Record<string,unknown>>(sql:string,args?:unknown[])=>{if(!held&&sql.startsWith('WITH entries AS MATERIALIZED(')){held=true;reached();await gate;}return query<Row>(sql,args);};return c;};reader=f.request('reports/payroll/recorded-time/export?from=2026-01-01&through=2026-01-31&timeZone=UTC',undefined,'staff');await atSource;assert.equal((await f.pg.query<{ok:boolean}>('SELECT pg_try_advisory_xact_lock(hashtextextended($1,8)) ok',[f.a])).rows[0].ok,false);release();const r=await reader;assert.equal(r.response.status,200,JSON.stringify(r.body));assert.match(r.body,/20\.67/);assert.equal((await f.pg.query<{ok:boolean}>('SELECT pg_try_advisory_xact_lock(hashtextextended($1,8)) ok',[f.a])).rows[0].ok,true);
 }finally{release();await reader;runtime.connect=connect;await f.pg.close();}
});
check('recorded-time exports reject ambiguous selectors,foreign sources and inconsistent or incomplete output',async f=>{
 assert.equal((await f.create({components:[f.hourly]})).response.status,201);assert.equal((await f.save()).response.status,201);const query='from=2026-01-01&through=2026-01-31&timeZone=UTC',path='reports/payroll/recorded-time/export?'+query;
 for(const suffix of ['','/export','/export.xlsx'])for(const key of ['from','through','timeZone','hubId','classId','personId','currencyId']){const r=await f.request('reports/payroll/recorded-time'+suffix+'?'+query+'&'+key+'=x&'+key+'=y',undefined,'staff');assert.equal(r.response.status,400);assert.equal(r.body.error.code,'DUPLICATE_QUERY');assert.equal(r.response.headers.get('content-disposition'),null);}
 for(const suffix of ['&limit=1','&amount=0','&payrollApproved=true'])assert.equal((await f.request(path+suffix,undefined,'staff')).response.status,400);const foreign=await f.request(path,undefined,'foreignMaster',{academy:f.b});assert.equal(foreign.response.status,200);assert.doesNotMatch(foreign.body,new RegExp(f.session.id));
 const data=(await f.report()).body.data;for(const mutate of [(d:any)=>{d.currencies[0].workers=[];},(d:any)=>{d.currencies[0].workers[0].actualSegments=[];},(d:any)=>{d.currencies[0].workers[0].configuredReductionRequiresReview=false;},(d:any)=>{d.currencies[0].knownActualHourlySubtotal.amount='0';},(d:any)=>{d.entries=[];}]){const d=structuredClone(data);mutate(d);assert.throws(()=>recordedWorkCsv(d));}
 const huge=structuredClone(data);huge.snapshotAt='x'.repeat(4_194_305);assert.throws(()=>recordedWorkCsv(huge),(e:unknown)=>e instanceof Error&&'code'in e&&e.code==='RECORDED_WORK_REPORT_REQUIRES_BACKGROUND_JOB');
});

check('recorded hourly report reads actual persisted sources, preserves five-minute reductions and posts no pay or journals',async f=>{
 const engagement=await f.create({components:[f.hourly]});assert.equal(engagement.response.status,201);
 const saved=await f.save();assert.equal(saved.response.status,201,JSON.stringify(saved.body));
 const before=(await f.pg.query('SELECT count(*)::integer AS n FROM public.request_keys')).rows[0].n;
 const result=await f.report();assert.equal(result.response.status,200,JSON.stringify(result.body));const d=result.body.data,c=d.currencies[0];
 assert.equal(c.actualHourlyTotal.amount,'20.67');assert.equal(c.configuredHourlyTotal.amount,'20.00');assert.equal(c.workers[0].actualMilliseconds,'3720000');assert.equal(c.workers[0].configuredMilliseconds,'3600000');assert.equal(c.workers[0].configuredReductionRequiresReview,true);
 assert.equal(c.workers[0].actualSegments[0].source.entryId,saved.body.data.id);assert.equal(c.workers[0].actualSegments[0].source.termsVersion,1);assert.equal(d.entries[0].outsideScheduleMilliseconds,'120000');
 for(const field of ['payrollApproved','earnedEntitlementDetermined','statutoryDeductionsCalculated','paymentExecuted','sessionEvidenceReviewed','completePayroll'])assert.equal(d[field],false);
 assert.doesNotMatch(JSON.stringify(d),/Private recorded-work|Private legal worker/);
 assert.equal((await f.pg.query('SELECT count(*)::integer AS n FROM public.request_keys')).rows[0].n,before);assert.equal((await f.pg.query('SELECT * FROM public.finance_journals')).rows.length,0);
 if(f.pg.runtime){const start=performance.now(),results=await Promise.all([f.report(),f.report(),f.report()]);assert.ok(results.every(r=>r.response.status===200&&r.body.data.currencies[0].actualHourlyTotal.amount==='20.67'));console.log(JSON.stringify({measurement:'brief-recorded-hourly-report',requests:3,elapsedMs:Math.ceil(performance.now()-start)}));}
 assert.equal((await f.save({expectedVersion:1,endsAt:'2026-01-05T16:01:00Z'})).response.status,200);
 const revised=await f.report();assert.equal(revised.body.data.currencies[0].actualHourlyTotal.amount,'20.33');assert.equal(revised.body.data.currencies[0].workers[0].actualSegments[0].source.entryVersion,2);assert.equal((await f.pg.query('SELECT * FROM public.session_time_revisions')).rows.length,2);
 await f.pg.query("UPDATE public.academies SET status='read_only' WHERE id=$1",[f.a]);assert.equal((await f.report()).response.status,200);
});
test('recorded work report index upgrade preserves actual time, private revisions and computed results',async()=>{
 const f=await fixture(63);try{
  assert.equal((await f.create({components:[f.hourly]})).response.status,201);assert.equal((await f.save()).response.status,201);
  const before=(await f.pg.query('SELECT to_jsonb(t) AS value FROM public.session_time_entries t ORDER BY id')).rows,revisions=(await f.pg.query('SELECT to_jsonb(r) AS value FROM public.session_time_revisions r ORDER BY entry_id,version')).rows;
  await f.pg.exec(await readFile(new URL('../db/migrations/064_recorded_work_report.sql',import.meta.url),'utf8'));
  assert.deepEqual((await f.pg.query('SELECT to_jsonb(t) AS value FROM public.session_time_entries t ORDER BY id')).rows,before);assert.deepEqual((await f.pg.query('SELECT to_jsonb(r) AS value FROM public.session_time_revisions r ORDER BY entry_id,version')).rows,revisions);
  assert.equal((await f.pg.query('SELECT public.schema_revision() AS revision')).rows[0].revision,64);
  assert.match(String((await f.pg.query("SELECT indexdef FROM pg_indexes WHERE schemaname='public' AND indexname='session_time_start'")).rows[0].indexdef),/academy_id, starts_at, id/);
  // Exercise the current report against the real full upgrade, not an
  // undefined new helper on an intentionally historical schema64 fixture.
  for(const file of (await readdir(new URL('../db/migrations/',import.meta.url))).filter(n=>n.endsWith('.sql')&&Number.parseInt(n,10)>64).sort())await f.pg.exec(await readFile(new URL('../db/migrations/'+file,import.meta.url),'utf8'));
  const result=await f.report();assert.equal(result.response.status,200,JSON.stringify(result.body));assert.equal(result.body.data.currencies[0].actualHourlyTotal.amount,'20.67');
 }finally{await f.pg.close();}
});
check('recorded hourly overlap across classes pays the highest visible rate once and returns pinned source revisions',async f=>{
 assert.equal((await f.create({components:[f.hourly]})).response.status,201);assert.equal((await f.save({endsAt:'2026-01-05T16:00:00Z'})).response.status,201);
 const c=await f.made('classes',{hubId:f.hub,courseId:f.c.course_id,courseVersion:1,name:'Second delivered class',mode:'in_person',schedule:{oneOff:[{start:'2026-01-05T10:30',end:'2026-01-05T11:30'}]}}),a=await f.made('classes/'+c.id+'/staff',{personId:f.actors.staff.person,role:'teacher',startsOn:'2026-01-01',reason:'Second teaching assignment'}),s=(await f.request('classes/'+c.id+'/sessions')).body.data[0];
 assert.equal((await f.create({code:'SECOND',components:[{...f.hourly,assignment:{id:a.id,version:1},amount:'30'}]})).response.status,201);
 const saved=await f.request('sessions/'+s.id+'/my-time',{...f.input,assignmentId:a.id,sessionVersion:1,startsAt:'2026-01-05T15:30:00Z',endsAt:'2026-01-05T16:30:00Z'},'staff');assert.equal(saved.response.status,201);
 const result=await f.report();assert.equal(result.response.status,200,JSON.stringify(result.body));const ccy=result.body.data.currencies[0];assert.equal(ccy.actualHourlyTotal.amount,'40.00');assert.equal(ccy.workers[0].actualMilliseconds,'5400000');assert.equal(ccy.workers[0].actualSegments.length,2);
 assert.equal((await f.save({expectedVersion:1,endsAt:'2026-01-05T16:10:00Z'})).response.status,200);
 assert.equal((await f.request('sessions/'+s.id+'/my-time',{...f.input,expectedVersion:1,assignmentId:a.id,sessionVersion:1,startsAt:'2026-01-05T15:00:00Z',endsAt:'2026-01-05T16:30:00Z'},'staff')).response.status,200);
 const shadowed=(await f.report()).body.data.currencies[0];assert.equal(shadowed.actualHourlyTotal.amount,'45.00');assert.equal(shadowed.workers[0].actualSegments.length,1);assert.equal(shadowed.workers[0].actualSegments[0].source.entryId,saved.body.data.id);assert.equal(shadowed.sourceAssessments.length,2);assert.ok(shadowed.sourceAssessments.some((s:{entryId:string;durationExceedsScheduleTolerance:boolean})=>s.entryId!==saved.body.data.id&&s.durationExceedsScheduleTolerance),'a lower-rate fully shadowed entry must retain its excess-time flag');
});
check('cancelled or later-rescheduled sessions retain recorded work and effective rate selection does not use the largest revision number',async f=>{
 const e=(await f.create({components:[f.hourly]})).body.data;assert.equal((await f.save()).response.status,201);
 assert.equal((await f.amend(e.id,{effectiveOn:'2026-01-01',components:[{...f.hourly,amount:'30'}]})).response.status,200);
 assert.equal((await f.amend(e.id,{expectedVersion:2,effectiveOn:'2026-01-03',components:[{...f.hourly,amount:'25'}]})).response.status,200);
 assert.equal((await f.amend(e.id,{expectedVersion:3,effectiveOn:'2026-01-02',components:[{...f.hourly,amount:'90'}]})).response.status,200);
 assert.equal((await f.request('sessions/'+f.session.id+'/change',{expectedVersion:2,reason:'Historical calendar cancellation',change:{kind:'cancel'}})).response.status,200);
 const result=await f.report();assert.equal(result.response.status,200,JSON.stringify(result.body));const d=result.body.data;assert.equal(d.entries.length,1);assert.equal(d.entries[0].currentSessionStatus,'cancelled');assert.equal(d.entries[0].scheduleChanged,true);assert.equal(d.currencies[0].actualHourlyTotal.amount,'25.83');assert.equal(d.currencies[0].workers[0].actualSegments[0].source.termsVersion,3);
 assert.equal((await f.pg.query('SELECT * FROM public.session_time_revisions')).rows.length,1);
});
check('missing terms, attendance-based components and incompatible assignment versions are explicit unpriced cases, not zero payroll',async f=>{
 assert.equal((await f.save()).response.status,201);let result=await f.report();assert.equal(result.response.status,200);assert.equal(result.body.data.unpricedComponents[0].reason,'NO_VISIBLE_APPLICABLE_COMPENSATION');assert.equal(result.body.data.currencies.length,0);
 const head={...f.components.find(c=>c.code==='HEAD')!,headcountBasis:'present'},e=(await f.create({components:[f.hourly,head]})).body.data;
 result=await f.report();assert.equal(result.body.data.currencies[0].knownActualHourlySubtotal.amount,'20.67');assert.equal(result.body.data.currencies[0].actualHourlyTotal,null);assert.equal(result.body.data.unpricedComponents[0].reason,'SESSION_HEADCOUNT_EVIDENCE_REQUIRED');
 assert.equal((await f.request('class-staff/'+f.assignment.id+'/update',{expectedVersion:1,role:'ta',reason:'New staffing revision'})).response.status,200);
 assert.equal((await f.amend(e.id,{components:[{...f.hourly,assignment:{id:f.assignment.id,version:2}}]})).response.status,200);
 result=await f.report();assert.equal(result.body.data.currencies[0].actualHourlyTotal,null);assert.equal(result.body.data.unpricedComponents[0].reason,'RECORDED_ASSIGNMENT_VERSION_MISMATCH');
});
check('recorded enrollment-based hourly rates use inclusive captured class-local dates and exact threshold increments, never present or signed counts',async f=>{
 const head={...f.components.find(c=>c.code==='HEAD')!,minimumStudents:1,includedStudents:0};
 assert.equal((await f.create({components:[head]})).response.status,201);assert.equal((await f.save()).response.status,201);
 let result=await f.report();assert.equal(result.response.status,200,JSON.stringify(result.body));assert.equal(result.body.data.currencies[0].actualHourlyTotal.amount,'0.00');
 const period=(expectedVersion:number,patch:Record<string,unknown>)=>f.request('enrollments/'+f.e.id+'/change',{expectedVersion,reason:'Synthetic historical membership correction',...patch});
 assert.equal((await period(1,{joinsOn:'2026-01-06'})).response.status,200);assert.equal((await f.report()).body.data.currencies[0].actualHourlyTotal.amount,'0.00');
 assert.equal((await period(2,{joinsOn:'2026-01-05',leavesOn:'2026-01-05'})).response.status,200);
 result=await f.report();const c=result.body.data.currencies[0],source=c.workers[0].actualSegments[0].source;assert.equal(c.actualHourlyTotal.amount,'28.42');assert.equal(c.configuredHourlyTotal.amount,'27.50');assert.equal(source.enrolledCount,1);assert.equal(source.enrollmentOn,'2026-01-05');assert.equal(source.headcountBasis,'enrolled');assert.equal(source.durationExceedsScheduleTolerance,false);
 assert.equal((await f.request('sessions/'+f.session.id+'/change',{expectedVersion:2,reason:'Calendar correction must not redate previously recorded headcount',change:{kind:'reschedule',start:'2026-01-06T10:00',end:'2026-01-06T11:00'}})).response.status,200);
 result=await f.report();assert.equal(result.body.data.entries[0].scheduleChanged,true);assert.equal(result.body.data.currencies[0].actualHourlyTotal.amount,'28.42');assert.equal(result.body.data.currencies[0].workers[0].actualSegments[0].source.enrollmentOn,'2026-01-05');
 assert.equal((await period(3,{joinsOn:'2026-01-01',leavesOn:'2026-01-04'})).response.status,200);assert.equal((await f.report()).body.data.currencies[0].actualHourlyTotal.amount,'0.00');
 assert.equal((await period(4,{leavesOn:'2026-01-05',enabled:false})).response.status,200);assert.equal((await f.report()).body.data.currencies[0].actualHourlyTotal.amount,'0.00');
 assert.equal((await f.pg.query('SELECT * FROM public.finance_journals')).rows.length,0);
});
check('headcounts remain private without current roster rights while ordinary saved-hour pricing remains available',async f=>{
 const head={...f.components.find(c=>c.code==='HEAD')!,minimumStudents:0,includedStudents:0};
 const e=(await f.create({components:[head]})).body.data;assert.equal((await f.save()).response.status,201);
 let result=await f.report(undefined,'staff');assert.equal(result.response.status,200,JSON.stringify(result.body));assert.equal(result.body.data.currencies[0].actualHourlyTotal,null);assert.equal(result.body.data.unpricedComponents[0].reason,'ROSTER_SOURCE_NOT_AVAILABLE');assert.doesNotMatch(JSON.stringify(result.body),/enrolledCount|enrollmentOn/);
 await f.pg.query("INSERT INTO public.role_permissions VALUES($1,$2,'rosters.view','allow')",[f.a,f.staffRole]);result=await f.report(undefined,'staff');assert.equal(result.body.data.currencies[0].actualHourlyTotal.amount,'25.83');assert.equal(result.body.data.currencies[0].workers[0].actualSegments[0].source.enrolledCount,0);
 const deny=await f.made('roles',{name:'Deny class roster headcount',permissions:[{capability:'rosters.view',effect:'deny'}]}),prior=(await f.request('people/'+f.actors.staff.person+'/access')).body.data;
 assert.equal((await f.request('people/'+f.actors.staff.person+'/access',{expectedVersion:prior.version,assignments:[{roleId:f.staffRole,allHubs:false,hubIds:[f.hub]},{roleId:deny.id,allHubs:false,classIds:[f.c.id]}]})).response.status,200);
 result=await f.report(undefined,'staff');assert.equal(result.body.data.currencies[0].actualHourlyTotal,null);assert.equal(result.body.data.unpricedComponents[0].reason,'ROSTER_SOURCE_NOT_AVAILABLE');assert.doesNotMatch(JSON.stringify(result.body),/enrolledCount|enrollmentOn/);
 assert.equal((await f.amend(e.id,{components:[f.hourly]})).response.status,200);result=await f.report(undefined,'staff');assert.equal(result.body.data.currencies[0].actualHourlyTotal.amount,'20.67');assert.doesNotMatch(JSON.stringify(result.body),/enrolledCount|enrollmentOn/);
});
check('recorded headcounts use the captured class civil day across UTC midnight rather than the actual or report UTC date',async f=>{
 const head={...f.components.find(c=>c.code==='HEAD')!,minimumStudents:1,includedStudents:0};assert.equal((await f.create({components:[head]})).response.status,201);
 assert.equal((await f.request('enrollments/'+f.e.id+'/change',{expectedVersion:1,joinsOn:'2026-01-05',leavesOn:'2026-01-05',reason:'One class-local day only'})).response.status,200);
 assert.equal((await f.request('sessions/'+f.session.id+'/change',{expectedVersion:2,reason:'Synthetic overnight civil time',change:{kind:'reschedule',start:'2026-01-05T23:30',end:'2026-01-06T00:30'}})).response.status,200);
 assert.equal((await f.save({sessionVersion:3,startsAt:'2026-01-06T04:30:00Z',endsAt:'2026-01-06T05:32:00Z'})).response.status,201);
 const result=await f.report('from=2026-01-06&through=2026-01-06&timeZone=UTC');assert.equal(result.response.status,200,JSON.stringify(result.body));assert.equal(result.body.data.currencies[0].actualHourlyTotal.amount,'28.42');assert.equal(result.body.data.currencies[0].workers[0].actualSegments[0].source.enrollmentOn,'2026-01-05');assert.equal(result.body.data.currencies[0].workers[0].actualSegments[0].source.enrolledCount,1);
 assert.equal((await f.report('from=2026-01-05&through=2026-01-05&timeZone=UTC')).body.data.entries.length,0);
});
check('observed attendance prices present and late only, requires both source permissions and refuses stale or unsigned eligibility counts',async f=>{
 const head={...f.components.find(c=>c.code==='HEAD')!,headcountBasis:'present',minimumStudents:1,includedStudents:0},engagement=(await f.create({components:[head]})).body.data;
 assert.equal((await f.save()).response.status,201);
 assert.equal((await f.request('enrollments/'+f.e.id+'/change',{expectedVersion:1,joinsOn:'2026-01-01',reason:'Historical attendance membership'})).response.status,200);
 const sheet=(version:number,enrollmentVersion:number,status:string)=>f.request('sessions/'+f.session.id+'/attendance/change',{expectedVersion:version,sessionVersion:2,entries:[{enrollmentId:f.e.id,enrollmentVersion,status,note:'PRIVATE attendance note'}],reason:'Reviewed observed attendance, not admission clearance'});
 let result=await f.report();assert.equal(result.body.data.currencies[0].actualHourlyTotal,null);
 assert.equal((await sheet(0,2,'present')).response.status,200);
 result=await f.report();assert.equal(result.response.status,200,JSON.stringify(result.body));assert.equal(result.body.data.currencies[0].actualHourlyTotal.amount,'28.42');
 let source=result.body.data.currencies[0].sourceAssessments[0];assert.equal(source.presentCount,1);assert.equal(source.attendanceVersion,1);assert.equal(source.attendanceCountBasis,'observed_present_and_late');assert.equal(source.admissionClearanceVerified,false);assert.doesNotMatch(JSON.stringify(result.body),/PRIVATE|enrolledCount|Adult learner/);
 const attendance=(await f.request('sessions/'+f.session.id+'/attendance')).body.data;assert.equal(attendance.entries[0].effectiveAttendance,'absent');
 for(const status of ['late','absent','excused']){const version=status==='late'?1:status==='absent'?2:3;assert.equal((await sheet(version,2,status)).response.status,200);result=await f.report();assert.equal(result.body.data.currencies[0].actualHourlyTotal.amount,status==='late'?'28.42':'0.00');}
 for(const cap of ['rosters.view','attendance.view'])await f.pg.query("INSERT INTO public.role_permissions VALUES($1,$2,$3,'allow') ON CONFLICT DO NOTHING",[f.a,f.staffRole,cap]);
 assert.equal((await f.report(undefined,'staff')).body.data.currencies[0].actualHourlyTotal.amount,'0.00');
 for(const cap of ['attendance.view','rosters.view']){await f.pg.query('DELETE FROM public.role_permissions WHERE role_id=$1 AND capability=$2',[f.staffRole,cap]);result=await f.report(undefined,'staff');assert.equal(result.body.data.currencies[0].actualHourlyTotal,null);assert.equal(result.body.data.unpricedComponents[0].reason,'SESSION_HEADCOUNT_EVIDENCE_REQUIRED');assert.doesNotMatch(JSON.stringify(result.body),/presentCount|attendanceVersion|enrolledCount/);await f.pg.query("INSERT INTO public.role_permissions VALUES($1,$2,$3,'allow')",[f.a,f.staffRole,cap]);}
 assert.equal((await f.request('enrollments/'+f.e.id+'/change',{expectedVersion:2,leavesOn:'2026-01-31',reason:'Roster revision invalidates old attendance source'})).response.status,200);
 result=await f.report();assert.equal(result.body.data.currencies[0].actualHourlyTotal,null);assert.equal((await sheet(4,3,'present')).response.status,200);assert.equal((await f.report()).body.data.currencies[0].actualHourlyTotal.amount,'28.42');
 assert.equal((await f.request('sessions/'+f.session.id+'/change',{expectedVersion:2,reason:'Changed calendar cannot silently redate captured headcount',change:{kind:'reschedule',start:'2026-01-06T10:00',end:'2026-01-06T11:00'}})).response.status,200);assert.equal((await f.report()).body.data.currencies[0].actualHourlyTotal,null);
 assert.equal((await f.request('sessions/'+f.session.id+'/attendance/change',{expectedVersion:5,sessionVersion:3,entries:[{enrollmentId:f.e.id,enrollmentVersion:3,status:'present',note:''}],reason:'New current calendar sheet is not evidence for the old captured session version'})).response.status,200);assert.equal((await f.report()).body.data.currencies[0].actualHourlyTotal,null);
 assert.equal((await f.amend(engagement.id,{components:[{...head,headcountBasis:'eligible_present'}]})).response.status,200);result=await f.report();assert.equal(result.body.data.currencies[0].actualHourlyTotal,null);assert.equal(result.body.data.unpricedComponents[0].reason,'SIGNED_ADMISSION_HEADCOUNT_EVIDENCE_REQUIRED');
 assert.equal((await f.pg.query('SELECT * FROM public.finance_journals')).rows.length,0);
});
check('per-source overtime tolerance is strict beyond the configured minutes and never hides shorter or shifted recorded hours',async f=>{
 assert.equal((await f.create({components:[f.hourly]})).response.status,201);assert.equal((await f.save({endsAt:'2026-01-05T16:05:00Z'})).response.status,201);
 let result=await f.report();assert.equal(result.body.data.currencies[0].workers[0].actualSegments[0].source.durationExceedsScheduleTolerance,false);
 assert.equal((await f.save({expectedVersion:1,endsAt:'2026-01-05T16:05:00.001Z'})).response.status,200);result=await f.report();assert.equal(result.body.data.currencies[0].workers[0].actualSegments[0].source.durationExceedsScheduleTolerance,true);
 assert.equal((await f.save({expectedVersion:2,startsAt:'2026-01-05T14:45:00Z',endsAt:'2026-01-05T15:30:00Z'})).response.status,200);result=await f.report();assert.equal(result.body.data.currencies[0].workers[0].actualSegments[0].source.durationExceedsScheduleTolerance,false);assert.equal(result.body.data.entries[0].outsideScheduleMilliseconds,'900000');assert.equal(result.body.data.entries[0].recordedMilliseconds,'2700000');
});
check('report intersects pay, time and financial scopes, honors filters and bot ceilings, and never exposes another school',async f=>{
 assert.equal((await f.create({components:[f.hourly]})).response.status,201);assert.equal((await f.save()).response.status,201);
 assert.equal((await f.report(undefined,'staff')).body.data.currencies[0].actualHourlyTotal.amount,'20.67');
 const base='from=2026-01-01&through=2026-01-31&timeZone=UTC';
 assert.equal((await f.report(base+'&hubId='+f.otherHub,'staff')).body.data.entries.length,0);
 assert.equal((await f.report(base+'&personId='+f.actors.manager.person)).body.data.entries.length,0);
 const foreign=await f.request('reports/payroll/recorded-time?'+base,undefined,'foreignMaster',{academy:f.b});assert.equal(foreign.response.status,200);assert.equal(foreign.body.data.entries.length,0);
 const deny=await f.made('roles',{name:'Deny one class time report',permissions:[{capability:'session-time.view',effect:'deny'}]}),prior=(await f.request('people/'+f.actors.staff.person+'/access')).body.data;
 assert.equal((await f.request('people/'+f.actors.staff.person+'/access',{expectedVersion:prior.version,assignments:[{roleId:f.staffRole,allHubs:false,hubIds:[f.hub]},{roleId:deny.id,allHubs:false,classIds:[f.c.id]}]})).response.status,200);
 const hidden=await f.report(base,'staff');assert.equal(hidden.response.status,200,JSON.stringify(hidden.body));assert.equal(hidden.body.data.entries.length,0);
 const botRole=await f.made('roles',{name:'Recorded work bot reader',permissions:['financial-reports.view','work-pay.view','session-time.view'].map(capability=>({capability,effect:'allow'}))}),botPrior=(await f.request('people/'+f.bot+'/access')).body.data;
 assert.equal((await f.request('people/'+f.bot+'/access',{expectedVersion:botPrior.version,assignments:[{roleId:botRole.id,allHubs:true}]})).response.status,200);
 assert.equal((await f.report(base,'bot')).body.data.entries.length,1);
 await f.pg.query('UPDATE auth_private.credentials SET all_hubs=false WHERE id=$1',[f.credential]);await f.pg.query('INSERT INTO auth_private.credential_hubs VALUES($1,$2,$3)',[f.credential,f.a,f.otherHub]);
 const bot=await f.report(base,'bot');assert.equal(bot.response.status,200,JSON.stringify(bot.body));assert.equal(bot.body.data.entries.length,0);
 await f.pg.query("DELETE FROM public.role_permissions WHERE role_id=$1 AND capability='session-time.view'",[f.staffRole]);assert.equal((await f.report(undefined,'staff')).response.status,403);
});
check('cross-currency overlaps require an FX policy even when a currency output filter hides one group',async f=>{
 assert.equal((await f.create({components:[f.hourly]})).response.status,201);assert.equal((await f.save()).response.status,201);
 const usd=await f.made('finance/currencies',{code:'USD',name:'US dollar',unitScale:2,reason:'Synthetic second currency'});assert.equal((await f.create({code:'USD',currency:{id:usd.id,version:1},components:[{...f.hourly,amount:'30'}]})).response.status,201);
 for(const query of [undefined,'from=2026-01-01&through=2026-01-31&timeZone=UTC&currencyId='+f.currency.id]){
  const result=await f.report(query);assert.equal(result.response.status,200,JSON.stringify(result.body));for(const c of result.body.data.currencies){assert.equal(c.actualHourlyTotal,null);assert.equal(c.workers.length,0);assert.ok(c.unpricedComponents.some((i:{reason:string})=>i.reason==='OVERLAPPING_CURRENCIES_REQUIRE_FX_POLICY'));}
 }
});
check('recorded report validates real ranges and zones and never accepts client-supplied rates, times or approvals',async f=>{
 for(const q of ['from=2026-01-01&through=2028-01-01&timeZone=UTC','from=2026-02-30&through=2026-03-01&timeZone=UTC','from=2026-01-01&through=2026-01-31&timeZone=%2B05%3A00','from=2026-01-01&through=2026-01-31&timeZone=UTC&payrollApproved=true'])assert.ok([400,422].includes((await f.report(q)).response.status));
 const result=await f.report('from=9999-12-31&through=9999-12-31&timeZone=America%2FToronto');assert.equal(result.response.status,200,JSON.stringify(result.body));assert.equal(result.body.data.entries.length,0);
});
test('recorded report fails rather than truncating an oversized same-snapshot source set',async()=>{
 const capabilities=['financial-reports.view','work-pay.view','session-time.view'] as const;
 for(const oversized of [{entries:Array(201).fill({}),terms:[]},{entries:[],terms:Array(1001).fill({})}]){
  // Isolated overflow formatter fixture; the native permission-fence case
  // above verifies the real lock/grant protocol instead of mocking it here.
  const ctx:ApiContext={policyLock:'shared',path:'reports/payroll/recorded-time',request:new Request('https://academy.example/api/v1/reports/payroll/recorded-time?from=2026-01-01&through=2026-01-31&timeZone=UTC'),requestId:'source-budget',credential:{token_id:'test',academy_id:'test',person_id:'test',capabilities:[...capabilities],all_hubs:true,hub_ids:[],allowed:true,kind:'human'},grants:capabilities.map(capability=>({capability,effect:'allow',allHubs:true,hubIds:[]})),db:{async query<Row>(){return {rows:[{snapshot_at:'test',...oversized}] as unknown as Row[]};},release(){}}};
  await assert.rejects(recordedWorkReport(ctx),/RECORDED_WORK_REPORT_REQUIRES_BACKGROUND_JOB/);
 }
});
