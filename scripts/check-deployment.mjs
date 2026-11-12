// Bounded, read-only production acceptance. No signup, delivery or financial writes.
import assert from 'node:assert/strict';
if (process.argv.length !== 3 || process.argv[2] !== '--execute') throw new Error('EXPLICIT_EXECUTE_REQUIRED');
const base = 'https://one.kavosh.ai';
async function check(path, status, options = {}) {
 const response = await fetch(base + path, { ...options, redirect: 'error', signal: AbortSignal.timeout(15000) });
 assert.equal(response.status, status, path);
 assert.match(response.headers.get('cache-control') ?? '', /no-store/i, path);
 assert.equal(response.headers.get('x-content-type-options'), 'nosniff', path);
 assert.equal(response.headers.get('x-frame-options'), 'DENY', path);
 assert.equal(response.headers.get('access-control-allow-origin'), null, path);
 return response;
}
assert.equal((await (await check('/api/health', 200)).json()).service, 'kavosh-one');
assert.deepEqual(await (await check('/api/ready', 200)).json(), { ready: true });
for (const path of ['/api/v1/people', '/api/v1/finance/accounts', '/api/v1/audit-events']) await check(path, 401);
const spoofed = await check('/api/auth/get-session', 200, { headers: { 'x-kavosh-client-ip': 'attacker-not-an-ip', 'x-kavosh-edge-key': 'attacker-controlled' } });
assert.equal(await spoofed.json(), null);
// The actual Cloudflare edge independently rejects a forged reserved CF header.
// This is an edge response, not an application response with app-level headers.
const reserved = await fetch(base + '/api/auth/get-session', { redirect: 'error', signal: AbortSignal.timeout(15000), headers: { 'cf-connecting-ip': 'attacker-not-an-ip' } });
assert.equal(reserved.status, 403); assert.equal(reserved.headers.get('server'), 'cloudflare');
await check('/api/auth/sign-in/email', 403, { method: 'POST', headers: { origin: 'https://untrusted.example', 'content-type': 'application/json' }, body: '{}' });
// Invalid input fails before invoking password verification or sending anything.
await check('/api/auth/sign-in/email', 400, { method: 'POST', headers: { origin: base, 'content-type': 'application/json' }, body: '{}' });
const oversized = await fetch(base + '/api/auth/sign-in/email', { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000), headers: { origin: base, 'content-type': 'application/json' }, body: JSON.stringify({ oversized: 'x'.repeat(2100000) }) });
assert.equal(oversized.status, 413);
const quick = await Promise.all(Array.from({ length: 5 }, () => check('/api/ready', 200)));
for (const response of quick) assert.deepEqual(await response.json(), { ready: true });
const landing = await fetch('https://kavosh.ai/', { redirect: 'error', signal: AbortSignal.timeout(15000) });
assert.equal(landing.status, 200);
console.log(JSON.stringify({ publicHttpsVerified: true, readiness: true, protectedAnonymousRequests: 3, spoofedProxyHeadersIgnored: true, reservedCloudflareHeaderRejectedAtEdge: true, crossOriginRejected: true, malformedInputRejected: true, oversizedBodyRejected: true, concurrentReadinessRequests: 5, landingHttpsStatus: 200, financialWrites: 0, accountsCreated: 0, providerMessagesSent: 0, fullUserJourneyVerified: false }));
