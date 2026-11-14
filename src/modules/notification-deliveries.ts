import { z } from 'zod';
import { assignmentGrantsForPeople,type ApiContext,type Reply } from '../core/api.ts';
import type { Connection } from '../core/database.ts';
import { approvalReadPolicyParameters,approvalReadParameters,permissionScope,type ReadPolicyContext } from '../core/approvals.ts';
import { ApiError,scopeNonempty,type Capability } from '../core/policy.ts';
import { automationEventReadSelectionSQL,automationEventSourceJoinsSQL,automationEventCurrentSourceSQL } from './automation-events.ts';

const uuid=z.string().uuid().transform(v=>v.toLowerCase());
const query=z.object({limit:z.coerce.number().int().min(1).max(50).default(20),after:uuid.optional(),channel:z.enum(['email','sms']).optional(),status:z.enum(['queued','preparing','sending','accepted','cancelled','failed','unknown']).optional()}).strict();
const historyQuery=z.object({limit:z.coerce.number().int().min(1).max(50).default(20),beforeVersion:z.coerce.number().int().positive().max(2147483647).optional()}).strict();
const date=z.iso.date().refine(v=>!v.startsWith('0000'));
const monitoringFilters=z.object({channel:query.shape.channel,status:query.shape.status,ruleId:uuid.optional(),eventId:uuid.optional(),personId:uuid.optional(),from:date.optional(),through:date.optional(),attentionOnly:z.enum(['true','false']).transform(v=>v==='true').optional()}).strict().refine(v=>!v.from||!v.through||v.from<=v.through);
const monitoringQuery=monitoringFilters.safeExtend({limit:query.shape.limit,after:uuid.optional()});
const deliveryFields='d.id,d.event_id "eventId",d.channel,d.status,d.version,d.created_at "createdAt",d.changed_at "changedAt",d.expires_at "expiresAt",d.expires_at>statement_timestamp() "queueWindowOpen",d.last_error "lastError"';
const deliveryFlags={deliveryConfirmed:false,contactValuesIncluded:false,providerReferenceIncluded:false,automaticRetryAfterUncertainSend:false,externalDeliveryVerified:false};
const attentionSQL="(d.status IN('failed','unknown') OR(d.status IN('queued','preparing') AND d.expires_at<=statement_timestamp()))";
const monitoringFrom=`FROM public.notification_deliveries d JOIN public.automation_event_sources e ON e.academy_id=d.academy_id AND e.event_id=d.event_id ${automationEventSourceJoinsSQL} JOIN public.people recipient ON recipient.academy_id=d.academy_id AND recipient.id=d.person_id WHERE ${automationEventReadSelectionSQL} AND public.work_scope_allows($6::jsonb,recipient.hub_id,recipient.id) AND public.work_scope_allows($7::jsonb,recipient.hub_id,recipient.id)`;
const monitoringFilterSQL=` AND($8::text IS NULL OR d.channel=$8) AND($9::text IS NULL OR d.status=$9) AND($10::uuid IS NULL OR d.rule_id=$10) AND($11::uuid IS NULL OR d.event_id=$11) AND($12::uuid IS NULL OR d.person_id=$12) AND($13::date IS NULL OR d.created_at>=($13::date::timestamp AT TIME ZONE 'UTC')) AND($14::date IS NULL OR d.created_at<(($14::date+1)::timestamp AT TIME ZONE 'UTC')) AND(NOT $15::boolean OR ${attentionSQL})`;
async function deliveryHistory(ctx:ApiContext,id:string,q:z.infer<typeof historyQuery>){
 const rows=(await ctx.db.query<{version:number;state:unknown}>(`SELECT version,jsonb_build_object('status',definition->'status','lastError',definition->'lastError','changedAt',definition->'changedAt','attribution',definition->'attribution','deliveryConfirmed',false) state FROM public.notification_delivery_revisions WHERE delivery_id=$1 AND($2::integer IS NULL OR version<$2) ORDER BY version DESC LIMIT $3`,[id,q.beforeVersion??null,q.limit+1])).rows;
 return {status:200,body:{data:rows.slice(0,q.limit),nextCursor:rows.length>q.limit?rows[q.limit-1].version:null,...deliveryFlags}};
}
// Supervision is read-only and separate from a person's private self inbox.
// Intersect this feature,recipient visibility and ORIGINAL source rights before
// paging or counting. A bot uses its actual current grants and token ceiling.
async function monitorDeliveries(ctx:ApiContext):Promise<Reply|null>{
 const m=/^automations\/deliveries(?:\/(summary|[^/]+)(?:\/(history))?)?$/.exec(ctx.path);if(!m)return null;
 if(ctx.request.method!=='GET')throw new ApiError(405,'METHOD_NOT_ALLOWED');
 const scopes=['notification-deliveries.view','people.view'].map(cap=>permissionScope(ctx,cap as Capability));if(scopes.some(s=>!scopeNonempty(s)))throw new ApiError(403,'FORBIDDEN');
 const params=new URL(ctx.request.url).searchParams;if([...params].length!==new Set(params.keys()).size)throw new ApiError(400,'DUPLICATE_QUERY');
 const policy=[...await approvalReadParameters(ctx),...scopes.map(s=>JSON.stringify(s))],flags={...deliveryFlags,scope:'current_authorized_records_only',readDoesNotResolve:true,workerLiveness:'not_observed',queueDatesTimeZone:'UTC'};
 if(m[1]&&m[1]!=='summary'){
  const id=uuid.parse(m[1]),q=m[2]?historyQuery.parse(Object.fromEntries(params)):(z.object({}).strict().parse(Object.fromEntries(params)),null);
  const data=(await ctx.db.query(`SELECT ${deliveryFields},d.rule_id "ruleId",d.rule_version "ruleVersion",d.person_id "recipientPersonId",e.source_kind "sourceKind",${attentionSQL} "needsAttention",coalesce((e.source_kind<>'approval' OR p.version=e.source_version) AND(${automationEventCurrentSourceSQL}),false) "sourceStillCurrent" ${monitoringFrom} AND d.id=$8`,[...policy,id])).rows[0];if(!data)throw new ApiError(404,'NOT_FOUND');
  if(q){const history=await deliveryHistory(ctx,id,q);return {...history,body:{...history.body,...flags}};}return {status:200,body:{data,...flags}};
 }
 if(m[2])throw new ApiError(404,'NOT_FOUND');
 const summary=m[1]==='summary',q=summary?monitoringFilters.parse(Object.fromEntries(params)):monitoringQuery.parse(Object.fromEntries(params)),values=[...policy,q.channel??null,q.status??null,q.ruleId??null,q.eventId??null,q.personId??null,q.from??null,q.through??null,q.attentionOnly??false];
 if(summary){const data=(await ctx.db.query(`SELECT d.channel,d.status,count(*)::text count,count(*) FILTER(WHERE ${attentionSQL})::text "attentionCount" ${monitoringFrom}${monitoringFilterSQL} GROUP BY d.channel,d.status ORDER BY d.channel,d.status`,values)).rows;return {status:200,body:{data,...flags}};}
 const page=q as z.infer<typeof monitoringQuery>,rows=(await ctx.db.query<{id:string}>(`SELECT ${deliveryFields},d.rule_id "ruleId",d.rule_version "ruleVersion",d.person_id "recipientPersonId",e.source_kind "sourceKind",${attentionSQL} "needsAttention" ${monitoringFrom}${monitoringFilterSQL} AND($16::uuid IS NULL OR d.id>$16) ORDER BY d.id LIMIT $17`,[...values,page.after??null,page.limit+1])).rows;
 return {status:200,body:{data:rows.slice(0,page.limit),nextCursor:rows.length>page.limit?rows[page.limit-1].id:null,...flags}};
}
export const deliverySourceFrom=`FROM public.notification_deliveries d JOIN public.automation_event_sources e ON e.academy_id=d.academy_id AND e.event_id=d.event_id ${automationEventSourceJoinsSQL} WHERE d.person_id=$2 AND ${automationEventReadSelectionSQL}`;
// Only a read policy,not a session,Credential,master actor or writable ApiContext.
// Background delivery borrows neither the producer nor the service's grants.
export async function deliveryRecipientPolicy(db:Connection,personId:string){
 const person=(await db.query<{is_master:boolean}>("SELECT p.id=a.master_person_id is_master FROM public.people p JOIN public.academies a ON a.id=p.academy_id WHERE p.id=$1 AND p.kind='human' AND p.status='active' AND p.auth_user_id IS NOT NULL",[personId])).rows[0];if(!person)return null;
 const capabilities=(await db.query<{name:Capability}>('SELECT name FROM public.capability_catalog')).rows.map(r=>r.name),grants=person.is_master?capabilities.map(capability=>({capability,effect:'allow' as const,allHubs:true,hubIds:[]})):(await assignmentGrantsForPeople(db,[personId])).get(personId)??[];
 const policy:ReadPolicyContext={credential:{person_id:personId,kind:'human',capabilities,all_hubs:true,hub_ids:[]},grants};return approvalReadPolicyParameters(policy,person.is_master);
}
export async function notificationDeliveries(ctx:ApiContext):Promise<Reply|null>{
 const monitor=await monitorDeliveries(ctx);if(monitor)return monitor;
 const m=/^me\/notification-deliveries(?:\/([^/]+)(?:\/(history))?)?$/.exec(ctx.path);if(!m)return null;
 if(ctx.credential.kind!=='human')throw new ApiError(403,'HUMAN_ACCOUNT_REQUIRED');if(ctx.request.method!=='GET')throw new ApiError(405,'METHOD_NOT_ALLOWED');
 const id=m[1]?uuid.parse(m[1]):null,params=new URL(ctx.request.url).searchParams;if([...params].length!==new Set(params.keys()).size)throw new ApiError(400,'DUPLICATE_QUERY');
 const policy=[...await approvalReadParameters(ctx),ctx.credential.token_id],ownSource=deliverySourceFrom+" AND d.owner_epoch=public.notification_preference_identity($2,$6)->>'ownerEpoch'",flags=deliveryFlags;
 if(m[2]){
  const q=historyQuery.parse(Object.fromEntries(params));if(!(await ctx.db.query('SELECT d.id '+ownSource+' AND d.id=$7',[...policy,id])).rows.length)throw new ApiError(404,'NOT_FOUND');
  return deliveryHistory(ctx,id!,q);
 }
 const fields=deliveryFields;
 if(id){z.object({}).strict().parse(Object.fromEntries(params));const data=(await ctx.db.query('SELECT '+fields+' '+ownSource+' AND d.id=$7',[...policy,id])).rows[0];if(!data)throw new ApiError(404,'NOT_FOUND');return {status:200,body:{data,...flags}};}
 const q=query.parse(Object.fromEntries(params));const rows=(await ctx.db.query<{id:string}>('SELECT '+fields+' '+ownSource+' AND($7::uuid IS NULL OR d.id>$7) AND($8::text IS NULL OR d.channel=$8) AND($9::text IS NULL OR d.status=$9) ORDER BY d.id LIMIT $10',[...policy,q.after??null,q.channel??null,q.status??null,q.limit+1])).rows;return {status:200,body:{data:rows.slice(0,q.limit),nextCursor:rows.length>q.limit?rows[q.limit-1].id:null,...flags}};
}
export const notificationDeliveriesContract=[
 {path:'/api/v1/automations/deliveries',method:'get',summary:'Read-only scoped human/bot delivery supervision:explicit notification-deliveries.view,recipient people.view and current original-source rights intersect BEFORE filters and paging. Metadata only,no contact/content/provider IDs. Accepted is not confirmed delivery;reading never retries or resolves.',querySchema:monitoringQuery},
 {path:'/api/v1/automations/deliveries/summary',method:'get',summary:'Exact filtered channel/status counts under the SAME current recipient/source rights,not school-wide counts or worker liveness. UTC inclusive created-date filters;failed,unknown and expired queued/preparing records need attention. Count strings preserve integer precision.',querySchema:monitoringFilters},
 {path:'/api/v1/automations/deliveries/{id}',method:'get',summary:'Current-authorized delivery metadata and source-currentness for a supervisor or API bot,never contact/content/lease/provider secrets. No retry,approval,payment or signing override.'},
 {path:'/api/v1/automations/deliveries/{id}/history',method:'get',summary:'Bounded immutable system state history under the same delivery/recipient/original-source read intersection. No content,contact or provider IDs;reading does not resolve or retry.',querySchema:historyQuery},
 {path:'/api/v1/me/notification-deliveries',method:'get',humanOnly:true,summary:'Own operational email/SMS queue metadata under current source permissions before paging;accepted means provider acceptance only,never confirmed delivery. No contacts,body,provider reference or generation hashes.',querySchema:query},
 {path:'/api/v1/me/notification-deliveries/{id}',method:'get',humanOnly:true,summary:'Own current-source-authorized queue status,never another person or school,provider credentials or delivered-to-person proof.'},
 {path:'/api/v1/me/notification-deliveries/{id}/history',method:'get',humanOnly:true,summary:'Immutable native-system delivery state history while the original source remains authorized;initial queue attribution links the approved rule dispatch,not a human inspection. No private provider IDs,contacts or content.',querySchema:historyQuery}
] as const;
