export const capabilities = ['hubs.view', 'hubs.edit', 'people.view', 'people.edit', 'audit.view', 'credentials.revoke'] as const;
export type Capability = typeof capabilities[number] | 'roles.view' | 'roles.edit' | 'access.view' | 'access.edit' | 'approvals.view' | 'approvals.review' | 'locations.view' | 'locations.edit' | 'courses.view' | 'courses.edit' | 'classes.view' | 'classes.edit' | 'sessions.request';
export interface Grant { capability: Capability; effect: 'allow' | 'deny'; allHubs: boolean; hubIds: string[] }
export interface Credential { token_id: string; academy_id: string; person_id: string; capabilities: Capability[]; all_hubs: boolean; hub_ids: string[]; allowed: boolean; kind?: 'human' | 'bot' }
export interface Scope { all: boolean; hubs: string[]; excludedHubs?: string[] }
export function scopeContains(source:Scope,target:Scope) {
  if(target.all)return source.all&&(source.excludedHubs??[]).every(h=>(target.excludedHubs??[]).includes(h));
  return target.hubs.every(h=>source.all?!source.excludedHubs?.includes(h):source.hubs.includes(h));
}
export function scopeNonempty(scope:Scope){return scope.all||scope.hubs.length>0;}

export function scopeFor(credential: Credential, grants: Grant[], capability: Capability): Scope {
  const relevant = grants.filter(g => g.capability === capability);
  if (!credential.capabilities.includes(capability) || relevant.some(g => g.effect === 'deny' && g.allHubs)) return { all: false, hubs: [] };
  const allowed = relevant.filter(g => g.effect === 'allow');
  const denied = new Set(relevant.filter(g=>g.effect==='deny').flatMap(g=>g.hubIds));
  const roleAll = allowed.some(g => g.allHubs);
  const roleHubs = new Set(allowed.flatMap(g => g.hubIds));
  if (roleAll && credential.all_hubs) return { all: true, hubs: [],...(denied.size?{excludedHubs:[...denied]}:{}) };
  if (roleAll) return { all: false, hubs: credential.hub_ids.filter(h=>!denied.has(h)) };
  return { all: false, hubs: [...roleHubs].filter(h => !denied.has(h) && (credential.all_hubs || credential.hub_ids.includes(h))) };
}

export class ApiError extends Error {
  constructor(public status: number, public code: string) { super(code); }
}
export function requireScope(scope: Scope, hub?: string) {
  if ((scope.all && (hub?!scope.excludedHubs?.includes(hub):!scope.excludedHubs?.length)) || (hub && scope.hubs.includes(hub))) return;
  throw new ApiError(403, 'FORBIDDEN');
}
