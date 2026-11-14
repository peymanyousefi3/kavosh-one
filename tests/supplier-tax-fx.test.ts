import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {test} from 'node:test';
import {supplierTaxFixture} from './supplier-tax-fixture.ts';
import {upgradeToCurrent} from './migration-upgrade.ts';
import {convertReferenceMinor,exchangeRatio} from '../src/core/exchange.ts';
import {spreadsheetRows} from './spreadsheet-reader.ts';

const ref=(v:{id:string})=>({id:v.id,version:1});
async function fixture(currency:{code:string;unitScale:number}={code:'USD',unitScale:2}){const f=await supplierTaxFixture();try{
 const usd=await f.made('finance/currencies',{...currency,name:'Synthetic foreign currency',reason:'Foreign supplier source'});
 const account=(code:string,kind:string,operationalRole:string)=>f.made('finance/accounts',{code,name:code,kind,operationalRole,hubId:f.hub,currencyId:usd.id,currencyVersion:1,reason:'Original foreign settlement mapping'});
 const cash=await account('FX-CASH','asset','cash'),ap=await account('FX-AP','liability','payable'),expense=await account('FX-EXPENSE','expense','expense'),tax=await account('FX-TAX','asset','tax_receivable');
 const bill=await f.made('finance/expense-bills',{...f.input,currency:ref(usd),payableAccount:ref(ap),documentNumber:'FX-BILL',lines:[{...f.input.lines[0],expenseAccount:ref(expense),taxAccount:ref(tax)}]});
 const paymentPath='finance/expense-bills/'+bill.id+'/payments',paymentInput={...f.paymentInput,amount:currency.unitScale===0?'50':f.paymentInput.amount,fundingAccount:ref(cash)},payment=await f.made(paymentPath,paymentInput);
 const quoteInput={base:ref(usd),quote:ref(f.currency),on:'2026-11-07',rate:'1.35',source:'Synthetic manually reviewed quote,not real market data',reference:'SYNTHETIC-FX',reason:'Explicit reviewed reporting reference'};
 const quote=await f.made('finance/exchange-rates',quoteInput);
 const definition={...f.definition,allocation:{...f.definition.allocation,income:[{box:'048',amount:'59.74'}],gstHst:'7.76'},fx:{rateId:quote.id,maximumAgeDays:0,gstHstMinor:'575',pstMinor:'0',review:'PRIVATE_FX_DATE_AND_SOURCE_REVIEW'}};
 const path='finance/expense-payments/'+payment.id+'/tax-recognition',record={expectedVersion:0,definition,reason:'PRIVATE_FX_RECOGNITION_REVIEW'};
 const role=await f.made('roles',{name:'Foreign reference viewers',permissions:['currencies.view','exchange-rates.view'].map(capability=>({capability,effect:'allow'}))});
 for(const person of [f.actors.staff.person,f.actors.manager.person])await f.pg.query('INSERT INTO public.role_assignments(academy_id,id,person_id,role_id,all_hubs) VALUES($1,$2,$3,$4,true)',[f.a,randomUUID(),person,role.id]);
 const report='reports/finance/supplier-t4a-working-paper?payeeId='+f.payee.id+'&employerId='+f.employer.id+'&taxYear=2026&timeZone=America/Toronto';
 return {...f,usd,cash,foreignBill:bill,foreignPaymentPath:paymentPath,foreignPaymentInput:paymentInput,foreignPayment:payment,quoteInput,quote,fxDefinition:definition,fxPath:path,fxRecord:record,fxRole:role,fxReport:report};
 }catch(error){await f.pg.close();throw error;}}

