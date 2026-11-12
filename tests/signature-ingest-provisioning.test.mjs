import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext,runInContext} from 'node:vm';
const source=readFileSync(new URL('../deploy/ovh/provision-signature-ingest.mjs',import.meta.url),'utf8').replace(/^import .*;\n/gm,'');
const directory='/etc/kavosh-one',web=directory+'/web.env',hbaPath='/etc/postgresql/18/main/pg_hba.conf',original='NODE_ENV=production\nAUTH_SECRET=synthetic-private-existing\n',hba='local all postgres peer\nhostssl kavosh_one kavosh_one_messages 127.0.0.1/32 scram-sha-256\nhost all all 0.0.0.0/0 reject\n';
function run({existing=false,shared=false,invalidHba=false,invalidAcademy=false}={}){
 const files=new Map([[web,original+(shared?'BOLDSIGN_WEBHOOK_ENABLED=false\n':'')],[directory+'/initial-academy.json',JSON.stringify({academyId:invalidAcademy?"invalid'uuid":'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',masterEmail:'private@example.test'})],[hbaPath,hba]]),reads=[],calls=[],logs=[],writes=[];let sequence=0;
 if(existing)files.set(directory+'/signature-ingest.env','already-configured');
 const context=createContext({assert,randomBytes:()=>({toString:()=> 'synthetic-private-generated-'+ ++sequence}),randomUUID:()=> '11111111-1111-4111-8111-'+String(++sequence).padStart(12,'0'),existsSync:p=>files.has(p),lstatSync:()=>({isFile:()=>true,isSymbolicLink:()=>false,uid:0,gid:0,nlink:1,mode:0o600}),readFileSync:p=>{reads.push(p);return files.get(p);},writeFileSync:(p,v,o)=>{assert.equal(o.flag,'wx');assert.equal(o.flush,true);assert.ok(!files.has(p));files.set(p,v);writes.push({p,mode:o.mode});},renameSync:(a,b)=>{assert.ok(files.has(a));files.set(b,files.get(a));files.delete(a);},chownSync:()=>{},execFileSync:(_binary,args,options)=>{calls.push({args,sql:options.input});if(options.input.includes('schema_revision'))return Buffer.from('390');if(options.input.includes('pg_roles'))return Buffer.from('0');if(options.input.includes('count(*) FROM public.academies'))return Buffer.from('1');if(options.input.includes('pg_hba_file_rules'))return Buffer.from(invalidHba?'1':'0');if(options.input.includes('pg_reload_conf'))return Buffer.from('t');return Buffer.from('');},console:{log:v=>logs.push(v),error:v=>logs.push(v)}});
 runInContext('process={getuid:()=>0,argv:["node","script"]}',context);runInContext(source,context);return{files,reads,calls,logs,writes,exitCode:context.process.exitCode};
}
test('signature login is intake-only, old web bytes and authentication rules survive, and no provider or account secret is logged',()=>{
 const r=run();assert.equal(r.exitCode,undefined);assert.equal(r.files.get(web+'.before-signature-ingest'),original);assert.ok(r.files.get(web).startsWith(original));assert.match(r.files.get(web),/^SIGNATURE_INGEST_DATABASE_URL=/m);
 assert.equal(r.files.get(hbaPath).replace('hostssl kavosh_one kavosh_one_signature_ingest 127.0.0.1/32 scram-sha-256\n',''),hba);
 const sql=r.calls.find(v=>v.sql.startsWith('BEGIN;')).sql;assert.match(sql,/GRANT kavosh_signature_ingest TO kavosh_one_signature_ingest/);assert.match(sql,/enabled,bound_documents_only\) VALUES\([^;]+true,true\)/);assert.doesNotMatch(sql,/GRANT kavosh_runtime|UPDATE public\.academies|identity\./);
 const record=JSON.parse(r.files.get(directory+'/boldsign-webhook.json'));assert.equal(record.providerSecretConfigured,false);assert.equal(record.configuration.environment,'Live');assert.equal(record.configuration.region,'CA');
 assert.ok(r.writes.every(v=>v.mode===0o600));assert.ok(!r.reads.some(v=>v.endsWith('boldsign-production.json')));assert.doesNotMatch(r.logs.join('')+JSON.stringify(r.calls.map(v=>v.args)),/synthetic-private|private@example/);
 assert.equal(JSON.parse(r.logs[0]).providerWebhookCreated,false);
});
test('repeat setup, shared environment and invalid academy stop before mutation; invalid HBA restores original and leaves web configuration unchanged',()=>{
 for(const options of [{existing:true},{shared:true},{invalidAcademy:true}]){const r=run(options);assert.equal(r.exitCode,1);assert.equal(r.writes.length,0);assert.equal(r.calls.length,0);}
 const failed=run({invalidHba:true});assert.equal(failed.exitCode,1);assert.equal(failed.files.get(hbaPath),hba);assert.equal(failed.files.get(web),original);assert.doesNotMatch(failed.logs.join(''),/synthetic-private|private@example/);
});
