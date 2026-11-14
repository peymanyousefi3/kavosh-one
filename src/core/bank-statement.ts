import { createHash } from 'node:crypto';
import { Temporal } from '@js-temporal/polyfill';
import { parse } from 'csv-parse/sync';
import { z } from 'zod';
import { ApiError } from './policy.ts';
import { parseMoney,formatMoneyTotal } from './money.ts';

const text=z.string().refine(v=>v.isWellFormed()&&!v.includes('\0')),column=text.trim().min(1).max(200);
export const statementMapping=z.object({delimiter:z.enum([',',';','\t']).default(','),dateColumn:column,dateFormat:z.enum(['YYYY-MM-DD','DD/MM/YYYY','MM/DD/YYYY']),
 decimalSeparator:z.enum(['.',',']).default('.'),groupSeparator:z.enum([',','.',' ']).nullable().default(null),
 amount:z.discriminatedUnion('kind',[z.object({kind:z.literal('signed'),column,positiveSide:z.enum(['debit','credit'])}).strict(),z.object({kind:z.literal('split'),positiveColumn:column,negativeColumn:column}).strict()]),
 descriptionColumn:column.nullable().default(null),referenceColumn:column.nullable().default(null)}).strict().refine(v=>v.groupSeparator!==v.decimalSeparator);
export const statementInput=z.object({csv:text.min(1).max(262144).refine(v=>Buffer.byteLength(v,'utf8')<=262144),mapping:statementMapping}).strict();
export type StatementRow={line:number;postedOn:string;debitNetMinor:string;description:string;reference:string;spreadsheetUnsafeText:boolean};
export function parseBankStatement(raw:unknown,scale:number){
 const v=statementInput.parse(raw),m=v.mapping;let records:string[][];
 try{records=parse(v.csv,{bom:true,delimiter:m.delimiter,cast:false,columns:false,skip_empty_lines:true,max_record_size:16384}) as string[][];}catch{throw new ApiError(400,'INVALID_STATEMENT_CSV');}
 if(records.length<2||records.length>501)throw new ApiError(400,'STATEMENT_REQUIRES_1_TO_500_ROWS');
 const headers=records[0].map(s=>s.trim());if(headers.length>40||headers.some(s=>!s.length||s.length>200)||new Set(headers).size!==headers.length)throw new ApiError(400,'AMBIGUOUS_STATEMENT_HEADERS');
 const used=[m.dateColumn,...m.amount.kind==='signed'?[m.amount.column]:[m.amount.positiveColumn,m.amount.negativeColumn],...m.descriptionColumn?[m.descriptionColumn]:[],...m.referenceColumn?[m.referenceColumn]:[]];
 if(new Set(used).size!==used.length||used.some(c=>!headers.includes(c)))throw new ApiError(400,'INVALID_STATEMENT_COLUMNS');
 const indices=new Map(headers.map((name,i)=>[name,i]));
 function money(value:string){
  let s=value.trim();if(s.length>80)throw new Error();let negative=s.startsWith('-');if(negative)s=s.slice(1);else if(s.startsWith('(')&&s.endsWith(')')){negative=true;s=s.slice(1,-1);}
  const parts=s.split(m.decimalSeparator);if(parts.length>2||parts[1]!==undefined&&!/^\d+$/.test(parts[1]))throw new Error();
  let whole=parts[0];if(m.groupSeparator&&whole.includes(m.groupSeparator)){const groups=whole.split(m.groupSeparator);if(!/^\d{1,3}$/.test(groups[0])||groups.slice(1).some(g=>!/^\d{3}$/.test(g)))throw new Error();whole=groups.join('');}
  if(!/^\d+$/.test(whole))throw new Error();return parseMoney((negative?'-':'')+whole+(parts[1]===undefined?'':'.'+parts[1]),scale);
 }
 const rows:StatementRow[]=records.slice(1).map((record,index)=>{
  const line=index+1;try{
   const get=(name:string)=>record[indices.get(name)!],d=get(m.dateColumn).trim();let iso=d;
   if(m.dateFormat!=='YYYY-MM-DD'){const match=/^(\d{2})\/(\d{2})\/(\d{4})$/.exec(d);if(!match)throw new Error();iso=match[3]+'-'+match[m.dateFormat==='DD/MM/YYYY'?2:1]+'-'+match[m.dateFormat==='DD/MM/YYYY'?1:2];}
   if(!/^\d{4}-\d{2}-\d{2}$/.test(iso)||iso<'0001-01-01'||iso>'9999-12-31'||Temporal.PlainDate.from(iso).toString()!==iso)throw new Error();
   let amount:bigint;if(m.amount.kind==='signed')amount=money(get(m.amount.column))*(m.amount.positiveSide==='debit'?1n:-1n);
   else{const p=get(m.amount.positiveColumn).trim(),n=get(m.amount.negativeColumn).trim(),positive=p===''?0n:money(p),negative=n===''?0n:money(n);if(positive<0n||negative<0n||(positive>0n&&negative>0n))throw new Error();amount=positive-negative;}
   if(amount===0n)throw new Error();const description=m.descriptionColumn?get(m.descriptionColumn):'',reference=m.referenceColumn?get(m.referenceColumn):'';
   if(description.length>2000||reference.length>200||!description.isWellFormed()||!reference.isWellFormed()||description.includes('\0')||reference.includes('\0'))throw new Error();
   return {line,postedOn:iso,debitNetMinor:amount.toString(),description,reference,spreadsheetUnsafeText:[description,reference].some(s=>/^\s*[=+@-]/u.test(s))};
  }catch{throw new ApiError(400,'INVALID_STATEMENT_ROW_'+line);}
 });
 const sourceHash=createHash('sha256').update(v.csv,'utf8').digest('hex'),importHash=createHash('sha256').update(JSON.stringify({sourceHash,mapping:m,unitScale:scale})).digest('hex');
 const positive=rows.reduce((sum,r)=>sum+(BigInt(r.debitNetMinor)>0n?BigInt(r.debitNetMinor):0n),0n),negative=rows.reduce((sum,r)=>sum+(BigInt(r.debitNetMinor)<0n?-BigInt(r.debitNetMinor):0n),0n),dates=rows.map(r=>r.postedOn).sort();
 return {mapping:m,sourceHash,importHash,rows,from:dates[0],through:dates.at(-1)!,unitScale:scale,totals:{debits:{minor:positive.toString(),amount:formatMoneyTotal(positive,scale)},credits:{minor:negative.toString(),amount:formatMoneyTotal(negative,scale)},net:{minor:(positive-negative).toString(),amount:formatMoneyTotal(positive-negative,scale)}},sourceVerified:false,ledgerAdjusted:false};
}