test('foreign supplier recognition retains exact original money and reviewed CAD amounts without posting a second payment',async()=>{
 const f=await fixture();try{
  const before=(await f.pg.query('SELECT * FROM public.finance_journal_lines ORDER BY journal_id,line_number')).rows;
  await f.pg.exec('BEGIN;SET LOCAL ROLE kavosh_runtime');try{await f.pg.query("SELECT set_config('app.academy_id',$1,true)",[f.a]);const native=(await f.pg.query<{plan:{grossMinor:string}}>('SELECT public.supplier_tax_plan($1,0,$2::jsonb) plan',[f.foreignPayment.id,JSON.stringify(f.fxDefinition)])).rows[0].plan;assert.equal(native.grossMinor,'6750');}finally{await f.pg.exec('ROLLBACK');}
  const r=await f.request(f.fxPath,f.fxRecord);assert.equal(r.response.status,200,JSON.stringify({body:r.body,queries:f.metrics.queryFailures}));
  assert.equal(r.body.data.settlementMinor,'6750');assert.equal(r.body.data.grossMinor,'6750');assert.equal(r.body.data.source.originalSettlementMinor,'5000');assert.equal(r.body.data.source.originalCurrencyId,f.usd.id);assert.equal(r.body.data.source.fx.rateId,f.quote.id);assert.equal(r.body.data.source.fx.taxConversionLegallyVerified,false);
  const report=await f.request(f.fxReport);assert.equal(report.response.status,200,JSON.stringify(report.body));assert.equal(report.body.data.recognizedPaymentCount,1);assert.equal(report.body.data.totals.gross.amount,'67.50');assert.equal(report.body.data.totals.excludedGstHst.amount,'7.76');assert.equal(report.body.data.totals.reportableIncome.amount,'59.74');assert.equal(report.body.data.paymentSources[0].originalSettlement.amount,'50.00');assert.equal(report.body.data.paymentSources[0].originalSettlement.currency,'USD');
  const csv=await f.request(f.fxReport.replace('?','/export?'));assert.equal(csv.response.status,200);assert.match(csv.body,/payment_original_source/);assert.match(csv.body,/payment_fx_reference/);assert.ok(csv.body.includes(f.quote.id));assert.doesNotMatch(csv.body,/PRIVATE_FX|PRIVATE_SUPPLIER/);
  const xlsx=await f.request(f.fxReport.replace('?','/export.xlsx?'));assert.equal(xlsx.response.status,200);const cells=spreadsheetRows(xlsx.body);assert.ok(cells.some(row=>row[0]==='payment_original_source'&&row[2]==='USD'&&row[9]==='5000'));assert.ok(cells.some(row=>row[0]==='payment_fx_reference'&&row[2].includes(f.quote.id)));assert.doesNotMatch(JSON.stringify(cells),/PRIVATE_FX|PRIVATE_SUPPLIER/);
  assert.deepEqual((await f.pg.query('SELECT * FROM public.finance_journal_lines ORDER BY journal_id,line_number')).rows,before);
  const audit=(await f.pg.query("SELECT changes FROM public.audit_events WHERE action='finance.supplier-tax.change'")).rows;assert.doesNotMatch(JSON.stringify(audit),/PRIVATE_FX|1\.35|SYNTHETIC-FX/);
  assert.equal((await f.request(f.fxPath,{expectedVersion:1,definition:null,reason:'Withdraw reviewed FX recognition'})).response.status,200);assert.equal((await f.request(f.fxPath)).body.data.state,'withdrawn');assert.equal((await f.request(f.fxPath)).body.data.source.fx.rateId,f.quote.id);
 }finally{await f.pg.close();}
});

test('foreign partial payments reserve original tax capacity across different exchange rates rather than comparing CAD with USD',async()=>{
 const f=await fixture();try{
  assert.equal((await f.request(f.fxPath,f.fxRecord)).response.status,200);
  const second=await f.made(f.foreignPaymentPath,{...f.foreignPaymentInput,amount:'63.00',paidAt:'2026-11-09T01:30:00Z'}),quote=await f.made('finance/exchange-rates',{...f.quoteInput,on:'2026-11-08',rate:'1.40'}),path='finance/expense-payments/'+second.id+'/tax-recognition';
  const definition={...f.fxDefinition,fx:{...f.fxDefinition.fx,rateId:quote.id,gstHstMinor:'725'},allocation:{...f.fxDefinition.allocation,income:[{box:'048',amount:'78.05'}],gstHst:'10.15'}};
  const r=await f.request(path,{...f.fxRecord,definition});assert.equal(r.response.status,200,JSON.stringify(r.body));
  const report=await f.request(f.fxReport);assert.equal(report.body.data.recognizedPaymentCount,2);assert.equal(report.body.data.totals.gross.amount,'155.70');assert.equal(report.body.data.totals.excludedGstHst.amount,'17.91');
  const excessive={...definition,fx:{...definition.fx,gstHstMinor:'726'},allocation:{...definition.allocation,income:[{box:'048',amount:'78.04'}],gstHst:'10.16'}};
  const bad=await f.request(path,{...f.fxRecord,expectedVersion:1,definition:excessive});assert.equal(bad.response.status,409);assert.equal(bad.body.error.code,'SUPPLIER_TAX_EXCLUSION_CAPACITY_EXCEEDED');
 }finally{await f.pg.close();}
});

