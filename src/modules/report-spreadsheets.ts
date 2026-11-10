import type { ApiContext,Reply } from '../core/api.ts';
import { ApiError } from '../core/policy.ts';
import { spreadsheetMime } from '../reports/spreadsheet.ts';
import type { z } from 'zod';

type Contract={method:string;path:string;summary:string;responseContentType?:string;querySchema?:z.ZodType;humanOnly?:boolean;pathSchemas?:Record<string,z.ZodType>};
export function spreadsheetContracts(contracts:readonly Contract[]) {
  return contracts.filter(c=>c.method==='get'&&c.path.startsWith('/api/v1/reports/')&&c.path.endsWith('/export')&&c.responseContentType?.startsWith('text/csv')).map(c=>({...c,method:'get' as const,path:c.path+'.xlsx',responseContentType:spreadsheetMime,summary:'Complete text-only Excel workbook from the same protected CSV report; exact money and identifiers remain text, current permissions and full export limits apply. '+c.summary}));
}
export async function reportSpreadsheets(ctx:ApiContext,contracts:readonly Contract[],run:(ctx:ApiContext)=>Promise<Reply|null>):Promise<Reply|null> {
  if(!ctx.path.endsWith('/export.xlsx'))return null;
  const sourcePath=ctx.path.slice(0,-5),fullPath='/api/v1/'+sourcePath;
  const registered=spreadsheetContracts(contracts).some(c=>new RegExp('^'+c.path.slice(0,-5).split(/(\{[^}]+\})/).map(part=>part.startsWith('{')?'[^/]+':part.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('')+'$').test(fullPath));
  if(!registered||ctx.request.method!=='GET')return null;
  const url=new URL(ctx.request.url);url.pathname=url.pathname.slice(0,-5);
  const reply=await run({...ctx,path:sourcePath,request:new Request(url,{method:'GET',headers:ctx.request.headers,signal:ctx.request.signal})});
  if(!reply||reply.status!==200||!reply.csv||reply.xlsx||reply.video||typeof reply.body!=='string'||!/^[-a-z0-9_.]{1,160}\.csv$/.test(reply.csv.filename))throw new ApiError(503,'SPREADSHEET_SOURCE_UNAVAILABLE');
  if(Buffer.byteLength(reply.body)>4_194_304)throw new ApiError(413,'SPREADSHEET_SOURCE_TOO_LARGE');
  return {status:200,body:reply.body,xlsx:{filename:reply.csv.filename.slice(0,-4)+'.xlsx'}};
}
