import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { operationsFixture } from './operations-fixture.ts';
import { formatMoney,formatMoneyTotal,maximumMinorUnits } from '../src/core/money.ts';
import { trialBalanceSQL } from '../src/modules/financial-reports.ts';

const capabilities=['financial-reports.view','ledger.view','accounts.view'] as const;
async function fixture(){
  const f=await operationsFixture();for(const role of [f.managerRole,f.staffRole])for(const cap of capabilities)await f.pg.query("INSERT INTO public.role_permissions VALUES($1,$2,$3,'allow')",[f.a,role,cap]);
  const currency=await f.request('finance/currencies',{code:'CAD',name:'Canadian dollar',unitScale:2,reason:'Synthetic report currency'});assert.equal(currency.response.status,201);
  const period=await f.request('finance/periods',{name:'Synthetic year',startsOn:'2026-01-01',endsOn:'2026-12-31',reason:'Synthetic report year'});assert.equal(period.response.status,201);
  const account=async(code:string,patch:Record<string,unknown>={})=>{const a=await f.request('finance/accounts',{code,name:'Synthetic '+code,kind:'asset',hubId:f.hub,currencyId:currency.body.data.id,currencyVersion:1,reason:'Synthetic report account',...patch});assert.equal(a.response.status,201,JSON.stringify(a.body));return a.body.data;};
  const cash=await account('1000'),equity=await account('3000',{kind:'equity'}),base={periodId:period.body.data.id,periodVersion:1,postedOn:'2026-06-01',description:'Synthetic private report source',reason:'Synthetic manual report source'};
  const post=(patch:Record<string,unknown>={})=>f.request('finance/journals',{...base,lines:[{accountId:cash.id,accountVersion:1,side:'debit',amount:'100.00',note:'Private debit note'},{accountId:equity.id,accountVersion:1,side:'credit',amount:'100.00'}],...patch});
  const report=(query='through=2026-12-31',as='master')=>f.request('reports/finance/trial-balance?'+query,undefined,as);
  const role=async(name:string,caps:readonly string[],effect='allow')=>{const r=await f.request('roles',{name,permissions:caps.map(capability=>({capability,effect}))});assert.equal(r.response.status,201);return r.body.data.id;};
  const assign=async(assignments:unknown[])=>{const before=(await f.request('people/'+f.actors.staff.person+'/access')).body.data;const r=await f.request('people/'+f.actors.staff.person+'/access',{expectedVersion:before.version,assignments});assert.equal(r.response.status,200,JSON.stringify(r.body));};
  return {...f,account,cash,equity,currency:currency.body.data,period:period.body.data,base,post,report,role,assign};
}
type Fixture=Awaited<ReturnType<typeof fixture>>;
function check(name:string,run:(f:Fixture)=>Promise<void>){test(name,async()=>{const f=await fixture();try{await run(f);}finally{await f.pg.close();}});}
check('posted trial balance derives nonzero account balances and independent currency totals from actual dated journals',async f=>{
  const empty=await f.report();assert.equal(empty.response.status,200,JSON.stringify(empty.body));assert.equal(empty.body.data.accountCount,0);assert.deepEqual(empty.body.data.currencies,[]);
  assert.equal((await f.post()).response.status,201);const r=await f.report();assert.equal(r.response.status,200,JSON.stringify(r.body));const data=r.body.data;
  assert.equal(data.report,'posted_trial_balance');assert.equal(data.coverage,'complete_selected_currencies');assert.equal(data.scopeMayOmitCounterparties,false);assert.equal(data.chartBasis,'current_account_metadata');assert.equal(data.currencyConversion,'none');assert.equal(data.accountCount,2);
  assert.deepEqual(data.entries.map((a:{kind:string})=>a.kind),['asset','equity']);assert.equal(data.entries[0].debit.amount,'100.00');assert.equal(data.entries[1].credit.amount,'100.00');assert.equal(data.currencies[0].balanced,true);assert.equal(data.currencies[0].debit.minor,'10000');assert.equal(data.currencies[0].credit.minor,'10000');assert.equal(data.currencies[0].difference.amount,'0.00');assert.ok(data.snapshotAt);
  assert.equal((await f.report('through=2026-05-31')).body.data.accountCount,0);assert.equal((await f.report('through=2026-06-01')).body.data.accountCount,2);
  for(const secret of ['Synthetic private report source','Private debit note'])assert.ok(!JSON.stringify(r.body).includes(secret));
});
check('scoped cross-hub reports retain own-account amounts and explicitly identify incomplete counterparties without exposing other hubs',async f=>{
  const other=await f.account('1000',{hubId:f.otherHub});assert.equal((await f.post({lines:[{accountId:f.cash.id,accountVersion:1,side:'debit',amount:'100.00'},{accountId:other.id,accountVersion:1,side:'credit',amount:'100.00'}]})).response.status,201);
  const r=await f.report('through=2026-12-31','staff');assert.equal(r.response.status,200);assert.equal(r.body.data.coverage,'scoped_selected_accounts');assert.equal(r.body.data.scopeMayOmitCounterparties,true);assert.equal(r.body.data.accountCount,1);assert.equal(r.body.data.entries[0].accountId,f.cash.id);assert.equal(r.body.data.currencies[0].balanced,false);assert.equal(r.body.data.currencies[0].difference.amount,'100.00');assert.ok(!JSON.stringify(r.body).includes(other.id));
  assert.equal((await f.report('through=2026-12-31&hubIds='+f.otherHub,'staff')).body.data.accountCount,0);assert.equal((await f.report('through=2026-12-31&accountIds='+other.id,'staff')).body.data.accountCount,0);
  assert.equal((await f.request('reports/finance/trial-balance?through=2026-12-31',undefined,'foreignMaster',{academy:f.b})).body.data.accountCount,0);
});
check('report permission cannot replace account or ledger rights and different selected-hub grants intersect rather than combine',async f=>{
  await f.post();for(const cap of capabilities){await f.pg.query('DELETE FROM public.role_permissions WHERE role_id=$1 AND capability=$2',[f.staffRole,cap]);assert.equal((await f.report('through=2026-12-31','staff')).response.status,403);await f.pg.query("INSERT INTO public.role_permissions VALUES($1,$2,$3,'allow')",[f.a,f.staffRole,cap]);}
  const reports=await f.role('Selected reports',['financial-reports.view']),ledger=await f.role('Other hub ledger',['ledger.view']),accounts=await f.role('Broad account directory',['accounts.view']);
  await f.assign([{roleId:reports,allHubs:false,hubIds:[f.hub]},{roleId:ledger,allHubs:false,hubIds:[f.otherHub]},{roleId:accounts,allHubs:true}]);
  const intersection=await f.report('through=2026-12-31&includeZero=true','staff');assert.equal(intersection.response.status,200);assert.equal(intersection.body.data.accountCount,0);assert.deepEqual(intersection.body.data.currencies,[]);
});
check('denial precedence removes hidden hub and global accounts before totals and pagination, including an empty denied country',async f=>{
  const other=await f.account('1000',{hubId:f.otherHub}),global=await f.account('1000',{hubId:null});await f.post({lines:[{accountId:f.cash.id,accountVersion:1,side:'debit',amount:'100.00'},{accountId:other.id,accountVersion:1,side:'credit',amount:'100.00'}]});
  const allow=await f.role('Broad reports',capabilities),deny=await f.role('Denied report hub',['financial-reports.view'],'deny');await f.assign([{roleId:allow,allHubs:true},{roleId:deny,allHubs:false,hubIds:[f.hub]}]);
  const report=await f.report('through=2026-12-31&includeZero=true','staff');assert.equal(report.body.data.accountCount,1);assert.equal(report.body.data.entries[0].accountId,other.id);assert.equal(report.body.data.currencies[0].difference.amount,'-100.00');assert.ok(!JSON.stringify(report.body).includes(global.id));
  const country=await f.request('locations/countries',{code:'US',name:'Empty denied country'});assert.equal(country.response.status,201);
  await f.assign([{roleId:allow,allHubs:true},{roleId:deny,allHubs:false,countryIds:[country.body.data.id]}]);const area=await f.report('through=2026-12-31&includeZero=true','staff');assert.equal(area.response.status,200);assert.equal(area.body.data.accountCount,3);assert.equal(area.body.data.scopeMayOmitCounterparties,true);assert.ok(!area.body.data.entries.some((a:{accountId:string})=>a.accountId===global.id));
});
check('trial-balance currency sums normalize pinned precision exactly and never combine different currency identities',async f=>{
  await f.request('finance/currencies/'+f.currency.id+'/change',{expectedVersion:1,unitScale:3,reason:'Synthetic precision change'});const newer=await f.account('1100',{currencyVersion:2,kind:'liability'});
  assert.equal((await f.post({lines:[{accountId:f.cash.id,accountVersion:1,side:'debit',amount:'1.00'},{accountId:newer.id,accountVersion:1,side:'credit',amount:'1.000'}]})).response.status,201);
  const usd=await f.request('finance/currencies',{code:'USD',name:'US dollar',unitScale:2,reason:'Synthetic separate currency'}),debit=await f.account('1200',{currencyId:usd.body.data.id}),credit=await f.account('2200',{currencyId:usd.body.data.id,kind:'liability'});
  assert.equal((await f.post({lines:[{accountId:debit.id,accountVersion:1,side:'debit',amount:'7.89'},{accountId:credit.id,accountVersion:1,side:'credit',amount:'7.89'}]})).response.status,201);
  const r=await f.report();assert.equal(r.response.status,200);assert.equal(r.body.data.currencies.length,2);const cad=r.body.data.currencies.find((c:{currencyCode:string})=>c.currencyCode==='CAD');assert.equal(cad.unitScale,3);assert.equal(cad.debit.minor,'1000');assert.equal(cad.credit.amount,'1.000');assert.equal(cad.balanced,true);assert.equal(r.body.data.currencies.find((c:{currencyCode:string})=>c.currencyCode==='USD').debit.amount,'7.89');
  const filtered=await f.report('through=2026-12-31&currencyIds='+usd.body.data.id);assert.equal(filtered.body.data.coverage,'complete_selected_currencies');assert.equal(filtered.body.data.currencies.length,1);assert.equal(filtered.body.data.accountCount,2);
});
check('report pages use account-kind/code/id order while totals stay complete; explicit multi-selection filters remain scoped',async f=>{
  await f.post();await f.account('0500');await f.account('2000',{kind:'liability'});await f.account('4000',{kind:'income'});await f.account('5000',{kind:'expense'});
  const first=await f.report('through=2026-12-31&includeZero=true&limit=1');assert.equal(first.body.data.accountCount,6);assert.equal(first.body.data.entries[0].code,'0500');assert.equal(first.body.data.currencies[0].debit.amount,'100.00');
  const second=await f.report('through=2026-12-31&includeZero=true&limit=1&'+new URLSearchParams(first.body.nextCursor));assert.equal(second.body.data.entries[0].code,'1000');assert.equal(second.body.data.currencies[0].debit.amount,'100.00');assert.equal(second.body.data.accountCount,6);
  const selected=await f.report('through=2026-12-31&accountIds='+[f.cash.id,f.equity.id].join(',')+'&hubIds='+[f.hub,f.otherHub].join(','));assert.equal(selected.body.data.accountCount,2);assert.equal(selected.body.data.scopeMayOmitCounterparties,true);assert.equal(selected.body.data.currencies[0].balanced,true);
});
check('report balances preserve reversals and retired accounts; current metadata is labelled rather than rewriting posted amounts',async f=>{
  const translations={en:'Cash account',fr:'Caisse','zh-CN':'现金账户'},posted=await f.post();await f.request('finance/accounts/'+f.cash.id+'/change',{expectedVersion:1,name:'Corrected chart label',translations,normalBalance:'credit',active:false,reason:'Synthetic chart correction'});
  const before=await f.report();assert.equal(before.body.data.entries[0].name,'Corrected chart label');assert.deepEqual(before.body.data.entries[0].translations,translations);assert.equal(before.body.data.entries[0].chartVersion,2);assert.equal(before.body.data.entries[0].debit.amount,'100.00');
  assert.equal((await f.request('finance/journals/'+posted.body.data.id+'/reverse',{...f.base,postedOn:'2026-07-01'})).response.status,201);assert.equal((await f.report('through=2026-06-30')).body.data.accountCount,2);assert.equal((await f.report()).body.data.accountCount,0);assert.equal((await f.report('through=2026-12-31&includeZero=true')).body.data.accountCount,2);
});
check('large trial-balance rows and currency totals remain decimal strings beyond Number safety and individual posting limits',async f=>{
  const amount=formatMoney(maximumMinorUnits,2),lines=[{accountId:f.cash.id,accountVersion:1,side:'debit',amount},{accountId:f.equity.id,accountVersion:1,side:'credit',amount}];assert.equal((await f.post({lines})).response.status,201);assert.equal((await f.post({lines})).response.status,201);
  const r=await f.report(),total=2n*maximumMinorUnits;assert.equal(r.body.data.currencies[0].debit.minor,total.toString());assert.equal(r.body.data.currencies[0].debit.amount,formatMoneyTotal(total,2));assert.equal(r.body.data.entries[0].closing.minor,total.toString());assert.equal(r.body.data.currencies[0].balanced,true);
});
check('financial reports reject malformed filters and partial cursors and cannot mutate or accept guessed report dates',async f=>{
  for(const query of ['', 'through=2026-02-30','through=2026-12-31&hubIds=','through=2026-12-31&accountIds='+f.cash.id+','+f.cash.id,'through=2026-12-31&currencyIds=not-an-id','through=2026-12-31&limit=101','through=2026-12-31&afterKind=asset','through=2026-12-31&sort=arbitrary'])assert.equal((await f.report(query)).response.status,400,query);
  assert.equal((await f.request('reports/finance/trial-balance',{through:'2026-12-31'})).response.status,405);
});
check('integral PostgreSQL numeric values with zero fractional scale remain readable and canonical across all financial views',async f=>{
  const initial=await f.post(),id=randomUUID();assert.equal(initial.response.status,201);await f.pg.exec('SET ROLE kavosh_runtime');try{
    await f.pg.query("SELECT set_config('app.academy_id',$1,false)",[f.a]);await f.pg.exec('BEGIN');try{
      await f.pg.query("INSERT INTO public.finance_journals(academy_id,id,period_id,period_version,posted_on,description,line_count,posted_by,approval_id) VALUES($1,$2,$3,1,'2026-06-01','Synthetic integral numeric representation',2,$4,$5)",[f.a,id,f.period.id,f.actors.master.person,initial.body.approval.id]);
      await f.pg.query("INSERT INTO public.finance_journal_lines(academy_id,journal_id,line_number,account_id,account_version,side,amount_minor) VALUES($1,$2,1,$3,1,'debit',10000.00),($1,$2,2,$4,1,'credit',10000)",[f.a,id,f.cash.id,f.equity.id]);await f.pg.exec('COMMIT');
    }catch(error){await f.pg.exec('ROLLBACK');throw error;}
  }finally{await f.pg.exec('RESET ROLE');}
  assert.equal((await f.pg.query<{value:string}>('SELECT amount_minor::text AS value FROM public.finance_journal_lines WHERE journal_id=$1 AND line_number=1',[id])).rows[0].value,'10000.00');
  const journal=await f.request('finance/journals/'+id),balance=await f.request('finance/accounts/'+f.cash.id+'/balance?through=2026-12-31'),ledger=await f.request('finance/accounts/'+f.cash.id+'/ledger?through=2026-12-31'),report=await f.report();
  assert.deepEqual([journal,balance,ledger,report].map(r=>r.response.status),[200,200,200,200]);assert.equal(journal.body.data.lines[0].amountMinor,'10000');assert.equal(balance.body.data.closing.minor,'20000');assert.ok(ledger.body.data.entries.every((l:{amountMinor:string})=>l.amountMinor==='10000'));assert.equal(report.body.data.currencies[0].debit.minor,'20000');assert.equal(report.body.data.currencies[0].balanced,true);
  const reversed=await f.request('finance/journals/'+id+'/reverse',{...f.base,postedOn:'2026-07-01'});assert.equal(reversed.response.status,201,JSON.stringify(reversed.body));assert.equal(reversed.body.data.lines[0].amountMinor,'10000');assert.equal((await f.report()).body.data.currencies[0].debit.minor,'10000');
  assert.equal((await f.pg.query<{value:string}>('SELECT amount_minor::text AS value FROM public.finance_journal_lines WHERE journal_id=$1 AND line_number=1',[id])).rows[0].value,'10000.00');
});
if(process.env.TEST_DATABASE_URL)check('five thousand accounts and journals reconcile under one hundred parallel same-snapshot trial-balance requests',async f=>{
  const initial=await f.post();assert.equal(initial.response.status,201);await f.pg.exec('BEGIN');try{
    await f.pg.exec('CREATE TEMP TABLE synthetic_report_accounts AS SELECT gen_random_uuid() AS id,n FROM generate_series(1,4998) n');
    await f.pg.query(`INSERT INTO public.finance_accounts(academy_id,id,hub_id,currency_id,currency_version,code,created_by) SELECT $1,s.id,$2,$3,1,'AC'||lpad(s.n::text,5,'0'),$4 FROM synthetic_report_accounts s`,[f.a,f.hub,f.currency.id,f.actors.master.person]);
    await f.pg.query(`INSERT INTO public.finance_account_revisions(academy_id,account_id,version,code,name,description,kind,normal_balance,active,changed_by,approval_id,reason) SELECT $1,s.id,1,'AC'||lpad(s.n::text,5,'0'),'Synthetic report account '||s.n,'','asset','debit',true,$2,$3,'Synthetic report load setup' FROM synthetic_report_accounts s`,[f.a,f.actors.master.person,initial.body.approval.id]);
    await f.pg.exec('CREATE TEMP TABLE synthetic_report_journals AS SELECT gen_random_uuid() AS id,n FROM generate_series(1,4999) n');
    await f.pg.query(`INSERT INTO public.finance_journals(academy_id,id,period_id,period_version,posted_on,description,line_count,posted_by,approval_id) SELECT $1,s.id,$2,1,'2026-06-01','Synthetic report load journal',2,$3,$4 FROM synthetic_report_journals s`,[f.a,f.period.id,f.actors.master.person,initial.body.approval.id]);
    await f.pg.query(`INSERT INTO public.finance_journal_lines(academy_id,journal_id,line_number,account_id,account_version,side,amount_minor)
     SELECT $1,j.id,l.n,CASE WHEN l.n=2 THEN $2::uuid ELSE coalesce(a.id,$3::uuid) END,1,CASE WHEN l.n=1 THEN 'debit' ELSE 'credit' END,10000
     FROM synthetic_report_journals j LEFT JOIN synthetic_report_accounts a ON a.n=j.n CROSS JOIN generate_series(1,2) l(n)`,[f.a,f.equity.id,f.cash.id]);await f.pg.exec('COMMIT');
  }catch(error){await f.pg.exec('ROLLBACK');throw error;}
  const before=f.metrics.businessQueries,durations:number[]=[];await Promise.all(Array.from({length:100},async()=>{const start=performance.now(),r=await f.report('through=2026-12-31&limit=100','staff');durations.push(performance.now()-start);assert.equal(r.response.status,200,JSON.stringify({response:r.body,queryFailures:f.metrics.queryFailures}));assert.equal(r.body.data.accountCount,5000);assert.equal(r.body.data.entries.length,100);assert.equal(r.body.data.currencies[0].debit.minor,'50000000');assert.equal(r.body.data.currencies[0].credit.minor,'50000000');assert.equal(r.body.data.currencies[0].balanced,true);assert.equal(r.body.data.coverage,'scoped_selected_accounts');assert.ok(r.body.nextCursor);}));
  const queries=f.metrics.businessQueries-before;assert.equal(queries,1200);console.log(JSON.stringify({measurement:'synthetic-posted-trial-balance',accounts:5000,journals:5000,postedLines:10000,concurrentRequests:100,principals:1,poolMaximum:4,validatedResponses:100,rowsPerResponse:100,p99Ms:Math.ceil(durations.sort((a,b)=>a-b)[98]),clientQueries:queries,bankRequests:0}));
  // Profile after the measured workload, not as a warm-up. The failed query
  // discarded12.5 million join pairs; keep a generous non-quadratic budget
  // without depending on a particular planner operator or exact timing.
  type Plan={'Rows Removed by Join Filter'?:number;'Actual Loops'?:number;Plans?:Plan[]};
  await f.pg.exec('SET ROLE kavosh_runtime');try{
    await f.pg.query("SELECT set_config('app.academy_id',$1,false),set_config('statement_timeout','5000',false)",[f.a]);
    const plan=(await f.pg.query<{'QUERY PLAN':{Plan:Plan;'Execution Time':number}[]}>('EXPLAIN(ANALYZE,BUFFERS,TIMING OFF,FORMAT JSON) '+trialBalanceSQL,[false,[f.hub],[],false,'2026-12-31',null,null,null,false,null,null,null,101])).rows[0]['QUERY PLAN'][0];
    const rejected=(n:Plan):number=>(n['Rows Removed by Join Filter']??0)*(n['Actual Loops']??1)+(n.Plans??[]).reduce((total,p)=>total+rejected(p),0),pairs=rejected(plan.Plan);assert.ok(pairs<500000,'must not rescan a whole grouped account set for each account');
    console.log(JSON.stringify({measurement:'trial-balance-plan-after-load',accounts:5000,rejectedJoinPairs:pairs,executionMs:Math.ceil(plan['Execution Time']),productionStatementLimitMs:5000}));
  }finally{await f.pg.exec('RESET ROLE');await f.pg.exec('RESET statement_timeout');await f.pg.exec('RESET app.academy_id');}
});
