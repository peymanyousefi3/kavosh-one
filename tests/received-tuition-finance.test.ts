import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { receiptFixture } from './receipt-fixture.ts';

async function fixture(){const f=await receiptFixture();try{
 const guardian=await f.request('guardians',{personId:f.actors.staff.person,legalName:'Private family guardian'});assert.equal(guardian.response.status,201);
 const relationship=await f.request('students/'+f.student.id+'/guardians',{guardianId:f.actors.staff.person,relationship:'parent',reason:'Reviewed synthetic legal family'});assert.equal(relationship.response.status,201,JSON.stringify(relationship.body));
 const role=await f.made('roles',{name:'Private family billing',permissions:[{capability:'received-tuition.view',effect:'allow'}]});
 const access=async(as:string,assignments:unknown[])=>{const id=as==='bot'?f.bot:f.actors[as].person,path='people/'+id+'/access',before=await f.request(path),r=await f.request(path,{expectedVersion:before.body.data.version,assignments});assert.equal(r.response.status,200,JSON.stringify(r.body));};
 await access('staff',[{roleId:role.id,allHubs:false,personIds:[f.student.id]}]);
 const root='students/'+f.student.id+'/tuition-invoices',path=root+'/'+f.invoice.id,read=(suffix='',as='staff')=>f.request(path+suffix,undefined,as);
 return {...f,role,access,root,path,read,relationship:relationship.body.data};
 }catch(error){await f.pg.close();throw error;}}
type Fixture=Awaited<ReturnType<typeof fixture>>;
function check(name:string,run:(f:Fixture)=>Promise<void>,nativeOnly=false){test(name,{skip:nativeOnly&&!process.env.TEST_DATABASE_URL},async()=>{const f=await fixture();try{await run(f);}finally{await f.pg.close();}});}

