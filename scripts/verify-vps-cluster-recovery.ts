// Explicit offline operator. Keys stay on this Mac; plaintext is streamed only
// into new root-private staging,then an isolated,dynamic-user restore service.
import assert from 'node:assert/strict';
import {execFileSync,spawnSync} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtempSync,openSync,closeSync,readFileSync,writeFileSync,unlinkSync,rmdirSync,statSync} from 'node:fs';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {isolatedClusterUnit,isolatedRecoveryStopped} from '../src/operations/cluster-recovery-unit.ts';
import {canonicalRoleExport} from '../src/operations/role-recovery.ts';
import {backupVerification} from '../src/operations/database-verification.ts';

const ssh=['-F','.local-tools/ovh.ssh-config','kavosh-one-production'],quote=(s:string)=>"'"+s.replaceAll("'","'\\''")+"'";
const remote=(command:string,input?:Buffer)=>execFileSync('/usr/bin/ssh',[...ssh,command],{input,stdio:[input?'pipe':'ignore','pipe','pipe'],timeout:60000,maxBuffer:3145728});
const get=(service:string)=>{const bytes=execFileSync('/usr/bin/security',['find-generic-password','-a','kavosh-one','-s',service,'-w'],{stdio:['ignore','pipe','pipe']});try{return JSON.parse(bytes.toString());}finally{bytes.fill(0);}};
let stage='arguments',directory:string|undefined,unit:ReturnType<typeof isolatedClusterUnit>|undefined,staged=false,installed=false;
let success:Record<string,unknown>|undefined,serverCleanupDeferred=false;
const localFiles:string[]=[],stagedFiles=['database.dump','roles-export.sql','verification.json','input.json','unit.service'];
const properties=(name:string)=>Object.fromEntries(remote('sudo systemctl show '+name+'.service -p LoadState -p ActiveState -p MainPID -p ControlPID -p Result -p ExecMainStatus -p MemoryPeak -p CPUUsageNSec').toString().trim().split('\n').map(line=>{const i=line.indexOf('=');return[line.slice(0,i),line.slice(i+1)];}));
try{
 const args=process.argv.slice(2);assert.equal(args.length,2);assert.equal(args[0],'--execute');assert.match(args[1],/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);assert.equal(process.platform,'darwin');
 const revision=process.env.CLUSTER_RECOVERY_OPERATOR_REVISION;assert.ok(revision&&/^[a-f0-9]{7,40}$/.test(revision)&&!/[\r\n]/.test(revision));process.umask(0o077);
 const operator='/srv/kavosh-one/operations/recovery-'+revision;unit=isolatedClusterUnit(randomUUID().replaceAll('-',''),operator);
 stage='trusted receipts';const receipt=JSON.parse(remote('sudo -u kavosh-one-backup cat /var/lib/kavosh-one-backups/backup-'+args[1]+'/delivery-status.json').toString()),backup=receipt.localBackup,config=JSON.parse(remote('sudo cat /var/lib/kavosh-one-config-backups/latest.json').toString());
 assert.equal(backup.id,args[1]);assert.equal(backup.serverMajor,18);assert.equal(receipt.snapshotBaselineOffsiteVerified,true);assert.equal(receipt.offsiteCopy?.independentCopyVerified,true);assert.equal(receipt.verificationOffsiteCopy?.independentCopyVerified,true);assert.equal(config.offsite?.independentCopyVerified,true);assert.equal(config.offsite?.scope,'one_encrypted_configuration_archive');assert.match(config.id,/^[a-f0-9-]{36}$/);
 const expected=backupVerification.parse(backup.verification);assert.ok(expected.cluster);assert.equal(expected.archiveSha256,backup.ciphertextSha256);
 const webBefore=remote('sudo systemctl show kavosh-one.service -p MainPID --value').toString().trim();assert.match(webBefore,/^[1-9][0-9]*$/);
 const source=JSON.parse(remote('sudo -u postgres psql -X -At --no-password -d kavosh_one -c '+quote("SELECT json_build_object('databaseName',current_database(),'bootstrapRole',(SELECT rolname FROM pg_roles WHERE oid=10))")).toString());assert.equal(source.databaseName,'kavosh_one');assert.match(source.bootstrapRole,/^[A-Za-z_][A-Za-z0-9_$]{0,62}$/);
 const drive=get('kavosh-one-drive-backup-connection'),recovery=get('kavosh-one-production-backup-recovery');assert.equal(drive.token.scope,'https://www.googleapis.com/auth/drive.file');
 directory=mkdtempSync('/private/tmp/kavosh-one-cluster-proof-');
 const download=(id:string,filename:string,bytes:number,digest:string,maximum:number)=>{
  assert.ok(Number.isSafeInteger(bytes)&&bytes>=22&&bytes<=maximum);assert.match(digest,/^[a-f0-9]{64}$/);const encrypted=join(directory!,filename),clear=join(directory!,filename.replace(/\.age$/,''));
  const content=execFileSync('/opt/homebrew/bin/rclone',['cat','kavosh_backup:backup-'+id+'/'+filename,'--config','/dev/null','--log-level','ERROR','--stats','0','--retries','1','--low-level-retries','1'],{env:{PATH:process.env.PATH,NODE_ENV:'production',RCLONE_CONFIG_KAVOSH_BACKUP_TYPE:'drive',RCLONE_CONFIG_KAVOSH_BACKUP_SCOPE:'drive.file',RCLONE_CONFIG_KAVOSH_BACKUP_ROOT_FOLDER_ID:drive.folderId,RCLONE_CONFIG_KAVOSH_BACKUP_CLIENT_ID:drive.clientId,RCLONE_CONFIG_KAVOSH_BACKUP_CLIENT_SECRET:drive.clientSecret,RCLONE_CONFIG_KAVOSH_BACKUP_TOKEN:JSON.stringify(drive.token)},stdio:['ignore','pipe','pipe'],timeout:60000,maxBuffer:bytes});
  try{assert.equal(content.length,bytes);assert.equal(createHash('sha256').update(content).digest('hex'),digest);writeFileSync(encrypted,content,{flag:'wx',mode:0o600});localFiles.push(encrypted);}finally{content.fill(0);}
  const fd=openSync(clear,'wx',0o600);localFiles.push(clear);try{execFileSync('/opt/homebrew/bin/age',['--decrypt','--identity','-',encrypted],{input:recovery.identity,stdio:['pipe',fd,'pipe'],timeout:30000});}finally{closeSync(fd);}return clear;
 };
 stage='independent authenticated downloads';let database:string,verificationFile:string,configuration:string;
 try{database=download(backup.id,'database.dump.age',backup.encryptedBytes,backup.ciphertextSha256,268435456);const proof=backup.verificationArchive;assert.equal(proof.filename,'verification.json.age');verificationFile=download(backup.id,proof.filename,proof.encryptedBytes,proof.ciphertextSha256,4194304);configuration=download(config.id,'configuration.tar.age',config.encryptedBytes,config.ciphertextSha256,16777216);}finally{recovery.identity='';}
 stage='input integrity';assert.ok(statSync(verificationFile).size<=2097152);assert.deepEqual(backupVerification.parse(JSON.parse(readFileSync(verificationFile,'utf8'))),expected);
 const roles=execFileSync('/usr/bin/tar',['-xOf',configuration,'roles.sql'],{stdio:['ignore','pipe','pipe'],maxBuffer:4194304});canonicalRoleExport(roles.toString());
 const dump=readFileSync(database),metadata={format:'kavosh-isolated-cluster-input-v1',backupId:backup.id,databaseName:source.databaseName,sourceBootstrapRole:source.bootstrapRole,archiveSha256:backup.ciphertextSha256,databaseDumpBytes:dump.length,databaseDumpSha256:createHash('sha256').update(dump).digest('hex'),roleExportBytes:roles.length,roleExportSha256:createHash('sha256').update(roles).digest('hex')};dump.fill(0);
 stage='new root-private staging';remote('sudo test ! -e '+unit.staging+' && sudo install -d -m0700 '+unit.staging);staged=true;
 const destination=(file:string)=>'sudo /bin/sh -c '+quote('umask 077; exec /usr/bin/dd conv=excl oflag=nofollow status=none of='+unit!.staging+'/'+file);
 const upload=(file:string,content:Buffer)=>remote(destination(file),content);
 const fd=openSync(database,'r');try{const transfer=spawnSync('/usr/bin/ssh',[...ssh,destination('database.dump')],{stdio:[fd,'pipe','pipe'],timeout:60000,maxBuffer:65536});assert.equal(transfer.status,0);}finally{closeSync(fd);}
 try{upload('roles-export.sql',roles);}finally{roles.fill(0);}upload('verification.json',readFileSync(verificationFile));upload('input.json',Buffer.from(JSON.stringify(metadata)));upload('unit.service',Buffer.from(unit.unit));
 stage='isolated service';installed=true;remote('sudo install -m0644 '+unit.staging+'/unit.service /run/systemd/system/'+unit.name+'.service');remote('sudo systemctl daemon-reload && sudo systemctl start --no-block '+unit.name+'.service');console.error('ISOLATED_CLUSTER_RECOVERY_STARTED: '+unit.name);
 const deadline=Date.now()+600000;let state=properties(unit.name);while(!isolatedRecoveryStopped(state)&&Date.now()<deadline){await delay(3000);state=properties(unit.name);}assert.ok(isolatedRecoveryStopped(state));assert.equal(state.ActiveState,'inactive');assert.equal(state.Result,'success');assert.equal(state.ExecMainStatus,'0');
 stage='restore evidence';const lines=remote('sudo journalctl -u '+unit.name+'.service --no-pager -o cat -n 20').toString().split('\n'),result=JSON.parse(lines.findLast(line=>line.startsWith('{"backupId":'))??'null');assert.equal(result?.backupId,backup.id);
 for(const field of ['originalExportedSnapshotMatched','rolesAndMembershipsVerified','databaseAccessAndSettingsVerified','isolatedPostgresStopped','osIsolationVerified'])assert.equal(result[field],true);assert.equal(result.applicationActivationAllowed,false);
 assert.equal(result.sequenceSafety?.nextGeneratedValuesOutsideRetainedData,true);assert.equal(result.sequenceSafety?.sequenceValuesChanged,false);assert.equal(result.sequenceSafety?.originalLiveSequenceValuesCompared,false);assert.ok(Number.isSafeInteger(result.sequenceSafety?.ownedSequencesChecked)&&result.sequenceSafety.ownedSequencesChecked>=0);assert.equal(result.sequenceValuesVerified,false);
 assert.equal(result.snapshotMatchPrecedesAuthenticationQuarantine,true);assert.equal(result.authenticationQuarantine?.originalBusinessAndAccountRecordsPreserved,true);assert.equal(result.authenticationQuarantine?.originalCredentialAndInvitationHistoryPreserved,true);assert.equal(result.authenticationQuarantine?.externalQueuesReplayed,false);assert.equal(result.authenticationQuarantine?.applicationActivationAllowed,false);
 assert.equal(remote('sudo systemctl show kavosh-one.service -p MainPID --value').toString().trim(),webBefore);assert.equal(remote('curl -sS -o /dev/null -w "%{http_code}" https://kavosh.ai/').toString(),'200');
 success={...result,unitName:unit.name,configurationBackupId:config.id,independentDriveDownloadsVerified:3,privateRecoveryKeyTransferredToVps:false,liveWebProcessUnchanged:true,landingHttpStatus:200,sourceDatabaseRestoreCommandsIssued:0,memoryPeak:state.MemoryPeak,cpuUsageNanoseconds:state.CPUUsageNSec};
}catch{console.error('ISOLATED_CLUSTER_ACCEPTANCE_FAILED: '+stage);process.exitCode=1;}
finally{
 if(installed&&unit){
  let observed:Record<string,string>|undefined;try{observed=properties(unit.name);}catch{/* Preserve the same job and private inputs when observation is unavailable. */}
  if(!isolatedRecoveryStopped(observed)){serverCleanupDeferred=true;console.error('ISOLATED_CLUSTER_OBSERVATION_PENDING: '+unit.name);process.exitCode=1;}
  else try{remote('sudo systemctl stop '+unit.name+'.service && sudo systemctl clean --what=state '+unit.name+'.service');remote('sudo rm -- /run/systemd/system/'+unit.name+'.service && sudo systemctl daemon-reload');}catch{serverCleanupDeferred=true;console.error('CLUSTER_SERVICE_CLEANUP_REQUIRED: '+unit.name);process.exitCode=1;}
 }
 if(staged&&unit&&!serverCleanupDeferred)try{remote('sudo rm -f -- '+stagedFiles.map(file=>unit!.staging+'/'+file).join(' ')+' && sudo rmdir '+unit.staging);}catch{console.error('CLUSTER_INPUT_CLEANUP_REQUIRED');process.exitCode=1;}
 for(const file of localFiles)try{unlinkSync(file);}catch{console.error('CLUSTER_LOCAL_CLEANUP_REQUIRED');process.exitCode=1;}
 if(directory)try{rmdirSync(directory);}catch{console.error('CLUSTER_LOCAL_CLEANUP_REQUIRED');process.exitCode=1;}
}
if(success&&process.exitCode!==1)console.log(JSON.stringify({...success,temporaryLocalAndServerInputsRemoved:true,temporaryDatabaseAndServiceRemoved:true}));
