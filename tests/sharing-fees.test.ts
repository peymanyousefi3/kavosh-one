import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { expenseFixture } from './expense-fixture.ts';
import { mintToken,hashToken } from '../src/core/tokens.ts';
import { processOneSubscription } from '../src/automations/subscription-worker.ts';
import { processOneNotification } from '../src/automations/notification-worker.ts';
import type { Database } from '../src/core/database.ts';

async function fixture(throughSchema?:number){
 const f=await expenseFixture({throughSchema});try{
  const invoice=await f.issue();assert.equal(invoice.response.status,201);
  const hubPayee=await f.made('finance/payees',{hubId:f.hub,kind:'hub',code:'HUB-FEE',name:'Synthetic hub fee beneficiary',reason:'Named fee participant'}),collector=await f.made('finance/collectors',{hubId:f.hub,code:'FEE-CASH',kind:'hub',custody:'academy_funds',name:'Synthetic tuition collector',accounts:[{id:f.cash.id,version:1}],reason:'Explicit custody'});
  const policy={expectedVersion:0,tuitionVersion:1,basis:'net_tuition',creditHandling:'retain_collections',recipients:[{payeeId:hubPayee.id,payeeVersion:1,method:'percentage',value:'75',release:'proportional'}],reason:'Synthetic hub agreement'},save=(patch:Record<string,unknown>={})=>f.request('finance/tuition-plans/'+f.plan.id+'/sharing',{...policy,...patch});assert.equal((await save()).response.status,200);
  const pay=(patch:Record<string,unknown>={})=>f.request('finance/invoices/'+invoice.body.data.id+'/receipts',{amount:'113',collector:{id:collector.id,version:1},holdingAccount:{id:f.cash.id,version:1},method:{id:f.method.id,version:1},receivedAt:'2026-11-06T12:00:00Z',period:{id:f.period.id,version:1},missingEvidenceReason:'Synthetic receipt exception',taxTreatment:'settle_invoice',allocation:'unallocated',reason:'Synthetic tuition collection',...patch});
  const input={...f.input,payee:{id:hubPayee.id,version:1},sharing:{invoiceId:invoice.body.data.id,policyVersion:1,asOf:'2026-11-06'},lines:[{...f.input.lines[0],amount:'75',recoverablePercent:'100'}]};
  const bill=(patch:Record<string,unknown>={},as='master',key?:string)=>f.bill({...input,...patch},as,key),capacity=async(version=1,on='2026-11-06',posted='2026-11-07')=>{await f.pg.exec('SET ROLE kavosh_runtime');try{await f.pg.query("SELECT set_config('app.academy_id',$1,false)",[f.a]);return(await f.pg.query<{s:any}>('SELECT public.sharing_fee_capacity($1,$2,$3,$4,$5) s',[invoice.body.data.id,version,hubPayee.id,on,posted])).rows[0].s;}finally{await f.pg.exec('RESET ROLE');}};
  return {...f,invoice:invoice.body.data,hubPayee,collector,policy,save,pay,input,bill,capacity};
 }catch(error){await f.pg.close();throw error;}
}
type Fixture=Awaited<ReturnType<typeof fixture>>;
function check(name:string,run:(f:Fixture)=>Promise<void>){test(name,async()=>{const f=await fixture();try{await run(f);}finally{await f.pg.close();}});}
async function access(f:Fixture,as:string){
 const caps=(await f.pg.query<{name:string}>('SELECT name FROM public.capability_catalog')).rows.map(r=>r.name),role=await f.made('roles',{name:'Sharing fee operator '+as,permissions:caps.map(capability=>({capability,effect:'allow'}))}),path='people/'+(as==='bot'?f.bot:f.actors[as].person)+'/access',before=await f.request(path);
 assert.equal((await f.request(path,{expectedVersion:before.body.data.version,assignments:[{roleId:role.id,allHubs:true},...as==='manager'?[{roleId:f.managerRole,allHubs:false,hubIds:[f.hub]}]:[]]})).response.status,200);return role;
}
const partial=(f:Fixture,amount:string)=>[{...f.input.lines[0],amount}];
check('sharing fees create one exact reviewed expense/payable with independently declared fee HST and existing payment status',async f=>{
 assert.equal((await f.bill()).body.error.code,'SHARING_FEE_EXCEEDS_RELEASED_CAPACITY');assert.equal((await f.pay()).response.status,201);const r=await f.bill();assert.equal(r.response.status,201,JSON.stringify({body:r.body,failures:f.metrics.queryFailures}));
 const d=r.body.data;assert.equal(d.net,'75.00');assert.equal(d.tax,'9.75');assert.equal(d.gross,'84.75');assert.equal(d.expense,'75.00');assert.equal(d.declaredRecoverableTax,'9.75');assert.equal(d.sharing.invoiceId,f.invoice.id);assert.equal(d.sharing.feeTaxInferred,false);assert.equal(d.moneyMovementPerformed,false);
 const link=(await f.pg.query('SELECT * FROM public.sharing_fee_bills')).rows[0];assert.equal(link.approval_id,r.body.approval.id);assert.equal((await f.capacity()).availableNetMinor,'0');assert.equal((await f.pg.query('SELECT count(*)::integer n FROM public.expense_payments')).rows[0].n,0);
 const payment=await f.request('finance/expense-bills/'+d.id+'/payments',{fundingAccount:{id:f.cash.id,version:1},payableVersion:1,method:{id:f.method.id,version:1},amount:'84.75',period:{id:f.period.id,version:1},postedOn:'2026-11-08',paidAt:'2026-11-08T12:00:00Z',missingEvidenceReason:'Synthetic payment record only',taxTreatment:'settle_expense_bill',reason:'Pay the recorded fee'});assert.equal(payment.response.status,201,JSON.stringify(payment.body));
 const status=await f.request('finance/expense-bills/'+d.id+'/payment-status');assert.equal(status.body.data.paymentStatus,'paid');assert.equal((await f.capacity()).availableNetMinor,'0');assert.equal((await f.bill({documentNumber:'DUPLICATE'})).body.error.code,'SHARING_FEE_EXCEEDS_RELEASED_CAPACITY');
 const costs=await f.request('reports/finance/expense-costs?from=2026-11-07&through=2026-11-07&studentIds='+f.student.id);assert.equal(costs.response.status,200);assert.equal(costs.body.data.currencies[0].expense.minor,'7500');
});
check('tuition HST never determines whether a hub fee has HST and tax-inclusive net capacity is exact',async f=>{
 assert.equal((await f.pay()).response.status,201);const noTax=await f.made('finance/tax-codes',{code:'FEE-NO-TAX',name:'Synthetic explicit no-tax fee',hubId:f.hub,countryCode:'CA',classification:'out_of_scope',ratePercent:'0',startsOn:'2026-01-01',legalBasis:'Synthetic independently reviewed fee treatment',reason:'Not inferred from tuition or cash'});
 const r=await f.bill({lines:[{...f.input.lines[0],taxCode:{id:noTax.id,version:1},pricing:'not_applicable',taxAccount:null,recoverablePercent:'0'}]});assert.equal(r.response.status,201,JSON.stringify(r.body));assert.equal(r.body.data.tax,'0.00');assert.equal(r.body.data.gross,'75.00');assert.equal((await f.cancel(r.body.data.id)).response.status,201);
 const inclusive=await f.bill({documentNumber:'INCLUSIVE',postedOn:'2026-11-09',lines:[{...f.input.lines[0],amount:'84.75',pricing:'tax_inclusive'}]});assert.equal(inclusive.response.status,201,JSON.stringify(inclusive.body));assert.equal(inclusive.body.data.net,'75.00');assert.equal(inclusive.body.data.tax,'9.75');
});
check('partial collection and split fee bills conserve cumulative capacity across replacement policy editions',async f=>{
 assert.equal((await f.pay({amount:'56.50'})).response.status,201);assert.equal((await f.capacity()).availableNetMinor,'3750');assert.equal((await f.bill()).response.status,409);
 assert.equal((await f.bill({documentNumber:'PART-1',lines:partial(f,'25')})).response.status,201);assert.equal((await f.capacity()).availableNetMinor,'1250');assert.equal((await f.bill({documentNumber:'TOO-MUCH',lines:partial(f,'12.51')})).response.status,409);
 assert.equal((await f.save({expectedVersion:1,recipients:[{...f.policy.recipients[0],value:'80'}]})).response.status,200);const changed={...f.input.sharing,policyVersion:2};assert.equal((await f.bill({documentNumber:'OLD',lines:partial(f,'1')})).body.error.code,'SHARING_FEE_SOURCE_CHANGED');
 assert.equal((await f.capacity(2)).availableNetMinor,'1500');assert.equal((await f.bill({documentNumber:'PART-2',sharing:changed,lines:partial(f,'15')})).response.status,201);assert.equal((await f.capacity(2)).availableNetMinor,'0');
});
check('future bills reserve capacity and a future void cannot fund a backdated replacement',async f=>{
 assert.equal((await f.pay()).response.status,201);const r=await f.bill({postedOn:'2026-11-09'});assert.equal(r.response.status,201);assert.equal((await f.bill({documentNumber:'BACKDATE'})).response.status,409);
 assert.equal((await f.cancel(r.body.data.id,{postedOn:'2026-11-10'})).response.status,201);assert.equal((await f.capacity()).availableNetMinor,'0');assert.equal((await f.bill({documentNumber:'EARLY-REPLACE',postedOn:'2026-11-09'})).response.status,409);
 const replaced=await f.bill({documentNumber:'AFTER-VOID',postedOn:'2026-11-10'});assert.equal(replaced.response.status,201,JSON.stringify(replaced.body));assert.equal((await f.pg.query('SELECT count(*)::integer n FROM public.sharing_fee_bills')).rows[0].n,2);
});
check('fee context and date are original invoice facts and caller proofs cannot override them',async f=>{
 assert.equal((await f.pay()).response.status,201);
 for(const patch of [{sharing:{...f.input.sharing,asOf:'2026-11-08'}},{sharing:{...f.input.sharing,sourceStamp:'forged'}},{sharing:{...f.input.sharing,approved:true}},{sharing:{...f.input.sharing,asOf:'2026-02-30'}},{lines:[{...f.input.lines[0],studentId:null}]},{lines:[{...f.input.lines[0],classId:null}]}])assert.equal((await f.bill(patch)).response.status,400,JSON.stringify(patch));
 assert.equal((await f.bill({sharing:{...f.input.sharing,asOf:'2026-11-04'}})).response.status,409);
});
check('upper approval pins fee capacity so competing bills make pending fees stale',async f=>{
 const receipt=await f.pay();assert.equal(receipt.response.status,201);await access(f,'staff');await access(f,'manager');const pending=await f.bill({},'staff');assert.equal(pending.response.status,202,JSON.stringify(pending.body));assert.equal((await f.approve(pending.body.approval.id,'staff')).response.status,403);
 assert.equal((await f.bill({documentNumber:'COMPETING',lines:partial(f,'25')})).response.status,201);assert.equal((await f.approve(pending.body.approval.id,'manager')).response.status,409);
 const fresh=await f.bill({documentNumber:'REMAINDER',lines:partial(f,'50')},'staff');assert.equal(fresh.response.status,202);assert.equal((await f.approve(fresh.body.approval.id,'manager')).response.status,200);
 const extra=await f.pay({amount:'0.01'});assert.equal(extra.response.status,409);assert.equal((await f.pg.query('SELECT count(*)::integer n FROM public.sharing_fee_bills')).rows[0].n,2);
});
check('a receipt correction invalidates a pending fee but does not silently erase an already issued liability',async f=>{
 const receipt=await f.pay();assert.equal(receipt.response.status,201);await access(f,'staff');await access(f,'manager');const pending=await f.bill({lines:partial(f,'50')},'staff');assert.equal(pending.response.status,202);
 const issued=await f.bill({documentNumber:'ISSUED',lines:partial(f,'25')});assert.equal(issued.response.status,201);
 assert.equal((await f.request('finance/receipts/'+receipt.body.data.id+'/reverse',{period:{id:f.period.id,version:1},postedOn:'2026-11-07',reason:'Correct the original tuition receipt'})).response.status,201);
 assert.equal((await f.approve(pending.body.approval.id,'manager')).response.status,409);const capacity=await f.capacity(1,'2026-11-07');assert.equal(capacity.availableNetMinor,'-2500');assert.equal(capacity.alreadyBilledNetMinor,'2500');
 const retained=await f.request('finance/expense-bills/'+issued.body.data.id);assert.equal(retained.body.data.status,'recorded');assert.equal(retained.body.data.net,'25.00');assert.equal((await f.bill({documentNumber:'NO-NEW',sharing:{...f.input.sharing,asOf:'2026-11-07'},lines:partial(f,'1')})).response.status,409);
 assert.equal((await f.bill({documentNumber:'OLD-CUTOFF-BYPASS',lines:partial(f,'1')})).body.error.code,'SHARING_FEE_EXCEEDS_RELEASED_CAPACITY');assert.equal((await f.capacity()).availableNetMinor,'-2500');
 assert.equal((await f.cancel(issued.body.data.id)).response.status,201);assert.equal((await f.capacity(1,'2026-11-08','2026-11-08')).availableNetMinor,'0');
});
check('a historical cutoff cannot bypass a credit cancellation effective before the fee bill posting date',async f=>{
 assert.equal((await f.pay()).response.status,201);assert.equal((await f.save({expectedVersion:1,creditHandling:'cancel_on_credit'})).response.status,200);
 assert.equal((await f.credit(f.invoice.id,{issuedAt:'2026-11-07T12:00:00Z'})).response.status,201);const sharing={...f.input.sharing,policyVersion:2};
 assert.equal((await f.bill({sharing})).body.error.code,'SHARING_FEE_EXCEEDS_RELEASED_CAPACITY');const c=await f.capacity(2);assert.equal(c.entitlement.cancelledByCredit,false);assert.equal(c.postingDateReleasedNetMinor,'0');assert.equal(c.claimableReleasedNetMinor,'0');
});
check('fee capacity API exposes complete source-bound remaining net with both original and expense permissions',async f=>{
 const path='finance/invoices/'+f.invoice.id+'/sharing-fee-capacity?',params=new URLSearchParams({payeeId:f.hubPayee.id,policyVersion:'1',asOf:'2026-11-06',postedOn:'2026-11-07'}),read=(as='master',extra='')=>f.request(path+params+extra,undefined,as);
 assert.equal((await f.pay()).response.status,201);const initial=await read();assert.equal(initial.response.status,200,JSON.stringify(initial.body));assert.equal(initial.body.data.availableNet,'75.00');assert.equal((await f.bill({lines:partial(f,'25')})).response.status,201);const r=await read();assert.equal(r.response.status,200);assert.equal(r.body.data.alreadyBilledNet,'25.00');assert.equal(r.body.data.availableNet,'50.00');assert.equal(r.body.data.feeTaxInferred,false);assert.equal(r.body.data.accountingPosted,false);assert.equal(r.body.data.sourceStamp,(await f.capacity()).sourceStamp);
 assert.equal((await read('master','&sourceStamp=forged')).response.status,400);const role=await access(f,'staff');assert.equal((await read('staff')).response.status,200);await f.pg.query("DELETE FROM public.role_permissions WHERE role_id=$1 AND capability='expenses.view'",[role.id]);assert.equal((await read('staff')).response.status,403);
});
check('sharing invoice filter keeps linked fee bills together in expenses without admitting ordinary bills or lending source access',async f=>{
 assert.equal((await f.pay()).response.status,201);const first=await f.bill({documentNumber:'FEE-A',lines:partial(f,'25')}),second=await f.bill({documentNumber:'FEE-B',lines:partial(f,'25')});assert.equal(first.response.status,201);assert.equal(second.response.status,201);
 assert.equal((await f.bill({sharing:undefined,documentNumber:'ORDINARY',lines:partial(f,'25')})).response.status,201);
 const path='finance/expense-bills?sharingInvoiceId='+f.invoice.id+'&limit=1',page=await f.request(path);assert.equal(page.response.status,200,JSON.stringify(page.body));assert.equal(page.body.data.length,1);assert.ok(page.body.nextCursor);const next=await f.request(path+'&after='+page.body.nextCursor);assert.equal(next.body.data.length,1);assert.deepEqual([page.body.data[0].id,next.body.data[0].id].sort(),[first.body.data.id,second.body.data.id].sort());
 const role=await access(f,'staff');assert.equal((await f.request(path,undefined,'staff')).response.status,200);await f.pg.query("DELETE FROM public.role_permissions WHERE role_id=$1 AND capability='share-rules.view'",[role.id]);assert.equal((await f.request(path,undefined,'staff')).response.status,403);assert.equal((await f.request('finance/expense-bills',undefined,'staff')).body.data.length,3);
});
check('approval history and decisions lose access when original receipt rights are revoked,without hiding an ordinary expense',async f=>{
 assert.equal((await f.pay()).response.status,201);const role=await access(f,'staff');await access(f,'manager');const pending=await f.bill({},'staff');assert.equal(pending.response.status,202);assert.equal((await f.request('approvals/'+pending.body.approval.id,undefined,'staff')).response.status,200);
 await f.pg.query("DELETE FROM public.role_permissions WHERE role_id=$1 AND capability='receipts.view'",[role.id]);assert.equal((await f.request('approvals/'+pending.body.approval.id,undefined,'staff')).response.status,404);assert.equal((await f.request('approvals/'+pending.body.approval.id+'/assessments',undefined,'staff')).response.status,404);assert.equal((await f.approve(pending.body.approval.id,'manager')).response.status,409);
 const bill=await f.bill({documentNumber:'MASTER'});assert.equal(bill.response.status,201);const read=await f.request('finance/expense-bills/'+bill.body.data.id,undefined,'staff');assert.equal(read.response.status,200);assert.equal(read.body.data.sharing,null);assert.equal((await f.cancel(bill.body.data.id,{},'staff')).response.status,403);
 const ordinary=await f.request('finance/expense-bills',{...f.input,sharing:undefined,payee:{id:f.payee.id,version:1},documentNumber:'ORDINARY'},'staff');assert.equal(ordinary.response.status,202,JSON.stringify(ordinary.body));
});
check('bot proposals need their own original source rights and bots cannot approve or bypass the human reviewer',async f=>{
 assert.equal((await f.pay()).response.status,201);const role=await access(f,'bot');const p=await f.bill({},'bot');assert.equal(p.response.status,202,JSON.stringify(p.body));assert.equal((await f.approve(p.body.approval.id,'bot')).response.status,403);assert.equal((await f.approve(p.body.approval.id)).response.status,200);
 await f.pg.query("DELETE FROM public.role_permissions WHERE role_id=$1 AND capability='share-rules.view'",[role.id]);assert.equal((await f.bill({documentNumber:'NO-OWN-SOURCE'},'bot')).response.status,403);
});
check('actual finite bearer ceilings cannot borrow the bot role full source rights or another hub',async f=>{
 assert.equal((await f.pay()).response.status,201);await access(f,'bot');const caps=(await f.pg.query<{name:string}>('SELECT name FROM public.capability_catalog')).rows.map(r=>r.name);
 async function key(capabilities:string[],hub:string,allHubs=false){const id=randomUUID(),token=mintToken();await f.pg.query("INSERT INTO auth_private.credentials(id,academy_id,person_id,token_hash,capabilities,all_hubs,expires_at) VALUES($1,$2,$3,$4,$5,$6,now()+interval '1 day')",[id,f.a,f.bot,hashToken(token),capabilities,allHubs]);if(!allHubs)await f.pg.query('INSERT INTO auth_private.credential_hubs(academy_id,credential_id,hub_id) VALUES($1,$2,$3)',[f.a,id,hub]);return token;}
 // Currency selection is an existing academy-wide capability. Do not weaken
 // that independent ceiling to make a hub-only posting test pass.
 const noReceipts=await key(caps.filter(c=>c!=='receipts.view'),f.hub,true),wrongHub=await key(caps,f.otherHub),readKey=await key(['invoices.view','share-rules.view','receipts.view','expenses.view'],f.hub),postingKey=await key(['expenses.view','expenses.edit','currencies.view','payees.view','accounts.view','journals.view','journals.edit','tax-codes.view','classes.view','students.view','invoices.view','share-rules.view','receipts.view'],f.hub,true),path='finance/invoices/'+f.invoice.id+'/sharing-fee-capacity?'+new URLSearchParams({payeeId:f.hubPayee.id,policyVersion:'1',asOf:'2026-11-06',postedOn:'2026-11-07'});
 assert.equal((await f.request('finance/expense-bills',f.input,'bot',{bearer:noReceipts})).response.status,403);assert.ok([403,404].includes((await f.request(path,undefined,'bot',{bearer:wrongHub})).response.status));assert.equal((await f.request(path,undefined,'bot',{bearer:readKey})).response.status,200);
 const good=await f.request('finance/expense-bills',f.input,'bot',{bearer:postingKey});assert.equal(good.response.status,202,JSON.stringify(good.body));assert.equal((await f.approve(good.body.approval.id)).response.status,200);
});
check('retries and event failures retain neither duplicate fee claims nor partial expense postings',async f=>{
 assert.equal((await f.pay()).response.status,201);const key=randomUUID(),r=await f.bill({lines:partial(f,'25')},'master',key);assert.equal(r.response.status,201);assert.deepEqual((await f.bill({lines:partial(f,'25')},'master',key)).body,r.body);
 await f.pg.exec('REVOKE INSERT ON public.outbox_events FROM kavosh_runtime');try{assert.equal((await f.bill({documentNumber:'FAIL',lines:partial(f,'25')})).response.status,503);}finally{await f.pg.exec('GRANT INSERT ON public.outbox_events TO kavosh_runtime');}
 assert.equal((await f.pg.query('SELECT count(*)::integer n FROM public.sharing_fee_bills')).rows[0].n,1);assert.equal((await f.pg.query('SELECT count(*)::integer n FROM public.expense_bills')).rows[0].n,1);assert.equal((await f.capacity()).availableNetMinor,'5000');
});
check('actual hub fee bills use the existing due reminder pipeline and paying the bill invalidates its portal reminder',async f=>{
 assert.equal((await f.pay()).response.status,201);const today=(await f.pg.query<{today:string}>("SELECT (statement_timestamp() AT TIME ZONE 'America/Toronto')::date::text today")).rows[0].today,created=await f.bill({dueOn:today});assert.equal(created.response.status,201);
 const role=await f.made('roles',{name:'Hub fee payment viewer only',permissions:['expenses.view','expense-payments.view'].map(capability=>({capability,effect:'allow'}))}),path='people/'+f.actors.staff.person+'/access';assert.equal((await f.request(path,{expectedVersion:(await f.request(path)).body.data.version,assignments:[{roleId:role.id,allHubs:false,hubIds:[f.hub]}]})).response.status,200);
 const definition={name:'Hub fee due',enabled:true,expenseReminder:{daysFromDue:0,timeZone:'America/Toronto'},trigger:{kind:'domain_event',eventTypes:['expense.reminder_due']},condition:{op:'exists',field:'entityId'},actions:[{kind:'notify',channels:['portal'],audience:{kind:'people',personIds:[f.actors.staff.person]},title:{en:'Hub fee due'},body:{en:'Review the recorded expense bill.'}}],execution:{mode:'automatic',maxRecipientsPerEvent:10,maxDailyDeliveries:100,maxDailySms:0,cooldownSeconds:0,maxChainDepth:1}},rule=await f.made('automations/rules',{hubId:null,code:'HUB_FEE_DUE',definition,reason:'Actual linked fee reminder'});await f.made('automations/rules/'+rule.id+'/subscriptions',{expectedVersion:1,reason:'Reviewed fee watch'});
 const database:Database={async connect(){const c=f.pg.runtime?await f.pg.runtime.connect():{query:f.pg.query.bind(f.pg),release(){}};await c.query('SET ROLE kavosh_automation_worker');return c;}};
 try{assert.equal((await processOneSubscription(database,[f.a])).outcome,'queued');assert.equal((await processOneNotification(database,[f.a])).outcome,'succeeded');}finally{if(!f.pg.runtime)await f.pg.exec('RESET ROLE');}
 const inbox=await f.request('notifications?origin=automation',undefined,'staff');assert.equal(inbox.response.status,200);const notice=inbox.body.data[0];assert.equal(notice.source.kind,'expense_due');assert.equal(notice.source.billId,created.body.data.id);assert.equal(notice.reminderStillCurrent,true);assert.equal(notice.bankSettlementVerified,false);assert.ok(!JSON.stringify(inbox.body).includes('source_snapshot'));assert.equal((await f.request('finance/expense-bills/'+created.body.data.id,undefined,'staff')).body.data.sharing,null);
 assert.equal((await f.request('finance/expense-bills/'+created.body.data.id+'/payments',{fundingAccount:{id:f.cash.id,version:1},payableVersion:1,method:{id:f.method.id,version:1},amount:'84.75',period:{id:f.period.id,version:1},postedOn:'2026-11-08',paidAt:'2026-11-08T12:00:00Z',missingEvidenceReason:'Synthetic recorded fee payment',taxTreatment:'settle_expense_bill',reason:'Clear the actual fee bill'})).response.status,201);assert.equal((await f.request('notifications?origin=automation',undefined,'staff')).body.data[0].reminderStillCurrent,false);
});
check('native fee links are tenant isolated and immutable and cannot be appended to an unrelated approved bill',async f=>{
 assert.equal((await f.pay()).response.status,201);const r=await f.bill();assert.equal(r.response.status,201);await f.pg.exec('SET ROLE kavosh_runtime');try{
  await f.pg.query("SELECT set_config('app.academy_id',$1,false)",[f.b]);assert.equal((await f.pg.query('SELECT * FROM public.sharing_fee_bills')).rows.length,0);assert.equal((await f.pg.query('SELECT public.sharing_fee_capacity($1,1,$2,DATE \'2026-11-06\',DATE \'2026-11-07\') s',[f.invoice.id,f.hubPayee.id])).rows[0].s,null);
  await f.pg.query("SELECT set_config('app.academy_id',$1,false)",[f.a]);for(const sql of ['DELETE FROM public.sharing_fee_bills','UPDATE public.sharing_fee_bills SET policy_version=2'])await assert.rejects(f.pg.exec(sql),/permission denied/);
 }finally{await f.pg.exec('RESET ROLE');}
 const ordinary=await f.bill({sharing:undefined,documentNumber:'ORDINARY'});assert.equal(ordinary.response.status,201);const link=(await f.pg.query('SELECT * FROM public.sharing_fee_bills')).rows[0];await f.pg.exec('SET ROLE kavosh_runtime');try{
  await f.pg.query("SELECT set_config('app.academy_id',$1,false)",[f.a]);await assert.rejects(f.pg.query('INSERT INTO public.sharing_fee_bills(academy_id,bill_id,invoice_id,sharing_plan_id,policy_version,payee_id,as_of,source_snapshot,approval_id,created_by) VALUES($1,$2,$3,$4,1,$5,$6,$7,$8,$9)',[f.a,ordinary.body.data.id,f.invoice.id,link.sharing_plan_id,f.hubPayee.id,'2026-11-06',link.source_snapshot,ordinary.body.approval.id,f.actors.master.person]),/SHARING_FEE_SOURCE_OR_REVIEW_INVALID/);
 }finally{await f.pg.exec('RESET ROLE');}
});
check('native completion rejects an omitted fee link and forged proof after actual expense writes,rolling everything back',async f=>{
 assert.equal((await f.pay()).response.status,201);const before=(await f.pg.query('SELECT count(*)::integer n FROM public.finance_journals')).rows[0].n;
 await f.pg.exec("CREATE FUNCTION public.test_sharing_fee_omit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL;END $$;CREATE TRIGGER aaa_test_sharing_fee_omit BEFORE INSERT ON public.sharing_fee_bills FOR EACH ROW EXECUTE FUNCTION public.test_sharing_fee_omit()");
 try{const r=await f.bill();assert.equal(r.response.status,400);assert.equal(r.body.error.code,'INVALID_INPUT');assert.equal(f.metrics.queryFailures.at(-1)?.sqlState,'23514');}finally{await f.pg.exec('DROP TRIGGER aaa_test_sharing_fee_omit ON public.sharing_fee_bills;DROP FUNCTION public.test_sharing_fee_omit()');}
 assert.equal((await f.pg.query('SELECT count(*)::integer n FROM public.expense_bills')).rows[0].n,0);assert.equal((await f.pg.query('SELECT count(*)::integer n FROM public.finance_journals')).rows[0].n,before);
 await f.pg.exec("CREATE FUNCTION public.test_sharing_fee_forge() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.source_snapshot=jsonb_set(NEW.source_snapshot,'{availableNetMinor}','\"999999\"');RETURN NEW;END $$;CREATE TRIGGER aaa_test_sharing_fee_forge BEFORE INSERT ON public.sharing_fee_bills FOR EACH ROW EXECUTE FUNCTION public.test_sharing_fee_forge()");
 try{const r=await f.bill();assert.equal(r.response.status,400);assert.equal(r.body.error.code,'INVALID_INPUT');assert.equal(f.metrics.queryFailures.at(-1)?.sqlState,'23514');}finally{await f.pg.exec('DROP TRIGGER aaa_test_sharing_fee_forge ON public.sharing_fee_bills;DROP FUNCTION public.test_sharing_fee_forge()');}
 assert.equal((await f.pg.query('SELECT count(*)::integer n FROM public.sharing_fee_bills')).rows[0].n,0);assert.equal((await f.bill()).response.status,201);
});
test('schema262 to263 preserves all pre-existing financial and sharing rows and source function grants',async()=>{
 const f=await fixture(262);try{assert.equal((await f.pay()).response.status,201);const tables=['revenue_share_plans','revenue_share_revisions','revenue_share_lines','tuition_invoices','tuition_receipts','expense_bills','expense_bill_lines','finance_journals','finance_journal_lines','approval_requests','audit_events','outbox_events'],before=[];for(const t of tables)before.push((await f.pg.query('SELECT to_jsonb(r) data FROM public.'+t+' r ORDER BY to_jsonb(r)::text')).rows);
  const property="SELECT oid,proowner,proacl,proconfig,provolatile FROM pg_proc WHERE oid='public.sharing_release_snapshot(uuid,integer,date)'::regprocedure",original=(await f.pg.query(property)).rows;
  await f.pg.exec(await readFile(new URL('../db/migrations/263_sharing_fee_bills.sql',import.meta.url),'utf8'));for(let n=0;n<tables.length;n++)assert.deepEqual((await f.pg.query('SELECT to_jsonb(r) data FROM public.'+tables[n]+' r ORDER BY to_jsonb(r)::text')).rows,before[n]);assert.deepEqual((await f.pg.query(property)).rows,original);assert.equal((await f.bill()).response.status,201);
 }finally{await f.pg.close();}
});
if(process.env.TEST_DATABASE_URL)check('two concurrent fee bills cannot reserve the same released tuition twice',async f=>{
 assert.equal((await f.pay()).response.status,201);const start=performance.now(),results=await Promise.all([f.bill({documentNumber:'RACE-A'}),f.bill({documentNumber:'RACE-B'})]);assert.equal(results.filter(r=>r.response.status===201).length,1,JSON.stringify(results.map(r=>r.body)));assert.equal(results.filter(r=>r.response.status===409).length,1);assert.equal((await f.capacity()).availableNetMinor,'0');assert.equal((await f.pg.query('SELECT count(*)::integer n FROM public.sharing_fee_bills')).rows[0].n,1);console.log(JSON.stringify({measurement:'brief-sharing-fee-double-claim',requests:2,winners:1,elapsedMs:Math.ceil(performance.now()-start)}));
});
if(process.env.TEST_DATABASE_URL)check('fee issuance versus actual receipt correction serializes without deadlock and never lets an old cutoff recreate the fee',async f=>{
 const paid=await f.pay();assert.equal(paid.response.status,201);const start=performance.now(),[fee,correction]=await Promise.all([f.bill(),f.request('finance/receipts/'+paid.body.data.id+'/reverse',{period:{id:f.period.id,version:1},postedOn:'2026-11-07',reason:'Concurrent receipt correction'})]);assert.equal(correction.response.status,201,JSON.stringify(correction.body));assert.ok([201,409].includes(fee.response.status),JSON.stringify(fee.body));assert.equal((await f.capacity()).availableNetMinor,fee.response.status===201?'-7500':'0');assert.equal((await f.bill({documentNumber:'NO-STALE-RECREATE'})).response.status,409);console.log(JSON.stringify({measurement:'brief-sharing-fee-receipt-correction',requests:2,feeIssued:fee.response.status===201,elapsedMs:Math.ceil(performance.now()-start)}));
});
