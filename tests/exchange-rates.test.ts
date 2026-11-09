import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {test} from 'node:test';
import {exchangeRatio,convertReferenceMinor} from '../src/core/exchange.ts';
import {invoiceFixture} from './invoice-fixture.ts';

test('reference conversion retains exact decimal ratios, major-unit conventions, signed half-even ties and aggregate precision',()=>{
 assert.deepEqual(exchangeRatio('1.3500'),{numerator:135n,denominator:100n});
 assert.equal(convertReferenceMinor('10000',2,2,exchangeRatio('1.35')).amount,'135.00');
 assert.equal(convertReferenceMinor('100',0,2,exchangeRatio('0.009')).amount,'0.90');
 for(const [input,expected] of [['1','0'],['3','2'],['-1','0'],['-3','-2']])assert.equal(convertReferenceMinor(input,0,0,exchangeRatio('0.5')).minor,expected);
 assert.equal(convertReferenceMinor('10000000000000000000000000000000000000000',0,0,exchangeRatio('2')).minor,'20000000000000000000000000000000000000000');
 assert.equal(convertReferenceMinor('1',18,18,exchangeRatio('0.000000000000000001')).exact.denominator,'1000000000000000000000000000000000000');
 for(const bad of ['0','-1','01','1e2','NaN','1.','1.0000000000000000001','1000000000000000000'])assert.throws(()=>exchangeRatio(bad));
 assert.throws(()=>convertReferenceMinor('1',19,2,exchangeRatio('1')));
});
async function fixture(){const f=await invoiceFixture();try{
 const usd=await f.made('finance/currencies',{code:'USD',name:'Synthetic US dollar',unitScale:2,reason:'Synthetic reference test'});
 const input={base:{id:usd.id,version:1},quote:{id:f.currency.id,version:1},on:'2026-01-31',rate:'1.35',source:'Synthetic manual quote; not market data',reason:'Private quote review'};
 const save=(patch:Record<string,unknown>={},as='master',key?:string)=>f.request('finance/exchange-rates',{...input,...patch},as,{key});
 const convert=(suffix='',as='master')=>f.request('finance/exchange-rates/conversion?baseCurrencyId='+usd.id+'&quoteCurrencyId='+f.currency.id+'&on=2026-01-31&amount=100'+suffix,undefined,as);
 async function access(as:string,caps=['exchange-rates.view','exchange-rates.edit','currencies.view'],global=true){
  const role=await f.made('roles',{name:'Reference quotes '+randomUUID(),permissions:caps.map(capability=>({capability,effect:'allow'}))}),person=as==='bot'?f.bot:f.actors[as].person,path='people/'+person+'/access',prior=(await f.request(path)).body.data;
  assert.equal((await f.request(path,{expectedVersion:prior.version,assignments:[{roleId:role.id,allHubs:global,...global?{}:{hubIds:[f.hub]}},...as==='manager'?[{roleId:f.managerRole,allHubs:true}]:[]]})).response.status,200);return role;
 }
 return {...f,usd,input,save,convert,access};
 }catch(e){await f.pg.close();throw e;}}
type Fixture=Awaited<ReturnType<typeof fixture>>;
function check(name:string,run:(f:Fixture)=>Promise<void>){test(name,async()=>{const f=await fixture();try{await run(f);}finally{await f.pg.close();}});}

