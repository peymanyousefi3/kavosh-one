import { createHash,randomUUID } from 'node:crypto';
import { z } from 'zod';
import { jsonBody,loadGrants,mutation,record,type ApiContext,type Reply } from './api.ts';
import { ApiError,scopeFor,scopeContains,scopeNonempty as nonempty,type Capability,type Credential,type Grant,type Scope } from './policy.ts';

const uuid=z.string().uuid().transform(value=>value.toLowerCase());
const version=z.number().int().min(1);
const capability=z.string().regex(/^[a-z][a-z0-9_-]*\.[a-z][a-z0-9_-]*$/).max(100);
const decisionInput=z.object({expectedVersion:version,decision:z.enum(['approve','reject']),reason:z.string().trim().min(1).max(2000)}).strict();
const withdrawInput=z.object({expectedVersion:version,reason:z.string().trim().min(1).max(2000)}).strict();
const paging=z.object({limit:z.coerce.number().int().min(1).max(100).default(50),after:uuid.optional(),status:z.enum(['pending','applied','rejected','withdrawn','stale']).optional()}).strict();
const resourceRef=z.object({id:uuid,hubId:uuid.nullable()}).strict();
const areaRef=z.object({kind:z.enum(['country','region','city']),id:uuid,countryId:uuid,regionId:uuid.nullable(),cityId:uuid.nullable()}).strict();
const storedScope=z.object({all:z.boolean(),hubs:z.array(uuid),excludedHubs:z.array(uuid).optional(),classes:z.array(resourceRef).optional(),people:z.array(resourceRef).optional(),excludedClasses:z.array(resourceRef).optional(),excludedPeople:z.array(resourceRef).optional(),areas:z.array(areaRef).optional(),excludedAreas:z.array(areaRef).optional()}).strict();
const storedCredential=z.object({token_id:uuid,academy_id:uuid,person_id:uuid,capabilities:z.array(capability),all_hubs:z.boolean(),hub_ids:z.array(uuid),allowed:z.boolean(),kind:z.enum(['human','bot']).optional()}).strict();
export interface Proposal {
  id:string;requester_id:string;requester_kind:'human'|'bot';credential_snapshot:unknown;grants_hash:string;
  dependency_hash:string;review_context:Record<string,unknown>;
  action:string;target_id:string;target_version:number;payload:unknown;scope:Scope;status:string;version:number;
  reason?:string|null;decision_code?:string|null;reviewer_id?:string|null;created_at?:Date|string;decided_at?:Date|string|null;
  privacy_capability?:Capability|null;
}

export interface ApprovalAction {
  requestCapability:Capability;
  policyChange?:boolean;
  privacyCapability?:Capability;
  // Authorization only: no writes/row locks. Runs before the policy lock and
  // again under that lock before a decision, including rejection, is applied.
  authorizeReviewer?(ctx:ApiContext,proposal:Proposal):Promise<void>;
  createdStatus?:200|201;
  validate(ctx:ApiContext,targetId:string,input:unknown,purpose:'request'|'review'):Promise<Scope>;
  dependencies(ctx:ApiContext,targetId:string,input:unknown):Promise<Record<string,unknown>>;
  apply(ctx:ApiContext,proposal:Proposal):Promise<unknown>;
}
export type ApprovalRegistry=Readonly<Record<string,ApprovalAction>>;
function getAction(registry:ApprovalRegistry,name:string) {
  if(!Object.hasOwn(registry,name))throw new ApiError(400,'UNKNOWN_ACTION');
  return registry[name];
}
export async function lockApprovalWrites(ctx:ApiContext,exclusive=false) {
  const mode=exclusive?'exclusive':'shared';
  if(ctx.policyLock==='exclusive'||ctx.policyLock===mode)return;
  if(ctx.policyLock)throw new Error('POLICY_LOCK_UPGRADE_FORBIDDEN');
  // Policy writes are exclusive; ordinary domain proposals can run concurrently
  // while preventing a permission change halfway through validation/application.
  const query=exclusive?'SELECT pg_advisory_xact_lock(hashtextextended($1,8))':'SELECT pg_advisory_xact_lock_shared(hashtextextended($1,8))';
  await ctx.db.query(query,[ctx.credential.academy_id]);
  ctx.grants=await loadGrants(ctx.db,ctx.credential);ctx.policyLock=mode;
}
function grantsHash(grants:Grant[]) {
  const rows=grants.map(g=>[g.capability,g.effect,g.allHubs,[...g.hubIds].sort(),...(g.classRefs?.length||g.personRefs?.length?
    [[...(g.classRefs??[])].sort((a,b)=>a.id.localeCompare(b.id)),[...(g.personRefs??[])].sort((a,b)=>a.id.localeCompare(b.id))]:[]),
    ...(g.areaRefs?.length?[['geography',[...g.areaRefs].sort((a,b)=>(a.kind+a.id).localeCompare(b.kind+b.id)),[...g.areaHubIds??[]].sort()]]:[])]).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return createHash('sha256').update(JSON.stringify(rows)).digest('hex');
}
function stateHash(value:unknown){return createHash('sha256').update(JSON.stringify(value)).digest('hex');}
export async function master(ctx:ApiContext) {
  return ctx.credential.kind==='human'&&(await ctx.db.query('SELECT 1 FROM public.academies WHERE master_person_id=$1',[ctx.credential.person_id])).rows.length===1;
}
export function permissionScope(ctx:ApiContext,name:Capability){return scopeFor(ctx.credential,ctx.grants,name);}

