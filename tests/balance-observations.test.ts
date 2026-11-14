import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { invoiceFixture } from './invoice-fixture.ts';

async function fixture(){const f=await invoiceFixture();try{
 const input={accountId:f.cash.id,accountVersion:1,asOf:'2026-01-31',balance:'100.25',reference:'Synthetic balance reference',reason:'Private manually entered balance review'};
 const observe=(patch:Record<string,unknown>={},as='master',key?:string)=>f.request('finance/balance-observations',{...input,...patch},as,{key});
 const list=(suffix='',as='master')=>f.request('finance/accounts/'+f.cash.id+'/balance-observations'+suffix,undefined,as);
 const compare=(id:string,as='master')=>f.request('finance/balance-observations/'+id+'/comparison',undefined,as);
 async function access(as:string,caps=['bank-balances.view','bank-balances.edit','accounts.view','ledger.view'],allHubs=false){
  const role=await f.made('roles',{name:'Balances '+as+' '+randomUUID(),permissions:caps.map(capability=>({capability,effect:'allow'}))}),person=as==='bot'?f.bot:f.actors[as].person,path='people/'+person+'/access',prior=(await f.request(path)).body.data;
  assert.equal((await f.request(path,{expectedVersion:prior.version,assignments:[{roleId:role.id,allHubs,...allHubs?{}:{hubIds:[f.hub]}},...as==='manager'?[{roleId:f.managerRole,allHubs:false,hubIds:[f.hub]}]:[]]})).response.status,200);return role;
 }
 async function journal(accountId=f.cash.id,side='debit',amount='90.25',postedOn='2026-01-20'){
  return f.request('finance/journals',{periodId:f.period.id,periodVersion:1,postedOn,description:'Synthetic posted treasury activity',reason:'Synthetic accounting test',lines:[{accountId,accountVersion:1,side,amount},{accountId:f.income.id,accountVersion:1,side:side==='debit'?'credit':'debit',amount}]});
 }
 return {...f,input,observe,list,compare,access,journal};
 }catch(error){await f.pg.close();throw error;}}
type Fixture=Awaited<ReturnType<typeof fixture>>;
function check(name:string,run:(f:Fixture)=>Promise<void>){test(name,async()=>{const f=await fixture();try{await run(f);}finally{await f.pg.close();}});}

