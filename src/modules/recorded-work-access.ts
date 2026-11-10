import { z } from 'zod';
import type { ApiContext } from '../core/api.ts';
import { permissionScope,lockApprovalWrites } from '../core/approvals.ts';
import { ApiError,scopeNonempty } from '../core/policy.ts';

const uuid=z.string().uuid().transform(v=>v.toLowerCase());
export const recordedWorkAuthorization=z.object({kind:z.literal('recorded_hourly'),engagements:z.array(z.object({engagementId:uuid,personId:uuid,hubId:uuid.nullable()}).strict()).max(10000).refine(a=>new Set(a.map(e=>e.engagementId)).size===a.length),entries:z.array(z.object({entryId:uuid,personId:uuid,hubId:uuid,classId:uuid,rosterUsed:z.boolean(),attendanceUsed:z.boolean()}).strict().refine(e=>!e.attendanceUsed||e.rosterUsed)).max(2000).refine(a=>new Set(a.map(e=>e.entryId)).size===a.length)}).strict();
export function recordedWorkReportScopes(ctx:ApiContext){const scopes=(['work-pay.view','financial-reports.view','session-time.view'] as const).map(cap=>permissionScope(ctx,cap));if(scopes.some(s=>!scopeNonempty(s)))throw new ApiError(403,'FORBIDDEN');return scopes;}
// A retained archive is not a newly filtered live report. Losing ANY captured
// time/work source,or a headcount permission actually used,blocks bytes and
// hash metadata together instead of silently presenting a smaller history.
export async function requireRecordedWorkResultAccess(ctx:ApiContext,raw:unknown){
 await lockApprovalWrites(ctx);const proof=recordedWorkAuthorization.parse(raw),[work,reports,time]=recordedWorkReportScopes(ctx);
 const target=`jsonb_build_object('all',false,'hubs','[]'::jsonb,'classes',jsonb_build_array(jsonb_build_object('id',t.class_id,'hubId',t.hub_id)))`;
 const ok=(await ctx.db.query<{ok:boolean}>(`SELECT
 NOT EXISTS(SELECT 1 FROM jsonb_to_recordset($1::jsonb) s("engagementId" uuid,"personId" uuid,"hubId" uuid) WHERE NOT EXISTS(SELECT 1 FROM public.work_engagements e WHERE e.id=s."engagementId" AND e.person_id=s."personId" AND e.hub_id IS NOT DISTINCT FROM s."hubId" AND public.work_scope_allows($3::jsonb,e.hub_id,e.person_id) AND public.work_scope_allows($4::jsonb,e.hub_id,e.person_id) AND($6::boolean OR e.hub_id=ANY($7::uuid[]))))
 AND NOT EXISTS(SELECT 1 FROM jsonb_to_recordset($2::jsonb) s("entryId" uuid,"personId" uuid,"hubId" uuid,"classId" uuid,"rosterUsed" boolean,"attendanceUsed" boolean) WHERE NOT EXISTS(SELECT 1 FROM public.session_time_entries t WHERE t.id=s."entryId" AND t.person_id=s."personId" AND t.hub_id=s."hubId" AND t.class_id=s."classId" AND public.work_scope_allows($3::jsonb,t.hub_id,t.person_id) AND public.work_scope_allows($4::jsonb,t.hub_id,t.person_id) AND($6::boolean OR t.hub_id=ANY($7::uuid[])) AND public.scope_contains($5::jsonb,${target}) AND(NOT s."rosterUsed" OR public.scope_contains($8::jsonb,${target})) AND(NOT s."attendanceUsed" OR public.scope_contains($9::jsonb,${target})))) ok`,[JSON.stringify(proof.engagements),JSON.stringify(proof.entries),JSON.stringify(work),JSON.stringify(reports),JSON.stringify(time),ctx.credential.all_hubs,ctx.credential.hub_ids,...(['rosters.view','attendance.view'] as const).map(cap=>JSON.stringify(permissionScope(ctx,cap)))])).rows[0]?.ok;
 if(ok!==true)throw new ApiError(403,'REPORT_SOURCE_ACCESS_CHANGED');
}