test('foreign recognition refuses missing stale future inverse and mismatched references and revocation hides private approvals and exports',async()=>{
 const f=await fixture();try{
  for(const definition of [{...f.definition},{...f.fxDefinition,fx:{...f.fxDefinition.fx,rateId:randomUUID()}},{...f.fxDefinition,allocation:{...f.fxDefinition.allocation,gstHst:'7.77',income:[{box:'048',amount:'59.73'}]}}]){const r=await f.request(f.fxPath,{...f.fxRecord,definition});assert.equal(r.response.status,409,JSON.stringify(r.body));}
  const future=await f.made('finance/exchange-rates',{...f.quoteInput,on:'2026-11-08'}),inverse=await f.made('finance/exchange-rates',{...f.quoteInput,base:ref(f.currency),quote:ref(f.usd),rate:'0.75'});
  for(const rate of [future,inverse]){const r=await f.request(f.fxPath,{...f.fxRecord,definition:{...f.fxDefinition,fx:{...f.fxDefinition.fx,rateId:rate.id}}});assert.equal(r.response.status,409);assert.equal(r.body.error.code,'SUPPLIER_TAX_FX_SOURCE_CHANGED');}
  const pending=await f.request(f.fxPath,f.fxRecord,'staff');assert.equal(pending.response.status,202,JSON.stringify(pending.body));
  await f.made('finance/exchange-rates',{...f.quoteInput,rate:'1.36',supersedesId:f.quote.id});const stale=await f.approve(pending.body.approval.id,'manager');assert.equal(stale.response.status,409);assert.equal((await f.pg.query('SELECT * FROM public.supplier_tax_records')).rows.length,0);
  const fresh=await f.made('finance/exchange-rates',{...f.quoteInput,on:'2026-11-06'}),definition={...f.fxDefinition,fx:{...f.fxDefinition.fx,rateId:fresh.id}};
  assert.equal((await f.request(f.fxPath,{...f.fxRecord,definition})).response.status,409);definition.fx.maximumAgeDays=1;
  assert.equal((await f.request(f.fxPath,{...f.fxRecord,definition})).response.status,200);
  await f.pg.query("DELETE FROM public.role_permissions WHERE role_id=$1 AND capability='exchange-rates.view'",[f.fxRole.id]);
  assert.equal((await f.request(f.fxPath,undefined,'staff')).response.status,404);assert.equal((await f.request(f.fxReport,undefined,'staff')).response.status,404);assert.equal((await f.request(f.fxReport.replace('?','/export?'),undefined,'staff')).response.status,404);
  assert.equal((await f.request(f.fxPath,{...f.fxRecord,expectedVersion:1,definition},'staff')).response.status,404);assert.equal((await f.request('approvals/'+pending.body.approval.id,undefined,'staff')).response.status,404);
 }finally{await f.pg.close();}
});

test('foreign recognition supports original three-decimal precision without changing original currency editions',async()=>{
 const f=await fixture({code:'BHD',unitScale:3});try{
  const definition={...f.fxDefinition,fx:{...f.fxDefinition.fx,gstHstMinor:'5750'}};
  const r=await f.request(f.fxPath,{...f.fxRecord,definition});assert.equal(r.response.status,200,JSON.stringify(r.body));assert.equal(r.body.data.source.originalSettlementMinor,'50000');assert.equal(r.body.data.source.originalUnitScale,3);assert.equal(r.body.data.settlementMinor,'6750');
  const report=await f.request(f.fxReport);assert.equal(report.body.data.totals.gross.amount,'67.50');assert.equal(report.body.data.paymentSources[0].originalSettlement.amount,'50.000');
 }finally{await f.pg.close();}
});

