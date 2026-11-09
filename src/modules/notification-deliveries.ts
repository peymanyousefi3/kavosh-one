import { z } from 'zod';
import { assignmentGrantsForPeople,type ApiContext,type Reply } from '../core/api.ts';
import type { Connection } from '../core/database.ts';
import { approvalReadPolicyParameters,approvalReadParameters,type ReadPolicyContext } from '../core/approvals.ts';
import { ApiError,type Capability } from '../core/policy.ts';
import { automationEventReadSelectionSQL,automationEventSourceJoinsSQL } from './automation-events.ts';

const uuid=z.string().uuid().transform(v=>v.toLowerCase());
const query=z.object({limit:z.coerce.number().int().min(1).max(50).default(20),after:uuid.optional(),channel:z.enum(['email','sms']).optional(),status:z.enum(['queued','preparing','sending','accepted','cancelled','failed','unknown']).optional()}).strict();
const historyQuery=z.object({limit:z.coerce.number().int().min(1).max(50).default(20),beforeVersion:z.coerce.number().int().positive().max(2147483647).optional()}).strict();
export const deliverySourceFrom=`FROM public.notification_deliveries d JOIN public.automation_event_sources e ON e.academy_id=d.academy_id AND e.event_id=d.event_id ${automationEventSourceJoinsSQL} WHERE d.person_id=$2 AND ${automationEventReadSelectionSQL}`;
// Only a read policy,not a session,Credential,master actor or writable ApiContext.
// Background delivery borrows neither the producer nor the service's grants.
export async function deliveryRecipientPolicy(db:Connection,personId:string){
 const person=(await db.query<{is_master:boolean}>("SELECT p.id=a.master_person_id is_master FROM public.people p JOIN public.academies a ON a.id=p.academy_id WHERE p.id=$1 AND p.kind='human' AND p.status='active' AND p.auth_user_id IS NOT NULL",[personId])).rows[0];if(!person)return null;
 const capabilities=(await db.query<{name:Capability}>('SELECT name FROM public.capability_catalog')).rows.map(r=>r.name),grants=person.is_master?capabilities.map(capability=>({capability,effect:'allow' as const,allHubs:true,hubIds:[]})):(await assignmentGrantsForPeople(db,[personId])).get(personId)??[];
 const policy:ReadPolicyContext={credential:{person_id:personId,kind:'human',capabilities,all_hubs:true,hub_ids:[]},grants};return approvalReadPolicyParameters(policy,person.is_master);
}
export async function notificationDeliveries(ctx:ApiContext):Promise<Reply|null>{
 const m=/^me\/notification-deliveries(?:\/([^/]+)(?:\/(history))?)?$/.exec(ctx.path);if(!m)return null;
 if(ctx.credential.kind!=='human')throw new ApiError(403,'HUMAN_ACCOUNT_REQUIRED');if(ctx.request.method!=='GET')throw new ApiError(405,'METHOD_NOT_ALLOWED');
 const id=m[1]?uuid.parse(m[1]):null,params=new URL(ctx.request.url).searchParams;if([...params].length!==new Set(params.keys()).size)throw new ApiError(400,'DUPLICATE_QUERY');
 const policy=[...await approvalReadParameters(ctx),ctx.credential.token_id],ownSource=deliverySourceFrom+" AND d.owner_epoch=public.notification_preference_identity($2,$6)->>'ownerEpoch'",flags={deliveryConfirmed:false,contactValuesIncluded:false,providerReferenceIncluded:false,automaticRetryAfterUncertainSend:false,externalDeliveryVerified:false};
 if(m[2]){
  const q=historyQuery.parse(Object.fromEntries(params));if(!(await ctx.db.query('SELECT d.id '+ownSource+' AND d.id=$7',[...policy,id])).rows.length)throw new ApiError(404,'NOT_FOUND');
  const rows=(await ctx.db.query<{version:number;state:unknown}>(`SELECT version,jsonb_build_object('status',definition->'status','lastError',definition->'lastError','changedAt',definition->'changedAt','attribution',definition->'attribution','deliveryConfirmed',false) state FROM public.notification_delivery_revisions WHERE delivery_id=$1 AND($2::integer IS NULL OR version<$2) ORDER BY version DESC LIMIT $3`,[id,q.beforeVersion??null,q.limit+1])).rows;return {status:200,body:{data:rows.slice(0,q.limit),nextCursor:rows.length>q.limit?rows[q.limit-1].version:null,...flags}};
 }
 const fields='d.id,d.event_id "eventId",d.channel,d.status,d.version,d.created_at "createdAt",d.changed_at "changedAt",d.expires_at "expiresAt",d.expires_at>clock_timestamp() "queueWindowOpen",d.last_error "lastError"';
 if(id){z.object({}).strict().parse(Object.fromEntries(params));const data=(await ctx.db.query('SELECT '+fields+' '+ownSource+' AND d.id=$7',[...policy,id])).rows[0];if(!data)throw new ApiError(404,'NOT_FOUND');return {status:200,body:{data,...flags}};}
 const q=query.parse(Object.fromEntries(params));const rows=(await ctx.db.query<{id:string}>('SELECT '+fields+' '+ownSource+' AND($7::uuid IS NULL OR d.id>$7) AND($8::text IS NULL OR d.channel=$8) AND($9::text IS NULL OR d.status=$9) ORDER BY d.id LIMIT $10',[...policy,q.after??null,q.channel??null,q.status??null,q.limit+1])).rows;return {status:200,body:{data:rows.slice(0,q.limit),nextCursor:rows.length>q.limit?rows[q.limit-1].id:null,...flags}};
}
export const notificationDeliveriesContract=[
 {path:'/api/v1/me/notification-deliveries',method:'get',humanOnly:true,summary:'Own operational email/SMS queue metadata under current source permissions before paging;accepted means provider acceptance only,never confirmed delivery. No contacts,body,provider reference or generation hashes.',querySchema:query},
 {path:'/api/v1/me/notification-deliveries/{id}',method:'get',humanOnly:true,summary:'Own current-source-authorized queue status,never another person or school,provider credentials or delivered-to-person proof.'},
 {path:'/api/v1/me/notification-deliveries/{id}/history',method:'get',humanOnly:true,summary:'Immutable native-system delivery state history while the original source remains authorized;initial queue attribution links the approved rule dispatch,not a human inspection. No private provider IDs,contacts or content.',querySchema:historyQuery}
] as const;
