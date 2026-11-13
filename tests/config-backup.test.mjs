import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync,readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {runInNewContext} from 'node:vm';
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
test('operational collector profile grants only monitor-metadata read membership and is included in settings recovery',()=>{
 const profile=read('kavosh-one-platform-notices-health.conf');assert.equal(profile,'[Service]\nWorkingDirectory=/srv/kavosh-one/operations/platform-notices-910769467d110f74bb67a82ea214ce2fc97083fc\nSupplementaryGroups=kavosh-one-monitor\nEnvironment=PLATFORM_OPERATIONAL_HEALTH_ENABLED=true\n');assert.ok(read('run-config-backup.sh').split(/\s+/).includes('etc/systemd/system/kavosh-one-background@platform-notices.service.d'));assert.doesNotMatch(profile,/User=|Group=root|ExecStart|LoadCredential|EnvironmentFile|Capability|ReadWritePaths/);assert.equal(read('kavosh-one-background@.service').match(/^ExecStart=(.*)$/m)?.[1],'/usr/bin/node scripts/process-%i.js');
});
test('reports runtime pin changes only its own working directory and is required for settings recovery',()=>{
 const profile=read('kavosh-one-reports-runtime.conf');assert.equal(profile,'[Service]\nWorkingDirectory=/srv/kavosh-one/operations/reports-062700ac7abf6e2779606b19504e9c965aba8173\n');assert.ok(read('run-config-backup.sh').split(/\s+/).includes('etc/systemd/system/kavosh-one-background@reports.service.d'));assert.doesNotMatch(profile,/User=|Group=|ExecStart|LoadCredential|Environment|Capability|ReadWritePaths/);
});
function verifyConfig({remove,extra,duplicate=false,password=false,corrupt=false,invalidOperator=false,invalidOperationalProfile=false,invalidReportProfile=false}={}){
 const units=readdirSync(new URL('../deploy/ovh/',import.meta.url)).filter(name=>/^kavosh-one.*\.(?:service|timer)$/.test(name));
 const entries=['roles.sql','etc/kavosh-one/web.env','etc/kavosh-one/backup.env','etc/kavosh-one/drive.json','etc/kavosh-one/twilio-credentials.json','etc/kavosh-one/r2-upload.json','etc/kavosh-one/r2-scan.json','etc/kavosh-one/r2-promote.json','etc/kavosh-one/r2-download.json','etc/kavosh-one-tls/server.crt','etc/caddy/kavosh-one.caddy','etc/kavosh-one-scanner/clamd.conf','etc/apparmor.d/local/usr.sbin.clamd','etc/apparmor.d/kavosh-one-parser',...units.map(name=>'etc/systemd/system/'+name),...['auth-delivery','file-inspection','file-promotion','file-verification','background-notifications','background-reports','background-messages','background-platform-notices'].map(name=>'etc/kavosh-one/'+name+'.env')].filter(name=>name!==remove);
 for(const name of ['etc/kavosh-one/media-readers.json','etc/kavosh-one/media-backup.env','etc/systemd/system/kavosh-one-backup.service.d/media.conf'])if(name!==remove)entries.push(name);
 const healthProfile='etc/systemd/system/kavosh-one-background@platform-notices.service.d/operational-health.conf';for(const name of ['etc/systemd/system/kavosh-one-background@platform-notices.service.d/',healthProfile])if(name!==remove)entries.push(name);
 const reportProfile='etc/systemd/system/kavosh-one-background@reports.service.d/runtime.conf';for(const name of ['etc/systemd/system/kavosh-one-background@reports.service.d/',reportProfile])if(name!==remove)entries.push(name);
 if(extra)entries.push(extra);if(duplicate)entries.push(entries[0]);
 const cipher=Buffer.from('synthetic encrypted configuration archive'),receipt={id:'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa',encryptedBytes:cipher.length,ciphertextSha256:corrupt?'a'.repeat(64):createHash('sha256').update(cipher).digest('hex'),offsite:{independentCopyVerified:true,scope:'one_encrypted_configuration_archive'}};
 const logs=[],commands=[],removed=[];
 const context={assert,Buffer,JSON,URL,join,createHash,readdirSync:()=>units,readFileSync:url=>Buffer.from(read(new URL(url).pathname.split('/').at(-1))),process:{platform:'darwin',argv:[],env:{},umask(){}},console:{log:v=>logs.push(v),error:v=>logs.push(v)},mkdtempSync:()=>'/private/tmp/synthetic-config-proof',openSync:()=>7,closeSync(){},writeFileSync:(file,bytes,options)=>{assert.equal(options.mode,0o600);assert.equal(options.flag,'wx');assert.ok(file.endsWith('/configuration.tar.age'));assert.equal(bytes.length,cipher.length);},unlinkSync:p=>removed.push(p),rmdirSync:p=>removed.push(p),execFileSync:(binary,args,options={})=>{
  commands.push([binary,args]);if(binary==='/usr/bin/ssh')return Buffer.from(JSON.stringify(receipt));
  if(binary==='/usr/bin/security')return Buffer.from(JSON.stringify(args.includes('kavosh-one-production-backup-recovery')?{identity:'PRIVATE_RECOVERY_SECRET'}:{folderId:'synthetic-folder',token:{scope:'https://www.googleapis.com/auth/drive.file'}}));
  if(binary==='/opt/homebrew/bin/rclone'){assert.equal(args[0],'cat');assert.equal(options.maxBuffer,cipher.length);return Buffer.from(cipher);}
  if(binary==='/opt/homebrew/bin/age'){assert.equal(options.input,'PRIVATE_RECOVERY_SECRET');return Buffer.alloc(0);}
  assert.equal(binary,'/usr/bin/tar');if(args[0]==='-tf')return Buffer.from(entries.join('\n'));
  if(args.at(-1)==='etc/kavosh-one/media-backup.env')return Buffer.from('KAVOSH_BACKUP_OPERATOR_CLI='+(invalidOperator?'/tmp/untrusted.js':'/srv/kavosh-one/operations/recovery-6347e76/scripts/database-recovery.js')+'\n');
  if(args.at(-1)===healthProfile)return Buffer.from(invalidOperationalProfile?'[Service]\nSupplementaryGroups=root\n':read('kavosh-one-platform-notices-health.conf'));
  if(args.at(-1)===reportProfile)return Buffer.from(invalidReportProfile?'[Service]\nUser=root\nWorkingDirectory=/tmp/untrusted\n':read('kavosh-one-reports-runtime.conf'));
  return Buffer.from(args.at(-1)==='roles.sql'?'CREATE ROLE synthetic;'+(password?" ALTER ROLE synthetic PASSWORD 'PRIVATE_PASSWORD';":''):args.at(-1).endsWith('.json')?'{"private":"PRIVATE_VALUE"}':'PRIVATE_VALUE');
 }};
 const source=readFileSync(new URL('../scripts/verify-vps-config-backup.mjs',import.meta.url),'utf8').replace(/^import .*;\n/gm,'').replaceAll('import.meta.url',JSON.stringify(import.meta.url));
 runInNewContext("process.argv=['node','script','--execute'];\n"+source,context);assert.ok(!logs.join('').includes('PRIVATE'));return{logs,commands,removed,exitCode:context.process.exitCode};
}
test('settings recovery checks every current unit,worker credential and parser policy without applying configuration',()=>{
 const r=verifyConfig();assert.equal(r.exitCode,undefined,JSON.stringify(r.logs));assert.equal(JSON.parse(r.logs.at(-1)).configurationApplied,false);assert.equal(r.removed.length,3);assert.equal(r.commands.filter(([binary])=>binary==='/usr/bin/ssh').length,1);
 assert.equal(JSON.parse(r.logs.at(-1)).mediaBackupOperator,'/srv/kavosh-one/operations/recovery-6347e76/scripts/database-recovery.js');const bad=verifyConfig({invalidOperator:true});assert.equal(bad.exitCode,1);assert.equal(bad.removed.length,3);assert.ok(!bad.logs.some(line=>line.includes('configurationApplied')));
 const proofs=JSON.parse(r.logs.at(-1)).serviceUnitSha256;assert.equal(proofs['kavosh-one.service'],createHash('sha256').update('PRIVATE_VALUE').digest('hex'));assert.equal(proofs['kavosh-one-monitor.service'],proofs['kavosh-one.service']);assert.ok(Object.keys(proofs).every(name=>/^kavosh-one[^/]*\.(?:service|timer)$/.test(name)));assert.equal(proofs['web.env'],undefined);assert.equal(proofs['roles.sql'],undefined);assert.equal(proofs['drive.json'],undefined);
 assert.equal(JSON.parse(r.logs.at(-1)).operationalHealthProfileSha256,createHash('sha256').update(read('kavosh-one-platform-notices-health.conf')).digest('hex'));
 assert.equal(JSON.parse(r.logs.at(-1)).reportRuntimeProfileSha256,createHash('sha256').update(read('kavosh-one-reports-runtime.conf')).digest('hex'));
});
test('missing current files,foreign paths,traversal,duplicates,password exports and corrupt ciphertext fail closed',()=>{
 for(const options of [{remove:'etc/apparmor.d/kavosh-one-parser'},{remove:'etc/systemd/system/kavosh-one-signature-completion.service'},{remove:'etc/kavosh-one/background-messages.env'},{remove:'etc/kavosh-one/media-readers.json'},{remove:'etc/systemd/system/kavosh-one-backup.service.d/media.conf'},{remove:'etc/systemd/system/kavosh-one-background@platform-notices.service.d/operational-health.conf'},{invalidOperationalProfile:true},{extra:'etc/systemd/system/kavosh-one-background@platform-notices.service.d/foreign.conf'},{remove:'etc/systemd/system/kavosh-one-background@reports.service.d/runtime.conf'},{invalidReportProfile:true},{extra:'etc/systemd/system/kavosh-one-background@reports.service.d/foreign.conf'},{extra:'etc/systemd/system/kavosh-one-backup.service.d/foreign.conf'},{extra:'etc/caddy/Caddyfile'},{extra:'etc/kavosh-one/../../caddy/Caddyfile'},{duplicate:true},{password:true},{corrupt:true}]){const r=verifyConfig(options);assert.equal(r.exitCode,1,JSON.stringify(options));assert.equal(r.removed.length,3);assert.ok(!r.logs.some(s=>s.includes('configurationApplied')));if(options.corrupt)assert.ok(!r.commands.some(([binary])=>binary==='/opt/homebrew/bin/age'));}
});
