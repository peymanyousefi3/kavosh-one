import { createHash,randomUUID } from 'node:crypto';
import { z } from 'zod';
import { jsonBody,loadGrants,mutation,record,type ApiContext,type Reply } from '../core/api.ts';
import { ApiError,requireScope,scopeFor,type Capability,type Credential,type Grant,type Scope } from '../core/policy.ts';

const uuid=z.string().uuid().transform(value=>value.toLowerCase());
const version=z.number().int().min(1);
const capability=z.string().regex(/^[a-z][a-z0-9_-]*\.[a-z][a-z0-9_-]*$/).max(100);
const permission=z.object({capability,effect:z.enum(['allow','deny'])}).strict();
const roleInput=z.object({name:z.string().trim().min(1).max(150),description:z.string().trim().max(1000).default(''),permissions:z.array(permission).max(200)}).strict();
const roleUpdate=roleInput.extend({expectedVersion:version});
const assignment=z.object({roleId:uuid,allHubs:z.boolean(),hubIds:z.array(uuid).max(100)}).strict().superRefine((value,ctx)=>{
  if((value.allHubs&&value.hubIds.length)||(!value.allHubs&&!value.hubIds.length)||new Set(value.hubIds).size!==value.hubIds.length)
    ctx.addIssue({code:'custom',message:'Choose all hubs or a non-empty unique hub list.'});
});
const accessInput=z.object({expectedVersion:version,assignments:z.array(assignment).max(50)}).strict().refine(v=>new Set(v.assignments.map(a=>a.roleId)).size===v.assignments.length);
const supervisorInput=z.object({expectedVersion:version,supervisorId:uuid.nullable()}).strict();
const decisionInput=z.object({expectedVersion:version,decision:z.enum(['approve','reject']),reason:z.string().trim().min(1).max(2000)}).strict();
const withdrawInput=z.object({expectedVersion:version,reason:z.string().trim().min(1).max(2000)}).strict();
const paging=z.object({limit:z.coerce.number().int().min(1).max(100).default(50),after:uuid.optional(),status:z.enum(['pending','applied','rejected','withdrawn','stale']).optional()}).strict();
const storedScope=z.object({all:z.boolean(),hubs:z.array(uuid),excludedHubs:z.array(uuid).optional()}).strict();
const storedCredential=z.object({token_id:uuid,academy_id:uuid,person_id:uuid,capabilities:z.array(capability),all_hubs:z.boolean(),hub_ids:z.array(uuid),allowed:z.boolean(),kind:z.enum(['human','bot']).optional()}).strict();
type Permission=z.infer<typeof permission>;
type Action='role.create'|'role.update'|'access.replace'|'supervisor.set';
interface Proposal {
  id:string;requester_id:string;requester_kind:'human'|'bot';credential_snapshot:unknown;grants_hash:string;
  dependency_hash:string;review_context:Record<string,unknown>;
  action:Action;target_id:string;target_version:number;payload:unknown;scope:Scope;status:string;version:number;
  reason?:string|null;decision_code?:string|null;reviewer_id?:string|null;created_at?:Date|string;decided_at?:Date|string|null;
}

