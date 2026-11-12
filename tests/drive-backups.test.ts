import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtemp,realpath,mkdir,writeFile,readFile,readdir,chmod,symlink,link,unlink,rmdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {copyEncryptedBackupToDrive} from '../src/operations/drive-backups.ts';

async function fixture(mode='normal'){
 const root=await realpath(await mkdtemp(join(tmpdir(),'kavosh-drive-test-'))),source=join(root,'source'),work=join(root,'work'),remote=join(root,'remote');
 for(const folder of [source,work,remote])await mkdir(folder,{mode:0o700});
 const archive=join(source,'database.dump.age'),binary=join(root,'rclone'),log=join(remote,'calls.jsonl'),stored=join(remote,'archive.age');
 // Synthetic ciphertext-shaped bytes test orchestration,not age cryptography.
 // The separate native database recovery suite exercises real age encryption.
 const bytes=Buffer.from('age-encryption.org/v1\nSYNTHETIC_CIPHERTEXT_ONLY_'.repeat(64));await writeFile(archive,bytes,{mode:0o600});
 const script=`#!${process.execPath}
const fs=require('node:fs');const a=process.argv.slice(2),mode=${JSON.stringify(mode)},stored=${JSON.stringify(stored)},log=${JSON.stringify(log)};
const safe=a[a.indexOf('--config')+1]==='/dev/null'&&process.env.RCLONE_CONFIG_KAVOSH_BACKUP_SCOPE==='drive.file'&&process.env.RCLONE_CONFIG_KAVOSH_BACKUP_TYPE==='drive'&&!process.env.KAVOSH_PRIVATE_ENV_SENTINEL;
if(!safe)process.exit(9);
fs.appendFileSync(log,JSON.stringify({command:a[0],args:a,pid:process.pid,credentialsInArgs:a.some(v=>v.includes('synthetic-client-secret')||v.includes('synthetic-access')||v.includes('synthetic-refresh'))})+'\\n');
if(mode==='hang'){process.on('SIGTERM',()=>{});setInterval(()=>{},1000);}
else if(mode==='error'){process.stderr.write('PRIVATE_PROVIDER_DIAGNOSTIC synthetic-refresh');process.exitCode=1;}
else if(mode==='warning'){process.stderr.write('PRIVATE_PROVIDER_WARNING synthetic-refresh');}
else if(a[0]==='copyto'){
 const bytes=fs.readFileSync(a[1]);if(!a.includes('--immutable')||!a.includes('--checksum')||!a.includes('--no-update-modtime'))process.exit(8);
 if(fs.existsSync(stored)&&!fs.readFileSync(stored).equals(bytes)){process.stderr.write('PRIVATE_IMMUTABLE_MISMATCH');process.exitCode=1;}else if(!fs.existsSync(stored))fs.writeFileSync(stored,bytes,{mode:0o600});
}else if(a[0]==='cat'){const bytes=fs.readFileSync(stored);if(mode==='changed')bytes[bytes.length-1]^=1;process.stdout.write(mode==='overrun'?Buffer.concat([bytes,Buffer.from('extra')]):mode==='short'?bytes.subarray(0,bytes.length-1):bytes);}
else process.exit(7);
`;
 await writeFile(binary,script,{mode:0o700});
 const input={rclone:binary,archive,workDirectory:work,backupId:randomUUID(),expectedSha256:createHash('sha256').update(bytes).digest('hex'),expectedBytes:bytes.length,
  drive:{clientId:'synthetic-backup.apps.googleusercontent.com',clientSecret:'synthetic-client-secret',folderId:'synthetic_folder_only',token:{access_token:'synthetic-access',refresh_token:'synthetic-refresh',token_type:'Bearer' as const,expiry:'2026-11-12T23:00:00Z',scope:'https://www.googleapis.com/auth/drive.file' as const}}};
 async function calls(){try{return(await readFile(log,'utf8')).trim().split('\n').filter(Boolean).map(s=>JSON.parse(s) as {command:string;args:string[];pid:number;credentialsInArgs:boolean});}catch{return[];}}
 async function close(){for(const file of await readdir(remote))await unlink(join(remote,file));await unlink(binary);await unlink(archive);for(const folder of [source,work,remote])await rmdir(folder);await rmdir(root);}
 return{root,source,work,remote,stored,archive,bytes,input,calls,close};
}

