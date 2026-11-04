export const capabilities = ['hubs.view', 'hubs.edit', 'people.view', 'people.edit', 'audit.view', 'credentials.revoke'] as const;
export type Capability = typeof capabilities[number] | 'roles.view' | 'roles.edit' | 'access.view' | 'access.edit' | 'approvals.view' | 'approvals.review' | 'locations.view' | 'locations.edit' | 'courses.view' | 'courses.edit' | 'classes.view' | 'classes.edit' | 'sessions.request' | 'staff.view' | 'staff.edit' | 'students.view' | 'students.edit' | 'guardians.view' | 'guardians.edit' | 'families.view' | 'families.edit' | 'registrations.view' | 'enrollments.view' | 'enrollments.edit' | 'rosters.view' | 'agreements.view' | 'agreements.edit' | 'signatures.view' | 'signatures.edit' | 'files.view' | 'files.edit' | 'files.upload' | 'storage.view' | 'storage.edit' | 'currencies.view' | 'currencies.edit' | 'accounts.view' | 'accounts.edit' | 'periods.view' | 'periods.edit' | 'journals.view' | 'journals.edit' | 'ledger.view' | 'financial-reports.view' | 'closing.view' | 'closing.edit';
export interface ResourceRef {id:string;hubId:string|null}
export interface AreaRef {kind:'country'|'region'|'city';id:string;countryId:string;regionId:string|null;cityId:string|null}
export interface Grant { capability: Capability; effect: 'allow' | 'deny'; allHubs: boolean; hubIds: string[];classRefs?:ResourceRef[];personRefs?:ResourceRef[];areaRefs?:AreaRef[];areaHubIds?:string[] }
export interface Credential { token_id: string; academy_id: string; person_id: string; capabilities: Capability[]; all_hubs: boolean; hub_ids: string[]; allowed: boolean; kind?: 'human' | 'bot' }
export interface Scope { all: boolean; hubs: string[]; excludedHubs?: string[];classes?:ResourceRef[];people?:ResourceRef[];excludedClasses?:ResourceRef[];excludedPeople?:ResourceRef[];areas?:AreaRef[];excludedAreas?:AreaRef[] }
const academyCapabilities=new Set<Capability>(['roles.view','roles.edit','credentials.revoke','locations.edit','storage.view','storage.edit','currencies.view','currencies.edit','periods.view','periods.edit','closing.view','closing.edit']);
const classCapabilities=new Set<Capability>(['classes.view','classes.edit','sessions.request','staff.view','staff.edit','enrollments.view','enrollments.edit','rosters.view','signatures.view','signatures.edit','files.view','files.edit','files.upload','approvals.view','approvals.review']);
const personCapabilities=new Set<Capability>(['people.view','people.edit','students.view','students.edit','guardians.view','guardians.edit','families.view','families.edit','registrations.view','signatures.view','signatures.edit','files.view','files.edit','files.upload','approvals.view','approvals.review']);
export function featureScope(scope:Scope,capability:Capability):Scope {
  if(academyCapabilities.has(capability)&&!scope.all)return {all:false,hubs:[]};
  const {classes,people,excludedClasses,excludedPeople,...base}=scope;
  return {...base,...classCapabilities.has(capability)?{classes,excludedClasses}:{},...personCapabilities.has(capability)?{people,excludedPeople}:{}};
}
export function areaContains(a:AreaRef,b:AreaRef){return a.id===(a.kind==='country'?b.countryId:a.kind==='region'?b.regionId:b.cityId);}
export function areaAllowsNewRecord(scope:Scope,area:AreaRef) {
  return !scope.excludedAreas?.some(a=>areaContains(a,area))&&(scope.all||Boolean(scope.areas?.some(a=>areaContains(a,area))));
}
export function scopeAllowsRef(source:Scope,ref:ResourceRef,kind:'classes'|'people') {
  const denied=kind==='classes'?source.excludedClasses:source.excludedPeople;
  return !source.excludedHubs?.includes(ref.hubId??'')&&!denied?.some(r=>r.id===ref.id)&&(
    Boolean(source[kind]?.some(r=>r.id===ref.id))||Boolean(ref.hubId&&source.hubs.includes(ref.hubId))||
    (source.all&&(ref.hubId!==null||!source.excludedHubs?.length)));
}
export function scopeContains(source:Scope,target:Scope) {
  if(target.areas?.some(a=>!source.all&&!source.areas?.some(s=>areaContains(s,a))))return false;
  if((target.all||target.areas?.length)&&source.excludedAreas?.some(e=>!target.excludedAreas?.some(t=>areaContains(t,e))))return false;
  if(target.areas?.length) {
    if(source.excludedHubs?.some(h=>!target.excludedHubs?.includes(h)))return false;
    for(const k of ['excludedClasses','excludedPeople'] as const)if(source[k]?.some(e=>!target[k]?.some(t=>t.id===e.id)))return false;
  }
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
export function scopeNonempty(scope:Scope){return scope.all||scope.hubs.length>0||Boolean(scope.classes?.length)||Boolean(scope.people?.length)||Boolean(scope.areas?.length);}

export function scopeFor(credential: Credential, grants: Grant[], capability: Capability): Scope {
  const relevant = grants.filter(g => g.capability === capability);
  if (!credential.capabilities.includes(capability) || relevant.some(g => g.effect === 'deny' && g.allHubs)) return { all: false, hubs: [] };
  const allowed = relevant.filter(g => g.effect === 'allow');
  const denied = new Set(relevant.filter(g=>g.effect==='deny').flatMap(g=>[...g.hubIds,...g.areaHubIds??[]]));
  const roleAll = allowed.some(g => g.allHubs);
  const roleHubs = new Set(allowed.flatMap(g => [...g.hubIds,...g.areaHubIds??[]]));
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
  if(credential.all_hubs) {
    const negative=[...new Map(relevant.filter(g=>g.effect==='deny').flatMap(g=>g.areaRefs??[]).map(a=>[a.kind+':'+a.id,a])).values()];
    const positive=[...new Map(allowed.flatMap(g=>g.areaRefs??[]).map(a=>[a.kind+':'+a.id,a])).values()].filter(a=>!negative.some(n=>areaContains(n,a)));
    if(positive.length){result.areas=positive;if(denied.size)result.excludedHubs=[...denied];}
    if(negative.length)result.excludedAreas=negative;
  }
  // Selected students can have registrations outside their primary hub. Keep
  // record-hub denials even when the positive grant selects only that person.
  if(capability==='registrations.view'&&denied.size)result.excludedHubs=[...denied].filter(h=>credential.all_hubs||credential.hub_ids.includes(h));
  if(academyCapabilities.has(capability)&&(!result.all||result.excludedHubs?.length||result.excludedAreas?.length))return {all:false,hubs:[]};
  return result;
}

export class ApiError extends Error {
  constructor(public status: number, public code: string) { super(code); }
}
export function requireScope(scope: Scope, hub?: string) {
  if ((scope.all && (hub?!scope.excludedHubs?.includes(hub):!scope.excludedHubs?.length&&!scope.excludedAreas?.length)) || (hub && scope.hubs.includes(hub))) return;
  throw new ApiError(403, 'FORBIDDEN');
}
