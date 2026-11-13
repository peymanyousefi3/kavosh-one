import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { consolidatedT4aFixture as fixture } from './t4a-consolidated-fixture.ts';
import { spreadsheetRows } from './spreadsheet-reader.ts';
import { upgradeToCurrent } from './migration-upgrade.ts';
import { setTimeout as delay } from 'node:timers/promises';
import { runFixtureReportWorker } from './report-worker-fixture.ts';

test('consolidated annual report combines real payroll and immutable person supplier payments exactly without private notes',async()=>{
 const f=await fixture();try{
 assert.equal((await f.request(f.recordPath,f.recordInput)).response.status,200);assert.equal((await f.request(f.supplierPath,f.supplierInput)).response.status,200);
 const before=(await f.pg.query('SELECT * FROM public.finance_journals ORDER BY id')).rows,r=await f.request(f.report());assert.equal(r.response.status,200,JSON.stringify({body:r.body,errors:f.metrics.queryFailures}));const d=r.body.data;
 assert.equal(d.linkedSupplierPayeeId,f.payee.id);assert.equal(d.paymentCount,2);assert.equal(d.recognizedPaymentCount,2);assert.equal(d.unresolvedPaymentCount,0);assert.equal(d.totals.reportableIncome.minor,'49425');assert.equal(d.totals.gross.minor,'55850');assert.equal(d.totals.net.minor,'55000');assert.equal(d.totals.excludedGstHst.minor,'6425');assert.equal(d.totals.fields.find((x:{box:string})=>x.box==='022').amount.minor,'850');assert.equal(d.slips.length,1);assert.deepEqual(d.slips[0].reportingAccountVersions,[1]);assert.deepEqual(d.chartData.map((x:{month:string})=>x.month),['2026-02','2026-11']);assert.deepEqual(d.paymentSources.map((x:{sourceKind:string})=>x.sourceKind),['payroll','expense']);assert.equal(d.yearToDateComplete,false);assert.equal(d.isOfficialT4A,false);assert.equal(d.sourceConsistency,'single_statement_payroll_supplier_and_person_link_snapshot');assert.equal(d.sourceSnapshots.payroll,d.sourceSnapshots.supplier);assert.doesNotMatch(JSON.stringify(d),/PRIVATE_|123456789RP/);assert.deepEqual((await f.pg.query('SELECT * FROM public.finance_journals ORDER BY id')).rows,before);
 const csv=await f.request(f.report('/export'));assert.equal(csv.response.status,200);assert.match(csv.body,/49425/);assert.match(csv.body,/coverage/);assert.match(csv.body,/payroll/);assert.match(csv.body,/expense/);assert.doesNotMatch(csv.body,/PRIVATE_|123456789RP/);
 }finally{await f.pg.close();}
});
test('combined report retains one actual snapshot when a supplier review changes before the report returns',{skip:!process.env.TEST_DATABASE_URL},async()=>{
 const f=await fixture();try{
 assert.equal((await f.request(f.recordPath,f.recordInput)).response.status,200);assert.equal((await f.request(f.supplierPath,f.supplierInput)).response.status,200);
 const runtime=f.pg.runtime!,connect=runtime.connect.bind(runtime);let reached!:()=>void,release!:()=>void,reads=0,pending:ReturnType<typeof f.request>|undefined;
 const ready=new Promise<void>(r=>reached=r),gate=new Promise<void>(r=>release=r);
 runtime.connect=async()=>{const c=await connect();return {async query<Row>(sql:string,params?:unknown[]){const result=await c.query<Row>(sql,params);if(sql.startsWith('WITH payroll_source AS MATERIALIZED')){reads++;reached();await gate;}return result;},release(destroy?:boolean){c.release(destroy);}};};
 try{
 pending=f.request(f.report());await Promise.race([ready,delay(3000,undefined,{ref:false}).then(()=>{throw new Error('T4A_COMBINED_SNAPSHOT_NOT_CAPTURED');})]);
 const corrected=await f.request(f.supplierPath,{...f.supplierInput,expectedVersion:1,definition:{...f.supplierInput.definition,allocation:{...f.supplierInput.definition.allocation,income:[{box:'048',amount:'43.25'}],gstHst:'6.75'}}});assert.equal(corrected.response.status,200,JSON.stringify(corrected.body));
 release();const r=await pending;assert.equal(r.response.status,200,JSON.stringify(r.body));assert.equal(reads,1);assert.equal(r.body.data.totals.reportableIncome.minor,'49425');assert.equal(r.body.data.sourceSnapshots.payroll,r.body.data.sourceSnapshots.supplier);assert.equal(r.body.data.paymentSources.find((p:{sourceKind:string})=>p.sourceKind==='expense').recognitionVersion,1);
 runtime.connect=connect;const fresh=await f.request(f.report());assert.equal(fresh.response.status,200);assert.equal(fresh.body.data.totals.reportableIncome.minor,'49325');assert.equal(fresh.body.data.paymentSources.find((p:{sourceKind:string})=>p.sourceKind==='expense').recognitionVersion,2);
 }finally{release();runtime.connect=connect;await Promise.allSettled(pending?[pending]:[]);}
 }finally{await f.pg.close();}
});
test('consolidated report keeps unresolved supplier records visible and fails closed when either source permission is revoked',async()=>{
 const f=await fixture();try{
 assert.equal((await f.request(f.recordPath,f.recordInput)).response.status,200);let r=await f.request(f.report());assert.equal(r.response.status,200);assert.equal(r.body.data.totals.reportableIncome.minor,'45000');assert.equal(r.body.data.unresolvedPaymentCount,1);assert.equal(r.body.data.unresolvedPayments[0].sourceKind,'expense');assert.equal(r.body.data.completeWithinSelectedRecordedPayments,false);
 assert.equal((await f.request(f.report(),undefined,'staff')).response.status,200);
 for(const cap of ['expenses.view','expense-payments.view','accounts.view','payroll-tax.view']){await f.pg.query('DELETE FROM public.role_permissions WHERE role_id IN($1,$2) AND capability=$3',[f.staffRole,f.taxRole.id,cap]);r=await f.request(f.report(),undefined,'staff');assert.ok([403,404].includes(r.response.status),cap+':'+JSON.stringify(r.body));assert.doesNotMatch(JSON.stringify(r.body),/reportableIncome|paymentSources/);await f.pg.query("INSERT INTO public.role_permissions VALUES($1,$2,$3,'allow') ON CONFLICT DO NOTHING",[f.a,f.staffRole,cap]);if(cap==='payroll-tax.view')await f.pg.query("INSERT INTO public.role_permissions VALUES($1,$2,$3,'allow') ON CONFLICT DO NOTHING",[f.a,f.taxRole.id,cap]);assert.equal((await f.request(f.report(),undefined,'staff')).response.status,200);}
 assert.equal((await f.request(f.report(),undefined,'foreignMaster',{academy:f.b})).response.status,404);assert.equal((await f.request(f.report('',{personId:f.actors.peer.person}))).response.status,200,'a different permitted person gets only their own empty sources');assert.equal((await f.request(f.report('',{personId:randomUUID()}))).response.status,404);
 }finally{await f.pg.close();}
});
test('consolidated report is centralized with reviewed reusable presets and actual formula-safe Excel export',async()=>{
 const f=await fixture();try{
 assert.equal((await f.request(f.recordPath,f.recordInput)).response.status,200);assert.equal((await f.request(f.supplierPath,f.supplierInput)).response.status,200);const saved=await f.request('reports/presets',{anchor:{kind:'academy'},definition:{name:'Annual combined services',reportId:'payroll.t4a-consolidated-working-paper',parameters:f.parameters},reason:'Synthetic saved combined report'});assert.equal(saved.response.status,201,JSON.stringify(saved.body));const path='reports/presets/'+saved.body.data.id;assert.equal((await f.request(path+'/run')).body.data.totals.reportableIncome.minor,'49425');const xlsx=await f.request(path+'/export.xlsx');assert.equal(xlsx.response.status,200,JSON.stringify(xlsx.body));const rows=spreadsheetRows(xlsx.body);assert.ok(rows.some(r=>r[0]==='annual_total'&&r[1]==='reportableIncome'&&r[10]==='49425'));assert.doesNotMatch(JSON.stringify(rows),/PRIVATE_|123456789RP/);const entry=(await f.request('reports/catalogue')).body.data.find((x:{id:string})=>x.id==='payroll.t4a-consolidated-working-paper');assert.deepEqual(entry.formats,['json','csv','xlsx']);assert.deepEqual(entry.backgroundJobFormats,['csv']);await f.pg.query("UPDATE public.academies SET status='read_only' WHERE id=$1",[f.a]);assert.equal((await f.request(path+'/run')).response.status,200);
 }finally{await f.pg.close();}
});
test('concurrent person payee creation waits the existing policy gate and appears in the next complete report',{skip:!process.env.TEST_DATABASE_URL},async()=>{
 const f=await fixture();try{
 const runtime=f.pg.runtime!,connect=runtime.connect.bind(runtime);let reached!:()=>void,release!:()=>void,pending:ReturnType<typeof f.request>|undefined,creation:ReturnType<typeof f.request>|undefined;
 const ready=new Promise<void>(r=>reached=r),gate=new Promise<void>(r=>release=r);
 runtime.connect=async()=>{const c=await connect();return {async query<Row>(sql:string,params?:unknown[]){const result=await c.query<Row>(sql,params);if(sql.startsWith("SELECT id FROM public.financial_payees WHERE kind='person' AND person_id=")){reached();await gate;}return result;},release(destroy?:boolean){c.release(destroy);}};};
 try{
 pending=f.request(f.report('',{personId:f.actors.peer.person}));await Promise.race([ready,delay(3000,undefined,{ref:false}).then(()=>{throw new Error('T4A_PERSON_LINK_CHECK_NOT_REACHED');})]);
 creation=f.request('finance/payees',{kind:'person',personId:f.actors.peer.person,code:'CONCURRENT-LINK',name:'Synthetic newly linked person',legalName:'Synthetic test person',reason:'Synthetic person link race'});
 let waiting=false;const deadline=performance.now()+2000;while(performance.now()<deadline){waiting=(await f.pg.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event='advisory'")).rows.length>0;if(waiting)break;await delay(10);}assert.equal(waiting,true,'payee creation must wait for the current report policy snapshot');
 release();const r=await pending;assert.equal(r.response.status,200,JSON.stringify(r.body));assert.equal(r.body.data.linkedSupplierPayeeId,null);assert.equal(r.body.data.paymentCount,0);const linked=await creation;assert.equal(linked.response.status,201,JSON.stringify(linked.body));
 runtime.connect=connect;const fresh=await f.request(f.report('',{personId:f.actors.peer.person}));assert.equal(fresh.response.status,200,JSON.stringify(fresh.body));assert.equal(fresh.body.data.linkedSupplierPayeeId,linked.body.data.id);assert.equal(fresh.body.data.paymentCount,0);assert.equal(fresh.body.data.sourceSnapshots.payroll,fresh.body.data.sourceSnapshots.supplier);
 }finally{release();runtime.connect=connect;await Promise.allSettled([pending,creation].filter(Boolean));}
 }finally{await f.pg.close();}
});
test('consolidated source queries reject duplicate selectors overrides and caller amounts',async()=>{
 const f=await fixture();try{for(const extra of ['&gross=10000','&includeHidden=true','&personId='+f.actors.staff.person,'&limit=1'])assert.equal((await f.request(f.report()+extra)).response.status,400);assert.equal((await f.request(f.report(),{})).response.status,405);assert.equal((await f.request(f.report('',{timeZone:'Not/AZone'}))).response.status,400);
 }finally{await f.pg.close();}
});
test('combined annual JSON CSV Excel and queued export retain original three-decimal foreign settlements and reviewed CAD provenance',async()=>{
 const f=await fixture();try{
 const ref=(v:{id:string})=>({id:v.id,version:1});
 for(const cap of ['currencies.view','exchange-rates.view'])await f.pg.query("INSERT INTO public.role_permissions VALUES($1,$2,$3,'allow') ON CONFLICT DO NOTHING",[f.a,f.taxRole.id,cap]);
 assert.equal((await f.request(f.recordPath,f.recordInput)).response.status,200);assert.equal((await f.request(f.supplierPath,f.supplierInput)).response.status,200);
 const foreign=await f.made('finance/currencies',{code:'BHD',name:'Synthetic foreign settlement',unitScale:3,reason:'Synthetic original precision'});
 const account=(code:string,kind:string,operationalRole:string)=>f.made('finance/accounts',{code,name:code,kind,operationalRole,hubId:f.hub,currencyId:foreign.id,currencyVersion:1,reason:'Synthetic foreign accounting mapping'});
 const cash=await account('COMBINED-FX-CASH','asset','cash'),ap=await account('COMBINED-FX-AP','liability','payable'),expense=await account('COMBINED-FX-COST','expense','expense');
 const bill=await f.made('finance/expense-bills',{payee:ref(f.payee),currency:ref(foreign),payableAccount:ref(ap),documentNumber:'COMBINED-FX',issuedOn:'2026-11-07',dueOn:'2026-12-07',postedOn:'2026-11-07',period:ref(f.period),lines:[{description:'Synthetic foreign service',hubId:f.hub,classId:null,studentId:null,expenseAccount:ref(expense),taxAccount:null,taxCode:{id:f.planInput.taxCodeId,version:1},taxOn:'2026-11-07',amount:'100',pricing:'tax_exclusive',recoverablePercent:'0',taxReview:'Synthetic reviewed fixture only'}],missingEvidenceReason:'Synthetic missing invoice',reason:'Synthetic foreign source'});
 const payment=await f.made('finance/expense-bills/'+bill.id+'/payments',{fundingAccount:ref(cash),payableVersion:1,method:ref(f.method),amount:'50.000',period:ref(f.period),postedOn:'2026-11-08',paidAt:'2026-11-08T12:00:00Z',missingEvidenceReason:'PRIVATE_FX_EVIDENCE',taxTreatment:'settle_expense_bill',reason:'Synthetic foreign payment'});
 const quote=await f.made('finance/exchange-rates',{base:ref(foreign),quote:ref(f.currency),on:'2026-11-08',rate:'1.35',source:'Synthetic manually reviewed rate,not actual market data',reference:'SYNTHETIC-COMBINED-FX',reason:'Synthetic reporting reference'});
 const definition={...f.supplierInput.definition,allocation:{...f.supplierInput.definition.allocation,income:[{box:'048',amount:'59.74'}],gstHst:'7.76'},fx:{rateId:quote.id,maximumAgeDays:0,gstHstMinor:'5750',pstMinor:'0',review:'PRIVATE_FX_DATE_REVIEW'}};
 const recognized=await f.request('finance/expense-payments/'+payment.id+'/tax-recognition',{expectedVersion:0,definition,reason:'PRIVATE_FX_RECOGNITION'});assert.equal(recognized.response.status,200,JSON.stringify(recognized.body));
 const before=(await f.pg.query('SELECT * FROM public.finance_journal_lines ORDER BY journal_id,line_number')).rows;
 const report=await f.request(f.report(),undefined,'staff');assert.equal(report.response.status,200,JSON.stringify(report.body));const d=report.body.data;assert.equal(d.totals.reportableIncome.minor,'55399');assert.equal(d.totals.gross.minor,'62600');assert.equal(d.paymentCount,3);assert.equal(d.supplierForeignCurrencyRecognitionIncluded,true);assert.equal(d.foreignPayrollRecognitionIncluded,false);assert.equal(d.referenceRatesIndependentlyVerified,false);assert.equal(d.taxConversionLegallyVerified,false);assert.equal(d.yearToDateComplete,false);
 const source=d.paymentSources.find((p:{paymentId:string})=>p.paymentId===payment.id);assert.equal(source.originalSettlement.currency,'BHD');assert.equal(source.originalSettlement.unitScale,3);assert.equal(source.originalSettlement.minor,'50000');assert.equal(source.originalSettlement.amount,'50.000');assert.equal(source.fx.rateId,quote.id);
 const csv=await f.request(f.report('/export'),undefined,'staff');assert.equal(csv.response.status,200);assert.match(csv.body,/payment_original_source/);assert.match(csv.body,/payment_fx_reference/);assert.ok(csv.body.includes(quote.id));assert.doesNotMatch(csv.body,/PRIVATE_FX|PRIVATE supplier|PRIVATE_T4A/);
 const xlsx=await f.request(f.report('/export.xlsx'),undefined,'staff');assert.equal(xlsx.response.status,200,JSON.stringify(xlsx.body));const rows=spreadsheetRows(xlsx.body);assert.ok(rows.some(r=>r[0]==='payment_original_source'&&r[2]==='BHD'&&r[3]==='expense'&&r[4]===payment.id&&r[10]==='50000'&&r[11]==='50.000'));assert.ok(rows.some(r=>r[0]==='payment_fx_reference'&&r[2].includes(quote.id)));assert.doesNotMatch(JSON.stringify(rows),/PRIVATE_FX|PRIVATE_T4A/);
 const queued=await f.request('reports/jobs',{reportId:'payroll.t4a-consolidated-working-paper',parameters:f.parameters},'staff');assert.equal(queued.response.status,202,JSON.stringify(queued.body));assert.equal((await runFixtureReportWorker(f)).outcome,'succeeded');const path='reports/jobs/'+queued.body.data.id+'/download';const archived=await f.request(path,undefined,'staff');assert.equal(archived.response.status,200);assert.match(archived.body,/payment_original_source/);assert.match(archived.body,/50\.000/);assert.ok(archived.body.includes(quote.id));
 assert.deepEqual((await f.pg.query('SELECT * FROM public.finance_journal_lines ORDER BY journal_id,line_number')).rows,before);
 await f.pg.query("DELETE FROM public.role_permissions WHERE role_id=$1 AND capability='exchange-rates.view'",[f.taxRole.id]);
 for(const path of [f.report(),f.report('/export'),f.report('/export.xlsx'),'reports/jobs/'+queued.body.data.id+'/download']){const denied=await f.request(path,undefined,'staff');assert.ok([403,404].includes(denied.response.status),JSON.stringify(denied.body));assert.doesNotMatch(JSON.stringify(denied.body),/55399|50000|paymentSources|payment_fx_reference/);}
 }finally{await f.pg.close();}
});
test('actual380to381 preserves original financial and privacy records and existing preset validator authority',async()=>{
 const f=await fixture({throughSchema:380});try{assert.equal((await f.request('me/privacy-requests',{category:'complaint',details:'Synthetic preserved privacy case'},'staff')).response.status,201);const privacy=(await f.pg.query('SELECT * FROM public.privacy_requests ORDER BY id')).rows;const sql="SELECT oid,proowner,proacl,prosecdef,proconfig FROM pg_proc WHERE oid='public.report_preset_static_definition_valid(jsonb)'::regprocedure",before=(await f.pg.query(sql)).rows,records=(await f.pg.query('SELECT * FROM public.expense_payments ORDER BY id')).rows;await upgradeToCurrent(f.pg);assert.deepEqual((await f.pg.query(sql)).rows,before);assert.deepEqual((await f.pg.query('SELECT * FROM public.expense_payments ORDER BY id')).rows,records);assert.deepEqual((await f.pg.query('SELECT * FROM public.privacy_requests ORDER BY id')).rows,privacy);assert.equal((await f.request(f.report())).response.status,200);
 }finally{await f.pg.close();}
});