function scopeContains(source:Scope,target:Scope) {
  if(target.all)return source.all&&(source.excludedHubs??[]).every(h=>(target.excludedHubs??[]).includes(h));
  return target.hubs.every(h=>source.all?!source.excludedHubs?.includes(h):source.hubs.includes(h));
}
function nonempty(scope:Scope){return scope.all||scope.hubs.length>0;}
function grantsHash(grants:Grant[]) {
  const rows=grants.map(g=>[g.capability,g.effect,g.allHubs,[...g.hubIds].sort()]).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return createHash('sha256').update(JSON.stringify(rows)).digest('hex');
}
async function dependencies(ctx:ApiContext,action:Action,targetId:string,input:unknown):Promise<Record<string,unknown>> {
  if(action==='access.replace') {
    const next=accessInput.parse(input),prior=await assignments(ctx,targetId);
    const ids=[...new Set([...next.assignments.map(a=>a.roleId),...prior.map(a=>a.role_id)])];
    const roles=(await ctx.db.query(`SELECT r.id,r.name,r.version,
      coalesce(jsonb_agg(jsonb_build_object('capability',p.capability,'effect',p.effect) ORDER BY p.capability) FILTER(WHERE p.capability IS NOT NULL),'[]'::jsonb) AS permissions
      FROM public.roles r LEFT JOIN public.role_permissions p ON p.academy_id=r.academy_id AND p.role_id=r.id
      WHERE r.id=ANY($1::uuid[]) GROUP BY r.academy_id,r.id ORDER BY r.id`,[ids])).rows;
    return {roles};
  }
  if(action==='role.update') {
    const affected=(await ctx.db.query(`SELECT p.id,p.access_version FROM public.role_assignments a JOIN public.people p
      ON p.academy_id=a.academy_id AND p.id=a.person_id WHERE a.role_id=$1 ORDER BY p.id`,[targetId])).rows;
    return {affected};
  }
  return {};
}
function stateHash(value:unknown){return createHash('sha256').update(JSON.stringify(value)).digest('hex');}
async function master(ctx:ApiContext) {
  return ctx.credential.kind==='human'&&(await ctx.db.query('SELECT 1 FROM public.academies WHERE master_person_id=$1',[ctx.credential.person_id])).rows.length===1;
}
function permissionScope(ctx:ApiContext,name:Capability){return scopeFor(ctx.credential,ctx.grants,name);}
async function canManage(ctx:ApiContext,personId:string) {
  const target=(await ctx.db.query<{id:string;kind:string;status:string;hub_id:string|null;access_version:number;supervisor_person_id:string|null}>('SELECT id,kind,status,hub_id,access_version,supervisor_person_id FROM public.people WHERE id=$1',[personId])).rows[0];
  if(!target)throw new ApiError(404,'NOT_FOUND');
  if(await master(ctx))return target;
  if(personId===ctx.credential.person_id)throw new ApiError(403,'SELF_ACCESS_CHANGE_FORBIDDEN');
  let managerId=ctx.credential.person_id;
  if(ctx.credential.kind!=='human') {
    const owner=(await ctx.db.query<{id:string}>(`SELECT owner.id FROM public.people bot JOIN public.people owner
      ON owner.academy_id=bot.academy_id AND owner.id=bot.supervisor_person_id WHERE bot.id=$1 AND owner.kind='human' AND owner.status='active'`,[ctx.credential.person_id])).rows[0];
    if(!owner)throw new ApiError(403,'BOT_OWNER_REQUIRED');
    managerId=owner.id;
  }
  const upper=(await ctx.db.query<{valid:boolean}>('SELECT public.is_supervisor($1,$2) AS valid',[managerId,personId])).rows[0]?.valid;
  if(!upper)throw new ApiError(403,'SUPERVISOR_REQUIRED');
  requireScope(permissionScope(ctx,'access.edit'),target.hub_id??undefined);
  return target;
}
async function role(ctx:ApiContext,id:string) {
  const row=(await ctx.db.query<{id:string;name:string;description:string;version:number;system_role:boolean}>('SELECT id,name,description,version,system_role FROM public.roles WHERE id=$1',[id])).rows[0];
  if(!row)throw new ApiError(404,'NOT_FOUND');
  const permissions=(await ctx.db.query<{capability:Capability;effect:'allow'|'deny'}>('SELECT capability,effect FROM public.role_permissions WHERE role_id=$1 ORDER BY capability',[id])).rows;
  return {...row,permissions};
}
async function validatePermissions(ctx:ApiContext,permissions:Permission[]) {
  if(new Set(permissions.map(p=>p.capability)).size!==permissions.length)throw new ApiError(400,'DUPLICATE_PERMISSION');
  const registered=(await ctx.db.query<{name:string}>('SELECT name FROM public.capability_catalog')).rows.map(p=>p.name);
  for(const p of permissions) {
    if(!registered.includes(p.capability))throw new ApiError(400,'UNKNOWN_CAPABILITY');
    if(!await master(ctx)&&!nonempty(permissionScope(ctx,p.capability as Capability)))throw new ApiError(403,'DELEGATION_EXCEEDS_AUTHORITY');
  }
}
async function assignments(ctx:ApiContext,personId:string) {
  return (await ctx.db.query<{id:string;role_id:string;all_hubs:boolean;hub_ids:string[]}>(`SELECT a.id,a.role_id,a.all_hubs,
    ARRAY(SELECT h.hub_id FROM public.assignment_hubs h WHERE h.academy_id=a.academy_id AND h.assignment_id=a.id ORDER BY h.hub_id) AS hub_ids
    FROM public.role_assignments a WHERE person_id=$1 ORDER BY role_id`,[personId])).rows;
}
async function validateDelegatedAssignment(ctx:ApiContext,item:z.infer<typeof assignment>,permissions:Permission[]) {
  const targetScope={all:item.allHubs,hubs:item.hubIds};
  if(!scopeContains(permissionScope(ctx,'access.edit'),targetScope))throw new ApiError(403,'DELEGATION_EXCEEDS_SCOPE');
  const count=(await ctx.db.query<{id:string}>('SELECT id FROM public.hubs WHERE id=ANY($1::uuid[])',[item.hubIds])).rows.length;
  if(count!==item.hubIds.length)throw new ApiError(400,'INVALID_REFERENCE');
  for(const p of permissions)if(!scopeContains(permissionScope(ctx,p.capability as Capability),targetScope))throw new ApiError(403,'DELEGATION_EXCEEDS_AUTHORITY');
}
function actionCapability(action:Action):Capability{return action.startsWith('role.')?'roles.edit':'access.edit';}
async function validateAction(ctx:ApiContext,action:Action,targetId:string,input:unknown) {
  const scope=permissionScope(ctx,actionCapability(action));
  if(!nonempty(scope))throw new ApiError(403,'FORBIDDEN');
  if(action==='role.create'||action==='role.update') {
    // Templates are academy configuration; staff assignments remain hub-scoped.
    requireScope(scope);
    const body=roleInput.parse(input);await validatePermissions(ctx,body.permissions);
    if(action==='role.update') {
      const existing=await role(ctx,targetId);
      if(existing.system_role)throw new ApiError(403,'SYSTEM_ROLE_PROTECTED');
      const assigned=(await ctx.db.query<{person_id:string}>('SELECT person_id FROM public.role_assignments WHERE role_id=$1',[targetId])).rows;
      for(const row of assigned) {
        await canManage(ctx,row.person_id);
        for(const a of (await assignments(ctx,row.person_id)).filter(a=>a.role_id===targetId)) {
          await validateDelegatedAssignment(ctx,{roleId:targetId,allHubs:a.all_hubs,hubIds:a.hub_ids},body.permissions);
        }
      }
    }
  } else if(action==='access.replace') {
    const person=await canManage(ctx,targetId);
    if(person.status==='disabled')throw new ApiError(403,'PERSON_DISABLED');
    const body=accessInput.parse(input);
    for(const item of body.assignments) {
      const r=await role(ctx,item.roleId);
      if(r.system_role)throw new ApiError(403,'SYSTEM_ROLE_PROTECTED');
      await validateDelegatedAssignment(ctx,item,r.permissions);
    }
    // Replacing access must also cover what would be removed, not just new grants.
    const previous=await assignments(ctx,targetId);
    for(const item of previous) {
      if(!scopeContains(scope,{all:item.all_hubs,hubs:item.hub_ids}))throw new ApiError(403,'DELEGATION_EXCEEDS_SCOPE');
    }
    const all=previous.some(a=>a.all_hubs)||body.assignments.some(a=>a.allHubs)||person.hub_id===null;
    return all?{all:true,hubs:[]}:{all:false,hubs:[...new Set([...previous.flatMap(a=>a.hub_ids),...body.assignments.flatMap(a=>a.hubIds),person.hub_id!])]};
  } else {
    if(!await master(ctx))throw new ApiError(403,'MASTER_REQUIRED');
    const body=supervisorInput.parse(input),person=await canManage(ctx,targetId);
    if(person.id===ctx.credential.person_id)throw new ApiError(403,'MASTER_SUPERVISOR_FORBIDDEN');
    if(body.supervisorId) {
      const supervisor=(await ctx.db.query('SELECT 1 FROM public.people WHERE id=$1 AND kind=\'human\' AND status=\'active\'',[body.supervisorId])).rows;
      if(!supervisor.length)throw new ApiError(400,'INVALID_SUPERVISOR');
    }
  }
  return scope;
}
async function applyAction(ctx:ApiContext,p:Proposal):Promise<unknown> {
  if(p.action==='role.create'||p.action==='role.update') {
    const input=roleInput.parse(p.payload);
    const existing=p.action==='role.update'?await role(ctx,p.target_id):null;
    if(existing&&existing.version!==p.target_version)throw new ApiError(409,'TARGET_CHANGED');
    if(existing) {
      const updated=await ctx.db.query('UPDATE public.roles SET name=$2,description=$3,version=version+1 WHERE id=$1 AND version=$4 RETURNING id',[p.target_id,input.name,input.description,p.target_version]);
      if(!updated.rows.length)throw new ApiError(409,'TARGET_CHANGED');
      await ctx.db.query('DELETE FROM public.role_permissions WHERE role_id=$1',[p.target_id]);
    } else await ctx.db.query('INSERT INTO public.roles(academy_id,id,name,description) VALUES($1,$2,$3,$4)',[ctx.credential.academy_id,p.target_id,input.name,input.description]);
    for(const permission of input.permissions)await ctx.db.query('INSERT INTO public.role_permissions(academy_id,role_id,capability,effect) VALUES($1,$2,$3,$4)',[ctx.credential.academy_id,p.target_id,permission.capability,permission.effect]);
    const result=await role(ctx,p.target_id);
    await record(ctx.db,ctx.credential,ctx.requestId,p.action,p.target_id,null,{before:existing,after:result,approvalId:p.id});
    return result;
  }
  const person=(await ctx.db.query<{id:string;access_version:number;supervisor_person_id:string|null}>('SELECT id,access_version,supervisor_person_id FROM public.people WHERE id=$1 FOR UPDATE',[p.target_id])).rows[0];
  if(!person||person.access_version!==p.target_version)throw new ApiError(409,'TARGET_CHANGED');
  if(p.action==='access.replace') {
    const input=accessInput.parse(p.payload),before=await assignments(ctx,p.target_id);
    await ctx.db.query('DELETE FROM public.assignment_hubs WHERE assignment_id IN (SELECT id FROM public.role_assignments WHERE person_id=$1)',[p.target_id]);
    await ctx.db.query('DELETE FROM public.role_assignments WHERE person_id=$1',[p.target_id]);
    for(const item of input.assignments) {
      const id=randomUUID();
      await ctx.db.query('INSERT INTO public.role_assignments(academy_id,id,person_id,role_id,all_hubs) VALUES($1,$2,$3,$4,$5)',[ctx.credential.academy_id,id,p.target_id,item.roleId,item.allHubs]);
      for(const hub of item.hubIds)await ctx.db.query('INSERT INTO public.assignment_hubs VALUES($1,$2,$3)',[ctx.credential.academy_id,id,hub]);
    }
    await ctx.db.query('UPDATE public.people SET access_version=access_version+1 WHERE id=$1',[p.target_id]);
    const result={personId:p.target_id,version:person.access_version+1,assignments:await assignments(ctx,p.target_id)};
    await record(ctx.db,ctx.credential,ctx.requestId,p.action,p.target_id,null,{before,after:result,approvalId:p.id});return result;
  }
  const input=supervisorInput.parse(p.payload);
  await ctx.db.query('UPDATE public.people SET supervisor_person_id=$2,access_version=access_version+1 WHERE id=$1',[p.target_id,input.supervisorId]);
  const result={personId:p.target_id,supervisorId:input.supervisorId,version:person.access_version+1};
  await record(ctx.db,ctx.credential,ctx.requestId,p.action,p.target_id,null,{before:{supervisorId:person.supervisor_person_id},after:result,approvalId:p.id});return result;
}
async function propose(ctx:ApiContext,action:Action,targetId:string|null,targetVersion:number,input:unknown):Promise<Reply> {
  const scope=await validateAction(ctx,action,targetId??randomUUID(),input);
  return mutation(ctx,{input,targetVersion},async()=>{
    const actualTarget=targetId??randomUUID(),reviewContext=await dependencies(ctx,action,actualTarget,input);
    const p:Proposal={id:randomUUID(),requester_id:ctx.credential.person_id,requester_kind:ctx.credential.kind??'bot',
      credential_snapshot:ctx.credential,grants_hash:grantsHash(ctx.grants),dependency_hash:stateHash(reviewContext),review_context:reviewContext,
      action,target_id:actualTarget,target_version:targetVersion,
      payload:input,scope,status:'pending',version:1};
    await ctx.db.query(`INSERT INTO public.approval_requests(academy_id,id,requester_id,requester_kind,credential_snapshot,grants_hash,action,target_id,target_version,payload,scope,dependency_hash,review_context)
      VALUES($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12,$13::jsonb)`,[ctx.credential.academy_id,p.id,p.requester_id,p.requester_kind,JSON.stringify(p.credential_snapshot),p.grants_hash,action,p.target_id,targetVersion,JSON.stringify(input),JSON.stringify(scope),p.dependency_hash,JSON.stringify(reviewContext)]);
    if(await master(ctx)) {
      const result=await applyAction(ctx,p);
      await ctx.db.query("UPDATE public.approval_requests SET status='applied',version=version+1,reviewer_id=$2,reason='Master self-approved',decided_at=now() WHERE id=$1",[p.id,ctx.credential.person_id]);
      await record(ctx.db,ctx.credential,ctx.requestId,'approval.applied',p.id,null,{action,targetId:p.target_id,selfApproved:true});
      return {status:action==='role.create'?201:200,body:{data:result,approval:{id:p.id,status:'applied',selfApproved:true}}};
    }
    await record(ctx.db,ctx.credential,ctx.requestId,'approval.requested',p.id,null,{action,targetId:p.target_id,scope});
    return {status:202,body:{approval:{id:p.id,status:'pending',version:1}}};
  });
}
async function visibleProposal(ctx:ApiContext,p:Proposal,review=false) {
  if(await master(ctx))return true;
  if(!review&&p.requester_id===ctx.credential.person_id)return true;
  const scope=permissionScope(ctx,review?'approvals.review':'approvals.view');
  if(!nonempty(scope)||!scopeContains(scope,storedScope.parse(p.scope)))return false;
  return (await ctx.db.query<{valid:boolean}>('SELECT public.is_supervisor($1,$2) AS valid',[ctx.credential.person_id,p.requester_id])).rows[0]?.valid===true;
}
async function decide(ctx:ApiContext,p:Proposal,input:z.infer<typeof decisionInput>):Promise<Reply> {
  if(ctx.credential.kind!=='human')throw new ApiError(403,'HUMAN_REVIEW_REQUIRED');
  if(p.requester_id===ctx.credential.person_id&&!await master(ctx))throw new ApiError(403,'SELF_APPROVAL_FORBIDDEN');
  if(!await visibleProposal(ctx,p,true))throw new ApiError(403,'SUPERVISOR_REQUIRED');
  return mutation(ctx,input,async()=>{
    const current=(await ctx.db.query<Proposal>('SELECT * FROM public.approval_requests WHERE id=$1 FOR UPDATE',[p.id])).rows[0];
    if(current.status!=='pending'||current.version!==input.expectedVersion)throw new ApiError(409,'APPROVAL_CHANGED');
    let status='rejected',result:unknown=null,decisionCode:string|null=null;
    if(input.decision==='approve') {
      const snapshot=storedCredential.parse(current.credential_snapshot) as Credential;
      const active=(await ctx.db.query('SELECT 1 FROM public.people WHERE id=$1 AND status=\'active\'',[current.requester_id])).rows.length;
      let authority=snapshot;
      if(current.requester_kind==='bot') {
        const live=(await ctx.db.query<Credential>('SELECT * FROM public.current_bot_scope($1)',[snapshot.token_id])).rows[0];
        if(!live||live.person_id!==current.requester_id||live.academy_id!==ctx.credential.academy_id){status='stale';decisionCode='CREDENTIAL_REVOKED';}else authority=live;
      }
      if(!active){status='stale';decisionCode='REQUESTER_INACTIVE';}
      if(grantsHash(await loadGrants(ctx.db,authority))!==current.grants_hash){status='stale';decisionCode='AUTHORITY_CHANGED';}
      if(stateHash(await dependencies(ctx,current.action,current.target_id,current.payload))!==current.dependency_hash){status='stale';decisionCode='DEPENDENCIES_CHANGED';}
      if(status!=='stale') {
        const requesterContext={...ctx,credential:authority,grants:await loadGrants(ctx.db,authority)};
        try {
          const requesterScope=await validateAction(requesterContext,current.action,current.target_id,current.payload);
          const reviewerScope=await validateAction(ctx,current.action,current.target_id,current.payload);
          if(!scopeContains(requesterScope,storedScope.parse(current.scope))||!scopeContains(reviewerScope,storedScope.parse(current.scope)))throw new ApiError(403,'AUTHORITY_CHANGED');
          // All validation happens before application; savepoint also protects against
          // optimistic-lock or constraint failures partway through a domain write.
          await ctx.db.query('SAVEPOINT approval_apply');
          try{result=await applyAction(ctx,current);await ctx.db.query('RELEASE SAVEPOINT approval_apply');status='applied';}
          catch(error){await ctx.db.query('ROLLBACK TO SAVEPOINT approval_apply');await ctx.db.query('RELEASE SAVEPOINT approval_apply');throw error;}
        } catch(error) {
          if(error instanceof ApiError&&[403,404,409].includes(error.status)){status='stale';decisionCode=error.code;}else throw error;
        }
      }
    }
    await ctx.db.query('UPDATE public.approval_requests SET status=$2,version=version+1,reviewer_id=$3,reason=$4,decision_code=$5,decided_at=now() WHERE id=$1',[current.id,status,ctx.credential.person_id,input.reason,decisionCode]);
    await record(ctx.db,ctx.credential,ctx.requestId,'approval.'+status,current.id,null,{before:'pending',after:status,reason:input.reason,decisionCode,action:current.action,targetId:current.target_id});
    return {status:status==='stale'?409:200,body:{approval:{id:current.id,status,version:current.version+1,reason:input.reason,decisionCode},...(result?{data:result}:{})}};
  });
}

