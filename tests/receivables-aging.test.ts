import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { receiptFixture } from './receipt-fixture.ts';
import { assertReceivableAgingBounds,receivableAgingLimits } from '../src/modules/receivables-aging.ts';
import { parse } from 'csv-parse/sync';
import { agingReportCsv } from '../src/modules/aging-report-export.ts';

const csv=(body:string)=>parse(body,{columns:true,bom:true}) as Record<string,string>[];
const meta=(rows:Record<string,string>[])=>Object.fromEntries(rows.filter(r=>r.section==='metadata').map(r=>[r.field,r.value]));
const exported=(f:Fixture,on='2026-12-02',suffix='',as='master')=>f.request('reports/finance/receivables-aging/export?on='+on+suffix,undefined,as);

type Fixture=Awaited<ReturnType<typeof receiptFixture>>;
function check(name:string,run:(f:Fixture)=>Promise<void>){test(name,async()=>{const f=await receiptFixture();try{await run(f);}finally{await f.pg.close();}});}
async function report(f:Fixture,on='2026-12-02',suffix='',as='master'){
 const r=await f.request('reports/finance/receivables-aging?on='+on+suffix,undefined,as);assert.equal(r.response.status,200,JSON.stringify({body:r.body,failures:f.metrics.queryFailures}));return r.body.data;
}
function amounts(c:any){return c.bands.map((b:any)=>b.amount);}
check('receivable CSV retains complete original totals all aging bands and unknown allocation-aware overdue without a posting',async f=>{
 const p=await f.pay();assert.equal(p.response.status,201);const before=(await f.pg.query('SELECT count(*)::integer n FROM public.finance_journals')).rows[0].n,r=await exported(f);assert.equal(r.response.status,200,JSON.stringify(r.body));assert.match(r.response.headers.get('content-type')??'',/^text\/csv/);assert.equal(r.response.headers.get('cache-control'),'no-store');const rows=csv(r.body),m=meta(rows),money=(field:string)=>rows.find(r=>r.section==='currency_total'&&r.field===field);assert.equal(m.recordCount,'1');assert.equal(m.paginationSnapshot,'one_source_snapshot_for_complete_export');assert.equal(JSON.parse(m.filters).limit,undefined);assert.equal(money('positiveReceivable')?.amount,'63.00');assert.equal(money('needsAllocation')?.amount,'63.00');assert.equal(money('overdue')?.amount_known,'false');assert.equal(money('overdue')?.amount,'');assert.equal(rows.filter(r=>r.section==='invoice_band').length,6);assert.equal(rows.filter(r=>r.section==='currency_band').length,6);assert.equal(rows.find(r=>r.section==='hub_chart'&&r.field==='positiveReceivable')?.amount,'63.00');assert.doesNotMatch(r.body,/Private receipt review|missing paper receipt|token_hash|collectorId|credential/);assert.equal((await f.pg.query('SELECT count(*)::integer n FROM public.finance_journals')).rows[0].n,before);
 assert.equal((await f.request('finance/receipts/'+p.body.data.id+'/allocations',{expectedVersion:0,mode:'oldest_due',reason:'Resolve report aging'})).response.status,200);const allocated=await exported(f);assert.equal(allocated.response.status,200);assert.equal(csv(allocated.body).find(r=>r.section==='currency_total'&&r.field==='overdue')?.amount,'0.00');
});
check('receivable CSV intersects current record permissions before counts and rechecks every required feature',async f=>{
 const caps=['receivables-reports.view','invoices.view','receipts.view','allocations.view'],role=await f.made('roles',{name:'Export own learner',permissions:caps.map(capability=>({capability,effect:'allow'}))}),path='people/'+f.actors.staff.person+'/access';assert.equal((await f.request(path,{expectedVersion:(await f.request(path)).body.data.version,assignments:[{roleId:role.id,allHubs:false,personIds:[f.student.id]}]})).response.status,200);assert.equal((await exported(f,undefined,'','staff')).response.status,200);assert.equal(meta(csv((await exported(f,undefined,'&studentIds='+f.actors.peer.person,'staff')).body)).recordCount,'0');const foreign=await f.request('reports/finance/receivables-aging/export?on=2026-12-02&invoiceIds='+f.invoice.id,undefined,'foreignMaster',{academy:f.b});assert.equal(foreign.response.status,200);assert.equal(meta(csv(foreign.body)).recordCount,'0');assert.deepEqual(JSON.parse(meta(csv(foreign.body)).filters).invoiceIds,[f.invoice.id]);assert.ok(csv(foreign.body).every(r=>r.record_id!==f.invoice.id));
 for(const cap of caps){await f.pg.query('DELETE FROM public.role_permissions WHERE role_id=$1 AND capability=$2',[role.id,cap]);const denied=await exported(f,undefined,'','staff');assert.equal(denied.response.status,403);assert.equal(denied.response.headers.get('content-disposition'),null);await f.pg.query("INSERT INTO public.role_permissions VALUES($1,$2,$3,'allow')",[f.a,role.id,cap]);assert.equal((await exported(f,undefined,'','staff')).response.status,200);}
});
check('receivable CSV refuses page parameters incomplete money bands charts and private injected filters',async f=>{
 for(const suffix of ['&limit=1','&after='+randomUUID(),'&snapshot=x','&on=2026-12-03','&cutoffs=30,30','&send=true']){const r=await exported(f,undefined,suffix);assert.equal(r.response.status,400,suffix);assert.equal(r.response.headers.get('content-disposition'),null);}assert.equal((await f.request('reports/finance/receivables-aging/export?on=2026-12-02',{})).response.status,405);
 const d=await report(f);assert.equal(agingReportCsv(d).status,200);for(const change of [(a:typeof d)=>a.entries.pop(),(a:typeof d)=>a.currencies[0].bands.pop(),(a:typeof d)=>a.chartData.hubs.pop(),(a:typeof d)=>a.currencies[0].positiveReceivable.minor='1',(a:typeof d)=>a.filters.private='secret',(a:typeof d)=>a.entries[0].bands[0].amount='0.00']){const bad=structuredClone(d);change(bad);assert.throws(()=>agingReportCsv(bad));}assert.throws(()=>agingReportCsv({...d,invoiceCount:2001}),/REPORT_REQUIRES_BACKGROUND_JOB/);assert.doesNotMatch(agingReportCsv({...d,authorizationContext:{private:'PRIVATE-PROOF'},notes:'PRIVATE-NOTE'}).body as string,/PRIVATE-PROOF|PRIVATE-NOTE|authorizationContext/);
});
check('receivable saved CSV ignores stored page size and preserves current caller and relative date provenance',async f=>{
 const preset=await f.made('reports/presets',{anchor:{kind:'hub',id:f.hub},definition:{name:'Tuition aging',reportId:'finance.receivables-aging',parameters:{on:'2026-12-02',limit:'1'}},reason:'Reusable complete aging export'}),r=await f.request('reports/presets/'+preset.id+'/export');assert.equal(r.response.status,200,JSON.stringify(r.body));assert.equal(meta(csv(r.body)).presetId,preset.id);assert.equal((await f.request('reports/presets/'+preset.id+'/export?limit=1')).response.status,400);const relative=await f.made('reports/presets',{anchor:{kind:'hub',id:f.hub},definition:{name:'Today AR',reportId:'finance.receivables-aging',parameters:{},dateWindow:{kind:'today',timeZone:'America/Toronto'}},reason:'Relative original report dates'}),dynamic=await f.request('reports/presets/'+relative.id+'/export?on=2026-12-02');assert.equal(dynamic.response.status,200,JSON.stringify(dynamic.body));assert.equal(JSON.parse(meta(csv(dynamic.body)).dateWindow).window.kind,'today');
});
check('receivables aging respects invoice dates, due-today and exact overdue bucket boundaries without writes',async f=>{
 const before=(await f.pg.query('SELECT count(*)::int n FROM public.finance_journals')).rows[0].n;
 assert.equal((await report(f,'2026-11-04')).invoiceCount,0);
 const due=await report(f,'2026-12-01');assert.equal(due.invoiceCount,1);assert.deepEqual(amounts(due.currencies[0]),['113.00','0.00','0.00','0.00','0.00','0.00']);
 const next=await report(f);assert.deepEqual(amounts(next.currencies[0]),['63.00','50.00','0.00','0.00','0.00','0.00']);assert.equal(next.currencies[0].overdue.amount,'50.00');
 assert.deepEqual(amounts((await report(f,'2026-12-31')).currencies[0]),['63.00','50.00','0.00','0.00','0.00','0.00']);
 assert.deepEqual(amounts((await report(f,'2027-04-01')).currencies[0]),['0.00','0.00','0.00','63.00','50.00','0.00']);
 assert.deepEqual(amounts((await report(f,'2026-12-03','&cutoffs=1,2')).currencies[0]),['63.00','0.00','50.00','0.00','0.00']);
 assert.equal(next.permissionsAppliedBeforeAggregation,true);assert.equal(next.currencyConversion,'none');assert.equal(next.taxBasis,'recorded_gross_no_recalculation');assert.equal(next.systemKnowledgeAsOf,false);
 assert.equal((await f.pg.query('SELECT count(*)::int n FROM public.finance_journals')).rows[0].n,before);
});
check('unallocated payments retain exact balances without guessing installment aging, and approved allocation resolves it',async f=>{
 const p=await f.pay();assert.equal(p.response.status,201,JSON.stringify(p.body));
 const early=await report(f,'2026-11-05');assert.equal(early.currencies[0].received.amount,'0.00');
 const r=await report(f);assert.equal(r.currencies[0].positiveReceivable.amount,'63.00');assert.equal(r.currencies[0].received.amount,'50.00');assert.equal(r.currencies[0].overdue,null);assert.equal(r.currencies[0].knownOverdue.amount,'0.00');assert.deepEqual(amounts(r.currencies[0]),['0.00','0.00','0.00','0.00','0.00','63.00']);
 const a=await f.request('finance/receipts/'+p.body.data.id+'/allocations',{expectedVersion:0,mode:'oldest_due',reason:'Synthetic approved mapping'});assert.equal(a.response.status,200,JSON.stringify(a.body));
 const allocated=await report(f);assert.equal(allocated.currencies[0].overdue.amount,'0.00');assert.equal(allocated.currencies[0].unallocatedReceived.amount,'0.00');assert.deepEqual(amounts(allocated.currencies[0]),['63.00','0.00','0.00','0.00','0.00','0.00']);
});
check('payment reversal changes balances only on its effective journal date, not the current reversal flag',async f=>{
 const p=await f.pay({allocation:'oldest_due'});assert.equal(p.response.status,201,JSON.stringify(p.body));assert.equal((await f.reverse(p.body.data.id,{postedOn:'2026-12-03'})).response.status,201);
 assert.equal((await report(f)).currencies[0].positiveReceivable.amount,'63.00');
 const reversed=await report(f,'2026-12-03');assert.equal(reversed.currencies[0].positiveReceivable.amount,'113.00');assert.equal(reversed.currencies[0].received.amount,'0.00');assert.equal(reversed.currencies[0].overdue.amount,'50.00');
});
check('dated full credits retain earlier receivables and show paid customer credit without inventing refunds',async f=>{
 const p=await f.pay({allocation:'oldest_due'});assert.equal(p.response.status,201);
 const c=await f.credit(f.invoice.id,{issuedAt:'2026-12-03T12:00:00Z'});assert.equal(c.response.status,201,JSON.stringify(c.body));
 assert.equal((await report(f)).currencies[0].positiveReceivable.amount,'63.00');
 const r=await report(f,'2026-12-03');assert.equal(r.currencies[0].positiveReceivable.amount,'0.00');assert.equal(r.currencies[0].customerCredit.amount,'50.00');assert.equal(r.currencies[0].netBalance.amount,'-50.00');assert.equal(r.entries[0].status,'customer_credit');assert.equal(r.moneyMovementPerformed,false);
 const file=await exported(f,'2026-12-03');assert.equal(file.response.status,200,JSON.stringify(file.body));assert.equal(csv(file.body).find(r=>r.section==='currency_total'&&r.field==='netBalance')?.amount,'-50.00');
});
check('backdated replacement cash exposes historical installment conflicts instead of silently clamping overdue balances',async f=>{
 const a=await f.pay({allocation:'oldest_due'});assert.equal(a.response.status,201);assert.equal((await f.reverse(a.body.data.id,{postedOn:'2026-11-20'})).response.status,201);
 const b=await f.pay({receivedAt:'2026-11-10T12:00:00Z',allocation:'oldest_due'});assert.equal(b.response.status,201,JSON.stringify(b.body));
 const historical=await report(f,'2026-11-15');assert.equal(historical.currencies[0].positiveReceivable.amount,'13.00');assert.equal(historical.entries[0].historicalAllocationConflict,true);assert.equal(historical.currencies[0].needsAllocation.amount,'13.00');assert.equal(historical.currencies[0].overdue,null);
 const file=await exported(f,'2026-11-15');assert.equal(file.response.status,200,JSON.stringify(file.body));assert.equal(csv(file.body).find(r=>r.section==='currency_total'&&r.field==='overdue')?.amount_known,'false');assert.equal(csv(file.body).find(r=>r.section==='invoice')?.historical_allocation_conflict,'true');
 const after=await report(f,'2026-11-20');assert.equal(after.currencies[0].positiveReceivable.amount,'63.00');assert.equal(after.entries[0].historicalAllocationConflict,false);assert.equal(after.entries[0].allocationReviewRequired,false);
});
check('report requires all four source permissions and intersects student grants before totals and filters',async f=>{
 const caps=['receivables-reports.view','invoices.view','receipts.view','allocations.view'];
 const role=await f.made('roles',{name:'Selected learner aging',permissions:caps.map(capability=>({capability,effect:'allow'}))});
 const path='people/'+f.actors.staff.person+'/access',old=await f.request(path);assert.equal((await f.request(path,{expectedVersion:old.body.data.version,assignments:[{roleId:role.id,allHubs:false,personIds:[f.student.id]}]})).response.status,200);
 assert.equal((await report(f,'2026-12-02','','staff')).invoiceCount,1);
 assert.equal((await report(f,'2026-12-02','&studentIds='+f.actors.peer.person,'staff')).invoiceCount,0);
 assert.equal((await report(f,'2026-12-02','&invoiceIds='+randomUUID(),'staff')).invoiceCount,0);
 const foreign=await f.request('reports/finance/receivables-aging?on=2026-12-02&invoiceIds='+f.invoice.id,undefined,'foreignMaster',{academy:f.b});assert.equal(foreign.response.status,200);assert.equal(foreign.body.data.invoiceCount,0);
 await f.pg.query("DELETE FROM public.role_permissions WHERE academy_id=$1 AND role_id=$2 AND capability='allocations.view'",[f.a,role.id]);
 const revoked=await f.request('reports/finance/receivables-aging?on=2026-12-02',undefined,'staff');assert.equal(revoked.response.status,403);
});
check('strict query validation rejects duplicate keys, invalid dates, unordered boundaries and unsupported fields',async f=>{
 for(const suffix of ['on=2026-12-02&on=2026-12-03','on=2026-02-30','on=2026-12-02&cutoffs=30,30','on=2026-12-02&cutoffs=0','on=2026-12-02&cutoffs=36501','on=2026-12-02&limit=0','on=2026-12-02&studentIds=no','on=2026-12-02&unexpected=true']){
  const r=await f.request('reports/finance/receivables-aging?'+suffix);assert.equal(r.response.status,400,suffix+JSON.stringify(r.body));
 }
});
check('independent permission scopes, explicit original-hub denials and bot credential ceilings cannot widen report aggregates',async f=>{
 const caps=['receivables-reports.view','invoices.view','receipts.view','allocations.view'],path='people/'+f.actors.staff.person+'/access';
 const reportRole=await f.made('roles',{name:'Report only this class',permissions:[{capability:caps[0],effect:'allow'}]}),sources=await f.made('roles',{name:'Sources only another learner',permissions:caps.slice(1).map(capability=>({capability,effect:'allow'}))});
 async function assign(assignments:unknown[]){const current=await f.request(path);const r=await f.request(path,{expectedVersion:current.body.data.version,assignments});assert.equal(r.response.status,200,JSON.stringify(r.body));}
 await assign([{roleId:reportRole.id,allHubs:false,classIds:[f.c.id]},{roleId:sources.id,allHubs:false,personIds:[f.actors.peer.person]}]);assert.equal((await report(f,'2026-12-02','','staff')).invoiceCount,0);
 await assign([{roleId:reportRole.id,allHubs:false,classIds:[f.c.id]},{roleId:sources.id,allHubs:false,personIds:[f.student.id]}]);assert.equal((await report(f,'2026-12-02','','staff')).invoiceCount,1);
 const deny=await f.made('roles',{name:'Deny original hub',permissions:[{capability:'invoices.view',effect:'deny'}]});await assign([{roleId:reportRole.id,allHubs:false,classIds:[f.c.id]},{roleId:sources.id,allHubs:true},{roleId:deny.id,allHubs:false,hubIds:[f.hub]}]);assert.equal((await report(f,'2026-12-02','','staff')).invoiceCount,0);
 const botRole=await f.made('roles',{name:'Bot aging observer',permissions:caps.map(capability=>({capability,effect:'allow'}))}),botPath='people/'+f.bot+'/access',old=await f.request(botPath);assert.equal((await f.request(botPath,{expectedVersion:old.body.data.version,assignments:[{roleId:botRole.id,allHubs:true}]})).response.status,200);
 assert.equal((await report(f,'2026-12-02','','bot')).invoiceCount,1);
 await f.pg.query('UPDATE auth_private.credentials SET all_hubs=false WHERE person_id=$1',[f.bot]);await f.pg.query('INSERT INTO auth_private.credential_hubs(academy_id,credential_id,hub_id) SELECT academy_id,id,$1 FROM auth_private.credentials WHERE person_id=$2',[f.otherHub,f.bot]);assert.equal((await report(f,'2026-12-02','','bot')).invoiceCount,0);
});
check('changing an approved allocation restates aging explicitly but never changes the recorded cash balance',async f=>{
 const p=await f.pay({allocation:'oldest_due'});assert.equal(p.response.status,201);
 const before=await report(f);assert.equal(before.currencies[0].overdue.amount,'0.00');
 const changed=await f.request('finance/receipts/'+p.body.data.id+'/allocations',{expectedVersion:1,mode:'manual',lines:[{installment:2,amount:'50'}],reason:'Explicit synthetic remapping'});assert.equal(changed.response.status,200,JSON.stringify(changed.body));
 const after=await report(f);assert.equal(after.currencies[0].overdue.amount,'50.00');assert.deepEqual(after.currencies[0].received,before.currencies[0].received);assert.deepEqual(after.currencies[0].positiveReceivable,before.currencies[0].positiveReceivable);assert.equal(after.historicalAllocationRestatement,true);assert.equal(after.allocationBasis,'current_approved_versions_restated_to_receipt_effective_dates');
});
check('currencies retain their own precision and amounts without a fabricated converted grand total',async f=>{
 const currency=await f.made('finance/currencies',{code:'EUR',name:'Synthetic alternate precision',unitScale:0,reason:'Synthetic configured precision, no FX quote'});
 const student=await f.made('people',{name:'Alternate currency learner',hubId:f.hub});await f.made('students',{personId:student.id,legalName:'Alternate currency learner',dateOfBirth:'1990-01-01',recruiter:{kind:'academy'}});const e=await f.made('classes/'+f.c.id+'/enrollments',{studentId:student.id,studentProfileVersion:1,joinsOn:'2027-01-01',reason:'Synthetic enrollment'});
 const plan=await f.made('enrollments/'+e.id+'/tuition-plan',{...f.planInput,currencyId:currency.id});const account=async(code:string,kind:string,operationalRole:string)=>f.made('finance/accounts',{code,name:'Synthetic '+code,kind,operationalRole,hubId:f.hub,currencyId:currency.id,currencyVersion:1,reason:'Synthetic alternate currency control'});
 const ar=await account('EUR-1100','asset','receivable'),deferred=await account('EUR-2300','liability','deferred_revenue'),tax=await account('EUR-2200','liability','tax_payable');await f.made('finance/tuition-plans/'+plan.id+'/invoice',{...f.base,billToId:student.id,accounts:{receivable:{id:ar.id,version:1},consideration:{id:deferred.id,version:1},tax:{id:tax.id,version:1}}});
 const r=await report(f);assert.deepEqual(r.currencies.map((c:any)=>[c.currencyCode,c.unitScale,c.positiveReceivable.minor,c.positiveReceivable.amount]),[['CAD',2,'11300','113.00'],['EUR',0,'113','113']]);assert.equal(r.total,undefined);assert.equal(r.currencyConversion,'none');assert.equal(r.chartData.hubs.length,2);
 assert.equal((await report(f,'2026-12-02','&currencyIds='+currency.id)).invoiceCount,1);
 const file=await exported(f);assert.equal(file.response.status,200,JSON.stringify(file.body));const totals=csv(file.body).filter(r=>r.section==='currency_total'&&r.field==='positiveReceivable');assert.deepEqual(totals.map(r=>[r.currency_code,r.amount]),[['CAD','113.00'],['EUR','113']]);
});
test('source and chart ceilings refuse partial totals at max plus one; this is a boundary check, not a full-volume benchmark',()=>{
 const b={invoices:10000,installments:100000,receipts:100000,allocations:200000};assert.doesNotThrow(()=>assertReceivableAgingBounds(b,1000,1000));
 for(const key of Object.keys(b) as (keyof typeof b)[])assert.throws(()=>assertReceivableAgingBounds({...b,[key]:receivableAgingLimits[key]+1}),/RECEIVABLE_AGING_REQUIRES_BACKGROUND_JOB/);
 assert.throws(()=>assertReceivableAgingBounds(b,1001),/RECEIVABLE_AGING_REQUIRES_BACKGROUND_JOB/);assert.throws(()=>assertReceivableAgingBounds(b,0,1001),/RECEIVABLE_AGING_REQUIRES_BACKGROUND_JOB/);
});
check('complete summaries are stable across final invoice pages and retain exact amounts above JavaScript integer precision',async f=>{
 const student=await f.made('people',{name:'Second synthetic learner',hubId:f.hub});await f.made('students',{personId:student.id,legalName:'Second synthetic learner',dateOfBirth:'1990-01-01',recruiter:{kind:'academy'}});
 const e=await f.made('classes/'+f.c.id+'/enrollments',{studentId:student.id,studentProfileVersion:1,joinsOn:'2027-01-01',reason:'Synthetic enrollment'});
 const plan=await f.made('enrollments/'+e.id+'/tuition-plan',{...f.planInput,originalAmount:'9007199254740993',agreedAmount:'9007199254740993',pricing:'tax_inclusive',installments:[{dueOn:'2026-12-01',amount:'9007199254740993',methodId:f.method.id,methodVersion:1}]});
 const inv=await f.made('finance/tuition-plans/'+plan.id+'/invoice', {...f.base,billToId:student.id});assert.ok(inv.id);
 const first=await f.request('reports/finance/receivables-aging?on=2026-12-02&limit=1');assert.equal(first.response.status,200,JSON.stringify(first.body));assert.equal(first.body.data.invoiceCount,2);assert.equal(first.body.data.currencies[0].positiveReceivable.amount,'9007199254741106.00');assert.equal(first.body.data.currencies[0].overdue.amount,'9007199254741043.00');assert.ok(first.body.nextCursor);
 const second=await f.request('reports/finance/receivables-aging?on=2026-12-02&limit=1&after='+first.body.nextCursor);assert.equal(second.response.status,200);assert.deepEqual(second.body.data.currencies,first.body.data.currencies);assert.deepEqual(second.body.data.chartData,first.body.data.chartData);assert.notEqual(second.body.data.entries[0].invoiceId,first.body.data.entries[0].invoiceId);assert.equal(second.body.nextCursor,null);
 const file=await exported(f);assert.equal(file.response.status,200,JSON.stringify(file.body));const rows=csv(file.body);assert.equal(new Set(rows.filter(r=>r.section==='invoice').map(r=>r.record_id)).size,2);assert.equal(rows.find(r=>r.section==='currency_total'&&r.field==='positiveReceivable')?.amount,'9007199254741106.00');
});
test('schema89 invoice, receipt and allocation records survive schema90 unchanged and remain reportable',async()=>{
 const f=await receiptFixture({throughSchema:89});try{
  const p=await f.pay({allocation:'oldest_due'});assert.equal(p.response.status,201);
  const tables=['tuition_invoices','billing_documents','tuition_receipts','receipt_allocation_plans','receipt_allocation_revisions','receipt_allocation_lines','finance_journals','finance_journal_lines'],before:unknown[]=[];
  for(const t of tables)before.push((await f.pg.query('SELECT to_jsonb(r) data FROM public.'+t+' r ORDER BY to_jsonb(r)::text')).rows);
  await f.pg.exec(await readFile(new URL('../db/migrations/090_receivables_aging.sql',import.meta.url),'utf8'));
  for(let i=0;i<tables.length;i++)assert.deepEqual((await f.pg.query('SELECT to_jsonb(r) data FROM public.'+tables[i]+' r ORDER BY to_jsonb(r)::text')).rows,before[i]);
  const r=await report(f);assert.equal(r.currencies[0].positiveReceivable.amount,'63.00');assert.equal(r.currencies[0].overdue.amount,'0.00');
 }finally{await f.pg.close();}
});
