import { z } from 'zod';
import type { ApiContext } from '../core/api.ts';
import { permissionScope,lockApprovalWrites } from '../core/approvals.ts';
import { ApiError,scopeNonempty,type Capability } from '../core/policy.ts';

export const receivedLearningQuery=z.object({limit:z.coerce.number().int().min(1).max(20).default(10),after:z.string().uuid().transform(v=>v.toLowerCase()).optional(),beforeOn:z.iso.date().optional()}).strict().refine(q=>Boolean(q.after)===Boolean(q.beforeOn),'Use both cursor fields');
export async function authorizeLearningRecipient(ctx:ApiContext,studentId:string,cap:Capability='received-reports.view'){
 if(ctx.credential.kind!=='human')throw new ApiError(403,'HUMAN_RECIPIENT_REQUIRED');
 const params=new URL(ctx.request.url).searchParams;if([...params].length!==new Set(params.keys()).size)throw new ApiError(400,'DUPLICATE_QUERY');
 await lockApprovalWrites(ctx);const s=permissionScope(ctx,cap);if(!scopeNonempty(s))throw new ApiError(403,'FORBIDDEN');
 if(!(await ctx.db.query<{allowed:boolean}>('SELECT public.report_recipient($1,$2) allowed',[studentId,ctx.credential.person_id])).rows[0].allowed)throw new ApiError(404,'NOT_FOUND');
 return {s};
}
// Shared published-learning queries use code-owned alias p and these bindings:
// student,actor,item,fullRecordScope,beforeOn,afterId,(limit or own filters).
export const receivedLearningSelection=`public.report_recipient($1,$2) AND($3::uuid IS NULL OR p.id=$3)
 AND public.scope_contains($4::jsonb,jsonb_build_object('all',false,'hubs','[]'::jsonb,'classes',jsonb_build_array(jsonb_build_object('id',p.class_id,'hubId',p.hub_id)),'people',jsonb_build_array(jsonb_build_object('id',$1::uuid,'hubId',p.hub_id)),'recordContext',jsonb_build_object('classId',p.class_id,'hubId',p.hub_id,'studentId',$1::uuid)))
 AND EXISTS(SELECT 1 FROM public.class_enrollments e WHERE e.academy_id=p.academy_id AND e.class_id=p.class_id AND e.student_id=$1 AND e.enabled
 AND e.joins_on<=(p.context#>>'{source,session,on}')::date AND(e.leaves_on IS NULL OR e.leaves_on>=(p.context#>>'{source,session,on}')::date))
 AND($5::date IS NULL OR((p.context#>>'{source,session,on}')::date,p.id)<($5,$6::uuid))`;
