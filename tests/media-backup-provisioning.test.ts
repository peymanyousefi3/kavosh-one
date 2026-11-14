import assert from 'node:assert/strict';
import {test} from 'node:test';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mediaBackupConfiguration} from '../deploy/ovh/provision-media-backup.ts';
const run=promisify(execFile),cli='/srv/kavosh-one/operations/recovery-abcdef1/scripts/database-recovery.js',scan={accountId:'a'.repeat(32),jurisdiction:'default',bucket:'kavosh-one-production-quarantine',accessKeyId:'synthetic-scanner',secretAccessKey:'synthetic-secret-not-real',maximumUploadBytes:4194304},clean={...scan,bucket:'kavosh-one-production-clean',accessKeyId:'synthetic-reader'};
test('media setup keeps its existing identity,flock,resource isolation and timer while mounting only separate reader credentials',()=>{
 const result=mediaBackupConfiguration(cli,scan,clean),readers=JSON.parse(result.readers);assert.equal(readers.length,2);assert.deepEqual(readers.map((row:{stage:string})=>row.stage),['quarantine','clean']);assert.equal(result.environment,'KAVOSH_BACKUP_OPERATOR_CLI='+cli+'\n');assert.ok(result.dropin.includes('LoadCredential=media-readers.json:/etc/kavosh-one/media-readers.json'));assert.ok(result.dropin.includes('/usr/bin/flock --nonblock --conflict-exit-code 75'));assert.ok(result.dropin.includes('run-backup.mjs --media-backup'));assert.ok(result.dropin.includes('TimeoutStartSec=7h'));assert.doesNotMatch(result.dropin,/User=|Group=|MemoryMax=|CPUQuota=|ProtectSystem=|OnCalendar=|kavosh\.ai|synthetic-secret/);assert.doesNotMatch(result.environment,/synthetic-secret/);
});
test('media setup rejects arbitrary operator paths,shared keys,wrong buckets and accounts before configuration writes',()=>{
 for(const args of [['/tmp/arbitrary.js',scan,clean],[cli,scan,{...clean,accessKeyId:scan.accessKeyId}],[cli,scan,{...clean,bucket:'public-anything'}],[cli,scan,{...clean,accountId:'b'.repeat(32)}],[cli,scan,{...clean,secretAccessKey:'short'}]] as const)assert.throws(()=>mediaBackupConfiguration(args[0],args[1],args[2]));
});
test('signed-evidence backup configuration requires a separate same-account archive reader and explicit enablement',()=>{
 const archive={...scan,bucket:'kavosh-one-production-agreements',accessKeyId:'synthetic-signature-backup-reader'},result=mediaBackupConfiguration(cli,scan,clean,archive),readers=JSON.parse(result.readers);assert.equal(readers.length,3);assert.equal(readers[2].stage,'signature-evidence');assert.deepEqual(readers[2].configuration,archive);assert.equal(result.environment,'KAVOSH_BACKUP_OPERATOR_CLI='+cli+'\nKAVOSH_BACKUP_SIGNED_EVIDENCE_ENABLED=true\n');assert.equal(result.dropin,mediaBackupConfiguration(cli,scan,clean).dropin);
 for(const patch of [{bucket:clean.bucket},{accountId:'b'.repeat(32)},{jurisdiction:'eu'},{accessKeyId:scan.accessKeyId},{accessKeyId:clean.accessKeyId}])assert.throws(()=>mediaBackupConfiguration(cli,scan,clean,{...archive,...patch}));
});
test('setup entrypoint refuses an unauthorized invocation before inspecting private files',async()=>{
 await assert.rejects(run(process.execPath,['--import','tsx','deploy/ovh/provision-media-backup.ts',process.getuid?.()===0?'--not-approved':'--execute'],{env:{PATH:process.env.PATH,NODE_ENV:'test'},timeout:5000}),error=>{const result=error as Error&{stdout:string;stderr:string};assert.equal(result.stdout,'');assert.equal(result.stderr.trim(),'MEDIA_BACKUP_PROVISION_FAILED: existing credentials and landing were not modified.');return true;});
});
