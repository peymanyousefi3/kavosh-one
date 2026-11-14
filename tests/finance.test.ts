import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { operationsFixture } from './operations-fixture.ts';

async function fixture(){
  const f=await operationsFixture();
  for(const role of [f.managerRole,f.staffRole])await f.pg.query("INSERT INTO public.role_permissions VALUES($1,$2,'accounts.view','allow')",[f.a,role]);
  await f.pg.query("INSERT INTO public.role_permissions VALUES($1,$2,'accounts.edit','allow')",[f.a,f.managerRole]);
  for(const capability of ['currencies.view','currencies.edit'])await f.pg.query("INSERT INTO public.role_permissions VALUES($1,$2,$3,'allow')",[f.a,f.policyRole,capability]);
  const currency=(patch:Record<string,unknown>={},as='master',key?:string)=>f.request('finance/currencies',{code:'CAD',name:'Canadian dollar',symbol:'C$',unitScale:2,reason:'Synthetic currency setup',...patch},as,{key});
  const account=(currencyId:string,patch:Record<string,unknown>={},as='master',key?:string)=>f.request('finance/accounts',{code:'1000',name:'Synthetic cash account',kind:'asset',currencyId,currencyVersion:1,hubId:f.hub,reason:'Synthetic chart setup',...patch},as,{key});
  return {...f,currency,account};
}
type Fixture=Awaited<ReturnType<typeof fixture>>;
function check(name:string,run:(f:Fixture)=>Promise<void>){test(name,async()=>{const f=await fixture();try{await run(f);}finally{await f.pg.close();}});}

