import { randomUUID } from 'node:crypto';
import { record,type ApiContext } from '../core/api.ts';
import { approvalReadParameters } from '../core/approvals.ts';
import type { AutomationDefinition } from '../core/automation-rules.ts';
import { boundAutomationEvent } from '../modules/automation-events.ts';

export function watchesPayrollReminders(d:AutomationDefinition){return Boolean(d.payrollReminder)||d.trigger.eventTypes.some(t=>t==='*'||t==='payroll.*'||t==='payroll.reminder_due');}
// Private100-posting scan. Effective source rights AND the original token
// ceiling precede the non-locking snapshot;only a chosen occurrence takes the
// original worker lock and reconstructs the canonical source before commit.
export async function nextPayrollReminder(ctx:ApiContext,subscription:string,lease:string,rule:{id:string;version:number;hub_id:string|null},definition:AutomationDefinition){
 const timing=definition.payrollReminder;if(!timing||!definition.enabled||definition.execution.mode!=='automatic')return null;
 const policy=await approvalReadParameters(ctx),cursor=(await ctx.db.query<{last_posting_id:string|null}>('SELECT last_posting_id FROM public.payroll_reminder_scans WHERE subscription_id=$1',[subscription])).rows[0]?.last_posting_id??null;
 const postings=(await ctx.db.query<{id:string;allowed:boolean}>(`WITH candidates AS MATERIALIZED(SELECT p.id FROM public.payrun_net_postings p JOIN public.payrun_groups g ON g.academy_id=p.academy_id AND g.id=p.run_id
  WHERE p.reversal_id IS NULL AND g.cancellation_id IS NULL AND($2::uuid IS NULL OR p.id>$2)
  AND($1::uuid IS NULL OR(jsonb_array_length(g.scope->'workContexts')>0 AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(g.scope->'workContexts') context WHERE(context->>'hubId')::uuid IS DISTINCT FROM $1))) ORDER BY p.id LIMIT 100)
  SELECT id,public.payroll_reminder_posting_allows(id,$3::jsonb,$4::jsonb) allowed FROM candidates ORDER BY id`,[rule.hub_id,cursor,policy[4],JSON.stringify({all:ctx.credential.all_hubs,hubs:ctx.credential.hub_ids})])).rows;
 let eventId:string|null=null,last:string|null=cursor;
 for(const posting of postings){
  if(!posting.allowed){last=posting.id;continue;}
  const due=(await ctx.db.query<{due:boolean}>(`SELECT true due FROM public.payroll_reminder_source_read($1,$2,$3) AS due(source) WHERE due.source IS NOT NULL
   AND($5::timestamptz IS NULL OR statement_timestamp()>=$5) AND($6::timestamptz IS NULL OR statement_timestamp()<=$6)
   AND NOT EXISTS(SELECT 1 FROM public.payroll_reminder_occurrences o WHERE o.rule_id=$4 AND o.posting_id=$1 AND o.days_from_planned_pay=$2 AND o.time_zone=$3 AND o.source_stamp=due.source->>'sourceStamp')`,[posting.id,timing.daysFromPlannedPay,timing.timeZone,rule.id,definition.startsAt,definition.endsAt])).rows[0];
  if(!due){last=posting.id;continue;}
  const receipt=(await ctx.db.query<{id:string;hub_id:string|null}>(`INSERT INTO public.payroll_reminder_occurrences(academy_id,id,subscription_id,lease_token,rule_id,rule_version,posting_id,days_from_planned_pay,time_zone,request_id)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT DO NOTHING RETURNING id,hub_id`,[ctx.credential.academy_id,randomUUID(),subscription,lease,rule.id,rule.version,posting.id,timing.daysFromPlannedPay,timing.timeZone,ctx.requestId])).rows[0];
  if(!receipt){last=posting.id;continue;}
  await record(ctx.db,ctx.credential,ctx.requestId,'payroll.reminder_due',posting.id,receipt.hub_id,{reminderReceiptId:receipt.id,ruleId:rule.id,externalRequestMade:false});
  eventId=(await ctx.db.query<{event_id:string}>('SELECT event_id FROM public.automation_event_sources WHERE payroll_reminder_id=$1',[receipt.id])).rows[0]?.event_id??null;if(!eventId)throw new Error('PAYROLL_REMINDER_EVENT_REQUIRED');break;
 }
 await ctx.db.query(`INSERT INTO public.payroll_reminder_scans(academy_id,subscription_id,lease_token,last_posting_id) VALUES($1,$2,$3,$4)
  ON CONFLICT(academy_id,subscription_id) DO UPDATE SET lease_token=excluded.lease_token,last_posting_id=excluded.last_posting_id`,[ctx.credential.academy_id,subscription,lease,postings.length<100&&!eventId?null:last]);
 return eventId?boundAutomationEvent(ctx,eventId):null;
}
