// Explicit owner-authorized Mac -> specified Kavosh VPS provisioning.
// The age PRIVATE key remains in macOS Keychain and never enters SSH or Git.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { timingSafeEqual } from 'node:crypto';
const account = 'kavosh-one', recoveryService = 'kavosh-one-production-backup-recovery';
const key = '/Users/peymanyousefi/Documents/Codex/2026-09-03/linkedin-plugin-app-69949aa62bf48191be5e57a01202beca-openai-curated/work/github-handoff-2026-09-11/kavosh-vps-admin';
const known = key.slice(0, key.lastIndexOf('/')) + '/known_hosts';
function get(service) { return execFileSync('/usr/bin/security', ['find-generic-password', '-a', account, '-s', service, '-w'], { stdio: ['ignore', 'pipe', 'pipe'] }); }
function store(service, value, update = false) {
 const encoded = JSON.stringify(value), command = 'add-generic-password ' + (update ? '-U ' : '') + '-a ' + account + ' -s ' + service + ' -l "Kavosh One encrypted backup" -w ' + JSON.stringify(encoded) + '\n';
 const result = spawnSync('/usr/bin/security', ['-iq'], { input: command, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
 assert.equal(result.status, 0);
 const actual = get(service), expected = Buffer.from(encoded);
 try { const trimmed = Buffer.from(actual.toString().trim()); assert.equal(trimmed.length, expected.length); assert.ok(timingSafeEqual(trimmed, expected)); trimmed.fill(0); } finally { actual.fill(0); expected.fill(0); }
}
async function json(url, options = {}) {
 const response = await fetch(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(15000) });
 if (!response.ok) { await response.body?.cancel(); throw new Error('DRIVE_AUTHORIZATION_REQUIRED'); }
 const bytes = await response.text(); if (bytes.length > 65536) throw new Error('PROVIDER_RESPONSE_LIMIT'); return JSON.parse(bytes);
}
let stage = 'configuration';
try {
 assert.equal(process.platform, 'darwin'); assert.deepEqual(process.argv.slice(2), ['--execute']);
 stage = 'limited Drive connection'; const raw = get('kavosh-one-drive-backup-connection'); let drive;
 try { drive = JSON.parse(raw.toString()); } finally { raw.fill(0); }
 assert.equal(drive.token.scope, 'https://www.googleapis.com/auth/drive.file');
 stage = 'Drive token refresh';
 const refreshed = await json('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: drive.clientId, client_secret: drive.clientSecret, refresh_token: drive.token.refresh_token, grant_type: 'refresh_token' }) });
 assert.equal(refreshed.token_type, 'Bearer'); assert.equal(refreshed.scope ?? drive.token.scope, drive.token.scope); assert.equal(typeof refreshed.access_token, 'string'); assert.ok(Number.isSafeInteger(refreshed.expires_in) && refreshed.expires_in > 0);
 drive.token = { ...drive.token, access_token: refreshed.access_token, refresh_token: refreshed.refresh_token ?? drive.token.refresh_token, expiry: new Date(Date.now() + refreshed.expires_in * 1000).toISOString() };
 store('kavosh-one-drive-backup-connection', drive, true);
 stage = 'private Drive folder';
 const folder = await json('https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(drive.folderId) + '?' + new URLSearchParams({ fields: 'id,name,mimeType,ownedByMe,shared,permissions(role,type,deleted)' }), { headers: { authorization: 'Bearer ' + drive.token.access_token } });
 assert.equal(folder.id, drive.folderId); assert.equal(folder.mimeType, 'application/vnd.google-apps.folder'); assert.equal(folder.ownedByMe, true); assert.equal(folder.shared, false); assert.equal(folder.permissions.length, 1); assert.equal(folder.permissions[0].role, 'owner'); assert.equal(folder.permissions[0].type, 'user'); assert.notEqual(folder.permissions[0].deleted, true);
 stage = 'off-server recovery key'; let recovery;
 try { const bytes = get(recoveryService); try { recovery = JSON.parse(bytes.toString()); } finally { bytes.fill(0); } }
 catch (error) {
  if (error.status !== 44) throw error;
  const identity = execFileSync('/opt/homebrew/bin/age-keygen', [], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000 });
  try { recovery = { identity: identity.toString(), recipient: execFileSync('/opt/homebrew/bin/age-keygen', ['-y'], { input: identity, stdio: ['pipe', 'pipe', 'pipe'], timeout: 5000 }).toString().trim(), createdAt: new Date().toISOString() }; store(recoveryService, recovery); } finally { identity.fill(0); }
 }
 assert.match(recovery.recipient, /^age1[023456789acdefghjklmnpqrstuvwxyz]{58}$/);
 assert.equal(execFileSync('/opt/homebrew/bin/age-keygen', ['-y'], { input: recovery.identity, stdio: ['pipe', 'pipe', 'pipe'], timeout: 5000 }).toString().trim(), recovery.recipient);
 stage = 'specified VPS credential store';
 const remote = `const fs=require('node:fs');const x=JSON.parse(fs.readFileSync(0,'utf8'));if(x.drive.token.scope!=='https://www.googleapis.com/auth/drive.file'||!/^age1[023456789acdefghjklmnpqrstuvwxyz]{58}$/.test(x.recipient))throw Error('INVALID_CONNECTION');fs.writeFileSync('/etc/kavosh-one/drive.json',JSON.stringify(x.drive),{mode:0o600,flag:'wx'});console.log(JSON.stringify({recipient:x.recipient,driveConnectionInstalled:true,privateRecoveryKeyTransferred:false}));`;
 const result = execFileSync('/usr/bin/ssh', ['-i', key, '-o', 'UserKnownHostsFile=' + known, '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=10', 'ubuntu@148.113.194.110', 'sudo node -e ' + "'" + remote.replaceAll("'", "'\\''") + "'"], { input: JSON.stringify({ drive, recipient: recovery.recipient }), stdio: ['pipe', 'pipe', 'pipe'], timeout: 30000, maxBuffer: 65536 });
 const installed = JSON.parse(result.toString()); assert.equal(installed.recipient, recovery.recipient); assert.equal(installed.privateRecoveryKeyTransferred, false); assert.equal(installed.driveConnectionInstalled, true);
 console.log(JSON.stringify({ ...installed, privateDriveFolderVerified: true, limitedDriveFileScopeVerified: true, recoveryKeychainService: recoveryService, googlePublishingStatusMustBeVerifiedSeparately: true }));
} catch { console.error('VPS_BACKUP_CONNECTION_FAILED: ' + stage); process.exitCode = 1; }
