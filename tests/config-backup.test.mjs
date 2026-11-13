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
function verifyConfig({remove,extra,duplicate=false,password=false,corrupt=false}={}){
 const units=readdirSync(new URL('../deploy/ovh/',import.meta.url)).filter(name=>/^kavosh-one.*\.(?:service|timer)$/.test(name));
 const entries=['roles.sql','etc/kavosh-one/web.env','etc/kavosh-one/backup.env','etc/kavosh-one/drive.json','etc/kavosh-one/twilio-credentials.json','etc/kavosh-one/r2-upload.json','etc/kavosh-one/r2-scan.json','etc/kavosh-one/r2-promote.json','etc/kavosh-one/r2-download.json','etc/kavosh-one-tls/server.crt','etc/caddy/kavosh-one.caddy','etc/kavosh-one-scanner/clamd.conf','etc/apparmor.d/local/usr.sbin.clamd','etc/apparmor.d/kavosh-one-parser',...units.map(name=>'etc/systemd/system/'+name),...['auth-delivery','file-inspection','file-promotion','file-verification','background-notifications','background-reports','background-messages','background-platform-notices'].map(name=>'etc/kavosh-one/'+name+'.env')].filter(name=>name!==remove);
 if(extra)entries.push(extra);if(duplicate)entries.push(entries[0]);
 const cipher=Buffer.from('synthetic encrypted configuration archive'),receipt={id:'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa',encryptedBytes:cipher.length,ciphertextSha256:corrupt?'a'.repeat(64):createHash('sha256').update(cipher).digest('hex'),offsite:{independentCopyVerified:true,scope:'one_encrypted_configuration_archive'}};
 const logs=[],commands=[],removed=[];
 const context={assert,Buffer,JSON,URL,join,createHash,readdirSync:()=>units,process:{platform:'darwin',argv:[],env:{},umask(){}},console:{log:v=>logs.push(v),error:v=>logs.push(v)},mkdtempSync:()=>'/private/tmp/synthetic-config-proof',openSync:()=>7,closeSync(){},writeFileSync:(file,bytes,options)=>{assert.equal(options.mode,0o600);assert.equal(options.flag,'wx');assert.ok(file.endsWith('/configuration.tar.age'));assert.equal(bytes.length,cipher.length);},unlinkSync:p=>removed.push(p),rmdirSync:p=>removed.push(p),execFileSync:(binary,args,options={})=>{
  commands.push([binary,args]);if(binary==='/usr/bin/ssh')return Buffer.from(JSON.stringify(receipt));
  if(binary==='/usr/bin/security')return Buffer.from(JSON.stringify(args.includes('kavosh-one-production-backup-recovery')?{identity:'PRIVATE_RECOVERY_SECRET'}:{folderId:'synthetic-folder',token:{scope:'https://www.googleapis.com/auth/drive.file'}}));
  if(binary==='/opt/homebrew/bin/rclone'){assert.equal(args[0],'cat');assert.equal(options.maxBuffer,cipher.length);return Buffer.from(cipher);}
  if(binary==='/opt/homebrew/bin/age'){assert.equal(options.input,'PRIVATE_RECOVERY_SECRET');return Buffer.alloc(0);}
  assert.equal(binary,'/usr/bin/tar');if(args[0]==='-tf')return Buffer.from(entries.join('\n'));
  return Buffer.from(args.at(-1)==='roles.sql'?'CREATE ROLE synthetic;'+(password?" ALTER ROLE synthetic PASSWORD 'PRIVATE_PASSWORD';":''):args.at(-1).endsWith('.json')?'{"private":"PRIVATE_VALUE"}':'PRIVATE_VALUE');
 }};
 const source=readFileSync(new URL('../scripts/verify-vps-config-backup.mjs',import.meta.url),'utf8').replace(/^import .*;\n/gm,'').replaceAll('import.meta.url',JSON.stringify(import.meta.url));
 runInNewContext("process.argv=['node','script','--execute'];\n"+source,context);assert.ok(!logs.join('').includes('PRIVATE'));return{logs,commands,removed,exitCode:context.process.exitCode};
}
test('settings recovery checks every current unit,worker credential and parser policy without applying configuration',()=>{
 const r=verifyConfig();assert.equal(r.exitCode,undefined,JSON.stringify(r.logs));assert.equal(JSON.parse(r.logs.at(-1)).configurationApplied,false);assert.equal(r.removed.length,3);assert.equal(r.commands.filter(([binary])=>binary==='/usr/bin/ssh').length,1);
});
test('missing current files,foreign paths,traversal,duplicates,password exports and corrupt ciphertext fail closed',()=>{
 for(const options of [{remove:'etc/apparmor.d/kavosh-one-parser'},{remove:'etc/systemd/system/kavosh-one-signature-completion.service'},{remove:'etc/kavosh-one/background-messages.env'},{extra:'etc/caddy/Caddyfile'},{extra:'etc/kavosh-one/../../caddy/Caddyfile'},{duplicate:true},{password:true},{corrupt:true}]){const r=verifyConfig(options);assert.equal(r.exitCode,1,JSON.stringify(options));assert.equal(r.removed.length,3);assert.ok(!r.logs.some(s=>s.includes('configurationApplied')));if(options.corrupt)assert.ok(!r.commands.some(([binary])=>binary==='/opt/homebrew/bin/age'));}
});
