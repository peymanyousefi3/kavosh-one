import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { Temporal } from '@js-temporal/polyfill';
import { parse } from 'csv-parse/sync';
import { reportDateWindow,resolveReportWindow,reportWindowParameters } from '../src/core/report-window.ts';
import { reportConfiguration,configuredReportContext } from '../src/modules/report-catalogue.ts';
import { operationsFixture } from './operations-fixture.ts';
import { historicalReportJob } from './historical-report-job.ts';

const window=(kind:string,patch:Record<string,unknown>={})=>reportDateWindow.parse({kind,timeZone:'America/Toronto',...patch});
test('civil calendar windows have explicit inclusive bounds across leap years,quarters,week starts,DST and international midnight',()=>{
 const cases:[string,string,string,string,Record<string,unknown>?][]=[
  ['today','2026-01-01T00:30:00Z','2025-12-31','2025-12-31'],['yesterday','2024-03-01T12:00:00Z','2024-02-29','2024-02-29'],
  ['week_to_date','2026-11-08T12:00:00Z','2026-11-02','2026-11-08'],['previous_week','2026-11-08T12:00:00Z','2026-10-26','2026-11-01'],
  ['week_to_date','2026-11-08T12:00:00Z','2026-11-08','2026-11-08',{weekStartsOn:7}],
  ['month_to_date','2024-03-01T01:00:00Z','2024-02-01','2024-02-29'],['previous_month','2024-03-15T12:00:00Z','2024-02-01','2024-02-29'],
  ['quarter_to_date','2026-04-01T01:00:00Z','2026-01-01','2026-03-31'],['previous_quarter','2026-01-15T12:00:00Z','2025-10-01','2025-12-31'],
  ['year_to_date','2026-01-01T00:30:00Z','2025-01-01','2025-12-31'],['previous_year','2025-06-01T12:00:00Z','2024-01-01','2024-12-31'],
  ['last_days','2026-03-09T04:30:00Z','2026-03-07','2026-03-09',{days:3}],['next_days','2026-10-31T12:00:00Z','2026-10-31','2026-11-02',{days:3}],
  ['today','2026-12-31T18:00:00Z','2027-01-01','2027-01-01',{timeZone:'Asia/Shanghai'}]
 ];
 for(const [kind,at,from,through,patch]of cases){const resolved=resolveReportWindow(window(kind,patch),at);assert.deepEqual([resolved.from,resolved.through],[from,through],JSON.stringify({kind,at,patch}));assert.equal(resolved.interval,'inclusive_civil_days');assert.equal(resolved.calendar,'iso8601');}
 for(const raw of [{kind:'last_days'},{kind:'next_days',days:0},{kind:'today',days:1},{kind:'today',weekStartsOn:0},{kind:'today',timeZone:'+04:00'},{kind:'today',timeZone:'Invalid/TimeZone'},{kind:'today',clock:'client supplied'}])assert.equal(reportDateWindow.safeParse({timeZone:'UTC',...raw}).success,false);
});
test('registered date mappings preserve original query validators,strip only generated fields and refuse competing static dates',()=>{
 const w=window('previous_month'),p=reportConfiguration('finance.profit-loss',{}, {},w);assert.deepEqual(p.parameters,{limit:'50'});assert.deepEqual(p.dateWindow,w);
 assert.deepEqual(reportConfiguration('finance.trial-balance',{through:'2026-12-31'},{}),{reportId:'finance.trial-balance',queryContractVersion:1,parameters:{through:'2026-12-31',includeZero:'false',limit:'50'},pathParameters:{}});
 for(const id of ['finance.trial-balance','finance.balance-sheet','finance.receivables-aging','finance.payables-aging','payroll.gross-accruals','inventory.stock','payroll.scheduled-costs','payroll.recorded-time'])assert.ok(reportConfiguration(id,{}, {},w).dateWindow);
 assert.ok(reportConfiguration('finance.outlook',{}, {},window('next_days',{days:31})).dateWindow);for(const kind of ['today','yesterday','week_to_date','month_to_date','quarter_to_date','year_to_date'])assert.throws(()=>reportConfiguration('finance.outlook',{}, {},window(kind)),/REPORT_DATE_WINDOW_REQUIRES_MULTIPLE_DAYS/);assert.throws(()=>reportConfiguration('finance.outlook',{}, {},window('next_days',{days:1})),/REPORT_DATE_WINDOW_REQUIRES_MULTIPLE_DAYS/);
 assert.ok(reportConfiguration('finance.bank-reconciliation',{accountId:randomUUID()}, {},w).dateWindow);
 assert.throws(()=>reportConfiguration('finance.profit-loss',{from:'2026-01-01'}, {},w),/REPORT_DATE_WINDOW_CONFLICT/);assert.throws(()=>reportConfiguration('inventory.stock',{timeZone:'Asia/Shanghai'}, {},w),/REPORT_TIME_ZONE_CONFLICT/);
 assert.throws(()=>reportConfiguration('learning.polls.by-id',{}, {id:randomUUID()},w),/REPORT_DATE_WINDOW_UNSUPPORTED/);
 assert.deepEqual(reportWindowParameters('finance.trial-balance',w,'2024-03-15T12:00:00Z').parameters,{through:'2024-02-29'});
 assert.deepEqual(reportWindowParameters('inventory.stock',w,'2024-03-15T12:00:00Z').parameters,{on:'2024-02-29',timeZone:'America/Toronto'});
 assert.throws(()=>configuredReportContext({} as Parameters<typeof configuredReportContext>[0],p),/REPORT_DATE_WINDOW_CLOCK_REQUIRED/);
});
async function fixture(){const f=await operationsFixture();try{
 for(const role of [f.staffRole,f.managerRole])for(const cap of ['report-presets.view','report-presets.edit','financial-reports.view','accounts.view','ledger.view'])await f.pg.query("INSERT INTO public.role_permissions VALUES($1,$2,$3,'allow')",[f.a,role,cap]);
 const made=async(path:string,body:unknown)=>{const r=await f.request(path,body);assert.equal(r.response.status,201,JSON.stringify(r.body));return r.body.data;};
 const clock=(await f.pg.query<{instant:string}>(`SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') instant`)).rows[0].instant,today=Temporal.Instant.from(clock).toZonedDateTimeISO('America/Toronto').toPlainDate(),year=today.year;
 const currency=await made('finance/currencies',{code:'CAD',name:'Canadian dollar',unitScale:2,reason:'Relative date test'}),period=await made('finance/periods',{name:'Current test year',startsOn:`${year}-01-01`,endsOn:`${year}-12-31`,reason:'Actual clock-based test year'});
 const accounts=[];for(const [code,kind]of [['1000','asset'],['4000','income']])accounts.push(await made('finance/accounts',{code,name:'Relative '+code,kind,hubId:f.hub,currencyId:currency.id,currencyVersion:1,reason:'Relative report source'}));
 await made('finance/journals',{periodId:period.id,periodVersion:1,postedOn:today.toString(),purpose:'activity',description:'PRIVATE relative source',reason:'Actual source on the database local date',lines:[{accountId:accounts[0].id,accountVersion:1,side:'debit',amount:'100.00'},{accountId:accounts[1].id,accountVersion:1,side:'credit',amount:'100.00'}]});
 const input={anchor:{kind:'hub',id:f.hub},definition:{name:'Current monthly result',reportId:'finance.profit-loss',parameters:{},dateWindow:{kind:'month_to_date',timeZone:'America/Toronto'}},reason:'Reusable live civil date window'};
 return {...f,made,today,input};
 }catch(error){await f.pg.close();throw error;}}
