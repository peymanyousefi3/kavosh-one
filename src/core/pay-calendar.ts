import { Temporal } from '@js-temporal/polyfill';
import { z } from 'zod';
import { ApiError } from './policy.ts';

const date=z.iso.date().refine(v=>v>='1900-01-01'&&v<='9999-12-31');
const label=z.string().trim().min(1).max(200).refine(v=>v.isWellFormed()&&!v.includes('\0'));
export const payCycle=z.discriminatedUnion('kind',[
 z.object({kind:z.literal('monthly'),day:z.number().int().min(1).max(31),shortMonth:z.literal('last_day').default('last_day')}).strict(),
 z.object({kind:z.literal('semimonthly'),days:z.array(z.number().int().min(1).max(31)).length(2).refine(a=>a[0]<a[1]),shortMonth:z.literal('last_day').default('last_day')}).strict(),
 z.object({kind:z.literal('biweekly'),anchorOn:date}).strict(),
 z.object({kind:z.literal('weekly'),weekday:z.number().int().min(1).max(7)}).strict(),
 z.object({kind:z.literal('custom'),label,dates:z.array(date).min(1).max(100).refine(a=>new Set(a).size===a.length)}).strict()
]);
export type PayCycle=z.infer<typeof payCycle>;
export const payCalendarRange=z.object({from:date,through:date}).strict().refine(v=>v.through>=v.from);
export function payCalendarDays(raw:unknown){
 const range=payCalendarRange.parse(raw),start=Temporal.PlainDate.from(range.from),end=Temporal.PlainDate.from(range.through),span=start.until(end).days;
 if(span>365)throw new ApiError(422,'PAY_CALENDAR_RANGE_TOO_LARGE');
 // A bounded civil-day walk avoids DST elapsed-hour arithmetic. One leap
 // year is the synchronous limit; larger exports belong in report jobs.
 return Array.from({length:span+1},(_,i)=>start.add({days:i}));
}
export function payOccurrencesOn(cycle:PayCycle,on:Temporal.PlainDate):{on:string;slot:number}[]{
 const dates:number[]=cycle.kind==='monthly'?[cycle.day]:cycle.kind==='semimonthly'?cycle.days:[];
 if(dates.length)return dates.flatMap((day,index)=>Math.min(day,on.daysInMonth)===on.day?[{on:on.toString(),slot:index+1}]:[]);
 if(cycle.kind==='weekly')return on.dayOfWeek===cycle.weekday?[{on:on.toString(),slot:1}]:[];
 if(cycle.kind==='biweekly')return Temporal.PlainDate.from(cycle.anchorOn).until(on).days%14===0?[{on:on.toString(),slot:1}]:[];
 if(cycle.kind==='custom')return cycle.dates.includes(on.toString())?[{on:on.toString(),slot:1}]:[];
 return [];
}
