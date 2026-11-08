import { z } from 'zod';
import type { ApiContext } from '../core/api.ts';
import { ApiError } from '../core/policy.ts';

export const agreementClearanceSchema=z.object({admissionCleared:z.boolean(),agreementClearanceVerified:z.boolean(),activityRecognized:z.boolean(),signedAfterActivity:z.boolean(),reason:z.string().max(100).nullable()}).strict().refine(v=>v.activityRecognized===v.agreementClearanceVerified&&(v.activityRecognized?(v.admissionCleared?!v.signedAfterActivity&&v.reason===null:v.signedAfterActivity&&v.reason==='agreement_signed_after_activity'):!v.admissionCleared&&!v.signedAfterActivity&&v.reason!==null));
export type AttendanceClearance=z.infer<typeof agreementClearanceSchema>;
export const unverifiedAttendanceClearance:AttendanceClearance={admissionCleared:false,agreementClearanceVerified:false,activityRecognized:false,signedAfterActivity:false,reason:'agreement_clearance_unverified'};
export function attendanceClearanceKey(enrollmentId:string,startsAt:string){return JSON.stringify([enrollmentId,startsAt]);}
// One bounded,request-local distinct batch,not one application query/student
// or an authorization cache persisting across permission/source changes.
export async function attendanceClearances(ctx:ApiContext,targets:{enrollmentId:string;startsAt:string}[]){
 const byKey=new Map(targets.map(t=>[attendanceClearanceKey(t.enrollmentId,t.startsAt),t])),selected=[...byKey.values()];if(selected.length>2000)throw new ApiError(409,'ATTENDANCE_REQUIRES_BACKGROUND_JOB');if(!selected.length)return {clearances:new Map<string,AttendanceClearance>(),evaluatedAt:null};
 await ctx.db.query('SELECT id FROM public.class_enrollments WHERE id=ANY($1::uuid[]) ORDER BY id FOR SHARE',[[...new Set(selected.map(t=>t.enrollmentId))]]);
 const rows=(await ctx.db.query<{key:string;clearance:unknown;checkedAt:string}>(`SELECT t.key,public.enrollment_agreement_clearance(t.enrollment_id,t.starts_at) clearance,statement_timestamp()::text AS "checkedAt" FROM jsonb_to_recordset($1::jsonb) t(key text,enrollment_id uuid,starts_at timestamptz)`,[JSON.stringify(selected.map(t=>({key:attendanceClearanceKey(t.enrollmentId,t.startsAt),enrollment_id:t.enrollmentId,starts_at:t.startsAt})))])).rows;
 if(rows.length!==selected.length||new Set(rows.map(r=>r.key)).size!==selected.length||rows.some(r=>!byKey.has(r.key)))throw new ApiError(503,'ATTENDANCE_CLEARANCE_UNAVAILABLE');
 const evaluatedAt=new Date(rows[0].checkedAt);if(!Number.isFinite(evaluatedAt.getTime())||rows.some(r=>r.checkedAt!==rows[0].checkedAt))throw new ApiError(503,'ATTENDANCE_CLEARANCE_UNAVAILABLE');
 return {evaluatedAt:evaluatedAt.toISOString(),clearances:new Map(rows.map(row=>{if(row.clearance===null)return [row.key,{...unverifiedAttendanceClearance,reason:'enrollment_no_longer_available'}] as const;const parsed=agreementClearanceSchema.safeParse(row.clearance);if(!parsed.success)throw new ApiError(503,'ATTENDANCE_CLEARANCE_UNAVAILABLE');return [row.key,parsed.data] as const;}))};
}
