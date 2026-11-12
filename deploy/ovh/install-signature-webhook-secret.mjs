// First provider-secret installation only, via private stdin. Not a rotation,
// provider call or service restart. Keep recovery copies root-only/encrypted.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,existsSync,lstatSync,renameSync} from 'node:fs';
try{
 assert.equal(process.getuid(),0);assert.equal(process.argv.length,2);const directory='/etc/kavosh-one',recordPath=directory+'/boldsign-webhook.json',paths=[directory+'/signature-ingest.env',directory+'/web.env'];
 const input=readFileSync(0,'utf8');assert.ok(Buffer.byteLength(input)<=8192);const value=JSON.parse(input);assert.deepEqual(Object.keys(value),['secret']);assert.match(value.secret,/^[\x21-\x7e]{16,4096}$/);
 const read=p=>{const s=lstatSync(p);assert.ok(s.isFile()&&!s.isSymbolicLink());assert.equal(s.uid,0);assert.equal(s.mode&0o777,0o600);assert.equal(s.nlink,1);return readFileSync(p,'utf8');};
 const record=JSON.parse(read(recordPath));assert.equal(record.providerSecretConfigured,false);assert.equal(record.configuration.secrets.length,1);assert.notEqual(record.configuration.secrets[0],value.secret);
 const oldLine='BOLDSIGN_WEBHOOK_CONNECTIONS='+JSON.stringify(JSON.stringify([record.configuration])),configuration={...record.configuration,secrets:[value.secret]},newLine='BOLDSIGN_WEBHOOK_CONNECTIONS='+JSON.stringify(JSON.stringify([configuration]));
 const replacements=paths.map(path=>{const text=read(path),lines=text.split('\n');assert.equal(lines.filter(v=>v.startsWith('BOLDSIGN_WEBHOOK_CONNECTIONS=')).length,1);assert.ok(lines.includes(oldLine));return{path,text:lines.map(v=>v===oldLine?newLine:v).join('\n')};});
 const nextRecord=JSON.stringify({configuration,providerSecretConfigured:true})+'\n',recovery=recordPath+'.provider-recovery.json';
 for(const path of [recovery,recordPath+'.provider-next',...paths.map(p=>p+'.provider-next')])assert.ok(!existsSync(path));
 writeFileSync(recovery,nextRecord,{mode:0o600,flag:'wx',flush:true});
 for(const r of replacements)writeFileSync(r.path+'.provider-next',r.text,{mode:0o600,flag:'wx',flush:true});writeFileSync(recordPath+'.provider-next',nextRecord,{mode:0o600,flag:'wx',flush:true});
 for(const r of replacements)renameSync(r.path+'.provider-next',r.path);renameSync(recordPath+'.provider-next',recordPath);
 console.log(JSON.stringify({providerSecretConfigured:true,privateEnvironmentsUpdated:2,serviceRestarted:false,agreementsSentOrChanged:0}));
}catch{console.error('SIGNATURE_WEBHOOK_SECRET_INSTALL_FAILED: private input or configuration mismatch; do not log credentials.');process.exitCode=1;}
