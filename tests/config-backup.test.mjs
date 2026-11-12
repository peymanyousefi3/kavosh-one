import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const read = name => readFileSync(new URL('../deploy/ovh/' + name, import.meta.url), 'utf8');
test('configuration backup retains isolation, uses password-free separate role export and fixed One-only paths', () => {
 const unit = read('kavosh-one-config-backup.service'), role = read('kavosh-one-role-export.service'), script = read('run-config-backup.sh');
 for (const line of ['NoNewPrivileges=true', 'ProtectSystem=strict', 'ProtectHome=true', 'RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6', 'SystemCallFilter=~@setuid', 'CapabilityBoundingSet=CAP_DAC_READ_SEARCH CAP_DAC_OVERRIDE']) assert.ok(unit.includes(line));
 assert.match(unit, /Requires=.*kavosh-one-role-export.service/);
 assert.match(role, /^User=postgres$/m); assert.match(role, /^RestrictAddressFamilies=AF_UNIX$/m);
 assert.match(read('export-backup-roles.sh'), /--no-role-passwords/);
 assert.doesNotMatch(script, /runuser|setpriv|etc\/caddy\/Caddyfile|srv\/kavosh(?:\s|\/)/);
 assert.match(script, /age --encrypt/); assert.match(script, /copy-config/);
 assert.match(script, /independentCopyVerified!==true/);
 assert.match(read('kavosh-one-config-backup.timer'), /03:05:00 America\/Toronto/);
 for (const name of ['run-config-backup.sh', 'export-backup-roles.sh']) execFileSync('/bin/bash', ['-n', new URL('../deploy/ovh/' + name, import.meta.url).pathname]);
});
