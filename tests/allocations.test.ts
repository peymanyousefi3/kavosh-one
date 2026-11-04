import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { receiptFixture } from './receipt-fixture.ts';

async function fixture(){
 const f=await receiptFixture(),payment=await f.pay({amount:'80'});assert.equal(payment.response.status,201,JSON.stringify(payment.body));const id=payment.body.data.id,path='finance/receipts/'+id+'/allocations';
 const allocate=(patch:Record<string,unknown>={},as='master',key?:string)=>f.request(path,{expectedVersion:0,mode:'oldest_due',reason:'Private allocation evidence',...patch},as,{key});
 const read=(suffix='',as='master')=>f.request(path+suffix,undefined,as),status=()=>f.request('finance/invoices/'+f.invoice.id+'/installment-status?overdueOn=2026-12-02');
 return {...f,paymentId:id,path,allocate,read,installments:status};
}
type Fixture=Awaited<ReturnType<typeof fixture>>;
function check(name:string,run:(f:Fixture)=>Promise<void>){test(name,async()=>{const f=await fixture();try{await run(f);}finally{await f.pg.close();}});}
async function access(f:Fixture,as:string,caps=['allocations.view','allocations.edit','receipts.view','invoices.view']){
 const role=await f.made('roles',{name:'Allocation access '+as,permissions:caps.map(capability=>({capability,effect:'allow'}))}),person=as==='bot'?f.bot:f.actors[as].person,path='people/'+person+'/access',old=await f.request(path);
 assert.equal((await f.request(path,{expectedVersion:old.body.data.version,assignments:[{roleId:role.id,allHubs:true},...as==='manager'?[{roleId:f.managerRole,allHubs:false,hubIds:[f.hub]}]:[]]})).response.status,200);return role;
}
check('oldest-due allocations conserve every unit and mark installments without posting money or tax twice',async f=>{
 const before=(await f.pg.query('SELECT * FROM public.finance_journals')).rows.length;
 assert.equal((await f.read()).body.data.version,0);const r=await f.allocate();assert.equal(r.response.status,200,JSON.stringify({body:r.body,failures:f.metrics.queryFailures}));assert.deepEqual(r.body.data.lines,[{installment:1,amount:'50.00'},{installment:2,amount:'30.00'}]);assert.equal(r.body.data.allocated,'80.00');assert.equal(r.body.data.unallocated,'0.00');assert.equal(r.body.data.additionalLedgerPosting,false);
 const status=await f.installments();assert.equal(status.response.status,200,JSON.stringify(status.body));assert.deepEqual(status.body.data.installments.map((i:any)=>[i.outstanding,i.status]),[['0.00','paid'],['33.00','partially_paid']]);assert.equal((await f.pg.query('SELECT * FROM public.finance_journals')).rows.length,before);
});
check('previews are side-effect free and honor a chosen partial budget before applying the exact suggestion',async f=>{
 const preview=await f.request(f.path+'/preview',{expectedVersion:0,mode:'oldest_due',amount:'60'});assert.equal(preview.response.status,200,JSON.stringify(preview.body));assert.equal(preview.body.data.previewOnly,true);assert.deepEqual(preview.body.data.lines,[{installment:1,amount:'50.00'},{installment:2,amount:'10.00'}]);assert.equal(preview.body.data.unallocated,'20.00');assert.equal((await f.pg.query('SELECT * FROM public.receipt_allocation_plans')).rows.length,0);
 const r=await f.allocate({amount:'60'});assert.equal(r.response.status,200);assert.deepEqual(r.body.data.lines,preview.body.data.lines);
});
check('complete manual replacements and clearing preserve historical versions without forgiving tuition',async f=>{
 assert.equal((await f.allocate()).response.status,200);const replace=await f.allocate({expectedVersion:1,mode:'manual',lines:[{installment:2,amount:'60'}]});assert.equal(replace.response.status,200,JSON.stringify(replace.body));assert.equal(replace.body.data.version,2);assert.equal(replace.body.data.unallocated,'20.00');assert.deepEqual((await f.read('?version=1')).body.data.lines,[{installment:1,amount:'50.00'},{installment:2,amount:'30.00'}]);
 const status=await f.installments();assert.equal(status.body.data.installments[0].status,'needs_allocation');assert.equal(status.body.data.allocationReviewRequired,true);assert.equal(status.body.data.unallocatedReceived,'20.00');assert.equal(status.body.data.installments[0].outstanding,'50.00');const cleared=await f.allocate({expectedVersion:2,mode:'manual',lines:[]});assert.equal(cleared.response.status,200);assert.equal(cleared.body.data.allocated,'0.00');assert.equal((await f.status()).received,'80.00');
 const first=await f.read('/history?limit=1');assert.equal(first.body.nextVersion,1);assert.equal((await f.read('/history?afterVersion=1&limit=1')).body.data[0].version,2);assert.ok(!JSON.stringify((await f.read()).body).includes('Private allocation evidence'));
});
check('receipt and installment caps, duplicate lines, stale versions and malformed amounts reject over-allocation',async f=>{
 for(const patch of [{mode:'manual',lines:[{installment:1,amount:'51'}]},{mode:'manual',lines:[{installment:1,amount:'50'},{installment:2,amount:'31'}]},{mode:'manual',lines:[{installment:1,amount:'1'},{installment:1,amount:'1'}]},{mode:'manual',lines:[{installment:999,amount:'1'}]},{mode:'manual',lines:[{installment:1,amount:'0'}]},{mode:'manual',lines:[{installment:1,amount:'1.001'}]},{amount:'81'},{mode:'oldest_due',lines:[]},{expectedVersion:99}]){const r=await f.allocate(patch);assert.ok([400,409].includes(r.response.status),JSON.stringify({patch,body:r.body}));}
 assert.equal((await f.pg.query('SELECT * FROM public.receipt_allocation_plans')).rows.length,0);
 const other=await f.pay({amount:'33'});assert.equal(other.response.status,201);const allocated=await f.request('finance/receipts/'+other.body.data.id+'/allocations',{expectedVersion:0,mode:'manual',lines:[{installment:1,amount:'33'}],reason:'Other receipt allocation'});assert.equal(allocated.response.status,200,JSON.stringify(allocated.body));
 const r=await f.allocate();assert.equal(r.response.status,200);assert.deepEqual(r.body.data.lines,[{installment:1,amount:'17.00'},{installment:2,amount:'63.00'}]);
});
check('receipt corrections and invoice credits deactivate allocations while retaining complete history',async f=>{
 assert.equal((await f.allocate()).response.status,200);assert.equal((await f.reverse(f.paymentId)).response.status,201);const old=await f.read();assert.equal(old.body.data.active,false);assert.equal(old.body.data.allocated,'80.00');assert.equal(old.body.data.effectiveAllocated,'0.00');assert.equal((await f.installments()).body.data.installments[0].outstanding,'50.00');assert.equal((await f.allocate({expectedVersion:1})).body.error.code,'ACTIVE_RECEIPT_AND_INVOICE_REQUIRED');
});
check('credited invoices keep allocation history but no installment remains due or accepts new allocation',async f=>{
 assert.equal((await f.allocate()).response.status,200);assert.equal((await f.credit(f.invoice.id)).response.status,201);assert.equal((await f.read()).body.data.active,false);assert.ok((await f.installments()).body.data.installments.every((i:any)=>i.status==='credited'&&i.outstanding==='0.00'));assert.equal((await f.allocate({expectedVersion:1})).response.status,409);
});
check('allocation retries and event failures preserve one atomic revision and cannot leave partial headers or lines',async f=>{
 const key=randomUUID(),r=await f.allocate({},'master',key);assert.equal(r.response.status,200);assert.deepEqual((await f.allocate({},'master',key)).body,r.body);assert.equal((await f.pg.query('SELECT * FROM public.receipt_allocation_revisions')).rows.length,1);
 await f.pg.exec('REVOKE INSERT ON public.outbox_events FROM kavosh_runtime');try{assert.equal((await f.allocate({expectedVersion:1,mode:'manual',lines:[]})).response.status,503);}finally{await f.pg.exec('GRANT INSERT ON public.outbox_events TO kavosh_runtime');}
 assert.equal((await f.read()).body.data.currentVersion,1);assert.equal((await f.pg.query('SELECT * FROM public.receipt_allocation_lines')).rows.length,2);
});
check('allocation viewers can inspect their own installment breakdown without access to ledger or private review history',async f=>{
 assert.equal((await f.allocate()).response.status,200);const role=await f.made('roles',{name:'Selected student allocations',permissions:['receipts.view','invoices.view','allocations.view'].map(capability=>({capability,effect:'allow'}))}),path='people/'+f.actors.staff.person+'/access',old=await f.request(path);assert.equal((await f.request(path,{expectedVersion:old.body.data.version,assignments:[{roleId:role.id,allHubs:false,personIds:[f.student.id]}]})).response.status,200);
 assert.equal((await f.read('','staff')).response.status,200);assert.equal((await f.read('/history','staff')).response.status,403);assert.equal((await f.request('finance/invoices/'+f.invoice.id+'/installment-status',undefined,'staff')).response.status,200);assert.equal((await f.request('finance/journals/'+f.paymentId,undefined,'staff')).response.status,403);assert.equal((await f.request(f.path,undefined,'foreignMaster',{academy:f.b})).response.status,404);
});
check('upper approval and unchanged source balances are required, while bots can only propose allocations',async f=>{
 const role=await access(f,'staff');await access(f,'manager');const pending=await f.allocate({},'staff');assert.equal(pending.response.status,202,JSON.stringify(pending.body));assert.equal((await f.read()).body.data.version,0);assert.equal((await f.approve(pending.body.approval.id,'staff')).response.status,403);assert.equal((await f.approve(pending.body.approval.id,'manager')).response.status,200);
 const revoked=await f.allocate({expectedVersion:1,mode:'manual',lines:[]},'staff');assert.equal(revoked.response.status,202);await f.pg.query("DELETE FROM public.role_permissions WHERE role_id=$1 AND capability='allocations.edit'",[role.id]);assert.equal((await f.request('approvals/'+revoked.body.approval.id,undefined,'staff')).response.status,404);assert.equal((await f.approve(revoked.body.approval.id)).response.status,409);
 await access(f,'bot');const bot=await f.allocate({expectedVersion:1,mode:'manual',lines:[]},'bot');assert.equal(bot.response.status,202,JSON.stringify(bot.body));assert.equal((await f.approve(bot.body.approval.id,'bot')).response.status,403);assert.equal((await f.approve(bot.body.approval.id)).response.status,200);
});
check('native allocation rows are tenant-bound and immutable, and late appends cannot alter completed revisions',async f=>{
 assert.equal((await f.allocate({mode:'manual',lines:[{installment:1,amount:'50'}]})).response.status,200);await f.pg.exec('SET ROLE kavosh_runtime');try{
  await f.pg.query("SELECT set_config('app.academy_id',$1,false)",[f.b]);assert.equal((await f.pg.query('SELECT * FROM public.receipt_allocation_revisions')).rows.length,0);await f.pg.query("SELECT set_config('app.academy_id',$1,false)",[f.a]);
  for(const sql of ['DELETE FROM public.receipt_allocation_plans',"UPDATE public.receipt_allocation_revisions SET total_minor=1",'DELETE FROM public.receipt_allocation_lines'])await assert.rejects(f.pg.exec(sql),/permission denied/i);
  await assert.rejects(f.pg.query('INSERT INTO public.receipt_allocation_lines VALUES($1,$2,1,$3,1,2,1)',[f.a,f.paymentId,f.plan.id]),/ALLOCATION_TOTAL_INVALID/);
 }finally{await f.pg.exec('RESET ROLE');}assert.equal((await f.read()).body.data.lines.length,1);
});
check('read-only schools allow non-mutating previews but not allocation changes',async f=>{
 await f.pg.query("UPDATE public.academies SET status='read_only' WHERE id=$1",[f.a]);assert.equal((await f.request(f.path+'/preview',{expectedVersion:0,mode:'oldest_due'})).response.status,200);assert.equal((await f.allocate()).response.status,403);
});
check('approved receipts allocate oldest-due-first by default under their original receipt approval',async f=>{
 const r=await f.pay({amount:'33',allocation:undefined});assert.equal(r.response.status,201,JSON.stringify({body:r.body,failures:f.metrics.queryFailures}));const id=r.body.data.id,a=await f.request('finance/receipts/'+id+'/allocations');assert.equal(a.response.status,200);assert.deepEqual(a.body.data.lines,[{installment:1,amount:'33.00'}]);assert.equal(a.body.data.allocated,'33.00');
 const stored=(await f.pg.query('SELECT a.approval_id=r.approval_id AS same FROM public.receipt_allocation_revisions a JOIN public.tuition_receipts r ON r.academy_id=a.academy_id AND r.id=a.receipt_id WHERE r.id=$1',[id])).rows[0];assert.equal(stored.same,true);assert.equal((await f.pg.query('SELECT * FROM public.finance_journals')).rows.length,3);
});
check('routine receipt staff need no discretionary allocation permission for the deterministic default',async f=>{
 const caps=['receipts.view','receipts.edit','invoices.view','tuition.view','collectors.view','payment-methods.view','accounts.view','journals.view','journals.edit','periods.view'];await access(f,'staff',caps);await access(f,'manager',caps);
 const pending=await f.pay({amount:'33',allocation:'oldest_due'},'staff');assert.equal(pending.response.status,202,JSON.stringify(pending.body));const accepted=await f.approve(pending.body.approval.id,'manager');assert.equal(accepted.response.status,200,JSON.stringify({body:accepted.body,failures:f.metrics.queryFailures}));const id=accepted.body.data.id;
 assert.equal((await f.request('finance/receipts/'+id+'/allocations',undefined,'staff')).response.status,403);assert.equal((await f.request('finance/receipts/'+id+'/allocations')).body.data.allocated,'33.00');
});
check('changed allocation capacity invalidates a pending automatic receipt instead of silently changing its reviewed split',async f=>{
 const caps=['receipts.view','receipts.edit','invoices.view','tuition.view','collectors.view','payment-methods.view','accounts.view','journals.view','journals.edit','periods.view'];await access(f,'staff',caps);const pending=await f.pay({amount:'33',allocation:'oldest_due'},'staff');assert.equal(pending.response.status,202);
 assert.equal((await f.allocate()).response.status,200);const stale=await f.approve(pending.body.approval.id);assert.equal(stale.response.status,409);assert.equal(stale.body.approval.decisionCode,'DEPENDENCIES_CHANGED');assert.equal((await f.status()).received,'80.00');
});
check('an automatic allocation event failure rolls back the entire new receipt, journal and allocation',async f=>{
 await f.pg.exec("CREATE FUNCTION public.reject_test_allocation_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.event_type='finance.receipt.allocated' THEN RAISE EXCEPTION 'SYNTHETIC_ALLOCATION_EVENT_FAILURE';END IF;RETURN NEW;END $$; CREATE TRIGGER reject_test_allocation_event BEFORE INSERT ON public.outbox_events FOR EACH ROW EXECUTE FUNCTION public.reject_test_allocation_event()");
 try{assert.equal((await f.pay({amount:'33',allocation:'oldest_due'})).response.status,503);}finally{await f.pg.exec('DROP TRIGGER reject_test_allocation_event ON public.outbox_events; DROP FUNCTION public.reject_test_allocation_event()');}
 assert.equal((await f.pg.query('SELECT * FROM public.tuition_receipts')).rows.length,1);assert.equal((await f.pg.query('SELECT * FROM public.finance_journals')).rows.length,2);assert.equal((await f.pg.query('SELECT * FROM public.receipt_allocation_plans')).rows.length,0);assert.equal((await f.pay({amount:'33',allocation:'oldest_due'})).response.status,201);
});
check('native automatic allocation validation rejects a forged split that fits the money caps but is not oldest-due-first',async f=>{
 await f.pg.exec("CREATE FUNCTION public.forge_test_allocation_line() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.installment=2;RETURN NEW;END $$; CREATE TRIGGER forge_test_allocation_line BEFORE INSERT ON public.receipt_allocation_lines FOR EACH ROW EXECUTE FUNCTION public.forge_test_allocation_line()");
 try{assert.equal((await f.pay({amount:'33',allocation:'oldest_due'})).response.status,400);}finally{await f.pg.exec('DROP TRIGGER forge_test_allocation_line ON public.receipt_allocation_lines; DROP FUNCTION public.forge_test_allocation_line()');}
 assert.equal((await f.pg.query('SELECT * FROM public.tuition_receipts')).rows.length,1);assert.equal((await f.pg.query('SELECT * FROM public.receipt_allocation_plans')).rows.length,0);
});
check('selected-student allocation editors receive broader upper review without confusing authority shape with money changes',async f=>{
 const common=await access(f,'staff',['receipts.view','invoices.view']);await access(f,'manager');const selected=await f.made('roles',{name:'One student allocation editor',permissions:['allocations.view','allocations.edit'].map(capability=>({capability,effect:'allow'}))}),path='people/'+f.actors.staff.person+'/access',before=await f.request(path);assert.equal((await f.request(path,{expectedVersion:before.body.data.version,assignments:[{roleId:common.id,allHubs:true},{roleId:selected.id,allHubs:false,personIds:[f.student.id]}]})).response.status,200);
 const pending=await f.allocate({},'staff');assert.equal(pending.response.status,202,JSON.stringify(pending.body));const reviewed=await f.approve(pending.body.approval.id,'manager');assert.equal(reviewed.response.status,200,JSON.stringify(reviewed.body));assert.equal(reviewed.body.data.allocated,'80.00');
});
if(process.env.TEST_DATABASE_URL)check('two native competing allocations cannot claim the same installment capacity',async f=>{
 const one=await f.pay({amount:'30'});assert.equal(one.response.status,201);const start=performance.now(),otherPath='finance/receipts/'+one.body.data.id+'/allocations',body={expectedVersion:0,mode:'manual',lines:[{installment:1,amount:'30'}],reason:'Synthetic allocation race'};
 const results=await Promise.all([f.allocate({mode:'manual',lines:[{installment:1,amount:'30'}]}),f.request(otherPath,body)]);assert.equal(results.filter(r=>r.response.status===200).length,1,JSON.stringify(results.map(r=>r.body)));assert.equal(results.filter(r=>r.response.status===409).length,1);console.log(JSON.stringify({measurement:'brief-installment-allocation-race',requests:2,winners:1,elapsedMs:Math.ceil(performance.now()-start)}));
});
