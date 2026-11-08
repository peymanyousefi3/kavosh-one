import { z } from 'zod';
import type { ApiContext,Reply } from '../core/api.ts';
import { approvalReadParameters,lockApprovalWrites } from '../core/approvals.ts';
import { ApiError } from '../core/policy.ts';
import { sessionCalendarSelectionSQL } from './automation-events.ts';

const uuid=z.string().uuid().transform(v=>v.toLowerCase()),empty=z.object({}).strict();
export async function receivedCalendar(ctx:ApiContext):Promise<Reply|null>{
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
export const receivedCalendarContract=[{path:'/api/v1/received-sessions/{id}',method:'get',summary:'Read session timing under class-view rights or verified own/guardian relationship,effective enrollment and received-calendar scope. Family meeting links additionally require current accepted Live agreement evidence,not retrospective attendance recognition;unsigned families retain calendar/reminders but no meeting link. Authorized class managers remain independent of student paperwork. Canceled/inactive sessions hide links;no peer roster or private profiles.'}] as const;
