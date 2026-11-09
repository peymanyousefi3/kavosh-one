import { Temporal } from '@js-temporal/polyfill';
import { z } from 'zod';
import { ApiError } from './policy.ts';

const zone=z.string().min(1).max(100).refine(v=>{if(/^[+-]/.test(v))return false;try{Temporal.Instant.from('2000-06-15T12:00:00Z').toZonedDateTimeISO(v);return true;}catch{return false;}});
export const reportDateWindow=z.object({kind:z.enum(['today','yesterday','week_to_date','previous_week','month_to_date','previous_month','quarter_to_date','previous_quarter','year_to_date','previous_year','last_days','next_days']),timeZone:zone,weekStartsOn:z.number().int().min(1).max(7).default(1),days:z.number().int().min(1).max(3660).optional()}).strict().refine(w=>['last_days','next_days'].includes(w.kind)===(w.days!==undefined),'Only rolling-day windows require days.');
export type ReportDateWindow=z.infer<typeof reportDateWindow>;
export const frozenReportWindow=z.object({window:reportDateWindow,resolvedAt:z.iso.datetime(),from:z.iso.date(),through:z.iso.date(),calendar:z.literal('iso8601'),interval:z.literal('inclusive_civil_days'),effectiveParameters:z.partialRecord(z.enum(['on','from','through','timeZone']),z.string().nullable()),overriddenFields:z.array(z.enum(['on','from','through','timeZone'])).max(4)}).strict();
type Inputs={fields:readonly string[];timeZone?:true};
const inputs:Record<string,Inputs>={
 'learning.student-performance':{fields:['from','through']},
 'payroll.paid-tax-year-to-date':{fields:['through'],timeZone:true},
 'payroll.register':{fields:['from','through']},
 'payroll.remittances':{fields:['on']},
 'payroll.settlements':{fields:['on']},
 'finance.trial-balance':{fields:['through']},'finance.balance-sheet':{fields:['through']},
 'community.achievements':{fields:['from','through']},
 'finance.profit-loss':{fields:['from','through']},'finance.bank-reconciliation':{fields:['from','through']},
 'finance.outlook':{fields:['on','through'],timeZone:true},
 'finance.receivables-aging':{fields:['on']},'finance.payables-aging':{fields:['on']},'payroll.gross-accruals':{fields:['on']},
 'inventory.stock':{fields:['on'],timeZone:true},
 'payroll.scheduled-costs':{fields:['from','through'],timeZone:true},'payroll.recorded-time':{fields:['from','through'],timeZone:true}
};
export function reportWindowSupported(id:string){return Object.hasOwn(inputs,id);}
export function reportWindowInputs(id:string){if(!reportWindowSupported(id))throw new ApiError(400,'REPORT_DATE_WINDOW_UNSUPPORTED');return inputs[id];}
export function resolveReportWindow(raw:ReportDateWindow,at:string){
 const window=reportDateWindow.parse(raw),instant=Temporal.Instant.from(at),today=instant.toZonedDateTimeISO(window.timeZone).toPlainDate();let from=today,through=today;
 const month=today.with({day:1}),quarter=month.with({month:Math.floor((today.month-1)/3)*3+1}),year=today.with({month:1,day:1}),week=today.subtract({days:(today.dayOfWeek-window.weekStartsOn+7)%7});
 switch(window.kind){
  case 'yesterday':from=through=today.subtract({days:1});break;
  case 'week_to_date':from=week;break;
  case 'previous_week':from=week.subtract({days:7});through=week.subtract({days:1});break;
  case 'month_to_date':from=month;break;
  case 'previous_month':from=month.subtract({months:1});through=month.subtract({days:1});break;
  case 'quarter_to_date':from=quarter;break;
  case 'previous_quarter':from=quarter.subtract({months:3});through=quarter.subtract({days:1});break;
  case 'year_to_date':from=year;break;
  case 'previous_year':from=year.subtract({years:1});through=year.subtract({days:1});break;
  case 'last_days':from=today.subtract({days:window.days!-1});break;
  case 'next_days':through=today.add({days:window.days!-1});break;
 }
 if(from.year<1900||through.year>9999)throw new ApiError(400,'REPORT_DATE_WINDOW_OUT_OF_RANGE');
 return {window,resolvedAt:instant.toString(),from:from.toString(),through:through.toString(),calendar:'iso8601' as const,interval:'inclusive_civil_days' as const};
}
export type ResolvedReportWindow=ReturnType<typeof resolveReportWindow>;
export function reportWindowParameters(id:string,window:ReportDateWindow,at:string){
 // An outlook requires on < through. To-date windows collapse on the first
 // day of a week/month/quarter/year,so do not approve a rule that later breaks.
 if(id==='finance.outlook'&&(['today','yesterday','week_to_date','month_to_date','quarter_to_date','year_to_date'].includes(window.kind)||window.days===1))throw new ApiError(400,'REPORT_DATE_WINDOW_REQUIRES_MULTIPLE_DAYS');
 const spec=reportWindowInputs(id),resolved=resolveReportWindow(window,at),parameters:Record<string,string>={};
 if(spec.fields.length===1)parameters[spec.fields[0]]=resolved.through;else{parameters[spec.fields[0]]=resolved.from;parameters[spec.fields[1]]=resolved.through;}
 if(spec.timeZone)parameters.timeZone=resolved.window.timeZone;return {parameters,resolved};
}
