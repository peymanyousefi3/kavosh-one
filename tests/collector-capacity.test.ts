import assert from 'node:assert/strict';
import { test } from 'node:test';
import { remittanceFixture } from './remittance-fixture.ts';
import { readFile } from 'node:fs/promises';

type Fixture=Awaited<ReturnType<typeof remittanceFixture>>;
async function native(f:Fixture,on='2026-11-06',direction='to_academy',academy=f.a){
 await f.pg.exec('SET ROLE kavosh_runtime');try{await f.pg.query("SELECT set_config('app.academy_id',$1,false)",[academy]);return(await f.pg.query<{current:string;through:string;available:string;activity:string;stamp:string}>('SELECT current_minor::text current,through_minor::text through,available_minor::text available,activity::text,source_stamp stamp FROM public.collector_fund_capacity($1,$2,$3,$4)',[f.third.id,f.due.id,on,direction])).rows[0];}finally{await f.pg.exec('RESET ROLE');}
}
async function access(f:Fixture){const caps=(await f.pg.query<{name:string}>('SELECT name FROM public.capability_catalog')).rows.map(r=>r.name),role=await f.made('roles',{name:'Collector capacity proposer',permissions:caps.map(capability=>({capability,effect:'allow'}))}),path='people/'+f.actors.staff.person+'/access',old=await f.request(path);assert.equal((await f.request(path,{expectedVersion:old.body.data.version,assignments:[{roleId:role.id,allHubs:true}]})).response.status,200);return role;}
async function trough(f:Fixture){const spent=await f.remit({amount:'100'});assert.equal(spent.response.status,201);assert.equal((await f.correction(spent.body.data.id)).response.status,201);return spent;}