export async function propose(ctx:ApiContext,registry:ApprovalRegistry,action:string,targetId:string|null,targetVersion:number,input:unknown):Promise<Reply> {
  const definition=getAction(registry,action);
  if(!nonempty(permissionScope(ctx,definition.requestCapability)))throw new ApiError(403,'FORBIDDEN');
  await lockApprovalWrites(ctx,definition.policyChange??false);
  const allocatedTarget=targetId??randomUUID();
  const scope=await definition.validate(ctx,allocatedTarget,input,'request');
  if(!nonempty(scope))throw new ApiError(403,'FORBIDDEN');
  return mutation(ctx,{input,targetVersion},async()=>{
    const actualTarget=allocatedTarget,reviewContext=await definition.dependencies(ctx,actualTarget,input);
    const p:Proposal={id:randomUUID(),requester_id:ctx.credential.person_id,requester_kind:ctx.credential.kind??'bot',
      credential_snapshot:ctx.credential,grants_hash:grantsHash(ctx.grants),dependency_hash:stateHash(reviewContext),review_context:reviewContext,
      action,target_id:actualTarget,target_version:targetVersion,
      payload:input,scope,status:'pending',version:1,privacy_capability:definition.privacyCapability??null};
    await ctx.db.query(`INSERT INTO public.approval_requests(academy_id,id,requester_id,requester_kind,credential_snapshot,grants_hash,action,target_id,target_version,payload,scope,dependency_hash,review_context,privacy_capability)
      VALUES($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12,$13::jsonb,$14)`,[ctx.credential.academy_id,p.id,p.requester_id,p.requester_kind,JSON.stringify(p.credential_snapshot),p.grants_hash,action,p.target_id,targetVersion,JSON.stringify(input),JSON.stringify(scope),p.dependency_hash,JSON.stringify(reviewContext),p.privacy_capability]);
    if(await master(ctx)) {
      const result=await definition.apply(ctx,p);
      await ctx.db.query("UPDATE public.approval_requests SET status='applied',version=version+1,reviewer_id=$2,reason='Master self-approved',decided_at=now() WHERE id=$1",[p.id,ctx.credential.person_id]);
      await record(ctx.db,ctx.credential,ctx.requestId,'approval.applied',p.id,null,{action,targetId:p.target_id,selfApproved:true});
      return {status:definition.createdStatus??200,body:{data:result,approval:{id:p.id,status:'applied',selfApproved:true}}};
    }
    await record(ctx.db,ctx.credential,ctx.requestId,'approval.requested',p.id,null,{action,targetId:p.target_id,scope});
    return {status:202,body:{approval:{id:p.id,status:'pending',version:1}}};
  });
}
async function visibleProposal(ctx:ApiContext,p:Proposal,review=false) {
  if(await master(ctx))return true;
  if(p.privacy_capability&&!scopeContains(permissionScope(ctx,p.privacy_capability),storedScope.parse(p.scope)))return false;
  if(!review&&p.requester_id===ctx.credential.person_id)return true;
  const scope=permissionScope(ctx,review?'approvals.review':'approvals.view');
  if(!nonempty(scope)||!scopeContains(scope,storedScope.parse(p.scope)))return false;
  return (await ctx.db.query<{valid:boolean}>('SELECT public.is_supervisor($1,$2) AS valid',[ctx.credential.person_id,p.requester_id])).rows[0]?.valid===true;
}
async function decide(ctx:ApiContext,registry:ApprovalRegistry,p:Proposal,input:z.infer<typeof decisionInput>):Promise<Reply> {
  if(ctx.credential.kind!=='human')throw new ApiError(403,'HUMAN_REVIEW_REQUIRED');
  if(p.requester_id===ctx.credential.person_id&&!await master(ctx))throw new ApiError(403,'SELF_APPROVAL_FORBIDDEN');
  if(!await visibleProposal(ctx,p,true))throw new ApiError(403,'SUPERVISOR_REQUIRED');
  // Caller-specific conflicts must reject the attempt, not invalidate a valid
  // case that a different upper reviewer can still approve.
  if(Object.hasOwn(registry,p.action))await registry[p.action].authorizeReviewer?.(ctx,p);
  return mutation(ctx,input,async()=>{
    const current=(await ctx.db.query<Proposal>('SELECT * FROM public.approval_requests WHERE id=$1 FOR UPDATE',[p.id])).rows[0];
    if(current.status!=='pending'||current.version!==input.expectedVersion)throw new ApiError(409,'APPROVAL_CHANGED');
    let status='rejected',result:unknown=null,decisionCode:string|null=null;
    if(input.decision==='approve') {
      const definition=Object.hasOwn(registry,current.action)?registry[current.action]:null;
      if(!definition){status='stale';decisionCode='ACTION_UNAVAILABLE';}
      const snapshot=storedCredential.parse(current.credential_snapshot) as Credential;
      const active=(await ctx.db.query('SELECT 1 FROM public.people WHERE id=$1 AND status=\'active\'',[current.requester_id])).rows.length;
      let authority=snapshot;
      if(current.requester_kind==='bot') {
        const live=(await ctx.db.query<Credential>('SELECT * FROM public.current_bot_scope($1)',[snapshot.token_id])).rows[0];
        if(!live||live.person_id!==current.requester_id||live.academy_id!==ctx.credential.academy_id){status='stale';decisionCode='CREDENTIAL_REVOKED';}else authority=live;
      }
      if(!active){status='stale';decisionCode='REQUESTER_INACTIVE';}
      if(grantsHash(await loadGrants(ctx.db,authority))!==current.grants_hash){status='stale';decisionCode='AUTHORITY_CHANGED';}
      if(definition&&stateHash(await definition.dependencies(ctx,current.target_id,current.payload))!==current.dependency_hash){status='stale';decisionCode='DEPENDENCIES_CHANGED';}
      if(status!=='stale') {
        const requesterContext={...ctx,credential:authority,grants:await loadGrants(ctx.db,authority)};
        try {
          const requesterScope=await definition!.validate(requesterContext,current.target_id,current.payload,'request');
          const reviewerScope=await definition!.validate(ctx,current.target_id,current.payload,'review');
          if(!scopeContains(requesterScope,storedScope.parse(current.scope))||!scopeContains(reviewerScope,storedScope.parse(current.scope)))throw new ApiError(403,'AUTHORITY_CHANGED');
          // All validation happens before application; savepoint also protects against
          // optimistic-lock or constraint failures partway through a domain write.
          await ctx.db.query('SAVEPOINT approval_apply');
          try{result=await definition!.apply(ctx,current);await ctx.db.query('RELEASE SAVEPOINT approval_apply');status='applied';}
          catch(error){await ctx.db.query('ROLLBACK TO SAVEPOINT approval_apply');await ctx.db.query('RELEASE SAVEPOINT approval_apply');throw error;}
        } catch(error) {
          if(error instanceof ApiError&&[403,404,409].includes(error.status)){status='stale';decisionCode=error.code;}else throw error;
        }
      }
    }
    await ctx.db.query('UPDATE public.approval_requests SET status=$2,version=version+1,reviewer_id=$3,reason=$4,decision_code=$5,decided_at=now() WHERE id=$1',[current.id,status,ctx.credential.person_id,input.reason,decisionCode]);
    await record(ctx.db,ctx.credential,ctx.requestId,'approval.'+status,current.id,null,{before:'pending',after:status,...current.privacy_capability?{hasReason:true}:{reason:input.reason},decisionCode,action:current.action,targetId:current.target_id});
    return {status:status==='stale'?409:200,body:{approval:{id:current.id,status,version:current.version+1,reason:input.reason,decisionCode},...(result?{data:result}:{})}};
  });
}

