// Fresh isolated auth delivery only. Never change existing web credentials,
// mail routing, roles, queues, or provider permissions. No messages are sent.
import {randomBytes} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync,existsSync,lstatSync,renameSync,chownSync} from 'node:fs';
import assert from 'node:assert/strict';
let phase='preflight';
try{
 assert.equal(process.getuid(),0);assert.deepEqual(process.argv.slice(2),['--execute']);
 const directory='/etc/kavosh-one',destination=directory+'/auth-delivery.env',hbaPath='/etc/postgresql/18/main/pg_hba.conf';
 assert.ok(!existsSync(destination));
 const read=path=>{const s=lstatSync(path);assert.ok(s.isFile()&&!s.isSymbolicLink());assert.equal(s.uid,0);assert.equal(s.mode&0o777,0o600);assert.equal(s.nlink,1);return readFileSync(path,'utf8');};
 const web=read(directory+'/web.env'),auth=[...web.matchAll(/^AUTH_SECRET=([A-Za-z0-9_-]{32,200})$/gm)];assert.equal(auth.length,1);
 const smtp=JSON.parse(read(directory+'/postmark-smtp.json')),twilio=JSON.parse(read(directory+'/twilio-production.json'));
 assert.equal(smtp.host,'smtp.postmarkapp.com');assert.equal(smtp.port,587);assert.equal(smtp.from,'info@kavosh.ai');
 for(const value of [smtp.user,smtp.password,twilio.apiKeySecret])assert.match(value,/^[\x21-\x7e]{10,4096}$/);
 assert.match(twilio.accountSid,/^AC[a-f0-9]{32}$/);assert.match(twilio.apiKeySid,/^SK[a-f0-9]{32}$/);assert.match(twilio.messagingServiceSid,/^MG[a-f0-9]{32}$/);
 const sql=statement=>{try{return execFileSync('/usr/sbin/runuser',['-u','postgres','--','/usr/bin/psql','-X','-At','-v','ON_ERROR_STOP=1','-d','kavosh_one'],{input:statement,stdio:['pipe','pipe','pipe']}).toString().trim();}catch{throw Error('DATABASE_PROVISION_FAILED');}};
 assert.equal(sql("SELECT count(*) FROM pg_roles WHERE rolname='kavosh_one_auth_delivery';"),'0');
 assert.equal(sql('SELECT count(*) FROM identity.delivery_outbox WHERE outcome IS NULL;'),'0');
 const hba=readFileSync(hbaPath,'utf8'),marker='host all all 0.0.0.0/0 reject';assert.equal(hba.split(marker).length,2);assert.ok(!hba.includes('kavosh_one_auth_delivery'));
 const password=randomBytes(48).toString('base64url'),values={NODE_ENV:'production',DATABASE_SSL_MODE:'require',NODE_EXTRA_CA_CERTS:'/etc/kavosh-one-tls/server.crt',DELIVERY_DATABASE_URL:'postgresql://kavosh_one_auth_delivery:'+password+'@127.0.0.1:5432/kavosh_one',AUTH_SECRET:auth[0][1],SMTP_HOST:smtp.host,SMTP_PORT:String(smtp.port),SMTP_USER:smtp.user,SMTP_PASSWORD:smtp.password,SMTP_FROM:smtp.from,TWILIO_ACCOUNT_SID:twilio.accountSid,TWILIO_API_KEY_SID:twilio.apiKeySid,TWILIO_API_KEY_SECRET:twilio.apiKeySecret,TWILIO_MESSAGING_SERVICE_SID:twilio.messagingServiceSid};
 phase='private configuration';writeFileSync(destination,Object.entries(values).map(([k,v])=>k+'='+JSON.stringify(v)).join('\n')+'\n',{mode:0o600,flag:'wx',flush:true});
 phase='dedicated queue-only database login';sql("BEGIN;CREATE ROLE kavosh_one_auth_delivery LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 2 PASSWORD '"+password+"';GRANT CONNECT ON DATABASE kavosh_one TO kavosh_one_auth_delivery;GRANT kavosh_delivery TO kavosh_one_auth_delivery;COMMIT;");
 phase='TLS-only local authentication';writeFileSync(directory+'/auth-delivery-hba.before',hba,{mode:0o600,flag:'wx',flush:true});
 const changed=hba.replace(marker,'hostssl kavosh_one kavosh_one_auth_delivery 127.0.0.1/32 scram-sha-256\n'+marker),metadata=lstatSync(hbaPath),next=hbaPath+'.kavosh-one-auth.next';
 const replace=value=>{writeFileSync(next,value,{mode:metadata.mode&0o777,flag:'wx',flush:true});chownSync(next,metadata.uid,metadata.gid);renameSync(next,hbaPath);};
 replace(changed);
 try{assert.equal(sql('SELECT count(*) FROM pg_hba_file_rules WHERE error IS NOT NULL;'),'0');assert.equal(sql('SELECT pg_reload_conf();'),'t');}
 catch{replace(hba);sql('SELECT pg_reload_conf();');throw Error('HBA_VALIDATION_FAILED');}
 console.log(JSON.stringify({isolatedAuthDeliveryLoginCreated:true,queueOnlyRole:true,localTlsOnly:true,webCredentialsChanged:false,landingPageChanged:false,messagesSent:0}));
}catch{console.error('AUTH_DELIVERY_PROVISION_FAILED: '+phase);process.exitCode=1;}
