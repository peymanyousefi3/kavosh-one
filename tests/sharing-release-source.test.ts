import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { calculateRevenueSharing } from '../src/core/revenue-sharing.ts';
import { receiptFixture } from './receipt-fixture.ts';

async function fixture(throughSchema?:number){
 const f=await receiptFixture({throughSchema});try{
  const payees=[];for(let n=0;n<4;n++)payees.push(await f.made('finance/payees',{hubId:f.hub,kind:n===0?'hub':'organization',code:'SHARE'+n,name:'Synthetic fee participant '+n,reason:'Synthetic source fixture'}));
  const input={expectedVersion:0,tuitionVersion:1,basis:'net_tuition',creditHandling:'retain_collections',recipients:payees.map((p,n)=>({payeeId:p.id,payeeVersion:1,method:'percentage',value:'20',release:(['proportional','on_invoice','first_collection','fully_collected'] as const)[n]})),reason:'Synthetic immutable fee terms'};
  const save=(patch:Record<string,unknown>={})=>f.request('finance/tuition-plans/'+f.plan.id+'/sharing',{...input,...patch});assert.equal((await save()).response.status,200);
  async function source(day='2026-11-06',version=1,academy=f.a){
   await f.pg.exec('SET ROLE kavosh_runtime');try{await f.pg.query("SELECT set_config('app.academy_id',$1,false)",[academy]);return(await f.pg.query<{source:any}>('SELECT public.sharing_release_snapshot($1,$2,$3) source',[f.invoice.id,version,day])).rows[0].source;}finally{await f.pg.exec('RESET ROLE');}
  }
  return {...f,payees,input,save,source};
 }catch(error){await f.pg.close();throw error;}
}
type Fixture=Awaited<ReturnType<typeof fixture>>;
function check(name:string,run:(f:Fixture)=>Promise<void>){test(name,async()=>{const f=await fixture();try{await run(f);}finally{await f.pg.close();}});}
function parity(f:Fixture,s:any,received:bigint,credited=false,patch:Record<string,unknown>={}){
 const expected=calculateRevenueSharing({unitScale:2,netMinor:10000n,grossMinor:11300n,receivedGrossMinor:received,basis:'net_tuition',invoiceIssued:true,invoiceCredited:credited,creditHandling:'retain_collections',allowOverAllocation:false,rules:f.input.recipients.map((r,n)=>({payeeId:r.payeeId,kind:n===0?'hub':'organization',method:'percentage',value:r.value,release:r.release} as const)),...patch});
 for(const key of ['baseMinor','collectedBaseMinor','fullTotalMinor','releasedTotalMinor','unassignedFullMinor','academyFullMinor','academyReleasedMinor','cashCoverageShortfallMinor'] as const)assert.equal(s[key],expected[key].toString(),key);
 for(const row of expected.rows){const actual=s.rows.find((r:any)=>r.payeeId===row.payeeId);assert.equal(actual.fullMinor,row.fullMinor.toString());assert.equal(actual.releasedMinor,row.releasedMinor.toString());}
 assert.equal(s.cancelledByCredit,expected.cancelledByCredit);assert.equal(s.overAllocated,expected.overAllocated);
}
check('dated sharing source matches canonical exact arithmetic across all four release modes without posting fees',async f=>{
 const before=await f.source();parity(f,before,0n);assert.equal(before.releasedTotalMinor,'2000');assert.equal(await f.source('2026-11-04'),null);
 const paid=await f.pay({amount:'56.50'});assert.equal(paid.response.status,201,JSON.stringify(paid.body));const partial=await f.source();parity(f,partial,5650n);assert.equal(partial.releasedTotalMinor,'5000');assert.notEqual(partial.sourceStamp,before.sourceStamp);
 assert.equal((await f.pay({amount:'56.50',receivedAt:'2026-11-08T12:00:00Z'})).response.status,201);const future=await f.source();parity(f,future,5650n);assert.notEqual(future.sourceStamp,partial.sourceStamp);parity(f,await f.source('2026-11-08'),11300n);
 assert.equal(future.recordedActivityVersion,2);for(const key of ['payableRecorded','ledgerPosted','feeTaxCalculated','bankSettlementVerified','moneyMovementPerformed'])assert.equal(future[key],false);
 assert.equal((await f.pg.query('SELECT count(*)::integer n FROM public.expense_bills')).rows[0].n,0);assert.equal((await f.pg.query('SELECT count(*)::integer n FROM public.finance_journals')).rows[0].n,3);
});
check('receipt correction preserves earlier dated collections and future activity invalidates stale stamps',async f=>{
 const paid=await f.pay({amount:'56.50'});assert.equal(paid.response.status,201);const original=await f.source();assert.equal((await f.reverse(paid.body.data.id)).response.status,201);
 const prior=await f.source();parity(f,prior,5650n);assert.notEqual(prior.sourceStamp,original.sourceStamp);assert.equal(prior.recordedActivityVersion,2);parity(f,await f.source('2026-11-07'),0n);
 const replacement=await f.pay({amount:'56.50',receivedAt:'2026-11-08T12:00:00Z'});assert.equal(replacement.response.status,201);parity(f,await f.source('2026-11-08'),5650n);
});
check('hub-held tuition releases fees once and later cash remittance does not recalculate or pay those fees',async f=>{
 const due=await f.made('finance/accounts',{code:'HUB-DUE',name:'Synthetic collector-held tuition',kind:'asset',operationalRole:'collector_receivable',hubId:f.hub,currencyId:f.currency.id,currencyVersion:1,reason:'Explicit third-party custody'}),collector=await f.made('finance/collectors',{hubId:f.hub,code:'THIRD',kind:'hub',custody:'third_party',name:'Synthetic collecting hub',accounts:[{id:due.id,version:1}],reason:'Synthetic hub custody'});
 assert.equal((await f.pay({amount:'113',collector:{id:collector.id,version:1},holdingAccount:{id:due.id,version:1}})).response.status,201);const before=await f.source('2026-11-08');parity(f,before,11300n);
 const remitted=await f.request('finance/collectors/'+collector.id+'/remittances',{collectorVersion:1,holdingAccount:{id:due.id,version:1},academyAccount:{id:f.cash.id,version:1},method:{id:f.method.id,version:1},period:{id:f.period.id,version:1},direction:'to_academy',amount:'113',postedOn:'2026-11-07',transferredAt:'2026-11-07T12:00:00Z',taxTreatment:'settle_collector',missingEvidenceReason:'Synthetic remittance record only',reason:'Not a fee settlement'});assert.equal(remitted.response.status,201,JSON.stringify(remitted.body));assert.deepEqual(await f.source('2026-11-08'),before);
 assert.equal((await f.pg.query('SELECT count(*)::integer n FROM public.expense_bills')).rows[0].n,0);assert.equal((await f.pg.query('SELECT count(*)::integer n FROM public.expense_payments')).rows[0].n,0);
});
check('credit cancellation takes effect only on its actual posting day while historical retained policy stays unchanged',async f=>{
 assert.equal((await f.pay({amount:'56.50'})).response.status,201);assert.equal((await f.save({expectedVersion:1,creditHandling:'cancel_on_credit'})).response.status,200);
 assert.equal((await f.credit(f.invoice.id,{issuedAt:'2026-11-09T12:00:00Z'})).response.status,201);
 parity(f,await f.source('2026-11-08',2),5650n,false,{creditHandling:'cancel_on_credit'});const cancelled=await f.source('2026-11-09',2);parity(f,cancelled,5650n,true,{creditHandling:'cancel_on_credit'});assert.equal(cancelled.releasedTotalMinor,'0');
 parity(f,await f.source('2026-11-09'),5650n,true);assert.equal((await f.source('2026-11-08',2)).invoiceCredited,false);
});
check('retired payees and disabled policies do not erase old fees or silently rebase new tuition editions',async f=>{
 assert.equal((await f.pay({amount:'56.50'})).response.status,201);const old=await f.source();assert.equal((await f.request('finance/payees/'+f.payees[0].id+'/change',{expectedVersion:1,name:'Retired hub',active:false,reason:'Preserve fee history'})).response.status,200);
 assert.equal((await f.save({expectedVersion:1,active:false})).response.status,200);const disabled=await f.source('2026-11-06',2);parity(f,disabled,5650n);assert.equal(disabled.policyActive,false);assert.equal(disabled.currentPolicyVersion,2);assert.equal((await f.source()).releasedTotalMinor,old.releasedTotalMinor);
 assert.equal((await f.credit(f.invoice.id)).response.status,201);assert.equal((await f.request('finance/tuition-plans/'+f.plan.id+'/change',{...f.planInput,expectedVersion:1,agreedAmount:'50',installments:[{...f.planInput.installments[0],amount:'56.50'}]})).response.status,200);
 const retained=await f.source();assert.equal(retained.tuitionVersion,1);assert.equal(retained.currentTuitionVersion,2);parity(f,retained,5650n,true);
 assert.equal((await f.save({expectedVersion:2,tuitionVersion:2,active:false})).response.status,200);await assert.rejects(f.source('2026-11-09',3),/SHARING_INVOICE_VERSION_MISMATCH/);
});
check('native source preserves deterministic residual pennies and explicit over-allocation shortfall',async f=>{
 const recipients=f.input.recipients.slice(0,3).map(r=>({...r,value:'33.3333',release:'proportional'}));assert.equal((await f.save({expectedVersion:1,recipients})).response.status,200);assert.equal((await f.pay({amount:'56.50'})).response.status,201);
 const s=await f.source('2026-11-06',2),sorted=[...recipients].sort((a,b)=>a.payeeId.localeCompare(b.payeeId));assert.equal(s.rows.find((r:any)=>r.payeeId===sorted[0].payeeId).fullMinor,'3334');assert.deepEqual(s.rows.map((r:any)=>r.fullMinor).sort(),['3333','3333','3334']);assert.equal(s.releasedTotalMinor,'4999');
 const over=[{...f.input.recipients[0],method:'flat',value:'150',release:'on_invoice'}];assert.equal((await f.save({expectedVersion:2,recipients:over,allowOverAllocation:true,overAllocationReason:'Explicit synthetic loss budget'})).response.status,200);
 const loss=await f.source('2026-11-06',3);assert.equal(loss.fullTotalMinor,'15000');assert.equal(loss.academyFullMinor,'-5000');assert.equal(loss.academyReleasedMinor,'-10000');assert.equal(loss.cashCoverageShortfallMinor,'10000');assert.equal(loss.overAllocated,true);
});
check('sharing snapshot enforces tenant isolation, invalid dates, invoker read-only security and no private source text',async f=>{
 assert.equal(await f.source('2026-11-06',1,f.b),null);assert.equal(await f.source('2026-11-06',99),null);await assert.rejects(f.source('2026-11-06',0),/SHARING_SNAPSHOT_INPUT_INVALID/);await assert.rejects(f.source('10000-01-01'),/SHARING_SNAPSHOT_INPUT_INVALID/);
 const s=await f.source();assert.ok(!JSON.stringify(s).includes('Private adult legal name'));assert.ok(!JSON.stringify(s).includes('Synthetic fee participant'));assert.match(s.sourceStamp,/^[0-9a-f]{64}$/);
 const p=(await f.pg.query<{provolatile:string;prosecdef:boolean;public_execute:boolean}>("SELECT p.provolatile,p.prosecdef,EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee=0 AND a.privilege_type='EXECUTE') public_execute FROM pg_proc p WHERE oid='public.sharing_release_snapshot(uuid,integer,date)'::regprocedure")).rows[0];assert.deepEqual(p,{provolatile:'s',prosecdef:false,public_execute:false});
 await f.pg.exec('BEGIN READ ONLY');try{assert.deepEqual(await f.source(),s);}finally{await f.pg.exec('ROLLBACK');}
});
check('dated sharing API uses posting dates, retains ordinary previews and rechecks original student permissions',async f=>{
 const path='finance/invoices/'+f.invoice.id+'/sharing-preview',paid=await f.pay({amount:'56.50'});assert.equal(paid.response.status,201);assert.equal((await f.reverse(paid.body.data.id)).response.status,201);
 const prior=await f.request(path+'?asOf=2026-11-06');assert.equal(prior.response.status,200,JSON.stringify(prior.body));assert.equal(prior.body.data.calculatedReleasedTotal,'50.00');assert.equal(prior.body.data.source,'dated_recorded_invoice_receipts');assert.equal(prior.body.data.sourceStamp,(await f.source()).sourceStamp);assert.equal(prior.body.data.payableRecorded,false);
 assert.equal((await f.request(path+'?asOf=2026-11-07')).body.data.calculatedReleasedTotal,'20.00');assert.equal((await f.request(path)).body.data.calculatedReleasedTotal,'20.00');assert.equal((await f.request(path+'?asOf=2026-11-04')).response.status,404);
 for(const query of ['asOf=2026-02-30','asOf=10000-01-01','asOf=2026-11-06&approved=true'])assert.equal((await f.request(path+'?'+query)).response.status,400);
 const role=await f.made('roles',{name:'One student dated fee viewer',permissions:['share-rules.view','invoices.view','receipts.view'].map(capability=>({capability,effect:'allow'}))}),accessPath='people/'+f.actors.staff.person+'/access';let before=await f.request(accessPath);
 assert.equal((await f.request(accessPath,{expectedVersion:before.body.data.version,assignments:[{roleId:role.id,allHubs:false,personIds:[f.student.id]}]})).response.status,200);
 assert.equal((await f.request(path+'?asOf=2026-11-06',undefined,'staff')).response.status,200);assert.equal((await f.request('finance/payees',undefined,'staff')).response.status,403);assert.equal((await f.request('finance/journals',undefined,'staff')).response.status,403);
 await f.pg.query("DELETE FROM public.role_permissions WHERE role_id=$1 AND capability='receipts.view'",[role.id]);assert.equal((await f.request(path+'?asOf=2026-11-06',undefined,'staff')).response.status,403);
 await f.pg.query("UPDATE public.academies SET status='read_only' WHERE id=$1",[f.a]);assert.equal((await f.request(path+'?asOf=2026-11-06')).response.status,200);
});
test('schema261 to262 preserves original sharing, invoice, receipt, journal and approval history',async()=>{
 const f=await fixture(261);try{
  assert.equal((await f.pay({amount:'56.50'})).response.status,201);const tables=['revenue_share_plans','revenue_share_revisions','revenue_share_lines','tuition_invoices','tuition_receipts','finance_journals','finance_journal_lines','approval_requests','audit_events','outbox_events'],before=[];
  for(const t of tables)before.push((await f.pg.query('SELECT to_jsonb(r) data FROM public.'+t+' r ORDER BY to_jsonb(r)::text')).rows);
  const properties="SELECT oid,proowner,proacl,proconfig,provolatile FROM pg_proc WHERE oid='public.revenue_share_full_amounts(uuid,uuid,integer)'::regprocedure",original=(await f.pg.query(properties)).rows;
  await f.pg.exec(await readFile(new URL('../db/migrations/262_sharing_release_snapshot.sql',import.meta.url),'utf8'));
  for(let n=0;n<tables.length;n++)assert.deepEqual((await f.pg.query('SELECT to_jsonb(r) data FROM public.'+tables[n]+' r ORDER BY to_jsonb(r)::text')).rows,before[n]);assert.deepEqual((await f.pg.query(properties)).rows,original);parity(f,await f.source(),5650n);
 }finally{await f.pg.close();}
});
if(process.env.TEST_DATABASE_URL)check('native sharing read holds no money locks and repeated reads see a concurrently committed receipt',async f=>{
 const reader=await f.pg.runtime!.connect();try{
  await reader.query('BEGIN READ ONLY');await reader.query("SELECT set_config('app.academy_id',$1,true),set_config('statement_timeout','2000',true)",[f.a]);const sql="SELECT public.sharing_release_snapshot($1,1,DATE '2026-11-06') source";
  const before=(await reader.query<{source:any}>(sql,[f.invoice.id])).rows[0].source;assert.equal(before.receivedGrossMinor,'0');assert.equal((await reader.query<{n:string}>("SELECT count(*)::text n FROM pg_locks WHERE pid=pg_backend_pid() AND locktype='advisory'")).rows[0].n,'0');
  const start=performance.now();assert.equal((await f.pay({amount:'56.50'})).response.status,201);const after=(await reader.query<{source:any}>(sql,[f.invoice.id])).rows[0].source;assert.equal(after.receivedGrossMinor,'5650');assert.notEqual(after.sourceStamp,before.sourceStamp);await reader.query('COMMIT');console.log(JSON.stringify({measurement:'sharing-read-concurrent-receipt',elapsedMs:Math.ceil(performance.now()-start),receipts:1}));
 }finally{await reader.query('ROLLBACK');reader.release();}
});