test('foreign recognition supports zero-decimal source money without treating major units as cents',async()=>{
 const f=await fixture({code:'JPY',unitScale:0});try{
  const quote=await f.made('finance/exchange-rates',{...f.quoteInput,rate:'0.009',supersedesId:f.quote.id});
  const definition={...f.fxDefinition,fx:{...f.fxDefinition.fx,rateId:quote.id,gstHstMinor:'6'},allocation:{...f.fxDefinition.allocation,income:[{box:'048',amount:'0.40'}],gstHst:'0.05'}};
  const r=await f.request(f.fxPath,{...f.fxRecord,definition});assert.equal(r.response.status,200,JSON.stringify(r.body));assert.equal(r.body.data.source.originalSettlementMinor,'50');assert.equal(r.body.data.settlementMinor,'45');
  const report=await f.request(f.fxReport);assert.equal(report.body.data.totals.reportableIncome.amount,'0.40');assert.equal(report.body.data.paymentSources[0].originalSettlement.amount,'50');
 }finally{await f.pg.close();}
});

test('two concurrent foreign partial-payment recognitions cannot reserve the same original tax capacity twice',async()=>{
 const f=await fixture();try{
  const second=await f.made(f.foreignPaymentPath,{...f.foreignPaymentInput,amount:'63.00'}),firstDefinition={...f.fxDefinition,fx:{...f.fxDefinition.fx,gstHstMinor:'700'},allocation:{...f.fxDefinition.allocation,income:[{box:'048',amount:'58.05'}],gstHst:'9.45'}},secondDefinition={...firstDefinition,allocation:{...firstDefinition.allocation,income:[{box:'048',amount:'75.60'}]}};
  const results=await Promise.all([f.request(f.fxPath,{...f.fxRecord,definition:firstDefinition}),f.request('finance/expense-payments/'+second.id+'/tax-recognition',{...f.fxRecord,definition:secondDefinition})]);
  assert.deepEqual(results.map(r=>r.response.status).sort(),[200,409],JSON.stringify(results.map(r=>r.body)));assert.equal(results.find(r=>r.response.status===409)!.body.error.code,'SUPPLIER_TAX_EXCLUSION_CAPACITY_EXCEEDED');assert.equal((await f.pg.query('SELECT count(*)::integer n FROM public.supplier_tax_revisions')).rows[0].n,1);
 }finally{await f.pg.close();}
});

test('actual387to388 preserves CAD recognition rows and helper authority and native FX arithmetic matches exact half-even reference conversion',async()=>{
 const f=await supplierTaxFixture({throughSchema:387});try{
  assert.equal((await f.request(f.recordPath,f.recordInput)).response.status,200);
  const tables=['expense_payments','finance_journal_lines','supplier_tax_records','supplier_tax_revisions','approval_requests','audit_events'],snapshot=async()=>{const rows=[];for(const t of tables)rows.push((await f.pg.query('SELECT * FROM public.'+t+' ORDER BY 1,2')).rows);return rows;};
  const before=await snapshot(),q="SELECT oid,proowner,proacl,proconfig,provolatile,prosecdef FROM pg_proc WHERE oid IN('public.supplier_tax_plan(uuid,integer,jsonb)'::regprocedure,'public.supplier_tax_definition_valid(jsonb)'::regprocedure,'public.supplier_tax_privacy()'::regprocedure) ORDER BY oid",authority=(await f.pg.query(q)).rows;await upgradeToCurrent(f.pg);assert.deepEqual(await snapshot(),before);assert.deepEqual((await f.pg.query(q)).rows,authority);
  for(const [minor,scale,rate] of [['1',2,'0.5'],['3',2,'0.5'],['575',2,'1.35'],['100',0,'0.009'],['9000000000000000000000',3,'1.000000000000000001']] as const){const ratio=exchangeRatio(rate),r=await f.pg.query<{value:string}>('SELECT public.supplier_tax_reference_minor($1,$2,$3,$4)::text value',[minor,scale,ratio.numerator.toString(),ratio.denominator.toString()]);assert.equal(r.rows[0].value,convertReferenceMinor(minor,scale,2,ratio).minor);}
  assert.equal((await f.request(f.recordPath)).body.data.settlementMinor,'5000');assert.equal((await f.request(f.recordPath)).body.data.source.fx,undefined);
 }finally{await f.pg.close();}
});
