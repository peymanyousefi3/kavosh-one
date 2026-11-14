import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext,runInContext} from 'node:vm';
const source=readFileSync(new URL('../deploy/ovh/install-signature-webhook-secret.mjs',import.meta.url),'utf8').replace(/^import .*;\n/gm,'');
function run({secret='synthetic-new-provider-secret',configured=false,mismatch=false}={}){
 const directory='/etc/kavosh-one',record=directory+'/boldsign-webhook.json',c={connectionId:'11111111-1111-4111-8111-111111111111',academyId:'22222222-2222-4222-8222-222222222222',region:'CA',environment:'Live',clientId:null,secrets:['synthetic-placeholder-secret']},line='BOLDSIGN_WEBHOOK_CONNECTIONS='+JSON.stringify(JSON.stringify([c])),prefix='AUTH_SECRET=synthetic-existing-auth\nSIGNATURE_INGEST_DATABASE_URL=synthetic-private-database\n',files=new Map([[record,JSON.stringify({configuration:c,providerSecretConfigured:configured})],[directory+'/web.env',prefix+line+'\n'],[directory+'/signature-ingest.env',(mismatch?'BOLDSIGN_WEBHOOK_CONNECTIONS="other"':line)+'\n']]),logs=[],writes=[];
 const context=createContext({assert,Buffer,readFileSync:p=>p===0?JSON.stringify({secret}):files.get(p),existsSync:p=>files.has(p),lstatSync:()=>({isFile:()=>true,isSymbolicLink:()=>false,uid:0,nlink:1,mode:0o600}),writeFileSync:(p,v,o)=>{assert.ok(!files.has(p));assert.equal(o.flag,'wx');assert.equal(o.mode,0o600);assert.equal(o.flush,true);writes.push(p);files.set(p,v);},renameSync:(a,b)=>{files.set(b,files.get(a));files.delete(a);},console:{log:v=>logs.push(v),error:v=>logs.push(v)}});runInContext('process={getuid:()=>0,argv:["node","script"]}',context);runInContext(source,context);return{files,logs,writes,exitCode:context.process.exitCode,prefix,directory,record};
}
test('first provider-secret installation updates only matching private connection lines and preserves all unrelated web bytes',()=>{
 const r=run();assert.equal(r.exitCode,undefined);assert.ok(r.files.get(r.directory+'/web.env').startsWith(r.prefix));const record=JSON.parse(r.files.get(r.record));assert.equal(record.providerSecretConfigured,true);assert.deepEqual(record.configuration.secrets,['synthetic-new-provider-secret']);assert.deepEqual(JSON.parse(r.files.get(r.record+'.provider-recovery.json')),record);
 const expected='BOLDSIGN_WEBHOOK_CONNECTIONS='+JSON.stringify(JSON.stringify([record.configuration]));for(const name of ['web.env','signature-ingest.env'])assert.ok(r.files.get(r.directory+'/'+name).split('\n').includes(expected));assert.doesNotMatch(r.logs.join(''),/synthetic-new|synthetic-existing|synthetic-private/);
});
test('existing provider credentials, mismatched private environments and malformed keys are refused before any write',()=>{
 for(const options of [{configured:true},{mismatch:true},{secret:'bad\nsecret'},{secret:'short'}]){const r=run(options);assert.equal(r.exitCode,1);assert.equal(r.writes.length,0);assert.doesNotMatch(r.logs.join(''),/synthetic-new|synthetic-existing|synthetic-private/);}
});
