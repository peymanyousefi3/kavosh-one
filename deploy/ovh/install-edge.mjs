// Append one separately maintained virtual host, preserving the original bytes.
// Run only after DNS is configured and local production readiness passes.
import { readFileSync, writeFileSync, existsSync, chmodSync, chownSync, unlinkSync, renameSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
if (process.getuid() !== 0) throw new Error('ROOT_REQUIRED');
const path = '/etc/caddy/Caddyfile', include = '/etc/caddy/kavosh-one.caddy';
const original = readFileSync(path), sha = x => createHash('sha256').update(x).digest('hex');
const expected = process.env.LANDING_CADDY_SHA256;
if (!expected || sha(original) !== expected) throw new Error('LANDING_CONFIG_CHANGED_REVIEW_REQUIRED');
if (existsSync(include) || /one\.kavosh\.ai|kavosh-one\.caddy/.test(original.toString())) throw new Error('EXISTING_ROUTE_REFUSED');
const env = readFileSync('/etc/kavosh-one/web.env', 'utf8');
const edge = /^EDGE_AUTH_SECRET=([A-Za-z0-9_-]{64})$/m.exec(env)?.[1];
if (!edge) throw new Error('EDGE_SECRET_MISSING');
const caddyGroup = Number(execFileSync('/usr/bin/id', ['-g', 'caddy']).toString().trim());
const config = `one.kavosh.ai {
 encode zstd gzip
 header {
  -Server
  X-Robots-Tag "noindex, nofollow"
  Cache-Control "no-store"
 }
 route {
 # Official Cloudflare networks verified at cloudflare.com/ips-v4 and ips-v6.
 # Never trust a visitor-supplied CF header from a direct origin connection.
 @cloudflare {
  remote_ip 173.245.48.0/20 103.21.244.0/22 103.22.200.0/22 103.31.4.0/22 141.101.64.0/18 108.162.192.0/18 190.93.240.0/20 188.114.96.0/20 197.234.240.0/22 198.41.128.0/17 162.158.0.0/15 104.16.0.0/13 104.24.0.0/14 172.64.0.0/13 131.0.72.0/22 2400:cb00::/32 2606:4700::/32 2803:f800::/32 2405:b500::/32 2405:8100::/32 2a06:98c0::/29 2c0f:f248::/32
  header Cf-Connecting-Ip *
 }
 vars kavosh_one_ip {remote_host}
 vars @cloudflare kavosh_one_ip {http.request.header.Cf-Connecting-Ip}
 request_body {
  max_size 2MB
 }
 reverse_proxy 127.0.0.1:3100 {
  header_up -Oai-Authenticated-*
  header_up -Cf-Connecting-Ip
  header_up -X-Forwarded-For
  header_up -X-Forwarded-Host
  header_up X-Forwarded-Proto https
  header_up Host one.kavosh.ai
  header_up X-Kavosh-Client-Ip {http.vars.kavosh_one_ip}
  header_up X-Kavosh-Edge-Key ${edge}
  transport http {
   dial_timeout 3s
   response_header_timeout 30s
  }
 }
 }
}
`;
const candidate = Buffer.concat([original, Buffer.from('\nimport /etc/caddy/kavosh-one.caddy\n')]);
writeFileSync('/etc/caddy/Caddyfile.before-kavosh-one', original, { flag: 'wx', mode: 0o600 });
writeFileSync(include, config, { flag: 'wx', mode: 0o640 });
chownSync(include, 0, caddyGroup);
try {
 writeFileSync(path + '.kavosh-one-candidate', candidate, { flag: 'wx', mode: 0o600 });
 execFileSync('/usr/bin/caddy', ['validate', '--config', path + '.kavosh-one-candidate', '--adapter', 'caddyfile'], { stdio: 'pipe' });
 if (sha(readFileSync(path)) !== expected) throw new Error('LANDING_CONFIG_CHANGED');
 chmodSync(path + '.kavosh-one-candidate', 0o644);
 renameSync(path + '.kavosh-one-candidate', path);
 try { execFileSync('/usr/bin/systemctl', ['reload', 'caddy'], { stdio: 'pipe' }); }
 catch { writeFileSync(path + '.kavosh-one-rollback', original, { flag: 'wx', mode: 0o644 }); renameSync(path + '.kavosh-one-rollback', path); execFileSync('/usr/bin/systemctl', ['reload', 'caddy'], { stdio: 'pipe' }); throw new Error('EDGE_RELOAD_FAILED_ORIGINAL_RESTORED'); }
 console.log(JSON.stringify({ routeAdded: 'one.kavosh.ai', originalConfigurationSha256: expected, originalConfigurationPrefixPreserved: readFileSync(path).subarray(0, original.length).equals(original), landingServiceRestarted: false }));
} catch (error) {
 // Never emit the Caddy parser's raw output, which can include injected secrets.
 console.error(error instanceof Error && /^[A-Z_]+$/.test(error.message) ? error.message : 'EDGE_INSTALL_FAILED'); process.exitCode = 1;
} finally { if (existsSync(path + '.kavosh-one-candidate')) unlinkSync(path + '.kavosh-one-candidate'); }
