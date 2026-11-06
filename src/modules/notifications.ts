import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { jsonBody,assignmentGrantsForPeople,mutation,record,type ApiContext,type Reply } from '../core/api.ts';
import { approvalReadParameters,approvalReadPolicyParameters,permissionScope } from '../core/approvals.ts';
import { ApiError,requireScope,type Capability } from '../core/policy.ts';
import { automationDefinition,ruleSample,simulateRule } from '../core/automation-rules.ts';
import { boundAutomationEvent,automationEventReadSelectionSQL,requireCurrentSessionEvent,type BoundEvent } from './automation-events.ts';
import { lockAcademyTopology } from './academy.ts';
import { automationRuleHeader,automationRuleRevision } from './automation-rules.ts';

const uuid=z.string().uuid().transform(v=>v.toLowerCase());
const locale=z.enum(['en','fr','zh-CN']);
const dispatch=z.object({eventId:uuid,expectedVersion:z.number().int().positive().max(2147483647),locale:z.enum(['en','fr','zh-CN']).default('en')}).strict();
const paging=z.object({limit:z.coerce.number().int().min(1).max(100).default(50),afterCreatedAt:z.iso.datetime({offset:true}).optional(),afterId:uuid.optional(),unread:z.enum(['true','false']).transform(v=>v==='true').optional(),origin:z.enum(['automation','mandatory']).optional(),locale:locale.default('en')}).strict().refine(v=>(v.afterCreatedAt===undefined)===(v.afterId===undefined));
const readInput=z.object({locale:locale.optional()}).strict();
const runPaging=z.object({limit:paging.shape.limit,afterCreatedAt:paging.shape.afterCreatedAt,afterId:paging.shape.afterId,eventId:uuid.optional()}).strict().refine(v=>(v.afterCreatedAt===undefined)===(v.afterId===undefined));
const empty=z.object({}).strict();
type Notification={id:string;title:string;body:string;severity:string;locale:string;origin:'automation'|'mandatory';source_id:string;source_kind:'approval'|'audit'|'session';event_id:string;created_at:string;read_at:string|null};
// Match current approval-case or audit-envelope rights,not the producer's snapshot. The
// recipient does not need permission to edit or inspect automation definitions.
const inboxFrom=`FROM public.portal_notifications n JOIN public.automation_event_sources e ON e.academy_id=n.academy_id AND e.event_id=n.event_id LEFT JOIN public.approval_requests p ON p.academy_id=e.academy_id AND p.id=e.approval_id LEFT JOIN public.portal_notification_reads rd ON rd.academy_id=n.academy_id AND rd.notification_id=n.id WHERE n.person_id=$2 AND ${automationEventReadSelectionSQL}`;
const fields=`n.id,n.title,n.body,n.severity,n.locale,n.origin,coalesce(e.approval_id,e.session_id,e.audit_id) AS source_id,e.source_kind,n.event_id,to_char(n.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at,rd.read_at`;
function human(ctx:ApiContext){if(ctx.credential.kind!=='human')throw new ApiError(403,'HUMAN_ACCOUNT_REQUIRED');}
const mandatoryLabels={en:{title:'Critical activity recorded',body:'Open the linked approval record to review this activity. Reading this notification does not approve or resolve it.'},fr:{title:'Activité critique enregistrée',body:'Ouvrez le dossier d’approbation associé pour examiner cette activité. Lire cette notification ne vaut ni approbation ni résolution.'},'zh-CN':{title:'已记录重要操作',body:'请打开关联的审批记录查看此操作。阅读本通知不会批准或解决该事项。'}};
function view(n:Notification,language:'en'|'fr'|'zh-CN'='en'){return {id:n.id,...(n.origin==='mandatory'?mandatoryLabels[language]:{title:n.title,body:n.body}),severity:n.severity,locale:n.origin==='mandatory'?language:n.locale,origin:n.origin,source:{kind:n.source_kind,id:n.source_id},eventId:n.event_id,createdAt:n.created_at,readAt:n.read_at,contentType:'text/plain',deliveryChannel:'portal'};}
async function own(ctx:ApiContext,id:string){human(ctx);const n=(await ctx.db.query<Notification>('SELECT '+fields+' '+inboxFrom+' AND n.id=$6',[...await approvalReadParameters(ctx),id])).rows[0];if(!n)throw new ApiError(404,'NOT_FOUND');return n;}
// Substitute only our five constant parameter names, never user SQL. This is
// the identical shared case predicate, evaluated for all recipient policies.
const recipientSelection=automationEventReadSelectionSQL.replace(/\$([1-5])\b/g,(_m,n:string)=>['r.is_master','r.person_id','r.has_approval_scope','r.approval_scope','r.private_scopes'][Number(n)-1]);
async function sessionAudiences(ctx:ApiContext,event:BoundEvent){
 if(event.source_kind!=='session')return [];
 // Current effective membership,not a saved roster or a person's primary hub.
 // The ordinary recipient policy below still independently gates every person.
 const rows=(await ctx.db.query<{kind:'session_guardians'|'session_staff';person_id:string}>(`WITH source AS MATERIALIZED(SELECT public.session_notification_source($1) s)
 SELECT DISTINCT 'session_guardians' AS kind,f.guardian_id AS person_id FROM source
 JOIN public.class_enrollments e ON e.class_id=(s->>'classId')::uuid AND e.enabled AND e.joins_on<=(s->>'on')::date AND(e.leaves_on IS NULL OR e.leaves_on>=(s->>'on')::date)
 JOIN public.family_relationships f ON f.academy_id=e.academy_id AND f.student_id=e.student_id AND f.relationship IN('parent','legal_guardian') AND f.state='approved'
 WHERE public.report_recipient(e.student_id,f.guardian_id)
 UNION SELECT 'session_staff',a.person_id FROM source JOIN public.class_staff a ON a.class_id=(s->>'classId')::uuid AND a.active AND a.starts_on<=(s->>'on')::date AND(a.ends_on IS NULL OR a.ends_on>=(s->>'on')::date)
 ORDER BY kind,person_id LIMIT 1001`,[event.projection.entityId])).rows;
 if(rows.length>1000)throw new ApiError(422,'AUTOMATION_RECIPIENT_SCAN_LIMIT');return rows;
}

