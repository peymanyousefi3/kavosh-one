import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync,readdirSync } from 'node:fs';
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
test('scanner stays private, resource bounded and fail-closed for size/encryption limits', () => {
 const config=read('clamd.conf'),unit=read('kavosh-one-scanner.service');
 for(const line of ['OfficialDatabaseOnly yes','LocalSocketMode 660','AlertExceedsMax yes','AlertEncrypted yes','StreamMaxLength 64M','EnableVersionCommand yes','BytecodeMode ForceInterpreter']) assert.ok(config.includes(line));
 assert.doesNotMatch(config,/^TCP(?:Socket|Addr)/m);
 for(const line of ['PrivateNetwork=true','RestrictAddressFamilies=AF_UNIX','CapabilityBoundingSet=','MemoryMax=2G','CPUQuota=75%','ProtectSystem=strict'])assert.ok(unit.includes(line));
 assert.ok(read('run-config-backup.sh').includes('etc/kavosh-one-scanner'));
});
test('every checked-in Kavosh One service and timer is covered by the encrypted configuration archive',()=>{
 const script=read('run-config-backup.sh'),units=readdirSync(new URL('../deploy/ovh/',import.meta.url)).filter(name=>/^kavosh-one.*\.(?:service|timer)$/.test(name));
 assert.ok(units.length>=12);
 for(const name of units)assert.ok(script.split(/\s+/).includes('etc/systemd/system/'+name),'Missing backup coverage: '+name);
 assert.doesNotMatch(script,/\betc\/systemd\/system\/(?:kavosh\.service|\*)/);
});