check('reviewed manual totals persist exactly without altering any accounting balance and comparison never claims bank verification',async f=>{
 const created=await f.observe();assert.equal(created.response.status,201,JSON.stringify({body:created.body,failures:f.metrics.queryFailures}));const o=created.body.data;
 assert.equal(o.balance.amount,'100.25');assert.equal(o.normalBalance,'debit');assert.equal(o.source,'manual_total');assert.equal(o.externallyVerified,false);assert.equal(o.ledgerAdjusted,false);assert.equal(o.moneyMovementPerformed,false);assert.doesNotMatch(JSON.stringify(o),/Private manually/);
 assert.equal((await f.pg.query('SELECT * FROM public.finance_journals')).rows.length,0);
 assert.equal((await f.list('?through=2026-01-30')).body.data.length,0);assert.equal((await f.list('?from=2026-01-31&through=2026-01-31')).body.data.length,1);
 assert.equal((await f.journal()).response.status,201);assert.equal((await f.journal(f.cash.id,'debit','5','2026-02-01')).response.status,201);
 const result=await f.compare(o.id);assert.equal(result.response.status,200,JSON.stringify(result.body));const d=result.body.data;assert.equal(d.ledger.balance.amount,'90.25');assert.equal(d.difference.amount,'10.00');assert.equal(d.amountsEqual,false);assert.equal(d.ledger.lineCount,1);assert.equal(d.observationCurrent,true);
 for(const k of ['reconciled','transactionMatchingPerformed','externallyVerified','ledgerAdjusted','moneyMovementPerformed'])assert.equal(d[k],false);
 assert.equal((await f.request('finance/accounts/'+f.cash.id+'/balance?through=2026-01-31')).body.data.closing.amount,'90.25');
 await f.pg.query("UPDATE public.academies SET status='read_only' WHERE id=$1",[f.a]);assert.equal((await f.compare(o.id)).response.status,200);
});
check('corrections, voids and reinstatement append history and can never overwrite or branch a prior observation',async f=>{
 const one=(await f.observe()).body.data,two=await f.observe({balance:'120',supersedesId:one.id});assert.equal(two.response.status,201,JSON.stringify(two.body));
 assert.equal((await f.observe({balance:'5',supersedesId:one.id})).response.status,409);assert.equal((await f.observe()).response.status,409);
 let list=await f.list();assert.equal(list.body.data.length,1);assert.equal(list.body.data[0].id,two.body.data.id);assert.equal((await f.list('?includeHistory=true')).body.data.length,2);
 assert.equal((await f.request('finance/balance-observations/'+one.id)).body.data.supersededBy,two.body.data.id);assert.equal((await f.compare(one.id)).body.data.observationCurrent,false);
 const voided=await f.observe({state:'void',balance:null,supersedesId:two.body.data.id});assert.equal(voided.response.status,201,JSON.stringify(voided.body));assert.equal(voided.body.data.balance,null);assert.equal((await f.compare(voided.body.data.id)).body.data.difference,null);
 assert.equal((await f.observe({state:'void',balance:null,supersedesId:voided.body.data.id})).response.status,409);
 const restored=await f.observe({balance:'0',supersedesId:voided.body.data.id});assert.equal(restored.response.status,201);assert.equal(restored.body.data.balance.minor,'0');
 list=await f.list('?includeHistory=true&limit=1');assert.ok(list.body.nextCursor);assert.equal((await f.list('?includeHistory=true&after='+list.body.nextCursor)).body.data.length,3);
 assert.equal((await f.pg.query('SELECT * FROM public.finance_balance_observations')).rows.length,4);assert.equal((await f.pg.query('SELECT * FROM public.finance_journals')).rows.length,0);
});
check('signed bank overdrafts and positive card liabilities compare using the pinned original normal balance',async f=>{
 const card=await f.made('finance/accounts',{code:'CARD',name:'Synthetic card',kind:'liability',operationalRole:'credit_card',hubId:f.hub,currencyId:f.currency.id,currencyVersion:1,reason:'Synthetic card account'});
 const observed=await f.observe({accountId:card.id,balance:'40'});assert.equal(observed.response.status,201);assert.equal(observed.body.data.normalBalance,'credit');assert.equal((await f.journal(card.id,'credit','40')).response.status,201);
 let result=await f.compare(observed.body.data.id);assert.equal(result.body.data.ledger.balance.amount,'40.00');assert.equal(result.body.data.difference.amount,'0.00');assert.equal(result.body.data.amountsEqual,true);assert.equal(result.body.data.reconciled,false);
 const negative=await f.observe({balance:'-10.01'});assert.equal(negative.response.status,201);assert.equal(negative.body.data.balance.minor,'-1001');assert.equal((await f.compare(negative.body.data.id)).body.data.difference.amount,'-10.01');
 assert.equal((await f.request('finance/accounts/'+f.cash.id+'/change',{expectedVersion:1,kind:'liability',normalBalance:'credit',operationalRole:'other',reason:'Synthetic later account classification'})).response.status,200);
 assert.equal((await f.request('finance/journals',{periodId:f.period.id,periodVersion:1,postedOn:'2026-01-20',description:'Synthetic revised-account posting',reason:'Check original observation convention',lines:[{accountId:f.cash.id,accountVersion:2,side:'credit',amount:'10'},{accountId:f.income.id,accountVersion:1,side:'debit',amount:'10'}]})).response.status,201);
 result=await f.compare(negative.body.data.id);assert.equal(result.body.data.ledger.normalBalance,'debit');assert.equal(result.body.data.ledger.balance.amount,'-10.00');assert.equal(result.body.data.difference.amount,'-0.01');
});
check('upper human review is mandatory, source/account changes invalidate approval and bank/private account rights protect proposals',async f=>{
 await f.access('staff');await f.access('manager');const pending=await f.observe({},'staff');assert.equal(pending.response.status,202,JSON.stringify(pending.body));assert.equal((await f.list()).body.data.length,0);
 assert.equal((await f.approve(pending.body.approval.id,'staff')).response.status,403);assert.equal((await f.approve(pending.body.approval.id,'manager')).response.status,200);
 const next=await f.observe({asOf:'2026-02-01'},'staff');assert.equal(next.response.status,202);
 await f.pg.query("DELETE FROM public.role_permissions WHERE role_id=$1 AND capability='accounts.view'",[(await f.access('manager')).id]);assert.equal((await f.request('approvals/'+next.body.approval.id,undefined,'manager')).response.status,404);
 assert.equal((await f.request('finance/accounts/'+f.cash.id+'/change',{expectedVersion:1,name:'Changed source account',reason:'Stale manual observation source'})).response.status,200);assert.equal((await f.approve(next.body.approval.id)).response.status,409);
 await f.access('bot');const bot=await f.observe({accountVersion:2,asOf:'2026-02-02'},'bot');assert.equal(bot.response.status,202);assert.equal((await f.approve(bot.body.approval.id,'bot')).response.status,403);assert.equal((await f.approve(bot.body.approval.id)).response.status,200);
});
check('balance history and comparisons honor tenant, current feature/account scopes and additional ledger rights',async f=>{
 const created=(await f.observe()).body.data;await f.access('staff',['bank-balances.view','accounts.view']);assert.equal((await f.list('', 'staff')).body.data.length,1);assert.equal((await f.compare(created.id,'staff')).response.status,403);
 assert.equal((await f.request('finance/balance-observations/'+created.id,undefined,'foreignMaster',{academy:f.b})).response.status,404);
 assert.equal((await f.request('finance/accounts/'+f.cash.id+'/balance-observations',undefined,'foreignMaster',{academy:f.b})).response.status,404);
 const role=await f.access('staff',['bank-balances.view','accounts.view'],true),deny=await f.made('roles',{name:'Deny balance hub',permissions:[{capability:'bank-balances.view',effect:'deny'}]}),path='people/'+f.actors.staff.person+'/access',prior=(await f.request(path)).body.data;
 assert.equal((await f.request(path,{expectedVersion:prior.version,assignments:[{roleId:role.id,allHubs:true},{roleId:deny.id,allHubs:false,hubIds:[f.hub]}]})).response.status,200);assert.equal((await f.request('finance/balance-observations/'+created.id,undefined,'staff')).response.status,404);
 await f.access('bot',['bank-balances.view','accounts.view'],true);await f.pg.query('UPDATE auth_private.credentials SET all_hubs=false WHERE id=$1',[f.credential]);await f.pg.query('INSERT INTO auth_private.credential_hubs VALUES($1,$2,$3)',[f.credential,f.a,f.otherHub]);assert.equal((await f.request('finance/balance-observations/'+created.id,undefined,'bot')).response.status,404);
});
check('invalid or future manual inputs, wrong prior anchors, false verification and non-treasury accounts never persist',async f=>{
 for(const patch of [{balance:'1.001'},{balance:'+1'},{balance:'1e2'},{state:'void',balance:null},{balance:null},{externallyVerified:true},{asOf:'9999-12-31'},{accountVersion:2147483648}])assert.equal((await f.observe(patch)).response.status,400,JSON.stringify(patch));
 assert.equal((await f.observe({accountId:f.ar.id})).response.status,409);assert.equal((await f.observe({accountVersion:2})).response.status,409);assert.equal((await f.pg.query('SELECT * FROM public.finance_balance_observations')).rows.length,0);
 const first=(await f.observe()).body.data;assert.equal((await f.observe({asOf:'2026-02-01',supersedesId:first.id})).response.status,409);
 assert.equal((await f.observe({balance:'999999999999999999999999999999999999.99',asOf:'2026-02-01'})).response.status,201);
});
check('manual balance retries and critical-alert/outbox failures are atomic with no posted adjustment',async f=>{
 const key=randomUUID(),first=await f.observe({},'master',key);assert.equal(first.response.status,201);assert.deepEqual((await f.observe({},'master',key)).body,first.body);
 assert.equal((await f.observe({balance:'999'},'master',key)).response.status,409);
 await f.pg.exec('REVOKE INSERT ON public.outbox_events FROM kavosh_runtime');try{assert.equal((await f.observe({asOf:'2026-02-01'})).response.status,503);}finally{await f.pg.exec('GRANT INSERT ON public.outbox_events TO kavosh_runtime');}
 assert.equal((await f.pg.query('SELECT * FROM public.finance_balance_observations')).rows.length,1);assert.equal((await f.pg.query('SELECT * FROM public.finance_journals')).rows.length,0);
 const alerts=(await f.pg.query("SELECT n.* FROM public.portal_notifications n JOIN public.automation_event_sources e ON e.academy_id=n.academy_id AND e.event_id=n.event_id WHERE e.approval_id=$1 AND n.origin='mandatory'",[first.body.approval.id])).rows;assert.ok(alerts.length>0);
 const audit=(await f.pg.query("SELECT changes FROM public.audit_events WHERE action='finance.balance-observation.recorded'")).rows;assert.doesNotMatch(JSON.stringify(audit),/Private manually|100\.25|Synthetic balance reference/);
});
check('native exact amount, normal-balance and deferred applied-approval guards reject real pending-case injection',async f=>{
 await f.access('staff');const pending=await f.observe({},'staff');assert.equal(pending.response.status,202);const p=(await f.pg.query<{target_id:string}>('SELECT target_id FROM public.approval_requests WHERE id=$1',[pending.body.approval.id])).rows[0];
 const sql=`INSERT INTO public.finance_balance_observations(academy_id,id,account_id,account_version,currency_id,unit_scale,normal_balance,as_of,state,balance_minor,supersedes_id,reference,reason,approval_id,created_by)
  SELECT p.academy_id,p.target_id,a.id,a.version,a.currency_id,a.unit_scale,$3,'2026-01-31','recorded',$4,NULL,p.payload->>'reference',p.payload->>'reason',p.id,$2 FROM public.approval_requests p JOIN public.finance_account_catalogue a ON a.academy_id=p.academy_id AND a.id=(p.payload->>'accountId')::uuid WHERE p.id=$1`;
 for(const [normal,minor,error] of [['debit','10026',/AMOUNT_INVALID/],['credit','10025',/ACCOUNT_OR_DATE_INVALID/],['debit','10025',/REVIEWED_APPROVAL_NOT_APPLIED/]] as const){
  await f.pg.exec('BEGIN');try{await f.pg.query("SELECT set_config('app.academy_id',$1,true)",[f.a]);await f.pg.exec('SET LOCAL ROLE kavosh_runtime');
   if(minor==='10025'&&normal==='debit'){await f.pg.query(sql,[pending.body.approval.id,f.actors.master.person,normal,minor]);await assert.rejects(f.pg.exec('COMMIT'),error);}
   else await assert.rejects(f.pg.query(sql,[pending.body.approval.id,f.actors.master.person,normal,minor]),error);
  }finally{await f.pg.exec('ROLLBACK');}
 }
 assert.equal((await f.pg.query('SELECT * FROM public.finance_balance_observations WHERE id=$1',[p.target_id])).rows.length,0);assert.equal((await f.approve(pending.body.approval.id)).response.status,200);
});
check('native balance storage denies edits/deletes and rejects missing or altered exact approvals',async f=>{
 const first=(await f.observe()).body.data;await f.pg.exec('SET ROLE kavosh_runtime');try{
  await f.pg.query("SELECT set_config('app.academy_id',$1,false)",[f.a]);await assert.rejects(f.pg.query('UPDATE public.finance_balance_observations SET balance_minor=0 WHERE id=$1',[first.id]),/permission denied/i);await assert.rejects(f.pg.query('DELETE FROM public.finance_balance_observations WHERE id=$1',[first.id]),/permission denied/i);
  await assert.rejects(f.pg.query(`INSERT INTO public.finance_balance_observations(academy_id,id,account_id,account_version,currency_id,unit_scale,normal_balance,as_of,state,balance_minor,supersedes_id,reference,reason,approval_id,created_by) SELECT academy_id,$2,account_id,account_version,currency_id,unit_scale,normal_balance,as_of,'recorded',0,id,reference,reason,approval_id,created_by FROM public.finance_balance_observations WHERE id=$1`,[first.id,randomUUID()]),/EXACT_APPROVAL/i);
  await f.pg.query("SELECT set_config('app.academy_id',$1,false)",[f.b]);assert.equal((await f.pg.query('SELECT * FROM public.finance_balance_observations')).rows.length,0);
 }finally{await f.pg.exec('RESET ROLE');}
});
if(process.env.TEST_DATABASE_URL)check('brief competing manual observations and corrections create one root and one immutable successor',async f=>{
 const started=performance.now(),roots=await Promise.all([f.observe(),f.observe()]);assert.deepEqual(roots.map(r=>r.response.status).sort(),[201,409]);const id=roots.find(r=>r.response.status===201)!.body.data.id;
 const corrected=await Promise.all(['1','2'].map(balance=>f.observe({balance,supersedesId:id})));assert.deepEqual(corrected.map(r=>r.response.status).sort(),[201,409]);assert.equal((await f.pg.query('SELECT * FROM public.finance_balance_observations')).rows.length,2);console.log(JSON.stringify({measurement:'brief-manual-balance-race',requests:4,elapsedMs:Math.ceil(performance.now()-started)}));
});
