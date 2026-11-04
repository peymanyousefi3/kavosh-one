import assert from 'node:assert/strict';
import { randomUUID,createHash } from 'node:crypto';
import { test } from 'node:test';
import { readFile,readdir } from 'node:fs/promises';
import { operationsFixture } from './operations-fixture.ts';
import { maximumMinorUnits,formatMoney,formatMoneyTotal } from '../src/core/money.ts';
import { financialStatementSQL } from '../src/modules/financial-statements.ts';

async function fixture(){
  const f=await operationsFixture();for(const role of [f.managerRole,f.staffRole])for(const capability of ['financial-reports.view','ledger.view','accounts.view'])await f.pg.query("INSERT INTO public.role_permissions VALUES($1,$2,$3,'allow')",[f.a,role,capability]);
  const currency=await f.request('finance/currencies',{code:'CAD',name:'Canadian dollar',unitScale:2,reason:'Synthetic statement currency'});assert.equal(currency.response.status,201);
  const period=await f.request('finance/periods',{name:'Synthetic 2026',startsOn:'2026-01-01',endsOn:'2026-12-31',reason:'Synthetic statement period'});assert.equal(period.response.status,201);
  const account=async(code:string,kind:string,patch:Record<string,unknown>={})=>{const a=await f.request('finance/accounts',{code,name:'Synthetic '+code,kind,hubId:f.hub,currencyId:currency.body.data.id,currencyVersion:1,reason:'Synthetic statement account',...patch});assert.equal(a.response.status,201,JSON.stringify(a.body));return a.body.data;};
  const cash=await account('1000','asset'),liability=await account('2000','liability'),equity=await account('3000','equity'),income=await account('4000','income'),expense=await account('5000','expense');
  const base={periodId:period.body.data.id,periodVersion:1,postedOn:'2026-06-01',description:'Synthetic private source description',reason:'Synthetic statement posting'};
  const post=(debit:{id:string;version:number},credit:{id:string;version:number},amount='100.00',patch:Record<string,unknown>={})=>f.request('finance/journals',{...base,lines:[{accountId:debit.id,accountVersion:debit.version,side:'debit',amount,note:'Synthetic private debit note'},{accountId:credit.id,accountVersion:credit.version,side:'credit',amount}],...patch});
  const profit=(query='from=2026-01-01&through=2026-12-31',as='master')=>f.request('reports/finance/profit-loss?'+query,undefined,as),sheet=(query='through=2026-12-31',as='master')=>f.request('reports/finance/balance-sheet?'+query,undefined,as);
  return {...f,currency:currency.body.data,period:period.body.data,account,cash,liability,equity,income,expense,base,post,profit,sheet};
}
type Fixture=Awaited<ReturnType<typeof fixture>>;
function check(name:string,run:(f:Fixture)=>Promise<void>){test(name,async()=>{const f=await fixture();try{await run(f);}finally{await f.pg.close();}});}
check('posted profit/loss and balance-sheet equation reconcile income, expenses, liabilities, equity and unclosed result',async f=>{
  for(const [debit,credit,amount] of [[f.cash,f.income,'500.00'],[f.expense,f.cash,'200.00'],[f.cash,f.liability,'50.00'],[f.cash,f.equity,'100.00']] as const)assert.equal((await f.post(debit,credit,amount)).response.status,201);
  const profit=await f.profit();assert.equal(profit.response.status,200,JSON.stringify(profit.body));const p=profit.body.data.currencies[0];assert.equal(p.income.amount,'500.00');assert.equal(p.expenses.amount,'200.00');assert.equal(p.netResult.amount,'300.00');assert.equal(profit.body.data.accountCount,2);assert.equal(profit.body.data.classificationBasis,'as_posted_account_revision');assert.equal(profit.body.data.currencyConversion,'none');
  const sheet=await f.sheet();assert.equal(sheet.response.status,200,JSON.stringify(sheet.body));const s=sheet.body.data.currencies[0];assert.equal(s.assets.amount,'450.00');assert.equal(s.liabilities.amount,'50.00');assert.equal(s.equity.amount,'100.00');assert.equal(s.unclosedPostedResult.amount,'300.00');assert.equal(s.liabilitiesEquityAndResult.amount,'450.00');assert.equal(s.difference.amount,'0.00');assert.equal(s.balanced,true);assert.equal(sheet.body.data.entries.find((r:{kind:string})=>r.kind==='expense').amount.amount,'-200.00');
  for(const secret of ['Synthetic private source description','Synthetic private debit note'])assert.ok(!JSON.stringify(sheet.body).includes(secret));
});
check('profit/loss uses explicit inclusive range while balance sheet includes all earlier posted dates',async f=>{
  await f.post(f.cash,f.income,'100.00',{postedOn:'2026-01-01'});await f.post(f.cash,f.income,'500.00');await f.post(f.expense,f.cash,'200.00');await f.post(f.expense,f.cash,'20.00',{postedOn:'2026-07-01'});
  const june=await f.profit('from=2026-06-01&through=2026-06-30');assert.equal(june.response.status,200);assert.equal(june.body.data.currencies[0].netResult.amount,'300.00');assert.equal((await f.sheet('through=2026-06-30')).body.data.currencies[0].assets.amount,'400.00');assert.equal((await f.sheet('through=2025-12-31')).body.data.currencies.length,0);
});
check('credits to expense and debits to income reduce reported activity without losing signed exact values',async f=>{
  await f.post(f.cash,f.income,'500.00');await f.post(f.expense,f.cash,'200.00');await f.post(f.income,f.cash,'100.00');await f.post(f.cash,f.expense,'50.00');
  const p=(await f.profit()).body.data.currencies[0];assert.equal(p.income.amount,'400.00');assert.equal(p.expenses.amount,'150.00');assert.equal(p.netResult.amount,'250.00');assert.equal((await f.sheet()).body.data.currencies[0].balanced,true);
});
check('as-posted kinds survive later chart reclassification and one account pages as separate historical-kind groups',async f=>{
  await f.post(f.expense,f.cash,'100.00');const changed=await f.request('finance/accounts/'+f.expense.id+'/change',{expectedVersion:1,kind:'asset',name:'Reclassified account',translations:{fr:'Compte reclassé','zh-CN':'重新分类账户'},reason:'Synthetic prospective reclassification'});assert.equal(changed.response.status,200);
  assert.equal((await f.post(changed.body.data,f.cash,'50.00')).response.status,201);const p=await f.profit();assert.equal(p.body.data.currencies[0].expenses.amount,'100.00');assert.equal(p.body.data.entries[0].kind,'expense');assert.equal(p.body.data.entries[0].currentKind,'asset');assert.equal(p.body.data.entries[0].translations['zh-CN'],'重新分类账户');
  const first=await f.sheet('through=2026-12-31&limit=1');assert.equal(first.body.data.accountCount,2);assert.equal(first.body.data.rowCount,3);const second=await f.sheet('through=2026-12-31&limit=1&'+new URLSearchParams(first.body.nextCursor)),third=await f.sheet('through=2026-12-31&limit=1&'+new URLSearchParams(second.body.nextCursor));assert.equal(second.body.data.entries[0].accountId,f.expense.id);assert.equal(third.body.data.entries[0].accountId,f.expense.id);assert.equal(second.body.data.entries[0].kind,'asset');assert.equal(third.body.data.entries[0].kind,'expense');assert.equal(third.body.nextCursor,null);assert.equal(third.body.data.currencies[0].assets.amount,'-100.00');assert.equal(third.body.data.currencies[0].unclosedPostedResult.amount,'-100.00');assert.equal(third.body.data.currencies[0].balanced,true);
});
check('balance sheet does not duplicate a result that recorded entries already moved into equity',async f=>{
  await f.post(f.cash,f.income,'500.00');await f.post(f.expense,f.cash,'200.00');await f.post(f.income,f.equity,'500.00');await f.post(f.equity,f.expense,'200.00');
  const s=await f.sheet();assert.equal(s.response.status,200);assert.equal(s.body.data.currencies[0].assets.amount,'300.00');assert.equal(s.body.data.currencies[0].equity.amount,'300.00');assert.equal(s.body.data.currencies[0].unclosedPostedResult.amount,'0.00');assert.equal(s.body.data.currencies[0].balanced,true);assert.equal(s.body.data.journalPurposeTreatment,'all_posted_purposes');
});
check('explicit closing transfers leave operating profit intact while balance-sheet and ledger totals include their real entries',async f=>{
  await f.post(f.cash,f.income,'500.00');await f.post(f.expense,f.cash,'200.00');
  for(const [debit,credit,amount] of [[f.income,f.equity,'500.00'],[f.equity,f.expense,'200.00']] as const){const r=await f.post(debit,credit,amount,{purpose:'closing',postedOn:'2026-12-31'});assert.equal(r.response.status,201,JSON.stringify(r.body));assert.equal(r.body.data.purpose,'closing');}
  const p=(await f.profit()).body.data;assert.equal(p.currencies[0].income.amount,'500.00');assert.equal(p.currencies[0].expenses.amount,'200.00');assert.equal(p.currencies[0].netResult.amount,'300.00');assert.equal(p.journalPurposeTreatment,'activity_and_legacy_excluding_opening_closing');assert.equal(p.unclassifiedLineCount,'0');assert.equal(p.requiresPurposeReview,false);
  const s=(await f.sheet()).body.data.currencies[0];assert.equal(s.assets.amount,'300.00');assert.equal(s.equity.amount,'300.00');assert.equal(s.unclosedPostedResult.amount,'0.00');assert.equal(s.balanced,true);
  const ledger=await f.request('finance/accounts/'+f.income.id+'/balance?through=2026-12-31');assert.equal(ledger.body.data.closing.minor,'0');
  const close=(await f.request('finance/journals')).body.data.find((j:{purpose:string})=>j.purpose==='closing');
  const reversed=await f.request('finance/journals/'+close.id+'/reverse',{...f.base,postedOn:'2026-12-31'});assert.equal(reversed.response.status,201,JSON.stringify(reversed.body));assert.equal(reversed.body.data.purpose,'closing');assert.equal((await f.profit()).body.data.currencies[0].netResult.amount,'300.00');assert.equal((await f.sheet()).body.data.currencies[0].balanced,true);
});
check('purpose boundary dates, permitted account kinds and reserved legacy values cannot be bypassed through journal input',async f=>{
  assert.equal((await f.post(f.cash,f.equity,'100.00',{purpose:'opening',postedOn:'2026-01-01'})).response.status,201);
  assert.equal((await f.post(f.cash,f.equity,'100.00',{purpose:'opening'})).body.error.code,'PURPOSE_DATE_INVALID');
  assert.equal((await f.post(f.income,f.equity,'100.00',{purpose:'closing'})).body.error.code,'PURPOSE_DATE_INVALID');
  assert.equal((await f.post(f.cash,f.income,'100.00',{purpose:'opening',postedOn:'2026-01-01'})).body.error.code,'PURPOSE_ACCOUNT_INVALID');
  assert.equal((await f.post(f.cash,f.equity,'100.00',{purpose:'closing',postedOn:'2026-12-31'})).body.error.code,'PURPOSE_ACCOUNT_INVALID');
  for(const purpose of ['legacy_unclassified','arbitrary',null])assert.equal((await f.post(f.cash,f.equity,'100.00',{purpose})).response.status,400);
  const opening=(await f.request('finance/journals')).body.data[0],reversed=await f.request('finance/journals/'+opening.id+'/reverse',{...f.base,postedOn:'2026-06-15'});assert.equal(reversed.response.status,201);assert.equal(reversed.body.data.purpose,'opening');assert.equal((await f.sheet()).body.data.currencies.length,0);
});
check('native journal purpose constraints reject forged classifications, dates, account kinds and changes independently of the API',async f=>{
  const closing=await f.post(f.income,f.equity,'100.00',{purpose:'closing',postedOn:'2026-12-31'});assert.equal(closing.response.status,201);
  await f.pg.exec('SET ROLE kavosh_runtime');try{
    await f.pg.query("SELECT set_config('app.academy_id',$1,false)",[f.a]);
    await assert.rejects(f.pg.exec("UPDATE public.finance_journals SET purpose='activity'"),/permission denied/i);
    const invalid=async(purpose:string,date:string,debit:string,credit:string,pattern:RegExp,reverses:string|null=null)=>{
      const id=randomUUID();await f.pg.exec('BEGIN');try{
        await assert.rejects((async()=>{
          await f.pg.query("INSERT INTO public.finance_journals(academy_id,id,period_id,period_version,posted_on,description,line_count,posted_by,approval_id,purpose,reverses_id) VALUES($1,$2,$3,1,$4,'Synthetic invalid purpose',2,$5,$6,$7,$8)",[f.a,id,f.period.id,date,f.actors.master.person,closing.body.approval.id,purpose,reverses]);
          await f.pg.query("INSERT INTO public.finance_journal_lines(academy_id,journal_id,line_number,account_id,account_version,side,amount_minor) VALUES($1,$2,1,$3,1,'debit',10000),($1,$2,2,$4,1,'credit',10000)",[f.a,id,debit,credit]);
          await f.pg.exec('COMMIT');
        })(),pattern);
      }finally{await f.pg.exec('ROLLBACK');}
    };
    await invalid('opening','2026-06-01',f.cash.id,f.equity.id,/FINANCE_PURPOSE_DATE_INVALID/);
    await invalid('closing','2026-06-01',f.income.id,f.equity.id,/FINANCE_PURPOSE_DATE_INVALID/);
    await invalid('opening','2026-01-01',f.cash.id,f.income.id,/FINANCE_PURPOSE_ACCOUNT_INVALID/);
    await invalid('closing','2026-12-31',f.cash.id,f.equity.id,/FINANCE_PURPOSE_ACCOUNT_INVALID/);
    await invalid('legacy_unclassified','2026-06-01',f.cash.id,f.equity.id,/FINANCE_LEGACY_PURPOSE_RESERVED/);
    await invalid('activity','2026-12-31',f.equity.id,f.income.id,/FINANCE_REVERSAL_PURPOSE_INVALID/,closing.body.data.id);
    assert.equal((await f.pg.query('SELECT count(*)::integer AS count FROM public.finance_journals')).rows[0].count,1);
  }finally{await f.pg.exec('RESET ROLE');}
});
check('closing purpose is bound to the reviewed payload and critical audit, with upper approval and stale-account protection',async f=>{
  for(const capability of ['journals.view','journals.edit'])await f.pg.query("INSERT INTO public.role_permissions VALUES($1,$2,$3,'allow')",[f.a,f.managerRole,capability]);
  const input={...f.base,purpose:'closing',postedOn:'2026-12-31',lines:[{accountId:f.income.id,accountVersion:1,side:'debit',amount:'100.00'},{accountId:f.equity.id,accountVersion:1,side:'credit',amount:'100.00'}]},key=randomUUID();
  const pending=await f.request('finance/journals',input,'manager',{key});assert.equal(pending.response.status,202);assert.equal((await f.request('finance/journals')).body.data.length,0);assert.deepEqual((await f.request('finance/journals',input,'manager',{key})).body,pending.body);
  assert.equal((await f.approve(pending.body.approval.id,'manager')).response.status,403);
  const applied=await f.approve(pending.body.approval.id);assert.equal(applied.response.status,200);assert.equal(applied.body.data.purpose,'closing');assert.equal((await f.request('finance/journals/'+applied.body.data.id)).body.data.purpose,'closing');
  const event=(await f.request('audit-events')).body.data.find((e:{entity_id:string;action:string})=>e.entity_id===applied.body.data.id&&e.action==='finance.journal.posted');assert.ok(event);assert.equal(event.changes.purpose,'closing');assert.equal(event.changes.severity,'critical');
  const next=await f.request('finance/journals',input,'manager');assert.equal(next.response.status,202);
  await f.request('finance/accounts/'+f.income.id+'/change',{expectedVersion:1,kind:'asset',reason:'Synthetic prospective chart change invalidates pending close'});
  const stale=await f.approve(next.body.approval.id);assert.equal(stale.response.status,409);assert.equal(stale.body.approval.decisionCode,'DEPENDENCIES_CHANGED');assert.equal((await f.request('finance/journals')).body.data.length,1);
});
test('actual schema31 journals remain unclassified on migration and warnings survive zero balances, filters and exact reversals',async()=>{
  const f=await operationsFixture({throughSchema:31}),approval=randomUUID(),currency=randomUUID(),period=randomUUID(),cash=randomUUID(),income=randomUUID(),first=randomUUID(),second=randomUUID();
  try{
    // Seed actual old-schema rows as the test owner, without installing or
    // backdating a purpose. The new API correctly refuses this old schema.
    assert.equal((await f.request('finance/journals')).response.status,503);
    await f.pg.exec('BEGIN');try{
      await f.pg.query("INSERT INTO public.approval_requests(academy_id,id,requester_id,requester_kind,credential_snapshot,grants_hash,dependency_hash,review_context,action,target_id,target_version,payload,scope,status,reviewer_id,decided_at) VALUES($1,$2,$3,'human','{}',repeat('0',64),repeat('0',64),'{}','synthetic.seed',$2,0,'{}','{}','applied',$3,now())",[f.a,approval,f.actors.master.person]);
      await f.pg.query("INSERT INTO public.finance_currencies(academy_id,id,code,created_by) VALUES($1,$2,'CAD',$3)",[f.a,currency,f.actors.master.person]);
      await f.pg.query("INSERT INTO public.finance_currency_revisions(academy_id,currency_id,version,name,symbol,unit_scale,active,changed_by,approval_id,reason) VALUES($1,$2,1,'Synthetic legacy CAD','$',2,true,$3,$4,'Synthetic old evidence')",[f.a,currency,f.actors.master.person,approval]);
      await f.pg.query("INSERT INTO public.finance_periods(academy_id,id,starts_on,ends_on,created_by) VALUES($1,$2,'2026-01-01','2026-12-31',$3)",[f.a,period,f.actors.master.person]);
      await f.pg.query("INSERT INTO public.finance_period_revisions(academy_id,period_id,version,name,state,changed_by,approval_id,reason) VALUES($1,$2,1,'Synthetic old year','open',$3,$4,'Synthetic old evidence')",[f.a,period,f.actors.master.person,approval]);
      for(const [id,code,kind,side] of [[cash,'1000','asset','debit'],[income,'4000','income','credit']]){
        await f.pg.query('INSERT INTO public.finance_accounts(academy_id,id,hub_id,currency_id,currency_version,code,created_by) VALUES($1,$2,$3,$4,1,$5,$6)',[f.a,id,f.hub,currency,code,f.actors.master.person]);
        await f.pg.query("INSERT INTO public.finance_account_revisions(academy_id,account_id,version,code,name,description,kind,normal_balance,active,changed_by,approval_id,reason) VALUES($1,$2,1,$3,'Synthetic old account','',$4,$5,true,$6,$7,'Synthetic old evidence')",[f.a,id,code,kind,side,f.actors.master.person,approval]);
      }
      for(const [id,debit,credit] of [[first,cash,income],[second,income,cash]]){
        await f.pg.query("INSERT INTO public.finance_journals(academy_id,id,period_id,period_version,posted_on,description,line_count,posted_by,approval_id) VALUES($1,$2,$3,1,'2026-06-01','Synthetic old journal',2,$4,$5)",[f.a,id,period,f.actors.master.person,approval]);
        await f.pg.query("INSERT INTO public.finance_journal_lines(academy_id,journal_id,line_number,account_id,account_version,side,amount_minor) VALUES($1,$2,1,$3,1,'debit',10000),($1,$2,2,$4,1,'credit',10000)",[f.a,id,debit,credit]);
      }
      await f.pg.exec('COMMIT');
    }catch(error){await f.pg.exec('ROLLBACK');throw error;}
    const before=(await f.pg.query('SELECT to_jsonb(j) AS original FROM public.finance_journals j ORDER BY id')).rows;
    for(const migration of (await readdir(new URL('../db/migrations/',import.meta.url))).filter(n=>Number.parseInt(n,10)>=32&&n.endsWith('.sql')).sort())await f.pg.exec(await readFile(new URL('../db/migrations/'+migration,import.meta.url),'utf8'));
    assert.deepEqual((await f.pg.query("SELECT to_jsonb(j)-ARRAY['purpose','closing_run_id'] AS original FROM public.finance_journals j ORDER BY id")).rows,before);
    assert.ok((await f.pg.query('SELECT closing_run_id FROM public.finance_journals')).rows.every(r=>r.closing_run_id===null));
    assert.deepEqual((await f.pg.query('SELECT DISTINCT purpose FROM public.finance_journals')).rows,[{purpose:'legacy_unclassified'}]);
    const profit=await f.request('reports/finance/profit-loss?from=2026-01-01&through=2026-12-31&limit=1');assert.equal(profit.response.status,200,JSON.stringify(profit.body));assert.equal(profit.body.data.currencies.length,0);assert.equal(profit.body.data.requiresPurposeReview,true);assert.equal(profit.body.data.unclassifiedLineCount,'2');
    const sheet=await f.request('reports/finance/balance-sheet?through=2026-12-31');assert.equal(sheet.body.data.unclassifiedLineCount,'4');assert.equal(sheet.body.data.requiresPurposeReview,true);
    const empty=await f.request('reports/finance/profit-loss?from=2026-01-01&through=2026-12-31&accountIds='+randomUUID());assert.equal(empty.body.data.unclassifiedLineCount,'0');assert.equal(empty.body.data.requiresPurposeReview,false);
    const reversed=await f.request('finance/journals/'+first+'/reverse',{periodId:period,periodVersion:1,postedOn:'2026-07-01',description:'Synthetic legacy inverse',reason:'Preserve unknown purpose'});assert.equal(reversed.response.status,201,JSON.stringify(reversed.body));assert.equal(reversed.body.data.purpose,'legacy_unclassified');assert.equal((await f.request('reports/finance/profit-loss?from=2026-01-01&through=2026-12-31')).body.data.unclassifiedLineCount,'3');
  }finally{await f.pg.close();}
});
check('pre-purpose pending journal payloads require fresh review instead of silently defaulting to activity after upgrade',async f=>{
  for(const capability of ['journals.view','journals.edit'])await f.pg.query("INSERT INTO public.role_permissions VALUES($1,$2,$3,'allow')",[f.a,f.managerRole,capability]);
  const input={...f.base,lines:[{accountId:f.cash.id,accountVersion:1,side:'debit',amount:'100.00'},{accountId:f.income.id,accountVersion:1,side:'credit',amount:'100.00'}]},pending=await f.request('finance/journals',input,'manager');assert.equal(pending.response.status,202);
  // Test owner reconstructs the exact former dependency shape/order, removing
  // only fields that did not exist before the purpose upgrade. Live users
  // cannot edit immutable pending payloads, contexts or their stored hashes.
  const context=(await f.pg.query<{review_context:{period:{version:number;state:string;starts_on:string;ends_on:string};accounts:{id:string;version:number;active:boolean;currency_version:number}[]}}>('SELECT review_context FROM public.approval_requests WHERE id=$1',[pending.body.approval.id])).rows[0].review_context;
  const oldContext={period:{version:context.period.version,state:context.period.state,starts_on:context.period.starts_on,ends_on:context.period.ends_on},accounts:context.accounts.map(a=>({id:a.id,version:a.version,active:a.active,currency_version:a.currency_version})),source:null};
  const oldHash=createHash('sha256').update(JSON.stringify(oldContext)).digest('hex');
  await f.pg.query("UPDATE public.approval_requests SET payload=payload-'purpose',review_context=$2::jsonb,dependency_hash=$3 WHERE id=$1",[pending.body.approval.id,JSON.stringify(oldContext),oldHash]);
  const reviewed=await f.approve(pending.body.approval.id);assert.equal(reviewed.response.status,409,JSON.stringify(reviewed.body));assert.equal(reviewed.body.approval.decisionCode,'DEPENDENCIES_CHANGED');assert.equal((await f.request('finance/journals')).body.data.length,0);
  const fresh=await f.request('finance/journals',{...input,purpose:'activity'},'manager');assert.equal(fresh.response.status,202);assert.equal((await f.approve(fresh.body.approval.id)).response.status,200);
});
check('narrow financial views do not invent counterparties or expose foreign-hub activity and require all three permissions',async f=>{
  const other=await f.account('4000','income',{hubId:f.otherHub});await f.post(f.cash,other,'100.00');const profit=await f.profit('from=2026-01-01&through=2026-12-31','staff'),sheet=await f.sheet('through=2026-12-31','staff');assert.equal(profit.response.status,200);assert.equal(profit.body.data.currencies.length,0);assert.equal(profit.body.data.scopeMayOmitCounterparties,true);assert.equal(sheet.body.data.currencies[0].assets.amount,'100.00');assert.equal(sheet.body.data.currencies[0].balanced,false);assert.equal(sheet.body.data.currencies[0].difference.amount,'100.00');assert.ok(!JSON.stringify(sheet.body).includes(other.id));
  await f.pg.query("DELETE FROM public.role_permissions WHERE role_id=$1 AND capability='ledger.view'",[f.staffRole]);assert.equal((await f.profit('from=2026-01-01&through=2026-12-31','staff')).response.status,403);assert.equal((await f.sheet('through=2026-12-31','staff')).response.status,403);assert.equal((await f.request('reports/finance/balance-sheet?through=2026-12-31',undefined,'foreignMaster',{academy:f.b})).body.data.accountCount,0);
});
check('statement currency groups retain precision and large values without guessed FX or unsafe JSON numbers',async f=>{
  await f.request('finance/currencies/'+f.currency.id+'/change',{expectedVersion:1,unitScale:3,reason:'Synthetic statement precision'});const finer=await f.account('4100','income',{currencyVersion:2});assert.equal((await f.post(f.cash,finer,'1.00')).response.status,201);
  const p=await f.profit();assert.equal(p.body.data.currencies[0].income.amount,'1.000');const s=await f.sheet();assert.equal(s.body.data.currencies[0].assets.amount,'1.000');assert.equal(s.body.data.currencies[0].balanced,true);
  const usd=await f.request('finance/currencies',{code:'USD',name:'US dollar',unitScale:2,reason:'Synthetic foreign currency'}),cash=await f.account('1100','asset',{currencyId:usd.body.data.id}),income=await f.account('4200','income',{currencyId:usd.body.data.id});const large=formatMoney(maximumMinorUnits,2);assert.equal((await f.post(cash,income,large)).response.status,201);assert.equal((await f.post(cash,income,large)).response.status,201);
  const r=await f.profit(),u=r.body.data.currencies.find((c:{currencyCode:string})=>c.currencyCode==='USD');assert.equal(u.netResult.minor,(2n*maximumMinorUnits).toString());assert.equal(u.netResult.amount,formatMoneyTotal(2n*maximumMinorUnits,2));assert.equal(r.body.data.currencies.length,2);const filtered=await f.profit('from=2026-01-01&through=2026-12-31&currencyIds='+usd.body.data.id);assert.equal(filtered.body.data.currencies.length,1);assert.equal(filtered.body.data.coverage,'complete_selected_currencies');
});
check('statement reads honor reversals by their dates and reject incomplete ranges, cursors and unsupported query mutations',async f=>{
  const posted=await f.post(f.cash,f.income,'100.00');assert.equal((await f.request('finance/journals/'+posted.body.data.id+'/reverse',{...f.base,postedOn:'2026-07-01'})).response.status,201);assert.equal((await f.profit('from=2026-06-01&through=2026-06-30')).body.data.currencies[0].netResult.amount,'100.00');assert.equal((await f.profit('from=2026-07-01&through=2026-07-31')).body.data.currencies[0].netResult.amount,'-100.00');assert.equal((await f.sheet()).body.data.currencies.length,0);
  for(const query of ['through=2026-12-31','from=2026-12-31&through=2026-01-01','from=2026-02-30&through=2026-12-31','from=2026-01-01&through=2026-12-31&afterKind=income','from=2026-01-01&through=2026-12-31&includeZero=true'])assert.equal((await f.profit(query)).response.status,400,query);
  assert.equal((await f.sheet('from=2026-01-01&through=2026-12-31')).response.status,400);assert.equal((await f.request('reports/finance/profit-loss',{from:'2026-01-01',through:'2026-12-31'})).response.status,405);
});
check('statement calculations handle the reproduced integral decimal minor-unit representation without rewriting its stored value',async f=>{
  const initial=await f.post(f.cash,f.income,'100.00'),id=randomUUID();assert.equal(initial.response.status,201);await f.pg.exec('SET ROLE kavosh_runtime');try{
    await f.pg.query("SELECT set_config('app.academy_id',$1,false)",[f.a]);await f.pg.exec('BEGIN');try{
      await f.pg.query("INSERT INTO public.finance_journals(academy_id,id,period_id,period_version,posted_on,description,line_count,posted_by,approval_id) VALUES($1,$2,$3,1,'2026-06-01','Synthetic statement numeric scale',2,$4,$5)",[f.a,id,f.period.id,f.actors.master.person,initial.body.approval.id]);
      await f.pg.query("INSERT INTO public.finance_journal_lines(academy_id,journal_id,line_number,account_id,account_version,side,amount_minor) VALUES($1,$2,1,$3,1,'debit',10000),($1,$2,2,$4,1,'credit',10000.000)",[f.a,id,f.cash.id,f.income.id]);await f.pg.exec('COMMIT');
    }catch(error){await f.pg.exec('ROLLBACK');throw error;}
  }finally{await f.pg.exec('RESET ROLE');}
  const p=await f.profit(),s=await f.sheet();assert.equal(p.response.status,200);assert.equal(s.response.status,200);assert.equal(p.body.data.currencies[0].netResult.minor,'20000');assert.equal(s.body.data.currencies[0].assets.minor,'20000');assert.equal(s.body.data.currencies[0].balanced,true);assert.equal((await f.pg.query<{value:string}>('SELECT amount_minor::text AS value FROM public.finance_journal_lines WHERE journal_id=$1 AND line_number=2',[id])).rows[0].value,'10000.000');
});
if(process.env.TEST_DATABASE_URL)check('five thousand posted journals reconcile under one hundred parallel profit/loss and balance-sheet requests',async f=>{
  const initial=await f.post(f.cash,f.income,'100.00');assert.equal(initial.response.status,201);await f.pg.exec('BEGIN');try{
    await f.pg.exec('CREATE TEMP TABLE synthetic_statement_journals AS SELECT gen_random_uuid() AS id FROM generate_series(1,4999)');
    await f.pg.query(`INSERT INTO public.finance_journals(academy_id,id,period_id,period_version,posted_on,description,line_count,posted_by,approval_id) SELECT $1,s.id,$2,1,'2026-06-01','Synthetic statement load',2,$3,$4 FROM synthetic_statement_journals s`,[f.a,f.period.id,f.actors.master.person,initial.body.approval.id]);
    await f.pg.query(`INSERT INTO public.finance_journal_lines(academy_id,journal_id,line_number,account_id,account_version,side,amount_minor) SELECT $1,s.id,l.n,CASE WHEN l.n=1 THEN $2::uuid ELSE $3::uuid END,1,CASE WHEN l.n=1 THEN 'debit' ELSE 'credit' END,10000 FROM synthetic_statement_journals s CROSS JOIN generate_series(1,2) l(n)`,[f.a,f.cash.id,f.income.id]);await f.pg.exec('COMMIT');
  }catch(error){await f.pg.exec('ROLLBACK');throw error;}
  const before=f.metrics.businessQueries,durations:number[]=[];await Promise.all(Array.from({length:100},async(_,i)=>{const start=performance.now(),isSheet=i%2===0,r=await (isSheet?f.sheet('through=2026-12-31','staff'):f.profit('from=2026-01-01&through=2026-12-31','staff'));durations.push(performance.now()-start);assert.equal(r.response.status,200,JSON.stringify({response:r.body,queryFailures:f.metrics.queryFailures}));assert.equal(r.body.data.entries.length,isSheet?2:1);const c=r.body.data.currencies[0];if(isSheet){assert.equal(c.assets.minor,'50000000');assert.equal(c.balanced,true);}else assert.equal(c.netResult.minor,'50000000');assert.equal(r.body.data.coverage,'scoped_selected_accounts');}));
  const queries=f.metrics.businessQueries-before;assert.equal(queries,1200);console.log(JSON.stringify({measurement:'synthetic-posted-statements',journals:5000,postedLines:10000,concurrentRequests:100,profitLossRequests:50,balanceSheetRequests:50,principals:1,poolMaximum:4,validatedResponses:100,rowsPerResponse:{profitLoss:1,balanceSheet:2},p99Ms:Math.ceil(durations.sort((a,b)=>a-b)[98]),clientQueries:queries,bankRequests:0}));
  type Plan={'Rows Removed by Join Filter'?:number;'Actual Loops'?:number;Plans?:Plan[]};
  await f.pg.exec('SET ROLE kavosh_runtime');try{
    await f.pg.query("SELECT set_config('app.academy_id',$1,false),set_config('statement_timeout','5000',false)",[f.a]);
    for(const sheet of [false,true]){
      const plan=(await f.pg.query<{'QUERY PLAN':{Plan:Plan;'Execution Time':number}[]}>('EXPLAIN(ANALYZE,BUFFERS,TIMING OFF,FORMAT JSON) '+financialStatementSQL,[false,[f.hub],[],false,'2026-12-31',null,null,null,sheet?null:'2026-01-01',sheet,null,null,null,101])).rows[0]['QUERY PLAN'][0];
      const rejected=(n:Plan):number=>(n['Rows Removed by Join Filter']??0)*(n['Actual Loops']??1)+(n.Plans??[]).reduce((total,p)=>total+rejected(p),0),pairs=rejected(plan.Plan);assert.ok(pairs<500000,'must not rescan a whole date range for each posted line');
      console.log(JSON.stringify({measurement:'statement-plan-after-load',report:sheet?'balance-sheet':'profit-loss',journals:5000,rejectedJoinPairs:pairs,executionMs:Math.ceil(plan['Execution Time']),productionStatementLimitMs:5000}));
    }
  }finally{await f.pg.exec('RESET ROLE');await f.pg.exec('RESET statement_timeout');await f.pg.exec('RESET app.academy_id');}
});
