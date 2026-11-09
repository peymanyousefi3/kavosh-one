import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomUUID} from 'node:crypto';
import {collectorOffsetFixture} from './collector-offset-fixture.ts';
import {counterpartyReportCapabilities} from '../src/modules/counterparty-statement-access.ts';
import {captureCounterpartyReport,requireCounterpartyCaptureAccess} from '../src/reports/counterparty-capture.ts';
import {loadGrants,type ApiContext} from '../src/core/api.ts';
import type {Credential} from '../src/core/policy.ts';
import {assertRuntimeRole} from '../src/core/database.ts';
import {lockAcademyTopology} from '../src/modules/academy.ts';
import {readFile} from 'node:fs/promises';
import {parse} from 'csv-parse/sync';
import {renderCounterpartyCaptureRows} from '../src/reports/counterparty-render.ts';
async function fixture(throughSchema?:number){const f=await collectorOffsetFixture(throughSchema);try{
 for(const cap of counterpartyReportCapabilities)await f.pg.query("INSERT INTO public.role_permissions VALUES($1,$2,$3,'allow') ON CONFLICT DO NOTHING",[f.a,f.staffRole,cap]);
 const parameters={payeeId:f.hubPayee.id,from:'2026-11-06',through:'2026-11-08'},q=await f.request('reports/jobs',{reportId:'finance.counterparty-statement',parameters},'staff');assert.equal(q.response.status,202,JSON.stringify(q.body));
 async function capture(leasePatch?:string){await f.pg.exec('SET ROLE kavosh_automation_worker');let transaction=false;try{
  await assertRuntimeRole({query:f.pg.query.bind(f.pg),release(){}},'automation_worker');await f.pg.query("SELECT set_config('app.academy_id',$1,false)",[f.a]);const lease=(await f.pg.query<{id:string;lease_token:string}>('SELECT * FROM public.claim_report_job($1)',[[f.a]])).rows[0];assert.ok(lease);assert.equal(lease.id,q.body.data.id);const c=(await f.pg.query<Credential&{user_id:string}>('SELECT * FROM public.report_job_actor($1,$2)',[lease.id,lease.lease_token])).rows[0];assert.ok(c?.allowed);assert.equal(c.person_id,f.actors.staff.person);await f.pg.exec('BEGIN');transaction=true;assert.equal((await f.pg.query<{ok:boolean}>('SELECT public.lock_human($1,$2) ok',[c.token_id,c.user_id])).rows[0].ok,true);const db={query:f.pg.query.bind(f.pg),release(){}},ctx:ApiContext={db,credential:c,grants:await loadGrants(db,c),request:new Request('https://internal.invalid'),path:'reports/jobs/'+lease.id,requestId:randomUUID()};await lockAcademyTopology(ctx);const captured=await captureCounterpartyReport(ctx,lease.id,leasePatch??lease.lease_token);await f.pg.exec('COMMIT');transaction=false;return {captured,lease,context:ctx};
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
check('bounded capture renderer preserves every canonical financial CSV row and disclosure flag',async f=>{
 await f.capture();const rows=(await f.pg.query('SELECT section,ordinal,payload FROM public.counterparty_report_capture_rows WHERE section<4 ORDER BY section,ordinal')).rows,frame=(await f.pg.query<any>('SELECT frame FROM public.counterparty_report_captures')).rows[0].frame,whole=renderCounterpartyCaptureRows(frame,rows).body,parts=rows.map(r=>renderCounterpartyCaptureRows(frame,[r]).body).join('');assert.equal(parts,whole);
 const direct=await f.request('reports/finance/counterparty-statement/export?'+new URLSearchParams(f.parameters),undefined,'staff');assert.equal(direct.response.status,200,JSON.stringify(direct.body));const actual=parse(whole,{columns:true,bom:true})as Record<string,string>[],expected=parse(direct.body,{columns:true,bom:true})as Record<string,string>[];assert.deepEqual(actual.filter(r=>r.section!=='metadata'),expected.filter(r=>r.section!=='metadata'));
 for(const r of expected.filter(r=>r.section==='metadata'&&r.field!=='snapshotAt'))assert.deepEqual(actual.find(a=>a.section==='metadata'&&a.field===r.field),r,r.field);assert.doesNotMatch(whole,/sourceScope|sourceManifest|authorizationContext|lease_token/);
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
check('large captured membership reauthorization returns only a Boolean under web read-only access and preserves old money after new activity',async f=>{
 const {captured,context}=await f.capture(),proof={kind:'counterparty_capture',jobId:f.job.id,sourceFingerprint:captured.sourceFingerprint,frame:f.parameters};
 async function read(){await f.pg.exec('SET ROLE kavosh_runtime');try{context.grants=await loadGrants(context.db,context.credential);await f.pg.exec('BEGIN READ ONLY');try{await requireCounterpartyCaptureAccess(context,proof);await f.pg.exec('COMMIT');}catch(e){await f.pg.exec('ROLLBACK');throw e;}}finally{await f.pg.exec('RESET ROLE');}}
 await read();assert.equal((await f.remit('10','2026-11-07')).response.status,201);await read();
 await f.pg.query("DELETE FROM public.role_permissions WHERE role_id=$1 AND capability='expenses.view'",[f.staffRole]);await assert.rejects(read(),(e:any)=>e.code==='REPORT_SOURCE_ACCESS_CHANGED');assert.equal((await f.pg.query<any>('SELECT payload FROM public.counterparty_report_capture_rows WHERE section=1')).rows[0].payload.closing,'2825');
});
check('capture access refuses another frame,fingerprint,tenant and newly hidden original funding without leaking cached membership',async f=>{
 const {captured,context}=await f.capture(),scopes=Object.fromEntries(counterpartyReportCapabilities.map(cap=>[cap,{all:true,hubs:[]}])) as Record<string,{all:boolean;hubs:string[]}>;
 const allows=async(frame:unknown=f.parameters,fingerprint=captured.sourceFingerprint,academy=f.a)=>{await f.pg.exec('SET ROLE kavosh_runtime');try{await f.pg.query("SELECT set_config('app.academy_id',$1,false)",[academy]);const r=(await f.pg.query('SELECT public.counterparty_report_capture_allows($1,$2,$3::jsonb,$4::jsonb) ok',[f.job.id,fingerprint,JSON.stringify(frame),JSON.stringify(scopes)])).rows;assert.deepEqual(Object.keys(r[0]),['ok']);return r[0].ok;}finally{await f.pg.exec('RESET ROLE');await f.pg.query("SELECT set_config('app.academy_id',$1,false)",[f.a]);}};
 assert.equal(await allows(),true);assert.equal(await allows({...f.parameters,from:'2026-11-01'}),false);assert.equal(await allows(f.parameters,'0'.repeat(64)),false);assert.equal(await allows(f.parameters,captured.sourceFingerprint,f.b),false);
 const funding=await f.made('finance/accounts',{code:'CAPTURE-FUTURE-HIDDEN',name:'Other original funding context',kind:'asset',operationalRole:'cash',hubId:f.otherHub,currencyId:f.currency.id,currencyVersion:1,reason:'Explicit retained source'});assert.equal((await f.request('finance/expense-bills/'+f.bill.id+'/payments',{fundingAccount:{id:funding.id,version:1},payableVersion:1,method:{id:f.method.id,version:1},amount:'10',period:f.input.period,postedOn:'2026-12-01',paidAt:'2026-12-01T12:00:00Z',missingEvidenceReason:'Synthetic future original funding',taxTreatment:'settle_expense_bill',reason:'Current source cannot hide future context'})).response.status,201);
 await f.pg.exec('SET ROLE kavosh_runtime');try{context.grants=await loadGrants(context.db,context.credential);await assert.rejects(requireCounterpartyCaptureAccess(context,{kind:'counterparty_capture',jobId:f.job.id,sourceFingerprint:captured.sourceFingerprint,frame:f.parameters}),(e:any)=>e.code==='REPORT_SOURCE_ACCESS_CHANGED');}finally{await f.pg.exec('RESET ROLE');}
});
test('actual284to285 preserves cached rows and all original monetary functions while adding Boolean-only access',async()=>{
 const f=await fixture(284);try{
  await f.capture();const rowsSQL='SELECT section,ordinal,payload FROM public.counterparty_report_capture_rows ORDER BY section,ordinal',cached=(await f.pg.query(rowsSQL)).rows,headerSQL='SELECT to_jsonb(h) data FROM public.counterparty_report_captures h',header=(await f.pg.query(headerSQL)).rows;
  const signatures="ARRAY['public.counterparty_statement_snapshot_read(uuid,date,date,jsonb,date,uuid,text,integer,integer,uuid[],boolean)'::regprocedure,'public.counterparty_statement_export_snapshot_read(uuid,date,date,jsonb,date,uuid,text,integer,integer,uuid[],boolean)'::regprocedure,'public.capture_counterparty_report_job(uuid,uuid,uuid,jsonb)'::regprocedure]",sql='SELECT oid,proowner,proacl,prosrc,proconfig,provolatile FROM pg_proc WHERE oid=ANY('+signatures+') ORDER BY oid',before=(await f.pg.query(sql)).rows,bodySQL="SELECT oid,proowner,proacl,proconfig,provolatile FROM pg_proc WHERE oid='public.counterparty_report_capture_rows(uuid,date,date,jsonb,date,uuid,text,integer,integer,uuid[],boolean)'::regprocedure",properties=(await f.pg.query(bodySQL)).rows;
  await f.pg.exec(await readFile(new URL('../db/migrations/285_counterparty_capture_access.sql',import.meta.url),'utf8'));assert.deepEqual((await f.pg.query(sql)).rows,before);assert.deepEqual((await f.pg.query(bodySQL)).rows,properties);assert.deepEqual((await f.pg.query(rowsSQL)).rows,cached);assert.deepEqual((await f.pg.query(headerSQL)).rows,header);assert.equal((await f.pg.query<{revision:number}>('SELECT public.schema_revision() revision')).rows[0].revision,285);
  await f.pg.exec('SET ROLE kavosh_message_worker');try{await assert.rejects(f.pg.query('SELECT public.counterparty_report_capture_allows($1,$2,$3::jsonb,$4::jsonb)',[randomUUID(),'a'.repeat(64),'{}','{}']),/permission denied/);}finally{await f.pg.exec('RESET ROLE');}
 }finally{await f.pg.close();}
});
