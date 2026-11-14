import { z } from 'zod';
import type { ApiContext } from '../core/api.ts';
import { permissionScope } from '../core/approvals.ts';
import { ApiError,requireScope,type Capability } from '../core/policy.ts';
import { classRow } from './classes.ts';
import { permittedPeople } from './students.ts';

const uuid=z.string().uuid().transform(v=>v.toLowerCase());
export const financialAttributionTarget=z.object({hubId:uuid.nullable(),classId:uuid.nullable().default(null),studentId:uuid.nullable().default(null),weight:z.number().int().min(1).max(1000000).default(1)}).strict().refine(t=>t.hubId!==null||(t.classId===null&&t.studentId===null));
export type FinancialAttributionTarget=z.infer<typeof financialAttributionTarget>;
// Both expense and manual-journal attribution authorize the complete old/new
// target set. Batch repeated people and classes rather than per-target reads.
export async function attributionTargetsAuthority(ctx:ApiContext,targets:FinancialAttributionTarget[],caps:readonly Capability[]){
 if(!caps.length)throw new ApiError(403,'FORBIDDEN');const scopes=caps.map(cap=>permissionScope(ctx,cap)),hubs=new Set<string|null>(),classes=new Map<string,string>(),students=new Set<string>();
 for(const t of targets){if(!hubs.has(t.hubId)){for(const scope of scopes)requireScope(scope,t.hubId??undefined);hubs.add(t.hubId);}if(t.classId){if(!classes.has(t.classId))classes.set(t.classId,(await classRow(ctx,t.classId)).hub_id);if(classes.get(t.classId)!==t.hubId)throw new ApiError(404,'NOT_FOUND');}if(t.studentId)students.add(t.studentId);}
 await permittedPeople(ctx,[...students],'students.view');return hubs;
}
