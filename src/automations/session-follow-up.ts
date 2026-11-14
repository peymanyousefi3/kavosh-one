import { randomUUID } from 'node:crypto';
import { record,type ApiContext } from '../core/api.ts';
import { approvalReadParameters } from '../core/approvals.ts';
import type { AutomationDefinition } from '../core/automation-rules.ts';
import { boundAutomationEvent,sessionEvidenceSelectionSQL } from '../modules/automation-events.ts';

export async function nextSessionFollowUp(ctx:ApiContext,subscription:string,lease:string,rule:{id:string;version:number;hub_id:string|null},definition:AutomationDefinition){
 const timing=definition.sessionFollowUp;if(!timing||!definition.enabled||definition.execution.mode!=='automatic')return null;
 const cursor=(await ctx.db.query<{at:string|null;id:string|null}>('SELECT last_ends_at::text at,last_session_id id FROM public.session_follow_up_scans WHERE subscription_id=$1',[subscription])).rows[0],policy=await approvalReadParameters(ctx),row=(await ctx.db.query<{id:string;hub_id:string;ends_at:string;eligible:boolean}>(`WITH candidates AS MATERIALIZED(
 SELECT s.id,s.class_id,s.hub_id,s.ends_at FROM public.class_sessions s WHERE s.status='scheduled' AND $2::uuid IS NOT NULL AND($4::uuid IS NULL OR s.hub_id=$4)
 AND($8::timestamptz IS NULL OR statement_timestamp()>=$8) AND($9::timestamptz IS NULL OR statement_timestamp()<=$9)
 AND s.ends_at<=statement_timestamp()-$6::integer*interval '1 minute' AND s.ends_at>statement_timestamp()-($6::integer+$7::integer)*interval '1 minute'
 AND($1::boolean OR ${sessionEvidenceSelectionSQL("jsonb_build_object('classId',s.class_id,'hubId',s.hub_id)",'$3::jsonb')}) AND($10::timestamptz IS NULL OR(s.ends_at,s.id)>($10::timestamptz,$11::uuid)) ORDER BY s.ends_at,s.id LIMIT 100
 ),sources AS MATERIALIZED(SELECT c.*,public.session_follow_up_source(c.id) source FROM candidates c),chosen AS MATERIALIZED(
 SELECT c.id,c.hub_id,c.ends_at::text ends_at,true eligible FROM sources c WHERE c.source IS NOT NULL
 AND NOT EXISTS(SELECT 1 FROM public.session_follow_up_occurrences o WHERE o.rule_id=$5 AND o.session_id=c.id AND o.minutes_after=$6 AND o.max_delay_minutes=$7 AND o.source_stamp=c.source#>>'{followUp,stamp}') ORDER BY c.ends_at,c.id LIMIT 1)
 SELECT * FROM chosen UNION ALL(SELECT c.id,c.hub_id,c.ends_at::text,false FROM candidates c WHERE NOT EXISTS(SELECT 1 FROM chosen) ORDER BY c.ends_at DESC,c.id DESC LIMIT 1)`,[policy[0],policy[1],policy[4],rule.hub_id,rule.id,timing.minutesAfter,timing.maxDelayMinutes,definition.startsAt,definition.endsAt,cursor?.at??null,cursor?.id??null])).rows[0];
 await ctx.db.query('INSERT INTO public.session_follow_up_scans(academy_id,subscription_id,lease_token,last_ends_at,last_session_id) VALUES($1,$2,$3,$4,$5) ON CONFLICT(academy_id,subscription_id) DO UPDATE SET lease_token=EXCLUDED.lease_token,last_ends_at=EXCLUDED.last_ends_at,last_session_id=EXCLUDED.last_session_id',[ctx.credential.academy_id,subscription,lease,row?.ends_at??null,row?.id??null]);if(!row?.eligible)return null;
 const receipt=(await ctx.db.query<{id:string}>(`INSERT INTO public.session_follow_up_occurrences(academy_id,id,subscription_id,lease_token,rule_id,rule_version,session_id,request_id,minutes_after,max_delay_minutes) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT DO NOTHING RETURNING id`,[ctx.credential.academy_id,randomUUID(),subscription,lease,rule.id,rule.version,row.id,ctx.requestId,timing.minutesAfter,timing.maxDelayMinutes])).rows[0];if(!receipt)return null;
 await record(ctx.db,ctx.credential,ctx.requestId,'session.follow_up_due',row.id,row.hub_id,{followUpReceiptId:receipt.id,ruleId:rule.id,severity:'critical',externalRequestMade:false});
 const event=(await ctx.db.query<{id:string}>("SELECT event_id id FROM public.automation_event_sources WHERE event_type='session.follow_up_due' AND projection#>>'{attributes,followUp,receiptId}'=$1",[receipt.id])).rows[0];if(!event)throw new Error('SESSION_FOLLOW_UP_EVENT_REQUIRED');return boundAutomationEvent(ctx,event.id);
}
