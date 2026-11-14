// Fresh operator setup only. Does not call BoldSign or activate any school.
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync,existsSync,lstatSync,renameSync,chownSync} from 'node:fs';
let phase='preflight';
try{
 assert.equal(process.getuid(),0);assert.equal(process.argv.length,2);
 const directory='/etc/kavosh-one',privatePath=directory+'/signature-ingest.env',recordPath=directory+'/boldsign-webhook.json',webPath=directory+'/web.env',login='kavosh_one_signature_ingest';
 for(const p of [privatePath,recordPath,webPath+'.before-signature-ingest',webPath+'.signature-next'])assert.ok(!existsSync(p));
 const read=p=>{const s=lstatSync(p);assert.ok(s.isFile()&&!s.isSymbolicLink());assert.equal(s.uid,0);assert.equal(s.mode&0o777,0o600);assert.equal(s.nlink,1);return readFileSync(p,'utf8');};
 const academyId=JSON.parse(read(directory+'/initial-academy.json')).academyId;assert.match(academyId,/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
 const previous=read(webPath);assert.doesNotMatch(previous,/^(SIGNATURE_INGEST_DATABASE_URL|BOLDSIGN_WEBHOOK_ENABLED|BOLDSIGN_WEBHOOK_CONNECTIONS)=/m);
 const sql=q=>{try{return execFileSync('/usr/sbin/runuser',['-u','postgres','--','/usr/bin/psql','-X','-At','-v','ON_ERROR_STOP=1','-d','kavosh_one'],{input:q,stdio:['pipe','pipe','pipe'],timeout:10000}).toString().trim();}catch{throw Error('SIGNATURE_DATABASE_SETUP_FAILED');}};
 assert.equal(sql('SELECT public.schema_revision();'),'390');assert.equal(sql("SELECT count(*) FROM pg_roles WHERE rolname='"+login+"';"),'0');assert.equal(sql("SELECT count(*) FROM public.academies WHERE id='"+academyId+"'::uuid AND status IN('provisioning','active','read_only');"),'1');
 const hbaPath='/etc/postgresql/18/main/pg_hba.conf',hba=readFileSync(hbaPath,'utf8'),marker='host all all 0.0.0.0/0 reject';assert.equal(hba.split(marker).length,2);assert.ok(!hba.includes(login));
 const connection={connectionId:randomUUID(),academyId,region:'CA',environment:'Live',clientId:null,secrets:[randomBytes(48).toString('base64url')]},password=randomBytes(48).toString('base64url');
 const additions={SIGNATURE_INGEST_DATABASE_URL:'postgresql://'+login+':'+password+'@127.0.0.1:5432/kavosh_one',BOLDSIGN_WEBHOOK_ENABLED:'true',BOLDSIGN_WEBHOOK_CONNECTIONS:JSON.stringify([connection])},encode=v=>Object.entries(v).map(([k,s])=>k+'='+JSON.stringify(s)).join('\n')+'\n';
 phase='private recovery configuration';writeFileSync(privatePath,encode({NODE_ENV:'production',DATABASE_SSL_MODE:'require',NODE_EXTRA_CA_CERTS:'/etc/kavosh-one-tls/server.crt',...additions}),{mode:0o600,flag:'wx',flush:true});writeFileSync(recordPath,JSON.stringify({configuration:connection,providerSecretConfigured:false})+'\n',{mode:0o600,flag:'wx',flush:true});
 phase='restricted login and native stream';sql("BEGIN;CREATE ROLE "+login+" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 2 PASSWORD '"+password+"';GRANT CONNECT ON DATABASE kavosh_one TO "+login+";GRANT kavosh_signature_ingest TO "+login+";INSERT INTO public.signature_connections(id,academy_id,region,environment,client_id,enabled,bound_documents_only) VALUES('"+connection.connectionId+"','"+academyId+"','CA','Live',NULL,true,true);INSERT INTO public.outbox_events(academy_id,id,event_type,entity_id,request_id) VALUES('"+academyId+"','"+randomUUID()+"','signature.connection.enabled.critical','"+connection.connectionId+"','"+randomUUID()+"');COMMIT;");
 phase='local TLS-only authentication';writeFileSync(directory+'/signature-ingest-hba.before',hba,{mode:0o600,flag:'wx',flush:true});const metadata=lstatSync(hbaPath),next=hbaPath+'.signature-next';
 const replace=v=>{writeFileSync(next,v,{mode:metadata.mode&0o777,flag:'wx',flush:true});chownSync(next,metadata.uid,metadata.gid);renameSync(next,hbaPath);};replace(hba.replace(marker,'hostssl kavosh_one '+login+' 127.0.0.1/32 scram-sha-256\n'+marker));
 try{assert.equal(sql('SELECT count(*) FROM pg_hba_file_rules WHERE error IS NOT NULL;'),'0');assert.equal(sql('SELECT pg_reload_conf();'),'t');}catch{replace(hba);sql('SELECT pg_reload_conf();');throw Error('SIGNATURE_HBA_INVALID');}
 phase='preserve and extend web environment';assert.equal(read(webPath),previous);writeFileSync(webPath+'.before-signature-ingest',previous,{mode:0o600,flag:'wx',flush:true});writeFileSync(webPath+'.signature-next',previous+(previous.endsWith('\n')?'':'\n')+encode(additions),{mode:0o600,flag:'wx',flush:true});renameSync(webPath+'.signature-next',webPath);
 console.log(JSON.stringify({callbackUrl:'https://one.kavosh.ai/api/webhooks/boldsign/'+connection.connectionId,restrictedLoginConfigured:true,boundDocumentsOnly:true,providerSecretConfigured:false,providerWebhookCreated:false,schoolActivated:false,agreementsSentOrChanged:0,landingPageChanged:false,serviceRestarted:false}));
}catch{console.error('SIGNATURE_INGEST_PROVISION_FAILED: '+phase);process.exitCode=1;}
