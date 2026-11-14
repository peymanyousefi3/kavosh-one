import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext,runInContext} from 'node:vm';
import {stripTypeScriptTypes} from 'node:module';
import {z} from 'zod';
const provisioning=readFileSync(new URL('../deploy/ovh/provision-file-copy.mjs',import.meta.url),'utf8').replace(/^import .*;\n/gm,'');
const daemon=stripTypeScriptTypes(readFileSync(new URL('../scripts/process-file-copies.ts',import.meta.url),'utf8')).replace(/^import .*;\n/gm,'');
const academy='aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa',hbaPath='/etc/postgresql/18/main/pg_hba.conf',hba='local all postgres peer\nhostssl kavosh_one kavosh_one_file_inspection 127.0.0.1/32 scram-sha-256\nhost all all 0.0.0.0/0 reject\n';
const credential=role=>({accountId:'e7bedfa4c49de9507c44d118e5b20dc9',bucket:role==='scan'?'kavosh-one-production-quarantine':'kavosh-one-production-clean',jurisdiction:'default',accessKeyId:'synthetic-'+role,secretAccessKey:'synthetic-private-'+role,maximumUploadBytes:67108864});
function provision(mode,{invalid=false,existing=false}={}){
 const files=new Map([[hbaPath,hba],['/etc/kavosh-one/initial-academy.json',JSON.stringify({academyId:academy})],...['scan','promote','download'].map(k=>['/etc/kavosh-one/r2-'+k+'.json',JSON.stringify(credential(k))])]),calls=[],logs=[];if(existing)files.set('/etc/kavosh-one/file-'+mode+'.env','previous');
 const c=createContext({assert,randomBytes:()=>({toString:()=> 'synthetic-private-db-password'}),readFileSync:p=>files.get(p),existsSync:p=>files.has(p),lstatSync:()=>({isFile:()=>true,isSymbolicLink:()=>false,uid:0,gid:0,mode:0o600,nlink:1}),writeFileSync:(p,v,o)=>{assert.equal(o.flag,'wx');assert.equal(o.flush,true);assert.equal(files.has(p),false);files.set(p,v);},chownSync:()=>{},renameSync:(a,b)=>{files.set(b,files.get(a));files.delete(a);},execFileSync:(_b,args,o)=>{calls.push({args,sql:o.input});if(o.input.includes('pg_roles'))return Buffer.from('0');if(o.input.includes('schema_revision'))return Buffer.from('388');if(o.input.includes('public.academies'))return Buffer.from('1');if(o.input.includes('pg_hba_file_rules'))return Buffer.from(invalid?'1':'0');if(o.input.includes('pg_reload_conf'))return Buffer.from('t');return Buffer.from('');},console:{log:x=>logs.push(x),error:x=>logs.push(x)}});
 runInContext('process={getuid:()=>0,argv:["node","script",'+JSON.stringify(mode)+']}',c);runInContext(provisioning,c);return{files,calls,logs,exitCode:c.process.exitCode};
}
test('promotion and verification get different exact credentials and logins; failed HBA validation restores previous bytes',()=>{
 for(const mode of ['promotion','verification']){
  const r=provision(mode);assert.equal(r.exitCode,undefined);const env=r.files.get('/etc/kavosh-one/file-'+mode+'.env'),raw=env.match(/^FILE_COPY_CONNECTIONS=(.+)$/m)[1],entry=JSON.parse(JSON.parse(raw))[0];
  assert.deepEqual(Object.keys(entry).sort(),mode==='promotion'?['academyId','destination','source']:['academyId','reader']);assert.equal(entry.reader?.accessKeyId??entry.destination.accessKeyId,mode==='promotion'?'synthetic-promote':'synthetic-download');
  assert.equal(r.files.get(hbaPath).replace('hostssl kavosh_one kavosh_one_file_'+mode+' 127.0.0.1/32 scram-sha-256\n',''),hba);assert.doesNotMatch(r.logs.join('')+JSON.stringify(r.calls.map(v=>v.args)),/synthetic-private/);
  const failed=provision(mode,{invalid:true});assert.equal(failed.exitCode,1);assert.equal(failed.files.get(hbaPath),hba);assert.equal(provision(mode,{existing:true}).exitCode,1);
 }
 assert.equal(provision('unrelated').files.size,5);
});
test('daemon routes only exact school/target bindings and exits cleanly on stop without sharing identity or mail credentials',async()=>{
 for(const mode of ['promotion','verification']){
  const controllers=[],calls=[],logs=[];let ended=false;
  const entries=mode==='promotion'?[{academyId:academy,source:credential('scan'),destination:credential('promote')}]:[{academyId:academy,reader:credential('download')}];
  const target=c=>c.bucket.endsWith('quarantine')?'a'.repeat(64):'b'.repeat(64);
  const context=createContext({z,AbortController:class extends AbortController{constructor(){super();controllers.push(this);}},randomUUID:()=>academy,r2Connection:z.any(),r2TargetId:target,postgresOptions:()=>({}),pg:{Pool:class{on(){}async end(){ended=true;}}},
   processOneCopy:async(_d,ids,_w,fn)=>{assert.equal(ids[0],academy);await fn({academyId:academy,sourceTargetId:'a'.repeat(64),destinationTargetId:'b'.repeat(64)},controllers[0].signal);controllers[0].abort();return{claimed:true,recorded:true};},
   processOneCopyCheck:async(_d,ids,_w,fn)=>{assert.equal(ids[0],academy);await fn({academyId:academy,destinationTargetId:'b'.repeat(64)},controllers[0].signal);controllers[0].abort();return{claimed:true,recorded:true};},
   copyStoredFile:async(task,lookup)=>{assert.equal(lookup('other',task.sourceTargetId),null);assert.equal(lookup(academy,'unknown'),null);calls.push(lookup(academy,task.destinationTargetId).accessKeyId);},checkCopyDestination:async(_t,config)=>{calls.push(config.accessKeyId);},console:{log:x=>logs.push(x),error:x=>logs.push(x)}});
  runInContext('process={argv:["node","script",'+JSON.stringify(mode)+'],on(){},env:'+JSON.stringify({FILE_COPY_WORKER_ENABLED:'true',FILE_COPY_MODE:mode,FILE_COPY_CONNECTIONS:JSON.stringify(entries),FILE_COPY_WORKER_DATABASE_URL:'synthetic'})+'}',context);await runInContext('(async()=>{'+daemon+'})()',context);
  assert.equal(context.process.exitCode,undefined);assert.equal(ended,true);assert.deepEqual(calls,[mode==='promotion'?'synthetic-promote':'synthetic-download']);assert.equal(logs.length,0);
  context.process.env.DATABASE_URL='synthetic-private-shared-database';await runInContext('(async()=>{'+daemon+'})()',context);assert.equal(context.process.exitCode,1);assert.equal(calls.length,1);assert.equal(logs.length,1);assert.doesNotMatch(logs[0],/synthetic-private/);
 }
});