test('reviewed relative preset runs and exports actual database-clock data without saving resolved dates or granting source rights',async()=>{
 const f=await fixture();try{const saved=await f.made('reports/presets',f.input),id=saved.id;assert.deepEqual(saved.definition.parameters,{limit:'50'});assert.equal(saved.definition.dateWindow.weekStartsOn,1);const before=(await f.pg.query('SELECT definition FROM public.report_preset_revisions WHERE preset_id=$1',[id])).rows;
 const run=await f.request('reports/presets/'+id+'/run',undefined,'staff');assert.equal(run.response.status,200,JSON.stringify(run.body));assert.equal(run.body.data.through,f.today.toString());assert.equal(run.body.data.from,f.today.with({day:1}).toString());assert.equal(run.body.data.currencies[0].netResult.amount,'100.00');assert.equal(run.body.resolvedDateWindow.window.timeZone,'America/Toronto');assert.ok(Temporal.Instant.from(run.body.resolvedDateWindow.resolvedAt));
 const csv=await f.request('reports/presets/'+id+'/export',undefined,'staff');assert.equal(csv.response.status,200,JSON.stringify(csv.body));const rows=parse(csv.body,{columns:true,bom:true}) as Record<string,string>[],meta=Object.fromEntries(rows.filter(r=>r.section==='metadata').map(r=>[r.field,r.value]));assert.equal(meta.dateWindowTimeZone,'America/Toronto');assert.equal(meta.dateWindowKind,'month_to_date');assert.equal(meta.presetId,id);assert.doesNotMatch(csv.body,/PRIVATE relative source/);
 const override=await f.request('reports/presets/'+id+'/run?through='+f.today.subtract({days:1}).toString(),undefined,'staff');if(f.today.day>1){assert.equal(override.response.status,200,JSON.stringify(override.body));assert.deepEqual(override.body.resolvedDateWindow.overriddenFields,['through']);assert.equal(override.body.resolvedDateWindow.effectiveParameters.through,f.today.subtract({days:1}).toString());}else assert.equal(override.response.status,400);
 assert.deepEqual((await f.pg.query('SELECT definition FROM public.report_preset_revisions WHERE preset_id=$1',[id])).rows,before);await f.pg.query("DELETE FROM public.role_permissions WHERE role_id=$1 AND capability='ledger.view'",[f.staffRole]);assert.equal((await f.request('reports/presets/'+id+'/run',undefined,'staff')).response.status,403);assert.equal((await f.request('reports/presets/'+id+'/export',undefined,'staff')).response.status,403);
 }finally{await f.pg.close();}
});
test('relative presets still need upper review and copies preserve date rules while starting disabled',async()=>{
 const f=await fixture();try{const pending=await f.request('reports/presets',f.input,'staff');assert.equal(pending.response.status,202,JSON.stringify(pending.body));const approved=await f.request('approvals/'+pending.body.approval.id+'/decide',{expectedVersion:1,decision:'approve',reason:'Approve reusable date rule'},'manager');assert.equal(approved.response.status,200,JSON.stringify(approved.body));const id=approved.body.data.id,copy=await f.request('reports/presets/'+id+'/duplicate',{expectedSourceVersion:1,anchor:{kind:'hub',id:f.hub},name:'Copied relative window',reason:'Independent date-rule preset'});assert.equal(copy.response.status,201,JSON.stringify(copy.body));assert.deepEqual(copy.body.data.definition.dateWindow,approved.body.data.definition.dateWindow);assert.equal(copy.body.data.definition.active,false);assert.equal((await f.request('reports/presets/'+copy.body.data.id+'/run')).response.status,409);
 }finally{await f.pg.close();}
});
test('one retained preset crosses local month/year midnight without client clocks or changed revisions',{skip:!process.env.TEST_DATABASE_URL},async()=>{
 const f=await fixture();try{const saved=await f.made('reports/presets',f.input),runtime=f.pg.runtime!,connect=runtime.connect.bind(runtime);let at='2026-01-01T00:30:00Z',clocks=0;runtime.connect=async()=>{const c=await connect();return {async query<Row>(sql:string,params?:unknown[]){if(sql.startsWith("SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC'")){clocks++;return {rows:[{instant:at}] as Row[]};}return c.query<Row>(sql,params);},release(destroy?:boolean){c.release(destroy);}};};
 const old=await f.request('reports/presets/'+saved.id+'/run');assert.equal(old.response.status,200,JSON.stringify(old.body));assert.deepEqual([old.body.data.from,old.body.data.through],['2025-12-01','2025-12-31']);at='2026-01-01T06:00:00Z';const next=await f.request('reports/presets/'+saved.id+'/run');assert.equal(next.response.status,200,JSON.stringify(next.body));assert.deepEqual([next.body.data.from,next.body.data.through],['2026-01-01','2026-01-01']);assert.equal(clocks,2);assert.equal((await f.request('reports/presets/'+saved.id)).body.data.latestVersion,1);
 assert.equal((await f.request('reports/presets/'+saved.id+'/run?at=2025-01-01T00%3A00%3A00Z')).response.status,400);
 }finally{await f.pg.close();}
});
test('native relative-definition guard rejects forged clock rules,conflicting dates and unsupported report date fields',async()=>{
 const f=await fixture();try{const saved=await f.made('reports/presets',f.input),d=saved.definition;for(const patch of [{dateWindow:{...d.dateWindow,days:3}},{dateWindow:{...d.dateWindow,weekStartsOn:0}},{dateWindow:{...d.dateWindow,timeZone:'Invalid/Zone'}},{parameters:{...d.parameters,through:'2026-01-01'}},{reportId:'learning.polls.by-id',pathParameters:{id:randomUUID()}},{dateWindow:null}])assert.equal((await f.pg.query<{valid:boolean}>('SELECT public.report_preset_definition_valid($1::jsonb) valid',[JSON.stringify({...d,...patch})])).rows[0].valid,false,JSON.stringify(patch));
 }finally{await f.pg.close();}
});
test('schema131 retains real schema130 absolute presets and queued jobs,keeps validator identity and does not invent date windows',async()=>{
 const f=await operationsFixture({throughSchema:130});try{const input={anchor:{kind:'hub',id:f.hub},definition:{name:'Old absolute dates',reportId:'finance.trial-balance',parameters:{through:'2026-12-31'}},reason:'Real preupgrade definition'},saved=await f.request('reports/presets',input);assert.equal(saved.response.status,201,JSON.stringify(saved.body));await historicalReportJob(f);const defs=(await f.pg.query('SELECT * FROM public.report_preset_revisions')).rows,jobs=(await f.pg.query('SELECT * FROM public.report_jobs')).rows,oid=(await f.pg.query("SELECT 'public.report_preset_definition_valid(jsonb)'::regprocedure::oid oid")).rows[0].oid;
 await f.pg.exec(await readFile(new URL('../db/migrations/131_report_date_windows.sql',import.meta.url),'utf8'));assert.deepEqual((await f.pg.query('SELECT * FROM public.report_preset_revisions')).rows,defs);assert.deepEqual((await f.pg.query('SELECT * FROM public.report_jobs')).rows,jobs);assert.equal((await f.pg.query("SELECT 'public.report_preset_definition_valid(jsonb)'::regprocedure::oid oid")).rows[0].oid,oid);
 const next=await f.request('reports/presets',{...input,definition:{...input.definition,parameters:{},dateWindow:{kind:'today',timeZone:'UTC'}}});assert.equal(next.response.status,201,JSON.stringify(next.body));assert.equal(next.body.data.definition.dateWindow.kind,'today');assert.equal((await f.request('reports/presets/'+saved.body.data.id+'/run')).response.status,200);
 }finally{await f.pg.close();}
});
