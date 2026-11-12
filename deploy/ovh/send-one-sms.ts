// Explicit owner-approved one-message acceptance. Recipient arrives on stdin,
// never argv or logs. The persistent attempt marker prevents accidental retries.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync,lstatSync} from 'node:fs';
import {messageTransport,twilioConnection,smsMessage,MessageDeliveryError} from '../../src/integrations/message-delivery.ts';
let phase='configuration';
try {
 assert.equal(process.getuid?.(),0);assert.deepEqual(process.argv.slice(2),['--execute']);
 const safe=(path:string,directory=false)=>{const s=lstatSync(path);assert.ok(directory?s.isDirectory():s.isFile());assert.ok(!s.isSymbolicLink());assert.equal(s.uid,0);assert.equal(s.mode&0o777,directory?0o700:0o600);if(!directory)assert.equal(s.nlink,1);};
 const path='/etc/kavosh-one/twilio-production.json';safe(path);
 const twilio=twilioConnection.parse(JSON.parse(readFileSync(path,'utf8')));
 const input=smsMessage.parse({to:readFileSync(0,'utf8').trim(),text:'Kavosh One connection test. No action required.'});
 const directory='/var/lib/kavosh-one-sms-acceptance';
 try{mkdirSync(directory,{mode:0o700});}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;}
 safe(directory,true);
 phase='one-time attempt reservation';
 writeFileSync(directory+'/attempt.json',JSON.stringify({reservedAt:new Date().toISOString(),automaticRetriesAllowed:false})+'\n',{mode:0o600,flag:'wx',flush:true});
 phase='single provider send';
 const receipt=await messageTransport({twilio}).sms(input);
 writeFileSync(directory+'/receipt.json',JSON.stringify({createdAt:new Date().toISOString(),...receipt})+'\n',{mode:0o600,flag:'wx',flush:true});
 console.log(JSON.stringify({singleTestMessageAccepted:true,...receipt,recipientPrinted:false,automaticRetryPerformed:false}));
}catch(e){console.error(JSON.stringify({error:'ONE_SMS_ACCEPTANCE_FAILED',phase,outcome:e instanceof MessageDeliveryError?e.outcome:'not_confirmed',automaticRetryAllowed:false}));process.exitCode=1;}
