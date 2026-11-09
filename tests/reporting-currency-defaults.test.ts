import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {test} from 'node:test';
import {invoiceFixture} from './invoice-fixture.ts';

async function fixture(){const f=await invoiceFixture();try{
 const usd=await f.made('finance/currencies',{code:'USD',name:'Synthetic dollar',unitScale:2,reason:'Synthetic reporting default'}),definition={currency:{id:f.currency.id,version:1},maximumRateAgeDays:7};
 const save=(patch:Record<string,unknown>={},as='master',key?:string)=>f.request('finance/reporting-defaults',{expectedVersion:0,definition,reason:'Private preference approval',...patch},as,{key});
 const report=(suffix='',as='master')=>f.request('reports/finance/asset-valuation?through=2026-01-31'+suffix,undefined,as);
 async function access(as:string,caps=['currencies.view','reporting-defaults.view','reporting-defaults.edit']){
  const role=await f.made('roles',{name:'School report defaults '+randomUUID(),permissions:caps.map(capability=>({capability,effect:'allow'}))}),person=as==='bot'?f.bot:f.actors[as].person,path='people/'+person+'/access',prior=(await f.request(path)).body.data;
  assert.equal((await f.request(path,{expectedVersion:prior.version,assignments:[{roleId:role.id,allHubs:true},...as==='manager'?[{roleId:f.managerRole,allHubs:true}]:[]]})).response.status,200);return role;
 }
 return {...f,usd,definition,save,report,access};
 }catch(e){await f.pg.close();throw e;}}
type Fixture=Awaited<ReturnType<typeof fixture>>;
function check(name:string,run:(f:Fixture)=>Promise<void>){test(name,async()=>{const f=await fixture();try{await run(f);}finally{await f.pg.close();}});}

