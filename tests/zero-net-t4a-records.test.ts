import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomUUID} from 'node:crypto';
import {upgradeToCurrent} from './migration-upgrade.ts';
import {readFile} from 'node:fs/promises';
import {t4aRecordFixture,zeroNetSource} from './t4a-record-fixture.ts';
import {parse} from 'csv-parse/sync';
import {runFixtureReportWorker} from './report-worker-fixture.ts';
import {spreadsheetRows} from './spreadsheet-reader.ts';
import {projectT4aServicePayment,projectT4aZeroNetSettlement} from '../src/core/t4a-service-allocation.ts';

async function fixture(options:{hiddenZeroAccount?:boolean;throughSchema?:number}={}){
 const f=await t4aRecordFixture({throughSchema:options.throughSchema});try{
  const deductionAccount=options.hiddenZeroAccount?await f.made('finance/accounts',{code:'ZERO-OTHER-HUB',name:'PRIVATE retained deduction account',kind:'liability',operationalRole:'payable',hubId:f.otherHub,currencyId:f.currency.id,currencyVersion:1,reason:'Synthetic other-hub original source'}):undefined;
  const zero=await zeroNetSource(f,{classification:'contractor',reportingForm:'T4A',deductionAccount}),settlementPath='payroll/net-postings/'+zero.posted.id+'/zero-net-settlement';
  const settlement={settledAt:'2026-02-16T00:30:00Z',timeZone:'America/Toronto',reference:'PRIVATE actual zero-net settlement',review:'PRIVATE separately reviewed actual settlement,not a bank transfer'};
  assert.equal((await f.request(settlementPath,{expectedVersion:0,definition:settlement,reason:'Synthetic actual contractor settlement'})).response.status,200);
  const definition={...f.recordDefinition,allocation:{...f.allocation,income:[{box:'048',amount:'100.00'}],gstHst:'0.00',incomeTaxDeducted:'0.00',review:'PRIVATE independent contractor reporting review of the actual full settlement'},incomeTaxSources:[],nonTaxDeductionSources:[{code:'WITHHOLDING',amount:'100.00',sourceReference:'PRIVATE reviewed deduction is not classified as income tax'}]};
  return {...f,zero,settlementPath,settlement,zeroDefinition:definition,zeroInput:{expectedVersion:0,settlementVersion:1,definition,reason:'PRIVATE explicit zero-net T4A recognition'},zeroPath:'payroll/net-postings/'+zero.posted.id+'/t4a-recognition'};
 }catch(error){await f.pg.close();throw error;}
}
test('reviewed contractor zero-net tax recognition retains the original settlement without inventing cash,journals or employee tax records',async()=>{
 const f=await fixture();try{
  const rows=async()=>{const out=[];for(const table of ['finance_journals','payrun_payments','t4a_payment_records','zero_net_tax_records'])out.push((await f.pg.query('SELECT to_jsonb(r) row FROM public.'+table+' r ORDER BY to_jsonb(r)::text')).rows);return out;};
  const before=await rows(),key=randomUUID(),saved=await f.request(f.zeroPath,f.zeroInput,'master',{key});
  assert.equal(saved.response.status,200,JSON.stringify({body:saved.body,failures:f.metrics.queryFailures}));
  assert.equal(saved.body.data.sourceKind,'zero_net_settlement');assert.equal(saved.body.data.version,1);assert.equal(saved.body.data.state,'recorded');
  assert.equal(saved.body.data.settlementVersion,1);assert.equal(saved.body.data.grossMinor,'10000');assert.equal(saved.body.data.netMinor,'0');assert.equal(saved.body.data.nonTaxDeductedMinor,'10000');
  assert.equal(saved.body.data.recognizedOn,'2026-02-15');assert.equal(saved.body.data.recordedSourceUsable,true);assert.equal(saved.body.data.paymentExecuted,false);assert.equal(saved.body.data.additionalLedgerPosting,false);assert.equal(Object.hasOwn(saved.body.data,'paymentId'),false);
  assert.deepEqual((await f.request(f.zeroPath)).body,{data:saved.body.data});assert.deepEqual((await f.request(f.zeroPath,f.zeroInput,'master',{key})).body,saved.body);assert.deepEqual(await rows(),before);
 }finally{await f.pg.close();}
});
test('required tax audit failure rolls back recognition and approval atomically and permits an exact retry',async()=>{
 const f=await fixture();try{
  const before=(await f.pg.query('SELECT to_jsonb(r) row FROM public.outbox_events r ORDER BY to_jsonb(r)::text')).rows,key=randomUUID();
  await f.pg.exec("CREATE FUNCTION public.fail_zero_t4a_audit_test() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN IF NEW.action='work.zero-net-t4a.change' THEN RAISE EXCEPTION 'synthetic audit failure';END IF;RETURN NEW;END$$;CREATE TRIGGER fail_zero_t4a_audit_test BEFORE INSERT ON public.audit_events FOR EACH ROW EXECUTE FUNCTION public.fail_zero_t4a_audit_test()");
  const failed=await f.request(f.zeroPath,f.zeroInput,'master',{key});assert.equal(failed.response.status,503);assert.doesNotMatch(JSON.stringify(failed.body),/PRIVATE|10000|synthetic audit/);
  for(const table of ['zero_net_t4a_records','zero_net_t4a_revisions'])assert.equal((await f.pg.query('SELECT * FROM public.'+table)).rows.length,0);
  assert.equal((await f.pg.query("SELECT * FROM public.approval_requests WHERE action='work.zero-net-t4a.change'")).rows.length,0);assert.deepEqual((await f.pg.query('SELECT to_jsonb(r) row FROM public.outbox_events r ORDER BY to_jsonb(r)::text')).rows,before);
  await f.pg.exec('DROP TRIGGER fail_zero_t4a_audit_test ON public.audit_events;DROP FUNCTION public.fail_zero_t4a_audit_test()');assert.equal((await f.request(f.zeroPath,f.zeroInput,'master',{key})).response.status,200);
  await assert.rejects(f.pg.exec("UPDATE public.zero_net_t4a_revisions SET definition='null'"),/ZERO_NET_T4A_HISTORY_IMMUTABLE/);await assert.rejects(f.pg.exec('DELETE FROM public.zero_net_t4a_revisions'),/ZERO_NET_T4A_HISTORY_IMMUTABLE/);
 }finally{await f.pg.close();}
});
test('actual419to420 preserves settled and paid accounting sources and original function authority',async()=>{
 const f=await fixture({throughSchema:419});try{
  const tables=['zero_net_settlements','zero_net_settlement_revisions','t4a_payment_records','t4a_payment_revisions','finance_journals','finance_journal_lines','payrun_payments','approval_requests','audit_events','outbox_events'],snapshot=async()=>{const rows=[];for(const t of tables)rows.push((await f.pg.query('SELECT to_jsonb(r) row FROM public.'+t+' r ORDER BY to_jsonb(r)::text')).rows);return rows;};
  const before=await snapshot(),sql="SELECT oid,proowner,proacl,pg_get_functiondef(oid) definition FROM pg_proc WHERE oid IN('public.zero_net_settlement_plan(uuid,integer,jsonb)'::regprocedure,'public.zero_net_tax_privacy()'::regprocedure,'public.zero_net_settlement_header_guard()'::regprocedure) ORDER BY oid",authority=(await f.pg.query(sql)).rows;
  await f.pg.exec(await readFile(new URL('../db/migrations/420_zero_net_contractor_tax_records.sql',import.meta.url),'utf8'));assert.deepEqual(await snapshot(),before);assert.deepEqual((await f.pg.query(sql)).rows,authority);assert.equal((await f.pg.query('SELECT public.schema_revision() revision')).rows[0].revision,420);await upgradeToCurrent(f.pg);assert.deepEqual(await snapshot(),before);assert.deepEqual((await f.pg.query(sql)).rows,authority);
  const coverage=(await f.pg.query<{delete_guard_present:boolean;truncate_guard_present:boolean}>("SELECT * FROM platform_private.academy_preservation_coverage WHERE relation_name IN('zero_net_t4a_records','zero_net_t4a_revisions')")).rows;assert.equal(coverage.length,2);assert.ok(coverage.every(r=>r.delete_guard_present&&r.truncate_guard_present));assert.equal((await f.request(f.zeroPath,f.zeroInput)).response.status,200);
 }finally{await f.pg.close();}
});
test('native concurrent contractor recognition retains one exact review and one audit effect',{skip:!process.env.TEST_DATABASE_URL},async()=>{
 const f=await fixture();try{
  const r=await Promise.all([f.request(f.zeroPath,f.zeroInput),f.request(f.zeroPath,f.zeroInput)]);assert.deepEqual(r.map(v=>v.response.status).sort(),[200,409]);assert.equal((await f.pg.query('SELECT * FROM public.zero_net_t4a_revisions')).rows.length,1);assert.equal((await f.pg.query("SELECT * FROM public.audit_events WHERE action='work.zero-net-t4a.change'")).rows.length,1);
 }finally{await f.pg.close();}
});
const parameters=(f:Awaited<ReturnType<typeof fixture>>)=>({personId:f.actors.staff.person,employerId:f.employer.id,taxYear:'2026',timeZone:'America/Toronto'});
test('contractor zero-net recognition needs an upper human,current settlement and private employer/source authority',async()=>{
 const f=await fixture();try{
  const pending=await f.request(f.zeroPath,f.zeroInput,'staff');assert.equal(pending.response.status,202,JSON.stringify(pending.body));const id=pending.body.approval.id;
  assert.equal((await f.approve(id,'staff')).response.status,403);assert.equal((await f.request(f.zeroPath)).response.status,404);
  const notice=(await f.request('notifications?origin=mandatory',undefined,'manager')).body.data.find((n:any)=>n.source.id===id);assert.ok(notice);assert.doesNotMatch(JSON.stringify(notice),/PRIVATE|sourceReference|incomeTaxSources|nonTaxDeductionSources|123456789/);
  assert.equal((await f.request(f.settlementPath,{expectedVersion:1,definition:{...f.settlement,settledAt:'2026-03-16T00:30:00Z'},reason:'Synthetic corrected actual date'})).response.status,200);
  assert.equal((await f.approve(id,'manager')).body.approval.status,'stale');assert.equal((await f.pg.query('SELECT * FROM public.zero_net_t4a_records')).rows.length,0);
  const next=await f.request(f.zeroPath,{...f.zeroInput,settlementVersion:2},'staff');assert.equal(next.response.status,202);assert.equal((await f.approve(next.body.approval.id,'manager')).response.status,200);
  assert.equal((await f.request(f.zeroPath)).body.data.recognizedOn,'2026-03-15');
  const bot=await f.request(f.zeroPath,{...f.zeroInput,expectedVersion:1,settlementVersion:2},'bot');assert.equal(bot.response.status,202);assert.equal((await f.approve(bot.body.approval.id,'bot')).body.error.code,'HUMAN_REVIEW_REQUIRED');
  await f.pg.query("DELETE FROM public.role_permissions WHERE role_id=ANY($1::uuid[]) AND capability='payroll-employers.view'",[[f.managerRole,f.taxRole.id]]);
  assert.ok([403,404].includes((await f.request(f.zeroPath,undefined,'manager')).response.status));assert.ok([403,404].includes((await f.approve(bot.body.approval.id,'manager')).response.status));
 }finally{await f.pg.close();}
});
test('stale settlement recognition stops contributing and explicit withdrawal/correction preserves all original history',async()=>{
 const f=await fixture();try{
  assert.equal((await f.request(f.zeroPath,f.zeroInput)).response.status,200);
  assert.equal((await f.request(f.settlementPath,{expectedVersion:1,definition:{...f.settlement,settledAt:'2026-03-16T00:30:00Z'},reason:'Synthetic corrected settlement date'})).response.status,200);
  const stale=await f.request(f.zeroPath);assert.equal(stale.body.data.currentSettlementVersion,2);assert.equal(stale.body.data.settlementVersion,1);assert.equal(stale.body.data.recordedSourceUsable,false);
  const path='reports/payroll/t4a-working-paper?'+new URLSearchParams(parameters(f)),report=await f.request(path);assert.equal(report.response.status,200);assert.equal(report.body.data.recognizedZeroNetSettlementCount,0);assert.equal(report.body.data.unresolvedZeroNetSettlementCount,1);assert.equal(report.body.data.totals.reportableIncome.minor,'0');
  assert.equal((await f.request(f.zeroPath,{expectedVersion:1,settlementVersion:2,definition:null,reason:'Synthetic withdrawal before correction'})).response.status,200);
  assert.equal((await f.request(f.zeroPath)).body.data.state,'withdrawn');assert.equal((await f.request(f.zeroPath,{...f.zeroInput,expectedVersion:2,settlementVersion:2})).response.status,200);
  const corrected=await f.request(f.zeroPath);assert.equal(corrected.body.data.version,3);assert.equal(corrected.body.data.recognizedOn,'2026-03-15');assert.equal(corrected.body.data.recordedSourceUsable,true);
  const history=await f.request(f.zeroPath+'/history?limit=1');assert.deepEqual(history.body.data.map((v:any)=>v.version),[1]);assert.equal(history.body.nextVersion,1);assert.deepEqual((await f.request(f.zeroPath+'/history?afterVersion=1')).body.data.map((v:any)=>v.state),['withdrawn','recorded']);
  assert.equal((await f.pg.query('SELECT * FROM public.payrun_payments WHERE posting_id=$1',[f.zero.posted.id])).rows.length,0);
 }finally{await f.pg.close();}
});
test('zero-net allocation requires exact posted codes and pennies and cannot weaken the positive-payment projector',async()=>{
 const f=await fixture();try{
  for(const patch of [
   {nonTaxDeductionSources:[{code:'UNKNOWN',amount:'100.00',sourceReference:'Synthetic wrong code'}]},
   {nonTaxDeductionSources:[{code:'WITHHOLDING',amount:'99.99',sourceReference:'Synthetic missing penny'}]},
   {allocation:{...f.zeroDefinition.allocation,income:[{box:'048',amount:'99.99'}]}},
   {reportingAccount:{id:randomUUID(),version:1}}
  ])assert.equal((await f.request(f.zeroPath,{...f.zeroInput,definition:{...f.zeroDefinition,...patch}})).response.status,409);
  const source={currencyCode:'CAD',unitScale:2,grossMinor:'10000',netMinor:'0',incomeTaxDeductedMinor:'0',nonTaxDeductedMinor:'10000'};
  assert.equal(projectT4aZeroNetSettlement(f.zeroDefinition.allocation,source).net.minor,'0');assert.throws(()=>projectT4aServicePayment(f.zeroDefinition.allocation,source));
  assert.throws(()=>projectT4aZeroNetSettlement(f.zeroDefinition.allocation,{...source,netMinor:'1000',nonTaxDeductedMinor:'9000'}));assert.throws(()=>projectT4aZeroNetSettlement(f.zeroDefinition.allocation,{...source,currencyCode:'USD'}));
  const employee=await zeroNetSource(f,{classification:'employee',reportingForm:'T4'}),settled=await f.request('payroll/net-postings/'+employee.posted.id+'/zero-net-settlement',{expectedVersion:0,definition:f.settlement,reason:'Synthetic employee settlement'});assert.equal(settled.response.status,200);
  const rejected=await f.request('payroll/net-postings/'+employee.posted.id+'/t4a-recognition',f.zeroInput);assert.equal(rejected.body.error.code,'ZERO_NET_T4A_CANADIAN_CONTRACTOR_CONTEXT_REQUIRED');
 }finally{await f.pg.close();}
});
test('consolidated and CSV exports include zero-net allocations separately with exact totals and no private review notes',async()=>{
 const f=await fixture();try{
  assert.equal((await f.request(f.recordPath,f.recordInput)).response.status,200);assert.equal((await f.request(f.zeroPath,f.zeroInput)).response.status,200);
  const query=new URLSearchParams(parameters(f));
  for(const report of ['t4a-working-paper','t4a-consolidated-working-paper']){
   const path='reports/payroll/'+report,r=await f.request(path+'?'+query);assert.equal(r.response.status,200,JSON.stringify({body:r.body,failures:f.metrics.queryFailures}));
   assert.equal(r.body.data.totals.reportableIncome.minor,'55000');assert.equal(r.body.data.totals.net.minor,'50000');assert.equal(r.body.data.totals.paymentCount,1);assert.equal(r.body.data.recognizedZeroNetSettlementCount,1);
   const csv=await f.request(path+'/export?'+query);assert.equal(csv.response.status,200);const text=csv.body,rows=parse(text,{bom:true,columns:true});assert.ok(rows.some((v:any)=>v.section==='zero_net_settlement'&&v.field==='reportableIncome'&&v.minor==='10000'));assert.ok(rows.some((v:any)=>v.section==='annual_total'&&v.field==='reportableIncome'&&v.minor==='55000'));assert.doesNotMatch(text,/PRIVATE|sourceReference|authorityReference|123456789/);
   const zeroRows=rows.filter((v:any)=>v.section==='zero_net_settlement');assert.ok(zeroRows.length);assert.ok(zeroRows.every((v:any)=>v.payment_id===''));
  }
 }finally{await f.pg.close();}
});
test('a hidden original deduction account denies the complete report rather than exposing a partial cash-only total',async()=>{
 const f=await fixture({hiddenZeroAccount:true});try{
  assert.equal((await f.request(f.zeroPath,f.zeroInput)).response.status,200);assert.ok([403,404].includes((await f.request(f.zeroPath,undefined,'manager')).response.status));
  assert.equal((await f.request(f.zeroPath,undefined,'foreignMaster',{academy:f.b})).response.status,404);
  const query=new URLSearchParams(parameters(f));for(const report of ['t4a-working-paper','t4a-consolidated-working-paper']){const r=await f.request('reports/payroll/'+report+'?'+query,undefined,'manager');assert.equal(r.response.status,403);assert.doesNotMatch(JSON.stringify(r.body),/PRIVATE|10000|55000|postingId/);}
 }finally{await f.pg.close();}
});
test('queued contractor exports retain zero-net source authority for CSV and spreadsheet downloads',async()=>{
 const f=await fixture();try{
  for(const cap of ['expenses.view','expense-payments.view','payees.view','payment-methods.view'])await f.pg.query("INSERT INTO public.role_permissions VALUES($1,$2,$3,'allow') ON CONFLICT DO NOTHING",[f.a,f.staffRole,cap]);
  await f.pg.query("INSERT INTO public.role_permissions VALUES($1,$2,'payees.view','allow') ON CONFLICT DO NOTHING",[f.a,f.taxRole.id]);
  assert.equal((await f.request(f.recordPath,f.recordInput)).response.status,200);assert.equal((await f.request(f.zeroPath,f.zeroInput)).response.status,200);
  const queued=await f.request('reports/jobs',{reportId:'payroll.t4a-consolidated-working-paper',parameters:parameters(f)},'staff');assert.equal(queued.response.status,202,JSON.stringify(queued.body));
  const id=queued.body.data.id,worked=await runFixtureReportWorker(f);assert.equal(worked.outcome,'succeeded',JSON.stringify({worked,failures:f.metrics.queryFailures}));
  const csv=await f.request('reports/jobs/'+id+'/download',undefined,'staff');assert.equal(csv.response.status,200);assert.match(csv.body,/zero_net_settlement/);
  const xlsx=await f.request('reports/jobs/'+id+'/download.xlsx',undefined,'staff');assert.equal(xlsx.response.status,200);const rows=spreadsheetRows(xlsx.body);assert.ok(rows.some((r:any[])=>r.includes('zero_net_settlement')));
  await f.pg.query("DELETE FROM public.role_permissions WHERE role_id=$1 AND capability='accounts.view'",[f.staffRole]);
  for(const suffix of ['/download','/download.xlsx'])assert.ok([403,404].includes((await f.request('reports/jobs/'+id+suffix,undefined,'staff')).response.status));
 }finally{await f.pg.close();}
});
test('annual contractor reporting combines reviewed cash and actual zero-net remuneration without adding a payment count or cash amount',async()=>{
 const f=await fixture();try{
  assert.equal((await f.request(f.recordPath,f.recordInput)).response.status,200);assert.equal((await f.request(f.zeroPath,f.zeroInput)).response.status,200);
  const path='reports/payroll/t4a-working-paper?personId='+f.actors.staff.person+'&employerId='+f.employer.id+'&taxYear=2026&timeZone=America%2FToronto',r=await f.request(path);
  assert.equal(r.response.status,200,JSON.stringify({body:r.body,failures:f.metrics.queryFailures}));const d=r.body.data;
  assert.equal(d.paymentCount,1);assert.equal(d.recognizedPaymentCount,1);assert.equal(d.zeroNetSettlementCount,1);assert.equal(d.recognizedZeroNetSettlementCount,1);assert.equal(d.unresolvedZeroNetSettlementCount,0);
  assert.equal(d.totals.gross.minor,'60850');assert.equal(d.totals.net.minor,'50000');assert.equal(d.totals.nonTaxDeductions.minor,'10000');assert.equal(d.totals.reportableIncome.minor,'55000');assert.equal(d.totals.fields.find((v:any)=>v.box==='022').amount.minor,'850');assert.equal(d.completeWithinSelectedRecordedSources,true);
  assert.equal(d.zeroNetSettlementSources[0].postingId,f.zero.posted.id);assert.equal(Object.hasOwn(d.zeroNetSettlementSources[0],'paymentId'),false);assert.equal(d.slips.length,1);assert.equal(d.chartData.length,1);assert.equal(d.slips[0].reportableIncome.minor,'55000');assert.equal(d.chartData[0].reportableIncome.minor,'55000');
  assert.doesNotMatch(JSON.stringify(d),/PRIVATE|sourceReference|eligibilityReview|123456789|authorityReference/);
 }finally{await f.pg.close();}
});
