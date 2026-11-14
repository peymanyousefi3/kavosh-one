// First installation only,not rotation or recovery. Existing encrypted records
// or even old private proposals require their original keys,never replacements.
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync,lstatSync,existsSync,renameSync} from 'node:fs';
let phase='preflight';
try{
 assert.equal(process.getuid(),0);assert.deepEqual(process.argv.slice(2),['--execute']);process.umask(0o077);
 const path='/etc/kavosh-one/web.env',next=path+'.private-data.next';assert.ok(!existsSync(next));
 const read=()=>{const s=lstatSync(path);assert.ok(s.isFile()&&!s.isSymbolicLink());assert.equal(s.uid,0);assert.equal(s.gid,0);assert.equal(s.nlink,1);assert.equal(s.mode&0o777,0o600);assert.ok(s.size<=1048576);return readFileSync(path,'utf8');};
 const original=read();assert.ok(!/^(?:export\s+)?(?:STUDENT_CARE|PAYROLL)_PRIVATE_[A-Z0-9_]+\s*=/m.test(original));
 phase='existing private evidence';
 const sql="BEGIN READ ONLY;SET LOCAL statement_timeout='5s';SELECT (SELECT count(*) FROM public.student_care_revisions)+(SELECT count(*) FROM public.payroll_private_identity_revisions)+(SELECT count(*) FROM public.approval_requests WHERE action IN('student.care.change','student.care.submit','work.payroll-identity.change'));COMMIT;";
 const count=execFileSync('/usr/sbin/runuser',['-u','postgres','--','/usr/bin/psql','-X','-q','-At','-v','ON_ERROR_STOP=1','-d','kavosh_one'],{input:sql,stdio:['pipe','pipe','pipe'],timeout:10000,maxBuffer:4096}).toString().trim();assert.equal(count,'0');
 const values={},secrets=[];
 for(const prefix of ['STUDENT_CARE','PAYROLL']){const key=randomBytes(32).toString('base64url'),fingerprint=randomBytes(32).toString('base64url');assert.match(key,/^[A-Za-z0-9_-]{43}$/);assert.match(fingerprint,/^[A-Za-z0-9_-]{43}$/);secrets.push(key,fingerprint);values[prefix+'_PRIVATE_ACTIVE_KEY_ID']='v1';values[prefix+'_PRIVATE_KEYS']=JSON.stringify({v1:key});values[prefix+'_PRIVATE_FINGERPRINT_KEY']=fingerprint;}
 assert.equal(new Set(secrets).size,4);
 const changed=original+(original.endsWith('\n')?'':'\n')+Object.entries(values).map(([k,v])=>k+'='+JSON.stringify(v)).join('\n')+'\n';
 phase='private atomic configuration';assert.equal(read(),original);writeFileSync(next,changed,{mode:0o600,flag:'wx',flush:true});assert.equal(read(),original);renameSync(next,path);assert.equal(read(),changed);
 // No automatic service restart: first authenticate the encrypted settings
 // backup,then activate the already verified release through its normal gate.
 console.log(JSON.stringify({privateDataKeysConfigured:true,separateCareAndPayrollKeys:true,existingConfigurationPreserved:true,existingPrivateEvidence:0,serviceRestarted:false,databaseWrites:0,providerOperations:0,encryptedBackupVerificationRequired:true}));
}catch{console.error('PRIVATE_DATA_PROVISION_FAILED: '+phase);process.exitCode=1;}
