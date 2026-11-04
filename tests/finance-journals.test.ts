import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { operationsFixture } from './operations-fixture.ts';

async function fixture(){
  const f=await operationsFixture();
  for(const role of [f.managerRole,f.staffRole])for(const capability of ['accounts.view','journals.view'])await f.pg.query("INSERT INTO public.role_permissions VALUES($1,$2,$3,'allow')",[f.a,role,capability]);
  await f.pg.query("INSERT INTO public.role_permissions VALUES($1,$2,'journals.edit','allow')",[f.a,f.managerRole]);
  const currency=await f.request('finance/currencies',{code:'CAD',name:'Canadian dollar',symbol:'$',unitScale:2,reason:'Synthetic ledger currency'});assert.equal(currency.response.status,201,JSON.stringify(currency.body));
  const period=await f.request('finance/periods',{name:'Synthetic 2026',startsOn:'2026-01-01',endsOn:'2026-12-31',reason:'Synthetic ledger year'});assert.equal(period.response.status,201,JSON.stringify(period.body));
  async function account(code:string,patch:Record<string,unknown>={}){
    const a=await f.request('finance/accounts',{code,name:'Synthetic '+code,kind:'asset',hubId:f.hub,currencyId:currency.body.data.id,currencyVersion:1,reason:'Synthetic ledger account',...patch});assert.equal(a.response.status,201,JSON.stringify(a.body));return a.body.data;
  }
  const cash=await account('1000'),equity=await account('3000',{kind:'equity'});
  const input={periodId:period.body.data.id,periodVersion:1,postedOn:'2026-06-01',description:'Synthetic opening cash',reference:'SYNTHETIC-001',reason:'Synthetic manual journal',lines:[{accountId:cash.id,accountVersion:1,side:'debit',amount:'100.00'},{accountId:equity.id,accountVersion:1,side:'credit',amount:'100.00'}]};
  const post=(patch:Record<string,unknown>={},as='master',key?:string)=>f.request('finance/journals',{...input,...patch},as,{key});
  const reversal={periodId:period.body.data.id,periodVersion:1,postedOn:'2026-06-02',description:'Synthetic exact correction',reason:'Synthetic reviewed reversal'};
  return {...f,account,cash,equity,currency:currency.body.data,period:period.body.data,input,post,reversal};
}
type Fixture=Awaited<ReturnType<typeof fixture>>;
function check(name:string,run:(f:Fixture)=>Promise<void>){test(name,async()=>{const f=await fixture();try{await run(f);}finally{await f.pg.close();}});}
check('reviewed exact double-entry postings persist real native rows with pinned account labels and currency units',async f=>{
  const result=await f.post();assert.equal(result.response.status,201,JSON.stringify(result.body));assert.equal(result.body.data.lines.length,2);assert.equal(result.body.data.lines[0].amountMinor,'10000');assert.equal(result.body.data.lines[0].amount,'100.00');assert.equal(result.body.data.lines[0].currencyCode,'CAD');assert.equal(result.body.data.reversesId,null);
  await f.request('finance/accounts/'+f.cash.id+'/change',{expectedVersion:1,name:'Renamed account',reason:'Synthetic metadata correction'});
  const read=await f.request('finance/journals/'+result.body.data.id);assert.equal(read.body.data.lines[0].accountName,'Synthetic 1000');assert.equal(read.body.data.lines[0].accountVersion,1);assert.equal((await f.pg.query('SELECT * FROM public.finance_journal_lines')).rows.length,2);
  assert.equal((await f.request('finance/journals?accountId='+f.cash.id+'&from=2026-06-01&through=2026-06-01')).body.data.length,1);assert.equal((await f.request('finance/journals?from=2026-06-02')).body.data.length,0);
});
check('journal amounts remain exact beyond Number safety and reject fractional minor units, numbers, zero, negative and unbalanced entries',async f=>{
  const large='9007199254740993.01',lines=f.input.lines.map(l=>({...l,amount:large}));const result=await f.post({lines});assert.equal(result.response.status,201,JSON.stringify(result.body));assert.equal(result.body.data.lines[0].amountMinor,'900719925474099301');assert.equal(result.body.data.lines[0].amount,large);
  for(const value of ['0','-1.00','1.001',1,'NaN','1e5'])assert.equal((await f.post({lines:f.input.lines.map(l=>({...l,amount:value}))})).response.status,400,String(value));
  assert.equal((await f.post({lines:[f.input.lines[0],{...f.input.lines[1],amount:'99.99'}]})).body.error.code,'JOURNAL_UNBALANCED');assert.equal((await f.post({lines:[f.input.lines[0]]})).response.status,400);assert.equal((await f.post({lines:Array.from({length:201},()=>f.input.lines[0])})).response.status,400);
});
check('ordinary financial staff propose exact journals but only an authorized superior applies them and audit omits private amounts and notes',async f=>{
  const secret='Synthetic confidential journal '+randomUUID(),pending=await f.post({description:secret,reason:secret,lines:f.input.lines.map(l=>({...l,note:secret}))},'manager');assert.equal(pending.response.status,202,JSON.stringify(pending.body));assert.equal((await f.request('finance/journals')).body.data.length,0);assert.equal((await f.approve(pending.body.approval.id,'manager')).response.status,403);
  const posted=await f.approve(pending.body.approval.id);assert.equal(posted.response.status,200,JSON.stringify(posted.body));assert.equal(posted.body.data.lines[0].note,secret);assert.equal(posted.body.data.postedBy,f.actors.master.person);assert.ok(!JSON.stringify((await f.request('audit-events')).body).includes(secret));
  const bot=await f.post({},'bot');assert.equal(bot.response.status,202);assert.equal((await f.approve(bot.body.approval.id,'bot')).response.status,403);assert.equal((await f.approve(bot.body.approval.id)).response.status,200);
});
check('closed, stale and mismatched periods reject postings while audited reopen restores only the new version',async f=>{
  assert.equal((await f.post({postedOn:'2027-01-01'})).body.error.code,'POSTING_DATE_OUTSIDE_PERIOD');assert.equal((await f.post({periodVersion:2})).body.error.code,'PERIOD_CHANGED');
  const close=await f.request('finance/periods/'+f.period.id+'/change',{expectedVersion:1,state:'closed',reason:'Synthetic close'});assert.equal(close.response.status,200);assert.equal((await f.post()).body.error.code,'OPEN_PERIOD_REQUIRED');
  await f.request('finance/periods/'+f.period.id+'/change',{expectedVersion:2,state:'open',reason:'Synthetic reviewed reopen'});assert.equal((await f.post()).body.error.code,'PERIOD_CHANGED');assert.equal((await f.post({periodVersion:3})).response.status,201);
  await f.request('finance/periods/'+f.period.id+'/change',{expectedVersion:3,state:'closed',reason:'Close posted period'});assert.equal((await f.request('finance/periods/'+f.period.id+'/change',{expectedVersion:4,state:'void',reason:'Must retain posted period'})).body.error.code,'PERIOD_HAS_POSTINGS');assert.equal((await f.request('finance/periods/'+f.period.id)).body.data.state,'closed');
});
check('exact inverse reversals preserve originals, clear inactive original accounts and cannot reverse twice or reverse a reversal',async f=>{
  const posted=await f.post(),id=posted.body.data.id;assert.equal(posted.response.status,201);
  await f.request('finance/accounts/'+f.cash.id+'/change',{expectedVersion:1,active:false,reason:'Retire original cash account'});assert.equal((await f.post()).body.error.code,'ACTIVE_ACCOUNT_REQUIRED');
  const reversed=await f.request('finance/journals/'+id+'/reverse',f.reversal);assert.equal(reversed.response.status,201,JSON.stringify(reversed.body));assert.equal(reversed.body.data.reversesId,id);assert.equal(reversed.body.data.lines[0].side,'credit');assert.equal(reversed.body.data.lines[0].accountVersion,1);assert.equal(reversed.body.data.lines[0].amount,'100.00');assert.equal((await f.request('finance/journals/'+id)).body.data.reversedById,reversed.body.data.id);
  assert.equal((await f.request('finance/journals/'+id+'/reverse',f.reversal)).body.error.code,'JOURNAL_ALREADY_REVERSED');assert.equal((await f.request('finance/journals/'+reversed.body.data.id+'/reverse',f.reversal)).body.error.code,'REVERSAL_OF_REVERSAL_FORBIDDEN');assert.equal((await f.pg.query('SELECT * FROM public.finance_journals')).rows.length,2);
});
check('mixed-hub journal visibility is whole-record and SQL-filtered; selected hubs never expose other-hub or global amounts',async f=>{
  const other=await f.account('1000',{hubId:f.otherHub}),global=await f.account('1000',{hubId:null});const own=await f.post();assert.equal(own.response.status,201);
  const mixed=await f.post({lines:[f.input.lines[0],{...f.input.lines[1],accountId:other.id}]}),school=await f.post({lines:[f.input.lines[0],{...f.input.lines[1],accountId:global.id}]});assert.equal(mixed.response.status,201);assert.equal(school.response.status,201);
  const visible=await f.request('finance/journals',undefined,'staff');assert.deepEqual(visible.body.data.map((r:{id:string})=>r.id),[own.body.data.id]);assert.equal((await f.request('finance/journals/'+mixed.body.data.id,undefined,'staff')).response.status,404);assert.equal((await f.request('finance/journals/'+school.body.data.id,undefined,'staff')).response.status,404);assert.equal((await f.request('finance/journals?accountId='+other.id,undefined,'staff')).body.data.length,0);
  assert.equal((await f.post({lines:[f.input.lines[0],{...f.input.lines[1],accountId:other.id}]},'manager')).response.status,404);assert.equal((await f.request('finance/journals/'+own.body.data.id,undefined,'foreignMaster',{academy:f.b})).response.status,404);
});
check('currency identities balance independently and pinned precision changes normalize exactly without inventing FX rates',async f=>{
  const usd=await f.request('finance/currencies',{code:'USD',name:'US dollar',unitScale:2,reason:'Synthetic foreign unit'});const foreign=await f.account('1100',{currencyId:usd.body.data.id});
  assert.equal((await f.post({lines:[f.input.lines[0],{...f.input.lines[1],accountId:foreign.id}]})).body.error.code,'JOURNAL_UNBALANCED');
  await f.request('finance/currencies/'+f.currency.id+'/change',{expectedVersion:1,unitScale:3,reason:'Synthetic precision revision'});const newer=await f.account('1200',{currencyVersion:2});
  const normalized=await f.post({lines:[f.input.lines[0],{...f.input.lines[1],accountId:newer.id}]});assert.equal(normalized.response.status,201,JSON.stringify(normalized.body));assert.equal(normalized.body.data.lines[0].amountMinor,'10000');assert.equal(normalized.body.data.lines[1].amountMinor,'100000');
  assert.equal((await f.post({lines:[f.input.lines[0],{...f.input.lines[1],accountId:newer.id,amount:'100.001'}]})).body.error.code,'JOURNAL_UNBALANCED');
  const second=await f.account('2100',{currencyId:usd.body.data.id});const multi=await f.post({lines:[...f.input.lines,{accountId:foreign.id,accountVersion:1,side:'debit',amount:'12.34'},{accountId:second.id,accountVersion:1,side:'credit',amount:'12.34'}]});assert.equal(multi.response.status,201,JSON.stringify(multi.body));assert.equal(multi.body.data.lines[2].currencyCode,'USD');
});
check('journal retry receipts are durable, raw injection is denied and audit/outbox failure cannot leave half a posting',async f=>{
  const key=randomUUID(),posted=await f.post({},'master',key);assert.equal(posted.response.status,201);assert.deepEqual((await f.post({},'master',key)).body,posted.body);
  const reverseKey=randomUUID(),path='finance/journals/'+posted.body.data.id+'/reverse',reversed=await f.request(path,f.reversal,'master',{key:reverseKey});assert.equal(reversed.response.status,201);assert.deepEqual((await f.request(path,f.reversal,'master',{key:reverseKey})).body,reversed.body);
  for(const patch of [{postedBy:f.actors.staff.person},{reversesId:posted.body.data.id},{approvalId:randomUUID()},{balance:'200'}])assert.equal((await f.post(patch)).response.status,400);
  await f.pg.exec('REVOKE INSERT ON public.outbox_events FROM kavosh_runtime');try{assert.equal((await f.post()).response.status,503);}finally{await f.pg.exec('GRANT INSERT ON public.outbox_events TO kavosh_runtime');}
  assert.equal((await f.pg.query('SELECT * FROM public.finance_journals')).rows.length,2);assert.equal((await f.pg.query('SELECT * FROM public.finance_journal_lines')).rows.length,4);
});
check('pending postings become stale when account or period assumptions change; losing editors cannot retrieve private pending payloads',async f=>{
  const pending=await f.post({},'manager');assert.equal(pending.response.status,202);await f.request('finance/accounts/'+f.cash.id+'/change',{expectedVersion:1,active:false,reason:'Invalidate pending journal'});
  const stale=await f.approve(pending.body.approval.id);assert.equal(stale.response.status,409);assert.equal(stale.body.approval.decisionCode,'DEPENDENCIES_CHANGED');assert.equal((await f.request('finance/journals')).body.data.length,0);
  await f.request('finance/accounts/'+f.cash.id+'/change',{expectedVersion:2,active:true,reason:'Reactivate for next test'});const next=await f.post({lines:[{...f.input.lines[0],accountVersion:3},f.input.lines[1]]},'manager');assert.equal(next.response.status,202);
  await f.pg.query("DELETE FROM public.role_permissions WHERE role_id=$1 AND capability='journals.edit'",[f.managerRole]);assert.equal((await f.request('approvals/'+next.body.approval.id,undefined,'manager')).response.status,404);assert.equal((await f.approve(next.body.approval.id)).body.approval.decisionCode,'AUTHORITY_CHANGED');
});
check('native posted rows cannot be edited, deleted, extended or fabricated as an incomplete or unbalanced journal',async f=>{
  const posted=await f.post(),id=posted.body.data.id;assert.equal(posted.response.status,201);
  await f.pg.exec('SET ROLE kavosh_runtime');try{
    await f.pg.query("SELECT set_config('app.academy_id',$1,false)",[f.b]);assert.equal((await f.pg.query('SELECT * FROM public.finance_journals')).rows.length,0);assert.equal((await f.pg.query('SELECT * FROM public.finance_journal_lines')).rows.length,0);
    await f.pg.query("SELECT set_config('app.academy_id',$1,false)",[f.a]);for(const table of ['finance_journals','finance_journal_lines']){await assert.rejects(f.pg.exec('DELETE FROM public.'+table),/permission denied/i);await assert.rejects(f.pg.exec('UPDATE public.'+table+' SET academy_id=academy_id'),/permission denied/i);}
    await assert.rejects(f.pg.query("INSERT INTO public.finance_journal_lines(academy_id,journal_id,line_number,account_id,account_version,side,amount_minor) VALUES($1,$2,3,$3,1,'debit',1)",[f.a,id,f.cash.id]),/FINANCE_LINE_NUMBER_INVALID/);
    async function invalid(fill:boolean){
      const next=randomUUID();await f.pg.exec('BEGIN');let open=true;try{
        await f.pg.query("INSERT INTO public.finance_journals(academy_id,id,period_id,period_version,posted_on,description,line_count,posted_by,approval_id) VALUES($1,$2,$3,1,'2026-06-01','Synthetic invalid native journal',2,$4,$5)",[f.a,next,f.period.id,f.actors.master.person,posted.body.approval.id]);
        if(fill)await f.pg.query("INSERT INTO public.finance_journal_lines(academy_id,journal_id,line_number,account_id,account_version,side,amount_minor) VALUES($1,$2,1,$3,1,'debit',1),($1,$2,2,$4,1,'credit',2)",[f.a,next,f.cash.id,f.equity.id]);
        await assert.rejects(f.pg.exec('COMMIT'),fill?/FINANCE_JOURNAL_UNBALANCED/:/FINANCE_JOURNAL_INCOMPLETE/);open=false;
      }finally{if(open)await f.pg.exec('ROLLBACK');}
    }
    await invalid(false);await invalid(true);
    await assert.rejects(f.pg.query("INSERT INTO public.finance_journals(academy_id,id,period_id,period_version,posted_on,description,line_count,posted_by,approval_id,created_at) VALUES($1,$2,$3,1,'2026-06-01','Forged posting time',2,$4,$5,'2000-01-01')",[f.a,randomUUID(),f.period.id,f.actors.master.person,posted.body.approval.id]),/permission denied/i);
    const forged=randomUUID();await f.pg.exec('BEGIN');try{
      await f.pg.query("INSERT INTO public.finance_journals(academy_id,id,period_id,period_version,posted_on,description,line_count,reverses_id,posted_by,approval_id) VALUES($1,$2,$3,1,'2026-06-02','Forged inverse',2,$4,$5,$6)",[f.a,forged,f.period.id,id,f.actors.master.person,posted.body.approval.id]);
      await f.pg.query("INSERT INTO public.finance_journal_lines(academy_id,journal_id,line_number,account_id,account_version,side,amount_minor) VALUES($1,$2,1,$3,1,'credit',50),($1,$2,2,$4,1,'debit',50)",[f.a,forged,f.cash.id,f.equity.id]);
      await assert.rejects(f.pg.exec('COMMIT'),/FINANCE_REVERSAL_INVALID/);
    }finally{await f.pg.exec('ROLLBACK');}
    const fractional=randomUUID();await f.pg.exec('BEGIN');try{
      await f.pg.query("INSERT INTO public.finance_journals(academy_id,id,period_id,period_version,posted_on,description,line_count,posted_by,approval_id) VALUES($1,$2,$3,1,'2026-06-01','Fractional raw minor units',2,$4,$5)",[f.a,fractional,f.period.id,f.actors.master.person,posted.body.approval.id]);
      await assert.rejects(f.pg.query("INSERT INTO public.finance_journal_lines(academy_id,journal_id,line_number,account_id,account_version,side,amount_minor) VALUES($1,$2,1,$3,1,'debit',1.5)",[f.a,fractional,f.cash.id]),/check constraint/i);
    }finally{await f.pg.exec('ROLLBACK');}
  }finally{await f.pg.exec('RESET ROLE');}
  assert.equal((await f.pg.query('SELECT * FROM public.finance_journals')).rows.length,1);
});
if(process.env.TEST_DATABASE_URL)check('concurrent exact inverses commit only one reversal with no losing posting or approval debris',async f=>{
  const posted=await f.post(),id=posted.body.data.id;const results=await Promise.all([f.request('finance/journals/'+id+'/reverse',f.reversal),f.request('finance/journals/'+id+'/reverse',f.reversal)]);
  assert.deepEqual(results.map(r=>r.response.status).sort(),[201,409]);assert.equal(results.find(r=>r.response.status===409)!.body.error.code,'JOURNAL_ALREADY_REVERSED');assert.equal((await f.pg.query('SELECT * FROM public.finance_journals')).rows.length,2);assert.equal((await f.pg.query("SELECT * FROM public.approval_requests WHERE action='finance.journal.reverse'")).rows.length,1);
});
if(process.env.TEST_DATABASE_URL)check('a posting waiting behind actual period closure observes closed state and cannot enter the ledger',async f=>{
  await f.pg.exec('BEGIN');let open=true,close:ReturnType<typeof f.request>|undefined,posting:ReturnType<typeof f.post>|undefined;
  async function wait(count:number){for(let attempt=0;attempt<500;attempt++){await f.pg.query('SELECT pg_stat_clear_snapshot()');if((await f.pg.query("SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND wait_event_type='Lock'")).rows.length>=count)return;await delay(10);}assert.fail('actual finance operations must block before owner release');}
  try{
    await f.pg.query('SELECT id FROM public.finance_periods WHERE id=$1 FOR UPDATE',[f.period.id]);close=f.request('finance/periods/'+f.period.id+'/change',{expectedVersion:1,state:'closed',reason:'Synthetic coordinated close'});await wait(1);posting=f.post();await wait(2);await f.pg.exec('COMMIT');open=false;
    assert.equal((await close).response.status,200);const rejected=await posting;assert.equal(rejected.response.status,409);assert.equal(rejected.body.error.code,'OPEN_PERIOD_REQUIRED');assert.equal((await f.pg.query('SELECT * FROM public.finance_journals')).rows.length,0);
  }finally{if(open)await f.pg.exec('ROLLBACK');await Promise.allSettled([close,posting]);}
});
if(process.env.TEST_DATABASE_URL)check('one hundred simultaneous real postings preserve all two hundred exact lines through the four-connection pool',async f=>{
  const before=f.metrics.businessQueries,durations:number[]=[],ids:string[]=[];
  await Promise.all(Array.from({length:100},async(_,i)=>{const start=performance.now(),r=await f.post({reference:'SYNTHETIC-CONCURRENT-'+i});durations.push(performance.now()-start);assert.equal(r.response.status,201,JSON.stringify(r.body));ids.push(r.body.data.id);assert.equal(r.body.data.lines[0].amount,'100.00');assert.equal(r.body.data.lines[1].amount,'100.00');}));
  assert.equal(new Set(ids).size,100);const totals=(await f.pg.query<{journals:number;lines:number;debits:string;credits:string}>("SELECT (SELECT count(*)::integer FROM public.finance_journals) AS journals,count(*)::integer AS lines,sum(amount_minor) FILTER(WHERE side='debit')::text AS debits,sum(amount_minor) FILTER(WHERE side='credit')::text AS credits FROM public.finance_journal_lines")).rows[0];
  assert.deepEqual(totals,{journals:100,lines:200,debits:'1000000',credits:'1000000'});
  const queries=f.metrics.businessQueries-before;assert.ok(queries<=10000,'bounded budget: at most100 client queries per two-line posting, not a per-line loop');
  console.log(JSON.stringify({measurement:'synthetic-exact-journal-posting',concurrentRequests:100,principals:1,poolMaximum:4,validatedResponses:100,persistedJournals:100,persistedLines:200,p99Ms:Math.ceil(durations.sort((a,b)=>a-b)[98]),clientQueries:queries,externalPayments:0,bankRequests:0}));
});
