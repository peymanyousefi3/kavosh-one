import assert from 'node:assert/strict';
import { randomUUID,createHash } from 'node:crypto';
import { test } from 'node:test';
import { spawn,spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { readFile } from 'node:fs/promises';
import { parse } from 'csv-parse/sync';
import { operationsFixture } from './operations-fixture.ts';
import { processOneReport } from '../src/reports/export-worker.ts';
import type { Database } from '../src/core/database.ts';
import { businessContract } from '../src/modules/business.ts';
import { reportJobsContract } from '../src/modules/report-jobs.ts';

test('every implemented report job operation is registered in the main generated bot API',async()=>{
 const api=JSON.parse(await readFile(new URL('../public/openapi.json',import.meta.url),'utf8'));assert.equal(reportJobsContract.length,6);for(const endpoint of reportJobsContract){assert.ok(businessContract.includes(endpoint));assert.equal(api.paths[endpoint.path]?.[endpoint.method]?.summary,endpoint.summary);}
});

async function fixture(){const f=await operationsFixture();try{
 for(const role of [f.staffRole,f.managerRole])for(const cap of ['financial-reports.view','accounts.view','ledger.view'])await f.pg.query("INSERT INTO public.role_permissions VALUES($1,$2,$3,'allow')",[f.a,role,cap]);
 const made=async(path:string,body:unknown)=>{const r=await f.request(path,body);assert.equal(r.response.status,201,JSON.stringify(r.body));return r.body.data;};
 const currency=await made('finance/currencies',{code:'CAD',name:'Canadian dollar',unitScale:2,reason:'Report job test currency'}),period=await made('finance/periods',{name:'Report job year',startsOn:'2026-01-01',endsOn:'2026-12-31',reason:'Report job test year'});
 const account=(code:string,kind='asset',hubId=f.hub)=>made('finance/accounts',{code,name:'Account '+code,kind,hubId,currencyId:currency.id,currencyVersion:1,reason:'Actual queued-report source'}),cash=await account('1000'),income=await account('4000','income');
 const post=async(amount='100.00')=>made('finance/journals',{periodId:period.id,periodVersion:1,postedOn:'2026-06-01',purpose:'activity',description:'PRIVATE journal',reason:'Queue report test posting',lines:[{accountId:cash.id,accountVersion:1,side:'debit',amount},{accountId:income.id,accountVersion:1,side:'credit',amount}]});await post();
 const errors:{code?:string;message?:string}[]=[],database:Database={async connect(){const c=f.pg.runtime?await f.pg.runtime.connect():{query:f.pg.query.bind(f.pg),release(){}};await c.query('SET ROLE kavosh_automation_worker');return {async query<Row>(sql:string,params?:unknown[]){try{return await c.query<Row>(sql,params);}catch(e){const x=e as {code?:string;message?:string};errors.push({code:x.code,message:x.message});throw e;}},release(destroy?:boolean){c.release(destroy);}};}};
 const work=async(db=database,signal?:AbortSignal)=>{try{return await processOneReport(db,[f.a],signal);}finally{if(!f.pg.runtime)await f.pg.exec('RESET ROLE');}};
 const queue=(as='staff',key?:string,parameters:Record<string,string>={through:'2026-12-31'})=>f.request('reports/jobs',{reportId:'finance.trial-balance',parameters},as,{key});
 const state=(id:string,as='staff')=>f.request('reports/jobs/'+id,undefined,as),download=(id:string,as='staff')=>f.request('reports/jobs/'+id+'/download',undefined,as);
 return {...f,currency,period,cash,income,account,post,made,queue,work,database,errors,state,download};
 }catch(e){await f.pg.close();throw e;}}
type F=Awaited<ReturnType<typeof fixture>>;
function check(name:string,run:(f:F)=>Promise<void>){test(name,async()=>{const f=await fixture();try{await run(f);}finally{await f.pg.close();}});}
check('durable own report jobs freeze complete CSV once,retain exact hash and never lend worker or peer authority',async f=>{
 const key=randomUUID(),q=await f.queue('staff',key);assert.equal(q.response.status,202,JSON.stringify(q.body));const id=q.body.data.id;assert.doesNotMatch(JSON.stringify(q.body),/credential_id|user_id|lease_token|token_hash/);assert.deepEqual((await f.queue('staff',key)).body,q.body);assert.equal((await f.download(id)).response.status,409);
 const result=await f.work();assert.equal(result.outcome,'succeeded',JSON.stringify(f.errors));assert.equal(result.recorded,true);const file=await f.download(id);assert.equal(file.response.status,200,JSON.stringify(file.body));assert.match(file.body,/100\.00/);assert.doesNotMatch(file.body,/PRIVATE journal/);const saved=await f.state(id);assert.equal(saved.body.data.status,'succeeded');assert.equal(saved.body.result.sha256,createHash('sha256').update(file.body).digest('hex'));assert.equal(saved.body.result.bytes,Buffer.byteLength(file.body));
 await f.post('50.00');assert.equal((await f.download(id)).body,file.body);assert.equal((await f.request('reports/jobs/'+id+'/cancel',{},'staff')).response.status,409);assert.equal((await f.work()).claimed,false);
 assert.equal((await f.state(id,'peer')).response.status,404);assert.equal((await f.state(id,'master')).response.status,200);assert.equal((await f.download(id,'master')).body,file.body);assert.equal((await f.request('reports/jobs/'+id,undefined,'foreignMaster',{academy:f.b})).response.status,404);
 assert.equal((await f.request('reports/jobs',undefined,'staff')).body.data.length,1);
});
check('worker rechecks actual identity verification,original session and current source permissions after enqueue',async f=>{
 const q=await f.queue();assert.equal(q.response.status,202);await f.pg.query("DELETE FROM public.role_permissions WHERE role_id=$1 AND capability='ledger.view'",[f.staffRole]);const result=await f.work();assert.equal(result.outcome,'cancelled',JSON.stringify(f.errors));assert.equal(result.recorded,true);assert.equal((await f.pg.query('SELECT * FROM public.report_job_results')).rows.length,0);assert.equal((await f.state(q.body.data.id)).response.status,403);
 await f.pg.query("INSERT INTO public.role_permissions VALUES($1,$2,'ledger.view','allow')",[f.a,f.staffRole]);const second=await f.queue();await f.pg.query('UPDATE identity."user" SET "phoneNumberVerified"=false WHERE id=$1',[f.actors.staff.user]);assert.equal((await f.work()).outcome,'cancelled',JSON.stringify(f.errors));assert.equal((await f.pg.query('SELECT last_error FROM public.report_jobs WHERE id=$1',[second.body.data.id])).rows[0].last_error,'QUEUED_AUTHORIZATION_EXPIRED');
});
check('stored result download checks source hubs again even when the caller still has another valid financial hub',async f=>{
 await f.pg.query('UPDATE public.role_assignments SET all_hubs=true WHERE person_id=$1 AND role_id=$2',[f.actors.staff.person,f.staffRole]);await f.account('2000','asset',f.otherHub);
 const q=await f.queue();assert.equal(q.response.status,202);assert.equal((await f.work()).outcome,'succeeded',JSON.stringify(f.errors));assert.equal((await f.download(q.body.data.id)).response.status,200);
 await f.pg.query('UPDATE public.role_assignments SET all_hubs=false WHERE person_id=$1 AND role_id=$2',[f.actors.staff.person,f.staffRole]);const denied=await f.download(q.body.data.id);assert.equal(denied.response.status,403);assert.equal(denied.body.error.code,'REPORT_SOURCE_ACCESS_CHANGED');assert.equal(denied.response.headers.get('content-disposition'),null);
 // Losing an unrelated hub must not block a file that selected only this hub.
 const selected=await f.queue('staff',undefined,{through:'2026-12-31',hubIds:f.hub});assert.equal(selected.response.status,202);assert.equal((await f.work()).outcome,'succeeded',JSON.stringify(f.errors));assert.equal((await f.download(selected.body.data.id)).response.status,200);
});
check('native job/result ownership,lease completion and tenant boundaries cannot be forged by the web runtime',async f=>{
 const q=await f.queue();assert.equal(q.response.status,202);await f.pg.exec('BEGIN');try{await f.pg.query("SELECT set_config('app.academy_id',$1,true)",[f.a]);await f.pg.exec('SET LOCAL ROLE kavosh_runtime');
 for(const sql of ['SELECT * FROM public.claim_report_job(ARRAY[]::uuid[])','UPDATE public.report_jobs SET requester_id=gen_random_uuid()','UPDATE public.report_jobs SET attempts=0','DELETE FROM public.report_jobs','INSERT INTO public.report_job_results(academy_id,job_id,body,filename,sha256,authorization_context) VALUES(gen_random_uuid(),gen_random_uuid(),\'x\',\'x.csv\',repeat(\'0\',64),\'{}\')']){await f.pg.exec('SAVEPOINT hostile');await assert.rejects(f.pg.exec(sql));await f.pg.exec('ROLLBACK TO SAVEPOINT hostile');}
 await f.pg.query("SELECT set_config('app.academy_id',$1,true)",[f.b]);assert.equal((await f.pg.query('SELECT * FROM public.report_jobs')).rows.length,0);
 }finally{await f.pg.exec('ROLLBACK');}
 assert.equal((await f.request('reports/jobs',{reportId:'finance.trial-balance',parameters:{through:'2026-12-31',afterId:randomUUID()}},'staff')).response.status,400);
});
test('native cancellation while report is prepared wins before any result or success can commit',{skip:!process.env.TEST_DATABASE_URL},async()=>{
 const f=await fixture();try{const q=await f.queue();assert.equal(q.response.status,202);let cancelled=false;const intercepted:Database={async connect(){const c=await f.database.connect();return {async query<Row>(sql:string,params?:unknown[]){if(!cancelled&&sql.startsWith('SELECT public.finish_report_job')&&sql.includes("'succeeded'")){const result=await f.request('reports/jobs/'+q.body.data.id+'/cancel',{},'staff');assert.equal(result.response.status,200,JSON.stringify(result.body));cancelled=true;}return c.query<Row>(sql,params);},release(destroy?:boolean){c.release(destroy);}};}};
 const result=await f.work(intercepted);assert.equal(cancelled,true);assert.equal(result.recorded,false);assert.equal((await f.state(q.body.data.id)).body.data.status,'cancelled');assert.equal((await f.pg.query('SELECT * FROM public.report_job_results')).rows.length,0);
 }finally{await f.pg.close();}
});
check('failed result persistence rolls back bytes and success,then a safe retry completes one immutable result',async f=>{
 const q=await f.queue();assert.equal(q.response.status,202);await f.pg.exec("CREATE FUNCTION public.fail_report_result() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic private failure';END $$;CREATE TRIGGER fail_report_result BEFORE INSERT ON public.report_job_results FOR EACH ROW EXECUTE FUNCTION public.fail_report_result()");
 assert.equal((await f.work()).outcome,'retry');const failed=await f.state(q.body.data.id);assert.equal(failed.body.data.status,'queued');assert.equal(failed.body.data.last_error,'PROCESSING_UNAVAILABLE');assert.doesNotMatch(JSON.stringify(failed.body),/synthetic private/);assert.equal((await f.pg.query('SELECT * FROM public.report_job_results')).rows.length,0);
 await f.pg.exec('DROP TRIGGER fail_report_result ON public.report_job_results;BEGIN;SET LOCAL ROLE kavosh_automation_policy');await f.pg.query("UPDATE public.report_jobs SET available_at=clock_timestamp()-interval '1 second' WHERE id=$1",[q.body.data.id]);await f.pg.exec('COMMIT');assert.equal((await f.work()).outcome,'succeeded',JSON.stringify(f.errors));assert.equal((await f.pg.query('SELECT * FROM public.report_job_results')).rows.length,1);
});
check('new verified login may cancel its own old queued job without inheriting the old session',async f=>{
 const q=await f.queue();assert.equal(q.response.status,202);const old=f.actors.staff.session,next=randomUUID();await f.pg.query('INSERT INTO identity.session(id,token,"userId","expiresAt","updatedAt","mfaVerified") VALUES($1,$2,$3,now()+interval \'1 day\',now(),true)',[next,'synthetic-session-'+randomUUID(),f.actors.staff.user]);f.actors.staff.session=next;
 await f.pg.query('UPDATE identity.session SET "expiresAt"=now()-interval \'1 second\' WHERE id=$1',[old]);assert.equal((await f.request('reports/jobs/'+q.body.data.id+'/cancel',{},'staff')).response.status,200);assert.equal((await f.work()).claimed,false);assert.equal((await f.pg.query('SELECT * FROM public.report_job_results')).rows.length,0);
});
check('school master can oversee and cancel human and bot jobs without borrowing their execution credentials',async f=>{
 for(const who of ['staff','bot']){const q=await f.queue(who);assert.equal(q.response.status,202);assert.equal((await f.state(q.body.data.id,'master')).response.status,200);const cancelled=await f.request('reports/jobs/'+q.body.data.id+'/cancel',{},'master');assert.equal(cancelled.response.status,200,JSON.stringify(cancelled.body));assert.equal(cancelled.body.data.status,'cancelled');}
 assert.equal((await f.request('reports/jobs',undefined,'master')).body.data.length,2);assert.equal((await f.work()).claimed,false);assert.equal((await f.pg.query('SELECT * FROM public.report_job_results')).rows.length,0);
});
test('lost report lease rolls back generated audit and bytes before one replacement generation can succeed',{skip:!process.env.TEST_DATABASE_URL},async()=>{
 const f=await fixture();try{const q=await f.queue();assert.equal(q.response.status,202);let expired=false;const intercepted:Database={async connect(){const c=await f.database.connect();return {async query<Row>(sql:string,params?:unknown[]){if(!expired&&sql.startsWith('SELECT public.finish_report_job')&&sql.includes("'succeeded'")){await f.pg.exec('BEGIN;SET LOCAL ROLE kavosh_automation_policy');await f.pg.query("UPDATE public.report_jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",[q.body.data.id]);await f.pg.exec('COMMIT');expired=true;}return c.query<Row>(sql,params);},release(destroy?:boolean){c.release(destroy);}};}};
 const lost=await f.work(intercepted);assert.equal(lost.recorded,false);assert.equal((await f.pg.query('SELECT * FROM public.report_job_results')).rows.length,0);assert.equal((await f.pg.query("SELECT * FROM public.audit_events WHERE action='report.generated'")).rows.length,0);
 assert.equal((await f.work()).outcome,'succeeded',JSON.stringify(f.errors));assert.equal((await f.state(q.body.data.id)).body.data.attempts,2);assert.equal((await f.pg.query('SELECT * FROM public.report_job_results')).rows.length,1);assert.equal((await f.pg.query("SELECT * FROM public.audit_events WHERE action='report.generated'")).rows.length,1);
 }finally{await f.pg.close();}
});
check('queue quota is a bounded logical rule and exact-key retries do not consume another slot',async f=>{
 const key=randomUUID(),first=await f.queue('staff',key);assert.equal(first.response.status,202);for(let i=1;i<20;i++)assert.equal((await f.queue()).response.status,202);assert.equal((await f.queue()).response.status,429);assert.deepEqual((await f.queue('staff',key)).body,first.body);assert.equal((await f.pg.query('SELECT * FROM public.report_jobs')).rows.length,20);assert.equal((await f.request('reports/jobs/'+first.body.data.id+'/cancel',{},'staff')).response.status,200);assert.equal((await f.queue()).response.status,202);
});
check('queued bot reports retain finite credential scope and revoked credentials cannot execute',async f=>{
 await f.account('2000','asset',f.otherHub);await f.pg.query('UPDATE public.role_assignments SET all_hubs=true WHERE person_id=$1 AND role_id=$2',[f.bot,f.managerRole]);const parameters={through:'2026-12-31',includeZero:'true'},broad=await f.queue('bot',undefined,parameters);assert.equal(broad.response.status,202,JSON.stringify(broad.body));assert.equal((await f.work()).outcome,'succeeded',JSON.stringify(f.errors));assert.match((await f.download(broad.body.data.id,'bot')).body,/Account 2000/);
 await f.pg.query('UPDATE auth_private.credentials SET all_hubs=false WHERE id=$1',[f.credential]);await f.pg.query('INSERT INTO auth_private.credential_hubs VALUES($1,$2,$3)',[f.credential,f.a,f.hub]);assert.equal((await f.download(broad.body.data.id,'bot')).response.status,403);
 const q=await f.queue('bot',undefined,parameters);assert.equal(q.response.status,202,JSON.stringify(q.body));assert.equal((await f.work()).outcome,'succeeded',JSON.stringify(f.errors));const file=await f.download(q.body.data.id,'bot');assert.equal(file.response.status,200);assert.doesNotMatch(file.body,/Account 2000/);
 const second=await f.queue('bot');assert.equal(second.response.status,202);await f.pg.query('UPDATE auth_private.credentials SET revoked_at=clock_timestamp() WHERE id=$1',[f.credential]);assert.equal((await f.work()).outcome,'cancelled',JSON.stringify(f.errors));assert.equal((await f.pg.query('SELECT count(*)::integer n FROM public.report_job_results')).rows[0].n,2);
});
test('two brief native report workers lease a queued generation only once',{skip:!process.env.TEST_DATABASE_URL},async()=>{
 const f=await fixture();try{const q=await f.queue();assert.equal(q.response.status,202);const started=performance.now(),results=await Promise.all([f.work(),f.work()]);assert.equal(results.filter(r=>r.claimed).length,1,JSON.stringify(f.errors));assert.ok(results.some(r=>r.recorded&&r.outcome==='succeeded'));assert.equal((await f.pg.query('SELECT * FROM public.report_job_results')).rows.length,1);console.log(JSON.stringify({measurement:'brief-report-worker-race',workers:2,elapsedMs:Math.ceil(performance.now()-started)}));}finally{await f.pg.close();}
});
async function boundaryAccounts(f:F,count:number){
 // Boundary fixture only,not a parallel load test. Seed valid synthetic chart
 // rows in one transaction;the actual loader/worker/API still run unchanged.
 const approval=(await f.pg.query<{approval_id:string}>('SELECT approval_id FROM public.finance_journals LIMIT 1')).rows[0].approval_id;await f.pg.exec('BEGIN');try{
 await f.pg.query('CREATE TEMP TABLE synthetic_queued_accounts AS SELECT gen_random_uuid() id,n FROM generate_series(1,$1::integer) n',[count]);await f.pg.query("INSERT INTO public.finance_accounts(academy_id,id,hub_id,currency_id,currency_version,code,created_by) SELECT $1,s.id,$2,$3,1,'Q'||lpad(s.n::text,5,'0'),$4 FROM synthetic_queued_accounts s",[f.a,f.hub,f.currency.id,f.actors.master.person]);
 await f.pg.query("INSERT INTO public.finance_account_revisions(academy_id,account_id,version,code,name,description,kind,normal_balance,active,changed_by,approval_id,reason) SELECT $1,s.id,1,'Q'||lpad(s.n::text,5,'0'),'Synthetic boundary account '||s.n,'','asset','debit',true,$2,$3,'One-row-beyond export boundary' FROM synthetic_queued_accounts s",[f.a,f.actors.master.person,approval]);await f.pg.exec('COMMIT');
 }catch(e){await f.pg.exec('ROLLBACK');throw e;}
}
test('one actual queued CSV completes the first row beyond the synchronous ceiling without partial totals',{skip:!process.env.TEST_DATABASE_URL},async()=>{
 const f=await fixture();try{await boundaryAccounts(f,1999);
 const immediate=await f.request('reports/finance/trial-balance/export?through=2026-12-31&includeZero=true',undefined,'staff');assert.equal(immediate.response.status,409);assert.equal(immediate.response.headers.get('content-disposition'),null);
 const q=await f.queue('staff',undefined,{through:'2026-12-31',includeZero:'true'});assert.equal(q.response.status,202);assert.equal((await f.work()).outcome,'succeeded',JSON.stringify(f.errors));const file=await f.download(q.body.data.id);assert.equal(file.response.status,200);const rows=parse(file.body,{columns:true,bom:true}) as Record<string,string>[];assert.equal(rows.filter(r=>r.section==='account').length,2001);assert.equal(rows.find(r=>r.section==='currency_total'&&r.field==='debit')?.amount,'100.00');assert.equal(rows.find(r=>r.section==='metadata'&&r.field==='accountCount')?.value,'2001');
 }finally{await f.pg.close();}
});
test('queued output beyond its own bound stops once with a useful limit error,not advice to queue again',{skip:!process.env.TEST_DATABASE_URL},async()=>{
 const f=await fixture();try{await boundaryAccounts(f,9999);const q=await f.queue('staff',undefined,{through:'2026-12-31',includeZero:'true'});assert.equal(q.response.status,202);const result=await f.work();assert.deepEqual(result,{claimed:true,recorded:true,outcome:'cancelled'});const state=(await f.state(q.body.data.id)).body.data;assert.equal(state.status,'cancelled');assert.equal(state.last_error,'REPORT_OUTPUT_LIMIT_EXCEEDED');assert.equal(state.attempts,1);assert.equal((await f.pg.query('SELECT * FROM public.report_job_results')).rows.length,0);assert.equal((await f.pg.query("SELECT * FROM public.audit_events WHERE action='report.generated'")).rows.length,0);assert.equal((await f.download(q.body.data.id)).response.status,409);assert.deepEqual(await f.work(),{claimed:false,recorded:false});}finally{await f.pg.close();}
});
test('actual separately compiled report daemon generates a stored CSV and stops cleanly',{skip:!process.env.TEST_DATABASE_URL},async()=>{
 const f=await fixture();let child:ReturnType<typeof spawn>|undefined,login:string|undefined;try{
 const q=await f.queue();assert.equal(q.response.status,202);login='kavosh_report_'+randomUUID().replaceAll('-','');const password='synthetic_only_'+randomUUID().replaceAll('-',''),db=(await f.pg.query<{name:string}>('SELECT current_database() name')).rows[0].name;assert.match(login,/^kavosh_report_[a-f0-9]{32}$/);assert.match(db,/^kavosh_test_[a-f0-9]{32}$/);
 await f.pg.exec(`CREATE ROLE ${login} LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '${password}';GRANT kavosh_automation_worker TO ${login}`);const url=new URL(process.env.TEST_DATABASE_URL!);url.username=login;url.password=password;url.pathname='/'+db;let output='';
 const command=process.env.REPORT_WORKER_COMPILED_ENTRY?[process.env.REPORT_WORKER_COMPILED_ENTRY]:['--import','tsx','scripts/process-reports.ts'];child=spawn(process.execPath,command,{cwd:process.cwd(),env:{PATH:process.env.PATH,NODE_ENV:'test',DATABASE_SSL_MODE:'disable',REPORT_WORKER_ENABLED:'true',REPORT_WORKER_DATABASE_URL:url.toString(),REPORT_WORKER_ACADEMIES:JSON.stringify([f.a])},stdio:['ignore','ignore','pipe']});child.stderr?.on('data',data=>output+=String(data).slice(0,2000));const exited=new Promise<number|null>(resolve=>child!.once('exit',resolve));
 let done=false;for(let n=0;n<100;n++){if((await f.pg.query<{status:string}>('SELECT status FROM public.report_jobs WHERE id=$1',[q.body.data.id])).rows[0].status==='succeeded'){done=true;break;}if(child.exitCode!==null)break;await delay(25);}assert.ok(done,'Report daemon did not complete: '+output);assert.equal((await f.download(q.body.data.id)).response.status,200);child.kill('SIGTERM');assert.equal(await Promise.race([exited,delay(2000,undefined,{ref:false}).then(()=>-1)]),0);assert.doesNotMatch(output,/postgresql:|synthetic_only_|password|token_hash/i);
 }finally{if(child&&child.exitCode===null){child.kill('SIGKILL');await new Promise(resolve=>child!.once('exit',resolve));}if(login)await f.pg.exec('DROP ROLE '+login);await f.pg.close();}
});
test('report daemon refuses disabled and shared-credential configurations without exposing supplied secrets',()=>{
 for(const extra of [{},{REPORT_WORKER_ENABLED:'true',MIGRATION_DATABASE_URL:'postgresql://not_used:synthetic_secret@127.0.0.1:1/not_used'}]){const child=spawnSync(process.execPath,['--import','tsx','scripts/process-reports.ts'],{cwd:process.cwd(),env:{PATH:process.env.PATH,NODE_ENV:'test',...extra},encoding:'utf8',timeout:3000});assert.equal(child.status,1,child.stderr);assert.match(child.stderr,/Report worker stopped/);assert.doesNotMatch(child.stderr,/synthetic_secret|postgresql:|not_used|password/);}
});
test('schema130 preserves actual schema129 report configurations without inventing generated jobs or outputs',async()=>{
 const f=await operationsFixture({throughSchema:129});try{const saved=await f.request('reports/presets',{anchor:{kind:'hub',id:f.hub},definition:{name:'Before report queue',reportId:'finance.trial-balance',parameters:{through:'2026-12-31'}},reason:'Actual preupgrade configuration'});assert.equal(saved.response.status,201,JSON.stringify(saved.body));const before=(await f.pg.query('SELECT * FROM public.report_preset_revisions')).rows;await f.pg.exec(await readFile(new URL('../db/migrations/130_report_jobs.sql',import.meta.url),'utf8'));assert.deepEqual((await f.pg.query('SELECT * FROM public.report_preset_revisions')).rows,before);assert.equal((await f.pg.query('SELECT * FROM public.report_jobs')).rows.length,0);assert.equal((await f.pg.query('SELECT * FROM public.report_job_results')).rows.length,0);}finally{await f.pg.close();}
});