function proposalView(p:Proposal) {
  return {id:p.id,action:p.action,targetId:p.target_id,targetVersion:p.target_version,requesterId:p.requester_id,
    payload:p.payload,scope:p.scope,status:p.status,version:p.version,reason:p.reason??null,decisionCode:p.decision_code??null,
    reviewContext:p.review_context,
    reviewerId:p.reviewer_id??null,createdAt:p.created_at,decidedAt:p.decided_at??null,...p.privacy_capability?{privacyCapability:p.privacy_capability}:{}};
}


export async function approvalRoutes(ctx:ApiContext,registry:ApprovalRegistry):Promise<Reply|null> {
  const {request,path,db,credential:c}=ctx;
  if(path!=='approvals'&&!path.startsWith('approvals/'))return null;
  if(path==='approvals'&&request.method==='GET') {
    const {limit,after,status}=paging.parse(Object.fromEntries(new URL(request.url).searchParams));
    const scope=permissionScope(ctx,'approvals.view');
    // Retired action handlers must not make authorized private history vanish.
    // Use existing grants, not only the currently mounted action definitions.
    const privateCaps=[...new Set(ctx.grants.filter(g=>g.effect==='allow'&&c.capabilities.includes(g.capability)).map(g=>g.capability))];
    const privateScopes=Object.fromEntries(privateCaps.map(cap=>[cap,permissionScope(ctx,cap)]));
    const rows=(await db.query<Proposal>(`SELECT * FROM public.approval_requests WHERE ($1::uuid IS NULL OR id>$1)
      AND ($2::text IS NULL OR status=$2) AND ($4::boolean OR
        ((privacy_capability IS NULL OR public.scope_contains(coalesce($8::jsonb->privacy_capability,'{"all":false,"hubs":[]}'::jsonb),scope))
          AND (requester_id=$5 OR ($6::boolean AND public.scope_contains($7::jsonb,scope) AND public.is_supervisor($5,requester_id))))) ORDER BY id LIMIT $3`,
      [after??null,status??null,limit+1,await master(ctx),c.person_id,nonempty(scope),JSON.stringify(scope),JSON.stringify(privateScopes)])).rows;
    return {status:200,body:{data:rows.slice(0,limit).map(proposalView),nextCursor:rows.length>limit?rows[limit-1].id:null}};
  }
  const approvalPath=/^approvals\/([^/]+)(?:\/(decide|withdraw))?$/.exec(path);
  if(approvalPath) {
    const id=uuid.parse(approvalPath[1]);
    const p=(await db.query<Proposal>('SELECT * FROM public.approval_requests WHERE id=$1',[id])).rows[0];
    if(!p)throw new ApiError(404,'NOT_FOUND');
    if(!await visibleProposal(ctx,p))throw new ApiError(404,'NOT_FOUND');
    if(request.method==='POST'&&approvalPath[2]==='decide') {
      if(c.kind!=='human')throw new ApiError(403,'HUMAN_REVIEW_REQUIRED');
      if(p.requester_id===c.person_id&&!await master(ctx))throw new ApiError(403,'SELF_APPROVAL_FORBIDDEN');
      if(!await visibleProposal(ctx,p,true))throw new ApiError(403,'SUPERVISOR_REQUIRED');
      if(Object.hasOwn(registry,p.action))await registry[p.action].authorizeReviewer?.(ctx,p);
    }
    if(request.method==='POST'&&approvalPath[2]==='withdraw'&&p.requester_id!==c.person_id)throw new ApiError(403,'REQUESTER_REQUIRED');
    if(request.method!=='GET')await lockApprovalWrites(ctx,Object.hasOwn(registry,p.action)?registry[p.action].policyChange??false:true);
    if(!await visibleProposal(ctx,p))throw new ApiError(404,'NOT_FOUND');
    if(request.method==='GET'&&!approvalPath[2])return {status:200,body:{data:proposalView(p)}};
    if(request.method==='POST'&&approvalPath[2]==='decide')return decide(ctx,registry,p,decisionInput.parse(await jsonBody(request)));
    if(request.method==='POST'&&approvalPath[2]==='withdraw') {
      if(p.requester_id!==c.person_id)throw new ApiError(403,'REQUESTER_REQUIRED');
      const input=withdrawInput.parse(await jsonBody(request));
      return mutation(ctx,input,async()=>{
        const updated=await db.query("UPDATE public.approval_requests SET status='withdrawn',version=version+1,reason=$3,decided_at=now() WHERE id=$1 AND version=$2 AND status='pending' RETURNING id",[id,input.expectedVersion,input.reason]);
        if(!updated.rows.length)throw new ApiError(409,'APPROVAL_CHANGED');
        await record(db,c,ctx.requestId,'approval.withdrawn',id,null,p.privacy_capability?{hasReason:true}:{reason:input.reason});
        return {status:200,body:{approval:{id,status:'withdrawn',version:input.expectedVersion+1}}};
      });
    }
  }

  throw new ApiError(405,'METHOD_NOT_ALLOWED');
}
export const approvalContract=[
  {path:'/api/v1/approvals',method:'get',summary:'Own and authorized subordinate cases, filtered before pagination',paged:true},
  {path:'/api/v1/approvals/{id}',method:'get',summary:'Read exact payload, reason, review history and stale decision code'},
  {path:'/api/v1/approvals/{id}/decide',method:'post',summary:'Human upper reviewer accepts/rejects exact unchanged proposal',schema:decisionInput},
  {path:'/api/v1/approvals/{id}/withdraw',method:'post',summary:'Requester withdraws a still-pending proposal',schema:withdrawInput}
] as const;

