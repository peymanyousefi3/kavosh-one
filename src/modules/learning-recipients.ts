import { z } from 'zod';
import type { ApiContext } from '../core/api.ts';
import { permissionScope,lockApprovalWrites } from '../core/approvals.ts';
import { ApiError } from '../core/policy.ts';
import { permittedPerson } from './students.ts';

export const receivedLearningQuery=z.object({limit:z.coerce.number().int().min(1).max(20).default(10),after:z.string().uuid().transform(v=>v.toLowerCase()).optional(),beforeOn:z.iso.date().optional()}).strict().refine(q=>Boolean(q.after)===Boolean(q.beforeOn),'Use both cursor fields');
export async function authorizeLearningRecipient(ctx:ApiContext,studentId:string){
 if(ctx.credential.kind!=='human')throw new ApiError(403,'HUMAN_RECIPIENT_REQUIRED');
 await lockApprovalWrites(ctx);await permittedPerson(ctx,studentId,'received-reports.view');
 if(!(await ctx.db.query<{allowed:boolean}>('SELECT public.report_recipient($1,$2) allowed',[studentId,ctx.credential.person_id])).rows[0].allowed)throw new ApiError(404,'NOT_FOUND');
 const s=permissionScope(ctx,'received-reports.view');return {s,selected:Boolean(s.people?.some(p=>p.id===studentId))};
}
// Both received-learning queries use code-owned alias p and these bindings:
// student,actor,item,all,selectedStudent,hubs,deniedHubs,beforeOn,afterId,limit.
export const receivedLearningSelection=`public.report_recipient($1,$2) AND($3::uuid IS NULL OR p.id=$3)
 AND($4::boolean OR $5::boolean OR p.hub_id=ANY($6::uuid[])) AND NOT p.hub_id=ANY($7::uuid[])
 AND EXISTS(SELECT 1 FROM public.class_enrollments e WHERE e.academy_id=p.academy_id AND e.class_id=p.class_id AND e.student_id=$1 AND e.enabled
 AND e.joins_on<=(p.context#>>'{source,session,on}')::date AND(e.leaves_on IS NULL OR e.leaves_on>=(p.context#>>'{source,session,on}')::date))
 AND($8::date IS NULL OR((p.context#>>'{source,session,on}')::date,p.id)<($8,$9::uuid))`;
