import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {test} from 'node:test';
import {parse} from 'csv-parse/sync';
import {exchangeRatio,sumReferenceMinor} from '../src/core/exchange.ts';
import {invoiceFixture} from './invoice-fixture.ts';
import {upgradeToCurrent} from './migration-upgrade.ts';

test('consolidated reference totals round exact signed source sums once,not each displayed row',()=>{
 const rate=exchangeRatio('0.005'),terms=['100','100'].map(minor=>({minor,sourceScale:2,rate}));assert.equal(sumReferenceMinor(terms,2).amount,'0.01');
 assert.equal(sumReferenceMinor([...terms,{minor:'-200',sourceScale:2,rate}],2).amount,'0.00');
 assert.equal(sumReferenceMinor([{minor:'1',sourceScale:0,rate:exchangeRatio('1.25')},{minor:'100',sourceScale:3,rate:exchangeRatio('0.5')}],2).amount,'1.30');
 assert.throws(()=>sumReferenceMinor(Array.from({length:2001},()=>terms[0]),2),/SOURCE_LIMIT/);
});
async function fixture(throughSchema?:number){const f=await invoiceFixture({throughSchema});try{
 const usd=await f.made('finance/currencies',{code:'USD',name:'Synthetic dollar',unitScale:2,reason:'Synthetic valuation currency'});
 const account=(code:string,kind='asset',hubId:string|null=f.hub,currencyId=usd.id,currencyVersion=1)=>f.made('finance/accounts',{code,name:'Synthetic '+code,kind,hubId,currencyId,currencyVersion,reason:'Synthetic valuation account'});
 const a=await account('USD-A'),b=await account('USD-B'),equity=await account('USD-E','equity');
 const post=(lines:unknown[],postedOn='2026-01-20')=>f.request('finance/journals',{periodId:f.period.id,periodVersion:1,postedOn,description:'Private valuation journal',reason:'Private valuation approval',lines});
 const lines=[{accountId:a.id,accountVersion:1,side:'debit',amount:'1'},{accountId:b.id,accountVersion:1,side:'debit',amount:'1'},{accountId:equity.id,accountVersion:1,side:'credit',amount:'2'}];
 const rateInput={base:{id:usd.id,version:1},quote:{id:f.currency.id,version:1},on:'2026-01-31',rate:'0.005',source:'=synthetic source',reference:'@synthetic quote',reason:'Private quote reason'};
 const rate=(patch:Record<string,unknown>={})=>f.request('finance/exchange-rates',{...rateInput,...patch});
 const report=(suffix='',as='master',csv=false)=>f.request('reports/finance/asset-valuation'+(csv?'/export':'')+'?through=2026-01-31&targetCurrencyId='+f.currency.id+suffix,undefined,as);
 const caps=['currency-valuation.view','financial-reports.view','ledger.view','accounts.view'];
 async function access(as='staff',omit?:string){
  const refRole=await f.made('roles',{name:'Global price references '+randomUUID(),permissions:['currencies.view','exchange-rates.view'].filter(c=>c!==omit).map(capability=>({capability,effect:'allow'}))}),financeRole=await f.made('roles',{name:'Own asset report '+randomUUID(),permissions:caps.filter(c=>c!==omit).map(capability=>({capability,effect:'allow'}))}),path='people/'+f.actors[as].person+'/access',prior=(await f.request(path)).body.data;
  assert.equal((await f.request(path,{expectedVersion:prior.version,assignments:[{roleId:refRole.id,allHubs:true},{roleId:financeRole.id,allHubs:false,hubIds:[f.hub]}]})).response.status,200);return {refRole,financeRole};
 }
 return {...f,usd,assetA:a,assetB:b,equity,account,post,lines,rate,rateInput,report,access,caps};
 }catch(e){await f.pg.close();throw e;}}
type Fixture=Awaited<ReturnType<typeof fixture>>;
function check(name:string,run:(f:Fixture)=>Promise<void>){test(name,async()=>{const f=await fixture();try{await run(f);}finally{await f.pg.close();}});}