check('approved exact reference quotes persist, convert without ledger writes and retry without duplicate effects',async f=>{
 const key=randomUUID(),r=await f.save({},'master',key);assert.equal(r.response.status,201,JSON.stringify({body:r.body,failures:f.metrics.queryFailures}));
 assert.deepEqual((await f.save({},'master',key)).body,r.body);assert.equal((await f.save({rate:'2'},'master',key)).response.status,409);
 assert.deepEqual(r.body.data.ratio,{numerator:'135',denominator:'100'});assert.doesNotMatch(JSON.stringify(r.body.data),/Private quote/);
 const c=await f.convert();assert.equal(c.response.status,200,JSON.stringify(c.body));assert.equal(c.body.data.converted.amount,'135.00');assert.equal(c.body.data.complete,true);assert.equal(c.body.data.rate.id,r.body.data.id);
 assert.equal((await f.pg.query('SELECT * FROM public.finance_journals')).rows.length,0);assert.equal((await f.pg.query('SELECT * FROM public.finance_exchange_rates')).rows.length,1);
 const audit=(await f.pg.query<{changes:{severity:string}}>("SELECT changes FROM public.audit_events WHERE action='finance.exchange-rate.recorded'")).rows;assert.equal(audit.length,1);assert.equal(audit[0].changes.severity,'critical');assert.doesNotMatch(JSON.stringify(audit),/Private quote|1\.35|Synthetic manual/);
 await f.pg.exec('REVOKE INSERT ON public.outbox_events FROM kavosh_runtime');try{assert.equal((await f.save({on:'2026-02-01'})).response.status,503);}finally{await f.pg.exec('GRANT INSERT ON public.outbox_events TO kavosh_runtime');}
 assert.equal((await f.pg.query('SELECT * FROM public.finance_exchange_rates')).rows.length,1);
});
check('correction and withdrawal history never overwrites, branches or silently falls back to an older reference',async f=>{
 const a=(await f.save()).body.data;assert.equal((await f.save()).response.status,409);
 const b=await f.save({supersedesId:a.id,rate:'1.4'});assert.equal(b.response.status,201,JSON.stringify(b.body));assert.equal((await f.save({supersedesId:a.id})).response.status,409);
 assert.equal((await f.convert()).body.data.converted.amount,'140.00');assert.equal((await f.request('finance/exchange-rates/'+a.id)).body.data.supersededBy,b.body.data.id);
 const v=await f.save({supersedesId:b.body.data.id,state:'void',rate:null});assert.equal(v.response.status,201,JSON.stringify(v.body));
 let c=await f.convert('&maximumAgeDays=30');assert.equal(c.body.data.issue,'REFERENCE_RATE_WITHDRAWN');assert.equal(c.body.data.converted,null);assert.equal(c.body.data.complete,false);
 assert.equal((await f.save({supersedesId:v.body.data.id,state:'void',rate:null})).response.status,409);
 const restored=await f.save({supersedesId:v.body.data.id,rate:'1.25'});assert.equal(restored.response.status,201);assert.equal((await f.convert()).body.data.converted.amount,'125.00');
 const list=await f.request('finance/exchange-rates?includeHistory=true&limit=1');assert.ok(list.body.nextCursor);assert.equal((await f.request('finance/exchange-rates?includeHistory=true&after='+list.body.nextCursor)).body.data.length,3);
 assert.equal((await f.request('finance/exchange-rates')).body.data.length,1);
});
check('missing prices, explicit age, direct direction and same-currency identity cannot manufacture a rate',async f=>{
 let c=await f.convert();assert.equal(c.body.data.complete,false);assert.equal(c.body.data.converted,null);
 assert.equal((await f.save({on:'2026-01-30'})).response.status,201);
 c=await f.convert();assert.equal(c.body.data.issue,'REFERENCE_RATE_MISSING');c=await f.convert('&maximumAgeDays=1');assert.equal(c.body.data.converted.amount,'135.00');
 const same=await f.request('finance/exchange-rates/conversion?baseCurrencyId='+f.currency.id+'&quoteCurrencyId='+f.currency.id+'&on=2026-01-31&amount=-1.25');assert.equal(same.body.data.converted.amount,'-1.25');assert.equal(same.body.data.sameCurrencyIdentity,true);
 const inverse=await f.request('finance/exchange-rates/conversion?baseCurrencyId='+f.currency.id+'&quoteCurrencyId='+f.usd.id+'&on=2026-01-30&amount=1');assert.equal(inverse.body.data.converted,null);
 for(const patch of [{rate:'0'},{rate:'1e2'},{on:'9999-12-31'},{state:'void',rate:null},{base:f.input.quote},{rate:'1',verified:true}])assert.equal((await f.save(patch)).response.status,400,JSON.stringify(patch));
 assert.equal((await f.convert('&amount=2')).response.status,400);assert.equal((await f.convert('&maximumAgeDays=3661')).response.status,400);
});
check('upper human review, global reference permissions, current currencies and tenant boundaries are enforced',async f=>{
 await f.access('staff');await f.access('manager');const p=await f.save({},'staff');assert.equal(p.response.status,202,JSON.stringify(p.body));assert.equal((await f.convert()).body.data.complete,false);
 assert.equal((await f.approve(p.body.approval.id,'staff')).response.status,403);assert.equal((await f.approve(p.body.approval.id,'manager')).response.status,200);
 assert.equal((await f.request('finance/exchange-rates/'+(await f.request('finance/exchange-rates')).body.data[0].id,undefined,'foreignMaster',{academy:f.b})).response.status,404);
 const stale=await f.save({on:'2026-02-01'},'staff');assert.equal(stale.response.status,202);
 assert.equal((await f.request('finance/currencies/'+f.usd.id+'/change',{expectedVersion:1,name:'Synthetic updated dollar',reason:'Invalidate pending quote'})).response.status,200);
 assert.equal((await f.approve(stale.body.approval.id)).response.status,409);assert.equal((await f.save()).response.status,409);
 await f.access('bot');const bot=await f.save({base:{id:f.usd.id,version:2},on:'2026-02-02'},'bot');assert.equal(bot.response.status,202);assert.equal((await f.approve(bot.body.approval.id,'bot')).response.status,403);assert.equal((await f.approve(bot.body.approval.id)).response.status,200);
 await f.access('staff',['exchange-rates.view']);assert.equal((await f.convert('', 'staff')).response.status,403);
});
check('private quote approvals disappear from detail and lists when global currency-source rights are removed',async f=>{
 await f.access('staff');await f.access('manager');const pending=await f.save({},'staff');assert.equal(pending.response.status,202);assert.equal((await f.request('approvals/'+pending.body.approval.id,undefined,'manager')).response.status,200);
 await f.access('manager',['exchange-rates.view','exchange-rates.edit']);assert.equal((await f.request('approvals/'+pending.body.approval.id,undefined,'manager')).response.status,404);
 const list=await f.request('approvals',undefined,'manager');assert.equal(list.response.status,200);assert.ok(!JSON.stringify(list.body).includes(pending.body.approval.id));assert.equal((await f.approve(pending.body.approval.id,'manager')).response.status,404);assert.equal((await f.pg.query('SELECT * FROM public.finance_exchange_rates')).rows.length,0);
});
check('a retired currency reference can be withdrawn but cannot acquire a new recorded price',async f=>{
 const first=(await f.save()).body.data;
 assert.equal((await f.request('finance/currencies/'+f.usd.id+'/change',{expectedVersion:1,active:false,reason:'Synthetic retirement'})).response.status,200);
 assert.equal((await f.save({base:{id:f.usd.id,version:2},supersedesId:first.id})).response.status,409);
 const v=await f.save({base:{id:f.usd.id,version:2},supersedesId:first.id,state:'void',rate:null});assert.equal(v.response.status,201,JSON.stringify(v.body));assert.equal((await f.convert()).body.data.issue,'REFERENCE_RATE_WITHDRAWN');
});
check('native immutable, exact-ratio and deferred completion constraints reject forged rate effects',async f=>{
 await f.access('staff');const pending=await f.save({},'staff');assert.equal(pending.response.status,202);
 const sql=`INSERT INTO public.finance_exchange_rates(academy_id,id,base_currency_id,base_currency_version,quote_currency_id,quote_currency_version,rate_on,state,rate,rate_numerator,rate_denominator,source,reference,reason,approval_id,created_by) SELECT academy_id,target_id,(payload#>>'{base,id}')::uuid,1,(payload#>>'{quote,id}')::uuid,1,(payload->>'on')::date,'recorded',payload->>'rate',$3,100,payload->>'source',payload->>'reference',payload->>'reason',id,$2 FROM public.approval_requests WHERE id=$1`;
 for(const [numerator,expected] of [['136',/EXACT_RATIO_REQUIRED/],['135',/APPROVAL_NOT_APPLIED|CRITICAL_AUDIT_REQUIRED/]] as const){await f.pg.exec('BEGIN');try{
  await f.pg.query("SELECT set_config('app.academy_id',$1,true)",[f.a]);await f.pg.exec('SET LOCAL ROLE kavosh_runtime');
  if(numerator==='136')await assert.rejects(f.pg.query(sql,[pending.body.approval.id,f.actors.master.person,numerator]),expected);
  else{await f.pg.query(sql,[pending.body.approval.id,f.actors.master.person,numerator]);await assert.rejects(f.pg.exec('COMMIT'),expected);}
 }finally{await f.pg.exec('ROLLBACK');}}
 assert.equal((await f.pg.query('SELECT * FROM public.finance_exchange_rates')).rows.length,0);assert.equal((await f.approve(pending.body.approval.id)).response.status,200);
 await f.pg.exec('SET ROLE kavosh_runtime');try{await f.pg.query("SELECT set_config('app.academy_id',$1,false)",[f.a]);await assert.rejects(f.pg.exec('UPDATE public.finance_exchange_rates SET rate=\'2\''),/permission denied/i);await assert.rejects(f.pg.exec('DELETE FROM public.finance_exchange_rates'),/permission denied/i);await f.pg.query("SELECT set_config('app.academy_id',$1,false)",[f.b]);assert.equal((await f.pg.query('SELECT * FROM public.finance_exchange_rates')).rows.length,0);}finally{await f.pg.exec('RESET ROLE');}
});
if(process.env.TEST_DATABASE_URL)check('brief competing quote roots and corrections retain exactly one accepted successor',async f=>{
 const started=performance.now(),roots=await Promise.all([f.save(),f.save()]);assert.deepEqual(roots.map(r=>r.response.status).sort(),[201,409]);
 const root=roots.find(r=>r.response.status===201)!.body.data.id,changes=await Promise.all(['1.2','1.3'].map(rate=>f.save({supersedesId:root,rate})));assert.deepEqual(changes.map(r=>r.response.status).sort(),[201,409]);assert.equal((await f.pg.query('SELECT * FROM public.finance_exchange_rates')).rows.length,2);
 console.log(JSON.stringify({measurement:'brief-reference-rate-conflict',requests:4,elapsedMs:Math.ceil(performance.now()-started)}));
});
