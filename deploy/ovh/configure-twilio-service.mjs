// Root-only fixed-destination provisioning. No sends, purchases, key changes,
// worker activation, or secret output. Existing configuration is never replaced.
import assert from 'node:assert/strict';
import { lstatSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
try {
 assert.equal(process.getuid(),0); assert.equal(process.argv.length,3);
 const messagingServiceSid=process.argv[2]; assert.match(messagingServiceSid,/^MG[a-f0-9]{32}$/);
 const source='/etc/kavosh-one/twilio-credentials.json', destination='/etc/kavosh-one/twilio-production.json';
 const safe=path=>{const s=lstatSync(path);assert.ok(s.isFile()&&!s.isSymbolicLink());assert.equal(s.uid,0);assert.equal(s.mode&0o777,0o600);assert.equal(s.nlink,1);};
 safe(source); const original=JSON.parse(readFileSync(source,'utf8'));
 assert.match(original.accountSid,/^AC[a-f0-9]{32}$/); assert.match(original.apiKeySid,/^SK[a-f0-9]{32}$/); assert.match(original.apiKeySecret,/^[A-Za-z0-9_-]{20,128}$/);
 const config={accountSid:original.accountSid,apiKeySid:original.apiKeySid,apiKeySecret:original.apiKeySecret,messagingServiceSid};
 if(existsSync(destination)){safe(destination);assert.deepEqual(JSON.parse(readFileSync(destination,'utf8')),config);}
 else writeFileSync(destination,JSON.stringify(config)+'\n',{mode:0o600,flag:'wx'});
 console.log(JSON.stringify({productionServiceConfigurationStored:true,rootOnly:true,existingKeyPermissionsChanged:false,messagesSent:0,workersActivated:false}));
}catch{console.error('TWILIO_SERVICE_CONFIGURATION_FAILED');process.exitCode=1;}
