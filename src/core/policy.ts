export const capabilities = ['hubs.view', 'hubs.edit', 'people.view', 'people.edit', 'audit.view', 'credentials.revoke'] as const;
export type Capability = typeof capabilities[number] | 'roles.view' | 'roles.edit' | 'access.view' | 'access.edit' | 'approvals.view' | 'approvals.review' | 'locations.view' | 'locations.edit' | 'courses.view' | 'courses.edit' | 'classes.view' | 'classes.edit' | 'sessions.request';
export interface ResourceRef {id:string;hubId:string|null}
export interface Grant { capability: Capability; effect: 'allow' | 'deny'; allHubs: boolean; hubIds: string[];classRefs?:ResourceRef[];personRefs?:ResourceRef[] }
export interface Credential { token_id: string; academy_id: string; person_id: string; capabilities: Capability[]; all_hubs: boolean; hub_ids: string[]; allowed: boolean; kind?: 'human' | 'bot' }
export interface Scope { all: boolean; hubs: string[]; excludedHubs?: string[];classes?:ResourceRef[];people?:ResourceRef[];excludedClasses?:ResourceRef[];excludedPeople?:ResourceRef[] }
const classCapabilities=new Set<Capability>(['classes.view','classes.edit','sessions.request','approvals.view','approvals.review']);
const personCapabilities=new Set<Capability>(['people.view','people.edit','approvals.view','approvals.review']);
export function featureScope(scope:Scope,capability:Capability):Scope {
  const {classes,people,excludedClasses,excludedPeople,...base}=scope;
  return {...base,...classCapabilities.has(capability)?{classes,excludedClasses}:{},...personCapabilities.has(capability)?{people,excludedPeople}:{}};
}
export function scopeAllowsRef(source:Scope,ref:ResourceRef,kind:'classes'|'people') {
  const denied=kind==='classes'?source.excludedClasses:source.excludedPeople;
  return !source.excludedHubs?.includes(ref.hubId??'')&&!denied?.some(r=>r.id===ref.id)&&(
    Boolean(source[kind]?.some(r=>r.id===ref.id))||Boolean(ref.hubId&&source.hubs.includes(ref.hubId))||
    (source.all&&(ref.hubId!==null||!source.excludedHubs?.length)));
}
export function scopeContains(source:Scope,target:Scope) {
  const blocked=new Set(source.excludedHubs),targetBlocked=new Set(target.excludedHubs),hubs=new Set(source.hubs);
  const broad=(hub:string|null)=>hub!==null&&(target.all||target.hubs.includes(hub))&&!targetBlocked.has(hub);
  if(target.all&&(!source.all||[...blocked].some(h=>!targetBlocked.has(h))))return false;
  if(!target.hubs.every(h=>targetBlocked.has(h)||((source.all||hubs.has(h))&&!blocked.has(h))))return false;
  for(const [kind,excluded] of [['classes','excludedClasses'],['people','excludedPeople']] as const) {
    const denied=new Set(source[excluded]?.map(r=>r.id)),targetDenied=new Set(target[excluded]?.map(r=>r.id)),allowed=new Set(source[kind]?.map(r=>r.id));
    if(source[excluded]?.some(r=>!targetDenied.has(r.id)&&!targetBlocked.has(r.hubId??'')&&(target.all||broad(r.hubId))))return false;
    for(const ref of target[kind]??[]) {
      if(targetDenied.has(ref.id)||targetBlocked.has(ref.hubId??''))continue;
      if(blocked.has(ref.hubId??'')||denied.has(ref.id)||!(allowed.has(ref.id)||(ref.hubId!==null&&hubs.has(ref.hubId))||(source.all&&(ref.hubId!==null||!blocked.size))))return false;
    }
  }
  return true;
}
export function scopeNonempty(scope:Scope){return scope.all||scope.hubs.length>0||Boolean(scope.classes?.length)||Boolean(scope.people?.length);}

export function scopeFor(credential: Credential, grants: Grant[], capability: Capability): Scope {
  const relevant = grants.filter(g => g.capability === capability);
  if (!credential.capabilities.includes(capability) || relevant.some(g => g.effect === 'deny' && g.allHubs)) return { all: false, hubs: [] };
  const allowed = relevant.filter(g => g.effect === 'allow');
  const denied = new Set(relevant.filter(g=>g.effect==='deny').flatMap(g=>g.hubIds));
  const roleAll = allowed.some(g => g.allHubs);
  const roleHubs = new Set(allowed.flatMap(g => g.hubIds));
  const result:Scope=roleAll&&credential.all_hubs?{all:true,hubs:[],...(denied.size?{excludedHubs:[...denied]}:{})}:
    {all:false,hubs:(roleAll?credential.hub_ids:[...roleHubs]).filter(h=>!denied.has(h)&&(credential.all_hubs||credential.hub_ids.includes(h)))};
  for(const [grantKey,scopeKey,deniedKey,supported] of [['classRefs','classes','excludedClasses',classCapabilities],['personRefs','people','excludedPeople',personCapabilities]] as const) {
    if(!supported.has(capability))continue;
    const negative=[...new Map(relevant.filter(g=>g.effect==='deny').flatMap(g=>g[grantKey]??[]).map(r=>[r.id,r])).values()]
      .filter(r=>credential.all_hubs||Boolean(r.hubId&&credential.hub_ids.includes(r.hubId)));
    const negativeIds=new Set(negative.map(r=>r.id));
    const positive=[...new Map(allowed.flatMap(g=>g[grantKey]??[]).map(r=>[r.id,r])).values()].filter(r=>!negativeIds.has(r.id)&&!denied.has(r.hubId??'')&&(credential.all_hubs||Boolean(r.hubId&&credential.hub_ids.includes(r.hubId))));
    if(positive.length)result[scopeKey]=positive;
    if(negative.length)result[deniedKey]=negative;
  }
  return result;
}

export class ApiError extends Error {
  constructor(public status: number, public code: string) { super(code); }
}
export function requireScope(scope: Scope, hub?: string) {
  if ((scope.all && (hub?!scope.excludedHubs?.includes(hub):!scope.excludedHubs?.length)) || (hub && scope.hubs.includes(hub))) return;
  throw new ApiError(403, 'FORBIDDEN');
}