check('actual posted asset valuation uses exact signed totals once and never adds expensed inventory or changes ledger',async f=>{
 assert.equal((await f.post(f.lines)).response.status,201);const quote=await f.rate();assert.equal(quote.response.status,201);
 const r=await f.report();assert.equal(r.response.status,200,JSON.stringify({body:r.body,failures:f.metrics.queryFailures}));const d=r.body.data;
 assert.equal(d.complete,true);assert.equal(d.total.amount,'0.01');assert.equal(d.knownSubtotal.minor,'1');assert.equal(d.entries.length,2);assert.equal(d.entries[0].converted.amount,'0.00');assert.equal(d.entries[1].converted.amount,'0.00');assert.equal(d.entries[0].rate.id,quote.body.data.id);assert.equal(d.entries[0].closing.amount,'1.00');assert.equal(d.schoolWide,true);
 assert.equal(d.referenceOnly,true);for(const k of ['ledgerAdjusted','moneyMovementPerformed','fxGainLossPosted','inventoryPurchaseCostAdded','formalBalanceSheet'])assert.equal(d[k],false);
 assert.doesNotMatch(JSON.stringify(d),/Private valuation|Private quote|Private accounting/);assert.equal((await f.pg.query('SELECT * FROM public.finance_journals')).rows.length,1);
 assert.equal((await f.request('finance/accounts/'+f.assetA.id+'/balance?through=2026-01-31')).body.data.closing.amount,'1.00');
 const original=await f.request('reports/finance/trial-balance?through=2026-01-31');assert.equal(original.body.data.currencyConversion,'none');assert.equal(original.body.data.currencies[0].balanced,true);
 const before=await f.request('reports/finance/asset-valuation?through=2026-01-19&rateOn=2026-01-31&targetCurrencyId='+f.currency.id);assert.equal(before.body.data.total.amount,'0.00');assert.equal(before.body.data.entries.length,0);
});
test('actual288to290 keeps original prices,posted balances,audit and quote guards while registering presets and tightening private approvals',async()=>{
 const f=await fixture(288);try{
  assert.equal((await f.post(f.lines)).response.status,201);assert.equal((await f.rate()).response.status,201);
  const tables=['finance_exchange_rates','finance_journals','finance_journal_lines','audit_events'],before=await Promise.all(tables.map(t=>f.pg.query('SELECT to_jsonb(t) data FROM public.'+t+' t ORDER BY to_jsonb(t)::text'))),functions="SELECT oid,proowner,proacl,proconfig,prosrc FROM pg_proc WHERE oid=ANY(ARRAY['public.guard_exchange_rate()'::regprocedure,'public.complete_exchange_rate()'::regprocedure,'public.exchange_rate_source(jsonb)'::regprocedure]) ORDER BY oid",original=(await f.pg.query(functions)).rows;
  await f.pg.exec(await readFile(new URL('../db/migrations/289_asset_currency_valuation.sql',import.meta.url),'utf8'));
  assert.equal((await f.pg.query<{n:number}>('SELECT public.schema_revision() n')).rows[0].n,289);for(const [i,t]of tables.entries())assert.deepEqual((await f.pg.query('SELECT to_jsonb(t) data FROM public.'+t+' t ORDER BY to_jsonb(t)::text')).rows,before[i].rows,t);assert.deepEqual((await f.pg.query(functions)).rows,original);
  const approvalSql="SELECT id,payload,review_context,status,reviewer_id,dependency_hash FROM public.approval_requests WHERE action='finance.exchange-rate.record' ORDER BY id",approvals=(await f.pg.query(approvalSql)).rows;
  await f.pg.exec(await readFile(new URL('../db/migrations/290_reference_reporting_integrity.sql',import.meta.url),'utf8'));assert.deepEqual((await f.pg.query(approvalSql)).rows,approvals);assert.equal((await f.pg.query<{ok:boolean}>("SELECT bool_and(privacy_bindings @> '[{\"capability\":\"currencies.view\",\"scope\":{\"all\":true,\"hubs\":[]}}]'::jsonb) ok FROM public.approval_requests WHERE action='finance.exchange-rate.record'")).rows[0].ok,true);
  for(const [i,t]of tables.entries())assert.deepEqual((await f.pg.query('SELECT to_jsonb(t) data FROM public.'+t+' t ORDER BY to_jsonb(t)::text')).rows,before[i].rows,t);assert.deepEqual((await f.pg.query(functions)).rows,original);
  await upgradeToCurrent(f.pg);assert.equal((await f.report()).body.data.total.amount,'0.01');
  const preset=await f.request('reports/presets',{anchor:{kind:'academy'},definition:{name:'Rolling asset value',reportId:'finance.asset-valuation',parameters:{targetCurrencyId:f.currency.id},dateWindow:{kind:'today',timeZone:'America/Toronto'}},reason:'Synthetic relative through date'});assert.equal(preset.response.status,201,JSON.stringify(preset.body));const run=await f.request('reports/presets/'+preset.body.data.id+'/run');assert.equal(run.response.status,200,JSON.stringify(run.body));assert.equal(run.body.resolvedDateWindow.window.kind,'today');assert.equal(run.body.data.targetCurrency.id,f.currency.id);
 }finally{await f.pg.close();}
});
check('missing and withdrawn prices leave total null,known subtotal explicit and zero-only assets need no fabricated quote',async f=>{
 await f.post(f.lines);await f.post([{accountId:f.cash.id,accountVersion:1,side:'debit',amount:'2'},{accountId:f.income.id,accountVersion:1,side:'credit',amount:'2'}]);
 let r=await f.report();assert.equal(r.body.data.complete,false);assert.equal(r.body.data.total,null);assert.equal(r.body.data.knownSubtotal.amount,'2.00');assert.deepEqual(r.body.data.missingCurrencyIds,[f.usd.id]);
 assert.equal(r.body.data.entries.find((e:any)=>e.accountId===f.cash.id).sameCurrencyIdentity,true);
 const old=(await f.rate({on:'2026-01-30'})).body.data;r=await f.report();assert.equal(r.body.data.total,null);r=await f.report('&maximumAgeDays=1');assert.equal(r.body.data.total.amount,'2.01');
 const current=(await f.rate()).body.data,voided=await f.rate({supersedesId:current.id,state:'void',rate:null});assert.equal(voided.response.status,201);r=await f.report('&maximumAgeDays=30');assert.equal(r.body.data.total,null);assert.equal(r.body.data.entries.find((e:any)=>e.accountId===f.assetA.id).issue,'REFERENCE_RATE_WITHDRAWN');assert.notEqual(old.id,current.id);
 const zero=await f.report('&accountIds='+f.ar.id+'&includeZero=true');assert.equal(zero.body.data.complete,true);assert.equal(zero.body.data.total.amount,'0.00');
});
check('hub intersections,explicit selections and each source permission apply before converted totals',async f=>{
 await f.post(f.lines);await f.rate();const hidden=await f.account('HIDDEN','asset',f.otherHub),global=await f.account('GLOBAL','asset',null);await f.post([{accountId:hidden.id,accountVersion:1,side:'debit',amount:'100'},{accountId:global.id,accountVersion:1,side:'credit',amount:'100'}]);
 await f.access();let r=await f.report('', 'staff');assert.equal(r.response.status,200,JSON.stringify(r.body));assert.equal(r.body.data.total.amount,'0.01');assert.equal(r.body.data.schoolWide,false);assert.ok(!JSON.stringify(r.body).includes(hidden.id));assert.ok(!JSON.stringify(r.body).includes(global.id));
 r=await f.report('&accountIds='+hidden.id,'staff');assert.equal(r.body.data.sourceCount,0);assert.equal(r.body.data.total.amount,'0.00');
 r=await f.report('&accountIds='+f.assetA.id);assert.equal(r.body.data.schoolWide,false);assert.equal(r.body.data.total.amount,'0.00');
 for(const cap of [...f.caps,'exchange-rates.view','currencies.view']){await f.access('staff',cap);assert.equal((await f.report('', 'staff')).response.status,403,cap);}
 const foreign=await f.request('reports/finance/asset-valuation?through=2026-01-31&targetCurrencyId='+f.currency.id,undefined,'foreignMaster',{academy:f.b});assert.equal(foreign.response.status,404);
});
check('pinned source precision,current chart classification,reversal and independently selected price date remain explicit',async f=>{
 const posted=await f.post(f.lines);await f.rate();assert.equal((await f.request('finance/currencies/'+f.usd.id+'/change',{expectedVersion:1,unitScale:3,reason:'Synthetic new precision'})).response.status,200);
 const newer=await f.account('USD-NEW','asset',f.hub,f.usd.id,2),newEquity=await f.account('USD-NEW-E','equity',f.hub,f.usd.id,2);assert.equal((await f.post([{accountId:newer.id,accountVersion:1,side:'debit',amount:'1.000'},{accountId:newEquity.id,accountVersion:1,side:'credit',amount:'1.000'}])).response.status,201);
 let r=await f.report();assert.equal(r.body.data.entries.find((e:any)=>e.accountId===f.assetA.id).unitScale,2);assert.equal(r.body.data.entries.find((e:any)=>e.accountId===newer.id).unitScale,3);assert.equal(r.body.data.total.amount,'0.02');
 assert.equal((await f.request('finance/accounts/'+f.assetA.id+'/change',{expectedVersion:1,kind:'liability',reason:'Synthetic current classification correction'})).response.status,200);r=await f.report();assert.equal(r.body.data.total.amount,'0.01');assert.ok(!r.body.data.entries.some((e:any)=>e.accountId===f.assetA.id));
 assert.equal((await f.request('finance/journals/'+posted.body.data.id+'/reverse',{periodId:f.period.id,periodVersion:1,postedOn:'2026-02-01',reason:'Synthetic later reversal',description:'Synthetic reversal'})).response.status,201);
 const later=await f.request('reports/finance/asset-valuation?through=2026-02-01&rateOn=2026-01-31&targetCurrencyId='+f.currency.id);assert.equal(later.body.data.rateOn,'2026-01-31');assert.equal(later.body.data.entries.length,1);assert.equal(later.body.data.total.amount,'0.00');
});
check('central catalogue and configurable presets reuse the same source checks;CSV stays exact,rectangular and formula-safe',async f=>{
 await f.post(f.lines);await f.rate();const catalogue=await f.request('reports/catalogue'),entry=catalogue.body.data.find((e:any)=>e.id==='finance.asset-valuation');assert.ok(entry);assert.deepEqual(entry.formats,['json','csv','xlsx']);assert.deepEqual(entry.backgroundJobFormats,[]);
 const csv=await f.report('', 'master',true);assert.equal(csv.response.status,200);assert.equal(typeof csv.body,'string');const rows=parse(csv.body,{bom:true}) as string[][];assert.ok(rows.length>5);assert.ok(rows.every(r=>r.length===26));assert.ok(rows.flat().includes('text: =synthetic source'));assert.ok(rows.flat().includes('text: @synthetic quote'));assert.ok(rows.flat().includes('0.01'));assert.doesNotMatch(csv.body,/Private quote reason|Private valuation/);
 const saved=await f.request('reports/presets',{anchor:{kind:'hub',id:f.hub},definition:{name:'Selected CAD asset value',reportId:'finance.asset-valuation',parameters:{through:'2026-01-31',targetCurrencyId:f.currency.id}},reason:'Synthetic reusable target currency'});assert.equal(saved.response.status,201,JSON.stringify(saved.body));const id=saved.body.data.id;
 const run=await f.request('reports/presets/'+id+'/run');assert.equal(run.response.status,200,JSON.stringify(run.body));assert.equal(run.body.data.total.amount,'0.01');const savedCsv=await f.request('reports/presets/'+id+'/export');assert.equal(savedCsv.response.status,200,JSON.stringify(savedCsv.body));assert.match(savedCsv.body,/provenance/);assert.match(savedCsv.body,new RegExp(id));
 await f.access();const readRole=await f.made('roles',{name:'Read shared asset preset',permissions:[{capability:'report-presets.view',effect:'allow'}]}),path='people/'+f.actors.staff.person+'/access',prior=(await f.request(path)).body.data;assert.equal((await f.request(path,{expectedVersion:prior.version,assignments:[{roleId:readRole.id,allHubs:false,hubIds:[f.hub]}]})).response.status,200);assert.equal((await f.request('reports/presets/'+id,undefined,'staff')).response.status,200);assert.equal((await f.request('reports/presets/'+id+'/run',undefined,'staff')).response.status,403);assert.equal((await f.request('reports/presets/'+id+'/export',undefined,'staff')).response.status,403);
 for(const suffix of ['&limit=1','&amount=5','&complete=true','&maximumAgeDays=3661','&through=2026-01-31','&rateOn=2026-02-30'])assert.equal((await f.report(suffix)).response.status,400,suffix);
 assert.equal((await f.request('reports/finance/asset-valuation',{through:'2026-01-31',targetCurrencyId:f.currency.id})).response.status,405);
 await f.pg.query("UPDATE public.academies SET status='read_only' WHERE id=$1",[f.a]);assert.equal((await f.report()).response.status,200);
});
if(process.env.TEST_DATABASE_URL)check('brief report/quote correction overlap never mixes currency snapshots within a valuation',async f=>{
 await f.post(f.lines);const original=(await f.rate()).body.data,started=performance.now();
 const results=await Promise.all([f.report(),f.rate({supersedesId:original.id,rate:'0.01'}),f.report(),f.report()]);assert.equal(results[1].response.status,201,JSON.stringify(results[1].body));const corrected=results[1].body.data.id;
 for(const r of [results[0],results[2],results[3]]){assert.equal(r.response.status,200,JSON.stringify(r.body));const ids=new Set(r.body.data.entries.map((e:any)=>e.rate.id));assert.equal(ids.size,1);const [id]=ids;assert.ok(id===original.id||id===corrected);assert.equal(r.body.data.total.amount,id===original.id?'0.01':'0.02');}
 const after=await f.report();assert.equal(after.body.data.total.amount,'0.02');assert.ok(after.body.data.entries.every((e:any)=>e.rate.id===corrected));console.log(JSON.stringify({measurement:'brief-valuation-quote-overlap',requests:5,elapsedMs:Math.ceil(performance.now()-started)}));
});
