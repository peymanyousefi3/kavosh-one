// Explicit operator acceptance: download and authenticate off-server; never
// apply configuration, restore roles, or print decrypted credentials.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash,createPrivateKey,X509Certificate } from 'node:crypto';
import { mkdtempSync, openSync, closeSync,readdirSync,readFileSync,writeFileSync, unlinkSync, rmdirSync } from 'node:fs';
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
 const operationalHealthProfile='etc/systemd/system/kavosh-one-background@platform-notices.service.d/operational-health.conf';
 const reportRuntimeProfile='etc/systemd/system/kavosh-one-background@reports.service.d/runtime.conf';
 required.push('etc/kavosh-one/media-readers.json','etc/kavosh-one/media-backup.env','etc/systemd/system/kavosh-one-backup.service.d/media.conf',operationalHealthProfile,reportRuntimeProfile);
 required.push('etc/kavosh-one-tls/server.key');
 required.push(...['initial-academy.json','boldsign-production.json','signature-vault-production.json','signature-completion.env','signature-completion-hba.before'].map(name=>'etc/kavosh-one/'+name));
 for (const file of required) assert.ok(entries.includes(file));
 assert.equal(new Set(entries).size,entries.length);
 for (const name of entries) {assert.ok(!name.startsWith('/')&&!name.split('/').some(part=>part==='.'||part==='..')&&!name.includes('\0'));assert.ok(name === 'roles.sql' || /^(etc\/kavosh-one(?:\/|$)|etc\/kavosh-one-tls(?:\/|$)|etc\/kavosh-one-scanner(?:\/|$)|etc\/postgresql\/18\/main(?:\/|$)|etc\/apparmor\.d\/local\/usr\.sbin\.clamd$|etc\/apparmor\.d\/kavosh-one-parser$|etc\/caddy\/kavosh-one\.caddy$|etc\/systemd\/system\/kavosh-one[^/]*\.(?:service|timer)$)/.test(name)||/^etc\/systemd\/system\/kavosh-one-backup\.service\.d(?:\/?|\/media\.conf)$/.test(name)||/^etc\/systemd\/system\/kavosh-one-background@platform-notices\.service\.d(?:\/?|\/operational-health\.conf)$/.test(name)||/^etc\/systemd\/system\/kavosh-one-background@reports\.service\.d(?:\/?|\/runtime\.conf)$/.test(name));}
 const content = name => execFileSync('/usr/bin/tar', ['-xOf', plaintext, name], { stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1048576 });
 let mediaBackupOperator,operationalHealthProfileSha256,reportRuntimeProfileSha256;const serviceUnitSha256={};
 for (const name of required) {
  const bytes = content(name);
  try {
   assert.ok(bytes.length > 0);
   if(/^etc\/systemd\/system\/kavosh-one[^/]*\.(?:service|timer)$/.test(name))serviceUnitSha256[name.slice('etc/systemd/system/'.length)]=createHash('sha256').update(bytes).digest('hex');
   if(name===operationalHealthProfile){assert.ok(bytes.equals(readFileSync(new URL('../deploy/ovh/kavosh-one-platform-notices-health.conf',import.meta.url))));operationalHealthProfileSha256=createHash('sha256').update(bytes).digest('hex');}
   if(name===reportRuntimeProfile){assert.ok(bytes.equals(readFileSync(new URL('../deploy/ovh/kavosh-one-reports-runtime.conf',import.meta.url))));reportRuntimeProfileSha256=createHash('sha256').update(bytes).digest('hex');}
   if (name.endsWith('.json')) assert.equal(typeof JSON.parse(bytes.toString()), 'object');
   if (name === 'roles.sql') { assert.ok(bytes.includes(Buffer.from('CREATE ROLE'))); assert.ok(!/\bPASSWORD\s+'/i.test(bytes.toString())); }
   if(name==='etc/kavosh-one/media-backup.env'){const text=bytes.toString();assert.match(text,/^KAVOSH_BACKUP_OPERATOR_CLI=\/srv\/kavosh-one\/operations\/recovery-[a-f0-9]{7,40}\/scripts\/database-recovery\.js\n$/);assert.equal(text.split('\n').length,2);mediaBackupOperator=text.slice('KAVOSH_BACKUP_OPERATOR_CLI='.length).trim();}
  } finally { bytes.fill(0); }
 }
 stage='archived database TLS certificate and private key matching';
 const certificate=content('etc/kavosh-one-tls/server.crt'),privateKey=content('etc/kavosh-one-tls/server.key');
 try{assert.ok(new X509Certificate(certificate).checkPrivateKey(createPrivateKey(privateKey)));}finally{certificate.fill(0);privateKey.fill(0);}
 stage='archived agreement worker and separate private vault binding';
 const signingNames=['initial-academy.json','boldsign-production.json','signature-vault-production.json','signature-completion.env'],signingBytes=signingNames.map(name=>content('etc/kavosh-one/'+name));
 try{
  const [academy,provider,vault]=signingBytes.slice(0,3).map(b=>JSON.parse(b.toString())),env={};
  for(const line of signingBytes[3].toString().trim().split('\n')){const at=line.indexOf('=');assert.ok(at>0);const key=line.slice(0,at);assert.equal(Object.hasOwn(env,key),false);env[key]=JSON.parse(line.slice(at+1));}
  const keys=['NODE_ENV','DATABASE_SSL_MODE','NODE_EXTRA_CA_CERTS','SIGNATURE_COMPLETION_WORKER_ENABLED','SIGNATURE_COMPLETION_DATABASE_URL','SIGNATURE_COMPLETION_CONNECTIONS'];assert.deepEqual(Object.keys(env).sort(),keys.sort());
  assert.equal(env.NODE_ENV,'production');assert.equal(env.DATABASE_SSL_MODE,'require');assert.equal(env.NODE_EXTRA_CA_CERTS,'/etc/kavosh-one-tls/server.crt');assert.ok(['true','false'].includes(env.SIGNATURE_COMPLETION_WORKER_ENABLED));
  assert.match(academy.academyId,/^[a-f0-9-]{36}$/);assert.equal(provider.region,'CA');assert.equal(provider.environment,'Live');assert.equal(typeof provider.apiKey,'string');assert.ok(provider.apiKey.length>0);
  assert.deepEqual(Object.keys(vault).sort(),['accountId','jurisdiction','bucket','accessKeyId','secretAccessKey','maximumUploadBytes'].sort());assert.match(vault.accountId,/^[a-f0-9]{32}$/);assert.equal(vault.jurisdiction,'default');assert.equal(vault.bucket,'kavosh-one-production-agreements');assert.match(vault.accessKeyId,/^[a-f0-9]{32}$/);assert.match(vault.secretAccessKey,/^[a-f0-9]{64}$/);assert.equal(vault.maximumUploadBytes,10485760);
  const connections=JSON.parse(env.SIGNATURE_COMPLETION_CONNECTIONS);assert.equal(connections.length,1);assert.equal(connections[0].academyId,academy.academyId);assert.deepEqual(connections[0].archive,vault);assert.equal(connections[0].providers.length,1);const bound=connections[0].providers[0];assert.equal(bound.region,provider.region);assert.equal(bound.environment,provider.environment);assert.equal(bound.apiKey,provider.apiKey);assert.equal(bound.clientId,null);assert.match(bound.connectionId,/^[a-f0-9-]{36}$/);
  const database=new URL(env.SIGNATURE_COMPLETION_DATABASE_URL);assert.equal(database.protocol,'postgresql:');assert.equal(database.username,'kavosh_one_signature_completion');assert.equal(database.hostname,'127.0.0.1');assert.equal(database.port,'5432');assert.equal(database.pathname,'/kavosh_one');assert.ok(database.password.length>=48);assert.equal(database.search,'');assert.equal(database.hash,'');
 }finally{for(const bytes of signingBytes)bytes.fill(0);}
 console.log(JSON.stringify({ backupId: receipt.id, encryptedBytes: receipt.encryptedBytes, ciphertextSha256: receipt.ciphertextSha256, independentDriveDownloadVerified: true, authenticatedOffServerDecryptionVerified: true, requiredFilesChecked: required.length, archiveEntriesChecked: entries.length, passwordFreeRolesVerified: true,databaseTlsKeyPairVerified:true,agreementWorkerVaultBindingVerified:true,mediaBackupOperator,serviceUnitSha256,operationalHealthProfileSha256,reportRuntimeProfileSha256, landingPageExcluded: true, privateRecoveryKeyTransferredToVps: false, configurationApplied: false, fullServerRebuildVerified: false }));
} catch { console.error('CONFIG_BACKUP_ACCEPTANCE_FAILED: ' + stage); process.exitCode = 1; }
finally {
 for (const file of [plaintext, encrypted]) if (file) try { unlinkSync(file); } catch (error) { if (error.code !== 'ENOENT') { console.error('CONFIG_PROOF_CLEANUP_REQUIRED'); process.exitCode = 1; } }
 if (directory) try { rmdirSync(directory); } catch { console.error('CONFIG_PROOF_CLEANUP_REQUIRED'); process.exitCode = 1; }
}
