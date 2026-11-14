// VPS-only, read-only preflights. No objects, signed links or secrets emitted.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
let phase = 'arguments';
try {
 assert.deepEqual(process.argv.slice(2), ['--execute']); assert.equal(process.getuid(), 0);
 let checks = 0;
 for (const [role, methods, headers, forbiddenMethod] of [['upload', ['PUT','HEAD'], 'content-type,if-none-match', 'GET'], ['download', ['GET','HEAD'], 'if-match,range', 'PUT']]) {
  const c = JSON.parse(readFileSync('/etc/kavosh-one/r2-' + role + '.json', 'utf8'));
  assert.match(c.accountId, /^[a-f0-9]{32}$/); assert.match(c.bucket, /^kavosh-one-production-(quarantine|clean)$/);
  const url = 'https://' + c.accountId + '.r2.cloudflarestorage.com/' + c.bucket + '/cors-acceptance/nonexistent-object';
  for (const [origin, method, requestedHeaders, allowed] of [
   ...methods.map(method => ['https://one.kavosh.ai', method, headers, true]),
   ['https://untrusted.invalid', methods[0], headers, false],
   ['https://one.kavosh.ai', forbiddenMethod, headers, false],
   ['https://one.kavosh.ai', methods[0], 'x-unapproved-header', false]
  ]) {
   phase = role + ' preflight ' + checks;
   const r = await fetch(url, { method:'OPTIONS', headers:{Origin:origin,'Access-Control-Request-Method':method,'Access-Control-Request-Headers':requestedHeaders}, signal:AbortSignal.timeout(10000), redirect:'error' });
   const permit = r.headers.get('access-control-allow-origin');
   if (allowed) { assert.ok(r.ok); assert.equal(permit, 'https://one.kavosh.ai'); for (const header of requestedHeaders.split(',')) assert.ok(r.headers.get('access-control-allow-headers')?.toLowerCase().split(/,\s*/).includes(header)); }
   else assert.notEqual(permit, origin);
   await r.body?.cancel(); checks++;
  }
 }
 console.log(JSON.stringify({executedOnVps:true,preflightChecksPassed:checks,allowedOrigin:'https://one.kavosh.ai',otherOriginsMethodsAndHeadersDenied:true,objectsCreated:false,browserEndToEndVerified:false}));
} catch { console.error('STORAGE_CORS_ACCEPTANCE_FAILED: ' + phase); process.exitCode=1; }
