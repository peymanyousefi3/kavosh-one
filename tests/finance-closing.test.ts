import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { operationsFixture } from './operations-fixture.ts';
import { maximumMinorUnits,formatMoney } from '../src/core/money.ts';
import { closingSourceSQL } from '../src/modules/finance-closing.ts';

const caps=['closing.view','periods.view','accounts.view','journals.view','ledger.view','financial-reports.view'];
async function fixture(){
 const f=await operationsFixture();for(const role of [f.managerRole,f.staffRole])for(const cap of caps)await f.pg.query("INSERT INTO public.role_permissions VALUES($1,$2,$3,'allow')",[f.a,role,cap]);
 const currency=await f.request('finance/currencies',{code:'CAD',name:'Synthetic Canadian dollar',unitScale:2,reason:'Synthetic closing unit'});assert.equal(currency.response.status,201);
 const period=await f.request('finance/periods',{name:'Synthetic 2026',startsOn:'2026-01-01',endsOn:'2026-12-31',reason:'Synthetic closing period'});assert.equal(period.response.status,201);
 const account=async(code:string,kind:string,patch:Record<string,unknown>={})=>{const r=await f.request('finance/accounts',{code,name:'Synthetic '+code,kind,hubId:f.hub,currencyId:currency.body.data.id,currencyVersion:1,translations:{fr:'Compte '+code,'zh-CN':'账户 '+code},reason:'Synthetic closing account',...patch});assert.equal(r.response.status,201);return r.body.data;};
 const cash=await account('1000','asset'),equity=await account('3000','equity'),income=await account('4000','income'),expense=await account('5000','expense');
 const base={periodId:period.body.data.id,periodVersion:1,postedOn:'2026-06-01',description:'Synthetic private source description',reason:'Synthetic closing source reason'};
 const post=(debit:{id:string;version:number},credit:{id:string;version:number},amount='100.00',patch:Record<string,unknown>={})=>f.request('finance/journals',{...base,lines:[{accountId:debit.id,accountVersion:debit.version,side:'debit',amount,note:'Synthetic private source note'},{accountId:credit.id,accountVersion:credit.version,side:'credit',amount}],...patch});
 const preview=(query='',as='master')=>f.request('finance/periods/'+period.body.data.id+'/closing-preview'+(query?'?'+query:''),undefined,as);
 async function globalize(as='staff'){
  const role=as==='staff'?f.staffRole:f.managerRole;
  await f.pg.query('UPDATE public.role_assignments SET all_hubs=true WHERE role_id=$1',[role]);
 }
 return {...f,currency:currency.body.data,period:period.body.data,account,cash,equity,income,expense,base,post,preview,globalize};
}
type Fixture=Awaited<ReturnType<typeof fixture>>;
function check(name:string,run:(f:Fixture)=>Promise<void>){test(name,async()=>{const f=await fixture();try{await run(f);}finally{await f.pg.close();}});}
check('closing preview reconciles exact real source positions without generating journals, closing periods or exposing notes',async f=>{
 await f.post(f.cash,f.income,'100.00');await f.post(f.expense,f.cash,'30.00');
 const count=(await f.pg.query('SELECT count(*)::text AS n FROM public.audit_events')).rows[0].n;
 const r=await f.preview();assert.equal(r.response.status,200,JSON.stringify(r.body));const d=r.body.data;assert.equal(d.operation,'read_only_source_validation');assert.equal(d.sourceStamp.journals,'2');assert.equal(d.sourceLineCount,'4');assert.equal(d.temporaryGroupCount,'2');assert.deepEqual(d.blockers,[]);assert.equal(d.currencies[0].balanced,true);
 const income=d.entries.find((e:{postedKind:string})=>e.postedKind==='income'),expense=d.entries.find((e:{postedKind:string})=>e.postedKind==='expense');assert.equal(income.closingSide,'debit');assert.equal(income.closingAmount.amount,'100.00');assert.equal(expense.closingSide,'credit');assert.equal(expense.closingAmount.amount,'30.00');assert.equal(income.translations['zh-CN'],'账户 4000');
 for(const secret of ['Synthetic private source description','Synthetic private source note','Synthetic closing source reason'])assert.ok(!JSON.stringify(r.body).includes(secret));
 assert.equal((await f.preview()).body.data.snapshot,d.snapshot);assert.equal((await f.pg.query('SELECT count(*)::text AS n FROM public.audit_events')).rows[0].n,count);assert.equal((await f.request('finance/periods/'+f.period.id)).body.data.state,'open');
 for(const [debit,credit,amount] of [[f.income,f.equity,'100.00'],[f.equity,f.expense,'30.00']] as const)assert.equal((await f.post(debit,credit,amount,{purpose:'closing',postedOn:'2026-12-31'})).response.status,201);
 assert.equal((await f.preview()).body.data.temporaryGroupCount,'0');assert.equal((await f.preview()).body.data.sourceStamp.journals,'4');
});
check('closing cursors require a stable snapshot and reject even net-neutral postings or metadata changed back to its original value',async f=>{
 await f.post(f.cash,f.income);await f.post(f.expense,f.cash,'20.00');
 const first=await f.preview('limit=1');assert.equal(first.response.status,200);assert.ok(first.body.nextCursor);const second=await f.preview('limit=1&'+new URLSearchParams(first.body.nextCursor));assert.equal(second.response.status,200);assert.notEqual(second.body.data.entries[0].accountId,first.body.data.entries[0].accountId);assert.equal(second.body.data.snapshot,first.body.data.snapshot);assert.equal(second.body.nextCursor,null);
 const extra=await f.post(f.cash,f.income,'10.00');await f.request('finance/journals/'+extra.body.data.id+'/reverse',{...f.base,postedOn:'2026-06-02'});
 assert.equal((await f.preview('snapshot='+first.body.data.snapshot)).body.error.code,'CLOSING_SOURCE_CHANGED');
 const old=(await f.preview()).body.data.snapshot;
 await f.request('finance/accounts/'+f.income.id+'/change',{expectedVersion:1,name:'Temporary label',reason:'Synthetic label change'});await f.request('finance/accounts/'+f.income.id+'/change',{expectedVersion:2,name:'Synthetic 4000',reason:'Synthetic label restored'});
 assert.equal((await f.preview('snapshot='+old)).response.status,409);
 const beforePeriod=(await f.preview()).body.data.snapshot;await f.request('finance/periods/'+f.period.id+'/change',{expectedVersion:1,name:'New label',reason:'Synthetic period label'});assert.equal((await f.preview('snapshot='+beforePeriod)).response.status,409);
});
check('closing source includes earlier unclosed activity, identifies earlier open periods and ignores later-dated postings',async f=>{
 const previous=await f.request('finance/periods',{name:'Synthetic 2025',startsOn:'2025-01-01',endsOn:'2025-12-31',reason:'Synthetic prior period'});assert.equal(previous.response.status,201);
 await f.post(f.cash,f.income,'50.00',{periodId:previous.body.data.id,postedOn:'2025-06-01'});await f.post(f.cash,f.income);
 const open=await f.preview();assert.equal(open.body.data.entries[0].closingAmount.amount,'150.00');assert.deepEqual(open.body.data.blockers,['EARLIER_OPEN_PERIOD']);
 await f.request('finance/periods/'+previous.body.data.id+'/change',{expectedVersion:1,state:'closed',reason:'Synthetic prior administrative close'});assert.deepEqual((await f.preview()).body.data.blockers,[]);
 const future=await f.request('finance/periods',{name:'Synthetic 2027',startsOn:'2027-01-01',endsOn:'2027-12-31',reason:'Synthetic later period'});assert.equal(future.response.status,201);const snapshot=(await f.preview()).body.data.snapshot;
 await f.post(f.cash,f.income,'40.00',{periodId:future.body.data.id,postedOn:'2027-06-01'});const unchanged=await f.preview('snapshot='+snapshot);assert.equal(unchanged.response.status,200);assert.equal(unchanged.body.data.sourceStamp.journals,'2');
 await f.request('finance/periods/'+f.period.id+'/change',{expectedVersion:1,state:'closed',reason:'Synthetic closed-state preview'});assert.ok((await f.preview()).body.data.blockers.includes('PERIOD_NOT_OPEN'));
});
check('inactive and reclassified temporary sources require review and same-account historical groups page independently',async f=>{
 await f.post(f.cash,f.income);
 await f.request('finance/accounts/'+f.income.id+'/change',{expectedVersion:1,active:false,reason:'Synthetic retired account'});assert.deepEqual((await f.preview()).body.data.blockers,['INACTIVE_TEMPORARY_ACCOUNT']);
 const changed=await f.request('finance/accounts/'+f.income.id+'/change',{expectedVersion:2,active:true,kind:'expense',reason:'Synthetic prospective kind'});assert.equal(changed.response.status,200);await f.post(changed.body.data,f.cash,'30.00');
 const first=await f.preview('limit=1');assert.deepEqual(first.body.data.blockers,['HISTORICAL_KIND_REVIEW_REQUIRED']);assert.equal(first.body.data.temporaryGroupCount,'2');const next=await f.preview('limit=1&'+new URLSearchParams(first.body.nextCursor));assert.equal(next.body.data.entries[0].accountId,first.body.data.entries[0].accountId);assert.notEqual(next.body.data.entries[0].postedKind,first.body.data.entries[0].postedKind);assert.equal(next.body.nextCursor,null);
});
check('large and multi-precision closing amounts stay exact, flag required splitting and never invent currency conversion',async f=>{
 const large=formatMoney(maximumMinorUnits,2);await f.post(f.cash,f.income,large);await f.post(f.cash,f.income,large);
 await f.request('finance/currencies/'+f.currency.id+'/change',{expectedVersion:1,unitScale:3,reason:'Synthetic precision revision'});const finer=await f.account('4100','income',{currencyVersion:2});await f.post(f.cash,finer,'1.00');
 const usd=await f.request('finance/currencies',{code:'USD',name:'Synthetic USD',unitScale:0,reason:'Synthetic distinct currency'}),cash=await f.account('1100','asset',{currencyId:usd.body.data.id}),income=await f.account('4200','income',{currencyId:usd.body.data.id});await f.post(cash,income,'123');
 const r=await f.preview();assert.equal(r.response.status,200,JSON.stringify(r.body));assert.equal(r.body.data.currencies.length,2);assert.ok(r.body.data.currencies.every((c:{balanced:boolean})=>c.balanced));const huge=r.body.data.entries.find((e:{accountId:string})=>e.accountId===f.income.id);assert.equal(huge.closingAmount.minor,(2n*maximumMinorUnits).toString());assert.equal(huge.requiresSplit,true);assert.equal(r.body.data.entries.find((e:{accountId:string})=>e.accountId===finer.id).closingAmount.amount,'1.000');
});
check('unknown legacy purposes remain blockers even when every source position nets to zero',async f=>{
 const original=await f.post(f.cash,f.income);await f.request('finance/journals/'+original.body.data.id+'/reverse',{...f.base,postedOn:'2026-06-02'});
 // Test-owner simulation of old rows. Actual schema31 migration preservation
 // and runtime immutability are independently covered by statement tests.
 await f.pg.exec("UPDATE public.finance_journals SET purpose='legacy_unclassified'");
 const r=await f.preview();assert.equal(r.body.data.unclassifiedLineCount,'4');assert.equal(r.body.data.temporaryGroupCount,'0');assert.deepEqual(r.body.data.blockers,['LEGACY_PURPOSE_REVIEW_REQUIRED']);
});
check('closing sources require complete current rights for every feature, honor bot ceilings and never reveal another academy',async f=>{
 await f.post(f.cash,f.income);assert.equal((await f.preview('','staff')).response.status,403);await f.globalize();assert.equal((await f.preview('','staff')).response.status,200);
 await f.pg.query("DELETE FROM public.role_permissions WHERE role_id=$1 AND capability='accounts.view'",[f.staffRole]);assert.equal((await f.preview('','staff')).response.status,403);assert.equal((await f.request('finance/periods/'+randomUUID()+'/closing-preview',undefined,'staff')).response.status,403);
 assert.equal((await f.request('finance/periods/'+f.period.id+'/closing-preview',undefined,'foreignMaster',{academy:f.b})).response.status,404);
 await f.globalize('manager');assert.equal((await f.preview('','bot')).response.status,200);
 await f.pg.query('UPDATE auth_private.credentials SET all_hubs=false WHERE id=$1',[f.credential]);await f.pg.query('INSERT INTO auth_private.credential_hubs(academy_id,credential_id,hub_id) VALUES($1,$2,$3)',[f.a,f.credential,f.hub]);assert.equal((await f.preview('','bot')).response.status,403);
});
check('closing preview rejects forged filters, partial or unbound cursors, mutations and stale hashes without changing data',async f=>{
 for(const q of ['limit=101','hubIds='+f.hub,'snapshot=bad','afterKind=income','afterCode=4000&afterId='+f.income.id+'&afterKind=income','snapshot='+'0'.repeat(64)+'&extra=true'])assert.equal((await f.preview(q)).response.status,400,q);
 assert.equal((await f.preview('snapshot='+'0'.repeat(64))).response.status,409);assert.equal((await f.request('finance/periods/'+f.period.id+'/closing-preview',{generate:true})).response.status,405);assert.equal((await f.request('finance/periods/'+randomUUID()+'/closing-preview')).response.status,404);
 await f.pg.query("UPDATE public.academies SET status='read_only' WHERE id=$1",[f.a]);assert.equal((await f.preview()).response.status,200);assert.equal((await f.request('finance/journals')).body.data.length,0);
});
if(process.env.TEST_DATABASE_URL)check('concurrent real postings cannot mix closing-source stamps, line counts and balances from different snapshots',async f=>{
 await f.post(f.cash,f.income);const baseline=(await f.preview()).body.data.snapshot;
 await Promise.all(Array.from({length:40},async(_,i)=>{
  if(i%2===0){const posted=await f.post(f.cash,f.income);assert.equal(posted.response.status,201,JSON.stringify(posted.body));return;}
  const r=await f.preview();assert.equal(r.response.status,200,JSON.stringify(r.body));const count=BigInt(r.body.data.sourceStamp.journals);assert.equal(r.body.data.sourceLineCount,(count*2n).toString());assert.equal(r.body.data.entries[0].closingAmount.minor,(count*10000n).toString());assert.equal(r.body.data.currencies[0].balanced,true);
 }));
 assert.equal((await f.preview()).body.data.sourceStamp.journals,'21');assert.equal((await f.preview('snapshot='+baseline)).response.status,409);
});
if(process.env.TEST_DATABASE_URL)check('five thousand closing accounts and journals support one hundred complete-source previews with bounded pages and consistent stamps',async f=>{
 await f.globalize();const initial=await f.post(f.cash,f.income);assert.equal(initial.response.status,201);
 await f.pg.exec('BEGIN');try{
  await f.pg.exec('CREATE TEMP TABLE synthetic_closing_accounts AS SELECT gen_random_uuid() AS id,n FROM generate_series(1,4996) n');
  await f.pg.query("INSERT INTO public.finance_accounts(academy_id,id,hub_id,currency_id,currency_version,code,created_by) SELECT $1,id,$2,$3,1,'C'||lpad(n::text,5,'0'),$4 FROM synthetic_closing_accounts",[f.a,f.hub,f.currency.id,f.actors.master.person]);
  await f.pg.query("INSERT INTO public.finance_account_revisions(academy_id,account_id,version,code,name,description,kind,normal_balance,active,changed_by,approval_id,reason) SELECT $1,id,1,'C'||lpad(n::text,5,'0'),'Synthetic closing account','','income','credit',true,$2,$3,'Synthetic load evidence' FROM synthetic_closing_accounts",[f.a,f.actors.master.person,initial.body.approval.id]);
  await f.pg.exec('CREATE TEMP TABLE synthetic_closing_journals AS SELECT gen_random_uuid() AS id,n FROM generate_series(1,4999) n');
  await f.pg.query("INSERT INTO public.finance_journals(academy_id,id,period_id,period_version,posted_on,description,line_count,posted_by,approval_id) SELECT $1,id,$2,1,'2026-06-01','Synthetic closing load',2,$3,$4 FROM synthetic_closing_journals",[f.a,f.period.id,f.actors.master.person,initial.body.approval.id]);
  await f.pg.query("INSERT INTO public.finance_journal_lines(academy_id,journal_id,line_number,account_id,account_version,side,amount_minor) SELECT $1,j.id,l.n,CASE WHEN l.n=1 THEN $2::uuid ELSE a.id END,1,CASE WHEN l.n=1 THEN 'debit' ELSE 'credit' END,10000 FROM synthetic_closing_journals j JOIN synthetic_closing_accounts a ON a.n=(j.n-1)%4996+1 CROSS JOIN generate_series(1,2) l(n)",[f.a,f.cash.id]);await f.pg.exec('COMMIT');
 }catch(error){await f.pg.exec('ROLLBACK');throw error;}
 const before=f.metrics.businessQueries,durations:number[]=[],snapshots=new Set<string>();
 await Promise.all(Array.from({length:100},async()=>{const start=performance.now(),r=await f.preview('limit=100','staff');durations.push(performance.now()-start);assert.equal(r.response.status,200,JSON.stringify({body:r.body,failures:f.metrics.queryFailures}));assert.equal(r.body.data.sourceStamp.journals,'5000');assert.equal(r.body.data.sourceStamp.chartVersions,'5000');assert.equal(r.body.data.sourceLineCount,'10000');assert.equal(r.body.data.temporaryGroupCount,'4997');assert.equal(r.body.data.entries.length,100);assert.deepEqual(r.body.data.blockers,[]);assert.equal(r.body.data.currencies[0].debit.minor,'50000000');assert.equal(r.body.data.currencies[0].credit.minor,'50000000');assert.ok(r.body.nextCursor);snapshots.add(r.body.data.snapshot);}));
 const queries=f.metrics.businessQueries-before;assert.equal(queries,1200);assert.equal(snapshots.size,1);console.log(JSON.stringify({measurement:'synthetic-closing-source-preview',accounts:5000,journals:5000,postedLines:10000,concurrentRequests:100,principals:1,poolMaximum:4,validatedResponses:100,rowsPerResponse:100,distinctSnapshots:snapshots.size,p99Ms:Math.ceil(durations.sort((a,b)=>a-b)[98]),clientQueries:queries,closingWrites:0,bankRequests:0}));
 type Plan={'Rows Removed by Join Filter'?:number;'Actual Loops'?:number;Plans?:Plan[]};
 await f.pg.exec('SET ROLE kavosh_runtime');try{
  await f.pg.query("SELECT set_config('app.academy_id',$1,false),set_config('statement_timeout','5000',false)",[f.a]);
  const plan=(await f.pg.query<{'QUERY PLAN':{Plan:Plan;'Execution Time':number}[]}>('EXPLAIN(ANALYZE,BUFFERS,TIMING OFF,FORMAT JSON) '+closingSourceSQL,[f.period.id,null,null,null,101])).rows[0]['QUERY PLAN'][0],rejected=(n:Plan):number=>(n['Rows Removed by Join Filter']??0)*(n['Actual Loops']??1)+(n.Plans??[]).reduce((sum,p)=>sum+rejected(p),0),pairs=rejected(plan.Plan);assert.ok(pairs<500000,'closing source must not rescan whole grouped account sets per row');console.log(JSON.stringify({measurement:'closing-source-plan-after-load',accounts:5000,rejectedJoinPairs:pairs,executionMs:Math.ceil(plan['Execution Time']),productionStatementLimitMs:5000}));
 }finally{await f.pg.exec('RESET ROLE');await f.pg.exec('RESET statement_timeout');await f.pg.exec('RESET app.academy_id');}
});
