import {createHash,randomUUID} from 'node:crypto';
import {mkdtemp,realpath,mkdir,writeFile,readFile,readdir,unlink,rmdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

export async function driveBackupFixture(mode='normal'){
 const root=await realpath(await mkdtemp(join(tmpdir(),'kavosh-drive-test-'))),source=join(root,'source'),work=join(root,'work'),remote=join(root,'remote');
 for(const folder of [source,work,remote])await mkdir(folder,{mode:0o700});
 const backupId=randomUUID(),remoteFile=(name:string)=>join(remote,createHash('sha256').update(name).digest('hex')+'.age');
 const archive=join(source,'database.dump.age'),binary=join(root,'rclone'),log=join(remote,'calls.jsonl'),stored=remoteFile('kavosh_backup:backup-'+backupId+'/database.dump.age');
 // Synthetic ciphertext-shaped bytes test orchestration,not age cryptography.
 // The separate native database recovery suite exercises real age encryption.
 const bytes=Buffer.from('age-encryption.org/v1\nSYNTHETIC_CIPHERTEXT_ONLY_'.repeat(64));await writeFile(archive,bytes,{mode:0o600});
 const script=`#!${process.execPath}
const fs=require('node:fs');const a=process.argv.slice(2),mode=${JSON.stringify(mode)},remote=${JSON.stringify(remote)},log=${JSON.stringify(log)};
const stored=require('node:path').join(remote,require('node:crypto').createHash('sha256').update(a[0]==='copyto'?a[2]:a[1]).digest('hex')+'.age');
const safe=a[a.indexOf('--config')+1]==='/dev/null'&&process.env.RCLONE_CONFIG_KAVOSH_BACKUP_SCOPE==='drive.file'&&process.env.RCLONE_CONFIG_KAVOSH_BACKUP_TYPE==='drive'&&!process.env.KAVOSH_PRIVATE_ENV_SENTINEL;
if(!safe)process.exit(9);
fs.appendFileSync(log,JSON.stringify({command:a[0],args:a,pid:process.pid,credentialsInArgs:a.some(v=>v.includes('synthetic-client-secret')||v.includes('synthetic-access')||v.includes('synthetic-refresh'))})+'\\n');
if(mode==='hang'){process.on('SIGTERM',()=>{});setInterval(()=>{},1000);}
else if(mode==='error'){process.stderr.write('PRIVATE_PROVIDER_DIAGNOSTIC synthetic-refresh');process.exitCode=1;}
else if(mode==='catalog-error'&&a[0]==='copyto'&&a[2].endsWith('/catalog.jsonl.age')){process.stderr.write('PRIVATE_CATALOG_COPY_FAILURE');process.exitCode=1;}
else if(mode==='warning'){process.stderr.write('PRIVATE_PROVIDER_WARNING synthetic-refresh');}
else if(a[0]==='copyto'){
 const bytes=fs.readFileSync(a[1]);if(!a.includes('--immutable')||!a.includes('--checksum')||!a.includes('--no-update-modtime'))process.exit(8);
 if(fs.existsSync(stored)&&!fs.readFileSync(stored).equals(bytes)){process.stderr.write('PRIVATE_IMMUTABLE_MISMATCH');process.exitCode=1;}else if(!fs.existsSync(stored))fs.writeFileSync(stored,bytes,{mode:0o600});
}else if(a[0]==='cat'){const bytes=fs.readFileSync(stored);if(mode==='changed')bytes[bytes.length-1]^=1;process.stdout.write(mode==='overrun'?Buffer.concat([bytes,Buffer.from('extra')]):mode==='short'?bytes.subarray(0,bytes.length-1):bytes);}
else process.exit(7);
`;
 await writeFile(binary,script,{mode:0o700});
 const input={rclone:binary,archive,workDirectory:work,backupId,expectedSha256:createHash('sha256').update(bytes).digest('hex'),expectedBytes:bytes.length,
  drive:{clientId:'synthetic-backup.apps.googleusercontent.com',clientSecret:'synthetic-client-secret',folderId:'synthetic_folder_only',token:{access_token:'synthetic-access',refresh_token:'synthetic-refresh',token_type:'Bearer' as const,expiry:'2026-11-12T23:00:00Z',scope:'https://www.googleapis.com/auth/drive.file' as const}}};
 async function calls(){try{return(await readFile(log,'utf8')).trim().split('\n').filter(Boolean).map(s=>JSON.parse(s) as {command:string;args:string[];pid:number;credentialsInArgs:boolean});}catch{return[];}}
 async function close(){for(const file of await readdir(remote))await unlink(join(remote,file));await unlink(binary);await unlink(archive);for(const folder of [source,work,remote])await rmdir(folder);await rmdir(root);}
 return{root,source,work,remote,stored,archive,bytes,input,calls,close,remoteFile};
}
