import { z } from 'zod';
import type { ApiContext } from '../core/api.ts';
import { permissionScope } from '../core/approvals.ts';
import { ApiError,scopeNonempty } from '../core/policy.ts';

const uuid=z.string().uuid().transform(v=>v.toLowerCase());
export const achievementReportAuthorization=z.object({kind:z.literal('achievement_summary'),sources:z.array(z.object({awardId:uuid,studentId:uuid,hubId:uuid.nullable(),classId:uuid.nullable()}).strict().refine(v=>v.classId===null||v.hubId!==null)).max(10000).refine(v=>new Set(v.map(s=>s.awardId)).size===v.length)}).strict();
export function achievementReportScopes(ctx:ApiContext){const scopes=(['achievement-reports.view','achievements.view'] as const).map(c=>permissionScope(ctx,c));if(scopes.some(s=>!scopeNonempty(s)))throw new ApiError(403,'FORBIDDEN');return scopes;}
// A retained aggregate is historical data,not a newly filtered report. Check
// EVERY captured immutable award owner before exposing either bytes or hashes.
export async function requireAchievementReportResultAccess(ctx:ApiContext,raw:unknown){
 const p=achievementReportAuthorization.parse(raw),scopes=achievementReportScopes(ctx),ok=(await ctx.db.query<{ok:boolean}>(`SELECT NOT EXISTS(SELECT 1 FROM jsonb_to_recordset($1::jsonb) s("awardId" uuid,"studentId" uuid,"hubId" uuid,"classId" uuid)
 WHERE NOT EXISTS(SELECT 1 FROM public.achievement_awards a WHERE a.id=s."awardId" AND a.student_id=s."studentId" AND a.hub_id IS NOT DISTINCT FROM s."hubId" AND a.class_id IS NOT DISTINCT FROM s."classId"
 AND public.scope_contains($2::jsonb,public.achievement_award_scope(a.student_id,a.hub_id,a.class_id)) AND public.scope_contains($3::jsonb,public.achievement_award_scope(a.student_id,a.hub_id,a.class_id))
 AND($4::boolean OR a.hub_id=ANY($5::uuid[])))) ok`,[JSON.stringify(p.sources),JSON.stringify(scopes[0]),JSON.stringify(scopes[1]),ctx.credential.all_hubs,ctx.credential.hub_ids])).rows[0].ok;if(!ok)throw new ApiError(403,'REPORT_SOURCE_ACCESS_CHANGED');
}
