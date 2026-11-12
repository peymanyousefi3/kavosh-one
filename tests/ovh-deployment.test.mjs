import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { runInNewContext } from 'node:vm';

// Isolate operator filesystem and service commands in memory. Actual Caddy,
// systemd, PostgreSQL TLS and public HTTP acceptance are independently verified
// by the live deployment receipt and scripts/check-deployment.mjs.
const source = name => readFileSync(new URL('../deploy/ovh/' + name, import.meta.url), 'utf8').replace(/^import .*;\n/gm, '');
test('requested Next shutdown is not a false crash, while real failures and OOM remain failures',()=>{
 const unit=readFileSync(new URL('../deploy/ovh/kavosh-one.service',import.meta.url),'utf8');
 assert.deepEqual(unit.match(/^SuccessExitStatus=.*$/gm),['SuccessExitStatus=143']);assert.match(unit,/^Restart=on-failure$/m);assert.match(unit,/^NoNewPrivileges=true$/m);assert.match(unit,/^ProtectSystem=strict$/m);
});
function fixture({ wrongHash = false, failValidation = false, failReload = false } = {}) {
 const original = Buffer.from('kavosh.ai {\n reverse_proxy 127.0.0.1:3000\n}\n');
 const config = '/etc/caddy/Caddyfile', files = new Map([[config, original], ['/etc/kavosh-one/web.env', Buffer.from('EDGE_AUTH_SECRET=' + 's'.repeat(64) + '\n')]]), output = [], commands = [];
 let reloads = 0;
 const context = { Buffer, Number, Error, Object, RegExp, console: { log: x => output.push(x), error: x => output.push(x) }, process: { getuid: () => 0, env: { LANDING_CADDY_SHA256: wrongHash ? 'wrong' : createHash('sha256').update(original).digest('hex') } }, createHash,
  readFileSync: (p, encoding) => { assert.ok(files.has(p), p); return encoding ? files.get(p).toString(encoding) : Buffer.from(files.get(p)); },
  writeFileSync: (p, value, options = {}) => { if (options.flag === 'wx') assert.ok(!files.has(p), p); files.set(p, Buffer.from(value)); },
  existsSync: p => files.has(p), chmodSync: () => {}, chownSync: () => {}, unlinkSync: p => files.delete(p),
  renameSync: (a, b) => { files.set(b, files.get(a)); files.delete(a); },
  execFileSync: (cmd, args) => { commands.push([cmd, ...args]); if (cmd === '/usr/bin/id') return Buffer.from('1000'); if (args[0] === 'validate' && failValidation) throw new Error('provider diagnostic ' + 's'.repeat(64)); if (args[0] === 'reload' && ++reloads === 1 && failReload) throw new Error('reload failure ' + 's'.repeat(64)); return Buffer.from(''); }
 };
 return { original, config, files, output, commands, context };
}
test('new virtual host preserves original routing bytes and never emits edge secrets', () => {
 const f = fixture(); runInNewContext(source('install-edge.mjs'), f.context);
 assert.ok(f.files.get(f.config).subarray(0, f.original.length).equals(f.original));
 assert.match(f.files.get('/etc/caddy/kavosh-one.caddy').toString(), /127\.0\.0\.1:3100/);
 assert.ok(f.commands.some(c => c[1] === 'validate')); assert.ok(f.commands.some(c => c[1] === 'reload'));
 assert.ok(!f.commands.some(c => c.includes('restart'))); assert.ok(!f.output.join('').includes('s'.repeat(64)));
});
test('changed original route is refused before any write', () => {
 const f = fixture({ wrongHash: true }); assert.throws(() => runInNewContext(source('install-edge.mjs'), f.context), /LANDING_CONFIG_CHANGED/);
 assert.equal(f.files.size, 2); assert.equal(f.commands.length, 0);
});
test('invalid new route leaves original configuration untouched and scrubs diagnostics', () => {
 const f = fixture({ failValidation: true }); runInNewContext(source('install-edge.mjs'), f.context);
 assert.ok(f.files.get(f.config).equals(f.original)); assert.equal(f.context.process.exitCode, 1);
 assert.ok(!f.commands.some(c => c[1] === 'reload')); assert.deepEqual(f.output, ['EDGE_INSTALL_FAILED']);
});
test('failed reload restores original bytes and reloads the original config without a restart', () => {
 const f = fixture({ failReload: true }); runInNewContext(source('install-edge.mjs'), f.context);
 assert.ok(f.files.get(f.config).equals(f.original)); assert.equal(f.commands.filter(c => c[1] === 'reload').length, 2);
 assert.deepEqual(f.output, ['EDGE_RELOAD_FAILED_ORIGINAL_RESTORED']);
});
test('PostgreSQL string literals are exactly quoted and unrelated settings survive', () => {
 const keys = ['listen_addresses', 'ssl', 'ssl_cert_file', 'ssl_key_file', 'ssl_min_protocol_version', 'max_connections', 'shared_buffers', 'work_mem', 'maintenance_work_mem'];
 let config = keys.map(k => k + ' = old').join('\n') + '\nport = 5432\n';
 const context = { process: { getuid: () => 0 }, Object, RegExp, Error, console: { log: () => {} }, readFileSync: () => config, writeFileSync: (_, value) => { config = value; } };
 runInNewContext(source('configure-postgres.mjs'), context);
 assert.match(config, /^listen_addresses = '127\.0\.0\.1'$/m); assert.match(config, /^ssl_min_protocol_version = 'TLSv1\.2'$/m); assert.match(config, /^port = 5432$/m); assert.ok(!config.includes("'''"));
 const once = config; runInNewContext(source('configure-postgres.mjs'), { ...context }); assert.equal(config, once);
});
