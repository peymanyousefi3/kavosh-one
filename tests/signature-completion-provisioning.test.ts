import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext,runInContext } from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';
import { signatureCompletionWorkerConfiguration } from '../src/integrations/signature-completion-config.ts';
import { expectedSchemaRevision } from '../src/core/database.ts';
import { postgresOptions } from '../src/core/postgres-config.ts';

const source=stripTypeScriptTypes(readFileSync(new URL('../deploy/ovh/provision-signature-completion.ts',import.meta.url),'utf8')).replace(/^import .*;\n/gm,'');
const directory='/etc/kavosh-one',envPath=directory+'/signature-completion.env',hbaPath='/etc/postgresql/18/main/pg_hba.conf',hba='local all postgres peer\nhostssl kavosh_one kavosh_one_messages 127.0.0.1/32 scram-sha-256\nhost all all 0.0.0.0/0 reject\n';
function run(options:{existing?:boolean;missingVault?:boolean;permissions?:boolean;media?:boolean;schema?:number;connections?:number;invalidHba?:boolean}={}){
 const connection={connectionId:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',region:'CA',environment:'Live',clientId:null};
 const files=new Map([[hbaPath,hba],[directory+'/initial-academy.json',JSON.stringify({academyId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'})],[directory+'/boldsign-production.json',JSON.stringify({region:'CA',environment:'Live',apiKey:'synthetic-private-provider'})],[directory+'/signature-vault-production.json',JSON.stringify({accountId:'a'.repeat(32),jurisdiction:'default',bucket:options.media?'kavosh-one-production-clean':'synthetic-signature-vault',accessKeyId:'synthetic-vault-writer',secretAccessKey:'synthetic-private-archive-secret',maximumUploadBytes:10485760})]]);
 if(options.existing)files.set(envPath,'existing');if(options.missingVault)files.delete(directory+'/signature-vault-production.json');
 const calls:{args:string[];sql:string}[]=[],reads:string[]=[],logs:string[]=[],writes:string[]=[];
 const c=createContext({assert,expectedSchemaRevision,signatureCompletionWorkerConfiguration,randomBytes:()=>({toString:()=> 'synthetic-private-database-secret'}),
  existsSync:(p:string)=>files.has(p),lstatSync:(p:string)=>({isDirectory:()=>p===directory,isFile:()=>p!==directory,isSymbolicLink:()=>false,uid:0,gid:0,nlink:1,size:Buffer.byteLength(files.get(p)??''),mode:p===directory?0o700:options.permissions&&p.endsWith('production.json')?0o644:0o600}),
  readFileSync:(p:string)=>{reads.push(p);assert.ok(files.has(p));return files.get(p);},writeFileSync:(p:string,v:string,o:{flag:string;flush:boolean;mode:number})=>{assert.equal(o.flag,'wx');assert.equal(o.flush,true);assert.equal(files.has(p),false);files.set(p,v);writes.push(p);},chownSync:()=>{},renameSync:(a:string,b:string)=>{files.set(b,files.get(a)!);files.delete(a);},
  execFileSync:(_binary:string,args:string[],o:{input:string})=>{calls.push({args,sql:o.input});if(o.input.includes('schema_revision'))return Buffer.from(String(options.schema??expectedSchemaRevision));if(o.input.includes('pg_roles'))return Buffer.from('0');if(o.input.includes('public.academies'))return Buffer.from('1');if(o.input.includes('json_agg'))return Buffer.from(JSON.stringify(Array.from({length:options.connections??1},()=>connection)));if(o.input.includes('pg_hba_file_rules'))return Buffer.from(options.invalidHba?'1':'0');if(o.input.includes('pg_reload_conf'))return Buffer.from('t');return Buffer.from('');},
  console:{log:(v:string)=>logs.push(v),error:(v:string)=>logs.push(v)},process:{getuid:()=>0,argv:['node','script'],exitCode:undefined as number|undefined}});
 runInContext(source,c,{timeout:1000});return {files,calls,reads,logs,writes,exitCode:c.process.exitCode};
}
test('completion setup uses one restricted login and disabled private configuration without touching the web or services',()=>{
 const r=run();assert.equal(r.exitCode,undefined);const text=r.files.get(envPath)!;
 assert.match(text,/^SIGNATURE_COMPLETION_WORKER_ENABLED="false"$/m);assert.match(text,/^DATABASE_SSL_MODE="require"$/m);
 const env=Object.fromEntries(text.trim().split('\n').map(line=>{const at=line.indexOf('=');return [line.slice(0,at),JSON.parse(line.slice(at+1))];}));
 const configured=signatureCompletionWorkerConfiguration({...env,SIGNATURE_COMPLETION_WORKER_ENABLED:'true'});assert.ok(configured);assert.equal(configured.academyIds.length,1);
 const sql=r.calls.find(c=>c.sql.startsWith('BEGIN;'))!.sql;assert.match(sql,/NOBYPASSRLS CONNECTION LIMIT 2/);assert.match(sql,/GRANT kavosh_signature_completion_worker TO kavosh_one_signature_completion/);assert.doesNotMatch(sql,/GRANT kavosh_runtime|UPDATE|DELETE|identity\./);
 assert.equal(r.files.get(hbaPath)!.replace('hostssl kavosh_one kavosh_one_signature_completion 127.0.0.1/32 scram-sha-256\n',''),hba);
 assert.ok(r.reads.every(p=>[hbaPath,directory+'/initial-academy.json',directory+'/boldsign-production.json',directory+'/signature-vault-production.json'].includes(p)));
 assert.doesNotMatch(r.logs.join('')+JSON.stringify(r.calls.map(c=>c.args)),/synthetic-private|apiKey|secretAccessKey/);assert.ok(r.calls.every(c=>c.args[0]==='-u'));
 assert.equal(JSON.parse(r.logs[0]).workerEnabled,false);assert.equal(JSON.parse(r.logs[0]).serviceStarted,false);
});
test('missing vault,shared media storage,repeat setup,insecure secret files and stale schema fail before any write',()=>{
 for(const options of [{existing:true},{missingVault:true},{permissions:true},{media:true},{schema:394},{connections:0},{connections:2}]){const r=run(options);assert.equal(r.exitCode,1,JSON.stringify(options));assert.equal(r.writes.length,0);assert.ok(!r.calls.some(c=>c.sql.startsWith('BEGIN;')));assert.doesNotMatch(r.logs.join(''),/synthetic-private/);}
});
test('invalid authentication rules restore the original bytes and leave the prepared worker disabled',()=>{
 const r=run({invalidHba:true});assert.equal(r.exitCode,1);assert.equal(r.files.get(hbaPath),hba);assert.match(r.files.get(envPath)!,/^SIGNATURE_COMPLETION_WORKER_ENABLED="false"$/m);assert.doesNotMatch(r.logs.join(''),/synthetic-private/);
});

const acceptanceSource=stripTypeScriptTypes(readFileSync(new URL('../deploy/ovh/check-signature-completion.ts',import.meta.url),'utf8')).replace(/^import .*;\n/gm,'');
async function acceptance(options:{enabled?:boolean;sharedSecret?:boolean;rootReadable?:boolean;unsafeRole?:boolean;jobReadable?:boolean}={}){
 const prepared=run(),env=Object.fromEntries(prepared.files.get(envPath)!.trim().split('\n').map(line=>{const at=line.indexOf('=');return [line.slice(0,at),JSON.parse(line.slice(at+1))];}));
 if(options.enabled)env.SIGNATURE_COMPLETION_WORKER_ENABLED='true';if(options.sharedSecret)env.AUTH_SECRET='synthetic-private-shared';
 let pools=0,ended=false,released=false,roleChecked=false,schemaChecked=false,queries=0;const logs:string[]=[];
 const c=createContext({assert,signatureCompletionWorkerConfiguration,postgresOptions:(url:string)=>postgresOptions(url,env),
  readFileSync:(p:string)=>{assert.equal(p,directory+'/web.env');if(options.rootReadable)return 'synthetic-private-web';throw Object.assign(new Error('denied'),{code:'EACCES'});},
  assertSignatureCompletionRole:async()=>{roleChecked=true;if(options.unsafeRole)throw new Error('unsafe');},assertSchemaReady:async()=>{schemaChecked=true;},
  pg:{Pool:class{constructor(o:{max:number;ssl:{rejectUnauthorized:boolean}}){pools++;assert.equal(o.max,1);assert.equal(o.ssl.rejectUnauthorized,true);}on(){}async connect(){return{async query(sql:string){queries++;if(sql.includes('signature_completion_jobs')){if(options.jobReadable)return {rows:[]};throw Object.assign(new Error('denied'),{code:'42501'});}return {rows:[{login:'kavosh_one_signature_completion',tls:true,identity_access:false}]};},release(){released=true;}};}async end(){ended=true;}}},
  process:{argv:['node','script'],getuid:()=>994,env,exitCode:undefined as number|undefined},console:{log:(s:string)=>logs.push(s),error:(s:string)=>logs.push(s)}});
 await runInContext('(async()=>{'+acceptanceSource+'})()',c,{timeout:1000});return {pools,ended,released,roleChecked,schemaChecked,queries,logs,exitCode:c.process.exitCode};
}
test('preactivation check validates isolation and cleans up without claiming jobs or using provider transports',async()=>{
 const r=await acceptance();assert.equal(r.exitCode,undefined);assert.equal(r.pools,1);assert.equal(r.queries,2);assert.ok(r.roleChecked&&r.schemaChecked&&r.ended&&r.released);assert.equal(JSON.parse(r.logs[0]).jobsClaimed,0);assert.equal(JSON.parse(r.logs[0]).providerRequests,0);
 for(const options of [{enabled:true},{sharedSecret:true},{rootReadable:true}]){const r=await acceptance(options);assert.equal(r.exitCode,1);assert.equal(r.pools,0);assert.doesNotMatch(r.logs.join(''),/synthetic-private/);}
 for(const options of [{unsafeRole:true},{jobReadable:true}]){const r=await acceptance(options);assert.equal(r.exitCode,1);assert.ok(r.ended&&r.released);assert.doesNotMatch(r.logs.join(''),/synthetic-private/);}
});
