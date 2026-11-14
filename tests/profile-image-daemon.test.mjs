import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext,runInContext} from 'node:vm';
import {stripTypeScriptTypes} from 'node:module';
import {z} from 'zod';

const source=stripTypeScriptTypes(readFileSync(new URL('../scripts/process-profile-images.ts',import.meta.url),'utf8')).replace(/^import .*;\n/gm,''),academy='aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa',target='b'.repeat(64);
const credential=id=>({accountId:'a'.repeat(32),jurisdiction:'default',bucket:'synthetic-private-images',accessKeyId:'synthetic-'+id,secretAccessKey:'synthetic-not-a-real-secret',maximumUploadBytes:4194304});
async function run(patch={},uid=994,ready=true){
 const logs=[],calls=[],controllers=[];let ended=0,sockets=0,pools=0,protocols=0;
 const entry={academyId:academy,readers:[{targetId:target,configuration:credential('reader')}],destination:credential('writer')};
 const context=createContext({z,AbortController:class extends AbortController{constructor(){super();controllers.push(this);}},randomUUID:()=>academy,r2Connection:z.any(),r2TargetId:()=>target,imageServiceSocket:'/run/kavosh-image/validator.sock',imageServiceConfiguration:z.object({socketPath:z.string().startsWith('/').max(100)}).strict(),assertPrivateImageSocket:async path=>{assert.equal(path,'/run/kavosh-one-parser-image/validator.sock');sockets++;},assertProfileImageService:async({socketPath})=>{assert.equal(socketPath,'/run/kavosh-one-parser-image/validator.sock');protocols++;if(!ready)throw Error('PRIVATE outdated parser');},postgresOptions:value=>{assert.equal(value,'synthetic-test-database');return{};},pg:{Pool:class{constructor(){pools++;}on(){}async end(){ended++;}}},processOneProfileImage:async(_db,ids,_w,callback)=>{assert.equal(ids[0],academy);await callback({academyId:academy},controllers[0].signal);controllers[0].abort();return{claimed:true,recorded:true};},generateStoredProfileImage:async(task,reader,writer,path,signal)=>{assert.equal(reader('other',target),null);assert.equal(reader(academy,'unknown'),null);assert.equal(writer('other'),null);assert.equal(path,'/run/kavosh-one-parser-image/validator.sock');assert.equal(signal.aborted,false);calls.push([reader(task.academyId,target).accessKeyId,writer(task.academyId).accessKeyId]);return{outcome:'unavailable'};},console:{error:value=>logs.push(value)}});
 context.process={argv:['node','script'],getuid:()=>uid,on(){},env:{FILE_IMAGE_VALIDATION_ENABLED:'true',FILE_IMAGE_VALIDATION_SOCKET_PATH:'/run/kavosh-one-parser-image/validator.sock',PROFILE_IMAGE_WORKER_ENABLED:'true',PROFILE_IMAGE_CONNECTIONS:JSON.stringify([entry]),PROFILE_IMAGE_DATABASE_URL:'synthetic-test-database',...patch}};await runInContext('(async()=>{'+source+'})()',context);return{logs,calls,ended,sockets,pools,protocols,exitCode:context.process.exitCode};
}
test('opt-in image daemon uses only exact injected academy/read-target/writer bindings and closes on stop',async()=>{
 const r=await run();assert.deepEqual(r.calls,[['synthetic-reader','synthetic-writer']]);assert.equal(r.sockets,1);assert.equal(r.pools,1);assert.equal(r.ended,1);assert.equal(r.exitCode,undefined);assert.deepEqual(r.logs,[]);
});
test('disabled root shared-credential malformed or unbound image daemon refuses before socket database or storage IO',async()=>{
 for(const [patch,uid]of [[{PROFILE_IMAGE_WORKER_ENABLED:'false'},994],[{},0],[{DATABASE_URL:'PRIVATE_shared_database'},994],[{PROFILE_IMAGE_CONNECTIONS:'PRIVATE_invalid_json'},994],[{PROFILE_IMAGE_CONNECTIONS:JSON.stringify([{academyId:academy,readers:[{targetId:'c'.repeat(64),configuration:credential('reader')}],destination:credential('writer')}])},994],[{PROFILE_IMAGE_CONNECTIONS:JSON.stringify([{academyId:academy,readers:[{targetId:target,configuration:credential('writer')}],destination:credential('writer')}])},994]]){const r=await run(patch,uid);assert.equal(r.exitCode,1);assert.equal(r.pools,0);assert.equal(r.sockets,0);assert.equal(r.calls.length,0);assert.equal(r.logs.length,1);assert.doesNotMatch(r.logs[0],/PRIVATE|synthetic-not-a-real-secret|postgresql:/);}
});
test('an outdated image parser refuses before database creation or any durable job claim',async()=>{
 const r=await run({},994,false);assert.equal(r.exitCode,1);assert.equal(r.sockets,1);assert.equal(r.protocols,1);assert.equal(r.pools,0);assert.equal(r.calls.length,0);assert.doesNotMatch(r.logs.join(''),/PRIVATE|synthetic-not-a-real-secret/);
 for(const patch of [{FILE_IMAGE_VALIDATION_ENABLED:'false'},{FILE_IMAGE_VALIDATION_SOCKET_PATH:undefined},{FILE_IMAGE_VALIDATION_SOCKET_PATH:'https://other.example'}]){const bad=await run(patch);assert.equal(bad.exitCode,1);assert.equal(bad.sockets,0);assert.equal(bad.pools,0);}
});
