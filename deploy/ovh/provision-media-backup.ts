import {readFile,lstat,mkdir,open,unlink,realpath} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {r2Connection} from '../../src/integrations/r2-config.ts';

const operator=/^\/srv\/kavosh-one\/operations\/recovery-[a-f0-9]{7,40}\/scripts\/database-recovery\.js$/;
export function mediaBackupConfiguration(cli:string,quarantine:unknown,clean:unknown,signatureArchive?:unknown){
 if(!operator.test(cli))throw Error('INVALID_BACKUP_OPERATOR');const scan=r2Connection.parse(quarantine),download=r2Connection.parse(clean);
 if(scan.bucket!=='kavosh-one-production-quarantine'||download.bucket!=='kavosh-one-production-clean'||scan.accountId!==download.accountId||scan.accessKeyId===download.accessKeyId)throw Error('SEPARATE_READ_ONLY_STORAGE_REQUIRED');
 const archive=signatureArchive===undefined?null:r2Connection.parse(signatureArchive);
 if(archive&&(archive.bucket!=='kavosh-one-production-agreements'||archive.accountId!==scan.accountId||archive.jurisdiction!==scan.jurisdiction||new Set([scan.accessKeyId,download.accessKeyId,archive.accessKeyId]).size!==3))throw Error('SEPARATE_READ_ONLY_STORAGE_REQUIRED');
 return{readers:JSON.stringify([{stage:'quarantine',configuration:scan},{stage:'clean',configuration:download},...archive?[{stage:'signature-evidence',configuration:archive}]:[]])+'\n',environment:'KAVOSH_BACKUP_OPERATOR_CLI='+cli+'\n'+(archive?'KAVOSH_BACKUP_SIGNED_EVIDENCE_ENABLED=true\n':''),dropin:'[Service]\nEnvironmentFile=/etc/kavosh-one/media-backup.env\nLoadCredential=media-readers.json:/etc/kavosh-one/media-readers.json\nExecStart=\nExecStart=/usr/bin/flock --nonblock --conflict-exit-code 75 /var/lib/kavosh-one-backups/backup.lock /usr/bin/node /srv/kavosh-one/deploy/run-backup.mjs --media-backup\nTimeoutStartSec=7h\n'};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const created:string[]=[];let reloaded=false;
 try{
  if(process.getuid?.()!==0||JSON.stringify(process.argv.slice(2))!==JSON.stringify(['--execute']))throw Error('ROOT_EXPLICIT_EXECUTION_REQUIRED');
  const cli=process.env.KAVOSH_BACKUP_OPERATOR_CLI??'';if(!operator.test(cli)||await realpath(cli)!==cli)throw Error('INVALID_BACKUP_OPERATOR');const runtime=await lstat(cli);if(!runtime.isFile()||runtime.uid!==0||(runtime.mode&0o022)!==0)throw Error('UNSAFE_BACKUP_OPERATOR');
  const paths=['/etc/kavosh-one/media-readers.json','/etc/kavosh-one/media-backup.env','/etc/systemd/system/kavosh-one-backup.service.d/media.conf'];
  for(const path of paths){try{await lstat(path);throw Error('EXISTING_MEDIA_CONFIGURATION_REFUSED');}catch(error){if((error as {code?:string}).code!=='ENOENT')throw error;}}
  const load=async(path:string)=>{const s=await lstat(path);if(!s.isFile()||s.isSymbolicLink()||s.uid!==0||s.nlink!==1||(s.mode&0o077)!==0||s.size>65536)throw Error('UNSAFE_STORAGE_CREDENTIAL');return JSON.parse(await readFile(path,'utf8'));};
  const configuration=mediaBackupConfiguration(cli,await load('/etc/kavosh-one/r2-scan.json'),await load('/etc/kavosh-one/r2-download.json'));
  if(!(await readFile('/srv/kavosh-one/deploy/run-backup.mjs','utf8')).includes("args[0]==='--media-backup'"))throw Error('PREPARED_BACKUP_RUNNER_REQUIRED');
  if(!(await readFile('/srv/kavosh-one/deploy/run-config-backup.sh','utf8')).includes('etc/systemd/system/kavosh-one-backup.service.d'))throw Error('PREPARED_SETTINGS_BACKUP_REQUIRED');
  const directory='/etc/systemd/system/kavosh-one-backup.service.d';try{await mkdir(directory,{mode:0o755});}catch(error){if((error as {code?:string}).code!=='EEXIST')throw error;}const s=await lstat(directory);if(!s.isDirectory()||s.isSymbolicLink()||s.uid!==0||(s.mode&0o022)!==0)throw Error('UNSAFE_BACKUP_UNIT_DIRECTORY');
  for(const [path,bytes,mode]of [[paths[0],configuration.readers,0o600],[paths[1],configuration.environment,0o600],[paths[2],configuration.dropin,0o644]] as const){const f=await open(path,'wx',mode);created.push(path);try{await f.writeFile(bytes);await f.sync();}finally{await f.close();}}
  execFileSync('/usr/bin/systemctl',['daemon-reload'],{stdio:'pipe'});reloaded=true;
  console.log(JSON.stringify({mediaConfigurationInstalled:true,existingBackupIdentityAndLockRetained:true,existingTimerChanged:false,privateReaderCredentialCopiesInstalled:true,signingEvidenceIncluded:false,landingChanged:false}));
 }catch{
  for(const path of created.reverse())await unlink(path).catch(()=>{});if(created.length&&!reloaded)try{execFileSync('/usr/bin/systemctl',['daemon-reload'],{stdio:'pipe'});}catch{}
  console.error('MEDIA_BACKUP_PROVISION_FAILED: existing credentials and landing were not modified.');process.exitCode=1;
 }
}
