import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { reportSpreadsheet,spreadsheetMime } from '../src/reports/spreadsheet.ts';
import { spreadsheetContracts,reportSpreadsheets } from '../src/modules/report-spreadsheets.ts';
import { businessContract } from '../src/modules/business.ts';
import { csvRow } from '../src/core/csv.ts';
import { spreadsheetRows } from './spreadsheet-reader.ts';
import type { ApiContext } from '../src/core/api.ts';

const signal=()=>new AbortController().signal;
test('actual worker workbook keeps exact text, money, Unicode, blanks and OOXML escape literals without formulas or external links',async()=>{
 const rows=[['identifier','amount','currency','notes','blank'],['000123','123456789012345678901234567890.12','CAD','费用 — frais 🤖\r\n next\tline',''],['=HYPERLINK("https://invalid.test")','-0.001','USD','_x000D_ _x005F_ <>&"',''],['+1','0','JPY','  keep spaces  ','']];
 const bytes=await reportSpreadsheet('\uFEFF'+rows.map(row=>csvRow(row)).join('\r\n')+'\r\n',randomUUID(),signal());
 const actual=spreadsheetRows(bytes);for(const [i,row]of rows.entries()){while(actual[i].length<row.length)actual[i].push('');assert.deepEqual(actual[i],row);}
 assert.equal(actual.length,rows.length);assert.ok(bytes.byteLength<20_000);
});
test('spreadsheet conversion refuses malformed, oversized, excessive or lossy cells rather than returning a partial workbook',async()=>{
 for(const source of ['a,b\n1','a\n"unclosed',''])await assert.rejects(reportSpreadsheet(source,randomUUID(),signal()),{code:'SPREADSHEET_EXPORT_UNAVAILABLE'});
 for(const source of ['a\n'+ 'x'.repeat(32_768),'a\n\u0000','a\n\uFFFD','a\n\uD800',Array(258).fill('column').join(','),Array(20_003).fill('a').join('\n'),Array(1002).fill(Array(100).fill('a').join(',')).join('\n')])await assert.rejects(reportSpreadsheet(source,randomUUID(),signal()),{code:'SPREADSHEET_REQUIRES_CSV',status:422});
 await assert.rejects(reportSpreadsheet('a'.repeat(4_194_305),randomUUID(),signal()),{code:'SPREADSHEET_SOURCE_TOO_LARGE'});
 const bytes=await reportSpreadsheet('a\n'+ 'x'.repeat(32_767),randomUUID(),signal());assert.equal(spreadsheetRows(bytes)[1][0].length,32_767);
});
test('worker admission, cancellation and actual exit settlement release capacity for later exports',async()=>{
 const principal=randomUUID(),cancel=new AbortController(),first=reportSpreadsheet('a\nb',principal,cancel.signal);
 await assert.rejects(reportSpreadsheet('a\nb',principal,signal()),{code:'SPREADSHEET_EXPORT_BUSY'});
 const second=reportSpreadsheet('a\nb',randomUUID(),signal());
 await assert.rejects(reportSpreadsheet('a\nb',randomUUID(),signal()),{code:'SPREADSHEET_EXPORT_BUSY'});
 cancel.abort();await assert.rejects(first,{code:'SPREADSHEET_EXPORT_ABORTED'});await second;
 assert.deepEqual(spreadsheetRows(await reportSpreadsheet('a\nb',principal,signal())),[['a'],['b']]);
 await assert.rejects(reportSpreadsheet('a\nb',principal,cancel.signal),{code:'SPREADSHEET_EXPORT_ABORTED'});
});
test('only registered report CSV paths gain Excel aliases and aliases retain source query and human restrictions',async()=>{
 const aliases=businessContract.filter(c=>'responseContentType'in c&&c.responseContentType===spreadsheetMime),sources=businessContract.filter(c=>'responseContentType'in c&&c.responseContentType==='text/csv'&&c.path.startsWith('/api/v1/reports/')&&(c.path.endsWith('/export')||c.path==='/api/v1/reports/jobs/{id}/download'));
 assert.ok(aliases.length>20);assert.equal(aliases.length,sources.length);assert.equal(new Set(aliases.map(c=>c.path)).size,aliases.length);
 for(const source of sources){const alias=aliases.find(c=>c.path===source.path+'.xlsx')!;assert.ok(alias);assert.equal('querySchema'in alias?alias.querySchema:null,'querySchema'in source?source.querySchema:null);assert.equal('humanOnly'in alias?alias.humanOnly:null,'humanOnly'in source?source.humanOnly:null);}
 const fake=[{path:'/api/v1/reports/presets/{id}/export',method:'get',summary:'Source',responseContentType:'text/csv',humanOnly:true}];
 assert.equal(spreadsheetContracts(fake)[0].humanOnly,true);
 const path='reports/presets/'+randomUUID()+'/export.xlsx',request=new Request('https://school.example/api/v1/'+path+'?through=2026-12-31',{headers:{'x-academy-id':'same-school'}}),ctx={path,request} as ApiContext;
 let calls=0;const reply=await reportSpreadsheets(ctx,fake,async inner=>{calls++;assert.equal(inner.path,path.slice(0,-5));assert.equal(new URL(inner.request.url).search,'?through=2026-12-31');assert.equal(inner.request.headers.get('x-academy-id'),'same-school');return {status:200,body:'a\nb',csv:{filename:'report.csv'}};});
 assert.deepEqual(reply,{status:200,body:'a\nb',xlsx:{filename:'report.xlsx'}});assert.equal(calls,1);
 assert.equal(await reportSpreadsheets({...ctx,path:'reports/unregistered/export.xlsx'},fake,async()=>{throw Error('must not run');}),null);
 assert.equal(await reportSpreadsheets({...ctx,request:new Request(request,{method:'POST'})},fake,async()=>{throw Error('must not run');}),null);
 await assert.rejects(reportSpreadsheets(ctx,fake,async()=>({status:200,body:'not csv'})),{code:'SPREADSHEET_SOURCE_UNAVAILABLE'});
 const multipart={status:409,body:{error:{code:'REPORT_MULTIPART_DOWNLOAD_REQUIRED'},partsPath:'/api/v1/reports/jobs/example/parts'}};assert.deepEqual(await reportSpreadsheets(ctx,fake,async()=>multipart),multipart);
 assert.ok(!aliases.some(c=>c.path.includes('/parts/')));
});
