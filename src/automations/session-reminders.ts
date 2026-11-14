import { randomUUID } from 'node:crypto';
import { record,type ApiContext } from '../core/api.ts';
import { approvalReadParameters } from '../core/approvals.ts';
import type { AutomationDefinition } from '../core/automation-rules.ts';
import { boundAutomationEvent,sessionCalendarSelectionSQL } from '../modules/automation-events.ts';

// One actual due session per existing leased watcher step. No new daemon,
// caller clock,synthetic identity,external delivery or unbounded roster work.
export async function nextSessionReminder(ctx:ApiContext,subscription:string,lease:string,rule:{id:string;version:number;hub_id:string|null},definition:AutomationDefinition){
 const reminder=definition.sessionReminder;if(!reminder||!definition.enabled||definition.execution.mode!=='automatic')return null;
 const policy=await approvalReadParameters(ctx);
 const row=(await ctx.db.query<{id:string;hub_id:string}>(`WITH candidates AS MATERIALIZED(
 SELECT s.id,s.hub_id,s.starts_at,public.session_notification_source(s.id) source FROM public.class_sessions s
 JOIN public.classes c ON c.academy_id=s.academy_id AND c.id=s.class_id JOIN public.hubs h ON h.academy_id=s.academy_id AND h.id=s.hub_id
 WHERE s.status='scheduled' AND c.active AND h.active AND($4::uuid IS NULL OR s.hub_id=$4)
 AND($8::timestamptz IS NULL OR statement_timestamp()>=$8) AND($9::timestamptz IS NULL OR statement_timestamp()<=$9)
 AND s.starts_at>statement_timestamp() AND s.starts_at<=statement_timestamp()+$6::integer*interval '1 minute'
 AND s.starts_at>statement_timestamp()+($6::integer-$7::integer)*interval '1 minute')
 SELECT id,hub_id FROM candidates WHERE source IS NOT NULL AND($1::boolean OR ${sessionCalendarSelectionSQL('candidates.source','$2','$3::jsonb')})
 AND NOT EXISTS(SELECT 1 FROM public.session_reminder_occurrences o WHERE o.rule_id=$5 AND o.session_id=candidates.id AND o.minutes_before=$6 AND o.source_stamp=public.session_reminder_stamp(candidates.source))
 ORDER BY starts_at,id LIMIT 1`,[policy[0],policy[1],policy[4],rule.hub_id,rule.id,reminder.minutesBefore,reminder.maxDelayMinutes,definition.startsAt,definition.endsAt])).rows[0];if(!row)return null;
 const receipt=(await ctx.db.query<{id:string}>(`INSERT INTO public.session_reminder_occurrences(academy_id,id,subscription_id,lease_token,rule_id,rule_version,session_id,request_id,minutes_before,max_delay_minutes)
 VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT DO NOTHING RETURNING id`,[ctx.credential.academy_id,randomUUID(),subscription,lease,rule.id,rule.version,row.id,ctx.requestId,reminder.minutesBefore,reminder.maxDelayMinutes])).rows[0];if(!receipt)return null;
 await record(ctx.db,ctx.credential,ctx.requestId,'session.reminder_due',row.id,row.hub_id,{reminderReceiptId:receipt.id,ruleId:rule.id,externalRequestMade:false});
 const event=(await ctx.db.query<{id:string}>("SELECT event_id AS id FROM public.automation_event_sources WHERE event_type='session.reminder_due' AND projection#>>'{attributes,reminder,receiptId}'=$1",[receipt.id])).rows[0];if(!event)throw new Error('SESSION_REMINDER_EVENT_REQUIRED');
 return boundAutomationEvent(ctx,event.id);
}
