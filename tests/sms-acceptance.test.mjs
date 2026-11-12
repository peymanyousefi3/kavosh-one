import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';
import {createContext,runInContext} from 'node:vm';
const source=stripTypeScriptTypes(readFileSync(new URL('../deploy/ovh/send-one-sms.ts',import.meta.url),'utf8')).replace(/^import .*;\n/gm,'');
class DeliveryFailure extends Error{outcome='outcome_unknown';}
async function run({files=new Map(),uncertain=false,recipient='+15005550006'}={}){
 const logs=[],sends=[];
 const context=createContext({assert,Date,MessageDeliveryError:DeliveryFailure,
  readFileSync:p=>p===0?recipient:JSON.stringify({synthetic:'private-test-credential'}),
  lstatSync:p=>({isDirectory:()=>true,isFile:()=>true,isSymbolicLink:()=>false,uid:0,mode:p.endsWith('sms-acceptance')?0o700:0o600,nlink:1}),mkdirSync:()=>{},
  writeFileSync:(p,data,options)=>{assert.equal(options.mode,0o600);assert.equal(options.flag,'wx');assert.equal(options.flush,true);if(files.has(p))throw Error('EEXIST');files.set(p,data);},
  twilioConnection:{parse:x=>x},smsMessage:{parse:x=>{assert.match(x.to,/^\+[1-9]\d{7,14}$/);return x;}},
  messageTransport:()=>({sms:async x=>{sends.push(x);if(uncertain)throw new DeliveryFailure('private provider diagnostic');return{provider:'twilio',providerMessageId:'SM'+'a'.repeat(32),providerStatus:'accepted',providerAccepted:true,deliveryConfirmed:false};}}),
  console:{log:x=>logs.push(x),error:x=>logs.push(x)}});
 runInContext('process={getuid:()=>0,argv:["node","script","--execute"]}',context);
 await runInContext('(async()=>{'+source+'})()',context);
 return{files,logs,sends,exitCode:context.process.exitCode};
}
test('one-message acceptance reserves before sending, stores no recipient and refuses duplicate invocations',async()=>{
 const first=await run();assert.equal(first.exitCode,undefined);assert.equal(first.sends.length,1);assert.equal(first.sends[0].text,'Kavosh One connection test. No action required.');
 assert.equal(first.files.size,2);assert.doesNotMatch([...first.files.values(),...first.logs].join(''),/15005550006|private-test-credential/);
 const repeat=await run({files:first.files});assert.equal(repeat.exitCode,1);assert.equal(repeat.sends.length,0);assert.match(repeat.logs[0],/one-time attempt reservation/);
});
test('invalid recipients never reserve or send; uncertain sends retain the marker and cannot silently retry',async()=>{
 const invalid=await run({recipient:'not-a-phone'});assert.equal(invalid.exitCode,1);assert.equal(invalid.sends.length,0);assert.equal(invalid.files.size,0);
 const uncertain=await run({uncertain:true});assert.equal(uncertain.exitCode,1);assert.equal(uncertain.sends.length,1);assert.equal(uncertain.files.size,1);assert.doesNotMatch(uncertain.logs.join(''),/private provider diagnostic/);
 const repeat=await run({files:uncertain.files});assert.equal(repeat.sends.length,0);assert.equal(repeat.exitCode,1);
});
