import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
const source=readFileSync(new URL('../deploy/ovh/configure-twilio-service.mjs',import.meta.url),'utf8').replace(/^import .*;\n/gm,'');
const service='MG'+'a'.repeat(32),original={accountSid:'AC'+'b'.repeat(32),apiKeySid:'SK'+'c'.repeat(32),apiKeySecret:'synthetic-private-value-not-a-real-key'};
function run({uid=0,mode=0o600,symlink=false,links=1,existing,selected=service}={}){
 const writes=[],logs=[],process={getuid:()=>uid,argv:['node','script',selected]};
 runInNewContext(source,{assert,process,lstatSync:()=>({isFile:()=>true,isSymbolicLink:()=>symlink,uid:0,mode,nlink:links}),readFileSync:p=>JSON.stringify(p.endsWith('twilio-production.json')?existing:original),existsSync:()=>existing!==undefined,writeFileSync:(...args)=>writes.push(args),console:{log:x=>logs.push(x),error:x=>logs.push(x)}});
 return{writes,logs,process};
}
test('SMS provisioning writes only fixed root-only destination and never logs credentials',()=>{
 const r=run();assert.equal(r.process.exitCode,undefined);assert.equal(r.writes.length,1);assert.equal(r.writes[0][0],'/etc/kavosh-one/twilio-production.json');assert.deepEqual(JSON.parse(r.writes[0][1]),{...original,messagingServiceSid:service});assert.equal(r.writes[0][2].flag,'wx');assert.equal(r.writes[0][2].mode,0o600);assert.ok(!r.logs.join('').includes(original.apiKeySecret));
});
test('SMS provisioning is idempotent and refuses mismatches, unsafe files or non-root callers without overwriting',()=>{
 const same=run({existing:{...original,messagingServiceSid:service}});assert.equal(same.process.exitCode,undefined);assert.equal(same.writes.length,0);
 for(const options of [{uid:501},{mode:0o644},{symlink:true},{links:2},{selected:'untrusted'},{existing:{...original,messagingServiceSid:'MG'+'d'.repeat(32)}}]){const r=run(options);assert.equal(r.process.exitCode,1);assert.equal(r.writes.length,0);assert.deepEqual(r.logs,['TWILIO_SERVICE_CONFIGURATION_FAILED']);}
});
