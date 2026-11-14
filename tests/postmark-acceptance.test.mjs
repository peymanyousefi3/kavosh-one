import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';
import {createContext,runInContext} from 'node:vm';
const source=stripTypeScriptTypes(readFileSync(new URL('../deploy/ovh/check-postmark.ts',import.meta.url),'utf8')).replace(/^import .*;\n/gm,'');
class DeliveryFailure extends Error{outcome='outcome_unknown';}
async function run({action='--verify-connection',files=new Map(),uncertain=false,mode=0o600,host='smtp.postmarkapp.com'}={}){
 const logs=[],sends=[];let verifies=0;
 const context=createContext({assert,Date,MessageDeliveryError:DeliveryFailure,
  readFileSync:()=>JSON.stringify({host,port:587,from:'info@kavosh.ai',user:'synthetic-access-key',password:'synthetic-private-password'}),
  lstatSync:p=>({isDirectory:()=>true,isFile:()=>true,isSymbolicLink:()=>false,uid:0,mode:p.endsWith('email-acceptance')?0o700:mode,nlink:1}),mkdirSync:()=>{},
  writeFileSync:(p,data,o)=>{assert.ok(p.startsWith('/var/lib/kavosh-one-email-acceptance/'));assert.equal(o.mode,0o600);assert.equal(o.flag,'wx');assert.equal(o.flush,true);if(files.has(p))throw Error('EEXIST');files.set(p,data);},smtpConnection:{parse:x=>x},
  verifySmtpConnection:async()=>{verifies++;return{authenticated:true,deliveryConfirmed:false};},
  messageTransport:()=>({email:async x=>{sends.push(x);if(uncertain)throw new DeliveryFailure('private provider diagnostic');return{provider:'smtp',providerMessageId:'<synthetic@example.test>',providerStatus:'accepted',providerAccepted:true,deliveryConfirmed:false};}}),
  console:{log:x=>logs.push(x),error:x=>logs.push(x)}});
 runInContext('process={getuid:()=>0,argv:["node","script",'+JSON.stringify(action)+']}',context);
 await runInContext('(async()=>{'+source+'})()',context);return{files,logs,sends,verifies,exitCode:context.process.exitCode};
}
test('email connection checks send nothing; fixed-recipient acceptance cannot silently repeat',async()=>{
 const check=await run();assert.equal(check.verifies,1);assert.equal(check.sends.length,0);assert.equal(check.files.size,0);assert.equal(check.exitCode,undefined);
 const first=await run({action:'--send-one'});assert.equal(first.exitCode,undefined);assert.equal(first.sends.length,1);assert.equal(first.sends[0].to,'info@kavosh.ai');assert.equal(first.verifies,0);assert.equal(first.files.size,2);assert.doesNotMatch([...first.files.values(),...first.logs].join(''),/synthetic-private-password|synthetic-access-key/);
 const repeat=await run({action:'--send-one',files:first.files});assert.equal(repeat.exitCode,1);assert.equal(repeat.sends.length,0);
});
test('unsafe configuration never connects; uncertain sends keep the attempt marker without leaking diagnostics',async()=>{
 for(const options of [{action:'--other'},{mode:0o644},{host:'untrusted.invalid'}]){const r=await run(options);assert.equal(r.exitCode,1);assert.equal(r.sends.length,0);assert.equal(r.verifies,0);}
 const uncertain=await run({action:'--send-one',uncertain:true});assert.equal(uncertain.exitCode,1);assert.equal(uncertain.sends.length,1);assert.equal(uncertain.files.size,1);assert.doesNotMatch(uncertain.logs.join(''),/private provider diagnostic/);
 const repeat=await run({action:'--send-one',files:uncertain.files});assert.equal(repeat.sends.length,0);assert.equal(repeat.exitCode,1);
});