check('school reporting defaults start unconfigured,persist through review,retry exactly and never change currency editions or ledger',async f=>{
 const empty=await f.request('finance/reporting-defaults');assert.equal(empty.response.status,200);assert.deepEqual(empty.body.data,{version:0,definition:null});assert.equal((await f.report()).response.status,409);
 const key=randomUUID(),saved=await f.save({},'master',key);assert.equal(saved.response.status,200,JSON.stringify({body:saved.body,failures:f.metrics.queryFailures}));assert.equal(saved.body.data.version,1);assert.deepEqual((await f.save({},'master',key)).body,saved.body);
 assert.equal((await f.save({definition:{...f.definition,maximumRateAgeDays:3}},'master',key)).response.status,409);assert.equal((await f.save()).response.status,409);
 const current=await f.request('finance/reporting-defaults');assert.deepEqual(current.body.data.definition,f.definition);assert.doesNotMatch(JSON.stringify(current.body),/Private preference/);
 const report=await f.report();assert.equal(report.response.status,200,JSON.stringify(report.body));assert.equal(report.body.data.targetCurrency.id,f.currency.id);assert.equal(report.body.data.targetSource,'school');assert.equal(report.body.data.maximumAgeDays,7);assert.equal(report.body.data.maximumAgeSource,'school');assert.equal(report.body.data.defaultsVersion,1);
 assert.equal((await f.pg.query<{version:number}>('SELECT version FROM public.finance_currencies WHERE id=$1',[f.currency.id])).rows[0].version,1);assert.equal((await f.pg.query('SELECT 1 FROM public.finance_journals')).rows.length,0);
 const history=await f.request('finance/reporting-defaults/history');assert.equal(history.body.data.length,1);assert.equal(history.body.data[0].reason,'Private preference approval');
});
check('a selected permitted hub reuses its configured currency;explicit target wins and missing hub currencies never silently use school money',async f=>{
 await f.save({definition:{currency:{id:f.usd.id,version:1},maximumRateAgeDays:3}});
 let r=await f.report('&hubIds='+f.hub);assert.equal(r.response.status,200,JSON.stringify(r.body));assert.equal(r.body.data.targetSource,'hub');assert.equal(r.body.data.targetCurrency.id,f.currency.id);
 r=await f.report('&hubIds='+f.hub+'&targetCurrencyId='+f.usd.id+'&maximumAgeDays=0');assert.equal(r.body.data.targetSource,'explicit');assert.equal(r.body.data.targetCurrency.id,f.usd.id);assert.equal(r.body.data.maximumAgeSource,'explicit');assert.equal(r.body.data.maximumAgeDays,0);
 const before=(await f.request('hubs/'+f.hub)).body.data;assert.equal((await f.request('hubs/'+f.hub+'/update',{expectedVersion:before.version,currency:'EUR'})).response.status,200);
 r=await f.report('&hubIds='+f.hub);assert.equal(r.response.status,409);assert.equal(r.body.error.code,'HUB_REPORTING_CURRENCY_NOT_CONFIGURED');
 r=await f.report('&hubIds='+[f.hub,f.otherHub].join(','));assert.equal(r.response.status,200);assert.equal(r.body.data.targetSource,'school');assert.equal(r.body.data.targetCurrency.id,f.usd.id);
});
check('configured age affects real reference conversion while an explicit zero-day override preserves missing-price refusal',async f=>{
 const a=await f.made('finance/accounts',{code:'USD-CASH',name:'Synthetic cash',kind:'asset',hubId:f.hub,currencyId:f.usd.id,currencyVersion:1,reason:'Synthetic asset'}),b=await f.made('finance/accounts',{code:'USD-EQUITY',name:'Synthetic equity',kind:'equity',hubId:f.hub,currencyId:f.usd.id,currencyVersion:1,reason:'Synthetic equity'});
 assert.equal((await f.request('finance/journals',{periodId:f.period.id,periodVersion:1,postedOn:'2026-01-20',description:'Synthetic asset funding',reason:'Synthetic reference test',lines:[{accountId:a.id,accountVersion:1,side:'debit',amount:'10'},{accountId:b.id,accountVersion:1,side:'credit',amount:'10'}]})).response.status,201);
 assert.equal((await f.request('finance/exchange-rates',{base:{id:f.usd.id,version:1},quote:{id:f.currency.id,version:1},on:'2026-01-30',rate:'1.35',source:'Synthetic reference quote',reason:'Synthetic quote'})).response.status,201);await f.save();
 let r=await f.report();assert.equal(r.body.data.total.amount,'13.50');assert.equal(r.body.data.complete,true);r=await f.report('&maximumAgeDays=0');assert.equal(r.body.data.total,null);assert.equal(r.body.data.complete,false);
 const preset=await f.request('reports/presets',{anchor:{kind:'academy'},definition:{name:'Use school default',reportId:'finance.asset-valuation',parameters:{through:'2026-01-31'}},reason:'Synthetic automatic reporting currency'});assert.equal(preset.response.status,201,JSON.stringify(preset.body));assert.equal((await f.request('reports/presets/'+preset.body.data.id+'/run')).body.data.total.amount,'13.50');
 assert.equal((await f.save({expectedVersion:1,definition:{currency:{id:f.usd.id,version:1},maximumRateAgeDays:0}})).response.status,200);const next=await f.request('reports/presets/'+preset.body.data.id+'/run');assert.equal(next.body.data.targetCurrency.id,f.usd.id);assert.equal(next.body.data.total.amount,'10.00');assert.equal(next.body.data.defaultsVersion,2);
});
check('upper humans approve defaults,bots only propose,and currency changes make pending settings stale',async f=>{
 await f.access('staff');await f.access('manager');const p=await f.save({},'staff');assert.equal(p.response.status,202,JSON.stringify(p.body));assert.equal((await f.approve(p.body.approval.id,'staff')).response.status,403);assert.equal((await f.approve(p.body.approval.id,'manager')).response.status,200);
 const pending=await f.save({expectedVersion:1},'staff');assert.equal(pending.response.status,202);assert.equal((await f.request('finance/currencies/'+f.currency.id+'/change',{expectedVersion:1,name:'Updated synthetic CAD',reason:'Invalidate stale source'})).response.status,200);assert.equal((await f.approve(pending.body.approval.id)).response.status,409);
 await f.access('bot');const bot=await f.save({expectedVersion:1,definition:{currency:{id:f.currency.id,version:2},maximumRateAgeDays:0}},'bot');assert.equal(bot.response.status,202,JSON.stringify(bot.body));assert.equal((await f.approve(bot.body.approval.id,'bot')).response.status,403);assert.equal((await f.approve(bot.body.approval.id)).response.status,200);
});
check('current global preference rights,tenant isolation and source privacy protect settings without granting financial reports',async f=>{
 await f.save();await f.access('staff',['currencies.view','reporting-defaults.view']);assert.equal((await f.request('finance/reporting-defaults',undefined,'staff')).response.status,200);assert.equal((await f.request('finance/reporting-defaults/history',undefined,'staff')).response.status,403);assert.equal((await f.report('', 'staff')).response.status,403);
 const foreign=await f.request('finance/reporting-defaults',undefined,'foreignMaster',{academy:f.b});assert.equal(foreign.response.status,200);assert.deepEqual(foreign.body.data,{version:0,definition:null});
 const refs=await f.made('roles',{name:'Reference-only defaults consumer',permissions:['currencies.view','exchange-rates.view'].map(capability=>({capability,effect:'allow'}))}),reports=await f.made('roles',{name:'Own hub assets',permissions:['currency-valuation.view','financial-reports.view','accounts.view','ledger.view'].map(capability=>({capability,effect:'allow'}))}),path='people/'+f.actors.staff.person+'/access',prior=(await f.request(path)).body.data;
 assert.equal((await f.request(path,{expectedVersion:prior.version,assignments:[{roleId:refs.id,allHubs:true},{roleId:reports.id,allHubs:false,hubIds:[f.hub]}]})).response.status,200);assert.equal((await f.request('finance/reporting-defaults',undefined,'staff')).response.status,403);assert.equal((await f.report('&hubIds='+f.hub,'staff')).response.status,200);
 const other=(await f.request('hubs/'+f.otherHub)).body.data;assert.equal((await f.request('hubs/'+f.otherHub+'/update',{expectedVersion:other.version,currency:'USD'})).response.status,200);const hidden=await f.report('&hubIds='+f.otherHub,'staff');assert.equal(hidden.response.status,200,JSON.stringify(hidden.body));assert.equal(hidden.body.data.targetSource,'school');assert.equal(hidden.body.data.targetCurrency.id,f.currency.id);assert.equal(hidden.body.data.sourceCount,0);assert.ok(!JSON.stringify(hidden.body).includes(f.otherHub));
 await f.access('staff');await f.access('manager');const p=await f.save({expectedVersion:1},'staff');assert.equal(p.response.status,202);await f.access('manager',['reporting-defaults.view','reporting-defaults.edit']);assert.equal((await f.request('approvals/'+p.body.approval.id,undefined,'manager')).response.status,404);
});
check('invalid defaults,retirement and failed critical outbox writes cannot create misleading target settings',async f=>{
 for(const patch of [{definition:{...f.definition,maximumRateAgeDays:3661}},{definition:{...f.definition,maximumRateAgeDays:-1}},{definition:{...f.definition,extra:true}},{expectedVersion:-1}])assert.equal((await f.save(patch)).response.status,400);
 await f.pg.exec('REVOKE INSERT ON public.outbox_events FROM kavosh_runtime');try{assert.equal((await f.save()).response.status,503);}finally{await f.pg.exec('GRANT INSERT ON public.outbox_events TO kavosh_runtime');}assert.equal((await f.pg.query('SELECT 1 FROM public.finance_reporting_preferences')).rows.length,0);
 assert.equal((await f.save()).response.status,200);assert.equal((await f.request('finance/currencies/'+f.currency.id+'/change',{expectedVersion:1,active:false,reason:'Retire synthetic currency'})).response.status,200);
 const retired=await f.report();assert.equal(retired.response.status,409);assert.equal(retired.body.error.code,'DEFAULT_REPORTING_CURRENCY_RETIRED');assert.equal((await f.report('&targetCurrencyId='+f.currency.id)).response.status,200);assert.equal((await f.save({expectedVersion:1,definition:{currency:{id:f.currency.id,version:2},maximumRateAgeDays:0}})).response.status,409);
 await f.pg.exec('SET ROLE kavosh_runtime');try{await f.pg.query("SELECT set_config('app.academy_id',$1,false)",[f.a]);await assert.rejects(f.pg.exec('UPDATE public.finance_reporting_preferences SET version=2'),/permission denied/);await assert.rejects(f.pg.exec('DELETE FROM public.finance_reporting_preferences'),/permission denied/);await f.pg.query("SELECT set_config('app.academy_id',$1,false)",[f.b]);assert.equal((await f.pg.query('SELECT 1 FROM public.finance_reporting_preferences')).rows.length,0);}finally{await f.pg.exec('RESET ROLE');}
});
if(process.env.TEST_DATABASE_URL)check('brief competing school-default changes keep one next edition and coherent report choices',async f=>{
 const started=performance.now(),results=await Promise.all([f.save(),f.save({definition:{currency:{id:f.usd.id,version:1},maximumRateAgeDays:0}})]);assert.deepEqual(results.map(r=>r.response.status).sort(),[200,409]);assert.equal((await f.pg.query('SELECT 1 FROM public.finance_reporting_preferences')).rows.length,1);const current=(await f.request('finance/reporting-defaults')).body.data,r=await f.report();assert.equal(r.body.data.targetCurrency.id,current.definition.currency.id);assert.equal(r.body.data.maximumAgeDays,current.definition.maximumRateAgeDays);assert.equal(r.body.data.defaultsVersion,1);console.log(JSON.stringify({measurement:'brief-reporting-default-conflict',requests:4,elapsedMs:Math.ceil(performance.now()-started)}));
});
