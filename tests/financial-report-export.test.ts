import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { parse } from 'csv-parse/sync';
import { operationsFixture } from './operations-fixture.ts';
import { financialReportCsv,financialExportEntryLimit } from '../src/modules/financial-report-export.ts';
import type { Connection } from '../src/core/database.ts';
import { parseMoney,formatMoneyTotal } from '../src/core/money.ts';

function decoded(body:string):Record<string,string>[] {return parse(body,{columns:true,bom:true,relax_column_count:false,skip_empty_lines:false});}
const metadata=(rows:Record<string,string>[])=>Object.fromEntries(rows.filter(r=>r.section==='metadata').map(r=>[r.field,r.value]));
async function fixture(){const f=await operationsFixture();try{
 for(const role of [f.staffRole,f.managerRole])for(const cap of ['financial-reports.view','accounts.view','ledger.view','report-presets.view','report-presets.edit'])await f.pg.query("INSERT INTO public.role_permissions VALUES($1,$2,$3,'allow')",[f.a,role,cap]);
 const made=async(path:string,body:unknown)=>{const r=await f.request(path,body);assert.equal(r.response.status,201,JSON.stringify(r.body));return r.body.data;};
 const currency=await made('finance/currencies',{code:'CAD',name:'Canadian dollar',unitScale:2,reason:'Export test currency'}),period=await made('finance/periods',{name:'Export year',startsOn:'2026-01-01',endsOn:'2026-12-31',reason:'Export test period'});
 const account=(code:string,kind='asset',name='Account '+code,hubId=f.hub)=>made('finance/accounts',{code,name,kind,hubId,currencyId:currency.id,currencyVersion:1,reason:'Actual export source account'}),cash=await account('1000','asset','=SUM(1,2)\n"费用 — frais"'),expense=await account('5000','expense'),income=await account('4000','income');
 const post=(amount='100.00')=>f.request('finance/journals',{periodId:period.id,periodVersion:1,postedOn:'2026-06-01',purpose:'activity',description:'PRIVATE journal header',reason:'Actual export source',lines:[{accountId:cash.id,accountVersion:1,side:'debit',amount,note:'PRIVATE line note'},{accountId:income.id,accountVersion:1,side:'credit',amount}]});
 assert.equal((await post()).response.status,201);const download=(report='trial-balance',patch:Record<string,string>={},as='master',options:Parameters<typeof f.request>[3]={})=>f.request('reports/finance/'+report+'/export?'+new URLSearchParams({through:'2026-12-31',...report==='profit-loss'?{from:'2026-01-01'}:{},...patch}),undefined,as,options);
 return {...f,made,account,currency,period,cash,expense,income,post,download};
 }catch(error){await f.pg.close();throw error;}}
