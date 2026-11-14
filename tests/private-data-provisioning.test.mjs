import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync} from 'node:fs';
import {randomBytes} from 'node:crypto';
import {createContext,runInContext} from 'node:vm';
const source=readFileSync(new URL('../deploy/ovh/provision-private-data.mjs',import.meta.url),'utf8').replace(/^import .*;\n/gm,''),path='/etc/kavosh-one/web.env',next=path+'.private-data.next',original='NODE_ENV=production\nAUTH_SECRET=synthetic-private-existing\n';
function run({existing=false,partial=false,privateRows=false,insecure=false,symlink=false,temporary=false,stale=false,renameFailure=false}={}){
 const before=original+(existing?'STUDENT_CARE_PRIVATE_KEYS="existing-material"\n':partial?'PAYROLL_PRIVATE_ACTIVE_KEY_ID="old"\n':''),files=new Map([[path,before]]),logs=[],calls=[];if(temporary)files.set(next,'original-unknown-file');let reads=0;
 const context=createContext({assert,randomBytes,existsSync:p=>files.has(p),readFileSync:p=>{reads++;if(stale&&reads===2)files.set(path,before+'CHANGED=unrelated-new-setting\n');return files.get(p);},lstatSync:()=>({isFile:()=>!symlink,isSymbolicLink:()=>symlink,uid:0,gid:0,nlink:1,mode:insecure?0o644:0o600,size:before.length}),
  writeFileSync:(p,v,o)=>{assert.equal(o.flag,'wx');assert.equal(o.mode,0o600);assert.equal(o.flush,true);assert.equal(files.has(p),false);calls.push({write:p});files.set(p,v);},renameSync:(a,b)=>{if(renameFailure)throw Error('synthetic rename failure');calls.push({rename:[a,b]});files.set(b,files.get(a));files.delete(a);},
  execFileSync:(bin,args,o)=>{calls.push({bin,args,input:o.input});return Buffer.from(privateRows?'1':'0');},console:{log:v=>logs.push(v),error:v=>logs.push(v)}});
 runInContext('process={getuid:()=>0,argv:["node","script","--execute"],umask:()=>{}}',context);runInContext(source,context);return{files,calls,logs,exitCode:context.process.exitCode,before};
}
test('fresh private keys append atomically without changing existing credentials restarting services or exposing secrets',()=>{
 const r=run();assert.equal(r.exitCode,undefined);assert.ok(r.files.get(path).startsWith(original));assert.equal(r.files.has(next),false);const values=Object.fromEntries(r.files.get(path).slice(original.length).trim().split('\n').map(line=>{const n=line.indexOf('=');return[line.slice(0,n),JSON.parse(line.slice(n+1))];}));assert.equal(Object.keys(values).length,6);
 const secrets=[];for(const prefix of ['STUDENT_CARE','PAYROLL']){assert.equal(values[prefix+'_PRIVATE_ACTIVE_KEY_ID'],'v1');const keys=JSON.parse(values[prefix+'_PRIVATE_KEYS']);assert.deepEqual(Object.keys(keys),['v1']);for(const key of [keys.v1,values[prefix+'_PRIVATE_FINGERPRINT_KEY']]){assert.match(key,/^[A-Za-z0-9_-]{43}$/);secrets.push(key);}}
 assert.equal(new Set(secrets).size,4);for(const key of secrets)assert.equal((JSON.stringify(r.calls)+r.logs.join('')).includes(key),false);const sql=r.calls.find(c=>c.bin).input;assert.match(sql,/BEGIN READ ONLY/);assert.match(sql,/student\.care\.submit/);assert.match(sql,/work\.payroll-identity\.change/);assert.doesNotMatch(sql,/\b(?:INSERT|UPDATE|DELETE|ALTER|CREATE|GRANT)\b/);assert.equal(JSON.parse(r.logs[0]).serviceRestarted,false);
});
test('existing or partial key configuration private historical evidence unsafe files and unknown temporary files refuse without writes',()=>{
 for(const options of [{existing:true},{partial:true},{privateRows:true},{insecure:true},{symlink:true},{temporary:true}]){const r=run(options);assert.equal(r.exitCode,1);assert.equal(r.files.get(path),r.before);assert.equal(r.calls.some(c=>c.write||c.rename),false);assert.doesNotMatch(r.logs.join(''),/synthetic-private-existing|existing-material/);if(options.temporary)assert.equal(r.files.get(next),'original-unknown-file');}
});
test('concurrent unrelated configuration changes and failed atomic rename never overwrite the original environment',()=>{
 for(const options of [{stale:true},{renameFailure:true}]){const r=run(options);assert.equal(r.exitCode,1);assert.equal(r.files.get(path),r.before+(options.stale?'CHANGED=unrelated-new-setting\n':''));assert.equal(r.calls.some(c=>c.rename),false);assert.doesNotMatch(r.logs.join(''),/synthetic-private-existing|CHANGED=/);}
});
