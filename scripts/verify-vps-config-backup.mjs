// Explicit operator acceptance: download and authenticate off-server; never
// apply configuration, restore roles, or print decrypted credentials.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash,createPrivateKey,X509Certificate } from 'node:crypto';
import { mkdtempSync, openSync, closeSync,readdirSync,readFileSync,writeFileSync, unlinkSync, rmdirSync } from 'node:fs';
import { join } from 'node:path';
import {verifyProfileImageRecovery} from '../src/operations/profile-image-recovery.mjs';
let stage = 'arguments', directory, encrypted, plaintext;
const get = service => {
 const bytes = execFileSync('/usr/bin/security', ['find-generic-password', '-a', 'kavosh-one', '-s', service, '-w'], { stdio: ['ignore', 'pipe', 'pipe'] });
 try { return JSON.parse(bytes.toString()); } finally { bytes.fill(0); }
};
try {
 assert.equal(process.platform, 'darwin');const args=process.argv.slice(2),order=['--execute','--require-private-data','--require-platform-connection','--require-public-profile','--require-profile-images'];assert.ok(args.length>=1&&args.length<=order.length);assert.deepEqual(args,order.slice(0,args.length));const requirePrivateData=args.length>=2,requirePlatformConnection=args.length>=3,requirePublicProfile=args.length>=4,requireProfileImages=args.length===5;process.umask(0o077);
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
 let mediaBackupOperator,operationalHealthProfileSha256,reportRuntimeProfileSha256,signedEvidenceBackupConfigured=false,agreementBackupReaderIncluded=false,agreementCompletionWorkerEnabled=false,agreementWorkerMonitorEnabled=false,profileImageWorkerMonitorEnabled=false,privateDataKeysIncluded=false,platformConnectionIncluded=false,platformGatewayEnabled=false,publicProfileConnectionIncluded=false,publicProfilesEnabled=false;const serviceUnitSha256={};
 for (const name of required) {
  const bytes = content(name);
  try {
   assert.ok(bytes.length > 0);
   if(name==='etc/kavosh-one/web.env'){
    const matches=[...bytes.toString().matchAll(/^((?:STUDENT_CARE|PAYROLL)_PRIVATE_[A-Z0-9_]+)=(.*)$/gm)];
    if(matches.length){
     const expected=['STUDENT_CARE','PAYROLL'].flatMap(p=>['_PRIVATE_ACTIVE_KEY_ID','_PRIVATE_KEYS','_PRIVATE_FINGERPRINT_KEY'].map(s=>p+s));assert.equal(matches.length,expected.length);assert.deepEqual(matches.map(m=>m[1]).sort(),expected.sort());const values=Object.fromEntries(matches.map(m=>[m[1],JSON.parse(m[2])])),material=[];
     for(const prefix of ['STUDENT_CARE','PAYROLL']){const active=values[prefix+'_PRIVATE_ACTIVE_KEY_ID'],keys=JSON.parse(values[prefix+'_PRIVATE_KEYS']);assert.match(active,/^[a-z][a-z0-9_-]{0,31}$/);assert.ok(keys&&typeof keys==='object'&&!Array.isArray(keys));const entries=Object.entries(keys);assert.ok(entries.length>=1&&entries.length<=10&&Object.hasOwn(keys,active));for(const [id,key]of entries){assert.match(id,/^[a-z][a-z0-9_-]{0,31}$/);material.push(key);}material.push(values[prefix+'_PRIVATE_FINGERPRINT_KEY']);}
     for(const key of material){assert.match(key,/^[A-Za-z0-9_-]{43}$/);const decoded=Buffer.from(key,'base64url');try{assert.equal(decoded.length,32);assert.equal(decoded.toString('base64url'),key);}finally{decoded.fill(0);}}assert.equal(new Set(material).size,material.length);privateDataKeysIncluded=true;
    }
    if(requirePrivateData)assert.equal(privateDataKeysIncluded,true);
    const platformMatches=[...bytes.toString().matchAll(/^(PLATFORM_(?:ENABLED|DATABASE_URL))=(.*)$/gm)];
    if(platformMatches.length){assert.deepEqual(platformMatches.map(m=>m[1]).sort(),['PLATFORM_DATABASE_URL','PLATFORM_ENABLED']);const values=Object.fromEntries(platformMatches.map(m=>[m[1],JSON.parse(m[2])]));assert.ok(['true','false'].includes(values.PLATFORM_ENABLED));const url=new URL(values.PLATFORM_DATABASE_URL);assert.equal(url.protocol,'postgresql:');assert.equal(url.hostname,'127.0.0.1');assert.equal(url.port,'5432');assert.equal(url.pathname,'/kavosh_one');assert.equal(url.username,'kavosh_one_platform');assert.match(url.password,/^[A-Za-z0-9_-]{64}$/);assert.equal(url.search,'');assert.equal(url.hash,'');platformConnectionIncluded=true;platformGatewayEnabled=values.PLATFORM_ENABLED==='true';}
    if(requirePlatformConnection)assert.equal(platformConnectionIncluded,true);
    const publicMatches=[...bytes.toString().matchAll(/^((?:PUBLIC_PROFILE[A-Z0-9_]*|PROFILE_SHARE_ORIGIN))=(.*)$/gm)];
    if(publicMatches.length){assert.deepEqual(publicMatches.map(m=>m[1]).sort(),['PROFILE_SHARE_ORIGIN','PUBLIC_PROFILES_ENABLED','PUBLIC_PROFILE_BUDGET_SECRET','PUBLIC_PROFILE_DATABASE_URL']);const v=Object.fromEntries(publicMatches.map(m=>[m[1],JSON.parse(m[2])]));assert.ok(['true','false'].includes(v.PUBLIC_PROFILES_ENABLED));assert.equal(v.PROFILE_SHARE_ORIGIN,'https://one.kavosh.ai');assert.match(v.PUBLIC_PROFILE_BUDGET_SECRET,/^[A-Za-z0-9_-]{43}$/);const key=Buffer.from(v.PUBLIC_PROFILE_BUDGET_SECRET,'base64url');try{assert.equal(key.length,32);assert.equal(key.toString('base64url'),v.PUBLIC_PROFILE_BUDGET_SECRET);}finally{key.fill(0);}const edge=[...bytes.toString().matchAll(/^EDGE_AUTH_SECRET=(.*)$/gm)];assert.equal(edge.length,1);const edgeKey=edge[0][1].startsWith('"')?JSON.parse(edge[0][1]):edge[0][1];assert.match(edgeKey,/^[A-Za-z0-9_-]{32,4096}$/);assert.notEqual(v.PUBLIC_PROFILE_BUDGET_SECRET,edgeKey);const u=new URL(v.PUBLIC_PROFILE_DATABASE_URL);assert.equal(u.protocol,'postgresql:');assert.equal(u.hostname,'127.0.0.1');assert.equal(u.port,'5432');assert.equal(u.pathname,'/kavosh_one');assert.equal(u.username,'kavosh_one_public_profile');assert.match(u.password,/^[A-Za-z0-9_-]{64}$/);assert.equal(u.search,'');assert.equal(u.hash,'');publicProfileConnectionIncluded=true;publicProfilesEnabled=v.PUBLIC_PROFILES_ENABLED==='true';}
    if(requirePublicProfile)assert.equal(publicProfileConnectionIncluded,true);
   }
   if(/^etc\/systemd\/system\/kavosh-one[^/]*\.(?:service|timer)$/.test(name))serviceUnitSha256[name.slice('etc/systemd/system/'.length)]=createHash('sha256').update(bytes).digest('hex');
   if(name==='etc/systemd/system/kavosh-one-monitor.service'){
    const template=readFileSync(new URL('../deploy/ovh/kavosh-one-monitor.service',import.meta.url)).toString(),signing='Environment=SIGNATURE_COMPLETION_MONITOR_ENABLED=false\n',images='Environment=PROFILE_IMAGE_MONITOR_ENABLED=false\n';assert.equal(template.split(signing).length,2);assert.equal(template.split(images).length,2);
    let matched=false;
    for(const s of [null,false,true])for(const i of [null,false,true]){
     const candidate=template.replace(signing,s===null?'':'Environment=SIGNATURE_COMPLETION_MONITOR_ENABLED='+s+'\n').replace(images,i===null?'':'Environment=PROFILE_IMAGE_MONITOR_ENABLED='+i+'\n');
     if(bytes.equals(Buffer.from(candidate))){assert.equal(matched,false);matched=true;agreementWorkerMonitorEnabled=s===true;profileImageWorkerMonitorEnabled=i===true;}
    }
    assert.equal(matched,true);
   }
   if(name===operationalHealthProfile){assert.ok(bytes.equals(readFileSync(new URL('../deploy/ovh/kavosh-one-platform-notices-health.conf',import.meta.url))));operationalHealthProfileSha256=createHash('sha256').update(bytes).digest('hex');}
   if(name===reportRuntimeProfile){assert.ok(bytes.equals(readFileSync(new URL('../deploy/ovh/kavosh-one-reports-runtime.conf',import.meta.url))));reportRuntimeProfileSha256=createHash('sha256').update(bytes).digest('hex');}
   if (name.endsWith('.json')) assert.equal(typeof JSON.parse(bytes.toString()), 'object');
   if (name === 'roles.sql') { assert.ok(bytes.includes(Buffer.from('CREATE ROLE'))); assert.ok(!/\bPASSWORD\s+'/i.test(bytes.toString())); }
   if(name==='etc/kavosh-one/media-backup.env'){const text=bytes.toString();assert.match(text,/^KAVOSH_BACKUP_OPERATOR_CLI=\/srv\/kavosh-one\/operations\/recovery-[a-f0-9]{7,40}\/scripts\/database-recovery\.js\n(?:KAVOSH_BACKUP_SIGNED_EVIDENCE_ENABLED=true\n)?$/);signedEvidenceBackupConfigured=text.endsWith('KAVOSH_BACKUP_SIGNED_EVIDENCE_ENABLED=true\n');mediaBackupOperator=text.split('\n')[0].slice('KAVOSH_BACKUP_OPERATOR_CLI='.length);}
  } finally { bytes.fill(0); }
 }
 stage='archived database TLS certificate and private key matching';
 const certificate=content('etc/kavosh-one-tls/server.crt'),privateKey=content('etc/kavosh-one-tls/server.key');
 try{assert.ok(new X509Certificate(certificate).checkPrivateKey(createPrivateKey(privateKey)));}finally{certificate.fill(0);privateKey.fill(0);}
 stage='archived platform connection and TLS authentication binding';
 if(platformConnectionIncluded){
  const hbaPath='etc/postgresql/18/main/pg_hba.conf',beforePath='etc/kavosh-one/platform-hba.before';for(const name of [hbaPath,beforePath]){assert.ok(entries.includes(name));if(!required.includes(name))required.push(name);}const parts=['roles.sql',hbaPath,beforePath].map(content);
  try{assert.match(parts[0].toString(),/\bCREATE ROLE "?kavosh_one_platform"?;/);assert.match(parts[0].toString(),/\bGRANT "?kavosh_platform_service"? TO "?kavosh_one_platform"?(?:\s|;)/);assert.equal(parts[1].toString().split('\n').filter(l=>l.trim()==='hostssl kavosh_one kavosh_one_platform 127.0.0.1/32 scram-sha-256').length,1);assert.ok(parts[2].length>0);}finally{for(const bytes of parts)bytes.fill(0);}
 }
 if(publicProfileConnectionIncluded){
  stage='archived public-profile connection and TLS authentication binding';const hba='etc/postgresql/18/main/pg_hba.conf',before='etc/kavosh-one/public-profile-hba.before';for(const n of [hba,before]){assert.ok(entries.includes(n));if(!required.includes(n))required.push(n);}const parts=['roles.sql',hba,before].map(content);try{assert.match(parts[0].toString(),/\bCREATE ROLE "?kavosh_one_public_profile"?;/);assert.match(parts[0].toString(),/\bGRANT "?kavosh_public_profile_service"? TO "?kavosh_one_public_profile"?(?:\s|;)/);assert.equal(parts[1].toString().split('\n').filter(l=>l.trim()==='hostssl kavosh_one kavosh_one_public_profile 127.0.0.1/32 scram-sha-256').length,1);assert.ok(parts[2].length>0);}finally{for(const b of parts)b.fill(0);}
 }
 stage='archived agreement worker and separate private vault binding';
 const signingNames=['initial-academy.json','boldsign-production.json','signature-vault-production.json','signature-completion.env'],signingBytes=signingNames.map(name=>content('etc/kavosh-one/'+name));
 try{
  const [academy,provider,vault]=signingBytes.slice(0,3).map(b=>JSON.parse(b.toString())),env={};
  for(const line of signingBytes[3].toString().trim().split('\n')){const at=line.indexOf('=');assert.ok(at>0);const key=line.slice(0,at);assert.equal(Object.hasOwn(env,key),false);env[key]=JSON.parse(line.slice(at+1));}
  const keys=['NODE_ENV','DATABASE_SSL_MODE','NODE_EXTRA_CA_CERTS','SIGNATURE_COMPLETION_WORKER_ENABLED','SIGNATURE_COMPLETION_DATABASE_URL','SIGNATURE_COMPLETION_CONNECTIONS'];assert.deepEqual(Object.keys(env).sort(),keys.sort());
  assert.equal(env.NODE_ENV,'production');assert.equal(env.DATABASE_SSL_MODE,'require');assert.equal(env.NODE_EXTRA_CA_CERTS,'/etc/kavosh-one-tls/server.crt');assert.ok(['true','false'].includes(env.SIGNATURE_COMPLETION_WORKER_ENABLED));agreementCompletionWorkerEnabled=env.SIGNATURE_COMPLETION_WORKER_ENABLED==='true';
  assert.match(academy.academyId,/^[a-f0-9-]{36}$/);assert.equal(provider.region,'CA');assert.equal(provider.environment,'Live');assert.equal(typeof provider.apiKey,'string');assert.ok(provider.apiKey.length>0);
  assert.deepEqual(Object.keys(vault).sort(),['accountId','jurisdiction','bucket','accessKeyId','secretAccessKey','maximumUploadBytes'].sort());assert.match(vault.accountId,/^[a-f0-9]{32}$/);assert.equal(vault.jurisdiction,'default');assert.equal(vault.bucket,'kavosh-one-production-agreements');assert.match(vault.accessKeyId,/^[a-f0-9]{32}$/);assert.match(vault.secretAccessKey,/^[a-f0-9]{64}$/);assert.equal(vault.maximumUploadBytes,10485760);
  const connections=JSON.parse(env.SIGNATURE_COMPLETION_CONNECTIONS);assert.equal(connections.length,1);assert.equal(connections[0].academyId,academy.academyId);assert.deepEqual(connections[0].archive,vault);assert.equal(connections[0].providers.length,1);const bound=connections[0].providers[0];assert.equal(bound.region,provider.region);assert.equal(bound.environment,provider.environment);assert.equal(bound.apiKey,provider.apiKey);assert.equal(bound.clientId,null);assert.match(bound.connectionId,/^[a-f0-9-]{36}$/);
  const database=new URL(env.SIGNATURE_COMPLETION_DATABASE_URL);assert.equal(database.protocol,'postgresql:');assert.equal(database.username,'kavosh_one_signature_completion');assert.equal(database.hostname,'127.0.0.1');assert.equal(database.port,'5432');assert.equal(database.pathname,'/kavosh_one');assert.ok(database.password.length>=48);assert.equal(database.search,'');assert.equal(database.hash,'');
  const readerPath='etc/kavosh-one/signature-vault-backup-reader.json';if(signedEvidenceBackupConfigured)assert.ok(entries.includes(readerPath));
  if(entries.includes(readerPath)){
   required.push(readerPath);const readerBytes=content(readerPath);signingBytes.push(readerBytes);const reader=JSON.parse(readerBytes.toString());
   assert.deepEqual(Object.keys(reader).sort(),Object.keys(vault).sort());for(const field of ['accountId','jurisdiction','bucket','maximumUploadBytes'])assert.equal(reader[field],vault[field]);assert.match(reader.accessKeyId,/^[a-f0-9]{32}$/);assert.match(reader.secretAccessKey,/^[a-f0-9]{64}$/);assert.notEqual(reader.accessKeyId,vault.accessKeyId);agreementBackupReaderIncluded=true;
   if(signedEvidenceBackupConfigured){const targetsBytes=content('etc/kavosh-one/media-readers.json');signingBytes.push(targetsBytes);const targets=JSON.parse(targetsBytes.toString());assert.equal(targets.length,3);assert.equal(targets.map(t=>t.stage).sort().join(','),'clean,quarantine,signature-evidence');assert.deepEqual(targets.find(t=>t.stage==='signature-evidence').configuration,reader);assert.equal(new Set(targets.map(t=>t.configuration.accessKeyId)).size,3);}
  }
 }finally{for(const bytes of signingBytes)bytes.fill(0);}
 let profileImages={profileImageCredentialBindingVerified:false,profileImageWorkerEnabled:false};
 if(requireProfileImages||entries.includes('etc/kavosh-one/profile-images.env')){
  stage='archived image-worker restricted credential and private storage binding';
  const paths={configuration:'etc/kavosh-one/profile-images.env',academy:'etc/kavosh-one/initial-academy.json',reader:'etc/kavosh-one/r2-download.json',writer:'etc/kavosh-one/r2-promote.json',roles:'roles.sql',hba:'etc/postgresql/18/main/pg_hba.conf',beforeHba:'etc/kavosh-one/profile-images-hba.before',unit:'etc/systemd/system/kavosh-one-profile-images.service'},buffers=[];
  try{const files={};for(const [key,name]of Object.entries(paths)){assert.ok(entries.includes(name));if(!required.includes(name))required.push(name);const bytes=content(name);buffers.push(bytes);files[key]=bytes.toString();}profileImages=verifyProfileImageRecovery(files,readFileSync(new URL('../deploy/ovh/kavosh-one-profile-images.service',import.meta.url)).toString());}finally{for(const bytes of buffers)bytes.fill(0);}
 }
 console.log(JSON.stringify({ backupId: receipt.id,...profileImages, encryptedBytes: receipt.encryptedBytes, ciphertextSha256: receipt.ciphertextSha256, independentDriveDownloadVerified: true, authenticatedOffServerDecryptionVerified: true, requiredFilesChecked: required.length, archiveEntriesChecked: entries.length, passwordFreeRolesVerified: true,privateDataKeysIncluded,platformConnectionIncluded,platformGatewayEnabled,publicProfileConnectionIncluded,publicProfilesEnabled,databaseTlsKeyPairVerified:true,agreementWorkerVaultBindingVerified:true,agreementBackupReaderIncluded,agreementCompletionWorkerEnabled,agreementWorkerMonitorEnabled,profileImageWorkerMonitorEnabled,signedEvidenceBackupConfigured,mediaBackupOperator,serviceUnitSha256,operationalHealthProfileSha256,reportRuntimeProfileSha256, landingPageExcluded: true, privateRecoveryKeyTransferredToVps: false, configurationApplied: false, fullServerRebuildVerified: false }));
} catch { console.error('CONFIG_BACKUP_ACCEPTANCE_FAILED: ' + stage); process.exitCode = 1; }
finally {
 for (const file of [plaintext, encrypted]) if (file) try { unlinkSync(file); } catch (error) { if (error.code !== 'ENOENT') { console.error('CONFIG_PROOF_CLEANUP_REQUIRED'); process.exitCode = 1; } }
 if (directory) try { rmdirSync(directory); } catch { console.error('CONFIG_PROOF_CLEANUP_REQUIRED'); process.exitCode = 1; }
}