export async function notifications(ctx:ApiContext):Promise<Reply|null>{
 const history=/^automations\/rules\/([^/]+)\/runs$/.exec(ctx.path);
 if(history){
  if(ctx.request.method!=='GET')throw new ApiError(405,'METHOD_NOT_ALLOWED');const id=uuid.parse(history[1]);await automationRuleHeader(ctx,id);const q=runPaging.parse(Object.fromEntries(new URL(ctx.request.url).searchParams));
  const rows=(await ctx.db.query<{id:string;created_at:string}>(`SELECT ar.id,ar.rule_version,ar.event_id,ar.actor_id,ar.outcome,ar.summary,to_char(ar.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at FROM public.automation_runs ar JOIN public.automation_event_sources e ON e.academy_id=ar.academy_id AND e.event_id=ar.event_id LEFT JOIN public.approval_requests p ON p.academy_id=e.academy_id AND p.id=e.approval_id WHERE ${automationEventReadSelectionSQL} AND ar.rule_id=$6 AND($7::timestamptz IS NULL OR(ar.created_at,ar.id)<($7::timestamptz,$8::uuid)) AND($9::uuid IS NULL OR ar.event_id=$9) ORDER BY ar.created_at DESC,ar.id DESC LIMIT $10`,[...await approvalReadParameters(ctx),id,q.afterCreatedAt??null,q.afterId??null,q.eventId??null,q.limit+1])).rows,tail=rows[q.limit-1];
  return {status:200,body:{data:rows.slice(0,q.limit),nextCursor:rows.length>q.limit?{afterCreatedAt:tail.created_at,afterId:tail.id}:null}};
 }
 const process=/^automations\/rules\/([^/]+)\/dispatch$/.exec(ctx.path);
 if(process){
  if(ctx.request.method!=='POST')throw new ApiError(405,'METHOD_NOT_ALLOWED');empty.parse(Object.fromEntries(new URL(ctx.request.url).searchParams));const id=uuid.parse(process[1]),input=dispatch.parse(await jsonBody(ctx.request));
  await lockAcademyTopology(ctx);const header=await automationRuleHeader(ctx,id);requireScope(permissionScope(ctx,'automations.execute'),header.hub_id??undefined);
  const locked=(await ctx.db.query<{version:number}>('SELECT version FROM public.automation_rules WHERE id=$1 FOR SHARE',[id])).rows[0];if(locked?.version!==header.version)throw new ApiError(409,'AUTOMATION_RULE_CHANGED');
  const event=await boundAutomationEvent(ctx,input.eventId);requireCurrentSessionEvent(event);
  // One rule lock makes duplicate checks, UTC-day budgets and cooldowns atomic
  // across API processes. Different rules remain concurrent.
  await ctx.db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,16))',[ctx.credential.academy_id+':'+id]);
  return mutation(ctx,{ruleId:id,...input},async()=>{
   const prior=(await ctx.db.query<{id:string;rule_version:number;outcome:string;summary:unknown}>('SELECT id,rule_version,outcome,summary FROM public.automation_runs WHERE rule_id=$1 AND event_id=$2',[id,event.id])).rows[0];
   if(prior)return {status:200,body:{data:{id:prior.id,ruleVersion:prior.rule_version,outcome:prior.outcome,summary:prior.summary,duplicate:true,externalRequestMade:false}}};
   if(header.version!==input.expectedVersion)throw new ApiError(409,'AUTOMATION_RULE_CHANGED');
   const revision=await automationRuleRevision(ctx,header),definition=automationDefinition.parse(revision.definition),simulation=simulateRule(definition,header.hub_id,ruleSample.parse(event.projection),input.locale);
   let outcome='processed',suppressed=0,unavailableChannels=0;const messages:{person:string;actionIndex:number;title:string;body:string;severity:string}[]=[];
   if(!simulation.eligibleByConfiguration)outcome='not_matched';else if(definition.execution.mode==='dry_run')outcome='dry_run';else if(definition.execution.mode==='approval_required')outcome='approval_required';
   if(outcome==='processed'){
    const master=(await ctx.db.query<{master_person_id:string}>('SELECT master_person_id FROM public.academies')).rows[0].master_person_id;
    const supervisors=event.projection.actorId&&simulation.actions.some(a=>a.audience.kind==='actor_supervisors')?(await ctx.db.query<{id:string}>('SELECT person_id AS id FROM public.supervisor_chain($1)',[event.projection.actorId])).rows.map(p=>p.id):[];
    const sessionRecipients=simulation.actions.some(a=>a.audience.kind==='session_guardians'||a.audience.kind==='session_staff')?await sessionAudiences(ctx,event):[],recordRecipients=new Set(sessionRecipients.map(p=>p.person_id));
    const audiences=simulation.actions.map(a=>a.audience.kind==='school_master'?[master]:a.audience.kind==='people'?a.audience.personIds:a.audience.kind==='actor_supervisors'?supervisors:sessionRecipients.filter(p=>p.kind===a.audience.kind).map(p=>p.person_id)),ids=[...new Set(audiences.flat())];
    if(ids.length>1000)throw new ApiError(422,'AUTOMATION_RECIPIENT_SCAN_LIMIT');
    const capabilities=(await ctx.db.query<{name:Capability}>('SELECT name FROM public.capability_catalog')).rows.map(c=>c.name);
    const people=(await ctx.db.query<{id:string;hub_id:string|null}>('SELECT id,hub_id FROM public.people WHERE id=ANY($1::uuid[]) AND kind=\'human\' AND status=\'active\' AND auth_user_id IS NOT NULL ORDER BY id',[ids])).rows;
    const grants=await assignmentGrantsForPeople(ctx.db,people.map(p=>p.id)),policies=[];
    // Bounded recipients share existing policy evaluation, without a query per
    // person. No producer/bot grants are lent to notification recipients.
    for(const person of people){if(header.hub_id!==null&&person.hub_id!==header.hub_id&&person.id!==master&&!recordRecipients.has(person.id))continue;
     const recipient={...ctx,credential:{...ctx.credential,person_id:person.id,kind:'human' as const,capabilities,all_hubs:true,hub_ids:[]},grants:person.id===master?capabilities.map(capability=>({capability,effect:'allow' as const,allHubs:true,hubIds:[]})):grants.get(person.id)??[]};
     const [is_master,person_id,has_approval_scope,approval_scope,private_scopes]=approvalReadPolicyParameters(recipient,person.id===master);policies.push({is_master,person_id,has_approval_scope,approval_scope:JSON.parse(approval_scope as string),private_scopes:JSON.parse(private_scopes as string)});
    }
    const eligible=new Set((await ctx.db.query<{person_id:string}>(`SELECT r.person_id FROM jsonb_to_recordset($1::jsonb) AS r(is_master boolean,person_id uuid,has_approval_scope boolean,approval_scope jsonb,private_scopes jsonb) CROSS JOIN public.automation_event_sources e LEFT JOIN public.approval_requests p ON p.academy_id=e.academy_id AND p.id=e.approval_id WHERE e.event_id=$2 AND ${recipientSelection}`,[JSON.stringify(policies),event.id])).rows.map(p=>p.person_id));
    if(eligible.size>definition.execution.maxRecipientsPerEvent)outcome='recipient_limit';else {
     const recent=definition.execution.cooldownSeconds?(await ctx.db.query<{person_id:string}>('SELECT DISTINCT person_id FROM public.portal_notifications WHERE rule_id=$1 AND created_at>transaction_timestamp()-($2::integer*interval \'1 second\')',[id,definition.execution.cooldownSeconds])).rows:[];const cooling=new Set(recent.map(p=>p.person_id));
     for(let actionIndex=0;actionIndex<simulation.actions.length;actionIndex++){const a=simulation.actions[actionIndex];unavailableChannels+=a.channels.filter(c=>c!=='portal').length;
      for(const person of [...new Set(audiences[actionIndex])].sort()){if(!eligible.has(person)){suppressed++;continue;}if(cooling.has(person)){suppressed++;continue;}if(a.channels.includes('portal'))messages.push({person,actionIndex,title:a.title,body:a.body,severity:a.effectiveSeverity});}
     }
     const used=(await ctx.db.query<{n:number}>('SELECT count(*)::integer AS n FROM public.portal_notifications WHERE rule_id=$1 AND created_at>=date_trunc(\'day\',transaction_timestamp() AT TIME ZONE \'UTC\') AT TIME ZONE \'UTC\' AND created_at<(date_trunc(\'day\',transaction_timestamp() AT TIME ZONE \'UTC\')+interval \'1 day\') AT TIME ZONE \'UTC\'',[id])).rows[0].n;
     if(used+messages.length>definition.execution.maxDailyDeliveries){outcome='daily_limit';messages.length=0;}
    }
   }
   const runId=randomUUID(),summary={portalNotifications:messages.length,suppressed,unavailableChannelActions:unavailableChannels,externalDelivery:'not_configured',budgetsUseUtcDay:true,recipientAuthorizationChecked:outcome==='processed',historicalSourceStateChanged:event.current_source_version!==event.source_version,executionDriver:ctx.notificationJobId?'background_job':'api_request',backgroundJobId:ctx.notificationJobId??null};
   await ctx.db.query('INSERT INTO public.automation_runs(academy_id,id,rule_id,rule_version,event_id,actor_id,outcome,summary) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb)',[ctx.credential.academy_id,runId,id,revision.version,event.id,ctx.credential.person_id,outcome,JSON.stringify(summary)]);
   // Batch writes keep the transaction bounded at the configured recipient cap.
   if(messages.length)await ctx.db.query(`INSERT INTO public.portal_notifications(academy_id,id,run_id,rule_id,event_id,person_id,action_index,severity,title,body,locale) SELECT $1,x.id,$2,$3,$4,x.person,x.action_index,x.severity,x.title,x.body,$5 FROM jsonb_to_recordset($6::jsonb) AS x(id uuid,person uuid,action_index integer,severity text,title text,body text)`,[ctx.credential.academy_id,runId,id,event.id,input.locale,JSON.stringify(messages.map(m=>({id:randomUUID(),person:m.person,action_index:m.actionIndex,severity:m.severity,title:m.title,body:m.body})))]);
   await record(ctx.db,ctx.credential,ctx.requestId,'automation.dispatched',runId,header.hub_id,{ruleId:id,eventId:event.id,outcome,portalNotifications:messages.length,severity:'critical',messageContentRedacted:true});
   return {status:201,body:{data:{id:runId,ruleVersion:revision.version,outcome,summary,duplicate:false,externalRequestMade:false}}};
  });
 }
 const match=/^notifications(?:\/([^/]+)(?:\/(read))?)?$/.exec(ctx.path);if(!match)return null;human(ctx);const id=match[1]?uuid.parse(match[1]):null;
 if(ctx.request.method==='POST'&&id&&match[2]==='read'){
  const input=readInput.parse(await jsonBody(ctx.request));await lockAcademyTopology(ctx);await own(ctx,id);
  return mutation(ctx,input,async()=>{await ctx.db.query('INSERT INTO public.portal_notification_reads(academy_id,notification_id,person_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[ctx.credential.academy_id,id,ctx.credential.person_id]);return {status:200,body:{data:view(await own(ctx,id),input.locale)}};});
 }
 if(ctx.request.method!=='GET'||match[2])throw new ApiError(405,'METHOD_NOT_ALLOWED');
 if(id){const q=readInput.parse(Object.fromEntries(new URL(ctx.request.url).searchParams));return {status:200,body:{data:view(await own(ctx,id),q.locale)}};}
 const q=paging.parse(Object.fromEntries(new URL(ctx.request.url).searchParams));
 const rows=(await ctx.db.query<Notification>('SELECT '+fields+' '+inboxFrom+' AND($6::timestamptz IS NULL OR(n.created_at,n.id)<($6::timestamptz,$7::uuid)) AND($8::boolean IS NULL OR(rd.notification_id IS NULL)=$8) AND($9::text IS NULL OR n.origin=$9) ORDER BY n.created_at DESC,n.id DESC LIMIT $10',[...await approvalReadParameters(ctx),q.afterCreatedAt??null,q.afterId??null,q.unread??null,q.origin??null,q.limit+1])).rows,tail=rows[q.limit-1];
 return {status:200,body:{data:rows.slice(0,q.limit).map(n=>view(n,q.locale)),nextCursor:rows.length>q.limit?{afterCreatedAt:tail.created_at,afterId:tail.id}:null,workerLiveness:'not_observed',backgroundProcessingSupported:true,mandatoryApprovalAlertsSupported:true,externalDeliveryEnabled:false}};
}
export const notificationsContract=[
 {path:'/api/v1/automations/rules/{id}/runs',method:'get',summary:'Immutable decision history, newest first, filtered by current rule and underlying case permissions before pagination; summaries never include recipient identities or message content',querySchema:runPaging},
 {path:'/api/v1/automations/rules/{id}/dispatch',method:'post',summary:'Process one actual source through the current approved rule with execute rights, durable deduplication, current recipient case permissions, UTC budgets and cooldowns; this immediate portal request starts no daemon and makes no external sends',schema:dispatch},
 {path:'/api/v1/notifications',method:'get',summary:'One human inbox for automatic critical-floor and custom-rule messages; current source permissions and optional origin/unread filters apply before pagination; mandatory labels support English,French,Simplified Chinese',querySchema:paging},
 {path:'/api/v1/notifications/{id}',method:'get',summary:'Read own portal notification and linked approval or audit ID only while its underlying source remains authorized',querySchema:readInput},
 {path:'/api/v1/notifications/{id}/read',method:'post',summary:'Idempotently mark an owned, current-authorized notification read; optional locale localizes mandatory labels, never approves or resolves a case',schema:readInput}
] as const;