test('actual financial attachments keep exact totals,balanced equations,formula-safe Unicode names and original private-source boundaries',async()=>{
 const f=await fixture();try{
  const counts=(await f.pg.query('SELECT count(*)::integer n FROM public.finance_journals')).rows[0].n;
  for(const report of ['trial-balance','profit-loss','balance-sheet']){const result=await f.download(report);assert.equal(result.response.status,200,JSON.stringify(result.body));assert.match(result.response.headers.get('content-type')??'',/^text\/csv; charset=utf-8$/);assert.equal(result.response.headers.get('cache-control'),'no-store');assert.match(result.response.headers.get('content-security-policy')??'',/sandbox/);const rows=decoded(result.body),meta=metadata(rows);assert.equal(meta.exportCompleteness,'complete_permitted_report_within_limits');assert.equal(meta.currencyConversion,'none');assert.equal(meta.coverage,'complete_selected_currencies');assert.equal(meta.scopeMayOmitCounterparties,'false');assert.doesNotMatch(result.body,/PRIVATE journal header|PRIVATE line note/);
   if(report==='trial-balance'){assert.equal(rows.find(r=>r.section==='account'&&r.account_id===f.cash.id)?.account_name,'text: =SUM(1,2)\n"费用 — frais"');assert.equal(rows.find(r=>r.section==='currency_total'&&r.field==='debit')?.amount,'100.00');assert.equal(rows.find(r=>r.section==='currency_total'&&r.field==='credit')?.amount_minor,'10000');}
   else if(report==='profit-loss'){assert.equal(rows.find(r=>r.section==='currency_total'&&r.field==='netResult')?.amount,'100.00');assert.equal(meta.journalPurposeTreatment,'activity_and_legacy_excluding_opening_closing');assert.equal(meta.requiresPurposeReview,'false');}
   else assert.equal(rows.find(r=>r.section==='currency_status'&&r.field==='balanced')?.value,'true');
  }
  assert.equal((await f.request('finance/accounts/'+f.cash.id)).body.data.name,'=SUM(1,2)\n"费用 — frais"');assert.equal((await f.pg.query('SELECT count(*)::integer n FROM public.finance_journals')).rows[0].n,counts);
 }finally{await f.pg.close();}
});
test('complete export is not the interactive page and invalid pagination or duplicate parameters never produce attachments',async()=>{
 const f=await fixture();try{
  for(let i=0;i<49;i++)await f.account('A'+String(i).padStart(3,'0'));const normal=await f.request('reports/finance/trial-balance?through=2026-12-31&includeZero=true&limit=1');assert.equal(normal.body.data.accountCount,52);assert.equal(normal.body.data.entries.length,1);assert.ok(normal.body.nextCursor);
  const result=await f.download('trial-balance',{includeZero:'true'});assert.equal(result.response.status,200,JSON.stringify(result.body));const rows=decoded(result.body);assert.equal(rows.filter(r=>r.section==='account').length,52);assert.equal(metadata(rows).accountCount,'52');
  const invalid:Record<string,string>[]=[{limit:'1'},{afterId:randomUUID()},{snapshot:'x'},{through:'bad'},{send:'true'}];for(const patch of invalid){const bad=await f.download('trial-balance',patch);assert.equal(bad.response.status,400,JSON.stringify(patch));assert.equal(bad.response.headers.get('content-disposition'),null);}
  const duplicate=await f.request('reports/finance/trial-balance/export?through=2026-12-31&through=2026-01-01');assert.equal(duplicate.response.status,400);assert.equal((await f.download('trial-balance',{},'master',{method:'POST'})).response.status,405);
 }finally{await f.pg.close();}
});
test('downloads and saved-config exports recheck source authority and report format rather than borrowing owner permissions',async()=>{
 const f=await fixture();try{
  const saved=await f.made('reports/presets',{anchor:{kind:'hub',id:f.hub},definition:{name:'Saved financial export',reportId:'finance.trial-balance',parameters:{through:'2026-12-31',limit:'1'}},reason:'Export all results,not the saved page size'}),path='reports/presets/'+saved.id+'/export';
  const fromPreset=await f.request(path,undefined,'staff');assert.equal(fromPreset.response.status,200,JSON.stringify(fromPreset.body));const rows=decoded(fromPreset.body);assert.equal(rows.filter(r=>r.section==='account').length,2);assert.equal(metadata(rows).presetId,saved.id);assert.equal(metadata(rows).presetVersion,'1');assert.equal(metadata(rows).coverage,'scoped_selected_accounts');
  const catalog=await f.request('reports/catalogue'),expected=['community.achievements','finance.balance-sheet','finance.outlook','finance.profit-loss','finance.trial-balance','payroll.gross-accruals','payroll.remittances','payroll.settlements'];assert.deepEqual(catalog.body.data.filter((r:{formats:string[]})=>r.formats.includes('csv')).map((r:{id:string})=>r.id).sort(),expected);assert.deepEqual(catalog.body.data.filter((r:{backgroundJobFormats:string[]})=>r.backgroundJobFormats.includes('csv')).map((r:{id:string})=>r.id).sort(),expected.filter(id=>!['finance.outlook','payroll.remittances'].includes(id)));
  await f.pg.query("DELETE FROM public.role_permissions WHERE role_id=$1 AND capability='ledger.view'",[f.staffRole]);for(const result of [await f.download('trial-balance',{},'staff'),await f.request(path,undefined,'staff')]){assert.equal(result.response.status,403);assert.equal(result.response.headers.get('content-disposition'),null);}
  const foreign=await f.download('trial-balance',{},'foreignMaster',{academy:f.b});assert.equal(foreign.response.status,200);assert.equal(metadata(decoded(foreign.body)).accountCount,'0');assert.doesNotMatch(foreign.body,new RegExp(f.cash.id));
  const other=await f.made('reports/presets',{anchor:{kind:'hub',id:f.hub},definition:{name:'Inventory configuration',reportId:'inventory.stock',parameters:{on:'2026-12-31',timeZone:'America/Toronto'}},reason:'Unavailable CSV must be explicit'});assert.equal((await f.request('reports/presets/'+other.id+'/export')).body.error.code,'REPORT_FORMAT_NOT_AVAILABLE');
  await f.pg.query("UPDATE public.academies SET status='read_only' WHERE id=$1",[f.a]);assert.equal((await f.download()).response.status,200);
 }finally{await f.pg.close();}
});
test('missing rows never become a seemingly complete CSV and oversized data fails without a partial file',()=>{
 const accountId=randomUUID(),currencyId=randomUUID(),zero={minor:'0',amount:'0.00'},entry={accountId,chartVersion:1,hubId:randomUUID(),code:'1000',name:'Name',kind:'asset',currencyId,currencyCode:'CAD',unitScale:2,closing:zero,debit:zero,credit:zero},data={report:'posted_trial_balance',through:'2026-12-31',snapshotAt:'2026-11-06 12:00+00',coverage:'scoped_selected_accounts',scopeMayOmitCounterparties:true,currencyConversion:'none',postingBasis:'all_posted_account_lines',accountCount:1,currencies:[],entries:[entry]};
 assert.throws(()=>financialReportCsv({...data,accountCount:2}),/REPORT_REQUIRES_BACKGROUND_JOB/);assert.throws(()=>financialReportCsv({...data,accountCount:financialExportEntryLimit+1,entries:Array(financialExportEntryLimit+1).fill(entry)}),/REPORT_REQUIRES_BACKGROUND_JOB/);
 const huge={minor:'9'.repeat(250),amount:'9'.repeat(250)+'.00'},large={...entry,name:'测'.repeat(200),closing:huge,debit:huge,credit:huge};assert.throws(()=>financialReportCsv({...data,accountCount:financialExportEntryLimit,entries:Array(financialExportEntryLimit).fill(large)}),/REPORT_REQUIRES_BACKGROUND_JOB/);
});
test('actual negative long money stays exact text and is never mistaken for untrusted formula-like text',async()=>{
 const f=await fixture();try{
  const amount='123456789012345678901234567890.12';await f.made('finance/journals',{periodId:f.period.id,periodVersion:1,postedOn:'2026-06-02',purpose:'activity',description:'PRIVATE adjustment',reason:'Exact signed export test',lines:[{accountId:f.cash.id,accountVersion:1,side:'credit',amount},{accountId:f.income.id,accountVersion:1,side:'debit',amount}]});
  const value=10000n-parseMoney(amount,2),result=await f.download(),cash=decoded(result.body).find(r=>r.section==='account'&&r.account_id===f.cash.id);assert.equal(result.response.status,200);assert.equal(cash?.closing_minor,value.toString());assert.equal(cash?.closing_amount,formatMoneyTotal(value,2));assert.match(cash?.closing_amount??'',/^-/);assert.doesNotMatch(cash?.closing_amount??'',/^text:/);
 }finally{await f.pg.close();}
});
test('native concurrent posting cannot mix report rows and totals from different database snapshots',{skip:!process.env.TEST_DATABASE_URL},async()=>{
 const f=await fixture();let resume!:()=>void,reached!:()=>void;const gate=new Promise<void>(resolve=>resume=resolve),captured=new Promise<void>(resolve=>reached=resolve);let exporting:ReturnType<typeof f.download>|undefined;try{
  const runtime=f.pg.runtime!;const connect=runtime.connect.bind(runtime);let reportQueries=0;runtime.connect=async()=>{const c=await connect();return {async query<Row>(sql:string,params?:unknown[]){const r=await c.query<Row>(sql,params);if(sql.startsWith('WITH selected AS MATERIALIZED')){reportQueries++;reached();await gate;}return r;},release(destroy?:boolean){c.release(destroy);}} as Connection;};
  exporting=f.download();await Promise.race([captured,new Promise<never>((_,reject)=>setTimeout(()=>reject(new Error('REPORT_DID_NOT_READ')),2000).unref())]);assert.equal((await f.post('50.00')).response.status,201);resume();const result=await exporting;assert.equal(result.response.status,200,JSON.stringify(result.body));const rows=decoded(result.body);assert.equal(rows.find(r=>r.section==='currency_total'&&r.field==='debit')?.amount,'100.00');assert.equal(rows.find(r=>r.section==='account'&&r.account_id===f.cash.id)?.debit_amount,'100.00');assert.equal(reportQueries,1);const current=await f.request("reports/finance/trial-balance?through=2026-12-31");assert.equal(current.response.status,200);assert.equal(current.body.data.entries.find((e:{accountId:string})=>e.accountId===f.cash.id).debit.amount,"150.00");
 }finally{resume();await Promise.allSettled([exporting].filter(Boolean));await f.pg.close();}
});
