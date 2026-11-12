// Explicit root-only SMTP checks. This never connects to a mailbox or uses
// IMAP/POP/Google credentials. Sending is a separate, fixed-recipient action.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync,lstatSync} from 'node:fs';
import {messageTransport,smtpConnection,verifySmtpConnection,MessageDeliveryError} from '../../src/integrations/message-delivery.ts';
let phase='configuration';
try{
 assert.equal(process.getuid?.(),0);const args=process.argv.slice(2);assert.equal(args.length,1);assert.ok(['--verify-connection','--send-one'].includes(args[0]));
 const path='/etc/kavosh-one/postmark-smtp.json',s=lstatSync(path);assert.ok(s.isFile()&&!s.isSymbolicLink());assert.equal(s.uid,0);assert.equal(s.mode&0o777,0o600);assert.equal(s.nlink,1);
 const smtp=smtpConnection.parse(JSON.parse(readFileSync(path,'utf8')));assert.equal(smtp.host,'smtp.postmarkapp.com');assert.equal(smtp.port,587);assert.equal(smtp.from,'info@kavosh.ai');
 if(args[0]==='--verify-connection'){
  phase='authenticated TLS SMTP connection';const result=await verifySmtpConnection(smtp);
  console.log(JSON.stringify({...result,executedOnVps:true,messagesSent:0,mailboxConnectionAttempted:false}));
 }else{
  const directory='/var/lib/kavosh-one-email-acceptance';
  try{mkdirSync(directory,{mode:0o700});}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;}
  const d=lstatSync(directory);assert.ok(d.isDirectory()&&!d.isSymbolicLink());assert.equal(d.uid,0);assert.equal(d.mode&0o777,0o700);
  phase='one-time attempt reservation';writeFileSync(directory+'/attempt.json',JSON.stringify({reservedAt:new Date().toISOString(),automaticRetriesAllowed:false})+'\n',{mode:0o600,flag:'wx',flush:true});
  phase='one fixed-recipient email';const receipt=await messageTransport({smtp}).email({to:smtp.from,subject:'Kavosh One email connection test',text:'This is a one-time Kavosh One email connection test from the VPS. Your existing Google Workspace inbox and email routing are unchanged. No action is required.'});
  writeFileSync(directory+'/receipt.json',JSON.stringify({createdAt:new Date().toISOString(),...receipt})+'\n',{mode:0o600,flag:'wx',flush:true});
  console.log(JSON.stringify({executedOnVps:true,singleTestEmailAccepted:true,...receipt,mailboxConnectionAttempted:false,automaticRetryPerformed:false}));
 }
}catch(e){console.error(JSON.stringify({error:'POSTMARK_ACCEPTANCE_FAILED',phase,outcome:e instanceof MessageDeliveryError?e.outcome:'not_confirmed',automaticRetryAllowed:false}));process.exitCode=1;}