check('master currency and account setup persist reviewed definitions without inventing balances, rates or transactions',async f=>{
  const c=await f.currency();assert.equal(c.response.status,201,JSON.stringify(c.body));assert.equal(c.body.approval.selfApproved,true);assert.equal(c.body.data.unitScale,2);
  const a=await f.account(c.body.data.id);assert.equal(a.response.status,201,JSON.stringify(a.body));assert.equal(a.body.data.currencyVersion,1);assert.equal(a.body.data.unitScale,2);assert.equal(a.body.data.normalBalance,'debit');assert.equal(a.body.data.balance,undefined);assert.equal(a.body.data.exchangeRate,undefined);
  const read=await f.request('finance/accounts/'+a.body.data.id);assert.equal(read.body.data.currencyCode,'CAD');assert.equal(read.body.data.name,'Synthetic cash account');assert.equal((await f.request('finance/accounts')).body.data.length,1);
  assert.equal((await f.request('finance/currencies')).body.data.length,1);assert.equal((await f.request('finance/accounts/'+a.body.data.id+'/history')).body.data[0].approvalId,a.body.approval.id);
});
check('non-master financial configuration waits for an upper human and preserves private exact-payload approval history',async f=>{
  const pending=await f.currency({},'manager');assert.equal(pending.response.status,202,JSON.stringify(pending.body));assert.equal((await f.request('finance/currencies')).body.data.length,0);assert.equal((await f.approve(pending.body.approval.id,'manager')).response.status,403);
  const approved=await f.approve(pending.body.approval.id);assert.equal(approved.response.status,200,JSON.stringify(approved.body));const id=approved.body.data.id;
  const a=await f.account(id,{},'manager');assert.equal(a.response.status,202,JSON.stringify(a.body));assert.equal((await f.request('finance/accounts')).body.data.length,0);assert.equal((await f.approve(a.body.approval.id)).response.status,200);
  const secret='Synthetic confidential financial correction '+randomUUID();const change=await f.request('finance/currencies/'+id+'/change',{expectedVersion:1,name:secret,reason:secret},'manager');assert.equal(change.response.status,202);assert.equal((await f.approve(change.body.approval.id)).response.status,200);
  assert.ok(!JSON.stringify((await f.request('audit-events')).body).includes(secret));assert.equal((await f.request('finance/currencies/'+id+'/history')).body.data[1].reason,secret);
});
check('account records pin currency precision while later definitions and partial metadata corrections preserve immutable earlier values',async f=>{
  const c=await f.currency({translations:{en:'Canadian dollar',fr:'Dollar canadien','zh-CN':'加元'}}),currency=c.body.data.id,a=await f.account(currency,{description:'Keep this note',active:false,translations:{fr:'Caisse'}});assert.equal(a.response.status,201);
  const changed=await f.request('finance/currencies/'+currency+'/change',{expectedVersion:1,unitScale:3,translations:{fr:null},reason:'Synthetic unit revision'});assert.equal(changed.response.status,200,JSON.stringify(changed.body));assert.deepEqual(changed.body.data.translations,{en:'Canadian dollar','zh-CN':'加元'});
  const old=await f.request('finance/accounts/'+a.body.data.id);assert.equal(old.body.data.unitScale,2);assert.equal(old.body.data.currencyVersion,1);
  assert.equal((await f.account(currency,{code:'1001'})).body.error.code,'CURRENCY_CHANGED');const newAccount=await f.account(currency,{code:'1001',currencyVersion:2});assert.equal(newAccount.response.status,201);assert.equal(newAccount.body.data.unitScale,3);
  const patch=await f.request('finance/accounts/'+a.body.data.id+'/change',{expectedVersion:1,name:'Renamed cash',reason:'Synthetic account rename'});assert.equal(patch.response.status,200,JSON.stringify(patch.body));assert.equal(patch.body.data.description,'Keep this note');assert.equal(patch.body.data.active,false);assert.equal(patch.body.data.unitScale,2);
  const history=await f.request('finance/accounts/'+a.body.data.id+'/history');assert.equal(history.body.data[0].name,'Synthetic cash account');assert.equal(history.body.data[1].name,'Renamed cash');assert.equal((await f.request('finance/currencies/'+currency+'/history')).body.data[0].unitScale,2);
});
check('hub-scoped account readers do not gain other-hub/global financial data or private history from generic directory rights',async f=>{
  const currency=(await f.currency()).body.data.id,own=await f.account(currency),other=await f.account(currency,{hubId:f.otherHub}),global=await f.account(currency,{hubId:null});assert.equal(global.response.status,201);
  const list=await f.request('finance/accounts',undefined,'staff');assert.equal(list.response.status,200);assert.deepEqual(list.body.data.map((r:{id:string})=>r.id),[own.body.data.id]);assert.equal(list.body.data[0].currencyCode,'CAD');
  assert.equal((await f.request('finance/accounts/'+other.body.data.id,undefined,'staff')).response.status,404);assert.equal((await f.request('finance/accounts/'+global.body.data.id,undefined,'staff')).response.status,404);assert.equal((await f.request('finance/accounts/'+own.body.data.id+'/history',undefined,'staff')).response.status,403);
  assert.equal((await f.request('finance/currencies',undefined,'staff')).response.status,403);assert.equal((await f.account(currency,{hubId:f.otherHub,code:'1001'},'manager')).response.status,403);
  assert.equal((await f.request('finance/accounts?hubId='+f.otherHub,undefined,'staff')).body.data.length,0);
});
check('finance setup rejects inactive/stale units, silent reparenting, fake balances and duplicate codes while allowing contra accounts',async f=>{
  const c=await f.currency(),currency=c.body.data.id,a=await f.account(currency,{normalBalance:'credit'});assert.equal(a.response.status,201);assert.equal(a.body.data.normalBalance,'credit');
  assert.equal((await f.currency()).body.error.code,'CURRENCY_CODE_EXISTS');assert.equal((await f.account(currency)).body.error.code,'ACCOUNT_CODE_EXISTS');assert.equal((await f.account(currency,{hubId:f.otherHub})).response.status,201);
  for(const patch of [{balance:'100.00'},{hubId:f.otherHub},{currencyVersion:2},{currencyId:randomUUID()}])assert.equal((await f.request('finance/accounts/'+a.body.data.id+'/change',{expectedVersion:1,reason:'Invalid immutable correction',...patch})).response.status,400);
  for(const patch of [{code:'usd'},{unitScale:1.5},{unitScale:19},{translations:{de:'EUR'}},{balance:'0'}])assert.equal((await f.currency({code:'USD',...patch})).response.status,400);
  await f.request('finance/currencies/'+currency+'/change',{expectedVersion:1,active:false,reason:'Synthetic currency inactive'});assert.equal((await f.account(currency,{code:'1001',currencyVersion:2})).body.error.code,'ACTIVE_CURRENCY_REQUIRED');assert.equal((await f.request('finance/accounts/'+a.body.data.id)).body.data.unitScale,2);
});
check('finance mutations keep durable retries, current authorization and transactional audit/outbox rollback',async f=>{
  const key=randomUUID(),c=await f.currency({},'master',key);assert.equal(c.response.status,201);assert.deepEqual((await f.currency({},'master',key)).body,c.body);
  const id=c.body.data.id,accountKey=randomUUID(),a=await f.account(id,{},'master',accountKey);assert.deepEqual((await f.account(id,{},'master',accountKey)).body,a.body);
  await f.pg.exec('REVOKE INSERT ON public.outbox_events FROM kavosh_runtime');try{assert.equal((await f.request('finance/accounts/'+a.body.data.id+'/change',{expectedVersion:1,name:'Must roll back',reason:'Synthetic event failure'})).response.status,503);}finally{await f.pg.exec('GRANT INSERT ON public.outbox_events TO kavosh_runtime');}
  assert.equal((await f.request('finance/accounts/'+a.body.data.id)).body.data.version,1);assert.equal((await f.request('finance/accounts/'+a.body.data.id+'/history')).body.data.length,1);
  await f.pg.query("DELETE FROM public.role_permissions WHERE role_id=$1 AND capability='accounts.edit'",[f.managerRole]);assert.equal((await f.account(id,{code:'1001'},'manager')).response.status,403);
});
check('native currency/account history is append-only, contiguous and tenant-bound with stable ownership/currency references',async f=>{
  const c=await f.currency(),currency=c.body.data.id,a=await f.account(currency);assert.equal(a.response.status,201);
  await f.pg.exec('SET ROLE kavosh_runtime');try {
    await f.pg.query("SELECT set_config('app.academy_id',$1,false)",[f.b]);assert.equal((await f.pg.query('SELECT * FROM public.finance_account_catalogue')).rows.length,0);assert.equal((await f.pg.query('SELECT * FROM public.finance_currency_revisions')).rows.length,0);
    await f.pg.query("SELECT set_config('app.academy_id',$1,false)",[f.a]);
    for(const table of ['finance_currency_revisions','finance_account_revisions']){await assert.rejects(f.pg.query('DELETE FROM public.'+table),/permission denied/i);await assert.rejects(f.pg.query('UPDATE public.'+table+' SET reason=\'changed\''),/permission denied/i);}
    await assert.rejects(f.pg.query('UPDATE public.finance_accounts SET hub_id=$1',[f.otherHub]),/permission denied/i);await assert.rejects(f.pg.query('UPDATE public.finance_accounts SET currency_version=2'),/permission denied/i);await assert.rejects(f.pg.query('UPDATE public.finance_currencies SET code=\'USD\''),/permission denied/i);
    await assert.rejects(f.pg.query('UPDATE public.finance_accounts SET version=version+2'),/FINANCE_VERSION_SEQUENCE/);await assert.rejects(f.pg.query('UPDATE public.finance_accounts SET code=\'2000\''),/FINANCE_VERSION_SEQUENCE/);
    await assert.rejects(f.pg.query(`INSERT INTO public.finance_currency_revisions(academy_id,currency_id,version,name,symbol,unit_scale,active,changed_by,approval_id,reason) VALUES($1,$2,9,'Forged','',2,true,$3,$4,'Invalid future revision')`,[f.a,currency,f.actors.master.person,c.body.approval.id]),/FINANCE_REVISION_MISMATCH/);
    await assert.rejects(f.pg.query('UPDATE public.finance_currencies SET version=version+1 WHERE id=$1',[currency]),/foreign key|finance_currency_current_revision/i);
  }finally{await f.pg.exec('RESET ROLE');}
});
check('pending account setup becomes stale when its currency definition changes and machine identities cannot self-approve finance',async f=>{
  const currency=(await f.currency()).body.data.id,pending=await f.account(currency,{},'manager');assert.equal(pending.response.status,202);
  await f.request('finance/currencies/'+currency+'/change',{expectedVersion:1,unitScale:3,reason:'Invalidate pending account assumptions'});const stale=await f.approve(pending.body.approval.id);assert.equal(stale.response.status,409);assert.equal(stale.body.approval.decisionCode,'DEPENDENCIES_CHANGED');assert.equal((await f.request('finance/accounts')).body.data.length,0);
  const bot=await f.currency({code:'USD'},'bot');assert.equal(bot.response.status,202);assert.equal((await f.approve(bot.body.approval.id,'bot')).response.status,403);assert.equal((await f.approve(bot.body.approval.id)).response.status,200);
});
check('financial editors losing private capability cannot recover their own pending payload through approval list/detail',async f=>{
  const currency=(await f.currency()).body.data.id,pending=await f.account(currency,{},'manager');assert.equal(pending.response.status,202);const id=pending.body.approval.id;
  assert.equal((await f.request('approvals/'+id,undefined,'manager')).response.status,200);
  await f.pg.query("DELETE FROM public.role_permissions WHERE role_id=$1 AND capability='accounts.edit'",[f.managerRole]);
  assert.equal((await f.request('approvals/'+id,undefined,'manager')).response.status,404);assert.ok(!(await f.request('approvals',undefined,'manager')).body.data.some((p:{id:string})=>p.id===id));assert.equal((await f.request('approvals/'+id)).response.status,200);
  const invalidated=await f.approve(id);assert.equal(invalidated.response.status,409);assert.equal(invalidated.body.approval.decisionCode,'AUTHORITY_CHANGED');assert.equal((await f.request('finance/accounts')).body.data.length,0);
});
check('explicit hub denial subtracts from broad financial rights and cannot expose unassigned school accounts',async f=>{
  const currency=(await f.currency()).body.data.id,own=await f.account(currency),other=await f.account(currency,{hubId:f.otherHub}),global=await f.account(currency,{hubId:null});assert.equal(global.response.status,201);
  const permissions=(effect:string)=>['accounts.view','accounts.edit'].map(capability=>({capability,effect}));
  const allow=await f.request('roles',{name:'Broad finance',permissions:permissions('allow')}),deny=await f.request('roles',{name:'Denied finance hub',permissions:permissions('deny')});assert.equal(allow.response.status,201);assert.equal(deny.response.status,201);
  const before=(await f.request('people/'+f.actors.staff.person+'/access')).body.data;
  assert.equal((await f.request('people/'+f.actors.staff.person+'/access',{expectedVersion:before.version,assignments:[{roleId:f.staffRole,allHubs:false,hubIds:[f.hub]},{roleId:allow.body.data.id,allHubs:true},{roleId:deny.body.data.id,allHubs:false,hubIds:[f.hub]}]})).response.status,200);
  const list=await f.request('finance/accounts',undefined,'staff');assert.deepEqual(list.body.data.map((r:{id:string})=>r.id),[other.body.data.id]);assert.equal((await f.request('finance/accounts/'+own.body.data.id,undefined,'staff')).response.status,404);assert.equal((await f.request('finance/accounts/'+global.body.data.id,undefined,'staff')).response.status,404);
  const locks=f.metrics.sharedPolicyLocks;assert.equal((await f.request('finance/accounts/'+own.body.data.id+'/change',{expectedVersion:1,name:'Forbidden',reason:'Scope denial'},'staff')).response.status,404);assert.equal(f.metrics.sharedPolicyLocks,locks);
});
check('currency grants are school-wide, account codes are unique within their owner and lookups filter before paging',async f=>{
  const currency=(await f.currency()).body.data.id;
  await f.pg.query("INSERT INTO public.role_permissions VALUES($1,$2,'currencies.view','allow')",[f.a,f.staffRole]);assert.equal((await f.request('finance/currencies',undefined,'staff')).response.status,403);
  const global=await f.account(currency,{hubId:null});assert.equal(global.response.status,201);assert.equal((await f.account(currency,{hubId:null})).body.error.code,'ACCOUNT_CODE_EXISTS');
  for(const [code,name] of [['1100','Cash % literal'],['1200','中文财务账户'],['1300','Cash plain']])assert.equal((await f.account(currency,{code,name})).response.status,201);
  assert.equal((await f.request('finance/accounts?q=%25')).body.data[0].name,'Cash % literal');assert.equal((await f.request('finance/accounts?q='+encodeURIComponent('中文'))).body.data.length,1);
  const first=await f.request('finance/accounts?limit=1',undefined,'staff');assert.equal(first.body.data.length,1);assert.ok(first.body.nextCursor);const second=await f.request('finance/accounts?limit=1&after='+first.body.nextCursor,undefined,'staff');assert.notEqual(second.body.data[0].id,first.body.data[0].id);
  for(const query of ['limit=101','q=','unknown=true'])assert.equal((await f.request('finance/accounts?'+query)).response.status,400);
});
check('native finance references reject foreign currency units, mismatched current codes and malformed translated history',async f=>{
  const c=await f.currency(),a=await f.account(c.body.data.id),account=a.body.data.id;
  await assert.rejects(f.pg.query(`INSERT INTO public.finance_accounts(academy_id,id,hub_id,currency_id,currency_version,code,created_by) VALUES($1,$2,$3,$4,1,'9999',$5)`,[f.b,randomUUID(),f.foreignHub,c.body.data.id,f.actors.foreignMaster.person]),/foreign key/i);
  await f.pg.exec('SET ROLE kavosh_runtime');try {
    await f.pg.query("SELECT set_config('app.academy_id',$1,false)",[f.a]);await f.pg.exec('BEGIN');let open=true;
    try{
      await f.pg.query("UPDATE public.finance_accounts SET version=2,code='2000' WHERE id=$1",[account]);
      await f.pg.query(`INSERT INTO public.finance_account_revisions(academy_id,account_id,version,code,name,description,kind,normal_balance,active,changed_by,approval_id,reason) VALUES($1,$2,2,'3000','Mismatch','','asset','debit',true,$3,$4,'Synthetic native mismatch')`,[f.a,account,f.actors.master.person,a.body.approval.id]);
      await assert.rejects(f.pg.exec('COMMIT'),/finance_account_current_revision|foreign key/i);open=false;
    }finally{if(open)await f.pg.exec('ROLLBACK');}
  }finally{await f.pg.exec('RESET ROLE');}
  assert.equal((await f.request('finance/accounts/'+account)).body.data.version,1);assert.equal((await f.request('finance/accounts/'+account+'/history')).body.data.length,1);
  await f.pg.exec('BEGIN');try {
    await f.pg.query('UPDATE public.finance_currencies SET version=2 WHERE id=$1',[c.body.data.id]);
    await assert.rejects(f.pg.query(`INSERT INTO public.finance_currency_revisions(academy_id,currency_id,version,name,symbol,unit_scale,active,translations,changed_by,approval_id,reason) VALUES($1,$2,2,'Invalid labels','',2,true,'{"en":null}',$3,$4,'Synthetic invalid translation')`,[f.a,c.body.data.id,f.actors.master.person,c.body.approval.id]),/FINANCE_TRANSLATIONS_INVALID/);
  }finally{await f.pg.exec('ROLLBACK');}
});
if(process.env.TEST_DATABASE_URL)check('simultaneous account corrections preserve one next revision and report the stale writer as a conflict',async f=>{
  const currency=(await f.currency()).body.data.id,a=await f.account(currency),id=a.body.data.id;
  const results=await Promise.all(['Correction A','Correction B'].map(name=>f.request('finance/accounts/'+id+'/change',{expectedVersion:1,name,reason:'Synthetic concurrent correction'})));
  assert.deepEqual(results.map(r=>r.response.status).sort(),[200,409]);assert.equal(results.find(r=>r.response.status===409)!.body.error.code,'TARGET_CHANGED');
  assert.equal((await f.request('finance/accounts/'+id)).body.data.version,2);assert.equal((await f.request('finance/accounts/'+id+'/history')).body.data.length,2);
});
if(process.env.TEST_DATABASE_URL)check('simultaneous same-owner account creation cannot duplicate chart codes or leave approval/history debris',async f=>{
  const currency=(await f.currency()).body.data.id,results=await Promise.all([f.account(currency),f.account(currency)]);assert.deepEqual(results.map(r=>r.response.status).sort(),[201,409]);assert.equal(results.find(r=>r.response.status===409)!.body.error.code,'ACCOUNT_CODE_EXISTS');
  assert.equal((await f.request('finance/accounts')).body.data.length,1);assert.equal((await f.pg.query('SELECT * FROM public.finance_account_revisions')).rows.length,1);assert.equal((await f.pg.query("SELECT * FROM public.approval_requests WHERE action='finance.account.create'")).rows.length,1);
});
if(process.env.TEST_DATABASE_URL)check('new account setup cannot slip past currency deactivation while both actual API requests wait on locks',async f=>{
  const currency=(await f.currency()).body.data.id;await f.pg.exec('BEGIN');let open=true,change:ReturnType<typeof f.request>|undefined,account:ReturnType<typeof f.account>|undefined;
  async function wait(count:number){for(let attempt=0;attempt<500;attempt++){await f.pg.query('SELECT pg_stat_clear_snapshot()');const rows=await f.pg.query("SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND wait_event_type='Lock'");if(rows.rows.length>=count)return;await delay(10);}assert.fail('the API operations must actually block before release');}
  try {
    await f.pg.query('SELECT id FROM public.finance_currencies WHERE id=$1 FOR UPDATE',[currency]);change=f.request('finance/currencies/'+currency+'/change',{expectedVersion:1,active:false,reason:'Synthetic coordinated retirement'});await wait(1);
    account=f.account(currency);await wait(2);await f.pg.exec('COMMIT');open=false;
    assert.equal((await change).response.status,200);const denied=await account;assert.equal(denied.response.status,409);assert.equal(denied.body.error.code,'ACTIVE_CURRENCY_REQUIRED');assert.equal((await f.request('finance/accounts')).body.data.length,0);
  }finally{if(open)await f.pg.exec('ROLLBACK');await Promise.allSettled([change,account]);}
});
if(process.env.TEST_DATABASE_URL)check('five-thousand-account metadata search stays scoped under one hundred parallel requests with bounded client queries',async f=>{
  const currency=(await f.currency()).body.data.id,a=await f.account(currency);await f.pg.exec('BEGIN');try {
    await f.pg.exec('CREATE TEMP TABLE synthetic_finance_accounts AS SELECT gen_random_uuid() AS id,n FROM generate_series(1,4999) n');
    await f.pg.query(`INSERT INTO public.finance_accounts(academy_id,id,hub_id,currency_id,currency_version,code,created_by)
      SELECT $1,s.id,CASE WHEN s.n%2=1 THEN $2::uuid ELSE $3::uuid END,$4,1,'AC'||lpad(s.n::text,5,'0'),$5 FROM synthetic_finance_accounts s`,[f.a,f.hub,f.otherHub,currency,f.actors.master.person]);
    await f.pg.query(`INSERT INTO public.finance_account_revisions(academy_id,account_id,version,code,name,description,kind,normal_balance,active,changed_by,approval_id,reason)
      SELECT $1,s.id,1,'AC'||lpad(s.n::text,5,'0'),'Finance load '||lpad(s.n::text,5,'0'),'','asset','debit',true,$2,$3,'Synthetic metadata load setup' FROM synthetic_finance_accounts s`,[f.a,f.actors.master.person,a.body.approval.id]);await f.pg.exec('COMMIT');
  }catch(error){await f.pg.exec('ROLLBACK');throw error;}
  const before=f.metrics.businessQueries,durations:number[]=[];
  await Promise.all(Array.from({length:100},async()=>{const start=performance.now(),r=await f.request('finance/accounts?q=Finance%20load%2004999',undefined,'staff');durations.push(performance.now()-start);assert.equal(r.response.status,200);assert.equal(r.body.data.length,1);assert.equal(r.body.data[0].name,'Finance load 04999');assert.equal(r.body.data[0].hubId,f.hub);assert.equal(r.body.data[0].balance,undefined);}));
  const queries=f.metrics.businessQueries-before;assert.equal(queries,1200);
  console.log(JSON.stringify({measurement:'synthetic-finance-account-metadata',records:5000,concurrentRequests:100,principals:1,poolMaximum:4,validatedResponses:100,rowsPerResponse:1,p99Ms:Math.ceil(durations.sort((a,b)=>a-b)[98]),clientQueries:queries,ledgerPostings:0,bankRequests:0}));
});
