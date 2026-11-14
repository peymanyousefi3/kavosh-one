import { Temporal } from '@js-temporal/polyfill';
import { z } from 'zod';
import { payCycle,payOccurrencesOn } from './pay-calendar.ts';
import { ApiError } from './policy.ts';

const date=z.iso.date().refine(v=>v>='1900-01-01'&&v<='9999-12-31');
const zone=z.string().min(1).max(100).refine(v=>{if(/^[+-]/.test(v))return false;try{Temporal.Instant.from('2000-01-01T00:00:00Z').toZonedDateTimeISO(v);return true;}catch{return false;}});
export const reportTiming=z.object({timeZone:zone,localTime:z.string().trim().length(5).regex(/^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/),startsOn:date,endsOn:date.nullable().default(null),cycle:z.union([payCycle,z.object({kind:z.literal('daily')}).strict()]),gapPolicy:z.enum(['shift_forward','skip']).default('shift_forward'),overlapPolicy:z.enum(['earlier','later']).default('earlier'),maxDelayMinutes:z.number().int().min(1).max(10080).default(60)}).strict().refine(t=>t.endsOn===null||t.endsOn>=t.startsOn);
export type ReportTiming=z.infer<typeof reportTiming>;
export function reportOccurrenceOn(timing:ReportTiming,on:Temporal.PlainDate){
 if(on.toString()<timing.startsOn||(timing.endsOn!==null&&on.toString()>timing.endsOn))return null;
 if(timing.cycle.kind!=='daily'&&!payOccurrencesOn(timing.cycle,on).length)return null;
 const local=on.toPlainDateTime(timing.localTime),compatible=local.toZonedDateTime(timing.timeZone,{disambiguation:'compatible'});
 // Gap policy is independent of overlap policy. 'earlier' during a spring
 // gap would shift BACKWARDS,which is not the requested shift-forward rule.
 const gap=!compatible.toPlainDateTime().equals(local);if(gap&&timing.gapPolicy==='skip')return null;
 const zoned=gap?compatible:local.toZonedDateTime(timing.timeZone,{disambiguation:timing.overlapPolicy});
 return {localDate:on.toString(),localTime:timing.localTime,timeZone:timing.timeZone,dueAt:zoned.toInstant().toString(),actualLocalTime:zoned.toPlainTime().toString(),shiftedForGap:gap};
}
export function nextReportOccurrence(raw:ReportTiming,after:string){
 const timing=reportTiming.parse(raw),instant=Temporal.Instant.from(after),local=instant.toZonedDateTimeISO(timing.timeZone).toPlainDate(),start=Temporal.PlainDate.compare(local,Temporal.PlainDate.from(timing.startsOn))<0?Temporal.PlainDate.from(timing.startsOn):local;
 if(timing.cycle.kind==='custom'){for(const date of [...timing.cycle.dates].sort()){if(date<start.toString())continue;const candidate=reportOccurrenceOn(timing,Temporal.PlainDate.from(date));if(candidate&&Temporal.Instant.compare(Temporal.Instant.from(candidate.dueAt),instant)>=0)return candidate;}return null;}
 // At most one candidate per civil date,even if two semimonthly slots clamp
 // onto the same short-month day. Never scan indefinitely for a custom date.
 for(let n=0;n<=3660;n++){const day=start.add({days:n});if(day.year>9999||(timing.endsOn!==null&&day.toString()>timing.endsOn))return null;const occurrence=reportOccurrenceOn(timing,day);if(occurrence&&Temporal.Instant.compare(Temporal.Instant.from(occurrence.dueAt),instant)>=0)return occurrence;}
 throw new ApiError(422,'REPORT_SCHEDULE_LOOKAHEAD_LIMIT');
}
