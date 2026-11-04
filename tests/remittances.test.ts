import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { receiptFixture } from './receipt-fixture.ts';

async function fixture(){
 const f=await receiptFixture(),due=await f.made('finance/accounts',{code:'HUB-DUE',name:'Synthetic funds due from collector',kind:'asset',operationalRole:'collector_receivable',hubId:f.hub,currencyId:f.currency.id,currencyVersion:1,reason:'Synthetic external custody account'}),third=await f.made('finance/collectors',{hubId:f.hub,code:'EXTERNAL',kind:'hub',custody:'third_party',name:'Synthetic external hub',accounts:[{id:due.id,version:1}],reason:'Synthetic collector'});
 const received=await f.pay({amount:'113',collector:{id:third.id,version:1},holdingAccount:{id:due.id,version:1}});assert.equal(received.response.status,201,JSON.stringify({body:received.body,failures:f.metrics.queryFailures}));
 const input={collectorVersion:1,holdingAccount:{id:due.id,version:1},academyAccount:{id:f.cash.id,version:1},method:{id:f.method.id,version:1},period:{id:f.period.id,version:1},direction:'to_academy',amount:'50',postedOn:'2026-11-07',transferredAt:'2026-11-07T12:00:00Z',taxTreatment:'settle_collector',missingEvidenceReason:'Synthetic missing bank evidence exception',reason:'Private remittance approval evidence'};
 const remit=(patch:Record<string,unknown>={},as='master',key?:string)=>f.request('finance/collectors/'+third.id+'/remittances',{...input,...patch},as,{key});
 const balances=(through='2026-11-08',as='master')=>f.request('finance/collectors/'+third.id+'/remittance-balances?through='+through,undefined,as);
 const correction=(id:string,patch:Record<string,unknown>={},as='master',key?:string)=>f.request('finance/remittances/'+id+'/reverse',{period:input.period,postedOn:'2026-11-09',reason:'Private remittance correction',...patch},as,{key});
 return {...f,due,third,receivedId:received.body.data.id,remittanceInput:input,remit,balances,correction};
}
type Fixture=Awaited<ReturnType<typeof fixture>>;
function check(name:string,run:(f:Fixture)=>Promise<void>){test(name,async()=>{const f=await fixture();try{await run(f);}finally{await f.pg.close();}});}
async function access(f:Fixture,as:string,caps=['remittances.view','remittances.edit','collectors.view','accounts.view','journals.view','journals.edit','periods.view','payment-methods.view','people.view']){
 const role=await f.made('roles',{name:'Remittance role '+as,permissions:caps.map(capability=>({capability,effect:'allow'}))}),person=as==='bot'?f.bot:f.actors[as].person,path='people/'+person+'/access',old=await f.request(path);
 assert.equal((await f.request(path,{expectedVersion:old.body.data.version,assignments:[{roleId:role.id,allHubs:true},...as==='manager'?[{roleId:f.managerRole,allHubs:false,hubIds:[f.hub]}]:[]]})).response.status,200);return role;
}
check('collector remittances clear exact held funds into academy cash without reposting income or tax',async f=>{
 const before=await f.balances();assert.equal(before.response.status,200,JSON.stringify(before.body));assert.equal(before.body.data[0].current,'113.00');
 const r=await f.remit();assert.equal(r.response.status,201,JSON.stringify({body:r.body,failures:f.metrics.queryFailures}));assert.equal(r.body.data.amount,'50.00');assert.equal(r.body.data.moneyMovementPerformed,false);assert.equal(r.body.data.externallyVerified,false);assert.equal(r.body.data.additionalTaxPosting,false);
 assert.deepEqual((await f.pg.query('SELECT account_id,side,amount_minor::text AS amount FROM public.finance_journal_lines WHERE journal_id=$1 ORDER BY line_number',[r.body.data.id])).rows,[{account_id:f.cash.id,side:'debit',amount:'5000'},{account_id:f.due.id,side:'credit',amount:'5000'}]);
 assert.equal((await f.balances()).body.data[0].through,'63.00');assert.equal((await f.pg.query('SELECT * FROM public.finance_journal_lines WHERE account_id=$1',[f.taxPayable.id])).rows.length,1);
 assert.equal((await f.remit({amount:'63'})).response.status,201);assert.equal((await f.balances()).body.data[0].currentDirection,'settled');assert.equal((await f.remit({amount:'0.01'})).body.error.code,'REMITTANCE_EXCEEDS_COLLECTOR_BALANCE');
});
check('dated receipt and remittance corrections retain true historical balances and reject generic reversal bypasses',async f=>{
 const r=await f.remit();assert.equal(r.response.status,201);const generic=await f.request('finance/journals/'+r.body.data.id+'/reverse',{periodId:f.period.id,periodVersion:1,postedOn:'2026-11-09',description:'Generic bypass attempt',reason:'Use remittance correction instead'});assert.equal(generic.response.status,409);assert.equal(generic.body.error.code,'REMITTANCE_CORRECTION_WORKFLOW_REQUIRED');
 const key=randomUUID(),fixed=await f.correction(r.body.data.id,{},'master',key);assert.equal(fixed.response.status,201,JSON.stringify(fixed.body));assert.equal(fixed.body.data.status,'reversed');assert.deepEqual((await f.correction(r.body.data.id,{},'master',key)).body,fixed.body);assert.equal((await f.correction(r.body.data.id)).response.status,409);
 const old=(await f.balances('2026-11-08')).body.data[0],now=(await f.balances('2026-11-09')).body.data[0];assert.equal(old.through,'63.00');assert.equal(old.current,'113.00');assert.equal(now.through,'113.00');
});
check('collector credits after receipt correction can be paid back explicitly without inventing another tuition refund',async f=>{
 assert.equal((await f.remit({amount:'113'})).response.status,201);assert.equal((await f.reverse(f.receivedId,{postedOn:'2026-11-08'})).response.status,201);
 const b=(await f.balances('2026-11-08')).body.data[0];assert.equal(b.current,'-113.00');assert.equal(b.currentDirection,'academy_owes_collector');assert.equal((await f.balances('2026-11-07')).body.data[0].through,'0.00');
 const paid=await f.remit({direction:'to_collector',amount:'113',postedOn:'2026-11-09',transferredAt:'2026-11-09T12:00:00Z'});assert.equal(paid.response.status,201,JSON.stringify(paid.body));assert.equal((await f.balances('2026-11-09')).body.data[0].current,'0.00');
 assert.equal((await f.pg.query('SELECT coalesce(sum(CASE WHEN side=\'debit\' THEN amount_minor ELSE -amount_minor END),0)::text AS amount FROM public.finance_journal_lines WHERE account_id=$1',[f.cash.id])).rows[0].amount,'0');
});
check('backdated remittances cannot spend future receipts or duplicate money already cleared by a later entry',async f=>{
 assert.equal((await f.remit({postedOn:'2026-11-05'})).body.error.code,'REMITTANCE_EXCEEDS_COLLECTOR_BALANCE');assert.equal((await f.remit({amount:'113',postedOn:'2026-11-09'})).response.status,201);
 assert.equal((await f.remit({amount:'1',postedOn:'2026-11-08'})).body.error.code,'REMITTANCE_EXCEEDS_COLLECTOR_BALANCE');assert.equal((await f.balances('2026-11-08')).body.data[0].through,'113.00');
});
check('retired collectors and replaced account mappings still permit clearing their actual historical held funds',async f=>{
 const other=await f.made('finance/accounts',{code:'NEW-DUE',name:'New synthetic collector account',kind:'asset',operationalRole:'collector_receivable',hubId:f.hub,currencyId:f.currency.id,currencyVersion:1,reason:'Prospective new holding map'});
 const changed=await f.request('finance/collectors/'+f.third.id+'/change',{expectedVersion:1,name:'Retired synthetic hub',active:false,accounts:[{id:other.id,version:1}],reason:'Retire collector without forgiving money'});assert.equal(changed.response.status,200);
 const r=await f.remit({collectorVersion:2,amount:'113'});assert.equal(r.response.status,201,JSON.stringify(r.body));assert.equal(r.body.data.collectorName,'Retired synthetic hub');assert.equal((await f.balances()).body.data[0].current,'0.00');
});
check('money precision, ownership, account roles, current source versions and periods are validated before posting',async f=>{
 for(const patch of [{amount:'0'},{amount:'-1'},{amount:'1.001'},{amount:50},{taxTreatment:'exclude_cash'},{onlinePayment:true}])assert.equal((await f.remit(patch)).response.status,400,JSON.stringify(patch));
 assert.equal((await f.remit({collectorVersion:99})).response.status,409);assert.equal((await f.remit({academyAccount:{id:f.ar.id,version:1}})).body.error.code,'REMITTANCE_ACCOUNT_ROLE_INVALID');assert.equal((await f.remit({direction:'to_collector'})).response.status,409);
 assert.equal((await f.request('finance/collectors/'+f.collector.id+'/remittance-balances?through=2026-11-08')).response.status,400);
 assert.equal((await f.request('finance/periods/'+f.period.id+'/change',{expectedVersion:1,state:'closed',reason:'Synthetic close'})).response.status,200);assert.equal((await f.remit({period:{id:f.period.id,version:2}})).response.status,409);
});
check('retries, duplicate references and outbox failures cannot duplicate or partially persist a remittance',async f=>{
 const key=randomUUID(),r=await f.remit({reference:'REMIT-ONE'},'master',key);assert.equal(r.response.status,201);assert.deepEqual((await f.remit({reference:'REMIT-ONE'},'master',key)).body,r.body);assert.equal((await f.remit({reference:'REMIT-ONE'})).body.error.code,'REMITTANCE_REFERENCE_EXISTS');
 await f.pg.exec('REVOKE INSERT ON public.outbox_events FROM kavosh_runtime');try{assert.equal((await f.remit({reference:'FAIL'})).response.status,503);}finally{await f.pg.exec('GRANT INSERT ON public.outbox_events TO kavosh_runtime');}
 assert.equal((await f.pg.query('SELECT * FROM public.collector_remittances')).rows.length,1);assert.equal((await f.balances()).body.data[0].current,'63.00');
});
check('financial evidence is hidden from ordinary media readers and is independently protected on remittance details',async f=>{
 const file=await f.made('files',{anchor:{kind:'hub',id:f.hub},domain:'finance_private',name:'Private transfer proof.pdf',claimedMimeType:'application/pdf',expectedBytes:100}),r=await f.remit({evidence:{id:file.id,version:1},missingEvidenceReason:''});assert.equal(r.response.status,201,JSON.stringify(r.body));assert.equal(r.body.data.evidence.storedContentVerified,false);
 await access(f,'staff',['remittances.view','collectors.view','accounts.view','files.view','files.edit','files.upload']);assert.equal((await f.request('files/'+file.id,undefined,'staff')).response.status,404);assert.equal((await f.request('files?domain=finance_private',undefined,'staff')).body.data.length,0);assert.equal((await f.request('finance/remittances/'+r.body.data.id,undefined,'staff')).body.data.evidence,null);
 await f.pg.query("INSERT INTO public.role_permissions(academy_id,role_id,capability,effect) SELECT academy_id,role_id,'financial-files.view','allow' FROM public.role_permissions WHERE capability='files.view' AND role_id IN(SELECT role_id FROM public.role_assignments WHERE person_id=$1)",[f.actors.staff.person]);
 assert.equal((await f.request('files/'+file.id,undefined,'staff')).response.status,200);assert.equal((await f.request('files/'+file.id+'/change',{expectedVersion:1,name:'Cannot edit private proof'},'staff')).response.status,404);assert.equal((await f.request('finance/remittances/'+r.body.data.id,undefined,'staff')).body.data.evidence.id,file.id);
});
check('hub financial viewers see their own remittances without private reasons, peer hubs or ledger access',async f=>{
 const r=await f.remit();assert.equal(r.response.status,201);for(const cap of ['remittances.view','collectors.view','accounts.view'])await f.pg.query("INSERT INTO public.role_permissions VALUES($1,$2,$3,'allow')",[f.a,f.staffRole,cap]);
 const read=await f.request('finance/remittances/'+r.body.data.id,undefined,'staff');assert.equal(read.response.status,200);assert.ok(!JSON.stringify(read.body).includes(f.remittanceInput.reason));assert.equal((await f.request('finance/remittances?limit=1',undefined,'staff')).body.data.length,1);assert.equal((await f.request('finance/journals/'+r.body.data.id,undefined,'staff')).response.status,403);assert.equal((await f.request('finance/remittances/'+r.body.data.id,undefined,'foreignMaster',{academy:f.b})).response.status,404);
 assert.equal((await f.balances('2026-11-08','staff')).body.data[0].current,'63.00');
});
check('upper human approval, source changes, revoked roles and bot ceilings remain effective for remittances',async f=>{
 const role=await access(f,'staff');await access(f,'manager');const pending=await f.remit({},'staff');assert.equal(pending.response.status,202,JSON.stringify(pending.body));assert.equal((await f.approve(pending.body.approval.id,'staff')).response.status,403);assert.equal((await f.approve(pending.body.approval.id,'manager')).response.status,200);
 const stale=await f.remit({amount:'60'},'staff');assert.equal(stale.response.status,202);assert.equal((await f.remit({amount:'10'})).response.status,201);assert.equal((await f.approve(stale.body.approval.id)).response.status,409);
 const conflicted=await f.remit({amount:'1',handledById:f.actors.manager.person},'staff');assert.equal(conflicted.response.status,202);assert.equal((await f.approve(conflicted.body.approval.id,'manager')).body.error.code,'BENEFICIARY_REVIEW_FORBIDDEN');assert.equal((await f.approve(conflicted.body.approval.id)).response.status,200);
 const revoked=await f.remit({amount:'1'},'staff');assert.equal(revoked.response.status,202);await f.pg.query("DELETE FROM public.role_permissions WHERE role_id=$1 AND capability='remittances.edit'",[role.id]);assert.equal((await f.request('approvals/'+revoked.body.approval.id,undefined,'staff')).response.status,404);
 await access(f,'bot');const bot=await f.remit({amount:'1'},'bot');assert.equal(bot.response.status,202,JSON.stringify(bot.body));assert.equal((await f.approve(bot.body.approval.id,'bot')).response.status,403);assert.equal((await f.approve(bot.body.approval.id)).response.status,200);
});
check('native remittance history remains immutable and tenant-bound even after corrections',async f=>{
 const r=await f.remit();assert.equal(r.response.status,201);await f.pg.exec('SET ROLE kavosh_runtime');try{await f.pg.query("SELECT set_config('app.academy_id',$1,false)",[f.b]);assert.equal((await f.pg.query('SELECT * FROM public.collector_remittances')).rows.length,0);await f.pg.query("SELECT set_config('app.academy_id',$1,false)",[f.a]);for(const sql of ['DELETE FROM public.collector_remittances',"UPDATE public.collector_remittances SET amount_minor=1",'DELETE FROM public.collector_remittance_reversals'])await assert.rejects(f.pg.exec(sql),/permission denied/i);}finally{await f.pg.exec('RESET ROLE');}
 assert.equal((await f.correction(r.body.data.id)).response.status,201);assert.equal((await f.pg.query('SELECT * FROM public.collector_remittances')).rows.length,1);await f.pg.query("UPDATE public.academies SET status='read_only' WHERE id=$1",[f.a]);assert.equal((await f.remit()).response.status,403);assert.equal((await f.balances()).response.status,200);
});
if(process.env.TEST_DATABASE_URL)check('two simultaneous native remittances cannot clear the same collector funds twice',async f=>{
 const started=performance.now(),results=await Promise.all([f.remit({amount:'80'}),f.remit({amount:'80'})]);assert.equal(results.filter(r=>r.response.status===201).length,1,JSON.stringify(results.map(r=>r.body)));assert.equal(results.filter(r=>r.response.status===409).length,1);assert.equal((await f.balances()).body.data[0].current,'33.00');console.log(JSON.stringify({measurement:'brief-collector-remittance-race',requests:2,winners:1,elapsedMs:Math.ceil(performance.now()-started)}));
});
if(process.env.TEST_DATABASE_URL)check('receipt correction versus remittance uses the same native funds gate without deadlock or double clearing',async f=>{
 const started=performance.now(),[remit,correction]=await Promise.all([f.remit({amount:'113'}),f.reverse(f.receivedId,{postedOn:'2026-11-08'})]);assert.equal(correction.response.status,201,JSON.stringify(correction.body));assert.ok([201,409].includes(remit.response.status),JSON.stringify(remit.body));assert.equal((await f.balances()).body.data[0].current,remit.response.status===201?'-113.00':'0.00');console.log(JSON.stringify({measurement:'brief-collector-receipt-correction-race',requests:2,remittanceRecorded:remit.response.status===201,elapsedMs:Math.ceil(performance.now()-started)}));
});
