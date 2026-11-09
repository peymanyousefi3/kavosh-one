import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomUUID} from 'node:crypto';
import {collectorOffsetFixture} from './collector-offset-fixture.ts';
import {counterpartyReportCapabilities} from '../src/modules/counterparty-statement-access.ts';
import {captureCounterpartyReport} from '../src/reports/counterparty-capture.ts';
import {loadGrants,type ApiContext} from '../src/core/api.ts';
import type {Credential} from '../src/core/policy.ts';
import {assertRuntimeRole} from '../src/core/database.ts';
import {lockAcademyTopology} from '../src/modules/academy.ts';
import {readFile} from 'node:fs/promises';
async function fixture(){const f=await collectorOffsetFixture();try{
 for(const cap of counterpartyReportCapabilities)await f.pg.query("INSERT INTO public.role_permissions VALUES($1,$2,$3,'allow') ON CONFLICT DO NOTHING",[f.a,f.staffRole,cap]);
 const parameters={payeeId:f.hubPayee.id,from:'2026-11-06',through:'2026-11-08'},q=await f.request('reports/jobs',{reportId:'finance.counterparty-statement',parameters},'staff');assert.equal(q.response.status,202,JSON.stringify(q.body));
 async function capture(leasePatch?:string){await f.pg.exec('SET ROLE kavosh_automation_worker');let transaction=false;try{
  await assertRuntimeRole({query:f.pg.query.bind(f.pg),release(){}},'automation_worker');await f.pg.query("SELECT set_config('app.academy_id',$1,false)",[f.a]);const lease=(await f.pg.query<{id:string;lease_token:string}>('SELECT * FROM public.claim_report_job($1)',[[f.a]])).rows[0];assert.ok(lease);assert.equal(lease.id,q.body.data.id);const c=(await f.pg.query<Credential&{user_id:string}>('SELECT * FROM public.report_job_actor($1,$2)',[lease.id,lease.lease_token])).rows[0];assert.ok(c?.allowed);assert.equal(c.person_id,f.actors.staff.person);await f.pg.exec('BEGIN');transaction=true;assert.equal((await f.pg.query<{ok:boolean}>('SELECT public.lock_human($1,$2) ok',[c.token_id,c.user_id])).rows[0].ok,true);const db={query:f.pg.query.bind(f.pg),release(){}},ctx:ApiContext={db,credential:c,grants:await loadGrants(db,c),request:new Request('https://internal.invalid'),path:'reports/jobs/'+lease.id,requestId:randomUUID()};await lockAcademyTopology(ctx);const captured=await captureCounterpartyReport(ctx,lease.id,leasePatch??lease.lease_token);await f.pg.exec('COMMIT');transaction=false;return {captured,lease};
 }finally{if(transaction)await f.pg.exec('ROLLBACK');await f.pg.exec('RESET ROLE');}}
 return {...f,parameters,job:q.body.data,capture};
 }catch(e){await f.pg.close();throw e;}}
