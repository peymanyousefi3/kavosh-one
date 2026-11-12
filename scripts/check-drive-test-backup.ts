import assert from 'node:assert/strict';
import {execFileSync,spawnSync} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtemp,realpath,mkdir,writeFile,readFile,readdir,unlink,rmdir} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {copyEncryptedBackupToDrive,driveBackupCredentials} from '../src/operations/drive-backups.ts';

// Explicit Mac-only live verification. No real DB,student,teacher,parent or
// financial data. No remote deletion or sharing change. Only encrypted test
// artifacts remain in a clearly named private verification subfolder.
let phase='configuration',root:string|undefined,work:string|undefined,identity:Buffer|undefined;
const owned:string[]=[],checks:string[]=[];
try{
 assert.deepEqual(process.argv.slice(2),['--execute']);assert.equal(process.platform,'darwin');
 const raw=execFileSync('/usr/bin/security',['find-generic-password','-a','kavosh-one','-s','kavosh-one-drive-backup-connection','-w'],{stdio:['ignore','pipe','pipe']});
 let drive:ReturnType<typeof driveBackupCredentials.parse>;try{drive=driveBackupCredentials.parse(JSON.parse(raw.toString()));}finally{raw.fill(0);}
 const headers={authorization:'Bearer '+drive.token.access_token,'content-type':'application/json'};
 const fields='id,name,mimeType,ownedByMe,shared,permissions(role,type,deleted),webViewLink';
 async function json(url:string,options:RequestInit={}){const response=await fetch(url,{...options,headers,redirect:'error',signal:AbortSignal.timeout(15000)});if(!response.ok){await response.body?.cancel();throw Error('PROVIDER_FAILED');}const text=await response.text();if(text.length>65536)throw Error('PROVIDER_LIMIT');return JSON.parse(text);}
 const privateFolder=(folder:Record<string,any>)=>{assert.match(folder.id,/^[A-Za-z0-9_-]{10,200}$/);assert.equal(folder.mimeType,'application/vnd.google-apps.folder');assert.equal(folder.ownedByMe,true);assert.equal(folder.shared,false);assert.equal(folder.permissions.length,1);assert.equal(folder.permissions[0].role,'owner');assert.equal(folder.permissions[0].type,'user');assert.notEqual(folder.permissions[0].deleted,true);};
 phase='private destination';const parent=await json('https://www.googleapis.com/drive/v3/files/'+drive.folderId+'?'+new URLSearchParams({fields}));privateFolder(parent);checks.push('private_owner_only_root');
 const q="'"+drive.folderId+"' in parents and trashed=false and appProperties has { key='kavoshBackupVerification' and value='synthetic' }";
 const existing=await json('https://www.googleapis.com/drive/v3/files?'+new URLSearchParams({q,fields:'files('+fields+')',pageSize:'2'}));assert.ok(Array.isArray(existing.files)&&existing.files.length<=1);
 const folder=existing.files[0]??await json('https://www.googleapis.com/drive/v3/files?'+new URLSearchParams({fields}),{method:'POST',body:JSON.stringify({name:'Verification - synthetic only',mimeType:'application/vnd.google-apps.folder',parents:[drive.folderId],appProperties:{kavoshBackupVerification:'synthetic'}})});privateFolder(folder);checks.push('isolated_private_synthetic_folder');
 const binary='/opt/homebrew/bin/rclone',age='/opt/homebrew/bin/age',keygen='/opt/homebrew/bin/age-keygen';
 phase='synthetic encryption';root=await realpath(await mkdtemp(join(tmpdir(),'kavosh-drive-live-')));work=join(root,'work');await mkdir(work,{mode:0o700});
 const source=join(root,'database.dump.age'),recovered=join(root,'retrieved.dump.age'),plaintext=Buffer.from('Kavosh One synthetic offsite encryption and recovery verification. No real academy records.\n'.repeat(512));
 identity=execFileSync(keygen,[],{stdio:['ignore','pipe','pipe'],timeout:5000});const recipient=execFileSync(keygen,['-y'],{input:identity,stdio:['pipe','pipe','pipe'],timeout:5000}).toString().trim();
 const ciphertext=execFileSync(age,['--encrypt','--recipient',recipient],{input:plaintext,stdio:['pipe','pipe','pipe'],timeout:5000,maxBuffer:1048576});assert.equal(ciphertext.subarray(0,22).toString(),'age-encryption.org/v1\n');assert.equal(ciphertext.includes(plaintext),false);await writeFile(source,ciphertext,{mode:0o600,flag:'wx'});owned.push(source);checks.push('real_age_encryption_without_private_key_file');
 phase='live encrypted copy and verification';const input={rclone:binary,archive:source,workDirectory:work,backupId:randomUUID(),expectedSha256:createHash('sha256').update(ciphertext).digest('hex'),expectedBytes:ciphertext.length,drive:{...drive,folderId:folder.id},timeoutMs:60000};
 const proof=await copyEncryptedBackupToDrive(input);assert.equal(proof.independentCopyVerified,true);assert.equal(proof.restoreVerified,false);assert.equal(proof.sourceDeleted,false);checks.push('live_upload_and_full_sha256_readback');
 phase='idempotent verified retry';assert.equal((await copyEncryptedBackupToDrive(input)).independentCopyVerified,true);checks.push('immutable_existing_archive_retry');
 phase='independent recovery download';const response=spawnSync(binary,['cat','kavosh_backup:backup-'+input.backupId+'/database.dump.age','--config','/dev/null','--log-level','ERROR','--stats','0','--retries','1','--low-level-retries','1'],{env:{PATH:process.env.PATH,NODE_ENV:'test',LANG:'C',TZ:'UTC',RCLONE_CONFIG_KAVOSH_BACKUP_TYPE:'drive',RCLONE_CONFIG_KAVOSH_BACKUP_SCOPE:'drive.file',RCLONE_CONFIG_KAVOSH_BACKUP_ROOT_FOLDER_ID:folder.id,RCLONE_CONFIG_KAVOSH_BACKUP_CLIENT_ID:drive.clientId,RCLONE_CONFIG_KAVOSH_BACKUP_CLIENT_SECRET:drive.clientSecret,RCLONE_CONFIG_KAVOSH_BACKUP_TOKEN:JSON.stringify(drive.token)},stdio:['ignore','pipe','pipe'],timeout:20000,maxBuffer:1048576});
 assert.equal(response.status,0);assert.equal(response.stderr.length,0);assert.deepEqual(response.stdout,ciphertext);await writeFile(recovered,response.stdout,{mode:0o600,flag:'wx'});owned.push(recovered);checks.push('separate_exact_ciphertext_download');
 const clear=execFileSync(age,['--decrypt','--identity','-',recovered],{input:identity,stdio:['pipe','pipe','pipe'],timeout:5000,maxBuffer:1048576});assert.deepEqual(clear,plaintext);clear.fill(0);checks.push('real_age_decryption_matches_original_synthetic_bytes');assert.deepEqual(await readFile(source),ciphertext);assert.deepEqual(await readdir(work),[]);checks.push('source_preserved_and_private_staging_removed');
 assert.equal(new URL(folder.webViewLink).hostname,'drive.google.com');
 console.log(JSON.stringify({provider:'google_drive',live:true,checks:checks.length,passed:checks,syntheticOnly:true,encryptedBytes:ciphertext.length,realPersonalDataUsed:false,realDatabaseRestoreVerified:false,remoteFilesDeleted:false,testArtifactRetained:true,verificationFolderUrl:folder.webViewLink,googleApplicationStatus:'testing',permanentScheduledBackupsReady:false}));
}catch{console.error('DRIVE_LIVE_TEST_FAILED: '+phase);process.exitCode=1;}
finally{identity?.fill(0);for(const path of owned)await unlink(path).catch(()=>{});if(work)await rmdir(work).catch(()=>{});if(root)await rmdir(root).catch(()=>{});}
