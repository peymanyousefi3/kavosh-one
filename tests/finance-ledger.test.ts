import assert from 'node:assert/strict';
import { test } from 'node:test';
import { operationsFixture } from './operations-fixture.ts';
import { formatMoney,formatMoneyTotal,maximumMinorUnits } from '../src/core/money.ts';

async function fixture(){
  const f=await operationsFixture();
  for(const role of [f.managerRole,f.staffRole])for(const capability of ['accounts.view','ledger.view'])await f.pg.query("INSERT INTO public.role_permissions VALUES($1,$2,$3,'allow')",[f.a,role,capability]);
  const c=await f.request('finance/currencies',{code:'CAD',name:'Canadian dollar',unitScale:2,reason:'Synthetic ledger units'});assert.equal(c.response.status,201);
  const p=await f.request('finance/periods',{name:'Synthetic 2026',startsOn:'2026-01-01',endsOn:'2026-12-31',reason:'Synthetic fiscal period'});assert.equal(p.response.status,201);
  const account=async(code:string,patch:Record<string,unknown>={})=>{const a=await f.request('finance/accounts',{code,name:'Synthetic '+code,kind:'asset',currencyId:c.body.data.id,currencyVersion:1,hubId:f.hub,reason:'Synthetic account',...patch});assert.equal(a.response.status,201);return a.body.data;};
  const cash=await account('1000'),equity=await account('3000',{kind:'equity'});
  const base={periodId:p.body.data.id,periodVersion:1,postedOn:'2026-06-01',description:'Synthetic journal private description',reason:'Synthetic manual entry'};
  const post=(patch:Record<string,unknown>={})=>f.request('finance/journals',{...base,lines:[{accountId:cash.id,accountVersion:1,side:'debit',amount:'100.00',note:'Synthetic private debit note'},{accountId:equity.id,accountVersion:1,side:'credit',amount:'100.00'}],...patch});
  const balance=(query='through=2026-12-31',as='master',id=cash.id)=>f.request('finance/accounts/'+id+'/balance?'+query,undefined,as);
  const ledger=(query='through=2026-12-31',as='master',id=cash.id)=>f.request('finance/accounts/'+id+'/ledger?'+query,undefined,as);
  return {...f,account,cash,equity,currency:c.body.data,period:p.body.data,base,post,balance,ledger};
}
type Fixture=Awaited<ReturnType<typeof fixture>>;
function check(name:string,run:(f:Fixture)=>Promise<void>){test(name,async()=>{const f=await fixture();try{await run(f);}finally{await f.pg.close();}});}
test('aggregate formatting preserves sums above a valid individual posting limit without allowing larger input postings',()=>{
  assert.equal(formatMoneyTotal(2n*maximumMinorUnits,2),'1999999999999999999999999999999999999.98');assert.equal(formatMoneyTotal(-2n*maximumMinorUnits,2),'-1999999999999999999999999999999999999.98');assert.throws(()=>formatMoney(2n*maximumMinorUnits,2),/INVALID_MONEY_AMOUNT/);assert.throws(()=>formatMoneyTotal(1n,19),/INVALID_CURRENCY_PRECISION/);assert.throws(()=>formatMoneyTotal(1 as unknown as bigint,2),/INVALID_MONEY_AMOUNT/);
});
check('account balances derive exact opening, movement and closing from dated postings; credits remain negative debit-net amounts',async f=>{
  const empty=await f.balance();assert.equal(empty.response.status,200);assert.equal(empty.body.data.closing.amount,'0.00');assert.equal(empty.body.data.lineCount,0);
  assert.equal((await f.post({postedOn:'2026-01-01'})).response.status,201);assert.equal((await f.post({postedOn:'2026-06-01'})).response.status,201);assert.equal((await f.post({postedOn:'2026-12-31'})).response.status,201);
  const balance=await f.balance('from=2026-06-01&through=2026-06-30');assert.equal(balance.response.status,200,JSON.stringify(balance.body));const b=balance.body.data;
  assert.equal(b.basis,'posted_account_lines');assert.equal(b.netConvention,'debits_minus_credits');assert.equal(b.opening.amount,'100.00');assert.equal(b.movement.amount,'100.00');assert.equal(b.closing.amount,'200.00');assert.equal(b.debits.minor,'10000');assert.equal(b.credits.minor,'0');assert.equal(b.lineCount,1);assert.equal(b.journalCount,1);
  assert.equal((await f.balance('through=2026-12-31','master',f.equity.id)).body.data.closing.amount,'-300.00');assert.equal((await f.balance('through=2025-12-31')).body.data.closing.amount,'0.00');
});
check('chronological composite cursors page stable same-day postings and keep the full-range totals independent of the current page',async f=>{
  await f.post({postedOn:'2026-05-31'});await f.post();await f.post();
  const first=await f.ledger('through=2026-12-31&limit=1');assert.equal(first.response.status,200,JSON.stringify(first.body));assert.equal(first.body.data.entries[0].postedOn,'2026-05-31');assert.equal(first.body.data.closing.amount,'300.00');assert.equal(first.body.data.lineCount,3);
  const second=await f.ledger('through=2026-12-31&limit=1&'+new URLSearchParams(first.body.nextCursor));const third=await f.ledger('through=2026-12-31&limit=1&'+new URLSearchParams(second.body.nextCursor));
  assert.equal(second.body.data.entries[0].postedOn,'2026-06-01');assert.notEqual(second.body.data.entries[0].journalId,third.body.data.entries[0].journalId);assert.equal(third.body.nextCursor,null);assert.equal(second.body.data.closing.amount,'300.00');assert.equal(third.body.data.closing.amount,'300.00');
});
check('dedicated scoped ledger rights include own-account amounts from mixed-hub journals without leaking private counterparties or journal content',async f=>{
  const other=await f.account('1000',{hubId:f.otherHub}),global=await f.account('1000',{hubId:null});const j=await f.post({lines:[{accountId:f.cash.id,accountVersion:1,side:'debit',amount:'100.00',note:'Private own-line note'},{accountId:other.id,accountVersion:1,side:'credit',amount:'100.00',note:'Private other-hub note'}]});assert.equal(j.response.status,201);
  const ledger=await f.ledger('through=2026-12-31','staff');assert.equal(ledger.response.status,200);assert.equal(ledger.body.data.closing.amount,'100.00');const serialized=JSON.stringify(ledger.body);
  for(const secret of ['Private own-line note','Private other-hub note','Synthetic journal private description',other.id])assert.ok(!serialized.includes(secret));assert.equal(ledger.body.data.entries[0].journalId,j.body.data.id);assert.equal((await f.request('finance/journals/'+j.body.data.id,undefined,'staff')).response.status,403);
  assert.equal((await f.balance('through=2026-12-31','staff',other.id)).response.status,404);assert.equal((await f.balance('through=2026-12-31','staff',global.id)).response.status,404);assert.equal((await f.request('finance/accounts/'+f.cash.id+'/ledger?through=2026-12-31',undefined,'foreignMaster',{academy:f.b})).response.status,404);
  await f.pg.query("DELETE FROM public.role_permissions WHERE role_id=$1 AND capability='ledger.view'",[f.staffRole]);assert.equal((await f.balance('through=2026-12-31','staff')).response.status,403);
});
check('reversal dates and inactive account history are retained in actual balances rather than erasing the original posting',async f=>{
  const posted=await f.post();assert.equal(posted.response.status,201);const reversed=await f.request('finance/journals/'+posted.body.data.id+'/reverse',{...f.base,postedOn:'2026-07-01'});assert.equal(reversed.response.status,201);
  await f.request('finance/accounts/'+f.cash.id+'/change',{expectedVersion:1,active:false,reason:'Synthetic retired account'});
  assert.equal((await f.balance('through=2026-06-30')).body.data.closing.amount,'100.00');const b=await f.balance('from=2026-07-01&through=2026-12-31');assert.equal(b.body.data.opening.amount,'100.00');assert.equal(b.body.data.movement.amount,'-100.00');assert.equal(b.body.data.closing.amount,'0.00');assert.equal((await f.ledger()).body.data.entries.length,2);
});
check('posted aggregates beyond the per-line limit remain exact and balances are never writable or confused with bank balances',async f=>{
  const large=formatMoney(maximumMinorUnits,2),lines=[{accountId:f.cash.id,accountVersion:1,side:'debit',amount:large},{accountId:f.equity.id,accountVersion:1,side:'credit',amount:large}];assert.equal((await f.post({lines})).response.status,201);assert.equal((await f.post({lines})).response.status,201);
  const b=await f.balance();assert.equal(b.body.data.closing.minor,(2n*maximumMinorUnits).toString());assert.equal(b.body.data.closing.amount,formatMoneyTotal(2n*maximumMinorUnits,2));assert.equal(b.body.data.bankBalance,undefined);assert.equal(b.body.data.exchangeRate,undefined);
  assert.equal((await f.request('finance/accounts/'+f.cash.id+'/balance',{balance:'99'})).response.status,405);
});
check('ledger reads reject guessed dates, incomplete cursors, unknown fields, inverted ranges and excessive pages',async f=>{
  for(const query of ['', 'through=2026-02-30','from=2026-12-31&through=2026-01-01','through=2026-12-31&limit=101','through=2026-12-31&afterLine=1','through=2026-12-31&unknown=1'])assert.equal((await f.ledger(query)).response.status,400,query);
  assert.equal((await f.balance('through=2026-12-31&limit=10')).response.status,400);
});
check('two same-account lines in one journal page by line number and pending proposals never enter posted balances',async f=>{
  for(const capability of ['journals.view','journals.edit'])await f.pg.query("INSERT INTO public.role_permissions VALUES($1,$2,$3,'allow')",[f.a,f.managerRole,capability]);
  const input={...f.base,lines:[{accountId:f.cash.id,accountVersion:1,side:'debit',amount:'100.00'},{accountId:f.cash.id,accountVersion:1,side:'credit',amount:'100.00'}]};
  const pending=await f.request('finance/journals',input,'manager');assert.equal(pending.response.status,202);assert.equal((await f.balance()).body.data.lineCount,0);assert.equal((await f.approve(pending.body.approval.id)).response.status,200);
  const first=await f.ledger('through=2026-12-31&limit=1');assert.equal(first.body.data.lineCount,2);assert.equal(first.body.data.journalCount,1);assert.equal(first.body.data.closing.amount,'0.00');assert.equal(first.body.data.entries[0].lineNumber,1);
  const second=await f.ledger('through=2026-12-31&limit=1&'+new URLSearchParams(first.body.nextCursor));assert.equal(second.body.data.entries[0].lineNumber,2);assert.equal(second.body.data.entries[0].journalId,first.body.data.entries[0].journalId);assert.equal(second.body.nextCursor,null);
});
check('explicit ledger denial overrides broader financial presets without blocking authorized unrelated-hub data',async f=>{
  const other=await f.account('1000',{hubId:f.otherHub}),global=await f.account('1000',{hubId:null});
  const allow=await f.request('roles',{name:'Broad ledger reader',permissions:[{capability:'accounts.view',effect:'allow'},{capability:'ledger.view',effect:'allow'}]}),deny=await f.request('roles',{name:'Denied ledger hub',permissions:[{capability:'ledger.view',effect:'deny'}]});assert.equal(allow.response.status,201);assert.equal(deny.response.status,201);
  const before=(await f.request('people/'+f.actors.staff.person+'/access')).body.data;assert.equal((await f.request('people/'+f.actors.staff.person+'/access',{expectedVersion:before.version,assignments:[{roleId:allow.body.data.id,allHubs:true},{roleId:deny.body.data.id,allHubs:false,hubIds:[f.hub]}]})).response.status,200);
  assert.equal((await f.balance('through=2026-12-31','staff')).response.status,403);assert.equal((await f.balance('through=2026-12-31','staff',global.id)).response.status,403);assert.equal((await f.balance('through=2026-12-31','staff',other.id)).response.status,200);assert.equal((await f.request('finance/accounts/'+f.cash.id,undefined,'staff')).response.status,200);
});
if(process.env.TEST_DATABASE_URL)check('five thousand real journals support one hundred parallel same-snapshot ledger summaries with bounded query counts',async f=>{
  const initial=await f.post();assert.equal(initial.response.status,201);await f.pg.exec('BEGIN');try{
    await f.pg.exec('CREATE TEMP TABLE synthetic_ledger_journals AS SELECT gen_random_uuid() AS id FROM generate_series(1,4999)');
    await f.pg.query(`INSERT INTO public.finance_journals(academy_id,id,period_id,period_version,posted_on,description,line_count,posted_by,approval_id)
     SELECT $1,s.id,$2,1,'2026-06-01','Synthetic ledger load',2,$3,$4 FROM synthetic_ledger_journals s`,[f.a,f.period.id,f.actors.master.person,initial.body.approval.id]);
    await f.pg.query(`INSERT INTO public.finance_journal_lines(academy_id,journal_id,line_number,account_id,account_version,side,amount_minor)
     SELECT $1,s.id,l.n,CASE WHEN l.n=1 THEN $2::uuid ELSE $3::uuid END,1,CASE WHEN l.n=1 THEN 'debit' ELSE 'credit' END,10000 FROM synthetic_ledger_journals s CROSS JOIN generate_series(1,2) l(n)`,[f.a,f.cash.id,f.equity.id]);await f.pg.exec('COMMIT');
  }catch(error){await f.pg.exec('ROLLBACK');throw error;}
  const before=f.metrics.businessQueries,durations:number[]=[];
  await Promise.all(Array.from({length:100},async()=>{const start=performance.now(),r=await f.ledger('through=2026-12-31&limit=100','staff');durations.push(performance.now()-start);assert.equal(r.response.status,200,JSON.stringify(r.body));assert.equal(r.body.data.closing.minor,'50000000');assert.equal(r.body.data.lineCount,5000);assert.equal(r.body.data.entries.length,100);assert.ok(r.body.nextCursor);}));
  const queries=f.metrics.businessQueries-before;assert.equal(queries,1300);console.log(JSON.stringify({measurement:'synthetic-account-ledger',journals:5000,postedLines:10000,concurrentRequests:100,principals:1,poolMaximum:4,validatedResponses:100,rowsPerResponse:100,p99Ms:Math.ceil(durations.sort((a,b)=>a-b)[98]),clientQueries:queries,bankRequests:0}));
});
