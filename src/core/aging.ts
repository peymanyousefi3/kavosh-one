import { z } from 'zod';
import { readMinorUnits,formatMoneyTotal } from './money.ts';

export const agingCutoffs=z.string().max(47).regex(/^[1-9]\d{0,4}(?:,[1-9]\d{0,4}){0,7}$/).default('30,60,90').transform(v=>v.split(',').map(Number)).refine(v=>v.every((n,i)=>n<=36500&&(!i||n>v[i-1])),'Use one to eight increasing overdue-day boundaries, each at most 36500.');
export function exactReportMoney(value:string|bigint,scale:number){const n=typeof value==='bigint'?value:readMinorUnits(value);return {minor:n.toString(),amount:formatMoneyTotal(n,scale)};}
export function agingBandDefinitions(days:number[]){return [{key:'not_due',fromDays:null,throughDays:0},...days.map((n,i)=>({key:`${i?days[i-1]+1:1}_${n}`,fromDays:i?days[i-1]+1:1,throughDays:n})),{key:`over_${days.at(-1)!}`,fromDays:days.at(-1)!+1,throughDays:null}];}
