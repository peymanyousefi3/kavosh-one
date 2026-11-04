import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { invoiceFixture as fixture } from './invoice-fixture.ts';
type Fixture=Awaited<ReturnType<typeof fixture>>;
function check(name:string,run:(f:Fixture)=>Promise<void>){test(name,async()=>{const f=await fixture();try{await run(f);}finally{await f.pg.close();}});}

check('invoice posting records exact receivables, deferred tuition and tax without recording cash or payment',async f=>{
 const r=await f.issue();assert.equal(r.response.status,201,JSON.stringify(r.body));const v=r.body.data;assert.equal(v.number,'SYN-00000001');assert.equal(v.gross,'113.00');assert.equal(v.net,'100.00');assert.equal(v.tax,'13.00');assert.equal(v.accountingPosted,true);assert.equal(v.paymentStatus,'not_tracked_here');assert.equal(v.refundPerformed,false);
 const lines=(await f.pg.query('SELECT account_id,side,amount_minor::text AS amount FROM public.finance_journal_lines ORDER BY line_number')).rows;
 assert.deepEqual(lines,[{account_id:f.ar.id,side:'debit',amount:'11300'},{account_id:f.deferred.id,side:'credit',amount:'10000'},{account_id:f.taxPayable.id,side:'credit',amount:'1300'}]);assert.ok(!lines.some(l=>l.account_id===f.cash.id));
 assert.equal((await f.request('finance/invoices/'+v.id)).body.data.billToName,'Private adult legal name');assert.equal((await f.request('finance/invoices?status=issued')).body.data.length,1);
 assert.equal((await f.request('finance/accounts/'+f.ar.id+'/history')).body.data[0].operationalRole,'receivable');
});
check('minor invoices require a legal guardian effective at the exact issue instant and retain the approved name',async f=>{
 assert.equal((await f.request('students/'+f.student.id+'/update',{expectedVersion:1,dateOfBirth:'2016-01-01'})).response.status,200);
 const guardian=await f.made('people',{name:'Synthetic guardian',hubId:f.hub});await f.made('guardians',{personId:guardian.id,legalName:'Pinned legal guardian'});
 assert.equal((await f.issue({billToId:guardian.id})).body.error.code,'LEGAL_GUARDIAN_REQUIRED');
 const link=await f.made('students/'+f.student.id+'/guardians',{guardianId:guardian.id,relationship:'parent',validFrom:'2026-11-05T12:00:00Z',validUntil:'2026-11-05T12:00:01Z',reason:'Synthetic precise billing authority'});
 assert.equal((await f.issue({billToId:guardian.id,issuedAt:'2026-11-05T12:00:01Z'})).body.error.code,'LEGAL_GUARDIAN_REQUIRED');
 const issued=await f.issue({billToId:guardian.id});assert.equal(issued.response.status,201,JSON.stringify(issued.body));assert.equal(issued.body.data.billToName,'Pinned legal guardian');
 assert.equal((await f.request('guardians/'+guardian.id+'/update',{expectedVersion:1,legalName:'Changed later name'})).response.status,200);
 assert.equal((await f.request('finance/invoices/'+issued.body.data.id)).body.data.billToName,'Pinned legal guardian');
 const stored=(await f.pg.query<{bill_to_snapshot:{relationshipId:string;relationshipVersion:number}}>('SELECT bill_to_snapshot FROM public.tuition_invoices WHERE id=$1',[issued.body.data.id])).rows[0].bill_to_snapshot;assert.equal(stored.relationshipId,link.id);assert.equal(stored.relationshipVersion,1);
});
check('full credit retains the invoice, reverses exact lines and releases terms only after a linked credit note',async f=>{
 const r=await f.issue();assert.equal(r.response.status,201,JSON.stringify(r.body));const id=r.body.data.id;
 const locked=await f.request('finance/tuition-plans/'+f.plan.id+'/cancel',{expectedVersion:1,reason:'Must not silently cancel invoiced terms'});assert.equal(locked.response.status,409,JSON.stringify(locked.body));assert.equal(locked.body.error.code,'TUITION_INVOICE_REQUIRES_CREDIT');
 const credited=await f.credit(id);assert.equal(credited.response.status,201,JSON.stringify({body:credited.body,failures:f.metrics.queryFailures}));assert.equal(credited.body.data.status,'credited');assert.equal(credited.body.data.creditNote.number,'SYN-00000002');assert.equal(credited.body.data.refundPerformed,false);
 assert.equal((await f.pg.query('SELECT * FROM public.finance_journals')).rows.length,2);assert.equal((await f.pg.query('SELECT * FROM public.finance_journal_lines')).rows.length,6);
 assert.equal((await f.request('finance/tuition-plans/'+f.plan.id+'/cancel',{expectedVersion:1,reason:'Cancel after full financial credit'})).response.status,200);
 assert.equal((await f.request('finance/invoices/'+id)).body.data.gross,'113.00');assert.equal((await f.credit(id)).response.status,409);
});
check('a cash account cannot masquerade as receivables and invalid mappings cannot consume an invoice number',async f=>{
 const r=await f.issue({accounts:{...f.base.accounts,receivable:{id:f.cash.id,version:1}}});assert.equal(r.response.status,400,JSON.stringify(r.body));assert.equal(r.body.error.code,'INVOICE_ACCOUNT_MAPPING_INVALID');
 assert.equal((await f.pg.query('SELECT * FROM public.billing_documents')).rows.length,0);assert.equal((await f.pg.query('SELECT next_number::text AS next FROM public.invoice_issuers')).rows[0].next,'1');
 const good=await f.issue();assert.equal(good.response.status,201,JSON.stringify(good.body));assert.equal(good.body.data.number,'SYN-00000001');
});
check('issuer revisions preserve old invoice identity and document numbers, and retired issuers can still correct their invoices',async f=>{
 const first=await f.issue();assert.equal(first.response.status,201,JSON.stringify(first.body));
 const changed=await f.request('finance/invoice-issuers/'+f.issuer.id+'/change',{expectedVersion:1,definition:{...f.definition,legalName:'New synthetic trading label'},active:false,reason:'Private issuer revision'});assert.equal(changed.response.status,200,JSON.stringify(changed.body));
 const old=(await f.request('finance/invoices/'+first.body.data.id)).body.data;assert.equal(old.issuer.legalName,'Synthetic Academy Inc.');assert.equal(old.number,'SYN-00000001');
 const corrected=await f.credit(first.body.data.id);assert.equal(corrected.response.status,201,JSON.stringify(corrected.body));assert.equal(corrected.body.data.creditNote.number,'SYN-00000002');
});
check('zero-price tuition can have an invoice and credit note without fabricated zero-value journal entries',async f=>{
 const revised=await f.request('finance/tuition-plans/'+f.plan.id+'/change',{...f.planInput,expectedVersion:1,originalAmount:'0',agreedAmount:'0',installments:[]});assert.equal(revised.response.status,200,JSON.stringify(revised.body));
 const r=await f.issue({planVersion:2});assert.equal(r.response.status,201,JSON.stringify(r.body));assert.equal(r.body.data.gross,'0.00');assert.equal(r.body.data.accountingPosted,false);
 assert.equal((await f.credit(r.body.data.id)).response.status,201);assert.equal((await f.pg.query('SELECT * FROM public.finance_journals')).rows.length,0);assert.equal((await f.pg.query('SELECT * FROM public.billing_documents')).rows.length,2);
});
check('failed event persistence rolls back the invoice, journal and numbering together',async f=>{
 await f.pg.exec('REVOKE INSERT ON public.outbox_events FROM kavosh_runtime');try{assert.equal((await f.issue()).response.status,503);}finally{await f.pg.exec('GRANT INSERT ON public.outbox_events TO kavosh_runtime');}
 for(const table of ['billing_documents','tuition_invoices','finance_journals','finance_journal_lines'])assert.equal((await f.pg.query('SELECT * FROM public.'+table)).rows.length,0,table);
 assert.equal((await f.pg.query('SELECT next_number::text AS next FROM public.invoice_issuers')).rows[0].next,'1');assert.equal((await f.issue()).body.data.number,'SYN-00000001');
});
check('invoice-only student viewers can read their document without tuition or journal privileges and cannot cross school boundaries',async f=>{
 const issued=await f.issue();assert.equal(issued.response.status,201,JSON.stringify(issued.body));const id=issued.body.data.id;
 const role=await f.made('roles',{name:'One student invoice viewer',permissions:[{capability:'invoices.view',effect:'allow'}]}),path='people/'+f.actors.staff.person+'/access',old=await f.request(path);
 assert.equal((await f.request(path,{expectedVersion:old.body.data.version,assignments:[{roleId:role.id,allHubs:false,personIds:[f.student.id]}]})).response.status,200);
 const read=await f.request('finance/invoices/'+id,undefined,'staff');assert.equal(read.response.status,200,JSON.stringify(read.body));assert.equal(read.body.data.gross,'113.00');assert.equal((await f.request('finance/invoices?limit=1',undefined,'staff')).body.data.length,1);
 assert.equal((await f.request('finance/tuition-plans/'+f.plan.id,undefined,'staff')).response.status,403);assert.equal((await f.request('finance/journals/'+id,undefined,'staff')).response.status,403);
 assert.ok(!JSON.stringify(read.body).includes('Private accounting review'));assert.equal(read.body.data.receivable_account,undefined);assert.equal((await f.request('finance/invoices/'+id,undefined,'foreignMaster',{academy:f.b})).response.status,404);
});
check('invoice posting can recognize earned tuition explicitly, and invalid tax identity or source versions cannot post',async f=>{
 assert.equal((await f.issue({issuerVersion:999})).response.status,409);assert.equal((await f.issue({planVersion:999})).response.status,409);
 const missing=await f.request('finance/invoice-issuers/'+f.issuer.id+'/change',{expectedVersion:1,definition:{...f.definition,taxRegistrations:[]},active:true,reason:'Synthetic missing registration'});assert.equal(missing.response.status,200);
 assert.equal((await f.issue({issuerVersion:2})).body.error.code,'CANADIAN_TAX_REGISTRATION_REQUIRED');
 await f.request('finance/invoice-issuers/'+f.issuer.id+'/change',{expectedVersion:2,definition:f.definition,active:true,reason:'Restore synthetic registration'});
 const r=await f.issue({issuerVersion:3,recognition:'earned',accounts:{...f.base.accounts,consideration:{id:f.income.id,version:1}}});assert.equal(r.response.status,201,JSON.stringify(r.body));
 assert.equal((await f.pg.query('SELECT amount_minor::text AS amount FROM public.finance_journal_lines WHERE account_id=$1',[f.income.id])).rows[0].amount,'10000');assert.equal((await f.pg.query('SELECT * FROM public.finance_journal_lines WHERE account_id=$1',[f.deferred.id])).rows.length,0);
});
check('invoice mutations fail closed in read-only schools and immutable native rows cannot be rewritten by the web role',async f=>{
 const r=await f.issue();assert.equal(r.response.status,201,JSON.stringify(r.body));const id=r.body.data.id;
 await f.pg.exec('SET ROLE kavosh_runtime');try{
  await f.pg.query("SELECT set_config('app.academy_id',$1,false)",[f.b]);assert.equal((await f.pg.query('SELECT * FROM public.tuition_invoices')).rows.length,0);
  await f.pg.query("SELECT set_config('app.academy_id',$1,false)",[f.a]);for(const sql of ['DELETE FROM public.tuition_invoices','DELETE FROM public.billing_documents',"UPDATE public.tuition_invoices SET bill_to_name='Overwrite'",'UPDATE public.billing_documents SET issued_on=current_date'])await assert.rejects(f.pg.exec(sql),/permission denied/i);
 }finally{await f.pg.exec('RESET ROLE');}
 await f.pg.query("UPDATE public.academies SET status='read_only' WHERE id=$1",[f.a]);assert.equal((await f.request('finance/invoices/'+id)).response.status,200);assert.equal((await f.credit(id)).response.status,403);
});
check('closed periods, early credits and operational-role mismatches are rejected before any new financial record',async f=>{
 assert.equal((await f.request('finance/accounts/'+f.cash.id+'/change',{expectedVersion:1,operationalRole:'tax_payable',reason:'Invalid role for cash asset'})).response.status,400);
 const issued=await f.issue();assert.equal(issued.response.status,201,JSON.stringify(issued.body));assert.equal((await f.credit(issued.body.data.id,{issuedAt:'2026-11-04T12:00:00Z'})).response.status,400);
 assert.equal((await f.request('finance/periods/'+f.period.id+'/change',{expectedVersion:1,state:'closed',reason:'Synthetic accounting cutoff'})).response.status,200);
 const blocked=await f.credit(issued.body.data.id,{periodVersion:2});assert.equal(blocked.response.status,409,JSON.stringify(blocked.body));assert.equal((await f.pg.query('SELECT * FROM public.tuition_invoice_credits')).rows.length,0);
});
check('invoice retries retain one document and generic journal reversal cannot bypass the credit-note workflow',async f=>{
 const key=randomUUID(),r=await f.issue({},'master',key);assert.equal(r.response.status,201,JSON.stringify(r.body));assert.deepEqual((await f.issue({},'master',key)).body,r.body);
 assert.equal((await f.issue()).body.error.code,'TUITION_ALREADY_INVOICED');assert.equal((await f.pg.query('SELECT * FROM public.billing_documents')).rows.length,1);
 const bypass=await f.request('finance/journals/'+r.body.data.id+'/reverse',{periodId:f.period.id,periodVersion:1,postedOn:'2026-11-06',description:'Must use credit workflow',reason:'Synthetic bypass attempt'});assert.equal(bypass.response.status,409,JSON.stringify(bypass.body));assert.equal(bypass.body.error.code,'INVOICE_CREDIT_WORKFLOW_REQUIRED');
 assert.equal((await f.pg.query('SELECT * FROM public.finance_journals')).rows.length,1);
});
check('issuer history is completely reachable through bounded version pagination',async f=>{
 await f.request('finance/invoice-issuers/'+f.issuer.id+'/change',{expectedVersion:1,definition:{...f.definition,address:'2 Synthetic Street'},active:true,reason:'Private revision'});
 const first=await f.request('finance/invoice-issuers/'+f.issuer.id+'/history?limit=1');assert.equal(first.response.status,200,JSON.stringify(first.body));assert.equal(first.body.nextVersion,1);assert.equal(first.body.data[0].definition.address,f.definition.address);
 const second=await f.request('finance/invoice-issuers/'+f.issuer.id+'/history?afterVersion=1&limit=1');assert.equal(second.body.data[0].version,2);assert.equal(second.body.nextVersion,null);
});
async function financeAccess(f:Fixture,as:string){
 const role=await f.made('roles',{name:'Finance writer '+as,permissions:['invoices.view','invoices.edit','invoice-issuers.view','tuition.view','students.view','accounts.view','journals.view','journals.edit','periods.view'].map(capability=>({capability,effect:'allow'}))});
 const person=as==='bot'?f.bot:f.actors[as].person,path='people/'+person+'/access',old=await f.request(path),assignments=[{roleId:role.id,allHubs:true},...as==='manager'?[{roleId:f.managerRole,allHubs:false,hubIds:[f.hub]}]:[]];
 assert.equal((await f.request(path,{expectedVersion:old.body.data.version,assignments})).response.status,200);return role;
}
check('staff invoicing requires upper human review and revoking edit access hides and invalidates the private case',async f=>{
 const writer=await financeAccess(f,'staff');await financeAccess(f,'manager');const pending=await f.issue({},'staff');assert.equal(pending.response.status,202,JSON.stringify(pending.body));assert.equal((await f.pg.query('SELECT * FROM public.billing_documents')).rows.length,0);assert.equal((await f.approve(pending.body.approval.id,'staff')).response.status,403);
 const accepted=await f.approve(pending.body.approval.id,'manager');assert.equal(accepted.response.status,200,JSON.stringify(accepted.body));assert.equal(accepted.body.data.gross,'113.00');
 const correction=await f.credit(accepted.body.data.id,{},'staff');assert.equal(correction.response.status,202,JSON.stringify(correction.body));
 await f.pg.query("DELETE FROM public.role_permissions WHERE role_id=$1 AND capability='invoices.edit'",[writer.id]);
 assert.equal((await f.request('approvals/'+correction.body.approval.id,undefined,'staff')).response.status,404);const revoked=await f.approve(correction.body.approval.id);assert.equal(revoked.response.status,409,JSON.stringify(revoked.body));assert.equal(revoked.body.approval.decisionCode,'AUTHORITY_CHANGED');
});
check('bots can propose an invoice but only a human reviewer can create its accounting records',async f=>{
 await financeAccess(f,'bot');const pending=await f.issue({},'bot');assert.equal(pending.response.status,202,JSON.stringify(pending.body));assert.equal((await f.approve(pending.body.approval.id,'bot')).response.status,403);assert.equal((await f.pg.query('SELECT * FROM public.finance_journals')).rows.length,0);
 const approved=await f.approve(pending.body.approval.id);assert.equal(approved.response.status,200,JSON.stringify(approved.body));assert.equal(approved.body.data.accountingPosted,true);
});
