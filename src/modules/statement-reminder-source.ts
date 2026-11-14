import {z} from 'zod';
import type {ApiContext,Reply} from '../core/api.ts';
import {permissionScope,privacyScopes} from '../core/approvals.ts';
import {ApiError,scopeNonempty} from '../core/policy.ts';
import {namedTimeZone} from '../core/automation-rules.ts';
import {readMinorUnits,formatMoneyTotal} from '../core/money.ts';
import {lockAcademyTopology} from './academy.ts';
const uuid=z.string().uuid().transform(v=>v.toLowerCase());
const query=z.object({daysFromDue:z.coerce.number().int().min(-365).max(3650),timeZone:namedTimeZone}).strict();
type Assessment={scope:unknown;currencies:{scale:number;signedDueMinor:string;matchedMinor:string;remainingMinor:string}[]};
export async function statementReminderSource(ctx:ApiContext):Promise<Reply|null>{
 const m=/^finance\/counterparty-statements\/([^/]+)\/reminder-source$/.exec(ctx.path);if(!m)return null;if(ctx.request.method!=='GET')throw new ApiError(405,'METHOD_NOT_ALLOWED');const id=uuid.parse(m[1]),params=new URL(ctx.request.url).searchParams;if([...params].length!==new Set(params.keys()).size)throw new ApiError(400,'DUPLICATE_QUERY');const q=query.parse(Object.fromEntries(params));await lockAcademyTopology(ctx);
 for(const cap of ['counterparty-statements.view','counterparty-settlements.view'] as const)if(!scopeNonempty(permissionScope(ctx,cap)))throw new ApiError(403,'FORBIDDEN');
 const s=(await ctx.db.query<{data:Assessment|null}>('SELECT public.statement_reminder_assessment($1,$2,$3,$4::jsonb) data',[id,q.daysFromDue,q.timeZone,JSON.stringify(privacyScopes(ctx))])).rows[0].data;if(!s)throw new ApiError(404,'NOT_FOUND');const {scope,...data}=s;
 return {status:200,body:{data:{...data,currencies:s.currencies.map(c=>({...c,signedDueMinor:readMinorUnits(c.signedDueMinor).toString(),matchedMinor:readMinorUnits(c.matchedMinor).toString(),remainingMinor:readMinorUnits(c.remainingMinor).toString(),signedDue:formatMoneyTotal(readMinorUnits(c.signedDueMinor),c.scale),matched:formatMoneyTotal(readMinorUnits(c.matchedMinor),c.scale),remaining:formatMoneyTotal(readMinorUnits(c.remainingMinor),c.scale)}))},clockSource:'database_statement_clock',currentEffectiveSourceRightsChecked:true,notificationQueued:false,externalRequestMade:false}};
}
export const statementReminderSourceContract=[{path:'/api/v1/finance/counterparty-statements/{id}/reminder-source',method:'get',summary:'Read-only one-snapshot assessment for configurable statement due-day reminders. Explicit civil-day offset/time zone,exact per-currency reviewed net balance,matching and unmatched-payment review gate. Existing recorded but unmatched payments,unknown legacy membership or amended double counting suppress eligibility. Whole original source/settlement rights required;no caller clock,paid flag,amount,authority or source proof accepted. Does not queue notifications,determine legal overdue status or move money.',querySchema:query}] as const;
