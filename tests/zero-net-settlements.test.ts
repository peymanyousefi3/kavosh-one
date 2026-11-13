import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {t4aRecordFixture,zeroNetSource} from './t4a-record-fixture.ts';
import {assertGenericCriticalNotice} from './redaction-assertions.ts';

const definition={settledAt:'2026-02-16T00:30:00Z',timeZone:'America/Toronto',reference:'PRIVATE verified full-offset source',review:'PRIVATE review of actual no-cash settlement,not tax or remittance clearance'},body={expectedVersion:0,definition,reason:'PRIVATE explicit reviewed zero-net settlement'};
const path=(id:string)=>'payroll/net-postings/'+id+'/zero-net-settlement';
async function counts(f:Awaited<ReturnType<typeof t4aRecordFixture>>){const result=[];for(const table of ['finance_journals','payrun_payments','paid_tax_record_revisions'])result.push((await f.pg.query<{n:number}>('SELECT count(*)::integer n FROM public.'+table)).rows[0].n);return result;}
test('zero-net settlement retains explicit reviewed local dates,exact retries and corrections without fictional cash,tax recognition or extra journals',async()=>{
 const f=await t4aRecordFixture({classification:'employee',reportingForm:'T4'});try{
  const {posted}=await zeroNetSource(f),url=path(posted.id),before=await counts(f),key=randomUUID(),saved=await f.request(url,body,'master',{key});assert.equal(saved.response.status,200,JSON.stringify({body:saved.body,failures:f.metrics.queryFailures}));
  const d=saved.body.data;assert.equal(d.version,1);assert.equal(d.state,'recorded');assert.equal(d.settledOn,'2026-02-15');assert.deepEqual(d.definition,definition);for(const flag of ['bankVerified','paymentExecuted','additionalLedgerPosting','taxYearAssigned','taxRecognitionPerformed','deductionRemittancesVerified'])assert.equal(d[flag],false);
  const retry=await f.request(url,body,'master',{key});assert.equal(retry.response.status,200);assert.deepEqual(retry.body,saved.body);assert.deepEqual(await counts(f),before);assert.equal((await f.pg.query('SELECT * FROM public.zero_net_settlement_revisions')).rows.length,1);
  const corrected={...definition,settledAt:'2026-02-17T15:00:00Z',reference:'PRIVATE corrected evidence reference'},second=await f.request(url,{...body,expectedVersion:1,definition:corrected});assert.equal(second.response.status,200,JSON.stringify(second.body));assert.equal(second.body.data.settledOn,'2026-02-17');assert.equal(second.body.data.version,2);
  const withdrawn=await f.request(url,{expectedVersion:2,definition:null,reason:'PRIVATE withdrawn after source review'});assert.equal(withdrawn.response.status,200,JSON.stringify(withdrawn.body));assert.equal(withdrawn.body.data.state,'withdrawn');assert.equal(withdrawn.body.data.definition,null);assert.equal((await f.request(url,{expectedVersion:3,definition:null,reason:'Repeated withdrawal'})).response.status,409);
  const first=(await f.request(url+'/history?limit=2')).body;assert.deepEqual(first.data.map((r:any)=>r.version),[1,2]);assert.deepEqual(first.data[0].definition,definition);assert.deepEqual(first.data[1].definition,corrected);assert.equal(first.nextVersion,2);const rest=(await f.request(url+'/history?limit=2&afterVersion=2')).body;assert.deepEqual(rest.data.map((r:any)=>[r.version,r.state]),[[3,'withdrawn']]);assert.equal(rest.nextVersion,null);
  assert.deepEqual(await counts(f),before);const audit=(await f.request('audit-events')).body;assert.doesNotMatch(JSON.stringify(audit),/PRIVATE|verified full-offset|corrected evidence/);
  assert.equal((await f.request(url,undefined,'foreignMaster',{academy:f.b})).response.status,404);assert.equal((await f.request(url,undefined,'peer')).response.status,404);
  assert.equal((await f.request(url+'?amount=0')).response.status,400);assert.equal((await f.request(url+'/history?limit=1&limit=2')).response.status,400);assert.equal((await f.request(url+'/history',body)).response.status,405);
 }finally{await f.pg.close();}
});
test('zero-net settlement uses upper-human approval,beneficiary protection,current source privacy and stale-version fencing',async()=>{
 const f=await t4aRecordFixture({classification:'employee',reportingForm:'T4'});try{
  const {posted}=await zeroNetSource(f),url=path(posted.id),requested=await f.request(url,body,'staff');assert.equal(requested.response.status,202,JSON.stringify(requested.body));const id=requested.body.approval.id;
  const notice=(await f.request('notifications?origin=mandatory',undefined,'manager')).body.data.find((n:any)=>n.source.id===id);assertGenericCriticalNotice(notice);assert.doesNotMatch(JSON.stringify(notice),/PRIVATE|settledAt|settledOn|full-offset/);
  const p=(await f.pg.query<any>('SELECT review_context FROM public.approval_requests WHERE id=$1',[id])).rows[0];
  const attempt=async(d:unknown,who=f.actors.manager.person)=>{await f.pg.exec('BEGIN');try{await f.pg.query("SELECT set_config('app.academy_id',$1,true)",[f.a]);await f.pg.exec('SET LOCAL ROLE kavosh_runtime');await f.pg.query('INSERT INTO public.zero_net_settlements(academy_id,posting_id) VALUES($1,$2)',[f.a,posted.id]);await f.pg.query('INSERT INTO public.zero_net_settlement_revisions(academy_id,posting_id,version,definition,source_snapshot,changed_by,approval_id,reason) VALUES($1,$2,1,$3::jsonb,$4::jsonb,$5,$6,$7)',[f.a,posted.id,JSON.stringify(d),JSON.stringify(p.review_context),who,id,body.reason]);await f.pg.exec('COMMIT');}finally{await f.pg.exec('ROLLBACK');}};
  await assert.rejects(()=>attempt({...definition,reference:'Forged different source'}),/ZERO_NET_SETTLEMENT_EXACT_REVIEW_REQUIRED/);await assert.rejects(()=>attempt(definition,f.actors.staff.person),/BENEFICIARY_REVIEW_FORBIDDEN/);await assert.rejects(()=>attempt(definition),/REVIEWED_APPROVAL_NOT_APPLIED|ZERO_NET_SETTLEMENT_AUDIT_REQUIRED/);assert.equal((await f.pg.query('SELECT * FROM public.zero_net_settlements')).rows.length,0);
  assert.equal((await f.request(url)).response.status,404);assert.equal((await f.request('approvals/'+id+'/decide',{expectedVersion:1,decision:'approve',reason:'Cannot self-approve'},'staff')).response.status,403);
  const approved=await f.request('approvals/'+id+'/decide',{expectedVersion:1,decision:'approve',reason:'PRIVATE upper reviewer inspected original source'},'manager');assert.equal(approved.response.status,200,JSON.stringify(approved.body));assert.equal(approved.body.approval.status,'applied');assert.equal(approved.body.data.changedBy,f.actors.manager.person);
  const pending=await f.request(url,{...body,expectedVersion:1},'staff');assert.equal(pending.response.status,202);const pendingId=pending.body.approval.id;
  assert.equal((await f.request(url,{...body,expectedVersion:1,definition:{...definition,reference:'PRIVATE newer master correction'}})).response.status,200);
  const stale=await f.request('approvals/'+pendingId+'/decide',{expectedVersion:1,decision:'approve',reason:'Original edition is stale'},'manager');assert.equal(stale.response.status,409);assert.equal(stale.body.approval.status,'stale');
  const third=await f.request(url,{...body,expectedVersion:2},'staff');assert.equal(third.response.status,202);
  await f.pg.query("DELETE FROM public.role_permissions WHERE role_id=$1 AND capability='journals.view'",[f.managerRole]);
  assert.equal((await f.request('approvals/'+third.body.approval.id,undefined,'manager')).response.status,404);assert.equal((await f.request(url,undefined,'manager')).response.status,404);
  const root=await f.request(url);assert.equal(root.response.status,200);assert.equal(root.body.data.version,2);
 }finally{await f.pg.close();}
});
test('zero-net settlement refuses positive net,future or invalid dates and retains prior attestation after posting reversal',async()=>{
 const f=await t4aRecordFixture();try{
  assert.equal((await f.request(path(f.posted.id),body)).response.status,409);
  const {posted}=await zeroNetSource(f),url=path(posted.id);
  for(const d of [{...definition,settledAt:'2099-01-01T12:00:00Z'},{...definition,timeZone:'Unknown/Private'},{...definition,amount:'0.00'},{...definition,settledAt:'2026-02-30T12:00:00Z'},{...definition,settledAt:'2026-02-16T24:00:00Z'},{...definition,settledAt:'2026-02-16T00:30:00.1234567Z'}]){const bad=await f.request(url,{...body,definition:d});assert.ok([400,409].includes(bad.response.status),JSON.stringify(bad.body));}
  assert.equal((await f.request(url,body)).response.status,200);const reversed=await f.request('payroll/net-postings/'+posted.id+'/reverse',{period:{id:f.period.id,version:1},postedOn:'2026-02-18',reason:'Synthetic correction of original posting'});assert.equal(reversed.response.status,201,JSON.stringify(reversed.body));
  const retained=await f.request(url);assert.equal(retained.response.status,200);assert.equal(retained.body.data.currentPostingReversed,true);assert.deepEqual(retained.body.data.definition,definition);
  assert.equal((await f.request(url,{...body,expectedVersion:1})).response.status,409);const withdraw=await f.request(url,{expectedVersion:1,definition:null,reason:'Withdraw invalidated attestation'});assert.equal(withdraw.response.status,200,JSON.stringify(withdraw.body));
  const hidden=await f.made('finance/accounts',{code:'ZERO-HIDDEN',name:'PRIVATE other-hub withholding',kind:'liability',operationalRole:'payable',hubId:f.otherHub,currencyId:f.currency.id,currencyVersion:1,reason:'Synthetic isolated source account'}),other=await zeroNetSource(f,{deductionAccount:hidden}),otherPath=path(other.posted.id),saved=await f.request(otherPath,body);assert.equal(saved.response.status,200);
  for(const r of [await f.request(otherPath,undefined,'manager'),await f.request(otherPath,{...body,expectedVersion:1},'manager'),await f.request('approvals/'+saved.body.approval.id,undefined,'manager')]){assert.equal(r.response.status,404);assert.doesNotMatch(JSON.stringify(r.body),/PRIVATE|settledAt|full-offset/);}
 }finally{await f.pg.close();}
});
test('actual407to408 upgrade preserves populated financial and approval state and protects new immutable history natively',async()=>{
 const f=await t4aRecordFixture({throughSchema:407});try{
  const {posted}=await zeroNetSource(f),tables=['payrun_groups','payrun_net_revisions','payrun_net_postings','payrun_payments','finance_journals','finance_journal_lines','approval_requests','audit_events','outbox_events','role_permissions'];
  const snapshot=async()=>{const result=[];for(const table of tables)result.push((await f.pg.query('SELECT to_jsonb(t)::text row FROM public.'+table+' t ORDER BY to_jsonb(t)::text')).rows);return result;},before=await snapshot();
  const authority=()=>f.pg.query("SELECT oid,proowner,proacl,pg_get_functiondef(oid) definition FROM pg_proc WHERE oid IN('public.paid_tax_record_plan(uuid,uuid,integer,jsonb)'::regprocedure,'public.payrun_posting_privacy()'::regprocedure) ORDER BY oid"),original=(await authority()).rows;
  await f.pg.exec('BEGIN');try{await f.pg.exec(await readFile(new URL('../db/migrations/408_zero_net_settlements.sql',import.meta.url),'utf8'));await f.pg.exec('COMMIT');}catch(e){await f.pg.exec('ROLLBACK');throw e;}
  assert.deepEqual(await snapshot(),before);assert.deepEqual((await authority()).rows,original);assert.equal((await f.pg.query<{r:number}>('SELECT public.schema_revision() r')).rows[0].r,408);
  const coverage=(await f.pg.query<any>("SELECT relation_name,delete_guard_present,truncate_guard_present FROM platform_private.academy_preservation_coverage WHERE relation_name LIKE 'zero_net_%' ORDER BY relation_name")).rows;assert.equal(coverage.length,2);assert.ok(coverage.every((r:any)=>r.delete_guard_present&&r.truncate_guard_present));
  assert.equal((await f.request(path(posted.id),body)).response.status,200);
  await f.pg.exec('BEGIN');try{await f.pg.query("SELECT set_config('app.academy_id',$1,true)",[f.b]);await f.pg.exec('SET LOCAL ROLE kavosh_runtime');for(const t of ['zero_net_settlements','zero_net_settlement_revisions'])assert.equal((await f.pg.query('SELECT * FROM public.'+t)).rows.length,0);}finally{await f.pg.exec('ROLLBACK');}
  await assert.rejects(f.pg.exec("UPDATE public.zero_net_settlement_revisions SET definition='null'"));await assert.rejects(f.pg.exec('DELETE FROM public.zero_net_settlement_revisions'));
  assert.deepEqual((await f.request(path(posted.id)+'/history')).body.data.map((r:any)=>r.version),[1]);
 }finally{await f.pg.close();}
});
test('zero-net settlement audit failure rolls back the effect,approval,outbox and retry receipt together',async()=>{
 const f=await t4aRecordFixture();try{
  const {posted}=await zeroNetSource(f),url=path(posted.id),key=randomUUID(),before=await counts(f);
  await f.pg.exec("CREATE FUNCTION public.fail_zero_net_audit_test() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN IF NEW.action='work.zero-net-settlement.change' THEN RAISE EXCEPTION 'synthetic missing audit';END IF;RETURN NEW;END$$;CREATE TRIGGER fail_zero_net_audit_test BEFORE INSERT ON public.audit_events FOR EACH ROW EXECUTE FUNCTION public.fail_zero_net_audit_test()");
  assert.equal((await f.request(url,body,'master',{key})).response.status,503);for(const t of ['zero_net_settlements','zero_net_settlement_revisions'])assert.equal((await f.pg.query('SELECT * FROM public.'+t)).rows.length,0);assert.equal((await f.pg.query("SELECT * FROM public.approval_requests WHERE action='work.zero-net-settlement.change'")).rows.length,0);assert.equal((await f.pg.query("SELECT * FROM public.outbox_events WHERE event_type='work.zero-net-settlement.change'")).rows.length,0);assert.deepEqual(await counts(f),before);
  await f.pg.exec('DROP TRIGGER fail_zero_net_audit_test ON public.audit_events;DROP FUNCTION public.fail_zero_net_audit_test()');const retry=await f.request(url,body,'master',{key});assert.equal(retry.response.status,200,JSON.stringify(retry.body));assert.deepEqual((await f.request(url,body,'master',{key})).body,retry.body);
 }finally{await f.pg.close();}
});
test('native simultaneous zero-net settlement edits produce exactly one edition and one audit effect',{skip:!process.env.TEST_DATABASE_URL},async()=>{
 const f=await t4aRecordFixture();try{const {posted}=await zeroNetSource(f),start=performance.now(),r=await Promise.all([f.request(path(posted.id),body),f.request(path(posted.id),body)]);assert.deepEqual(r.map(x=>x.response.status).sort(),[200,409]);assert.equal((await f.pg.query('SELECT * FROM public.zero_net_settlement_revisions')).rows.length,1);assert.equal((await f.pg.query("SELECT * FROM public.audit_events WHERE action='work.zero-net-settlement.change'")).rows.length,1);assert.ok(performance.now()-start<10000);}finally{await f.pg.close();}
});