test('backdated collector remittance cannot reuse money restored only by a later reversal',async()=>{
 const f=await remittanceFixture();try{
  await trough(f);
  assert.equal((await f.balances('2026-11-06')).body.data[0].through,'113.00');assert.equal((await f.balances('2026-11-07')).body.data[0].through,'13.00');assert.equal((await f.balances()).body.data[0].current,'113.00');
  const backdated=await f.remit({amount:'50',postedOn:'2026-11-06',transferredAt:'2026-11-06T13:00:00Z'});assert.equal(backdated.response.status,409,JSON.stringify(backdated.body));assert.equal(backdated.body.error.code,'REMITTANCE_EXCEEDS_COLLECTOR_BALANCE');
  const source=await native(f);assert.equal(source.current,'11300');assert.equal(source.through,'11300');assert.equal(source.available,'1300');assert.equal(source.activity,'3');assert.equal((await native(f,'2026-11-09')).available,'11300');
  assert.equal((await f.remit({amount:'13',postedOn:'2026-11-06',transferredAt:'2026-11-06T13:00:00Z'})).response.status,201);assert.equal((await f.balances('2026-11-07')).body.data[0].through,'0.00');assert.equal((await native(f)).available,'0');
 }finally{await f.pg.close();}
});
test('backdated repayment cannot reuse an academy debt restored only by a later refund correction',async()=>{
 const f=await remittanceFixture();try{
  assert.equal((await f.remit({amount:'113'})).response.status,201);assert.equal((await f.reverse(f.receivedId,{postedOn:'2026-11-08'})).response.status,201);
  const refund=await f.remit({direction:'to_collector',amount:'113',postedOn:'2026-11-09',transferredAt:'2026-11-09T12:00:00Z'});assert.equal(refund.response.status,201);assert.equal((await f.correction(refund.body.data.id,{postedOn:'2026-11-11'})).response.status,201);
  const source=await native(f,'2026-11-08','to_collector');assert.equal(source.current,'-11300');assert.equal(source.through,'-11300');assert.equal(source.available,'0');assert.equal((await native(f,'2026-11-11','to_collector')).available,'11300');
  assert.equal((await f.remit({direction:'to_collector',amount:'50',postedOn:'2026-11-08',transferredAt:'2026-11-08T12:00:00Z'})).body.error.code,'REMITTANCE_EXCEEDS_COLLECTOR_BALANCE');
 }finally{await f.pg.close();}
});
test('native capacity independently rejects a direct overdrawing header with a real pending approval',async()=>{
 const f=await remittanceFixture();try{
  const spent=await trough(f);await access(f);const proposal=await f.remit({amount:'13',postedOn:'2026-11-06',transferredAt:'2026-11-06T13:00:00Z'},'staff');assert.equal(proposal.response.status,202);const p=(await f.pg.query<{target_id:string}>('SELECT target_id FROM public.approval_requests WHERE id=$1',[proposal.body.approval.id])).rows[0];
  await f.pg.exec('SET ROLE kavosh_runtime');try{await f.pg.query("SELECT set_config('app.academy_id',$1,false)",[f.a]);await assert.rejects(f.pg.query("INSERT INTO public.collector_remittances SELECT (jsonb_populate_record(NULL::public.collector_remittances,to_jsonb(r)||jsonb_build_object('id',$2::uuid,'amount_minor',5000,'posted_on','2026-11-06','reversal_id',NULL,'approval_id',$3::uuid,'created_by',$4::uuid))).* FROM public.collector_remittances r WHERE r.id=$1",[spent.body.data.id,p.target_id,proposal.body.approval.id,f.actors.staff.person]),/REMITTANCE_EXCEEDS_COLLECTOR_BALANCE/);}finally{await f.pg.exec('RESET ROLE');}
  assert.equal((await f.pg.query('SELECT count(*)::integer n FROM public.collector_remittances')).rows[0].n,1);assert.equal((await f.approve(proposal.body.approval.id)).response.status,200);
 }finally{await f.pg.close();}
});
test('zero-net new activity invalidates an old approval even when current dated and available balances remain identical',async()=>{
 const f=await remittanceFixture();try{
  await access(f);const before=await native(f),pending=await f.remit({amount:'10',postedOn:'2026-11-06',transferredAt:'2026-11-06T13:00:00Z'},'staff');assert.equal(pending.response.status,202);
  const moved=await f.remit({amount:'20'});assert.equal(moved.response.status,201);assert.equal((await f.correction(moved.body.data.id,{postedOn:'2026-11-07'})).response.status,201);const after=await native(f);assert.equal(after.current,before.current);assert.equal(after.through,before.through);assert.equal(after.available,before.available);assert.notEqual(after.stamp,before.stamp);assert.equal((await f.approve(pending.body.approval.id)).response.status,409);
 }finally{await f.pg.close();}
});
test('collector capacity API enforces collector and account rights without requiring ledger access or accepting financial proof overrides',async()=>{
 const f=await remittanceFixture();try{
  await trough(f);for(const cap of ['remittances.view','collectors.view','accounts.view'])await f.pg.query("INSERT INTO public.role_permissions VALUES($1,$2,$3,'allow')",[f.a,f.staffRole,cap]);
  const path='finance/collectors/'+f.third.id+'/remittance-capacity?'+new URLSearchParams({holdingAccountId:f.due.id,on:'2026-11-06',direction:'to_academy'}),read=await f.request(path,undefined,'staff');assert.equal(read.response.status,200,JSON.stringify(read.body));assert.equal(read.body.data.current,'113.00');assert.equal(read.body.data.available,'13.00');assert.equal(read.body.data.sourceStamp,(await native(f)).stamp);assert.equal(read.body.data.moneyMovementPerformed,false);
  assert.equal((await f.request('finance/journals',undefined,'staff')).response.status,403);assert.equal((await f.request(path+'&sourceStamp=forged')).response.status,400);assert.equal((await f.request(path.replace('on=2026-11-06','on=2026-02-30'))).response.status,400);assert.equal((await f.request(path.replace(f.due.id,f.cash.id))).response.status,400);assert.equal((await f.request(path,undefined,'foreignMaster',{academy:f.b})).response.status,404);
  assert.equal((await f.request(path+'&on=2026-11-07')).body.error.code,'DUPLICATE_QUERY');assert.equal((await f.request('finance/collectors/'+f.third.id+'/remittance-balances?through=2026-11-06&through=2026-11-07')).body.error.code,'DUPLICATE_QUERY');
  await f.pg.query("DELETE FROM public.role_permissions WHERE role_id=$1 AND capability='accounts.view'",[f.staffRole]);assert.equal((await f.request(path,undefined,'staff')).response.status,403);
 }finally{await f.pg.close();}
});
test('capacity source is tenant-bound and invoker-only with strict dates and directions',async()=>{
 const f=await remittanceFixture();try{
  const foreign=await native(f,'2026-11-06','to_academy',f.b);assert.equal(foreign.current,'0');assert.equal(foreign.available,'0');assert.equal(foreign.activity,'0');await assert.rejects(native(f,'2026-11-06','forged'),/COLLECTOR_CAPACITY_INPUT_INVALID/);await assert.rejects(native(f,'10000-01-01'),/COLLECTOR_CAPACITY_INPUT_INVALID/);
  await assert.rejects(f.pg.query("SELECT * FROM public.collector_fund_capacity(NULL,$1,DATE '2026-11-06','to_academy')",[f.due.id]),/COLLECTOR_CAPACITY_INPUT_INVALID/);
  const emptyStamps=[];for(const academy of [f.a,f.b]){await f.pg.query("SELECT set_config('app.academy_id',$1,false)",[academy]);emptyStamps.push((await f.pg.query<{source_stamp:string}>("SELECT source_stamp FROM public.collector_fund_capacity($1,$2,DATE '2026-11-06','to_academy')",[f.collector.id,f.cash.id])).rows[0].source_stamp);}assert.notEqual(emptyStamps[0],emptyStamps[1]);
  const r=(await f.pg.query<{provolatile:string;prosecdef:boolean;public_execute:boolean}>("SELECT p.provolatile,p.prosecdef,EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee=0 AND a.privilege_type='EXECUTE') public_execute FROM pg_proc p WHERE oid='public.collector_fund_capacity(uuid,uuid,date,text)'::regprocedure")).rows[0];assert.deepEqual(r,{provolatile:'v',prosecdef:false,public_execute:false});
 }finally{await f.pg.close();}
});
test('capacity entrypoint sees a real new remittance journal inside its actual row trigger',async()=>{
 const f=await remittanceFixture();try{
  await f.pg.exec("CREATE TABLE public.test_collector_capacity_probe(available numeric NOT NULL);GRANT INSERT ON public.test_collector_capacity_probe TO kavosh_runtime;CREATE FUNCTION public.test_collector_capacity_probe() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN INSERT INTO public.test_collector_capacity_probe SELECT c.available_minor FROM public.collector_remittances r CROSS JOIN LATERAL public.collector_fund_capacity(r.collector_id,r.holding_account,r.posted_on,'to_academy') c WHERE r.academy_id=NEW.academy_id AND r.id=NEW.id;RETURN NULL;END $$;CREATE TRIGGER test_collector_capacity_probe AFTER INSERT ON public.finance_journals FOR EACH ROW EXECUTE FUNCTION public.test_collector_capacity_probe()");assert.equal((await f.remit()).response.status,201);assert.deepEqual((await f.pg.query('SELECT available::text FROM public.test_collector_capacity_probe')).rows,[{available:'6300'}]);
 }finally{await f.pg.close();}
});
test('schema263 to264 preserves collected tuition journals source rows and the original guard identity and grants',async()=>{
 const f=await remittanceFixture({throughSchema:263});try{
  const names=['tuition_invoices','tuition_receipts','finance_journals','finance_journal_lines','approval_requests','audit_events','outbox_events'],before=[];for(const name of names)before.push((await f.pg.query('SELECT to_jsonb(r) data FROM public.'+name+' r ORDER BY to_jsonb(r)::text')).rows);
  const props="SELECT oid,proowner,proacl,proconfig,provolatile FROM pg_proc WHERE oid=ANY(ARRAY['public.guard_collector_remittance()'::regprocedure,'public.collector_fund_balance(uuid,uuid,date)'::regprocedure]) ORDER BY oid",original=(await f.pg.query(props)).rows;
  await f.pg.exec(await readFile(new URL('../db/migrations/264_collector_fund_capacity.sql',import.meta.url),'utf8'));assert.deepEqual((await f.pg.query(props)).rows,original);for(let n=0;n<names.length;n++)assert.deepEqual((await f.pg.query('SELECT to_jsonb(r) data FROM public.'+names[n]+' r ORDER BY to_jsonb(r)::text')).rows,before[n]);assert.equal((await native(f)).available,'11300');assert.equal((await f.remit()).response.status,201);
 }finally{await f.pg.close();}
});
if(process.env.TEST_DATABASE_URL)test('read-only capacity inspection takes no money locks while another connection records a transfer',async()=>{
 const f=await remittanceFixture(),reader=await f.pg.runtime!.connect();try{
  await reader.query('BEGIN READ ONLY');await reader.query("SELECT set_config('app.academy_id',$1,true),set_config('statement_timeout','2000',true)",[f.a]);const sql="SELECT available_minor::text available FROM public.collector_fund_capacity($1,$2,DATE '2026-11-07','to_academy')",before=(await reader.query<{available:string}>(sql,[f.third.id,f.due.id])).rows[0];assert.equal(before.available,'11300');assert.equal((await reader.query<{n:string}>("SELECT count(*)::text n FROM pg_locks WHERE pid=pg_backend_pid() AND locktype='advisory'")).rows[0].n,'0');
  const started=performance.now();assert.equal((await f.remit()).response.status,201);assert.equal((await reader.query<{available:string}>(sql,[f.third.id,f.due.id])).rows[0].available,'6300');await reader.query('COMMIT');console.log(JSON.stringify({measurement:'collector-capacity-read-concurrent-transfer',elapsedMs:Math.ceil(performance.now()-started),transfers:1}));
 }finally{await reader.query('ROLLBACK');reader.release();await f.pg.close();}
});
