import {z} from 'zod';
import type {ApiContext,Reply} from '../core/api.ts';
import {lockApprovalWrites,permissionScope,privacyScopes} from '../core/approvals.ts';
import {ApiError,scopeNonempty} from '../core/policy.ts';
import {lockAcademyTopology} from './academy.ts';
const uuid=z.string().uuid().transform(v=>v.toLowerCase());
export const privacyReminderTiming=z.object({basis:z.enum(['baseline','target']),daysFromTarget:z.number().int().min(-365).max(3650)}).strict();
const query=privacyReminderTiming.extend({daysFromTarget:z.coerce.number().int().min(-365).max(3650)});
export async function privacyReminderSource(ctx:ApiContext):Promise<Reply|null>{
 const m=/^privacy-requests\/([^/]+)\/reminder-source$/.exec(ctx.path);if(!m)return null;if(ctx.request.method!=='GET')throw new ApiError(405,'METHOD_NOT_ALLOWED');
 const id=uuid.parse(m[1]),params=new URL(ctx.request.url).searchParams;if([...params].length!==new Set(params.keys()).size)throw new ApiError(400,'DUPLICATE_QUERY');const q=query.parse(Object.fromEntries(params));await lockApprovalWrites(ctx);await lockAcademyTopology(ctx);
 if(!scopeNonempty(permissionScope(ctx,'privacy-requests.view')))throw new ApiError(403,'FORBIDDEN');
 const row=(await ctx.db.query<{data:Record<string,unknown>|null}>('SELECT public.privacy_reminder_assessment($1,$2,$3,$4::jsonb) data',[id,q.basis,q.daysFromTarget,JSON.stringify(privacyScopes(ctx))])).rows[0]?.data;if(!row)throw new ApiError(404,'NOT_FOUND');const {scope:_scope,...data}=row;
 return {status:200,body:{data,clockSource:'database_statement_clock',timeZoneSource:'immutable_original_request_time_zone',currentEffectiveSourceRightsChecked:true,notificationQueued:false,externalRequestMade:false}};
}
export const privacyReminderSourceContract=[{path:'/api/v1/privacy-requests/{id}/reminder-source',method:'get',summary:'Read-only same-snapshot operational privacy follow-up assessment. Explicit baseline/most-recent-reviewed-target basis and civil-day offset in the immutable original request time zone. Final/withdrawn cases are ineligible;clarification retains the reviewed target. Current complete subject/original requester scope required. No request text,private notes,contacts,source proof,caller clock,queue effect,legal-deadline certification,disclosure or deletion.',querySchema:query}] as const;
