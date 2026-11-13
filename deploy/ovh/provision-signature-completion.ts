// Fresh root-only setup. Deliberately disabled until separate acceptance.
// No provider IO,service start,web/identity configuration or school activation.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync,writeFileSync,existsSync,lstatSync,renameSync,chownSync } from 'node:fs';
import { signatureCompletionWorkerConfiguration } from '../../src/integrations/signature-completion-config.ts';
import { expectedSchemaRevision } from '../../src/core/database.ts';

let phase='preflight';
try{
 assert.equal(process.getuid?.(),0);assert.equal(process.argv.length,2);
 const directory='/etc/kavosh-one',path=directory+'/signature-completion.env',login='kavosh_one_signature_completion';
 const parent=lstatSync(directory);assert.ok(parent.isDirectory()&&!parent.isSymbolicLink());assert.equal(parent.uid,0);assert.equal(parent.mode&0o777,0o700);
 for(const p of [path,directory+'/signature-completion-hba.before'])assert.ok(!existsSync(p));
 const read=(p:string)=>{const s=lstatSync(p);assert.ok(s.isFile()&&!s.isSymbolicLink());assert.equal(s.uid,0);assert.equal(s.mode&0o777,0o600);assert.equal(s.nlink,1);assert.ok(s.size<=1048576);return JSON.parse(readFileSync(p,'utf8'));};
 const academyId=read(directory+'/initial-academy.json').academyId;assert.match(academyId,/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
 const provider=read(directory+'/boldsign-production.json'),archive=read(directory+'/signature-vault-production.json');assert.equal(provider.region,'CA');assert.equal(provider.environment,'Live');
 assert.ok(!['kavosh-one-production-quarantine','kavosh-one-production-clean'].includes(archive.bucket));
 const sql=(query:string)=>{try{return execFileSync('/usr/sbin/runuser',['-u','postgres','--','/usr/bin/psql','-X','-At','-v','ON_ERROR_STOP=1','-d','kavosh_one'],{input:query,stdio:['pipe','pipe','pipe'],timeout:10000}).toString().trim();}catch{throw Error('SIGNATURE_COMPLETION_DATABASE_SETUP_FAILED');}};
 assert.equal(sql('SELECT public.schema_revision();'),String(expectedSchemaRevision));
 assert.equal(sql("SELECT count(*) FROM pg_roles WHERE rolname='"+login+"';"),'0');
 assert.equal(sql("SELECT count(*) FROM public.academies WHERE id='"+academyId+"'::uuid AND status IN('provisioning','active','read_only');"),'1');
 const connections=JSON.parse(sql("SELECT coalesce(json_agg(json_build_object('connectionId',id,'region',region,'environment',environment,'clientId',client_id)),'[]'::json) FROM public.signature_connections WHERE academy_id='"+academyId+"'::uuid AND enabled AND bound_documents_only AND region='CA' AND environment='Live' AND client_id IS NULL;"));assert.equal(connections.length,1);
 const password=randomBytes(48).toString('base64url'),url='postgresql://'+login+':'+password+'@127.0.0.1:5432/kavosh_one';
 const values={NODE_ENV:'production',DATABASE_SSL_MODE:'require',NODE_EXTRA_CA_CERTS:'/etc/kavosh-one-tls/server.crt',SIGNATURE_COMPLETION_WORKER_ENABLED:'true',SIGNATURE_COMPLETION_DATABASE_URL:url,SIGNATURE_COMPLETION_CONNECTIONS:JSON.stringify([{academyId,providers:[{...connections[0],apiKey:provider.apiKey}],archive}])};
 assert.ok(signatureCompletionWorkerConfiguration(values));
 const hbaPath='/etc/postgresql/18/main/pg_hba.conf',hba=readFileSync(hbaPath,'utf8'),marker='host all all 0.0.0.0/0 reject';assert.equal(hba.split(marker).length,2);assert.ok(!hba.includes(login));
 const metadata=lstatSync(hbaPath),next=hbaPath+'.signature-completion-next';assert.ok(metadata.isFile()&&!metadata.isSymbolicLink());assert.ok(!existsSync(next));
 phase='disabled private recovery configuration';
 writeFileSync(path,Object.entries({...values,SIGNATURE_COMPLETION_WORKER_ENABLED:'false'}).map(([k,v])=>k+'='+JSON.stringify(v)).join('\n')+'\n',{mode:0o600,flag:'wx',flush:true});
 phase='restricted database login';
 sql("BEGIN;CREATE ROLE "+login+" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 2 PASSWORD '"+password+"';GRANT CONNECT ON DATABASE kavosh_one TO "+login+";GRANT kavosh_signature_completion_worker TO "+login+";COMMIT;");
 phase='local TLS-only authentication';writeFileSync(directory+'/signature-completion-hba.before',hba,{mode:0o600,flag:'wx',flush:true});
 const replace=(v:string)=>{writeFileSync(next,v,{mode:metadata.mode&0o777,flag:'wx',flush:true});chownSync(next,metadata.uid,metadata.gid);renameSync(next,hbaPath);};
 replace(hba.replace(marker,'hostssl kavosh_one '+login+' 127.0.0.1/32 scram-sha-256\n'+marker));
 try{assert.equal(sql('SELECT count(*) FROM pg_hba_file_rules WHERE error IS NOT NULL;'),'0');assert.equal(sql('SELECT pg_reload_conf();'),'t');}catch{replace(hba);sql('SELECT pg_reload_conf();');throw Error('SIGNATURE_COMPLETION_HBA_INVALID');}
 console.log(JSON.stringify({isolatedDatabaseLoginConfigured:true,workerEnabled:false,serviceStarted:false,providerRequests:0,existingAgreementsChanged:0,schoolActivated:false,landingPageChanged:false}));
}catch{console.error('SIGNATURE_COMPLETION_PROVISION_FAILED: '+phase);process.exitCode=1;}
