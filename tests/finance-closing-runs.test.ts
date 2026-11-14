import assert from 'node:assert/strict';
import { createHash,randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { operationsFixture } from './operations-fixture.ts';
import { maximumMinorUnits,formatMoney } from '../src/core/money.ts';

const caps=['closing.view','closing.edit','periods.view','periods.edit','accounts.view','journals.view','journals.edit','ledger.view','financial-reports.view'];
async function fixture(){
 const f=await operationsFixture();
 for(const role of [f.managerRole,f.staffRole])for(const cap of caps)await f.pg.query("INSERT INTO public.role_permissions VALUES($1,$2,$3,'allow')",[f.a,role,cap]);
 const currency=await f.request('finance/currencies',{code:'CAD',name:'Synthetic CAD',unitScale:2,reason:'Synthetic closing currency'});assert.equal(currency.response.status,201,JSON.stringify(currency.body));
 const period=await f.request('finance/periods',{name:'Synthetic 2026',startsOn:'2026-01-01',endsOn:'2026-12-31',reason:'Synthetic closing period'});assert.equal(period.response.status,201,JSON.stringify(period.body));
 const account=async(code:string,kind:string,extra:Record<string,unknown>={})=>{const r=await f.request('finance/accounts',{code,name:'Synthetic '+code,kind,hubId:f.hub,currencyId:currency.body.data.id,currencyVersion:1,reason:'Synthetic closing account',...extra});assert.equal(r.response.status,201,JSON.stringify(r.body));return r.body.data;};
 const cash=await account('1000','asset'),equity=await account('3000','equity'),income=await account('4000','income'),expense=await account('5000','expense');
 const post=(debit:{id:string;version:number},credit:{id:string;version:number},amount='100.00',patch:Record<string,unknown>={})=>f.request('finance/journals',{periodId:period.body.data.id,periodVersion:1,postedOn:'2026-06-01',description:'Synthetic source',reason:'Synthetic source reason',lines:[{accountId:debit.id,accountVersion:debit.version,side:'debit',amount},{accountId:credit.id,accountVersion:credit.version,side:'credit',amount}],...patch});
 const preview=()=>f.request('finance/periods/'+period.body.data.id+'/closing-preview');
 const input=async(patch:Record<string,unknown>={})=>{const r=await preview();assert.equal(r.response.status,200,JSON.stringify(r.body));return {expectedPeriodVersion:r.body.data.periodVersion,snapshot:r.body.data.snapshot,equityMappings:[{currencyId:currency.body.data.id,sourceHubId:f.hub,accountId:equity.id,accountVersion:1}],reason:'Synthetic private closing reason',...patch};};
 const close=(body:unknown,as='master',key=randomUUID())=>f.request('finance/periods/'+period.body.data.id+'/closing-runs',body,as,{key});
 const globalize=async()=>f.pg.query('UPDATE public.role_assignments SET all_hubs=true WHERE role_id=ANY($1::uuid[])',[[f.staffRole,f.managerRole]]);
 return {...f,currency:currency.body.data,period:period.body.data,account,cash,equity,income,expense,post,preview,input,close,globalize};
}
type Fixture=Awaited<ReturnType<typeof fixture>>;
function check(name:string,run:(f:Fixture)=>Promise<void>){test(name,async()=>{const f=await fixture();try{await run(f);}finally{await f.pg.close();}});}
check('reviewed close posts balanced exact entries, retains source provenance and leaves operating profit intact',async f=>{
 assert.equal((await f.post(f.cash,f.income)).response.status,201);assert.equal((await f.post(f.expense,f.cash,'30.00')).response.status,201);
 const input=await f.input(),key=randomUUID(),closed=await f.close(input,'master',key);assert.equal(closed.response.status,201,JSON.stringify({body:closed.body,errors:f.metrics.queryFailures}));
 const r=closed.body.data;assert.equal(r.active,true);assert.equal(r.journalCount,1);assert.equal(r.pairCount,2);assert.equal(r.sourceSnapshot,input.snapshot);assert.equal(r.sourceStamp.journals,'2');assert.equal(r.closedPeriodVersion,2);assert.ok(!JSON.stringify(r).includes(input.reason));
 assert.deepEqual((await f.close(input,'master',key)).body,closed.body);
 assert.equal((await f.request('finance/periods/'+f.period.id)).body.data.activeClosingRunId,r.id);
 const linked=await f.request('finance/closing-runs/'+r.id+'/journals');assert.equal(linked.body.data.length,1);assert.equal(linked.body.data[0].lineCount,4);
 const journal=(await f.request('finance/journals/'+linked.body.data[0].id)).body.data;assert.equal(journal.closingRunId,r.id);assert.equal(journal.purpose,'closing');
 assert.equal((await f.request('finance/accounts/'+f.income.id+'/balance?through=2026-12-31')).body.data.closing.minor,'0');
 assert.equal((await f.request('finance/accounts/'+f.expense.id+'/balance?through=2026-12-31')).body.data.closing.minor,'0');
 const profit=await f.request('reports/finance/profit-loss?from=2026-01-01&through=2026-12-31');assert.equal(profit.body.data.currencies[0].netResult.amount,'70.00');
 const sheet=(await f.request('reports/finance/balance-sheet?through=2026-12-31')).body.data.currencies[0];assert.equal(sheet.equity.amount,'70.00');assert.equal(sheet.unclosedPostedResult.minor,'0');assert.equal(sheet.balanced,true);
 assert.equal((await f.close(input)).response.status,409);assert.equal((await f.post(f.cash,f.income)).response.status,409);
});
check('exact original journal retry returns its saved receipt after formal close and prospective account retirement',async f=>{
 const input={periodId:f.period.id,periodVersion:1,postedOn:'2026-06-01',description:'Synthetic retry source',reason:'Synthetic retry reason',lines:[{accountId:f.cash.id,accountVersion:1,side:'debit',amount:'100.00'},{accountId:f.income.id,accountVersion:1,side:'credit',amount:'100.00'}]},key=randomUUID();
 const original=await f.request('finance/journals',input,'master',{key});assert.equal(original.response.status,201);assert.equal((await f.close(await f.input())).response.status,201);
 assert.equal((await f.request('finance/accounts/'+f.income.id+'/change',{expectedVersion:1,active:false,reason:'Synthetic prospective retirement'})).response.status,200);
 const retry=await f.request('finance/journals',input,'master',{key});assert.equal(retry.response.status,201,JSON.stringify(retry.body));assert.deepEqual(retry.body,original.body);assert.equal((await f.pg.query('SELECT count(*)::integer AS n FROM public.finance_journals')).rows[0].n,2);
 assert.equal((await f.request('finance/journals',input)).response.status,409);
});
check('pending and applied financial retry receipts still require current full account and feature authority',async f=>{
 await f.globalize();const input={periodId:f.period.id,periodVersion:1,postedOn:'2026-06-01',description:'Synthetic staff retry',reason:'Synthetic retry reason',lines:[{accountId:f.cash.id,accountVersion:1,side:'debit',amount:'100.00'},{accountId:f.income.id,accountVersion:1,side:'credit',amount:'100.00'}]},key=randomUUID();
 const original=await f.request('finance/journals',input,'staff',{key});assert.equal(original.response.status,202);assert.equal((await f.approve(original.body.approval.id,'manager')).response.status,200);assert.equal((await f.close(await f.input())).response.status,201);
 const retry=await f.request('finance/journals',input,'staff',{key});assert.equal(retry.response.status,202,JSON.stringify(retry.body));assert.deepEqual(retry.body,original.body);
 await f.pg.query("DELETE FROM public.role_permissions WHERE role_id=$1 AND capability='accounts.view'",[f.staffRole]);assert.equal((await f.request('finance/journals',input,'staff',{key})).response.status,404);
 await f.pg.query("INSERT INTO public.role_permissions VALUES($1,$2,'accounts.view','allow')",[f.a,f.staffRole]);await f.pg.query("DELETE FROM public.role_permissions WHERE role_id=$1 AND capability='journals.edit'",[f.staffRole]);assert.equal((await f.request('finance/journals',input,'staff',{key})).response.status,403);
});
check('saved exact reversal retry survives formal closure and never creates a second inverse',async f=>{
 const posted=await f.post(f.cash,f.income);assert.equal(posted.response.status,201);const path='finance/journals/'+posted.body.data.id+'/reverse',input={periodId:f.period.id,periodVersion:1,postedOn:'2026-06-02',description:'Synthetic retry inverse',reason:'Synthetic retry inverse reason'},key=randomUUID();
 const original=await f.request(path,input,'master',{key});assert.equal(original.response.status,201);assert.equal((await f.close(await f.input({equityMappings:[]}))).response.status,201);
 const retry=await f.request(path,input,'master',{key});assert.equal(retry.response.status,201,JSON.stringify(retry.body));assert.deepEqual(retry.body,original.body);assert.equal((await f.pg.query('SELECT count(*)::integer AS n FROM public.finance_journals')).rows[0].n,2);
 assert.equal((await f.request(path,{...input,reason:'Changed request'},'master',{key})).body.error.code,'IDEMPOTENCY_CONFLICT');
});
check('prior version-one financial proposals require fresh review while original dependency date fields remain stable',async f=>{
 await f.globalize();const input={periodId:f.period.id,periodVersion:1,postedOn:'2026-06-01',description:'Synthetic prior proposal',reason:'Synthetic upgrade reason',lines:[{accountId:f.cash.id,accountVersion:1,side:'debit',amount:'100.00'},{accountId:f.income.id,accountVersion:1,side:'credit',amount:'100.00'}]},pending=await f.request('finance/journals',input,'staff');assert.equal(pending.response.status,202);
 const context=(await f.request('approvals/'+pending.body.approval.id)).body.data.reviewContext;assert.equal(context.period.starts_on,'2026-01-01');assert.equal(context.period.ends_on,'2026-12-31');assert.equal(context.journalPurposeVersion,2);
 // Exact former protocol shape from the pre-correction journal handler.
 // Only the disposable test owner can reconstruct immutable stored cases.
 const old={journalPurposeVersion:1,period:{version:context.period.version,state:context.period.state,starts_on:context.period.starts_on,ends_on:context.period.ends_on},accounts:context.accounts.map((a:{id:string;version:number;active:boolean;currency_version:number})=>({id:a.id,version:a.version,active:a.active,currency_version:a.currency_version})),source:null};
 await f.pg.query('UPDATE public.approval_requests SET review_context=$2::jsonb,dependency_hash=$3 WHERE id=$1',[pending.body.approval.id,JSON.stringify(old),createHash('sha256').update(JSON.stringify(old)).digest('hex')]);
 const reviewed=await f.approve(pending.body.approval.id);assert.equal(reviewed.response.status,409,JSON.stringify(reviewed.body));assert.equal(reviewed.body.approval.decisionCode,'DEPENDENCIES_CHANGED');assert.equal((await f.request('finance/journals')).body.data.length,0);
});
check('school-wide close requires full current rights, upper human review and stale-source rejection',async f=>{
 await f.post(f.cash,f.income);const input=await f.input();assert.equal((await f.close(input,'staff')).response.status,403);await f.globalize();
 const pending=await f.close(input,'staff');assert.equal(pending.response.status,202,JSON.stringify(pending.body));assert.equal((await f.approve(pending.body.approval.id,'staff')).response.status,403);
 assert.equal((await f.request('finance/periods/'+f.period.id+'/closing-runs')).body.data.length,0);
 await f.post(f.expense,f.cash,'1.00');const stale=await f.approve(pending.body.approval.id);assert.equal(stale.response.status,409,JSON.stringify(stale.body));assert.equal(stale.body.approval.decisionCode,'DEPENDENCIES_CHANGED');
 const next=await f.close(await f.input(),'staff');assert.equal(next.response.status,202);const applied=await f.approve(next.body.approval.id,'manager');assert.equal(applied.response.status,200,JSON.stringify(applied.body));assert.equal(applied.body.data.active,true);
 assert.equal((await f.request('finance/closing-runs/'+applied.body.data.id,undefined,'foreignMaster',{academy:f.b})).response.status,404);
 await f.pg.query("DELETE FROM public.role_permissions WHERE role_id=$1 AND capability='accounts.view'",[f.staffRole]);assert.equal((await f.request('finance/closing-runs/'+applied.body.data.id,undefined,'staff')).response.status,403);
});
check('close mappings and exact source checks reject invalid or stale plans without partial writes',async f=>{
 await f.post(f.cash,f.income);const input=await f.input(),m=input.equityMappings[0];
 for(const [patch,status] of [[{snapshot:'0'.repeat(64)},409],[{equityMappings:[]},400],[{equityMappings:[m,m]},400],[{equityMappings:[{...m,accountVersion:2}]},409],[{equityMappings:[{...m,accountId:f.cash.id}]},409],[{equityMappings:[{...m,accountId:randomUUID()}]},404],[{expectedPeriodVersion:2},409]] as const){const r=await f.close({...input,...patch});assert.equal(r.response.status,status,JSON.stringify(r.body));}
 assert.equal((await f.request('finance/journals')).body.data.length,1);assert.equal((await f.request('finance/periods/'+f.period.id+'/closing-runs')).body.data.length,0);assert.equal((await f.request('finance/periods/'+f.period.id)).body.data.state,'open');
});
check('empty close, rename, permission-protected reopen and incremental reclose retain immutable run history',async f=>{
 const first=await f.close(await f.input({equityMappings:[]}));assert.equal(first.response.status,201,JSON.stringify(first.body));assert.equal(first.body.data.journalCount,0);
 assert.equal((await f.request('finance/periods/'+f.period.id+'/change',{expectedVersion:2,name:'Renamed closed period',reason:'Synthetic rename'})).response.status,200);
 assert.equal((await f.request('finance/closing-runs/'+first.body.data.id)).body.data.active,true);
 await f.globalize();await f.pg.query("DELETE FROM public.role_permissions WHERE role_id=$1 AND capability='closing.edit'",[f.staffRole]);
 const reopen={expectedVersion:3,state:'open',reason:'Synthetic controlled reopen'};assert.equal((await f.request('finance/periods/'+f.period.id+'/change',reopen,'staff')).response.status,403);
 const reopenKey=randomUUID(),reopened=await f.request('finance/periods/'+f.period.id+'/change',reopen,'master',{key:reopenKey});assert.equal(reopened.response.status,200);
 assert.deepEqual((await f.request('finance/periods/'+f.period.id+'/change',reopen,'master',{key:reopenKey})).body,reopened.body);
 assert.equal((await f.request('finance/closing-runs/'+first.body.data.id)).body.data.active,false);
 assert.equal((await f.post(f.cash,f.income,'25.00',{periodVersion:4})).response.status,201);
 const second=await f.close(await f.input());assert.equal(second.response.status,201,JSON.stringify(second.body));assert.equal(second.body.data.pairCount,1);assert.equal(second.body.data.closedPeriodVersion,5);
 assert.equal((await f.request('finance/periods/'+f.period.id+'/closing-runs')).body.data.length,2);
});
check('large closing groups split exactly within posting limits and finer equity precision never rounds',async f=>{
 const large=formatMoney(maximumMinorUnits,2);await f.post(f.cash,f.income,large);await f.post(f.cash,f.income,large);
 await f.request('finance/currencies/'+f.currency.id+'/change',{expectedVersion:1,unitScale:3,reason:'Synthetic finer destination'});
 const finer=await f.account('3100','equity',{currencyVersion:2});
 const closed=await f.close(await f.input({equityMappings:[{currencyId:f.currency.id,sourceHubId:f.hub,accountId:finer.id,accountVersion:1}]}));assert.equal(closed.response.status,201,JSON.stringify(closed.body));assert.equal(closed.body.data.pairCount,21);
 const totals=(await f.pg.query<{minor:string}>('SELECT sum(amount_minor)::text AS minor FROM public.finance_journal_lines WHERE account_id=$1',[finer.id])).rows[0];assert.equal(BigInt(totals.minor),maximumMinorUnits*20n);
 assert.equal((await f.request('finance/accounts/'+f.income.id+'/balance?through=2026-12-31')).body.data.closing.minor,'0');
});
check('coarser equity precision cannot silently discard fractional currency units',async f=>{
 await f.request('finance/currencies/'+f.currency.id+'/change',{expectedVersion:1,unitScale:3,reason:'Synthetic finer source'});
 const cash=await f.account('1100','asset',{currencyVersion:2}),income=await f.account('4100','income',{currencyVersion:2});await f.post(cash,income,'0.001');
 const rejected=await f.close(await f.input());assert.equal(rejected.response.status,409);assert.equal(rejected.body.error.code,'CLOSING_EQUITY_PRECISION_REQUIRED');assert.equal((await f.request('finance/periods/'+f.period.id)).body.data.state,'open');
});
check('audit delivery failure rolls back close, entries, period revision, approval and retry receipt together',async f=>{
 await f.post(f.cash,f.income);const body=await f.input(),key=randomUUID();
 const before=(await f.pg.query<{n:number}>('SELECT count(*)::integer AS n FROM public.approval_requests')).rows[0].n;
 await f.pg.exec('REVOKE INSERT ON public.outbox_events FROM kavosh_runtime');try{const r=await f.close(body,'master',key);assert.equal(r.response.status,503,JSON.stringify(r.body));}finally{await f.pg.exec('GRANT INSERT ON public.outbox_events TO kavosh_runtime');}
 assert.equal((await f.pg.query('SELECT count(*)::integer AS n FROM public.approval_requests')).rows[0].n,before);assert.equal((await f.request('finance/journals')).body.data.length,1);assert.equal((await f.request('finance/periods/'+f.period.id+'/closing-runs')).body.data.length,0);assert.equal((await f.request('finance/periods/'+f.period.id)).body.data.version,1);
 assert.equal((await f.close(body,'master',key)).response.status,201);
});
check('active later close blocks backdated earlier-period posts independently at API and native database boundaries',async f=>{
 const old=await f.request('finance/periods',{name:'Synthetic 2025',startsOn:'2025-01-01',endsOn:'2025-12-31',reason:'Synthetic earlier period'});assert.equal(old.response.status,201);
 await f.request('finance/periods/'+old.body.data.id+'/change',{expectedVersion:1,state:'closed',reason:'Synthetic administrative close'});await f.post(f.cash,f.income);
 const closed=await f.close(await f.input());assert.equal(closed.response.status,201,JSON.stringify(closed.body));
 await f.request('finance/periods/'+old.body.data.id+'/change',{expectedVersion:2,state:'open',reason:'Synthetic earlier reopen'});
 const denied=await f.post(f.cash,f.income,'1.00',{periodId:old.body.data.id,periodVersion:3,postedOn:'2025-06-01'});assert.equal(denied.body.error.code,'FINANCIAL_CLOSED_THROUGH');
 await f.pg.exec('SET ROLE kavosh_runtime');try{
  await f.pg.query("SELECT set_config('app.academy_id',$1,false)",[f.a]);
  await assert.rejects(f.pg.query("INSERT INTO public.finance_journals(academy_id,id,period_id,period_version,posted_on,description,line_count,posted_by,approval_id) VALUES($1,$2,$3,3,'2025-06-01','Synthetic blocked source',2,$4,$5)",[f.a,randomUUID(),old.body.data.id,f.actors.master.person,closed.body.data.approvalId]),/FINANCE_CLOSED_THROUGH/);
  await assert.rejects(f.pg.query('UPDATE public.finance_closing_runs SET reason=$1',['Forged']),/permission denied/i);
  await assert.rejects(f.pg.query('DELETE FROM public.finance_closing_runs'),/permission denied/i);
  await assert.rejects(f.pg.query('UPDATE public.finance_periods SET active_closing_run_id=NULL WHERE id=$1',[f.period.id]),/FINANCE_CLOSE_REOPEN_REQUIRED/);
 }finally{await f.pg.exec('RESET ROLE');}
});
if(process.env.TEST_DATABASE_URL)check('financial exclusive ownership is checked against the actual current school lock',async f=>{
 await f.pg.exec('SET ROLE kavosh_runtime');await f.pg.exec('BEGIN');try{
  await f.pg.query("SELECT set_config('app.academy_id',$1,true)",[f.a]);const owned=async()=>(await f.pg.query<{yes:boolean}>('SELECT public.finance_book_is_exclusive() AS yes')).rows[0].yes;
  assert.equal(await owned(),false);await f.pg.query('SELECT public.lock_finance_book()');assert.equal(await owned(),false);
  await f.pg.query('SELECT pg_advisory_xact_lock(hashtextextended($1,10))',[f.b]);assert.equal(await owned(),false);
  await f.pg.query('SELECT pg_advisory_xact_lock(hashtextextended($1,10))',[f.a]);assert.equal(await owned(),true);
 }finally{await f.pg.exec('ROLLBACK');await f.pg.exec('RESET ROLE');}
});
if(process.env.TEST_DATABASE_URL)check('posting queued behind a real closing lock cannot enter the closed source or leave partial records',async f=>{
 await f.post(f.cash,f.income);const input=await f.input();let closing:ReturnType<typeof f.close>|undefined,posting:ReturnType<typeof f.post>|undefined,open=true;
 await f.pg.exec('BEGIN');try{
  await f.pg.query('SELECT pg_advisory_xact_lock(hashtextextended($1,10))',[f.a]);closing=f.close(input);
  const wait=async(count:number)=>{for(let i=0;i<150;i++){await f.pg.query('SELECT pg_stat_clear_snapshot()');if((await f.pg.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND wait_event='advisory'")).rows.length>=count)return;await delay(5);}assert.fail('expected actual lock waits');};
  await wait(1);posting=f.post(f.expense,f.cash,'1.00');await wait(2);await f.pg.exec('COMMIT');open=false;
  const r=await closing;assert.equal(r.response.status,201,JSON.stringify(r.body));assert.equal((await posting).response.status,409);assert.equal((await f.pg.query('SELECT count(*)::integer AS n FROM public.finance_journals')).rows[0].n,2);
 }finally{if(open)await f.pg.exec('ROLLBACK');await Promise.allSettled([closing,posting]);}
});
if(process.env.TEST_DATABASE_URL)check('a period editor without closing rights is denied before waiting on the financial book gate',async f=>{
 const closed=await f.close(await f.input({equityMappings:[]}));assert.equal(closed.response.status,201);await f.globalize();await f.pg.query("DELETE FROM public.role_permissions WHERE role_id=$1 AND capability='closing.edit'",[f.staffRole]);
 await f.pg.exec('BEGIN');try{
  await f.pg.query('SELECT pg_advisory_xact_lock(hashtextextended($1,10))',[f.a]);const denied=await f.request('finance/periods/'+f.period.id+'/change',{expectedVersion:2,state:'open',reason:'Synthetic forbidden reopen'},'staff');assert.equal(denied.response.status,403,JSON.stringify(denied.body));assert.equal(f.metrics.queryFailures.length,0);
 }finally{await f.pg.exec('ROLLBACK');}
});
if(process.env.TEST_DATABASE_URL)check('simultaneous closing requests commit only one complete run without losing-request debris',async f=>{
 await f.post(f.cash,f.income);const input=await f.input(),results=await Promise.all([f.close(input),f.close(input)]);assert.deepEqual(results.map(r=>r.response.status).sort(),[201,409]);
 assert.equal((await f.pg.query('SELECT count(*)::integer AS n FROM public.finance_closing_runs')).rows[0].n,1);assert.equal((await f.pg.query("SELECT count(*)::integer AS n FROM public.approval_requests WHERE action='finance.closing.post'")).rows[0].n,1);assert.equal((await f.pg.query('SELECT count(*)::integer AS n FROM public.finance_journals')).rows[0].n,2);
});
check('native close headers require real exclusive ownership, truthful source evidence and complete activation',async f=>{
 await f.post(f.cash,f.income);const preview=(await f.preview()).body.data,input=await f.input();await f.globalize();const pending=await f.close(input,'staff');assert.equal(pending.response.status,202);
 const proposal=(await f.request('approvals/'+pending.body.approval.id)).body.data;
 await f.pg.exec('SET ROLE kavosh_runtime');try{
  await f.pg.query("SELECT set_config('app.academy_id',$1,false)",[f.a]);
  const invalid=async(exclusive:boolean,snapshot:string,stamp:unknown,pattern:RegExp)=>{await f.pg.exec('BEGIN');try{
   if(exclusive)await f.pg.query('SELECT pg_advisory_xact_lock(hashtextextended($1,10))',[f.a]);
   await assert.rejects((async()=>{await f.pg.query("INSERT INTO public.finance_closing_runs(academy_id,id,period_id,open_period_version,through,source_snapshot,source_stamp,equity_mappings,journal_count,pair_count,created_by,approval_id,reason) VALUES($1,$2,$3,1,'2026-12-31',$4,$5::jsonb,$6::jsonb,0,0,$7,$8,'Synthetic forged close')",[f.a,proposal.targetId,f.period.id,snapshot,JSON.stringify(stamp),JSON.stringify(input.equityMappings),f.actors.master.person,pending.body.approval.id]);await f.pg.exec('SET CONSTRAINTS finance_closing_complete IMMEDIATE');})(),pattern);
  }finally{await f.pg.exec('ROLLBACK');}};
  await invalid(false,input.snapshot,preview.sourceStamp,/FINANCE_EXCLUSIVE_REQUIRED/);
  await invalid(true,'0'.repeat(64),preview.sourceStamp,/FINANCE_CLOSE_SNAPSHOT_INVALID/);
  await invalid(true,input.snapshot,{...preview.sourceStamp,journals:'0'},/FINANCE_CLOSE_SOURCE_CHANGED/);
  await invalid(true,input.snapshot,preview.sourceStamp,/FINANCE_CLOSE_INCOMPLETE/);
 }finally{await f.pg.exec('RESET ROLE');}
 assert.equal((await f.request('finance/periods/'+f.period.id+'/closing-runs')).body.data.length,0);assert.equal((await f.request('finance/periods/'+f.period.id)).body.data.version,1);
});
check('native close completeness rejects mismatched equity, sides, precision and omitted temporary balances',async f=>{
 await f.post(f.cash,f.income);const preview=(await f.preview()).body.data,input=await f.input();await f.globalize();const pending=await f.close(input,'staff');assert.equal(pending.response.status,202);
 const run=(await f.request('approvals/'+pending.body.approval.id)).body.data.targetId;
 await f.pg.exec('SET ROLE kavosh_runtime');try{
  await f.pg.query("SELECT set_config('app.academy_id',$1,false)",[f.a]);
  for(const [target,side,amount,error] of [[f.cash.id,'credit','10000','FINANCE_CLOSE_PAIR_INVALID'],[f.equity.id,'debit','10000','FINANCE_CLOSE_PAIR_INVALID'],[f.equity.id,'credit','9999','FINANCE_CLOSE_PAIR_INVALID'],[f.equity.id,'credit','5000','FINANCE_CLOSE_TEMPORARY_BALANCE']] as const){
   await f.pg.exec('BEGIN');try{
    await f.pg.query('SELECT pg_advisory_xact_lock(hashtextextended($1,10))',[f.a]);
    await f.pg.query("INSERT INTO public.finance_closing_runs(academy_id,id,period_id,open_period_version,through,source_snapshot,source_stamp,equity_mappings,journal_count,pair_count,created_by,approval_id,reason) VALUES($1,$2,$3,1,'2026-12-31',$4,$5::jsonb,$6::jsonb,1,1,$7,$8,'Synthetic incomplete close')",[f.a,run,f.period.id,input.snapshot,JSON.stringify(preview.sourceStamp),JSON.stringify(input.equityMappings),f.actors.master.person,pending.body.approval.id]);
    const journal=randomUUID();await f.pg.query("INSERT INTO public.finance_journals(academy_id,id,period_id,period_version,posted_on,description,line_count,posted_by,approval_id,purpose,closing_run_id) VALUES($1,$2,$3,1,'2026-12-31','Synthetic forged pair',2,$4,$5,'closing',$6)",[f.a,journal,f.period.id,f.actors.master.person,pending.body.approval.id,run]);
    const debit=error==='FINANCE_CLOSE_TEMPORARY_BALANCE'?amount:'10000';
    await f.pg.query("INSERT INTO public.finance_journal_lines(academy_id,journal_id,line_number,account_id,account_version,side,amount_minor) VALUES($1,$2,1,$3,1,'debit',$4::numeric),($1,$2,2,$5,1,$6,$7::numeric)",[f.a,journal,f.income.id,debit,target,side,amount]);
    await f.pg.query("UPDATE public.finance_periods SET version=2,state='closed',active_closing_run_id=$2 WHERE id=$1",[f.period.id,run]);
    await f.pg.query("INSERT INTO public.finance_period_revisions(academy_id,period_id,version,name,state,changed_by,approval_id,reason) VALUES($1,$2,2,'Synthetic 2026','closed',$3,$4,'Synthetic native close')",[f.a,f.period.id,f.actors.master.person,pending.body.approval.id]);
    await assert.rejects(f.pg.exec('SET CONSTRAINTS finance_closing_complete IMMEDIATE'),new RegExp(error));
   }finally{await f.pg.exec('ROLLBACK');}
  }
 }finally{await f.pg.exec('RESET ROLE');}
 assert.equal((await f.request('finance/periods/'+f.period.id)).body.data.version,1);assert.equal((await f.request('finance/journals')).body.data.length,1);
});
check('multiple currencies and source hubs close into explicitly selected destinations without FX or lost refunds',async f=>{
 await f.post(f.cash,f.income);await f.post(f.expense,f.cash,'130.00');
 const otherIncome=await f.account('4200','income',{hubId:f.otherHub});await f.post(f.cash,otherIncome,'25.00');
 const usd=await f.request('finance/currencies',{code:'USD',name:'Synthetic USD',unitScale:0,reason:'Synthetic second currency'});assert.equal(usd.response.status,201);
 const cash=await f.account('1100','asset',{currencyId:usd.body.data.id}),income=await f.account('4100','income',{currencyId:usd.body.data.id}),equity=await f.account('3100','equity',{currencyId:usd.body.data.id});await f.post(cash,income,'123');
 const body=await f.input();body.equityMappings.push({...body.equityMappings[0],sourceHubId:f.otherHub},{currencyId:usd.body.data.id,sourceHubId:f.hub,accountId:equity.id,accountVersion:1});
 const r=await f.close(body);assert.equal(r.response.status,201,JSON.stringify(r.body));assert.equal(r.body.data.pairCount,4);
 const currencies=(await f.request('reports/finance/balance-sheet?through=2026-12-31')).body.data.currencies;assert.equal(currencies.length,2);assert.ok(currencies.every((c:{balanced:boolean;unclosedPostedResult:{minor:string}})=>c.balanced&&c.unclosedPostedResult.minor==='0'));assert.equal(currencies.find((c:{currencyCode:string})=>c.currencyCode==='CAD').equity.amount,'-5.00');assert.equal(currencies.find((c:{currencyCode:string})=>c.currencyCode==='USD').equity.amount,'123');
});
check('bot can propose a school close but only a currently authorized upper human can apply it',async f=>{
 await f.post(f.cash,f.income);await f.globalize();const input=await f.input(),pending=await f.close(input,'bot');assert.equal(pending.response.status,202,JSON.stringify(pending.body));
 assert.equal((await f.approve(pending.body.approval.id,'bot')).response.status,403);
 await f.pg.query("DELETE FROM public.role_permissions WHERE role_id=$1 AND capability='journals.edit'",[f.managerRole]);const denied=await f.approve(pending.body.approval.id,'manager');assert.equal(denied.response.status,403);
 assert.equal((await f.request('approvals/'+pending.body.approval.id)).body.data.status,'pending');
 const stale=await f.approve(pending.body.approval.id);assert.equal(stale.response.status,409);assert.equal(stale.body.approval.decisionCode,'AUTHORITY_CHANGED');
});
if(process.env.TEST_DATABASE_URL)check('five thousand account history closes exactly within unchanged production SQL limits and bounded journal batches',async f=>{
 const initial=await f.post(f.cash,f.income);assert.equal(initial.response.status,201);await f.pg.exec('BEGIN');try{
  await f.pg.exec('CREATE TEMP TABLE synthetic_close_accounts AS SELECT gen_random_uuid() AS id,n FROM generate_series(1,4996) n');
  await f.pg.query("INSERT INTO public.finance_accounts(academy_id,id,hub_id,currency_id,currency_version,code,created_by) SELECT $1,id,$2,$3,1,'C'||lpad(n::text,5,'0'),$4 FROM synthetic_close_accounts",[f.a,f.hub,f.currency.id,f.actors.master.person]);
  await f.pg.query("INSERT INTO public.finance_account_revisions(academy_id,account_id,version,code,name,description,kind,normal_balance,active,changed_by,approval_id,reason) SELECT $1,id,1,'C'||lpad(n::text,5,'0'),'Synthetic closing account','','income','credit',true,$2,$3,'Synthetic close load' FROM synthetic_close_accounts",[f.a,f.actors.master.person,initial.body.approval.id]);
  await f.pg.exec('CREATE TEMP TABLE synthetic_close_journals AS SELECT gen_random_uuid() AS id,n FROM generate_series(1,4999) n');
  await f.pg.query("INSERT INTO public.finance_journals(academy_id,id,period_id,period_version,posted_on,description,line_count,posted_by,approval_id) SELECT $1,id,$2,1,'2026-06-01','Synthetic closing load',2,$3,$4 FROM synthetic_close_journals",[f.a,f.period.id,f.actors.master.person,initial.body.approval.id]);
  await f.pg.query("INSERT INTO public.finance_journal_lines(academy_id,journal_id,line_number,account_id,account_version,side,amount_minor) SELECT $1,j.id,l.n,CASE WHEN l.n=1 THEN $2::uuid ELSE a.id END,1,CASE WHEN l.n=1 THEN 'debit' ELSE 'credit' END,10000 FROM synthetic_close_journals j JOIN synthetic_close_accounts a ON a.n=(j.n-1)%4996+1 CROSS JOIN generate_series(1,2) l(n)",[f.a,f.cash.id]);await f.pg.exec('COMMIT');
 }catch(error){await f.pg.exec('ROLLBACK');throw error;}
 const body=await f.input(),before=f.metrics.businessQueries,start=performance.now(),r=await f.close(body);assert.equal(r.response.status,201,JSON.stringify({body:r.body,failures:f.metrics.queryFailures}));const elapsed=Math.ceil(performance.now()-start),queries=f.metrics.businessQueries-before;
 assert.equal(r.body.data.pairCount,4997);assert.equal(r.body.data.journalCount,50);assert.equal(r.body.data.sourceStamp.journals,'5000');
 const sums=(await f.pg.query<{n:number;largest:number}>('SELECT count(*)::integer AS n,max(line_count)::integer AS largest FROM public.finance_journals WHERE closing_run_id=$1',[r.body.data.id])).rows[0];assert.deepEqual(sums,{n:50,largest:200});
 const p=(await f.request('finance/periods/'+f.period.id+'/closing-preview')).body.data;assert.equal(p.temporaryGroupCount,'0');assert.equal(p.sourceJournalCount,undefined);assert.equal(p.sourceStamp.journals,'5050');
 const sheet=(await f.request('reports/finance/balance-sheet?through=2026-12-31')).body.data.currencies[0];assert.equal(sheet.equity.amount,'500000.00');assert.equal(sheet.unclosedPostedResult.minor,'0');assert.equal(sheet.balanced,true);
 console.log(JSON.stringify({measurement:'synthetic-reviewed-financial-close',accounts:5000,sourceJournals:5000,sourceLines:10000,closingPairs:4997,closingJournals:50,maximumLinesPerJournal:200,elapsedMs:elapsed,clientQueries:queries,productionStatementLimitMs:5000,externalPayments:0}));
});