test('Drive backup verifies exact downloaded ciphertext,uses memory-only restricted credentials and preserves the original archive',async()=>{
 const f=await fixture();const prior=process.env.KAVOSH_PRIVATE_ENV_SENTINEL;process.env.KAVOSH_PRIVATE_ENV_SENTINEL='MUST_NOT_REACH_TRANSPORT';try{
  const result=await copyEncryptedBackupToDrive(f.input);assert.equal(result.independentCopyVerified,true);assert.equal(result.restoreVerified,false);assert.equal(result.remoteWormRetentionVerified,false);assert.equal(result.sourceDeleted,false);assert.equal(result.mediaIncluded,false);
  assert.equal(result.ciphertextSha256,f.input.expectedSha256);assert.deepEqual(await readFile(f.archive),f.bytes);assert.deepEqual(await readFile(f.stored),f.bytes);assert.deepEqual(await readdir(f.work),[]);
  const calls=await f.calls();assert.deepEqual(calls.map(c=>c.command),['copyto','cat']);assert.ok(calls.every(c=>!c.credentialsInArgs));assert.ok(calls.every(c=>c.args.includes('--transfers')&&c.args.includes('--bwlimit')));assert.doesNotMatch(JSON.stringify(result),/synthetic-client-secret|synthetic-access|synthetic-refresh/);
  assert.equal((await copyEncryptedBackupToDrive(f.input)).independentCopyVerified,true);assert.deepEqual(await readFile(f.stored),f.bytes);
 }finally{if(prior===undefined)delete process.env.KAVOSH_PRIVATE_ENV_SENTINEL;else process.env.KAVOSH_PRIVATE_ENV_SENTINEL=prior;await f.close();}
});

test('Drive backup rejects unverified digest,size,plaintext,broader scopes and injected controls before transport',async()=>{
 const f=await fixture();try{
  for(const patch of [{expectedSha256:'0'.repeat(64)},{expectedBytes:f.bytes.length+1},{drive:{...f.input.drive,token:{...f.input.drive.token,scope:'https://www.googleapis.com/auth/drive'}}},{drive:{...f.input.drive,folderId:'../other-files'}},{remote:'local:/PRIVATE'},{rclone:'relative-binary'}])await assert.rejects(copyEncryptedBackupToDrive({...f.input,...patch}));
  const plain=Buffer.from('PRIVATE PLAINTEXT IS NOT AN ENCRYPTED BACKUP.');await writeFile(f.archive,plain,{mode:0o600});await assert.rejects(copyEncryptedBackupToDrive({...f.input,expectedBytes:plain.length,expectedSha256:createHash('sha256').update(plain).digest('hex')}),{code:'ENCRYPTED_BACKUP_REQUIRED'});
  assert.deepEqual(await f.calls(),[]);assert.deepEqual(await readdir(f.work),[]);
 }finally{await f.close();}
});

test('configuration archives use a distinct fixed destination and never accept caller-chosen remote paths',async()=>{
 const f=await fixture();try{
  const result=await copyEncryptedBackupToDrive({...f.input,kind:'configuration'});assert.equal(result.scope,'one_encrypted_configuration_archive');assert.equal(result.independentCopyVerified,true);assert.equal(result.restoreVerified,false);
  const calls=await f.calls();assert.equal(calls[0].args[2],'kavosh_backup:backup-'+f.input.backupId+'/configuration.tar.age');assert.equal(calls[1].args[1],calls[0].args[2]);
  await assert.rejects(copyEncryptedBackupToDrive({...f.input,kind:'../private'}),{code:'INVALID_DRIVE_BACKUP_CONFIGURATION'});assert.equal((await f.calls()).length,2);
 }finally{await f.close();}
});

test('Drive backup refuses symlinks,hardlinks and public working directories without deleting existing files',async()=>{
 const f=await fixture(),alias=join(f.source,'alias.age');try{
  await symlink(f.archive,alias);try{await assert.rejects(copyEncryptedBackupToDrive({...f.input,archive:alias}),{code:'UNSAFE_RECOVERY_FILE'});}finally{await unlink(alias);}
  await link(f.archive,alias);try{await assert.rejects(copyEncryptedBackupToDrive(f.input),{code:'UNSAFE_RECOVERY_FILE'});}finally{await unlink(alias);}
  await chmod(f.work,0o755);try{await assert.rejects(copyEncryptedBackupToDrive(f.input),{code:'PRIVATE_RECOVERY_DIRECTORY_REQUIRED'});}finally{await chmod(f.work,0o700);}
  assert.deepEqual(await readFile(f.archive),f.bytes);assert.deepEqual(await f.calls(),[]);
 }finally{await f.close();}
});

test('Drive backup never reports remote success for changed,short or overlong downloaded content and never deletes the remote',async()=>{
 for(const mode of ['changed','short','overrun']){const f=await fixture(mode);try{
  await assert.rejects(copyEncryptedBackupToDrive(f.input),{code:'DRIVE_BACKUP_REMOTE_DIGEST_MISMATCH'});assert.deepEqual(await readFile(f.stored),f.bytes);assert.deepEqual(await readdir(f.work),[]);assert.deepEqual((await f.calls()).map(c=>c.command),['copyto','cat']);
 }finally{await f.close();}}
});

