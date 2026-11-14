import { z } from 'zod';
import type { ApiContext } from '../core/api.ts';
import { permissionScope,lockApprovalWrites } from '../core/approvals.ts';
import { ApiError,scopeNonempty } from '../core/policy.ts';
import { studentFeedbackTargetSQL } from './student-feedback.ts';

const uuid=z.string().uuid().transform(v=>v.toLowerCase());
export const performanceAuthorization=z.object({kind:z.literal('student_performance'),sources:z.array(z.object({feedbackId:uuid,studentId:uuid,classId:uuid,hubId:uuid}).strict()).max(200).refine(v=>new Set(v.map(r=>r.feedbackId)).size===v.length)}).strict();
export function performanceReportScope(ctx:ApiContext){const scope=permissionScope(ctx,'student-feedback.view');if(!scopeNonempty(scope))throw new ApiError(403,'FORBIDDEN');return scope;}
// Retained administrative history is not a newly filtered live report. Losing
// any captured source blocks both its bytes and hash metadata,not just that row.
export async function requirePerformanceResultAccess(ctx:ApiContext,raw:unknown){
 await lockApprovalWrites(ctx);const proof=performanceAuthorization.parse(raw),scope=performanceReportScope(ctx);
 const ok=(await ctx.db.query<{ok:boolean}>(`SELECT NOT EXISTS(SELECT 1 FROM jsonb_to_recordset($1::jsonb) s("feedbackId" uuid,"studentId" uuid,"classId" uuid,"hubId" uuid) WHERE NOT EXISTS(SELECT 1 FROM public.student_feedback f WHERE f.id=s."feedbackId" AND f.student_id=s."studentId" AND f.class_id=s."classId" AND f.hub_id=s."hubId" AND public.scope_contains($2::jsonb,${studentFeedbackTargetSQL}))) ok`,[JSON.stringify(proof.sources),JSON.stringify(scope)])).rows[0].ok;
 if(!ok)throw new ApiError(403,'REPORT_SOURCE_ACCESS_CHANGED');
}
