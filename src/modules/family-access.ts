import type { ApiContext } from '../core/api.ts';
import { lockApprovalWrites,permissionScope } from '../core/approvals.ts';
import { ApiError,scopeNonempty } from '../core/policy.ts';

// Registration authority includes pending children,not disabled children.
// Each feature still requires its own independently configured scope.
export async function receivedStudentScope(ctx:ApiContext,studentId:string,capability:'received-tuition.view'|'received-enrollments.view'|'received-calendar.view'){
 if(ctx.credential.kind!=='human')throw new ApiError(403,'HUMAN_RECIPIENT_REQUIRED');
 await lockApprovalWrites(ctx);const scope=permissionScope(ctx,capability);if(!scopeNonempty(scope))throw new ApiError(403,'FORBIDDEN');
 if(!(await ctx.db.query<{v:boolean}>('SELECT public.registration_data_basis($1,$2) IS NOT NULL v',[studentId,ctx.credential.person_id])).rows[0].v)throw new ApiError(404,'NOT_FOUND');return scope;
}
