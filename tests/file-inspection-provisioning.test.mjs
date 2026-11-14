import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext,runInContext} from 'node:vm';
const source=readFileSync(new URL('../deploy/ovh/provision-file-inspection.mjs',import.meta.url),'utf8').replace(/^import .*;\n/gm,'');
const hbaPath='/etc/postgresql/18/main/pg_hba.conf',hba='local all postgres peer\nhostssl kavosh_one kavosh_one_auth_delivery 127.0.0.1/32 scram-sha-256\nhost all all 0.0.0.0/0 reject\nhost all all ::/0 reject\n';
function run({existing=false,invalid=false}={}){
 const files=new Map([[hbaPath,hba],['/etc/kavosh-one/initial-academy.json',JSON.stringify({academyId:'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa',masterEmail:'private@example.test'})],['/etc/kavosh-one/r2-scan.json',JSON.stringify({accountId:'e7bedfa4c49de9507c44d118e5b20dc9',bucket:'kavosh-one-production-quarantine',maximumUploadBytes:67108864,accessKeyId:'synthetic-scan-key',secretAccessKey:'synthetic-private-scan-secret',jurisdiction:'default'})]]),calls=[],logs=[];
 if(existing)files.set('/etc/kavosh-one/file-inspection.env','previous');
 const context=createContext({assert,randomBytes:()=>({toString:()=> 'synthetic-private-db-password'}),readFileSync:p=>files.get(p),existsSync:p=>files.has(p),lstatSync:()=>({isFile:()=>true,isSymbolicLink:()=>false,uid:0,gid:0,mode:0o600,nlink:1}),
  writeFileSync:(p,v,o)=>{assert.equal(o.flag,'wx');assert.equal(o.flush,true);assert.equal(files.has(p),false);files.set(p,v);},chownSync:()=>{},renameSync:(a,b)=>{files.set(b,files.get(a));files.delete(a);},
  execFileSync:(bin,args,o)=>{calls.push({args,sql:o.input});if(o.input.includes('pg_roles'))return Buffer.from('0');if(o.input.includes('schema_revision'))return Buffer.from('388');if(o.input.includes('public.academies'))return Buffer.from('1');if(o.input.includes('pg_hba_file_rules'))return Buffer.from(invalid?'1':'0');if(o.input.includes('pg_reload_conf'))return Buffer.from('t');return Buffer.from('');},console:{log:x=>logs.push(x),error:x=>logs.push(x)}});
 runInContext('process={getuid:()=>0,argv:["node","script","--execute"]}',context);runInContext(source,context);return{files,calls,logs,exitCode:context.process.exitCode};
}
test('file worker gets scan-only credentials and its own restricted login, preserving existing authentication rules',()=>{
 const r=run();assert.equal(r.exitCode,undefined);const line='hostssl kavosh_one kavosh_one_file_inspection 127.0.0.1/32 scram-sha-256\n';assert.equal(r.files.get(hbaPath).replace(line,''),hba);
 const env=r.files.get('/etc/kavosh-one/file-inspection.env');assert.match(env,/FILE_INSPECTION_R2_CONNECTIONS=/);assert.doesNotMatch(env,/private@example|^(AUTH_SECRET|DATABASE_URL|SMTP_PASSWORD|TWILIO_API_KEY_SECRET|R2_UPLOAD_CONNECTIONS)=/m);assert.match(env,/FILE_(?:IMAGE|VIDEO|PDF)_VALIDATION_ENABLED="true"/);
 assert.match(r.calls.find(c=>c.sql.startsWith('BEGIN;')).sql,/GRANT kavosh_file_worker TO kavosh_one_file_inspection/);assert.doesNotMatch(r.logs.join('')+JSON.stringify(r.calls.map(c=>c.args)),/synthetic-private|private@example/);
});
test('repeat provisioning refuses changes; invalid authentication rules restore exact original bytes',()=>{
 const existing=run({existing:true});assert.equal(existing.exitCode,1);assert.equal(existing.calls.length,0);assert.equal(existing.files.get(hbaPath),hba);
 const invalid=run({invalid:true});assert.equal(invalid.exitCode,1);assert.equal(invalid.files.get(hbaPath),hba);assert.doesNotMatch(invalid.logs.join(''),/synthetic-private/);
});