type F=Awaited<ReturnType<typeof fixture>>;function check(name:string,run:(f:F)=>Promise<void>){test(name,async()=>{const f=await fixture();try{await run(f);}finally{await f.pg.close();}});}
check('actual requester-bound capture retains all canonical rows and source proof atomically without publishing a result',async f=>{
 const {captured}=await f.capture();assert.equal(captured.captured,true);assert.equal(captured.sourceCount,2);assert.equal(captured.entryCount,2);const h=(await f.pg.query<any>('SELECT * FROM public.counterparty_report_captures')).rows[0],rows=(await f.pg.query<any>('SELECT section,ordinal,payload FROM public.counterparty_report_capture_rows ORDER BY section,ordinal')).rows;assert.deepEqual(h.frame,f.parameters);assert.equal(h.source_metadata.sourceFingerprint,captured.sourceFingerprint);assert.equal(rows.filter(r=>r.section===4).length,2);assert.equal(rows.filter(r=>r.section===2).length,2);assert.equal(rows.find(r=>r.section===1).payload.closing,'2825');assert.deepEqual(rows.find(r=>r.section===0).payload,h.source_metadata);assert.equal((await f.pg.query('SELECT 1 FROM public.report_job_results')).rows.length,0);assert.equal((await f.request('reports/jobs/'+f.job.id+'/download',undefined,'staff')).response.status,409);assert.equal((await f.pg.query("SELECT 1 FROM public.audit_events WHERE action='report.capture'")).rows.length,1);
});
check('missing original source authority rolls back the complete capture and its audit',async f=>{
 await f.pg.query("DELETE FROM public.role_permissions WHERE role_id=$1 AND capability='expenses.view'",[f.staffRole]);await assert.rejects(f.capture(),(e:any)=>e.code==='REPORT_SOURCE_ACCESS_CHANGED');for(const table of ['counterparty_report_captures','counterparty_report_capture_rows'])assert.equal((await f.pg.query('SELECT 1 FROM public.'+table)).rows.length,0);assert.equal((await f.pg.query("SELECT 1 FROM public.audit_events WHERE action='report.capture'")).rows.length,0);
});
check('wrong native worker lease cannot leave a header,source rows or capture audit',async f=>{
 await assert.rejects(f.capture(randomUUID()),/REPORT_CAPTURE_LIVE_LEASE_REQUIRED/);assert.equal((await f.pg.query('SELECT 1 FROM public.counterparty_report_captures')).rows.length,0);assert.equal((await f.pg.query('SELECT 1 FROM public.counterparty_report_capture_rows')).rows.length,0);assert.equal((await f.pg.query("SELECT 1 FROM public.audit_events WHERE action='report.capture'")).rows.length,0);
});
check('captured money and source membership remain frozen after a later real remittance',async f=>{
 await f.capture();const before=(await f.pg.query('SELECT section,ordinal,payload FROM public.counterparty_report_capture_rows ORDER BY section,ordinal')).rows;
 assert.equal((await f.remit('10','2026-11-07')).response.status,201);
 assert.deepEqual((await f.pg.query('SELECT section,ordinal,payload FROM public.counterparty_report_capture_rows ORDER BY section,ordinal')).rows,before);
 const live=await f.request('reports/finance/counterparty-statement?'+new URLSearchParams(f.parameters),undefined,'staff');assert.equal(live.response.status,200,JSON.stringify(live.body));assert.equal(live.body.data.currencies[0].closing.minor,'1825');
});
check('opening source membership and noncash offsets survive capture without becoming current-window cash',async f=>{
 const principal=await f.made('finance/accounts',{code:'CAPTURE-OPENING',name:'Explicit original principal',kind:'asset',operationalRole:'other',hubId:f.hub,currencyId:f.currency.id,currencyVersion:1,reason:'Original opening source'}),opening=await f.request('finance/journals',{periodId:f.period.id,periodVersion:1,postedOn:'2026-01-01',purpose:'opening',description:'Original opening principal',reason:'Retain actual dated source',lines:[{accountId:principal.id,accountVersion:1,side:'debit',amount:'100'},{accountId:f.cash.id,accountVersion:1,side:'credit',amount:'100'}],counterpartyLines:[{lineNumber:1,payee:{id:f.hubPayee.id,version:1},category:'opening_balance'}]});assert.equal(opening.response.status,201,JSON.stringify(opening.body));assert.equal((await f.offset()).response.status,201);
 const {captured}=await f.capture(),rows=(await f.pg.query<any>('SELECT section,ordinal,payload FROM public.counterparty_report_capture_rows ORDER BY section,ordinal')).rows;
 assert.equal(captured.sourceCount,5);assert.equal(captured.entryCount,4);assert.equal(rows.filter(r=>r.section===4).length,5);const totals=rows.find(r=>r.section===1).payload;assert.equal(totals.opening,'10000');
 const live=await f.request('reports/finance/counterparty-statement?'+new URLSearchParams(f.parameters),undefined,'staff');assert.equal(live.response.status,200,JSON.stringify(live.body));assert.equal(totals.closing,live.body.data.currencies[0].closing.minor);const pair=rows.filter(r=>r.section===2&&r.payload.category==='noncash_offset');assert.equal(pair.length,2);assert.equal(pair.reduce((n,r)=>n+BigInt(r.payload.change),0n),0n);
});
check('web and outbound roles cannot browse the cache or execute private capture and worker cannot write raw cached rows',async f=>{
 await f.capture();for(const role of ['kavosh_runtime','kavosh_message_worker']){await f.pg.exec('SET ROLE '+role);try{
  for(const sql of ['SELECT * FROM public.counterparty_report_captures','SELECT * FROM public.counterparty_report_capture_rows','SELECT public.capture_counterparty_report_job($1,$2,$3,$4::jsonb)'])await assert.rejects(f.pg.query(sql,sql.includes('$1')?[f.job.id,randomUUID(),randomUUID(),'{}']:[]),/permission denied/);
 }finally{await f.pg.exec('RESET ROLE');}}
 await f.pg.exec('SET ROLE kavosh_automation_worker');try{for(const sql of ["UPDATE public.counterparty_report_captures SET source_metadata='{}'::jsonb",'DELETE FROM public.counterparty_report_capture_rows',"INSERT INTO public.counterparty_report_capture_rows VALUES($1,$2,0,0,'{}'::jsonb)"])await assert.rejects(f.pg.query(sql,sql.includes('$1')?[f.a,f.job.id]:[]),/permission denied/);}finally{await f.pg.exec('RESET ROLE');}
});
check('private capture policy cannot be used as an application or daemon identity and sealed snapshots cannot be edited even by it',async f=>{
 await f.capture();await f.pg.exec('SET ROLE kavosh_report_capture_policy');try{
  for(const purpose of ['web','automation_worker','message_worker'] as const)await assert.rejects(assertRuntimeRole({query:f.pg.query.bind(f.pg),release(){}},purpose),/UNSAFE_DATABASE_ROLE/);
  await assert.rejects(f.pg.query("UPDATE public.counterparty_report_captures SET source_metadata='{}'::jsonb"),/REPORT_CAPTURE_IMMUTABLE/);
  await assert.rejects(f.pg.query('DELETE FROM public.counterparty_report_capture_rows'),/permission denied|REPORT_CAPTURE_IMMUTABLE/);
 }finally{await f.pg.exec('RESET ROLE');}
});
test('actual283to284 upgrade preserves existing financial records,jobs and canonical source functions',async()=>{
 const f=await collectorOffsetFixture(283);try{
  assert.equal((await f.request('reports/jobs',{reportId:'finance.counterparty-statement',parameters:{payeeId:f.hubPayee.id,from:'2026-11-06',through:'2026-11-08'}})).response.status,202);
  const tables=['report_jobs','report_job_results','finance_journals','finance_journal_lines','audit_events'],snapshot=async(t:string)=>(await f.pg.query('SELECT to_jsonb(r) data FROM public.'+t+' r ORDER BY to_jsonb(r)::text')).rows,before=[];for(const t of tables)before.push(await snapshot(t));
  const sql="SELECT oid,prosrc,proowner,proacl,proconfig,provolatile,prosecdef FROM pg_proc WHERE oid=ANY(ARRAY['public.counterparty_statement_snapshot_read(uuid,date,date,jsonb,date,uuid,text,integer,integer,uuid[],boolean)'::regprocedure,'public.counterparty_statement_export_snapshot_read(uuid,date,date,jsonb,date,uuid,text,integer,integer,uuid[],boolean)'::regprocedure,'public.report_job_guard()'::regprocedure,'public.finish_report_job(uuid,uuid,text,text,text,text,jsonb)'::regprocedure]) ORDER BY oid",functions=(await f.pg.query(sql)).rows;
  await f.pg.exec(await readFile(new URL('../db/migrations/284_counterparty_report_capture.sql',import.meta.url),'utf8'));for(let n=0;n<tables.length;n++)assert.deepEqual(await snapshot(tables[n]),before[n]);assert.deepEqual((await f.pg.query(sql)).rows,functions);assert.equal((await f.pg.query<{revision:number}>('SELECT public.schema_revision() revision')).rows[0].revision,284);
 }finally{await f.pg.close();}
});
