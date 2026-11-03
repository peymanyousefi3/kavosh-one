import { Temporal } from '@js-temporal/polyfill';
import { z } from 'zod';
import { jsonBody,type ApiContext,type Reply } from '../core/api.ts';
import { permissionScope } from '../core/approvals.ts';
import { ApiError,requireScope } from '../core/policy.ts';

const date=z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value=>{try{Temporal.PlainDate.from(value,{overflow:'reject'});return true;}catch{return false;}});
const time=z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
const local=z.string().regex(/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d$/).refine(value=>{try{Temporal.PlainDateTime.from(value,{overflow:'reject'});return true;}catch{return false;}});
const disambiguation=z.enum(['reject','earlier','later']).default('reject');
const oneOff=z.object({start:local,end:local,disambiguation}).strict();
const weekly=z.object({from:date,through:date,weekdays:z.array(z.number().int().min(1).max(7)).min(1).max(7),
  startTime:time,endTime:time,endDayOffset:z.number().int().min(0).max(1).default(0),everyWeeks:z.number().int().min(1).max(52).default(1),disambiguation}).strict();
const exclusion=z.object({date,reason:z.string().trim().min(1).max(300)}).strict();
export const scheduleInput=z.object({weekly:weekly.optional(),oneOff:z.array(oneOff).max(500).default([]),exclude:z.array(exclusion).max(366).default([])}).strict()
  .refine(value=>Boolean(value.weekly)||value.oneOff.length>0,'Provide a weekly pattern or explicit dates.');
const previewInput=z.object({hubId:z.string().uuid().transform(v=>v.toLowerCase()),schedule:scheduleInput}).strict();
type Schedule=z.infer<typeof scheduleInput>;
export interface ScheduledTime {start:string;end:string;requestedStart:string;requestedEnd:string;localStart:string;localEnd:string;timeZone:string;startOffset:string;endOffset:string;durationMinutes:number;adjustedForTimeZone:boolean;disambiguation:'reject'|'earlier'|'later';source:'weekly'|'oneOff'}

function resolve(start:string,end:string,timeZone:string,choice:'reject'|'earlier'|'later',source:ScheduledTime['source']):ScheduledTime {
  try {
    // Explicitly reject folds/gaps by default rather than silently changing a
    // lesson. See https://tc39.es/proposal-temporal/docs/zoneddatetime.html .
    const first=Temporal.PlainDateTime.from(start).toZonedDateTime(timeZone,{disambiguation:choice});
    const last=Temporal.PlainDateTime.from(end).toZonedDateTime(timeZone,{disambiguation:choice});
    const durationMinutes=(last.epochMilliseconds-first.epochMilliseconds)/60_000;
    if(durationMinutes<=0||durationMinutes>1440)throw new ApiError(400,'SESSION_DURATION_OUT_OF_RANGE');
    const localStart=first.toPlainDateTime().toString({smallestUnit:'minute'}),localEnd=last.toPlainDateTime().toString({smallestUnit:'minute'});
    return {start:first.toInstant().toString(),end:last.toInstant().toString(),requestedStart:start,requestedEnd:end,localStart,localEnd,timeZone,
      startOffset:first.offset,endOffset:last.offset,durationMinutes,adjustedForTimeZone:localStart!==start||localEnd!==end,disambiguation:choice,source};
  }catch(error){if(error instanceof ApiError)throw error;throw new ApiError(400,'INVALID_OR_AMBIGUOUS_LOCAL_TIME');}
}

export function compileSchedule(raw:unknown,timeZone:string) {
  const input:Schedule=scheduleInput.parse(raw);
  try{new Intl.DateTimeFormat('en',{timeZone});}catch{throw new ApiError(400,'INVALID_TIME_ZONE');}
  const excluded=new Map(input.exclude.map(item=>[item.date,item.reason]));
  if(excluded.size!==input.exclude.length)throw new ApiError(400,'DUPLICATE_EXCLUSION_DATE');
  const sessions:ScheduledTime[]=[],skipped=new Map<string,string>();
  function append(start:string,end:string,choice:'reject'|'earlier'|'later',source:ScheduledTime['source']) {
    const day=start.slice(0,10),reason=excluded.get(day);
    if(reason){skipped.set(day,reason);return;}
    sessions.push(resolve(start,end,timeZone,choice,source));
    if(sessions.length>500)throw new ApiError(400,'SCHEDULE_TOO_LARGE');
  }
  if(input.weekly) {
    const rule=input.weekly,from=Temporal.PlainDate.from(rule.from),through=Temporal.PlainDate.from(rule.through),span=from.until(through).days;
    if(span<0||span>365)throw new ApiError(400,'SCHEDULE_RANGE_OUT_OF_BOUNDS');
    if(new Set(rule.weekdays).size!==rule.weekdays.length)throw new ApiError(400,'DUPLICATE_WEEKDAY');
    // Intervals are anchored to the ISO week containing `from`, not to a
    // rolling seven-day window which would shift selected weekdays.
    const weekStart=from.subtract({days:from.dayOfWeek-1});
    for(let day=from;Temporal.PlainDate.compare(day,through)<=0;day=day.add({days:1})) {
      const week=Math.floor(weekStart.until(day).days/7);
      if(rule.weekdays.includes(day.dayOfWeek)&&week%rule.everyWeeks===0)
        append(day.toString()+'T'+rule.startTime,day.add({days:rule.endDayOffset}).toString()+'T'+rule.endTime,rule.disambiguation,'weekly');
    }
  }
  for(const item of input.oneOff)append(item.start,item.end,item.disambiguation,'oneOff');
  sessions.sort((a,b)=>a.start.localeCompare(b.start));
  for(let i=1;i<sessions.length;i++)if(sessions[i].start<sessions[i-1].end)throw new ApiError(400,'CLASS_SESSION_OVERLAP');
  return {timeZone,timeZoneDatabaseVersion:process.versions.tz??null,sessions,excluded:[...excluded].sort(([a],[b])=>a.localeCompare(b)).map(([day,reason])=>({date:day,reason,matched:skipped.has(day)})),count:sessions.length};
}

export async function calendar(ctx:ApiContext):Promise<Reply|null> {
  if(ctx.path!=='calendar/preview')return null;
  if(ctx.request.method!=='POST')throw new ApiError(405,'METHOD_NOT_ALLOWED');
  const input=previewInput.parse(await jsonBody(ctx.request,128*1024));
  requireScope(permissionScope(ctx,'hubs.view'),input.hubId);
  const hub=(await ctx.db.query<{time_zone:string|null;active:boolean}>('SELECT time_zone,active FROM public.hubs WHERE id=$1',[input.hubId])).rows[0];
  if(!hub)throw new ApiError(404,'NOT_FOUND');
  if(!hub.time_zone)throw new ApiError(409,'HUB_TIME_ZONE_REQUIRED');
  return {status:200,body:{data:compileSchedule(input.schedule,hub.time_zone),persisted:false}};
}
export const calendarContract=[{path:'/api/v1/calendar/preview',method:'post',readOnly:true,summary:'Preview weekly/irregular dates and exclusions in the selected hub time zone without saving or notifying',schema:previewInput}] as const;
