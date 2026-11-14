import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { operationsFixture } from './operations-fixture.ts';
import { lockFinanceBook } from '../src/core/finance-lock.ts';
import type { ApiContext } from '../src/core/api.ts';
import type { Connection } from '../src/core/database.ts';

async function fixture(){
 const f=await operationsFixture();
 const c=await f.request('finance/currencies',{code:'CAD',name:'Synthetic CAD',unitScale:2,reason:'Synthetic write gate'});assert.equal(c.response.status,201);
 const p=await f.request('finance/periods',{name:'Synthetic 2026',startsOn:'2026-01-01',endsOn:'2026-12-31',reason:'Synthetic write gate'});assert.equal(p.response.status,201);
 const account=async(code:string,kind:string)=>{const r=await f.request('finance/accounts',{code,name:'Synthetic '+code,kind,hubId:f.hub,currencyId:c.body.data.id,currencyVersion:1,reason:'Synthetic write gate'});assert.equal(r.response.status,201);return r.body.data;};
 const cash=await account('1000','asset'),equity=await account('3000','equity');
 const input={periodId:p.body.data.id,periodVersion:1,postedOn:'2026-06-01',description:'Synthetic write',reason:'Synthetic gate test',lines:[{accountId:cash.id,accountVersion:1,side:'debit',amount:'100.00'},{accountId:equity.id,accountVersion:1,side:'credit',amount:'100.00'}]};
 return {...f,currency:c.body.data,period:p.body.data,cash,equity,post:()=>f.request('finance/journals',input)};
}
type Fixture=Awaited<ReturnType<typeof fixture>>;
function check(name:string,run:(f:Fixture)=>Promise<void>){test(name,async()=>{const f=await fixture();try{await run(f);}finally{await f.pg.close();}});}
async function waiting(f:Fixture){
 for(let attempt=0;attempt<150;attempt++){
  await f.pg.query('SELECT pg_stat_clear_snapshot()');
  if((await f.pg.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND wait_event='advisory'")).rows.length)return;
  await delay(5);
 }
 assert.fail('the financial writer must actually wait at the advisory gate');
}
async function runtime(f:Fixture):Promise<Connection>{
 const c=await f.pg.runtime!.connect();await c.query('BEGIN');await c.query("SELECT set_config('app.academy_id',$1,true),set_config('lock_timeout','2000',true)",[f.a]);return c;
}
test('financial API lock is acquired once per context and failed acquisition is never cached',async()=>{
 let calls=0;const ctx={db:{async query(sql:string){assert.equal(sql,'SELECT public.lock_finance_book()');calls++;return {rows:[]};}}} as unknown as ApiContext;
 await lockFinanceBook(ctx);await lockFinanceBook(ctx);assert.equal(calls,1);assert.equal(ctx.financeBookLocked,true);
 const failed={db:{async query(){throw new Error('Synthetic unavailable gate');}}} as unknown as ApiContext;await assert.rejects(lockFinanceBook(failed));assert.equal(failed.financeBookLocked,undefined);
});
check('all financial source tables install enabled statement guards and gate helpers cannot bypass role or tenant checks',async f=>{
 const tables=(await f.pg.query<{table_name:string}>("SELECT c.relname AS table_name FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid WHERE t.tgname='finance_book_write' AND NOT t.tgisinternal AND t.tgenabled='O' AND (t.tgtype::integer & 1)=0 ORDER BY c.relname")).rows.map(r=>r.table_name);
 assert.deepEqual(tables,['finance_account_revisions','finance_accounts','finance_closing_runs','finance_currencies','finance_currency_revisions','finance_journal_lines','finance_journals','finance_period_revisions','finance_periods']);
 const privilege=(await f.pg.query<{identity:boolean;runtime:boolean;definer:boolean}>("SELECT has_function_privilege('kavosh_identity','public.lock_finance_book()','EXECUTE') AS identity,has_function_privilege('kavosh_runtime','public.lock_finance_book()','EXECUTE') AS runtime,(SELECT prosecdef FROM pg_proc WHERE oid='public.lock_finance_book()'::regprocedure) AS definer")).rows[0];assert.deepEqual(privilege,{identity:false,runtime:true,definer:false});
 await f.pg.exec('SET ROLE kavosh_runtime');try{
  await f.pg.exec('RESET app.academy_id');await assert.rejects(f.pg.exec('SELECT public.lock_finance_book()'),/FINANCE_CONTEXT_REQUIRED/);
  await assert.rejects(f.pg.query("INSERT INTO public.finance_currencies(academy_id,id,code,created_by) VALUES($1,$2,'BAD',$3)",[f.a,f.equity.id,f.actors.master.person]),/row-level security/i);
 }finally{await f.pg.exec('RESET ROLE');}
});
if(process.env.TEST_DATABASE_URL)check('API finance writers wait before taking period, account or currency row locks and resume safely',async f=>{
 const cases:[()=>ReturnType<typeof f.request>,string,string,number][]=[
  [()=>f.post(),'finance_periods',f.period.id,201],
  [()=>f.request('finance/accounts/'+f.cash.id+'/change',{expectedVersion:1,name:'Gate checked cash',reason:'Synthetic ordered gate'}),'finance_accounts',f.cash.id,200],
  [()=>f.request('finance/currencies/'+f.currency.id+'/change',{expectedVersion:1,name:'Gate checked CAD',reason:'Synthetic ordered gate'}),'finance_currencies',f.currency.id,200],
  [()=>f.request('finance/periods/'+f.period.id+'/change',{expectedVersion:1,name:'Gate checked year',reason:'Synthetic ordered gate'}),'finance_periods',f.period.id,200]
 ];
 for(const [start,table,id,status] of cases){
  await f.pg.exec('BEGIN');let open=true,pending:ReturnType<typeof f.request>|undefined;
  try{
   await f.pg.query('SELECT pg_advisory_xact_lock(hashtextextended($1,10))',[f.a]);pending=start();await waiting(f);
   // If the API locked this row before entering the book gate, NOWAIT fails.
   assert.equal((await f.pg.query('SELECT id FROM public.'+table+' WHERE id=$1 FOR UPDATE NOWAIT',[id])).rows.length,1);
   await f.pg.exec('COMMIT');open=false;const r=await pending;assert.equal(r.response.status,status,JSON.stringify(r.body));
  }finally{if(open)await f.pg.exec('ROLLBACK');await Promise.allSettled([pending]);}
 }
 assert.equal((await f.request('finance/journals')).body.data.length,1);
});
if(process.env.TEST_DATABASE_URL)check('native statement triggers gate header and revision DML before row locks independently of API helpers',async f=>{
 const commands:[string,unknown[],string|null,string|null][]=[
  ['UPDATE public.finance_currencies SET version=version+1 WHERE id=$1',[f.currency.id],'finance_currencies',f.currency.id],
  ['UPDATE public.finance_accounts SET version=version+1 WHERE id=$1',[f.cash.id],'finance_accounts',f.cash.id],
  ['UPDATE public.finance_periods SET version=version+1 WHERE id=$1',[f.period.id],'finance_periods',f.period.id],
  ...['finance_currency_revisions','finance_account_revisions','finance_period_revisions','finance_journal_lines'].map(t=>['INSERT INTO public.'+t+' SELECT * FROM public.'+t+' WHERE false',[],null,null] as [string,unknown[],null,null]),
  ['INSERT INTO public.finance_closing_runs(academy_id,id,period_id,open_period_version,through,source_snapshot,source_stamp,equity_mappings,journal_count,pair_count,created_by,approval_id,reason) SELECT academy_id,id,period_id,open_period_version,through,source_snapshot,source_stamp,equity_mappings,journal_count,pair_count,created_by,approval_id,reason FROM public.finance_closing_runs WHERE false',[],null,null],
  ["INSERT INTO public.finance_journals(academy_id,id,period_id,period_version,posted_on,description,line_count,posted_by,approval_id) SELECT academy_id,id,period_id,period_version,posted_on,description,line_count,posted_by,approval_id FROM public.finance_journals WHERE false",[],null,null]
 ];
 for(const [sql,params,table,id] of commands){
  const c=await runtime(f);await f.pg.exec('BEGIN');let open=true,pending:ReturnType<Connection['query']>|undefined;
  try{
   await f.pg.query('SELECT pg_advisory_xact_lock(hashtextextended($1,10))',[f.a]);pending=c.query(sql,params);await waiting(f);
   if(table)assert.equal((await f.pg.query('SELECT id FROM public.'+table+' WHERE id=$1 FOR UPDATE NOWAIT',[id])).rows.length,1);
   await f.pg.exec('ROLLBACK');open=false;await pending;
  }finally{if(open)await f.pg.exec('ROLLBACK');await Promise.allSettled([pending]);await c.query('ROLLBACK');c.release();}
 }
 for(const table of ['finance_accounts','finance_currencies','finance_periods'])assert.ok((await f.pg.query('SELECT version FROM public.'+table)).rows.every(r=>r.version===1));
});
if(process.env.TEST_DATABASE_URL)check('shared native writers overlap and commit or rollback releases the transaction gate without session residue',async f=>{
 const a=await runtime(f),b=await runtime(f);await f.pg.exec('BEGIN');let first=true,second=true;
 try{
  await a.query('SELECT public.lock_finance_book()');await b.query('SELECT public.lock_finance_book()');
  const canLock=async()=>(await f.pg.query<{locked:boolean}>('SELECT pg_try_advisory_xact_lock(hashtextextended($1,10)) AS locked',[f.a])).rows[0].locked;
  assert.equal(await canLock(),false);await a.query('COMMIT');first=false;assert.equal(await canLock(),false);await b.query('ROLLBACK');second=false;assert.equal(await canLock(),true);
  // The future closer already owns the exclusive gate. Its own DML must be
  // able to re-enter the shared statement guard without a lock upgrade.
  await f.pg.exec('SET ROLE kavosh_runtime');await f.pg.query("SELECT set_config('app.academy_id',$1,true)",[f.a]);await f.pg.query('UPDATE public.finance_accounts SET version=version+1 WHERE id=$1',[f.cash.id]);
  assert.equal((await f.pg.query('SELECT version FROM public.finance_accounts WHERE id=$1',[f.cash.id])).rows[0].version,2);
 }finally{if(first)await a.query('ROLLBACK');if(second)await b.query('ROLLBACK');a.release();b.release();await f.pg.exec('ROLLBACK');await f.pg.exec('RESET ROLE');}
 assert.equal((await f.pg.query('SELECT version FROM public.finance_accounts WHERE id=$1',[f.cash.id])).rows[0].version,1);
});
if(process.env.TEST_DATABASE_URL)check('an exclusive school gate does not block financial reads or another school and a timeout leaves no partial journal',async f=>{
 await f.pg.exec('BEGIN');let open=true,pending:ReturnType<typeof f.post>|undefined;
 try{
  await f.pg.query('SELECT pg_advisory_xact_lock(hashtextextended($1,10))',[f.a]);pending=f.post();await waiting(f);
  assert.equal((await f.request('finance/periods/'+f.period.id+'/closing-preview')).response.status,200);
  const foreign=await f.request('finance/currencies',{code:'USD',name:'Other synthetic school',unitScale:2,reason:'Independent school gate'},'foreignMaster',{academy:f.b});assert.equal(foreign.response.status,201,JSON.stringify(foreign.body));
  const timed=await pending;assert.equal(timed.response.status,503);assert.doesNotMatch(JSON.stringify(timed.body),/hashtextextended|lock_finance_book|55P03|stack/);assert.ok(f.metrics.queryFailures.some(e=>e.sqlState==='55P03'));assert.equal((await f.pg.query('SELECT count(*)::integer AS n FROM public.finance_journals')).rows[0].n,0);
  assert.equal((await f.pg.query("SELECT count(*)::integer AS n FROM public.approval_requests WHERE action='finance.journal.post'")).rows[0].n,0);
  for(const path of ['finance/periods/'+f.period.id+'/change','finance/currencies/'+f.currency.id+'/change','finance/accounts/'+f.cash.id+'/change'])assert.equal((await f.request(path,{expectedVersion:1,name:'Unauthorized must not wait',reason:'Synthetic denial'},'staff')).response.status,403);
  await f.pg.exec('ROLLBACK');open=false;assert.equal((await f.post()).response.status,201);
 }finally{if(open)await f.pg.exec('ROLLBACK');await Promise.allSettled([pending]);}
});
