import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext,runInContext} from 'node:vm';
const source=readFileSync(new URL('../deploy/ovh/provision-first-school.mjs',import.meta.url),'utf8').replace(/^import .*;\n/gm,'');
function run({email="o'reilly@example.test",files=new Map(),populated=false,fail=false}={}){
 const logs=[],calls=[];let n=0;const context=createContext({assert,randomUUID:()=>['aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa','bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb'][n++],
  readFileSync:p=>p===0?Buffer.from(JSON.stringify({masterEmail:email})):files.get(p),existsSync:p=>files.has(p),lstatSync:()=>({isFile:()=>true,isSymbolicLink:()=>false,uid:0,mode:0o600}),
  writeFileSync:(p,data,o)=>{assert.equal(p,'/etc/kavosh-one/initial-academy.json');assert.equal(o.flag,'wx');assert.equal(o.mode,0o600);assert.equal(o.flush,true);assert.equal(files.has(p),false);files.set(p,data);},
  execFileSync:(bin,args,o)=>{calls.push({bin,args,sql:o.input});if(o.input.includes('schema_revision'))return Buffer.from('388');if(o.input.includes("||'|'||"))return Buffer.from(populated?'1|1':'0|0');if(o.input.includes('JOIN public.people'))return Buffer.from('1');if(fail)throw Error('private '+email);return Buffer.from('');},console:{log:x=>logs.push(x),error:x=>logs.push(x)}});
 runInContext('process={getuid:()=>0,argv:["node","script","--execute"]}',context);runInContext(source,context);return{files,logs,calls,exitCode:context.process.exitCode};
}
test('first school creates only a pending master; no identity, activation or bot token and no email in logs or argv',()=>{
 const r=run();assert.equal(r.exitCode,undefined);const sql=r.calls.find(c=>c.sql.startsWith('BEGIN;')).sql;assert.match(sql,/pg_advisory_xact_lock/);assert.match(sql,/'pending'/);assert.match(sql,/o''reilly@example.test/);assert.doesNotMatch(sql,/INSERT INTO identity|UPDATE.*status|auth_private.credentials/);assert.doesNotMatch(r.logs.join('')+JSON.stringify(r.calls.map(c=>c.args)),/reilly@example/);
 const repeat=run({files:r.files});assert.equal(repeat.exitCode,undefined);assert.equal(repeat.calls.length,1);assert.ok(repeat.calls[0].sql.startsWith('SELECT count(*)'));
});
test('existing data, malformed email and mismatched master fail closed; private database errors are redacted',()=>{
 for(const options of [{populated:true},{email:'bad@example.test;DROP TABLE people'}]){const r=run(options);assert.equal(r.exitCode,1);assert.equal(r.files.size,0);}
 const first=run(),mismatch=run({files:first.files,email:'other@example.test'});assert.equal(mismatch.exitCode,1);assert.equal(mismatch.calls.length,0);
 const failure=run({fail:true});assert.equal(failure.exitCode,1);assert.doesNotMatch(failure.logs.join(''),/reilly@example|private/);
});