test('Drive backup scrubs provider diagnostics and refuses an existing mismatched destination instead of overwriting it',async()=>{
 for(const mode of ['normal','error','warning']){const f=await fixture(mode);try{
  const original=Buffer.from('KEEP EXISTING REMOTE');await writeFile(f.stored,original,{mode:0o600});await assert.rejects(copyEncryptedBackupToDrive(f.input),error=>{assert.equal((error as {code:string}).code,'DRIVE_BACKUP_COPY_UNVERIFIED');assert.doesNotMatch(String(error),/PRIVATE_|synthetic-refresh|client-secret/);return true;});
  assert.deepEqual(await readFile(f.stored),original);assert.deepEqual(await readdir(f.work),[]);assert.deepEqual((await f.calls()).map(c=>c.command),['copyto']);
 }finally{await f.close();}}
});

test('explicit Drive operator commands verify a retained archive and never print credentials or activate a database dump implicitly',async()=>{
 const f=await fixture(),run=promisify(execFile);try{
  const prefix=process.env.RECOVERY_COMPILED_CLI?[process.env.RECOVERY_COMPILED_CLI]:['--import','tsx','scripts/database-recovery.ts'];
  const args=[...prefix,'copy-drive',f.input.backupId,f.archive,f.input.expectedSha256,String(f.input.expectedBytes)],environment={PATH:process.env.PATH,NODE_ENV:'test' as const,RECOVERY_WORK_DIRECTORY:f.work,RCLONE_BIN:f.input.rclone,BACKUP_DRIVE_CONNECTION_JSON:JSON.stringify(f.input.drive),BACKUP_DATABASE_URL:'postgresql://PRIVATE:PRIVATE@invalid/PRIVATE'};
  const response=await run(process.execPath,args,{env:environment,timeout:5000});const result=JSON.parse(response.stdout);assert.equal(result.independentCopyVerified,true);assert.equal(result.restoreVerified,false);assert.equal(response.stderr,'');assert.doesNotMatch(response.stdout,/synthetic-client-secret|synthetic-access|synthetic-refresh|postgresql:/);assert.deepEqual((await f.calls()).map(c=>c.command),['copyto','cat']);
  const configuration=JSON.parse((await run(process.execPath,[...prefix,'copy-config',f.input.backupId,f.archive,f.input.expectedSha256,String(f.input.expectedBytes)],{env:environment,timeout:5000})).stdout);assert.equal(configuration.scope,'one_encrypted_configuration_archive');assert.equal(configuration.independentCopyVerified,true);assert.equal((await f.calls()).at(-1)?.args[1],'kavosh_backup:backup-'+f.input.backupId+'/configuration.tar.age');
  await assert.rejects(run(process.execPath,args,{env:{...environment,BACKUP_DRIVE_CONNECTION_JSON:'PRIVATE_INVALID_JSON'},timeout:5000}),error=>{const e=error as Error&{stdout:string;stderr:string};assert.equal(e.stdout,'');assert.equal(e.stderr.trim(),'INVALID_DRIVE_BACKUP_CONFIGURATION');return true;});
  await assert.rejects(run(process.execPath,[...prefix,'backup'],{env:environment,timeout:5000}),error=>{const e=error as Error&{stdout:string;stderr:string};assert.equal(e.stdout,'');assert.equal(e.stderr.trim(),'INVALID_BACKUP_CONFIGURATION');return true;});
 }finally{await f.close();}
});

test('Drive backup cancellation retains admission until a stubborn child actually exits,then permits a new copy',async()=>{
 const f=await fixture('hang'),controller=new AbortController();let pending:ReturnType<typeof copyEncryptedBackupToDrive>|undefined;try{
  pending=copyEncryptedBackupToDrive(f.input,controller.signal);void pending.catch(()=>{});const until=Date.now()+2500;let calls=await f.calls();while(!calls.length&&Date.now()<until){await delay(10);calls=await f.calls();}assert.equal(calls.length,1);
  controller.abort();await assert.rejects(copyEncryptedBackupToDrive(f.input),{code:'DRIVE_BACKUP_BUSY'});await assert.rejects(pending,{code:'DRIVE_BACKUP_COPY_UNVERIFIED'});assert.throws(()=>process.kill(calls[0].pid,0),(error:unknown)=>(error as {code:string}).code==='ESRCH');assert.deepEqual(await readdir(f.work),[]);
 }finally{controller.abort();await pending?.catch(()=>{});await f.close();}
 const next=await fixture();try{assert.equal((await copyEncryptedBackupToDrive(next.input)).independentCopyVerified,true);}finally{await next.close();}
});
