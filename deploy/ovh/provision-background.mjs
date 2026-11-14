// Existing queue daemons, isolated identities. Only messages gets send-only
// provider connections. No identity secret, surrogate actor or new rule/policy.
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync,existsSync,lstatSync,renameSync,chownSync} from 'node:fs';
let phase='preflight';
try{
 assert.equal(process.getuid(),0);assert.equal(process.argv.length,3);const mode=process.argv[2],roles={notifications:'kavosh_automation_worker',reports:'kavosh_automation_worker',messages:'kavosh_message_worker','platform-notices':'kavosh_platform_notice_worker'};assert.ok(Object.hasOwn(roles,mode));
 const directory='/etc/kavosh-one',path=directory+'/background-'+mode+'.env',login='kavosh_one_'+mode.replaceAll('-','_');assert.ok(!existsSync(path));
 const read=p=>{const s=lstatSync(p);assert.ok(s.isFile()&&!s.isSymbolicLink());assert.equal(s.uid,0);assert.equal(s.mode&0o777,0o600);assert.equal(s.nlink,1);return JSON.parse(readFileSync(p,'utf8'));};
 const academyId=read(directory+'/initial-academy.json').academyId;assert.match(academyId,/^[a-f0-9-]{36}$/);
 const sql=q=>{try{return execFileSync('/usr/sbin/runuser',['-u','postgres','--','/usr/bin/psql','-X','-At','-v','ON_ERROR_STOP=1','-d','kavosh_one'],{input:q,stdio:['pipe','pipe','pipe'],timeout:10000}).toString().trim();}catch{throw Error('DATABASE_PROVISION_FAILED');}};
 assert.equal(sql("SELECT count(*) FROM pg_roles WHERE rolname='"+login+"';"),'0');assert.equal(sql('SELECT public.schema_revision();'),'388');assert.equal(sql("SELECT count(*) FROM public.academies WHERE id='"+academyId+"'::uuid;"),'1');
 const hbaPath='/etc/postgresql/18/main/pg_hba.conf',hba=readFileSync(hbaPath,'utf8'),marker='host all all 0.0.0.0/0 reject';assert.equal(hba.split(marker).length,2);assert.ok(!hba.includes(login));
 const password=randomBytes(48).toString('base64url'),url='postgresql://'+login+':'+password+'@127.0.0.1:5432/kavosh_one',ids=JSON.stringify([academyId]),values={NODE_ENV:'production',DATABASE_SSL_MODE:'require',NODE_EXTRA_CA_CERTS:'/etc/kavosh-one-tls/server.crt'};
 if(mode==='notifications')Object.assign(values,{NOTIFICATION_WORKER_ENABLED:'true',NOTIFICATION_WORKER_DATABASE_URL:url,NOTIFICATION_WORKER_ACADEMIES:ids,NOTIFICATION_SUBSCRIPTIONS_ENABLED:'true'});
 if(mode==='reports')Object.assign(values,{REPORT_WORKER_ENABLED:'true',REPORT_WORKER_DATABASE_URL:url,REPORT_WORKER_ACADEMIES:ids,REPORT_SCHEDULER_ENABLED:'true'});
 if(mode==='platform-notices')Object.assign(values,{PLATFORM_NOTICE_WORKER_ENABLED:'true',PLATFORM_NOTICE_WORKER_DATABASE_URL:url});
 if(mode==='messages'){
  const smtp=read(directory+'/postmark-smtp.json'),t=read(directory+'/twilio-production.json');assert.equal(smtp.from,'info@kavosh.ai');assert.equal(smtp.host,'smtp.postmarkapp.com');
  const twilio={accountSid:t.accountSid,messagingServiceSid:t.messagingServiceSid,apiKeySid:t.apiKeySid,apiKeySecret:t.apiKeySecret};assert.match(twilio.apiKeySid,/^SK[a-f0-9]{32}$/);
  Object.assign(values,{NOTIFICATION_OUTBOUND_WORKER_ENABLED:'true',OPERATIONAL_DELIVERY_ENABLED:'true',NOTIFICATION_OUTBOUND_DATABASE_URL:url,NOTIFICATION_OUTBOUND_ACADEMIES:ids,OPERATIONAL_DELIVERY_CONNECTIONS:JSON.stringify([{academyId,configuration:{smtp,twilio}}])});
 }
 phase='private per-worker configuration';writeFileSync(path,Object.entries(values).map(([k,v])=>k+'='+JSON.stringify(v)).join('\n')+'\n',{mode:0o600,flag:'wx',flush:true});
 phase='restricted database login';sql("BEGIN;CREATE ROLE "+login+" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 2 PASSWORD '"+password+"';GRANT CONNECT ON DATABASE kavosh_one TO "+login+";GRANT "+roles[mode]+" TO "+login+";COMMIT;");
 phase='local TLS-only authentication';writeFileSync(directory+'/background-'+mode+'-hba.before',hba,{mode:0o600,flag:'wx',flush:true});const metadata=lstatSync(hbaPath),next=hbaPath+'.kavosh-one-'+mode+'.next';
 const replace=v=>{writeFileSync(next,v,{mode:metadata.mode&0o777,flag:'wx',flush:true});chownSync(next,metadata.uid,metadata.gid);renameSync(next,hbaPath);};replace(hba.replace(marker,'hostssl kavosh_one '+login+' 127.0.0.1/32 scram-sha-256\n'+marker));
 try{assert.equal(sql('SELECT count(*) FROM pg_hba_file_rules WHERE error IS NOT NULL;'),'0');assert.equal(sql('SELECT pg_reload_conf();'),'t');}catch{replace(hba);sql('SELECT pg_reload_conf();');throw Error('HBA_VALIDATION_FAILED');}
 console.log(JSON.stringify({mode,isolatedWorkerConfigured:true,providerCredentialsIncluded:mode==='messages',rulesOrApprovalsCreated:0,messagesSent:0,schoolActivated:false,landingPageChanged:false}));
}catch{console.error('BACKGROUND_WORKER_PROVISION_FAILED: '+phase);process.exitCode=1;}
