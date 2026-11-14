import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';
import {createContext,runInContext} from 'node:vm';
import {z} from 'zod';
const source=stripTypeScriptTypes(readFileSync(new URL('../deploy/ovh/probe-file-inspection.ts',import.meta.url),'utf8')).replace(/^import .*;\n/gm,'');
async function cleanup({uid=0,owned=[true,false],kind='kavosh-one-synthetic-inspection-v1',mode=0o640}={}){
 const target='a'.repeat(64),school='aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa',ids=['bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb','cccccccc-cccc-4ccc-accc-cccccccccccc'];
 const receipt={kind,academyId:school,storageTargetId:target,files:ids.map((fileId,i)=>({fileId,bytes:96,sha256:'b'.repeat(64),uploaded:owned[i]}))},calls=[],logs=[],writes=[];let credentialReads=0;
 const config={accountId:'c'.repeat(32),bucket:'kavosh-one-production-quarantine',jurisdiction:'default',accessKeyId:'synthetic-upload-id',secretAccessKey:'synthetic-private-upload-secret',maximumUploadBytes:67108864};
 const context=createContext({assert,z,randomUUID:()=>ids[0],readFileSync:p=>{if(p.endsWith('r2-upload.json')){credentialReads++;return JSON.stringify(config);}assert.equal(p,'/var/lib/kavosh-one-file-acceptance/probes.json');return JSON.stringify(receipt);},lstatSync:()=>({isFile:()=>true,isSymbolicLink:()=>false,uid:0,mode,nlink:1}),writeFileSync:(p,data)=>{assert.equal(p,'/var/lib/kavosh-one-file-acceptance/probes.json');writes.push(JSON.parse(data));},
  r2Connection:{parse:v=>v},r2TargetId:()=>target,S3Client:class{async send(c){if(c.kind==='head')throw {$metadata:{httpStatusCode:404}};calls.push(c.input);}destroy(){}},DeleteObjectCommand:class{constructor(input){this.input=input;}},HeadObjectCommand:class{kind='head';constructor(input){this.input=input;}},AbortSignal,console:{log:x=>logs.push(x),error:x=>logs.push(x)}});
 runInContext('process={getuid:()=>'+uid+',argv:["node","script","--cleanup"],env:{}}',context);await runInContext('(async()=>{'+source+'})()',context);return{calls,logs,writes,credentialReads,exitCode:context.process.exitCode,school,ids};
}
test('probe cleanup deletes only receipt-confirmed synthetic objects and records each completion',async()=>{
 const r=await cleanup();assert.equal(r.exitCode,undefined);assert.equal(r.calls.length,1);assert.equal(r.calls[0].Bucket,'kavosh-one-production-quarantine');assert.equal(r.calls[0].Key,`academies/${r.school}/quarantine/${r.ids[0]}`);assert.equal(r.writes.length,1);assert.equal(r.writes[0].files[0].uploaded,false);assert.doesNotMatch(r.logs.join(''),/synthetic-private/);
 const repeated=await cleanup({owned:[false,false]});assert.equal(repeated.exitCode,undefined);assert.equal(repeated.calls.length,0);assert.equal(repeated.writes.length,0);
});
test('non-root, unsafe receipt permissions and unrelated manifests cannot delete objects or read the upload key',async()=>{
 for(const options of [{uid:991},{mode:0o666},{kind:'unrelated'}]){const r=await cleanup(options);assert.equal(r.exitCode,1);assert.equal(r.calls.length,0);assert.equal(r.credentialReads,0);assert.doesNotMatch(r.logs.join(''),/synthetic-private/);}
});