function proposalView(p:Proposal) {
  return {id:p.id,action:p.action,targetId:p.target_id,targetVersion:p.target_version,requesterId:p.requester_id,
    payload:p.payload,scope:p.scope,status:p.status,version:p.version,reason:p.reason??null,decisionCode:p.decision_code??null,
    reviewContext:p.review_context,
    reviewerId:p.reviewer_id??null,createdAt:p.created_at,decidedAt:p.decided_at??null};
}

export async function administration(ctx:ApiContext):Promise<Reply|null> {
  const {request,path,db,credential:c}=ctx;
  const ownPath=path==='roles'||path==='approvals'||/^roles\//.test(path)||/^approvals\//.test(path)||/^people\/[^/]+\/(access|supervisor)$/.test(path);
  if(request.method!=='GET'&&ownPath) {
    // ponytail: policy writes serialize per academy; use finer locks only if
    // measured configuration-write contention warrants the extra complexity.
    await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,8))',[c.academy_id]);
    ctx.grants=await loadGrants(db,c);
  }
  if(path==='capabilities'&&request.method==='GET') {
    requireScope(permissionScope(ctx,'roles.view'));
    return {status:200,body:{data:(await db.query('SELECT name,label,workspace,sensitive FROM public.capability_catalog ORDER BY workspace,name')).rows}};
  }
  if(path==='me/access'&&request.method==='GET') {
    const caps=(await db.query<{name:Capability}>('SELECT name FROM public.capability_catalog ORDER BY name')).rows;
    return {status:200,body:{master:await master(ctx),data:caps.map(item=>({capability:item.name,scope:permissionScope(ctx,item.name)}))}};
  }
  if(path==='roles'&&request.method==='GET') {
    requireScope(permissionScope(ctx,'roles.view'));
    const {limit,after}=paging.omit({status:true}).parse(Object.fromEntries(new URL(request.url).searchParams));
    const rows=(await db.query<{id:string}>(`SELECT r.id,r.name,r.description,r.version,r.system_role,
      coalesce(jsonb_agg(jsonb_build_object('capability',p.capability,'effect',p.effect) ORDER BY p.capability) FILTER(WHERE p.capability IS NOT NULL),'[]'::jsonb) AS permissions
      FROM public.roles r LEFT JOIN public.role_permissions p ON p.academy_id=r.academy_id AND p.role_id=r.id
      WHERE ($1::uuid IS NULL OR r.id>$1) GROUP BY r.academy_id,r.id ORDER BY r.id LIMIT $2`,[after??null,limit+1])).rows;
    return {status:200,body:{data:rows.slice(0,limit),nextCursor:rows.length>limit?rows[limit-1].id:null}};
  }
  if(path==='roles'&&request.method==='POST')return propose(ctx,'role.create',null,0,roleInput.parse(await jsonBody(request)));
  const rolePath=/^roles\/([^/]+)(?:\/(update|duplicate))?$/.exec(path);
  if(rolePath) {
    const id=uuid.parse(rolePath[1]);
    if(request.method==='GET'&&!rolePath[2]){requireScope(permissionScope(ctx,'roles.view'));return {status:200,body:{data:await role(ctx,id)}};}
    if(request.method==='POST'&&rolePath[2]==='update') {
      const input=roleUpdate.parse(await jsonBody(request)),{expectedVersion,...body}=input;
      return propose(ctx,'role.update',id,expectedVersion,body);
    }
    if(request.method==='POST'&&rolePath[2]==='duplicate') {
      requireScope(permissionScope(ctx,'roles.view'));
      const input=z.object({name:roleInput.shape.name}).strict().parse(await jsonBody(request)),source=await role(ctx,id);
      return propose(ctx,'role.create',null,0,{name:input.name,description:source.description,permissions:source.permissions});
    }
  }
  const accessPath=/^people\/([^/]+)\/(access|supervisor)$/.exec(path);
  if(accessPath) {
    const id=uuid.parse(accessPath[1]);
    if(request.method==='GET'&&accessPath[2]==='access') {
      const person=(await db.query<{hub_id:string|null;access_version:number;supervisor_person_id:string|null}>('SELECT hub_id,access_version,supervisor_person_id FROM public.people WHERE id=$1',[id])).rows[0];
      if(!person)throw new ApiError(404,'NOT_FOUND');
      const scope=permissionScope(ctx,'access.view');requireScope(scope,person.hub_id??undefined);
      const assigned=await assignments(ctx,id),full=scope.all&&!scope.excludedHubs?.length;
      const visibleHubs=!full&&scope.all?(await db.query<{id:string}>('SELECT id FROM public.hubs WHERE NOT id=ANY($1::uuid[])',[scope.excludedHubs??[]])).rows.map(h=>h.id):scope.hubs;
      const local=assigned.flatMap(item=>{
        if(full)return [item];
        const hubs=item.all_hubs?visibleHubs:item.hub_ids.filter(h=>scope.all?!scope.excludedHubs?.includes(h):scope.hubs.includes(h));
        return hubs.length?[{...item,all_hubs:false,hub_ids:hubs}]:[];
      });
      return {status:200,body:{data:{personId:id,version:person.access_version,supervisorId:person.supervisor_person_id,assignments:local,partiallyHidden:!full}}};
    }
    if(request.method==='POST') {
      const input=(accessPath[2]==='access'?accessInput:supervisorInput).parse(await jsonBody(request));
      return propose(ctx,accessPath[2]==='access'?'access.replace':'supervisor.set',id,input.expectedVersion,input);
    }
  }
  if(path==='approvals'&&request.method==='GET') {
    const {limit,after,status}=paging.parse(Object.fromEntries(new URL(request.url).searchParams));
    const scope=permissionScope(ctx,'approvals.view');
    const rows=(await db.query<Proposal>(`SELECT * FROM public.approval_requests WHERE ($1::uuid IS NULL OR id>$1)
      AND ($2::text IS NULL OR status=$2) AND ($4::boolean OR requester_id=$5 OR
        ($6::boolean AND public.scope_contains($7::jsonb,scope) AND public.is_supervisor($5,requester_id))) ORDER BY id LIMIT $3`,
      [after??null,status??null,limit+1,await master(ctx),c.person_id,nonempty(scope),JSON.stringify(scope)])).rows;
    return {status:200,body:{data:rows.slice(0,limit).map(proposalView),nextCursor:rows.length>limit?rows[limit-1].id:null}};
  }
  const approvalPath=/^approvals\/([^/]+)(?:\/(decide|withdraw))?$/.exec(path);
  if(approvalPath) {
    const id=uuid.parse(approvalPath[1]);
    const p=(await db.query<Proposal>('SELECT * FROM public.approval_requests WHERE id=$1',[id])).rows[0];
    if(!p||!await visibleProposal(ctx,p))throw new ApiError(404,'NOT_FOUND');
    if(request.method==='GET'&&!approvalPath[2])return {status:200,body:{data:proposalView(p)}};
    if(request.method==='POST'&&approvalPath[2]==='decide')return decide(ctx,p,decisionInput.parse(await jsonBody(request)));
    if(request.method==='POST'&&approvalPath[2]==='withdraw') {
      if(p.requester_id!==c.person_id)throw new ApiError(403,'REQUESTER_REQUIRED');
      const input=withdrawInput.parse(await jsonBody(request));
      return mutation(ctx,input,async()=>{
        const updated=await db.query("UPDATE public.approval_requests SET status='withdrawn',version=version+1,reason=$3,decided_at=now() WHERE id=$1 AND version=$2 AND status='pending' RETURNING id",[id,input.expectedVersion,input.reason]);
        if(!updated.rows.length)throw new ApiError(409,'APPROVAL_CHANGED');
        await record(db,c,ctx.requestId,'approval.withdrawn',id,null,{reason:input.reason});
        return {status:200,body:{approval:{id,status:'withdrawn',version:input.expectedVersion+1}}};
      });
    }
  }
  if(path==='roles'||path==='approvals'||rolePath||accessPath||approvalPath)throw new ApiError(405,'METHOD_NOT_ALLOWED');
  return null;
}

