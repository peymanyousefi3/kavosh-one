import { z } from 'zod';
import { jsonBody,mutation,record,type ApiContext,type Reply } from '../core/api.ts';
import { master,permissionScope,propose,type ApprovalRegistry,type Proposal } from '../core/approvals.ts';
import { ApiError,requireScope } from '../core/policy.ts';
import { automationRuleHeader } from './automation-rules.ts';
import { lockAcademyTopology } from './academy.ts';

const uuid=z.string().uuid().transform(v=>v.toLowerCase()),reason=z.string().trim().min(1).max(2000).refine(v=>v.isWellFormed()&&!v.includes('\0'));
const input=z.object({expectedVersion:z.number().int().positive().max(2147483647),locale:z.enum(['en','fr','zh-CN']).default('en'),reason}).strict(),payload=input.extend({ruleId:uuid}),empty=z.object({}).strict();
const paging=z.object({limit:z.coerce.number().int().min(1).max(100).default(25),after:uuid.optional()}).strict();
const columns='s.id,s.rule_id,s.rule_version,s.owner_id,s.owner_kind,s.locale,s.approval_id,s.status,s.failure_count,s.last_error,s.created_at,s.stopped_at';
type Subscription={id:string;rule_id:string;owner_id:string;status:string};
async function rule(ctx:ApiContext,id:string){const r=await automationRuleHeader(ctx,id);requireScope(permissionScope(ctx,'automations.execute'),r.hub_id??undefined);return r;}
async function basis(ctx:ApiContext,raw:unknown){const i=payload.parse(raw);await rule(ctx,i.ruleId);const source=(await ctx.db.query<{source:{version:number;enabled:boolean;mode:string;schoolActive:boolean;hubActive:boolean}|null}>('SELECT public.automation_subscription_source($1) source',[i.ruleId])).rows[0]?.source;if(!source||source.version!==i.expectedVersion||!source.enabled||source.mode!=='automatic'||!source.schoolActive||!source.hubActive)throw new ApiError(409,'SUBSCRIPTION_RULE_UNAVAILABLE');return {source};}
async function detail(ctx:ApiContext,id:string){const r=(await ctx.db.query<Subscription>('SELECT '+columns+' FROM public.automation_subscriptions s WHERE s.id=$1',[id])).rows[0];if(!r)throw new ApiError(404,'NOT_FOUND');const header=await automationRuleHeader(ctx,r.rule_id);return {...r,currentRuleVersion:header.version,workerLiveness:'not_observed',externalDeliveryEnabled:false};}
export const automationSubscriptionActions:ApprovalRegistry={'automation.subscription.create':{
 requestCapability:'automations.execute',privacyCapability:'automations.view',policyChange:true,createdStatus:201,
 async validate(ctx,_id,raw){await lockAcademyTopology(ctx);const i=payload.parse(raw),r=await rule(ctx,i.ruleId);return r.hub_id?{all:false,hubs:[r.hub_id]}:{all:true,hubs:[]};},
 async dependencies(ctx,_id,raw,purpose){try{return await basis(ctx,raw);}catch(error){if(purpose==='review'&&error instanceof ApiError&&[403,404,409].includes(error.status))return {unavailable:error.code};throw error;}},
 async authorizeReviewer(ctx,p){await rule(ctx,payload.parse(p.payload).ruleId);},
 async apply(ctx,p:Proposal){
  if(ctx.credential.kind!=='human')throw new ApiError(403,'HUMAN_REVIEW_REQUIRED');const i=payload.parse(p.payload),credential=uuid.parse((p.credential_snapshot as {token_id:unknown}).token_id);
  try{await ctx.db.query(`INSERT INTO public.automation_subscriptions(academy_id,id,rule_id,rule_version,owner_id,owner_kind,credential_id,user_id,locale,approval_id,reason)
   SELECT $1,$2,$3,$4,$5,$6,$7,auth_user_id,$8,$9,$10 FROM public.people WHERE id=$5`,[ctx.credential.academy_id,p.target_id,i.ruleId,i.expectedVersion,p.requester_id,p.requester_kind,credential,i.locale,p.id,i.reason]);}
  catch(error){const e=error as {code?:string;message?:string};if(e.code==='23505')throw new ApiError(409,'SUBSCRIPTION_ALREADY_ACTIVE');if(e.code==='23514'&&e.message==='SUBSCRIPTION_EXACT_APPROVAL_REQUIRED')throw new ApiError(409,'SUBSCRIPTION_SOURCE_CHANGED');throw error;}
  const r=await automationRuleHeader(ctx,i.ruleId);await record(ctx.db,ctx.credential,ctx.requestId,'automation.subscription.created',p.target_id,r.hub_id,{ruleId:i.ruleId,ownerId:p.requester_id,severity:'critical',startsAtActivation:true,externalRequestMade:false});return {...await detail(ctx,p.target_id),startsAtActivation:true,historicalBackfill:false,workerRequired:true,externalRequestMade:false};
 }
}};
export async function automationSubscriptions(ctx:ApiContext,registry:ApprovalRegistry=automationSubscriptionActions):Promise<Reply|null>{
 const collection=/^automations\/rules\/([^/]+)\/subscriptions$/.exec(ctx.path),item=/^automations\/subscriptions\/([^/]+)(?:\/(stop))?$/.exec(ctx.path);if(!collection&&!item)return null;
 const query=new URL(ctx.request.url).searchParams;if([...query].length!==new Set(query.keys()).size)throw new ApiError(400,'DUPLICATE_QUERY');const params=Object.fromEntries(query);
 if(collection){const ruleId=uuid.parse(collection[1]);
  if(ctx.request.method==='POST'){empty.parse(params);return propose(ctx,registry,'automation.subscription.create',null,0,{...input.parse(await jsonBody(ctx.request)),ruleId});}
  if(ctx.request.method!=='GET')throw new ApiError(405,'METHOD_NOT_ALLOWED');await automationRuleHeader(ctx,ruleId);const q=paging.parse(params),rows=(await ctx.db.query<{id:string}>('SELECT '+columns+' FROM public.automation_subscriptions s WHERE s.rule_id=$1 AND($2::uuid IS NULL OR s.id>$2) ORDER BY s.id LIMIT $3',[ruleId,q.after??null,q.limit+1])).rows;return {status:200,body:{data:rows.slice(0,q.limit),nextCursor:rows.length>q.limit?rows[q.limit-1].id:null}};
 }
 const id=uuid.parse(item![1]);empty.parse(params);
 if(item![2]){
  if(ctx.request.method!=='POST')throw new ApiError(405,'METHOD_NOT_ALLOWED');empty.parse(await jsonBody(ctx.request));await lockAcademyTopology(ctx);const r=await detail(ctx,id),owner=ctx.credential.person_id===r.owner_id;await rule(ctx,r.rule_id);
  if(!owner&&!await master(ctx)&&!(ctx.credential.kind==='human'&&(await ctx.db.query<{ok:boolean}>('SELECT public.is_supervisor($1,$2) ok',[ctx.credential.person_id,r.owner_id])).rows[0]?.ok))throw new ApiError(403,'UPPER_OR_OWNER_REQUIRED');
  return mutation(ctx,{},async()=>{const current=(await ctx.db.query<{status:string}>('SELECT status FROM public.automation_subscriptions WHERE id=$1 FOR NO KEY UPDATE',[id])).rows[0];if(current?.status!=='stopped'){const header=await automationRuleHeader(ctx,r.rule_id);await record(ctx.db,ctx.credential,ctx.requestId,'automation.subscription.stopped',id,header.hub_id,{severity:'critical',before:{status:current?.status},after:{status:'stopped'},doesNotCancelExistingJobs:true});await ctx.db.query("UPDATE public.automation_subscriptions SET status='stopped' WHERE id=$1",[id]);}return {status:200,body:{data:await detail(ctx,id),existingJobsCancelled:false}};});
 }
 if(ctx.request.method!=='GET')throw new ApiError(405,'METHOD_NOT_ALLOWED');return {status:200,body:{data:await detail(ctx,id)}};
}
export const automationSubscriptionsContract=[
 {path:'/api/v1/automations/rules/{id}/subscriptions',method:'post',summary:'Request an upper-reviewed persistent watcher owned by the current human session or scoped bot credential; starts at actual approval activation,not historical events,and follows current approved automatic-rule versions',schema:input},
 {path:'/api/v1/automations/rules/{id}/subscriptions',method:'get',summary:'Current-rule-authorized watcher status without session IDs,credential references,lease tokens or private transaction snapshots',querySchema:paging},
 {path:'/api/v1/automations/subscriptions/{id}',method:'get',summary:'Read current-authorized watcher status; human-session expiration or lost authority suspends background work'},
 {path:'/api/v1/automations/subscriptions/{id}/stop',method:'post',summary:'Owner or authorized upper human stops future watching; already queued notification jobs retain their separate cancellation controls',schema:empty}
] as const;
