import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext,runInContext} from 'node:vm';
const source=readFileSync(new URL('../deploy/ovh/provision-background.mjs',import.meta.url),'utf8').replace(/^import .*;\n/gm,'');
const hbaPath='/etc/postgresql/18/main/pg_hba.conf',hba='local all postgres peer\nhostssl kavosh_one kavosh_one_file_verification 127.0.0.1/32 scram-sha-256\nhost all all 0.0.0.0/0 reject\n';
function run(mode,{invalid=false,existing=false}={}){
 const directory='/etc/kavosh-one',files=new Map([[hbaPath,hba],[directory+'/initial-academy.json',JSON.stringify({academyId:'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa',masterEmail:'private@example.test'})],[directory+'/postmark-smtp.json',JSON.stringify({host:'smtp.postmarkapp.com',port:587,user:'synthetic-smtp-user',password:'synthetic-private-smtp',from:'info@kavosh.ai'})],[directory+'/twilio-production.json',JSON.stringify({accountSid:'AC'+'a'.repeat(32),apiKeySid:'SK'+'b'.repeat(32),apiKeySecret:'synthetic-private-sms',messagingServiceSid:'MG'+'c'.repeat(32)})]]),calls=[],logs=[],reads=[];
 if(existing)files.set(directory+'/background-'+mode+'.env','previous');
 const c=createContext({assert,randomBytes:()=>({toString:()=> 'synthetic-private-database'}),readFileSync:p=>{reads.push(p);return files.get(p);},existsSync:p=>files.has(p),lstatSync:()=>({isFile:()=>true,isSymbolicLink:()=>false,uid:0,gid:0,mode:0o600,nlink:1}),writeFileSync:(p,v,o)=>{assert.equal(o.flag,'wx');assert.equal(o.flush,true);assert.equal(files.has(p),false);files.set(p,v);},chownSync:()=>{},renameSync:(a,b)=>{files.set(b,files.get(a));files.delete(a);},execFileSync:(_b,args,o)=>{calls.push({args,sql:o.input});if(o.input.includes('pg_roles'))return Buffer.from('0');if(o.input.includes('schema_revision'))return Buffer.from('388');if(o.input.includes('public.academies'))return Buffer.from('1');if(o.input.includes('pg_hba_file_rules'))return Buffer.from(invalid?'1':'0');if(o.input.includes('pg_reload_conf'))return Buffer.from('t');return Buffer.from('');},console:{log:x=>logs.push(x),error:x=>logs.push(x)}});
 runInContext('process={getuid:()=>0,argv:["node","script",'+JSON.stringify(mode)+']}',c);runInContext(source,c);return{files,calls,logs,reads,exitCode:c.process.exitCode};
}
test('background role configurations isolate providers from reports/rules and preserve prior database authentication bytes',()=>{
 const roles={notifications:'kavosh_automation_worker',reports:'kavosh_automation_worker',messages:'kavosh_message_worker','platform-notices':'kavosh_platform_notice_worker'};
 for(const [mode,role]of Object.entries(roles)){
  const r=run(mode);assert.equal(r.exitCode,undefined);const env=r.files.get('/etc/kavosh-one/background-'+mode+'.env');assert.doesNotMatch(env,/private@example|^(AUTH_SECRET|DATABASE_URL|IDENTITY_DATABASE_URL|SMTP_PASSWORD|TWILIO_API_KEY_SECRET)=/m);
  assert.equal(env.includes('OPERATIONAL_DELIVERY_CONNECTIONS='),mode==='messages');assert.equal(r.reads.some(p=>p.endsWith('postmark-smtp.json')),mode==='messages');assert.equal(r.reads.some(p=>p.endsWith('twilio-production.json')),mode==='messages');
  assert.match(r.calls.find(c=>c.sql.startsWith('BEGIN;')).sql,new RegExp('GRANT '+role+' TO kavosh_one_'+mode.replaceAll('-','_')));assert.equal(r.files.get(hbaPath).replace('hostssl kavosh_one kavosh_one_'+mode.replaceAll('-','_')+' 127.0.0.1/32 scram-sha-256\n',''),hba);assert.doesNotMatch(r.logs.join('')+JSON.stringify(r.calls.map(c=>c.args)),/synthetic-private|private@example/);
 }
});
test('unknown modes, repeat setup and invalid authentication configuration cannot mutate existing rules',()=>{
 const unknown=run('__proto__');assert.equal(unknown.exitCode,1);assert.equal(unknown.calls.length,0);
 const repeat=run('reports',{existing:true});assert.equal(repeat.exitCode,1);assert.equal(repeat.calls.length,0);
 const failure=run('messages',{invalid:true});assert.equal(failure.exitCode,1);assert.equal(failure.files.get(hbaPath),hba);assert.doesNotMatch(failure.logs.join(''),/synthetic-private/);
});
