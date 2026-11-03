export const capabilities = ['hubs.view', 'hubs.edit', 'people.view', 'people.edit', 'audit.view', 'credentials.revoke'] as const;
export type Capability = typeof capabilities[number];
export interface Grant { capability: Capability; effect: 'allow' | 'deny'; allHubs: boolean; hubIds: string[] }
export interface Credential { token_id: string; academy_id: string; person_id: string; capabilities: Capability[]; all_hubs: boolean; hub_ids: string[]; allowed: boolean; kind?: 'human' | 'bot' }
export interface Scope { all: boolean; hubs: string[] }

export function scopeFor(credential: Credential, grants: Grant[], capability: Capability): Scope {
  const relevant = grants.filter(g => g.capability === capability);
  if (!credential.capabilities.includes(capability) || relevant.some(g => g.effect === 'deny')) return { all: false, hubs: [] };
  const allowed = relevant.filter(g => g.effect === 'allow');
  const roleAll = allowed.some(g => g.allHubs);
  const roleHubs = new Set(allowed.flatMap(g => g.hubIds));
  if (roleAll && credential.all_hubs) return { all: true, hubs: [] };
  if (roleAll) return { all: false, hubs: credential.hub_ids };
  return { all: false, hubs: [...roleHubs].filter(h => credential.all_hubs || credential.hub_ids.includes(h)) };
}

export class ApiError extends Error {
  constructor(public status: number, public code: string) { super(code); }
}
export function requireScope(scope: Scope, hub?: string) {
  if (scope.all || (hub && scope.hubs.includes(hub))) return;
  throw new ApiError(403, 'FORBIDDEN');
}
