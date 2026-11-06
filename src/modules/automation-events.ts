import { z } from 'zod';
import type { ApiContext,Reply } from '../core/api.ts';
import { approvalReadParameters,approvalReadSelectionSQL,permissionScope } from '../core/approvals.ts';
import { ApiError,scopeNonempty } from '../core/policy.ts';
import type { RuleSample } from '../core/automation-rules.ts';

const uuid=z.string().uuid().transform(v=>v.toLowerCase()),instant=z.iso.datetime({offset:true});
const query=z.object({limit:z.coerce.number().int().min(1).max(100).default(50),afterOccurredAt:instant.optional(),afterId:uuid.optional(),approvalId:uuid.optional(),eventType:z.string().max(160).regex(/^[a-z][a-z0-9_-]*(?:\.[a-z][a-z0-9_-]*)+$/).optional(),sourceKind:z.enum(['approval','audit','session']).optional()}).strict().refine(v=>(v.afterOccurredAt===undefined)===(v.afterId===undefined));
export type BoundEvent={id:string;audit_id:string;approval_id:string|null;source_kind:'approval'|'audit'|'session';source_version:number;projection:RuleSample;occurred_at:string;current_source_version:number;current_status:string;source_current:boolean};
export const sessionCalendarSelectionSQL=(session:string,actor:string,scopes:string)=>`(public.scope_contains(coalesce(${scopes}->'classes.view','{"all":false,"hubs":[]}'::jsonb),jsonb_build_object('all',false,'hubs','[]'::jsonb,'classes',jsonb_build_array(jsonb_build_object('id',${session}->'classId','hubId',${session}->'hubId')))) OR public.session_calendar_person((${session}->>'sessionId')::uuid,${actor},coalesce(${scopes}->'received-calendar.view','{"all":false,"hubs":[]}'::jsonb)))`;
// Audit envelopes expose only metadata already available to a current auditor,
// never the audit changes. School-wide envelopes require unrestricted scope.
// Reused for event readers,queue visibility,inboxes and recipient resolution.
export const automationEventReadSelectionSQL=`((e.source_kind='approval' AND ${approvalReadSelectionSQL}) OR(e.source_kind='audit' AND($1::boolean OR public.scope_contains(coalesce($5::jsonb->'audit.view','{"all":false,"hubs":[]}'::jsonb),jsonb_build_object('all',e.hub_id IS NULL,'hubs',CASE WHEN e.hub_id IS NULL THEN '[]'::jsonb ELSE jsonb_build_array(e.hub_id) END)))) OR(e.source_kind='session' AND($1::boolean OR ${sessionCalendarSelectionSQL("(e.projection->'attributes')",'$2','$5::jsonb')})))`;
function scopeParameters(ctx:ApiContext){const s=permissionScope(ctx,'automations.view');if(!scopeNonempty(s))throw new ApiError(403,'FORBIDDEN');return [s.all,s.hubs,s.excludedHubs??[],!s.excludedAreas?.length];}
const selected=`((e.hub_id IS NULL AND $6::boolean AND cardinality($8::uuid[])=0 AND $9::boolean) OR(e.hub_id IS NOT NULL AND($6::boolean OR e.hub_id=ANY($7::uuid[])) AND NOT e.hub_id=ANY($8::uuid[])))`;
const columns=`e.event_id AS id,e.audit_id,e.approval_id,e.source_kind,e.source_version,e.projection,to_char(e.occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS occurred_at,CASE WHEN e.source_kind='audit' THEN 1 WHEN e.source_kind='session' THEN ss.version ELSE p.version END AS current_source_version,CASE WHEN e.source_kind='audit' THEN 'recorded' WHEN e.source_kind='session' THEN ss.status ELSE p.status END AS current_status,CASE WHEN e.source_kind='session' THEN coalesce((e.event_type<>'session.reminder_due' OR public.session_reminder_current(e.event_id)) AND ss.version=e.source_version AND sc.code=e.projection#>>'{attributes,classCode}' AND sc.name=e.projection#>>'{attributes,className}' AND sc.active=(e.projection#>>'{attributes,classActive}')::boolean AND sc.time_zone=e.projection#>>'{attributes,timeZone}',false) ELSE true END AS source_current`;
const from=`FROM public.automation_event_sources e LEFT JOIN public.approval_requests p ON p.academy_id=e.academy_id AND p.id=e.approval_id LEFT JOIN public.class_sessions ss ON ss.academy_id=e.academy_id AND ss.id=e.session_id LEFT JOIN public.classes sc ON sc.academy_id=ss.academy_id AND sc.id=ss.class_id WHERE ${automationEventReadSelectionSQL} AND ${selected}`;
export async function boundAutomationEvent(ctx:ApiContext,id:string){const e=(await ctx.db.query<BoundEvent>('SELECT '+columns+' '+from+' AND e.event_id=$10',[...await approvalReadParameters(ctx),...scopeParameters(ctx),id])).rows[0];if(!e)throw new ApiError(404,'NOT_FOUND');return e;}
export function requireCurrentSessionEvent(e:BoundEvent){if(e.source_kind==='session'&&!e.source_current)throw new ApiError(409,'AUTOMATION_SESSION_SOURCE_CHANGED');}
export async function lockCurrentSessionEvent(ctx:ApiContext,e:BoundEvent){
 if(e.source_kind!=='session')return e;
 // Same parent-then-session order as schedule changes. A cancellation cannot
 // slip between the final source check and committed portal delivery.
 await ctx.db.query('SELECT c.id FROM public.classes c JOIN public.class_sessions s ON s.academy_id=c.academy_id AND s.class_id=c.id WHERE s.id=$1 FOR SHARE OF c',[e.projection.entityId]);
 await ctx.db.query('SELECT id FROM public.class_sessions WHERE id=$1 FOR SHARE',[e.projection.entityId]);
 const current=await boundAutomationEvent(ctx,e.id);requireCurrentSessionEvent(current);return current;
}
// Internal watcher selection. Snapshot visibility catches late commits;the
// indexed xmin lower bound skips old epochs without trusting a time watermark.
export async function pendingSubscriptionEvent(ctx:ApiContext,subscriptionId:string,snapshot:string,activationTransaction:string){
 return (await ctx.db.query<BoundEvent>('SELECT '+columns+' '+from+` AND e.origin_transaction IS NOT NULL AND e.origin_transaction<>$12::xid8 AND e.origin_transaction>=pg_snapshot_xmin($11::pg_snapshot) AND NOT pg_visible_in_snapshot(e.origin_transaction,$11::pg_snapshot)
  AND NOT EXISTS(SELECT 1 FROM public.automation_subscription_events done WHERE done.academy_id=e.academy_id AND done.subscription_id=$10 AND done.event_id=e.event_id)
  ORDER BY e.origin_transaction,e.event_id LIMIT 1`,[...await approvalReadParameters(ctx),...scopeParameters(ctx),subscriptionId,snapshot,activationTransaction])).rows[0]??null;
}
export function boundEventView(e:BoundEvent){return {id:e.id,sourceKind:e.source_kind,sourceVersion:e.source_version,auditId:e.audit_id,approvalId:e.approval_id,recordedAt:e.occurred_at,sample:e.projection,sourceVerification:e.source_kind==='audit'?'database_bound_audit_event':e.source_kind==='session'?'database_bound_session_event':'database_bound_approval_event',underlyingBusinessFactsIndependentlyVerified:false,currentSourceVersion:e.current_source_version,currentStatus:e.current_status,sourceStateChanged:!e.source_current||e.current_source_version!==e.source_version,sessionSourceCurrent:e.source_kind==='session'?e.source_current:null,dispatchStateIncluded:false};}
export async function automationEvents(ctx:ApiContext):Promise<Reply|null>{
 const m=/^automations\/events(?:\/([^/]+))?$/.exec(ctx.path);if(!m)return null;if(ctx.request.method!=='GET')throw new ApiError(405,'METHOD_NOT_ALLOWED');
 if(m[1]){z.object({}).strict().parse(Object.fromEntries(new URL(ctx.request.url).searchParams));return {status:200,body:{data:boundEventView(await boundAutomationEvent(ctx,uuid.parse(m[1])))}};}
 const q=query.parse(Object.fromEntries(new URL(ctx.request.url).searchParams)),rows=(await ctx.db.query<BoundEvent>('SELECT '+columns+' '+from+' AND($10::timestamptz IS NULL OR(e.occurred_at,e.event_id)>($10::timestamptz,$11::uuid)) AND($12::uuid IS NULL OR e.approval_id=$12) AND($13::text IS NULL OR e.event_type=$13) AND($14::text IS NULL OR e.source_kind=$14) ORDER BY e.occurred_at,e.event_id LIMIT $15',[...await approvalReadParameters(ctx),...scopeParameters(ctx),q.afterOccurredAt??null,q.afterId??null,q.approvalId??null,q.eventType??null,q.sourceKind??null,q.limit+1])).rows;
 const tail=rows[q.limit-1];return {status:200,body:{data:rows.slice(0,q.limit).map(boundEventView),nextCursor:rows.length>q.limit?{afterOccurredAt:tail.occurred_at,afterId:tail.id}:null,supportedSources:['approval','audit','session'],legacyOrUnboundEventsIncluded:false,workerLiveness:'not_observed'}};
}
export const automationEventsContract=[
 {path:'/api/v1/automations/events',method:'get',summary:'Read bound approval events under case privacy or new audit-backed metadata under current audit scope,plus automation rights before pagination; no private audit changes,unbound events or delivery claims',querySchema:query},
 {path:'/api/v1/automations/events/{id}',method:'get',summary:'Immutable bound event snapshot plus current source-state drift; underlying business facts are not independently certified'}
] as const;
