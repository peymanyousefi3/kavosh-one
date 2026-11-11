import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { consolidatedT4aFixture as fixture } from './t4a-consolidated-fixture.ts';
import { spreadsheetRows } from './spreadsheet-reader.ts';
import { upgradeToCurrent } from './migration-upgrade.ts';

test('consolidated annual report combines real payroll and immutable person supplier payments exactly without private notes',async()=>{
 const f=await fixture();try{
 assert.equal((await f.request(f.recordPath,f.recordInput)).response.status,200);assert.equal((await f.request(f.supplierPath,f.supplierInput)).response.status,200);
 const before=(await f.pg.query('SELECT * FROM public.finance_journals ORDER BY id')).rows,r=await f.request(f.report());assert.equal(r.response.status,200,JSON.stringify({body:r.body,errors:f.metrics.queryFailures}));const d=r.body.data;
 assert.equal(d.linkedSupplierPayeeId,f.payee.id);assert.equal(d.paymentCount,2);assert.equal(d.recognizedPaymentCount,2);assert.equal(d.unresolvedPaymentCount,0);assert.equal(d.totals.reportableIncome.minor,'49425');assert.equal(d.totals.gross.minor,'55850');assert.equal(d.totals.net.minor,'55000');assert.equal(d.totals.excludedGstHst.minor,'6425');assert.equal(d.totals.fields.find((x:{box:string})=>x.box==='022').amount.minor,'850');assert.equal(d.slips.length,1);assert.deepEqual(d.slips[0].reportingAccountVersions,[1]);assert.deepEqual(d.chartData.map((x:{month:string})=>x.month),['2026-02','2026-11']);assert.deepEqual(d.paymentSources.map((x:{sourceKind:string})=>x.sourceKind),['payroll','expense']);assert.equal(d.yearToDateComplete,false);assert.equal(d.isOfficialT4A,false);assert.match(d.sourceConsistency,/not_a_single_atomic/);assert.doesNotMatch(JSON.stringify(d),/PRIVATE_|123456789RP/);assert.deepEqual((await f.pg.query('SELECT * FROM public.finance_journals ORDER BY id')).rows,before);
 const csv=await f.request(f.report('/export'));assert.equal(csv.response.status,200);assert.match(csv.body,/49425/);assert.match(csv.body,/coverage/);assert.match(csv.body,/payroll/);assert.match(csv.body,/expense/);assert.doesNotMatch(csv.body,/PRIVATE_|123456789RP/);
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
test('consolidated source queries reject duplicate selectors overrides and caller amounts',async()=>{
 const f=await fixture();try{for(const extra of ['&gross=10000','&includeHidden=true','&personId='+f.actors.staff.person,'&limit=1'])assert.equal((await f.request(f.report()+extra)).response.status,400);assert.equal((await f.request(f.report(),{})).response.status,405);assert.equal((await f.request(f.report('',{timeZone:'Not/AZone'}))).response.status,400);
 }finally{await f.pg.close();}
});
test('actual380to381 preserves original financial and privacy records and existing preset validator authority',async()=>{
 const f=await fixture({throughSchema:380});try{assert.equal((await f.request('me/privacy-requests',{category:'complaint',details:'Synthetic preserved privacy case'},'staff')).response.status,201);const privacy=(await f.pg.query('SELECT * FROM public.privacy_requests ORDER BY id')).rows;const sql="SELECT oid,proowner,proacl,prosecdef,proconfig FROM pg_proc WHERE oid='public.report_preset_static_definition_valid(jsonb)'::regprocedure",before=(await f.pg.query(sql)).rows,records=(await f.pg.query('SELECT * FROM public.expense_payments ORDER BY id')).rows;await upgradeToCurrent(f.pg);assert.deepEqual((await f.pg.query(sql)).rows,before);assert.deepEqual((await f.pg.query('SELECT * FROM public.expense_payments ORDER BY id')).rows,records);assert.deepEqual((await f.pg.query('SELECT * FROM public.privacy_requests ORDER BY id')).rows,privacy);assert.equal((await f.request(f.report())).response.status,200);
 }finally{await f.pg.close();}
});
