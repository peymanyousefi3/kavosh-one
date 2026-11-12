// Fresh scanner worker only. No upload/promotion keys, user credentials,
// financial access, mail access or automatic file publication.
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync,existsSync,lstatSync,renameSync,chownSync} from 'node:fs';
let phase='preflight';
try{
 assert.equal(process.getuid(),0);assert.deepEqual(process.argv.slice(2),['--execute']);
 const directory='/etc/kavosh-one',destination=directory+'/file-inspection.env',hbaPath='/etc/postgresql/18/main/pg_hba.conf';assert.ok(!existsSync(destination));
 const read=p=>{const s=lstatSync(p);assert.ok(s.isFile()&&!s.isSymbolicLink());assert.equal(s.uid,0);assert.equal(s.mode&0o777,0o600);assert.equal(s.nlink,1);return JSON.parse(readFileSync(p,'utf8'));};
 const academy=read(directory+'/initial-academy.json'),r2=read(directory+'/r2-scan.json');assert.match(academy.academyId,/^[a-f0-9-]{36}$/);assert.equal(r2.bucket,'kavosh-one-production-quarantine');assert.equal(r2.accountId,'e7bedfa4c49de9507c44d118e5b20dc9');assert.ok(Number.isSafeInteger(r2.maximumUploadBytes)&&r2.maximumUploadBytes>0);
 const sql=q=>{try{return execFileSync('/usr/sbin/runuser',['-u','postgres','--','/usr/bin/psql','-X','-At','-v','ON_ERROR_STOP=1','-d','kavosh_one'],{input:q,stdio:['pipe','pipe','pipe'],timeout:10000}).toString().trim();}catch{throw Error('DATABASE_PROVISION_FAILED');}};
 assert.equal(sql("SELECT count(*) FROM pg_roles WHERE rolname='kavosh_one_file_inspection';"),'0');assert.equal(sql('SELECT public.schema_revision();'),'388');assert.equal(sql("SELECT count(*) FROM public.academies WHERE id='"+academy.academyId+"'::uuid;"),'1');
 const hba=readFileSync(hbaPath,'utf8'),marker='host all all 0.0.0.0/0 reject';assert.equal(hba.split(marker).length,2);assert.ok(!hba.includes('kavosh_one_file_inspection'));
 const password=randomBytes(48).toString('base64url'),values={NODE_ENV:'production',DATABASE_SSL_MODE:'require',NODE_EXTRA_CA_CERTS:'/etc/kavosh-one-tls/server.crt',FILE_INSPECTION_WORKER_ENABLED:'true',FILE_INSPECTION_DATABASE_URL:'postgresql://kavosh_one_file_inspection:'+password+'@127.0.0.1:5432/kavosh_one',FILE_INSPECTION_R2_CONNECTIONS:JSON.stringify([{academyId:academy.academyId,configuration:r2}]),FILE_INSPECTION_MAXIMUM_BYTES:String(Math.min(r2.maximumUploadBytes,67108864)),FILE_INSPECTION_TIMEOUT_MS:'120000',FILE_IMAGE_VALIDATION_ENABLED:'true',FILE_IMAGE_VALIDATION_SOCKET_PATH:'/run/kavosh-one-parser-image/validator.sock',FILE_PDF_VALIDATION_ENABLED:'true',FILE_PDF_VALIDATION_SOCKET_PATH:'/run/kavosh-one-parser-pdf/validator.sock',FILE_VIDEO_VALIDATION_ENABLED:'true',FILE_VIDEO_VALIDATION_SOCKET_PATH:'/run/kavosh-one-parser-video/validator.sock',CLAMD_SOCKET_PATH:'/run/kavosh-one-scanner/clamd.sock',CLAMD_TIME_ZONE:'UTC',CLAMD_MAXIMUM_DATABASE_AGE_SECONDS:'172800'};
 phase='private worker configuration';writeFileSync(destination,Object.entries(values).map(([k,v])=>k+'='+JSON.stringify(v)).join('\n')+'\n',{mode:0o600,flag:'wx',flush:true});
 phase='restricted inspection login';sql("BEGIN;CREATE ROLE kavosh_one_file_inspection LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 2 PASSWORD '"+password+"';GRANT CONNECT ON DATABASE kavosh_one TO kavosh_one_file_inspection;GRANT kavosh_file_worker TO kavosh_one_file_inspection;COMMIT;");
 phase='local TLS-only authentication';writeFileSync(directory+'/file-inspection-hba.before',hba,{mode:0o600,flag:'wx',flush:true});const metadata=lstatSync(hbaPath),next=hbaPath+'.kavosh-one-file.next';
 const replace=v=>{writeFileSync(next,v,{mode:metadata.mode&0o777,flag:'wx',flush:true});chownSync(next,metadata.uid,metadata.gid);renameSync(next,hbaPath);};
 replace(hba.replace(marker,'hostssl kavosh_one kavosh_one_file_inspection 127.0.0.1/32 scram-sha-256\n'+marker));
 try{assert.equal(sql('SELECT count(*) FROM pg_hba_file_rules WHERE error IS NOT NULL;'),'0');assert.equal(sql('SELECT pg_reload_conf();'),'t');}catch{replace(hba);sql('SELECT pg_reload_conf();');throw Error('HBA_VALIDATION_FAILED');}
 console.log(JSON.stringify({inspectionWorkerConfigured:true,restrictedInspectionDatabaseRole:true,quarantineReadOnlyCredentialSelected:true,webCredentialsChanged:false,landingPageChanged:false,filesPublished:0}));
}catch{console.error('FILE_INSPECTION_PROVISION_FAILED: '+phase);process.exitCode=1;}