check('family invoices show original issued amounts and exact partial/full recorded receipts without inventing settlement or new postings',async f=>{
 const before=await f.read();assert.equal(before.response.status,200,JSON.stringify(before.body));assert.equal(before.body.data.invoiced,'113.00');assert.equal(before.body.data.balance,'113.00');assert.equal(before.body.data.paymentStatus,'unpaid');assert.equal(before.body.data.planningOnly,false);assert.equal(before.body.data.externalSettlementVerified,false);assert.equal(before.body.data.issuer.legalName,f.definition.legalName);assert.equal(before.response.headers.get('cache-control'),'no-store');
 const payment=await f.pay();assert.equal(payment.response.status,201,JSON.stringify(payment.body));const partial=await f.read();assert.equal(partial.body.data.received,'50.00');assert.equal(partial.body.data.balance,'63.00');assert.equal(partial.body.data.paymentStatus,'partially_paid');
 const remaining=await f.pay({amount:'63'});assert.equal(remaining.response.status,201);const paid=await f.read();assert.equal(paid.body.data.paymentStatus,'paid');assert.equal(paid.body.data.balance,'0.00');const list=await f.request(f.root,undefined,'staff');assert.equal(list.response.status,200);assert.equal(list.body.data[0].received,'113.00');
 const count=(await f.pg.query('SELECT count(*) n FROM public.finance_journals')).rows;await f.read();await f.read('/receipts');assert.deepEqual((await f.pg.query('SELECT count(*) n FROM public.finance_journals')).rows,count);assert.equal((await f.pg.query('SELECT * FROM public.finance_journal_lines WHERE account_id=$1',[f.taxPayable.id])).rows.length,1);
 assert.doesNotMatch(JSON.stringify(paid.body),/Private adult legal name|Private family guardian|Private accounting|billTo|sourceSnapshot|receivable_account|holding_account|taxTimingReview|approval_id/);
});
check('family receipt reversal and invoice credit preserve history and distinguish customer credit from actual refund',async f=>{
 const payment=await f.pay();assert.equal(payment.response.status,201);assert.equal((await f.reverse(payment.body.data.id)).response.status,201);const reversed=await f.read('/receipts?status=reversed');assert.equal(reversed.response.status,200,JSON.stringify(reversed.body));assert.equal(reversed.body.data.length,1);assert.equal(reversed.body.data[0].active,false);assert.equal(reversed.body.data[0].amount,'50.00');assert.equal((await f.read()).body.data.paymentStatus,'unpaid');
 assert.equal((await f.pay({amount:'113'})).response.status,201);const credit=await f.credit(f.invoice.id);assert.equal(credit.response.status,201,JSON.stringify(credit.body));const balance=await f.read();assert.equal(balance.body.data.status,'credited');assert.equal(balance.body.data.received,'113.00');assert.equal(balance.body.data.credited,'113.00');assert.equal(balance.body.data.balance,'-113.00');assert.equal(balance.body.data.paymentStatus,'customer_credit');assert.equal(balance.body.data.refundPerformed,false);assert.ok(balance.body.data.creditNoteNumber);
 assert.equal((await f.request(f.root+'?status=issued',undefined,'staff')).body.data.length,0);assert.equal((await f.request(f.root+'?status=credited',undefined,'staff')).body.data.length,1);assert.equal((await f.read('/receipts?status=recorded')).body.data.length,1);
});
check('family payment directory retains pinned collector/method labels and bounded corrected records without staff evidence or account data',async f=>{
 const a=await f.pay({reference:'Parent receipt reference'}),b=await f.pay({amount:'10'});assert.equal(a.response.status,201);assert.equal(b.response.status,201);
 const renamed=await f.request('finance/payment-methods/'+f.method.id+'/change',{expectedVersion:1,name:'Renamed method',reason:'Synthetic current method'});assert.equal(renamed.response.status,200);
 const page=await f.read('/receipts?limit=1');assert.equal(page.response.status,200,JSON.stringify(page.body));assert.equal(page.body.data.length,1);assert.ok(page.body.nextCursor);const next=await f.read('/receipts?limit=1&after='+page.body.nextCursor);assert.equal(next.body.data.length,1);assert.notEqual(next.body.data[0].id,page.body.data[0].id);assert.equal(next.body.nextCursor,null);
 for(const r of [...page.body.data,...next.body.data]){assert.equal(r.methodName,'Synthetic transfer');assert.equal(r.collectorName,'Synthetic academy-controlled cash');assert.equal(r.status,'recorded');assert.equal(r.externalSettlementVerified,false);}
 assert.doesNotMatch(JSON.stringify(page.body)+JSON.stringify(next.body),/holding|evidence|Private receipt|missingEvidence|approval|received_by|bank|accounts|sourceSnapshot/);
 assert.equal((await f.request('finance/invoices/'+f.invoice.id,undefined,'staff')).response.status,403);assert.equal((await f.request('finance/receipts/'+a.body.data.id,undefined,'staff')).response.status,403);
});
check('family billing rechecks exact record denial and current legal authority before directory balance or payment history',async f=>{
 for(const suffix of ['', '/receipts'])assert.equal((await f.read(suffix,'manager')).response.status,403);
 assert.equal((await f.request(f.root+'/'+randomUUID(),undefined,'staff')).response.status,404);assert.equal((await f.request('students/'+f.actors.manager.person+'/tuition-invoices/'+f.invoice.id,undefined,'staff')).response.status,404);assert.equal((await f.request(f.path,undefined,'foreignMaster',{academy:f.b})).response.status,404);
 const denied=await f.made('roles',{name:'Denied invoice class',permissions:[{capability:'received-tuition.view',effect:'deny'}]});await f.access('staff',[{roleId:f.role.id,allHubs:false,personIds:[f.student.id]},{roleId:denied.id,allHubs:false,classIds:[f.c.id]}]);assert.deepEqual((await f.request(f.root+'?limit=1',undefined,'staff')).body.data,[]);assert.equal((await f.read()).response.status,404);assert.equal((await f.read('/receipts')).response.status,404);
 await f.access('staff',[{roleId:f.role.id,allHubs:true}]);assert.equal((await f.read()).response.status,200);assert.equal((await f.request('family-relationships/'+f.relationship.id+'/suspend',{expectedVersion:1,reason:'Synthetic family revoked'})).response.status,200);for(const path of [f.root,f.path,f.path+'/receipts'])assert.equal((await f.request(path,undefined,'staff')).response.status,404);
 await f.access('bot',[{roleId:f.role.id,allHubs:true}]);assert.equal((await f.read('','bot')).response.status,403);assert.equal((await f.read('/receipts','bot')).body.error.code,'HUMAN_RECIPIENT_REQUIRED');
});
check('family billing strict filters never accept caller money,history,scope or paid overrides',async f=>{
 for(const suffix of ['?limit=51','?limit=1&limit=2','?after=bad','?studentId='+f.student.id,'?paid=true'])assert.equal((await f.request(f.root+suffix,undefined,'staff')).response.status,400);
 for(const suffix of ['?version=1','?amount=1','/receipts?limit=51','/receipts?limit=1&limit=2','/receipts?status=paid','/receipts?accountId='+f.cash.id])assert.equal((await f.read(suffix)).response.status,400);
 for(const path of [f.root,f.path,f.path+'/receipts'])assert.equal((await f.request(path,{paid:true},'staff')).response.status,405);
});
check('family sees no received money or receipt for an unapproved request and one exact payment after upper approval',async f=>{
 const role=await f.made('roles',{name:'Synthetic receipt submitter',permissions:['receipts.view','receipts.edit','invoices.view','tuition.view','collectors.view','payment-methods.view','accounts.view','journals.view','journals.edit','periods.view','people.view'].map(capability=>({capability,effect:'allow'}))});await f.access('manager',[{roleId:role.id,allHubs:true},{roleId:f.managerRole,allHubs:false,hubIds:[f.hub]}]);
 const key=randomUUID(),pending=await f.pay({},'manager',key);assert.equal(pending.response.status,202,JSON.stringify(pending.body));assert.deepEqual((await f.pay({},'manager',key)).body,pending.body);assert.equal((await f.read()).body.data.received,'0.00');assert.deepEqual((await f.read('/receipts')).body.data,[]);assert.equal((await f.approve(pending.body.approval.id)).response.status,200);assert.equal((await f.read()).body.data.received,'50.00');assert.equal((await f.read('/receipts')).body.data.length,1);assert.equal((await f.pg.query('SELECT count(*)::integer n FROM public.tuition_receipts')).rows[0].n,1);
});
check('family invoice credit racing a read returns one coherent current financial snapshot and no stale balance afterward',async f=>{
 const [read,credit]=await Promise.all([f.read(),f.credit(f.invoice.id)]);assert.equal(read.response.status,200,JSON.stringify(read.body));assert.equal(credit.response.status,201,JSON.stringify(credit.body));const v=read.body.data;assert.equal(v.received,'0.00');assert.equal(v.balance,v.status==='credited'?'0.00':'113.00');assert.equal(v.credited,v.status==='credited'?'113.00':'0.00');const after=await f.read();assert.equal(after.body.data.paymentStatus,'credited');assert.equal(after.body.data.balance,'0.00');
},true);
