import { randomUUID } from 'node:crypto';
import { record,type ApiContext } from '../core/api.ts';
import { approvalReadParameters } from '../core/approvals.ts';
import type { AutomationDefinition } from '../core/automation-rules.ts';
import { boundAutomationEvent } from '../modules/automation-events.ts';

export function watchesTuitionReminders(definition:AutomationDefinition){return Boolean(definition.tuitionReminder)||definition.trigger.eventTypes.some(t=>t==='*'||t==='tuition.*'||t==='tuition.reminder_due');}

// One leased step inspects at most100 private tenant invoice IDs,then wraps.
// Authorization precedes financial source computation or any published event.
// This service-only cursor exposes no IDs/counts to the subscriber or recipients.
// No per-student daemon,caller clock,synthetic master or external IO.
export async function nextTuitionReminder(ctx:ApiContext,subscription:string,lease:string,rule:{id:string;version:number;hub_id:string|null},definition:AutomationDefinition){
 const timing=definition.tuitionReminder;if(!timing||!definition.enabled||definition.execution.mode!=='automatic')return null;
 const policy=await approvalReadParameters(ctx),cursor=(await ctx.db.query<{last_invoice_id:string|null}>('SELECT last_invoice_id FROM public.tuition_reminder_scans WHERE subscription_id=$1',[subscription])).rows[0]?.last_invoice_id??null;
 const invoices=(await ctx.db.query<{id:string;allowed:boolean}>(`WITH candidates AS MATERIALIZED(SELECT i.id FROM public.tuition_invoices i WHERE i.credit_id IS NULL AND($1::uuid IS NULL OR i.hub_id=$1) AND($2::uuid IS NULL OR i.id>$2) ORDER BY i.id LIMIT 100)
  SELECT id,public.tuition_reminder_invoice_allows(id,$3,$4::jsonb) allowed FROM candidates ORDER BY id`,[rule.hub_id,cursor,policy[1],policy[4]])).rows;
 let eventId:string|null=null,last:string|null=cursor;
 for(const invoice of invoices){
  if(!invoice.allowed){last=invoice.id;continue;}
  const due=(await ctx.db.query<{installment:number;hub_id:string}>(`SELECT (due.source->>'installment')::integer installment,(due.source->>'hubId')::uuid hub_id FROM public.tuition_reminder_sources($1,$2) AS due(source) WHERE due.source IS NOT NULL
    AND($4::timestamptz IS NULL OR statement_timestamp()>=$4) AND($5::timestamptz IS NULL OR statement_timestamp()<=$5)
    AND NOT EXISTS(SELECT 1 FROM public.tuition_reminder_occurrences o WHERE o.rule_id=$3 AND o.invoice_id=$1 AND o.installment=(due.source->>'installment')::integer AND o.days_from_due=$2 AND o.source_stamp=due.source->>'sourceStamp') ORDER BY installment LIMIT 1`,[invoice.id,timing.daysFromDue,rule.id,definition.startsAt,definition.endsAt])).rows[0];
  if(!due){last=invoice.id;continue;}
  const receipt=(await ctx.db.query<{id:string}>(`INSERT INTO public.tuition_reminder_occurrences(academy_id,id,subscription_id,lease_token,rule_id,rule_version,invoice_id,installment,days_from_due,request_id)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT DO NOTHING RETURNING id`,[ctx.credential.academy_id,randomUUID(),subscription,lease,rule.id,rule.version,invoice.id,due.installment,timing.daysFromDue,ctx.requestId])).rows[0];
  if(!receipt){last=invoice.id;continue;}
  await record(ctx.db,ctx.credential,ctx.requestId,'tuition.reminder_due',invoice.id,due.hub_id,{reminderReceiptId:receipt.id,ruleId:rule.id,externalRequestMade:false});
  eventId=(await ctx.db.query<{event_id:string}>('SELECT event_id FROM public.automation_event_sources WHERE tuition_reminder_id=$1',[receipt.id])).rows[0]?.event_id??null;if(!eventId)throw new Error('TUITION_REMINDER_EVENT_REQUIRED');break;
 }
 await ctx.db.query(`INSERT INTO public.tuition_reminder_scans(academy_id,subscription_id,lease_token,last_invoice_id) VALUES($1,$2,$3,$4)
  ON CONFLICT(academy_id,subscription_id) DO UPDATE SET lease_token=excluded.lease_token,last_invoice_id=excluded.last_invoice_id`,[ctx.credential.academy_id,subscription,lease,invoices.length<100&&!eventId?null:last]);
 return eventId?boundAutomationEvent(ctx,eventId):null;
}
