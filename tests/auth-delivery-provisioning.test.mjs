import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext,runInContext} from 'node:vm';
const source=readFileSync(new URL('../deploy/ovh/provision-auth-delivery.mjs',import.meta.url),'utf8').replace(/^import .*;\n/gm,'');
const hbaPath='/etc/postgresql/18/main/pg_hba.conf',originalHba='local all postgres peer\nhostssl kavosh_one kavosh_one_web,kavosh_one_identity 127.0.0.1/32 scram-sha-256\nhostssl kavosh_one kavosh_one_backup 127.0.0.1/32 scram-sha-256\nhost all all 0.0.0.0/0 reject\nhost all all ::/0 reject\n';
function run({existing=false,pending=false,invalidHba=false}={}){
 const smtp={host:'smtp.postmarkapp.com',port:587,from:'info@kavosh.ai',user:'synthetic-smtp-user',password:'synthetic-private-smtp-password'},twilio={accountSid:'AC'+'a'.repeat(32),apiKeySid:'SK'+'b'.repeat(32),apiKeySecret:'synthetic-private-sms-password',messagingServiceSid:'MG'+'c'.repeat(32)};
 const files=new Map([[hbaPath,originalHba],['/etc/kavosh-one/web.env','AUTH_SECRET='+'synthetic-private-auth-'.padEnd(64,'x')+'\n'],['/etc/kavosh-one/postmark-smtp.json',JSON.stringify(smtp)],['/etc/kavosh-one/twilio-production.json',JSON.stringify(twilio)]]),logs=[],calls=[];
 if(existing)files.set('/etc/kavosh-one/auth-delivery.env','original-env');
 const context=createContext({assert,randomBytes:()=>({toString:()=> 'synthetic-generated-db-password'}),existsSync:p=>files.has(p),readFileSync:p=>files.get(p),lstatSync:()=>({isFile:()=>true,isSymbolicLink:()=>false,uid:0,gid:0,mode:0o600,nlink:1}),
  writeFileSync:(p,v,o)=>{if(o.flag==='wx')assert.ok(!files.has(p));assert.equal(o.flush,true);files.set(p,v);},renameSync:(a,b)=>{files.set(b,files.get(a));files.delete(a);},chownSync:()=>{},
  execFileSync:(bin,args,o)=>{calls.push({bin,args,input:o.input});if(o.input.includes('pg_roles'))return Buffer.from('0');if(o.input.includes('outcome IS NULL'))return Buffer.from(pending?'1':'0');if(o.input.includes('pg_hba_file_rules'))return Buffer.from(invalidHba?'1':'0');if(o.input.includes('pg_reload_conf'))return Buffer.from('t');return Buffer.from('');},
  console:{log:x=>logs.push(x),error:x=>logs.push(x)}});
 runInContext('process={getuid:()=>0,argv:["node","script","--execute"]}',context);runInContext(source,context);return{files,logs,calls,exitCode:context.process.exitCode};
}
test('isolated auth provisioning preserves original HBA bytes, keeps secrets off argv and stores only worker credentials',()=>{
 const r=run();assert.equal(r.exitCode,undefined);const newLine='hostssl kavosh_one kavosh_one_auth_delivery 127.0.0.1/32 scram-sha-256\n';assert.equal(r.files.get(hbaPath).replace(newLine,''),originalHba);assert.equal(r.files.get('/etc/kavosh-one/auth-delivery-hba.before'),originalHba);
 const env=r.files.get('/etc/kavosh-one/auth-delivery.env');assert.match(env,/DELIVERY_DATABASE_URL=/);assert.doesNotMatch(env,/^(DATABASE_URL|IDENTITY_DATABASE_URL|EDGE_AUTH_SECRET|MIGRATION_DATABASE_URL)=/m);
 assert.match(r.calls.find(c=>c.input.startsWith('BEGIN;')).input,/GRANT kavosh_delivery TO kavosh_one_auth_delivery/);assert.doesNotMatch(JSON.stringify(r.calls.map(c=>c.args))+r.logs.join(''),/synthetic-private|synthetic-generated-db-password/);
});
test('existing configuration or pending messages refuse provisioning; invalid HBA restores the exact previous file',()=>{
 for(const options of [{existing:true},{pending:true}]){const r=run(options);assert.equal(r.exitCode,1);assert.equal(r.files.get(hbaPath),originalHba);assert.equal(r.calls.some(c=>c.input.startsWith('BEGIN;')),false);}
 const r=run({invalidHba:true});assert.equal(r.exitCode,1);assert.equal(r.files.get(hbaPath),originalHba);assert.ok(r.files.has('/etc/kavosh-one/auth-delivery.env'));assert.doesNotMatch(r.logs.join(''),/synthetic-private|synthetic-generated-db-password/);
});