export const administrationContract=[
  {path:'/api/v1/capabilities',method:'get',summary:'Registered feature rights and labels; academy-wide roles.view required'},
  {path:'/api/v1/me/access',method:'get',summary:'Current actor effective feature/data scopes and master status'},
  {path:'/api/v1/roles',method:'get',summary:'Paginated academy role templates (roles.view)',paged:true},
  {path:'/api/v1/roles',method:'post',summary:'Create role template; non-master waits for upper approval',schema:roleInput},
  {path:'/api/v1/roles/{id}',method:'get',summary:'Read a role template (roles.view)'},
  {path:'/api/v1/roles/{id}/update',method:'post',summary:'Version-checked role change, without self-escalation',schema:roleUpdate},
  {path:'/api/v1/roles/{id}/duplicate',method:'post',summary:'Duplicate and customize a reusable role template',schema:z.object({name:roleInput.shape.name}).strict()},
  {path:'/api/v1/people/{id}/access',method:'get',summary:'View permitted access-assignment segments; outside-scope data redacted'},
  {path:'/api/v1/people/{id}/access',method:'post',summary:'Replace subordinate role assignments within delegation limits',schema:accessInput},
  {path:'/api/v1/people/{id}/supervisor',method:'post',summary:'Master-only, version-checked, cycle-safe supervisor change',schema:supervisorInput},
  {path:'/api/v1/approvals',method:'get',summary:'Own and authorized subordinate cases, filtered before pagination',paged:true},
  {path:'/api/v1/approvals/{id}',method:'get',summary:'Read exact payload, reason, review history and stale decision code'},
  {path:'/api/v1/approvals/{id}/decide',method:'post',summary:'Human upper reviewer accepts/rejects exact unchanged proposal',schema:decisionInput},
  {path:'/api/v1/approvals/{id}/withdraw',method:'post',summary:'Requester withdraws a still-pending proposal',schema:withdrawInput}
] as const;
