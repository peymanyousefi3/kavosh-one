// Explicit operator acceptance: download and authenticate off-server; never
// apply configuration, restore roles, or print decrypted credentials.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, openSync, closeSync,readdirSync,writeFileSync, unlinkSync, rmdirSync } from 'node:fs';
import { join } from 'node:path';
let stage = 'arguments', directory, encrypted, plaintext;
const get = service => {
 const bytes = execFileSync('/usr/bin/security', ['find-generic-password', '-a', 'kavosh-one', '-s', service, '-w'], { stdio: ['ignore', 'pipe', 'pipe'] });
 try { return JSON.parse(bytes.toString()); } finally { bytes.fill(0); }
};
try {
 assert.equal(process.platform, 'darwin'); assert.deepEqual(process.argv.slice(2), ['--execute']); process.umask(0o077);
 stage = 'trusted server receipt';
 const receipt = JSON.parse(execFileSync('/usr/bin/ssh', ['-F', '.local-tools/ovh.ssh-config', 'kavosh-one-production', 'sudo cat /var/lib/kavosh-one-config-backups/latest.json'], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 }));
 assert.match(receipt.id, /^[a-f0-9-]{36}$/); assert.match(receipt.ciphertextSha256, /^[a-f0-9]{64}$/);
 assert.equal(receipt.offsite.independentCopyVerified, true); assert.equal(receipt.offsite.scope, 'one_encrypted_configuration_archive');
 assert.ok(Number.isSafeInteger(receipt.encryptedBytes)&&receipt.encryptedBytes > 0 && receipt.encryptedBytes <= 16777216);
 const drive = get('kavosh-one-drive-backup-connection');
 assert.equal(drive.token.scope, 'https://www.googleapis.com/auth/drive.file');
 directory = mkdtempSync('/private/tmp/kavosh-one-config-proof-'); encrypted = join(directory, 'configuration.tar.age'); plaintext = join(directory, 'configuration.tar');
 stage = 'independent Drive download';
 const downloaded=execFileSync('/opt/homebrew/bin/rclone', ['cat', 'kavosh_backup:backup-' + receipt.id + '/configuration.tar.age', '--config', '/dev/null', '--log-level', 'ERROR', '--stats', '0', '--retries', '1', '--low-level-retries', '1'], { env: { PATH: process.env.PATH, RCLONE_CONFIG_KAVOSH_BACKUP_TYPE: 'drive', RCLONE_CONFIG_KAVOSH_BACKUP_SCOPE: 'drive.file', RCLONE_CONFIG_KAVOSH_BACKUP_ROOT_FOLDER_ID: drive.folderId, RCLONE_CONFIG_KAVOSH_BACKUP_CLIENT_ID: drive.clientId, RCLONE_CONFIG_KAVOSH_BACKUP_CLIENT_SECRET: drive.clientSecret, RCLONE_CONFIG_KAVOSH_BACKUP_TOKEN: JSON.stringify(drive.token) }, stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000,maxBuffer:receipt.encryptedBytes });
 try{assert.equal(downloaded.length,receipt.encryptedBytes);assert.equal(createHash('sha256').update(downloaded).digest('hex'),receipt.ciphertextSha256);writeFileSync(encrypted,downloaded,{flag:'wx',mode:0o600});}finally{downloaded.fill(0);}
 stage = 'complete authenticated off-server decryption';
 const recovery = get('kavosh-one-production-backup-recovery'), output = openSync(plaintext, 'wx', 0o600);
 try { execFileSync('/opt/homebrew/bin/age', ['--decrypt', '--identity', '-', encrypted], { input: recovery.identity, stdio: ['pipe', output, 'pipe'], timeout: 30000 }); } finally { closeSync(output); recovery.identity = ''; }
 stage = 'archive paths and credential completeness';
 const entries = execFileSync('/usr/bin/tar', ['-tf', plaintext], { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim().split('\n');
 const units=readdirSync(new URL('../deploy/ovh/',import.meta.url)).filter(name=>/^kavosh-one.*\.(?:service|timer)$/.test(name));
 const required = [...new Set(['roles.sql', 'etc/kavosh-one/web.env', 'etc/kavosh-one/backup.env', 'etc/kavosh-one/drive.json', 'etc/kavosh-one/twilio-credentials.json', 'etc/kavosh-one/r2-upload.json', 'etc/kavosh-one/r2-scan.json', 'etc/kavosh-one/r2-promote.json', 'etc/kavosh-one/r2-download.json', 'etc/kavosh-one-tls/server.crt', 'etc/caddy/kavosh-one.caddy', 'etc/kavosh-one-scanner/clamd.conf', 'etc/apparmor.d/local/usr.sbin.clamd','etc/apparmor.d/kavosh-one-parser',...units.map(name=>'etc/systemd/system/'+name),...['auth-delivery','file-inspection','file-promotion','file-verification','background-notifications','background-reports','background-messages','background-platform-notices'].map(name=>'etc/kavosh-one/'+name+'.env')])];
 for (const file of required) assert.ok(entries.includes(file));
 assert.equal(new Set(entries).size,entries.length);
 for (const name of entries) {assert.ok(!name.startsWith('/')&&!name.split('/').some(part=>part==='.'||part==='..')&&!name.includes('\0'));assert.ok(name === 'roles.sql' || /^(etc\/kavosh-one(?:\/|$)|etc\/kavosh-one-tls(?:\/|$)|etc\/kavosh-one-scanner(?:\/|$)|etc\/postgresql\/18\/main(?:\/|$)|etc\/apparmor\.d\/local\/usr\.sbin\.clamd$|etc\/apparmor\.d\/kavosh-one-parser$|etc\/caddy\/kavosh-one\.caddy$|etc\/systemd\/system\/kavosh-one[^/]*\.(?:service|timer)$)/.test(name));}
 const content = name => execFileSync('/usr/bin/tar', ['-xOf', plaintext, name], { stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1048576 });
 for (const name of required) {
  const bytes = content(name);
  try {
   assert.ok(bytes.length > 0);
   if (name.endsWith('.json')) assert.equal(typeof JSON.parse(bytes.toString()), 'object');
   if (name === 'roles.sql') { assert.ok(bytes.includes(Buffer.from('CREATE ROLE'))); assert.ok(!/\bPASSWORD\s+'/i.test(bytes.toString())); }
  } finally { bytes.fill(0); }
 }
 console.log(JSON.stringify({ backupId: receipt.id, encryptedBytes: receipt.encryptedBytes, ciphertextSha256: receipt.ciphertextSha256, independentDriveDownloadVerified: true, authenticatedOffServerDecryptionVerified: true, requiredFilesChecked: required.length, archiveEntriesChecked: entries.length, passwordFreeRolesVerified: true, landingPageExcluded: true, privateRecoveryKeyTransferredToVps: false, configurationApplied: false, fullServerRebuildVerified: false }));
} catch { console.error('CONFIG_BACKUP_ACCEPTANCE_FAILED: ' + stage); process.exitCode = 1; }
finally {
 for (const file of [plaintext, encrypted]) if (file) try { unlinkSync(file); } catch (error) { if (error.code !== 'ENOENT') { console.error('CONFIG_PROOF_CLEANUP_REQUIRED'); process.exitCode = 1; } }
 if (directory) try { rmdirSync(directory); } catch { console.error('CONFIG_PROOF_CLEANUP_REQUIRED'); process.exitCode = 1; }
}
