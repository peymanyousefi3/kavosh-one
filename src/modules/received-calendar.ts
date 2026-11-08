import { z } from 'zod';
import { Temporal } from '@js-temporal/polyfill';
import type { ApiContext,Reply } from '../core/api.ts';
import { approvalReadParameters,lockApprovalWrites } from '../core/approvals.ts';
import { ApiError } from '../core/policy.ts';
import { sessionCalendarSelectionSQL } from './automation-events.ts';
import { receivedStudentScope } from './family-access.ts';

const uuid=z.string().uuid().transform(v=>v.toLowerCase()),empty=z.object({}).strict();
const day=z.iso.date().refine(v=>v>='1900-01-01'&&v<='9999-12-31');
const familyCalendarQuery=z.object({from:day,through:day,limit:z.coerce.number().int().min(1).max(100).default(50),afterStartsAt:z.iso.datetime({offset:true}).max(40).refine(v=>v.slice(0,10)>='1900-01-01'&&!/\.\d{7}/.test(v)).optional(),afterId:uuid.optional(),classId:uuid.optional(),hubId:uuid.optional(),status:z.enum(['scheduled','cancelled']).optional(),mode:z.enum(['online','in_person']).optional()}).strict().refine(q=>(q.afterStartsAt===undefined)===(q.afterId===undefined)).refine(q=>{try{const span=Temporal.PlainDate.from(q.from).until(Temporal.PlainDate.from(q.through)).days;return span>=0&&span<=365;}catch{return false;}},'Choose an inclusive range of at most 366 days.');
async function familyCalendar(ctx:ApiContext,studentId:string):Promise<Reply>{
 if(ctx.request.method!=='GET')throw new ApiError(405,'METHOD_NOT_ALLOWED');const params=new URL(ctx.request.url).searchParams;if([...params].length!==new Set(params.keys()).size)throw new ApiError(400,'DUPLICATE_QUERY');const q=familyCalendarQuery.parse(Object.fromEntries(params)),scope=await receivedStudentScope(ctx,studentId,'received-calendar.view');
 // Bind the exact requested child,not ANY sibling for whom the same guardian
 // happens to have session access. Scope and civil enrollment dates precede
 // counts,cursors and paging. A source is evaluated once per candidate.
 const result=(await ctx.db.query<{data:({sessionId:string;startsAt:string}&Record<string,unknown>)[];counts:Record<string,number>;evaluatedAt:string}>(`WITH candidates AS MATERIALIZED(
 SELECT s.id,s.starts_at,s.ends_at,h.name hub_name,public.session_notification_source(s.id) source
 FROM public.class_enrollments e JOIN public.classes c ON c.academy_id=e.academy_id AND c.id=e.class_id JOIN public.class_sessions s ON s.academy_id=c.academy_id AND s.class_id=c.id JOIN public.hubs h ON h.academy_id=e.academy_id AND h.id=e.hub_id
 WHERE e.student_id=$1 AND e.enabled AND public.report_recipient(e.student_id,$2)
 AND public.scope_contains($5::jsonb,jsonb_build_object('all',false,'hubs','[]'::jsonb,'people',jsonb_build_array(jsonb_build_object('id',e.student_id,'hubId',e.hub_id)),'recordContext',jsonb_build_object('hubId',e.hub_id,'classId',e.class_id,'studentId',e.student_id)))
 AND s.starts_at>=(($3::date-2)::timestamp AT TIME ZONE 'UTC') AND s.starts_at<(($4::date+3)::timestamp AT TIME ZONE 'UTC')
 AND(s.starts_at AT TIME ZONE c.time_zone)::date BETWEEN $3::date AND $4::date
 AND e.joins_on<=(s.starts_at AT TIME ZONE c.time_zone)::date AND(e.leaves_on IS NULL OR e.leaves_on>=(s.starts_at AT TIME ZONE c.time_zone)::date)
 AND($6::uuid IS NULL OR c.id=$6) AND($7::uuid IS NULL OR e.hub_id=$7) AND($8::text IS NULL OR s.status=$8) AND($9::text IS NULL OR s.mode=$9)),
 eligible AS MATERIALIZED(SELECT *,CASE WHEN source->>'status'='cancelled' THEN 'cancelled' WHEN ends_at<=statement_timestamp() THEN 'past' WHEN starts_at<=statement_timestamp() THEN 'in_progress' ELSE 'upcoming' END phase FROM candidates WHERE source IS NOT NULL),
 page AS(SELECT * FROM eligible WHERE $10::timestamptz IS NULL OR(starts_at,id)>($10::timestamptz,$11::uuid) ORDER BY starts_at,id LIMIT $12)
 SELECT coalesce((SELECT jsonb_agg(source||jsonb_build_object('startsAt',to_char(starts_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'endsAt',to_char(ends_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'phase',phase,'hubName',hub_name,'recordPath','/api/v1/received-sessions/'||id::text) ORDER BY starts_at,id) FROM page),'[]'::jsonb) data,
 (SELECT jsonb_build_object('sessions',count(*),'scheduled',count(*) FILTER(WHERE phase<>'cancelled'),'cancelled',count(*) FILTER(WHERE phase='cancelled'),'pastScheduled',count(*) FILTER(WHERE phase='past'),'inProgressScheduled',count(*) FILTER(WHERE phase='in_progress'),'upcomingScheduled',count(*) FILTER(WHERE phase='upcoming'),'inactiveClassSessions',count(*) FILTER(WHERE source->'classActive'='false'::jsonb)) FROM eligible) counts,
 to_char(statement_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') "evaluatedAt"`,[studentId,ctx.credential.person_id,q.from,q.through,JSON.stringify(scope),q.classId??null,q.hubId??null,q.status??null,q.mode??null,q.afterStartsAt??null,q.afterId??null,q.limit+1])).rows[0];
 const last=result.data[q.limit-1];return {status:200,body:{studentId,from:q.from,through:q.through,data:result.data.slice(0,q.limit),counts:result.counts,evaluatedAt:result.evaluatedAt,nextCursor:result.data.length>q.limit?{afterStartsAt:last.startsAt,afterId:last.sessionId}:null,privateFamilyOnly:true,attendanceIncluded:false,meetingLinksIncluded:false}};
}
export async function receivedCalendar(ctx:ApiContext):Promise<Reply|null>{
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
 {path:'/api/v1/students/{id}/calendar',method:'get',humanOnly:true,summary:'Verified own/guardian child calendar across classes for an inclusive class-local range of up to366days. Exact child/record-hub/class permissions and inclusive joining/leaving dates filter before counts and stable UTC cursor paging. Current past/in-progress/upcoming/cancelled schedule counts are not attendance,completed learning or paid sessions. No private meeting links,peer rosters,reports,care or teacher time;follow each recordPath for fresh individual session access.',querySchema:familyCalendarQuery},
 {path:'/api/v1/received-sessions/{id}',method:'get',summary:'Read session timing under class-view rights or verified own/guardian relationship,effective enrollment and received-calendar scope. Family meeting links additionally require current accepted Live agreement evidence,not retrospective attendance recognition;unsigned families retain calendar/reminders but no meeting link. Authorized class managers remain independent of student paperwork. Canceled/inactive sessions hide links;no peer roster or private profiles.'}] as const;
