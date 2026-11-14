// First connection setup only. Never enrol an owner,impersonate a school user,
// publish content,activate a gateway or rotate an existing connection implicitly.
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync,lstatSync,existsSync,renameSync,chownSync} from 'node:fs';
let phase='preflight';
try{
 assert.equal(process.getuid(),0);const args=process.argv.slice(2);assert.ok(['["--execute"]','["--execute-public-profile"]'].includes(JSON.stringify(args)));const profile=args[0]==='--execute-public-profile';process.umask(0o077);
 const kind=profile?'public-profile':'platform',login=profile?'kavosh_one_public_profile':'kavosh_one_platform',service=profile?'kavosh_public_profile_service':'kavosh_platform_service';
 const directory='/etc/kavosh-one',webPath=directory+'/web.env',nextWeb=webPath+'.'+kind+'.next',beforeHba=directory+'/'+kind+'-hba.before',hbaPath='/etc/postgresql/18/main/pg_hba.conf',nextHba=hbaPath+'.kavosh-one-'+kind+'.next';
 for(const path of [nextWeb,beforeHba,nextHba])assert.ok(!existsSync(path));
 const readWeb=()=>{const s=lstatSync(webPath);assert.ok(s.isFile()&&!s.isSymbolicLink());assert.equal(s.uid,0);assert.equal(s.gid,0);assert.equal(s.nlink,1);assert.equal(s.mode&0o777,0o600);assert.ok(s.size<=1048576);return readFileSync(webPath,'utf8');};
 const original=readWeb();assert.ok(!(profile?/^(?:export\s+)?(?:PUBLIC_PROFILE[A-Z0-9_]*|PROFILE_SHARE_ORIGIN)\s*=/m:/^(?:export\s+)?PLATFORM_[A-Z0-9_]+\s*=/m).test(original));
 const hbaMetadata=lstatSync(hbaPath);assert.ok(hbaMetadata.isFile()&&!hbaMetadata.isSymbolicLink());assert.equal(hbaMetadata.nlink,1);assert.equal(hbaMetadata.mode&0o022,0);
 const hba=readFileSync(hbaPath,'utf8'),marker='host all all 0.0.0.0/0 reject';assert.equal(hba.split(marker).length,2);
 const sql=input=>execFileSync('/usr/sbin/runuser',['-u','postgres','--','/usr/bin/psql','-X','-q','-At','-v','ON_ERROR_STOP=1','-d','kavosh_one'],{input,stdio:['pipe','pipe','pipe'],timeout:10000,maxBuffer:4096}).toString().trim();
 // Use PostgreSQL's parsed exact identities,not a prefix match that would
 // mistake the existing kavosh_one_platform_notices worker for this login.
 assert.equal(sql("SELECT count(*) FROM pg_hba_file_rules WHERE '"+login+"'=ANY(user_name);"),'0');
 assert.equal(sql("SELECT count(*) FROM pg_roles WHERE rolname='"+login+"' OR(rolcanlogin AND NOT rolsuper AND pg_has_role(oid,'"+service+"','member'));"),'0');
 assert.equal(sql("SELECT count(*) FROM pg_roles WHERE rolname='"+service+"' AND NOT rolcanlogin AND NOT rolsuper AND NOT rolbypassrls;"),'1');
 const password=randomBytes(48).toString('base64url');assert.match(password,/^[A-Za-z0-9_-]{64}$/);
 const url='postgresql://'+login+':'+password+'@127.0.0.1:5432/kavosh_one',values=profile?{PUBLIC_PROFILES_ENABLED:'false',PUBLIC_PROFILE_DATABASE_URL:url,PUBLIC_PROFILE_BUDGET_SECRET:randomBytes(32).toString('base64url'),PROFILE_SHARE_ORIGIN:'https://one.kavosh.ai'}:{PLATFORM_ENABLED:'false',PLATFORM_DATABASE_URL:url},changed=original+(original.endsWith('\n')?'':'\n')+Object.entries(values).map(([k,v])=>k+'='+JSON.stringify(v)).join('\n')+'\n';
 phase='private recovery configuration';assert.equal(readWeb(),original);writeFileSync(nextWeb,changed,{mode:0o600,flag:'wx',flush:true});assert.equal(readWeb(),original);renameSync(nextWeb,webPath);assert.equal(readWeb(),changed);
 phase='restricted platform connection';
 sql("BEGIN;SET LOCAL log_statement='none';SET LOCAL log_min_duration_statement=-1;SET LOCAL log_min_duration_sample=-1;SET LOCAL log_min_error_statement='panic';CREATE ROLE "+login+" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 2 PASSWORD '"+password+"';GRANT CONNECT ON DATABASE kavosh_one TO "+login+";GRANT "+service+" TO "+login+";COMMIT;");
 phase='local TLS authentication';assert.equal(readFileSync(hbaPath,'utf8'),hba);writeFileSync(beforeHba,hba,{mode:0o600,flag:'wx',flush:true});
 const replace=value=>{writeFileSync(nextHba,value,{mode:hbaMetadata.mode&0o777,flag:'wx',flush:true});chownSync(nextHba,hbaMetadata.uid,hbaMetadata.gid);renameSync(nextHba,hbaPath);};
 replace(hba.replace(marker,'hostssl kavosh_one '+login+' 127.0.0.1/32 scram-sha-256\n'+marker));
 try{assert.equal(sql('SELECT count(*) FROM pg_hba_file_rules WHERE error IS NOT NULL;'),'0');assert.equal(sql('SELECT pg_reload_conf();'),'t');}
 catch{replace(hba);sql('SELECT pg_reload_conf();');throw Error('PLATFORM_HBA_VALIDATION_FAILED');}
 console.log(JSON.stringify({connectionKind:kind,...profile?{restrictedPublicProfileConnectionCreated:true,publicProfilesEnabled:false,recordsPublished:0}:{restrictedPlatformConnectionCreated:true,platformGatewayEnabled:false,ownerEnrolled:false},localTlsOnly:true,connectionLimit:2,existingWebCredentialsPreserved:true,existingHbaRulesPreserved:true,serviceRestarted:false,businessDataWrites:0,providerOperations:0,encryptedBackupVerificationRequired:true}));
}catch{console.error('PLATFORM_CONNECTION_PROVISION_FAILED: '+phase);process.exitCode=1;}
