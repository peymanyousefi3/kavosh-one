// Exact two worker modes. The verifier receives only the clean-bucket reader;
// the promoter receives only quarantine-read and clean-write credentials.
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync,lstatSync,existsSync,renameSync,chownSync} from 'node:fs';
let phase='preflight';
try{
 assert.equal(process.getuid(),0);assert.equal(process.argv.length,3);const mode=process.argv[2];assert.ok(['promotion','verification'].includes(mode));const directory='/etc/kavosh-one',path=directory+'/file-'+mode+'.env',login='kavosh_one_file_'+mode;assert.ok(!existsSync(path));
 const read=p=>{const s=lstatSync(p);assert.ok(s.isFile()&&!s.isSymbolicLink());assert.equal(s.uid,0);assert.equal(s.mode&0o777,0o600);assert.equal(s.nlink,1);return JSON.parse(readFileSync(p,'utf8'));};
 const academyId=read(directory+'/initial-academy.json').academyId;assert.match(academyId,/^[a-f0-9-]{36}$/);
 const load=role=>{const c=read(directory+'/r2-'+role+'.json');assert.equal(c.accountId,'e7bedfa4c49de9507c44d118e5b20dc9');assert.equal(c.bucket,role==='scan'?'kavosh-one-production-quarantine':'kavosh-one-production-clean');return c;};
 const connection=mode==='promotion'?{academyId,source:load('scan'),destination:load('promote')}:{academyId,reader:load('download')};
 const sql=q=>{try{return execFileSync('/usr/sbin/runuser',['-u','postgres','--','/usr/bin/psql','-X','-At','-v','ON_ERROR_STOP=1','-d','kavosh_one'],{input:q,stdio:['pipe','pipe','pipe'],timeout:10000}).toString().trim();}catch{throw Error('DATABASE_PROVISION_FAILED');}};
 assert.equal(sql("SELECT count(*) FROM pg_roles WHERE rolname='"+login+"';"),'0');assert.equal(sql('SELECT public.schema_revision();'),'388');assert.equal(sql("SELECT count(*) FROM public.academies WHERE id='"+academyId+"'::uuid;"),'1');
 const hbaPath='/etc/postgresql/18/main/pg_hba.conf',hba=readFileSync(hbaPath,'utf8'),marker='host all all 0.0.0.0/0 reject';assert.equal(hba.split(marker).length,2);assert.ok(!hba.includes(login));
 const password=randomBytes(48).toString('base64url'),values={NODE_ENV:'production',DATABASE_SSL_MODE:'require',NODE_EXTRA_CA_CERTS:'/etc/kavosh-one-tls/server.crt',FILE_COPY_WORKER_ENABLED:'true',FILE_COPY_MODE:mode,FILE_COPY_WORKER_DATABASE_URL:'postgresql://'+login+':'+password+'@127.0.0.1:5432/kavosh_one',FILE_COPY_CONNECTIONS:JSON.stringify([connection])};
 phase='private mode-specific configuration';writeFileSync(path,Object.entries(values).map(([k,v])=>k+'='+JSON.stringify(v)).join('\n')+'\n',{mode:0o600,flag:'wx',flush:true});
 phase='restricted worker database login';sql("BEGIN;CREATE ROLE "+login+" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 2 PASSWORD '"+password+"';GRANT CONNECT ON DATABASE kavosh_one TO "+login+";GRANT kavosh_file_worker TO "+login+";COMMIT;");
 phase='local TLS-only authentication';writeFileSync(directory+'/file-'+mode+'-hba.before',hba,{mode:0o600,flag:'wx',flush:true});const metadata=lstatSync(hbaPath),next=hbaPath+'.kavosh-one-'+mode+'.next';
 const replace=v=>{writeFileSync(next,v,{mode:metadata.mode&0o777,flag:'wx',flush:true});chownSync(next,metadata.uid,metadata.gid);renameSync(next,hbaPath);};replace(hba.replace(marker,'hostssl kavosh_one '+login+' 127.0.0.1/32 scram-sha-256\n'+marker));
 try{assert.equal(sql('SELECT count(*) FROM pg_hba_file_rules WHERE error IS NOT NULL;'),'0');assert.equal(sql('SELECT pg_reload_conf();'),'t');}catch{replace(hba);sql('SELECT pg_reload_conf();');throw Error('HBA_VALIDATION_FAILED');}
 console.log(JSON.stringify({mode,privateWorkerConfigured:true,sharedCredentialsAdded:false,landingPageChanged:false,filesCopiedOrPublished:0}));
}catch{console.error('FILE_COPY_PROVISION_FAILED: '+phase);process.exitCode=1;}
