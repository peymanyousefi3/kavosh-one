import { randomUUID } from 'node:crypto';
import { record,type ApiContext } from '../core/api.ts';
import { approvalReadParameters } from '../core/approvals.ts';
import type { AutomationDefinition } from '../core/automation-rules.ts';
import { boundAutomationEvent } from '../modules/automation-events.ts';

export function watchesExpenseReminders(d:AutomationDefinition){return Boolean(d.expenseReminder)||d.trigger.eventTypes.some(t=>t==='*'||t==='expense.*'||t==='expense.reminder_due');}
// Bounded private cursor;whole-bill authorization precedes source computation.
// Mixed/global bills require an academy-level rule,not a guessed hub owner.
export async function nextExpenseReminder(ctx:ApiContext,subscription:string,lease:string,rule:{id:string;version:number;hub_id:string|null},definition:AutomationDefinition){
 const timing=definition.expenseReminder;if(!timing||!definition.enabled||definition.execution.mode!=='automatic')return null;
 const policy=await approvalReadParameters(ctx),cursor=(await ctx.db.query<{last_bill_id:string|null}>('SELECT last_bill_id FROM public.expense_reminder_scans WHERE subscription_id=$1',[subscription])).rows[0]?.last_bill_id??null;
 const bills=(await ctx.db.query<{id:string;allowed:boolean}>(`WITH candidates AS MATERIALIZED(SELECT b.id FROM public.expense_bills b WHERE b.void_id IS NULL AND($2::uuid IS NULL OR b.id>$2)
  AND($1::uuid IS NULL OR(EXISTS(SELECT 1 FROM public.expense_bill_lines l WHERE l.academy_id=b.academy_id AND l.bill_id=b.id) AND NOT EXISTS(SELECT 1 FROM public.expense_bill_lines l WHERE l.academy_id=b.academy_id AND l.bill_id=b.id AND l.hub_id IS DISTINCT FROM $1))) ORDER BY b.id LIMIT 100)
  SELECT id,public.expense_reminder_bill_allows(id,$3::jsonb) allowed FROM candidates ORDER BY id`,[rule.hub_id,cursor,policy[4]])).rows;
 let eventId:string|null=null,last:string|null=cursor;
 for(const bill of bills){
  if(!bill.allowed){last=bill.id;continue;}
  const due=(await ctx.db.query<{due:boolean}>(`SELECT true due FROM public.expense_reminder_source($1,$2,$3) AS due(source) WHERE due.source IS NOT NULL
   AND($5::timestamptz IS NULL OR statement_timestamp()>=$5) AND($6::timestamptz IS NULL OR statement_timestamp()<=$6)
   AND NOT EXISTS(SELECT 1 FROM public.expense_reminder_occurrences o WHERE o.rule_id=$4 AND o.bill_id=$1 AND o.days_from_due=$2 AND o.time_zone=$3 AND o.source_stamp=due.source->>'sourceStamp')`,[bill.id,timing.daysFromDue,timing.timeZone,rule.id,definition.startsAt,definition.endsAt])).rows[0];
  if(!due){last=bill.id;continue;}
  const receipt=(await ctx.db.query<{id:string;hub_id:string|null}>(`INSERT INTO public.expense_reminder_occurrences(academy_id,id,subscription_id,lease_token,rule_id,rule_version,bill_id,days_from_due,time_zone,request_id)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT DO NOTHING RETURNING id,hub_id`,[ctx.credential.academy_id,randomUUID(),subscription,lease,rule.id,rule.version,bill.id,timing.daysFromDue,timing.timeZone,ctx.requestId])).rows[0];
  if(!receipt){last=bill.id;continue;}
  await record(ctx.db,ctx.credential,ctx.requestId,'expense.reminder_due',bill.id,receipt.hub_id,{reminderReceiptId:receipt.id,ruleId:rule.id,externalRequestMade:false});
  eventId=(await ctx.db.query<{event_id:string}>('SELECT event_id FROM public.automation_event_sources WHERE expense_reminder_id=$1',[receipt.id])).rows[0]?.event_id??null;if(!eventId)throw new Error('EXPENSE_REMINDER_EVENT_REQUIRED');break;
 }
 await ctx.db.query(`INSERT INTO public.expense_reminder_scans(academy_id,subscription_id,lease_token,last_bill_id) VALUES($1,$2,$3,$4)
  ON CONFLICT(academy_id,subscription_id) DO UPDATE SET lease_token=excluded.lease_token,last_bill_id=excluded.last_bill_id`,[ctx.credential.academy_id,subscription,lease,bills.length<100&&!eventId?null:last]);
 return eventId?boundAutomationEvent(ctx,eventId):null;
}
