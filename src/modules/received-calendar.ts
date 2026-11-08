import { z } from 'zod';
import { Temporal } from '@js-temporal/polyfill';
import type { ApiContext,Reply } from '../core/api.ts';
import { approvalReadParameters,lockApprovalWrites } from '../core/approvals.ts';
import { ApiError } from '../core/policy.ts';
import { sessionCalendarSelectionSQL } from './automation-events.ts';
import { receivedStudentScope } from './family-access.ts';

const uuid=z.string().uuid().transform(v=>v.toLowerCase()),empty=z.object({}).strict();
const day=z.iso.date().refine(v=>v>='1900-01-01'&&v<='9999-12-31');
const locale=z.enum(['en','fr','zh-CN']);
const familyCalendarQuery=z.object({from:day,through:day,limit:z.coerce.number().int().min(1).max(100).default(50),afterStartsAt:z.iso.datetime({offset:true}).max(40).refine(v=>v.slice(0,10)>='1900-01-01'&&!/\.\d{7}/.test(v)).optional(),afterId:uuid.optional(),afterKind:z.enum(['class_session','calendar_event']).optional(),classId:uuid.optional(),hubId:uuid.optional(),status:z.enum(['scheduled','cancelled']).optional(),mode:z.enum(['online','in_person']).optional(),kind:z.enum(['class_session','competition','holiday','milestone','event']).optional(),locale:locale.default('en')}).strict().refine(q=>(q.afterStartsAt===undefined)===(q.afterId===undefined)&&(q.afterKind===undefined||q.afterId!==undefined)).refine(q=>{try{const span=Temporal.PlainDate.from(q.from).until(Temporal.PlainDate.from(q.through)).days;return span>=0&&span<=365;}catch{return false;}},'Choose an inclusive range of at most 366 days.');
async function familyCalendar(ctx:ApiContext,studentId:string):Promise<Reply>{
 if(ctx.request.method!=='GET')throw new ApiError(405,'METHOD_NOT_ALLOWED');const params=new URL(ctx.request.url).searchParams;if([...params].length!==new Set(params.keys()).size)throw new ApiError(400,'DUPLICATE_QUERY');const q=familyCalendarQuery.parse(Object.fromEntries(params)),scope=await receivedStudentScope(ctx,studentId,'received-calendar.view');
 // Bind the exact requested child,not ANY sibling for whom the same guardian
 // happens to have session access. Scope and civil enrollment dates precede
 // counts,cursors and paging. A source is evaluated once per candidate.
 const result=(await ctx.db.query<{data:({sessionId?:string;eventId?:string;entryType:'class_session'|'calendar_event';startsAt:string}&Record<string,unknown>)[];counts:Record<string,number>;eventCounts:Record<string,number>;evaluatedAt:string}>(`WITH candidates AS MATERIALIZED(
 SELECT s.id,s.starts_at,s.ends_at,h.name hub_name,public.session_notification_source(s.id) source
 FROM public.class_enrollments e JOIN public.classes c ON c.academy_id=e.academy_id AND c.id=e.class_id JOIN public.class_sessions s ON s.academy_id=c.academy_id AND s.class_id=c.id JOIN public.hubs h ON h.academy_id=e.academy_id AND h.id=e.hub_id
 WHERE e.student_id=$1 AND e.enabled AND public.report_recipient(e.student_id,$2)
 AND public.scope_contains($5::jsonb,jsonb_build_object('all',false,'hubs','[]'::jsonb,'people',jsonb_build_array(jsonb_build_object('id',e.student_id,'hubId',e.hub_id)),'recordContext',jsonb_build_object('hubId',e.hub_id,'classId',e.class_id,'studentId',e.student_id)))
 AND s.starts_at>=(($3::date-2)::timestamp AT TIME ZONE 'UTC') AND s.starts_at<(($4::date+3)::timestamp AT TIME ZONE 'UTC')
 AND(s.starts_at AT TIME ZONE c.time_zone)::date BETWEEN $3::date AND $4::date
 AND e.joins_on<=(s.starts_at AT TIME ZONE c.time_zone)::date AND(e.leaves_on IS NULL OR e.leaves_on>=(s.starts_at AT TIME ZONE c.time_zone)::date)
 AND($6::uuid IS NULL OR c.id=$6) AND($7::uuid IS NULL OR e.hub_id=$7) AND($8::text IS NULL OR s.status=$8) AND($9::text IS NULL OR s.mode=$9) AND($15::text IS NULL OR $15='class_session')),
 event_candidates AS MATERIALIZED(SELECT e.id,e.starts_at,e.ends_at,public.family_calendar_event_source(e.id,$1,$2,$5::jsonb,$14,false,$6,$7) source FROM public.calendar_events e
 WHERE $9::text IS NULL AND($15::text IS NULL OR e.definition->>'kind'=$15) AND($8::text IS NULL OR e.definition->>'status'=$8)
 AND tstzrange(e.starts_at,e.ends_at,'[)')&&tstzrange((($3::date-2)::timestamp AT TIME ZONE 'UTC'),(($4::date+3)::timestamp AT TIME ZONE 'UTC'),'[)')
 AND(e.starts_at AT TIME ZONE(e.definition->>'timeZone'))::date<=$4::date AND((e.ends_at-interval '1 microsecond') AT TIME ZONE(e.definition->>'timeZone'))::date>=$3::date),
 entries AS(SELECT id,starts_at,ends_at,'class_session'::text record_kind,source||jsonb_build_object('entryType','class_session','hubName',hub_name,'recordPath','/api/v1/received-sessions/'||id::text) source FROM candidates WHERE source IS NOT NULL
 UNION ALL SELECT id,starts_at,ends_at,'calendar_event',source FROM event_candidates WHERE source IS NOT NULL),
 eligible AS MATERIALIZED(SELECT *,CASE WHEN source->>'status'='cancelled' THEN 'cancelled' WHEN ends_at<=statement_timestamp() THEN 'past' WHEN starts_at<=statement_timestamp() THEN 'in_progress' ELSE 'upcoming' END phase FROM entries),
 page AS(SELECT * FROM eligible WHERE $10::timestamptz IS NULL OR(starts_at,record_kind,id)>($10::timestamptz,$13::text,$11::uuid) ORDER BY starts_at,record_kind,id LIMIT $12)
 SELECT coalesce((SELECT jsonb_agg(source||jsonb_build_object('startsAt',to_char(starts_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'endsAt',to_char(ends_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'phase',phase) ORDER BY starts_at,record_kind,id) FROM page),'[]'::jsonb) data,
 (SELECT jsonb_build_object('sessions',count(*),'scheduled',count(*) FILTER(WHERE phase<>'cancelled'),'cancelled',count(*) FILTER(WHERE phase='cancelled'),'pastScheduled',count(*) FILTER(WHERE phase='past'),'inProgressScheduled',count(*) FILTER(WHERE phase='in_progress'),'upcomingScheduled',count(*) FILTER(WHERE phase='upcoming'),'inactiveClassSessions',count(*) FILTER(WHERE source->'classActive'='false'::jsonb)) FROM eligible WHERE record_kind='class_session') counts,
 (SELECT jsonb_build_object('total',count(*),'competition',count(*) FILTER(WHERE source->>'kind'='competition'),'holiday',count(*) FILTER(WHERE source->>'kind'='holiday'),'milestone',count(*) FILTER(WHERE source->>'kind'='milestone'),'event',count(*) FILTER(WHERE source->>'kind'='event'),'cancelled',count(*) FILTER(WHERE phase='cancelled')) FROM eligible WHERE record_kind='calendar_event') "eventCounts",
 to_char(statement_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') "evaluatedAt"`,[studentId,ctx.credential.person_id,q.from,q.through,JSON.stringify(scope),q.classId??null,q.hubId??null,q.status??null,q.mode??null,q.afterStartsAt??null,q.afterId??null,q.limit+1,q.afterKind??'class_session',q.locale,q.kind??null])).rows[0];
 const last=result.data[q.limit-1];return {status:200,body:{studentId,from:q.from,through:q.through,data:result.data.slice(0,q.limit),counts:result.counts,eventCounts:result.eventCounts,evaluatedAt:result.evaluatedAt,nextCursor:result.data.length>q.limit?{afterStartsAt:last.startsAt,afterId:last.sessionId??last.eventId,afterKind:last.entryType}:null,privateFamilyOnly:true,attendanceIncluded:false,meetingLinksIncluded:false}};
}
export async function receivedCalendar(ctx:ApiContext):Promise<Reply|null>{
 const event=/^students\/([^/]+)\/calendar\/events\/([^/]+)$/.exec(ctx.path);if(event){
  if(ctx.request.method!=='GET')throw new ApiError(405,'METHOD_NOT_ALLOWED');const studentId=uuid.parse(event[1]),id=uuid.parse(event[2]),params=new URL(ctx.request.url).searchParams;if([...params].length!==new Set(params.keys()).size)throw new ApiError(400,'DUPLICATE_QUERY');const q=z.object({locale:locale.default('en')}).strict().parse(Object.fromEntries(params)),scope=await receivedStudentScope(ctx,studentId,'received-calendar.view'),source=(await ctx.db.query<{source:Record<string,unknown>|null}>('SELECT public.family_calendar_event_source($1,$2,$3,$4::jsonb,$5,true) source',[id,studentId,ctx.credential.person_id,JSON.stringify(scope),q.locale])).rows[0].source;if(!source)throw new ApiError(404,'NOT_FOUND');return {status:200,body:{data:source,privateFamilyOnly:true,attendanceIncluded:false,meetingLinksIncluded:false}};
 }
 const family=/^students\/([^/]+)\/calendar$/.exec(ctx.path);if(family)return familyCalendar(ctx,uuid.parse(family[1]));
 const m=/^received-sessions\/([^/]+)$/.exec(ctx.path);if(!m)return null;if(ctx.request.method!=='GET')throw new ApiError(405,'METHOD_NOT_ALLOWED');empty.parse(Object.fromEntries(new URL(ctx.request.url).searchParams));
 const id=uuid.parse(m[1]);await lockApprovalWrites(ctx);
 // One statement snapshot for timing,relationship,scope and meeting link.
 // Family/enrollment/permission mutations use the same shared policy lock.
 const policy=await approvalReadParameters(ctx);
 const row=(await ctx.db.query<{source:Record<string,unknown>;online_url:string|null}>(`WITH selected AS MATERIALIZED(SELECT s.online_url,public.session_notification_source(s.id) source FROM public.class_sessions s WHERE s.id=$4)
 SELECT source,CASE WHEN source->>'status'='scheduled' AND source->'classActive'='true'::jsonb AND($1::boolean OR public.scope_contains(coalesce($3::jsonb->'classes.view','{"all":false,"hubs":[]}'::jsonb),jsonb_build_object('all',false,'hubs','[]'::jsonb,'classes',jsonb_build_array(jsonb_build_object('id',source->'classId','hubId',source->'hubId')))) OR public.session_calendar_meeting_allowed($4,$2,coalesce($3::jsonb->'received-calendar.view','{"all":false,"hubs":[]}'::jsonb))) THEN online_url ELSE NULL END online_url FROM selected
 WHERE source IS NOT NULL AND($1::boolean OR ${sessionCalendarSelectionSQL('selected.source','$2','$3::jsonb')})`,[policy[0],policy[1],policy[4],id])).rows[0];if(!row)throw new ApiError(404,'NOT_FOUND');
 return {status:200,body:{data:{...row.source,onlineUrl:row.online_url},rosterIncluded:false,privateProfilesIncluded:false}};
}
export const receivedCalendarContract=[
 {path:'/api/v1/students/{id}/calendar/events/{eventId}',method:'get',humanOnly:true,summary:'Fresh exact-child verified-family event detail with localized title/description,pinned host-country flag data and configured external website. Current own enrollment and class/hub scope required;no peer details,administrative reason,source snapshot,private class meeting links or attendance. Archived/withdrawn access returns404.',querySchema:z.object({locale:locale.default('en')}).strict()},
 {path:'/api/v1/students/{id}/calendar',method:'get',humanOnly:true,summary:'One private verified-family calendar combines class sessions and school/hub/class competitions, holidays, milestones and events for up to 366 inclusive local days. Exact child, legal relationship, actual record scope and enrollment dates filter before counts and UTC instant/type/UUID cursor paging. Localized event titles and reviewed country flag data; separate eventCounts never inflate session counts. Mode filters select class sessions only. Each request uses current authorized state, not a frozen cross-page snapshot. Schedule phases are not attendance, completed learning or payroll. No peer rosters, private reports or meeting links; each recordPath rechecks current individual access.',querySchema:familyCalendarQuery},
 {path:'/api/v1/received-sessions/{id}',method:'get',summary:'Read session timing under class-view rights or verified own/guardian relationship,effective enrollment and received-calendar scope. Family meeting links additionally require current accepted Live agreement evidence,not retrospective attendance recognition;unsigned families retain calendar/reminders but no meeting link. Authorized class managers remain independent of student paperwork. Canceled/inactive sessions hide links;no peer roster or private profiles.'}] as const;
