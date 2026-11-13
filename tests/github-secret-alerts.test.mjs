import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
const source=readFileSync(new URL('../scripts/check-github-secret-alerts.mjs',import.meta.url),'utf8').replace(/^import .*;\n/gm,'');
function run({alerts=[],status=0,invalid=false,args=['--execute']}={}){
 const logs=[],commands=[],context={assert:{...assert,deepEqual:(a,b)=>assert.deepEqual(structuredClone(a),structuredClone(b))},Buffer,Object,JSON,Number,Date,process:{argv:['node','script',...args]},console:{log:v=>logs.push(v),error:v=>logs.push(v)},spawnSync:(command,params,options)=>{commands.push({command,params,options});return{status,stdout:invalid?'PRIVATE_INVALID_DIAGNOSTIC':alerts.map(value=>JSON.stringify(value)).join('\n'),stderr:'PRIVATE_PROVIDER_DIAGNOSTIC'};}};
 runInNewContext(source,context);assert.ok(!logs.join('').includes('PRIVATE_'));return{logs,commands,exitCode:context.process.exitCode};
}
test('secret-alert checks request metadata only and preserve unknown validity without claiming provider verification',()=>{
 const alerts=[{number:1,state:'resolved',resolution:'used_in_tests',secret_type:'stripe_webhook_signing_secret',validity:'unknown'}],r=run({alerts});assert.equal(r.exitCode,undefined);const result=JSON.parse(r.logs[0]);assert.equal(result.openAlerts,0);assert.equal(result.reportedValidity.unknown,1);assert.equal(result.providerValidityVerified,false);assert.equal(result.providerKeysRotated,false);assert.equal(result.alertStateChanged,false);
 assert.equal(r.commands.length,1);assert.equal(r.commands[0].command,'gh');assert.equal(r.commands[0].params[0],'api');assert.ok(r.commands[0].params.includes('--paginate'));assert.equal(r.commands[0].params.at(-1),'.[]|{number,state,resolution,secret_type,validity:(.validity//"unknown")}');assert.ok(!r.commands[0].params.includes('--method'));assert.equal(r.commands[0].options.maxBuffer,1048576);
 assert.ok(r.commands[0].params.includes('repos/peymanyousefi3/kavosh-one/secret-scanning/alerts?hide_secret=true'));assert.ok(r.commands[0].params.includes('X-GitHub-Api-Version: 2026-03-10'));
});
test('open or known-active alerts fail without any automatic resolution or key changes',()=>{
 for(const alert of [{number:2,state:'open',resolution:null,secret_type:'synthetic',validity:'unknown'},{number:3,state:'resolved',resolution:'used_in_tests',secret_type:'synthetic',validity:'active'}]){const r=run({alerts:[alert]});assert.equal(r.exitCode,1);assert.equal(JSON.parse(r.logs[0]).alertStateChanged,false);assert.equal(r.commands.length,1);}
});
test('malformed,secret-bearing,over-budget or unavailable responses never print partial success or diagnostics',()=>{
 const base={number:1,state:'resolved',resolution:'used_in_tests',secret_type:'synthetic',validity:'unknown'};
 for(const options of [{invalid:true},{status:1},{alerts:[{...base,secret:'PRIVATE_SECRET'}]},{alerts:[{...base,validity:'unexpected'}]},{alerts:Array.from({length:1001},(_,i)=>({...base,number:i+1}))},{args:['--execute','extra']}]){const r=run(options);assert.equal(r.exitCode,1);assert.ok(!r.logs.some(line=>line.startsWith('{')));if(options.args)assert.equal(r.commands.length,0);}
});
