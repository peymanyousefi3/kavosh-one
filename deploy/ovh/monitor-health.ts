import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {constants} from 'node:fs';
import {open,rename,realpath,statfs,unlink} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {privateDirectory,regularFile} from '../../src/operations/recovery-files.ts';
import {evaluateOperationalHealth,healthObservation,systemdExitTime} from '../../src/operations/operational-health.ts';
const run=promisify(execFile);let temporary:string|undefined;
try{
 if(process.argv.length!==2||process.getuid?.()===0||process.env.STATE_DIRECTORY!=='/var/lib/kavosh-one-health')throw new Error('INVALID_MONITOR_CONTEXT');
 const directory=await realpath(process.env.STATE_DIRECTORY);if(directory!=='/var/lib/kavosh-one-health')throw new Error('INVALID_MONITOR_CONTEXT');await privateDirectory(directory);
 for(const key of ['DATABASE_URL','AUTH_SECRET','IDENTITY_DATABASE_URL','BACKUP_DATABASE_URL','CREDENTIALS_DIRECTORY'])if(process.env[key]!==undefined)throw new Error('MONITOR_CREDENTIALS_REFUSED');
 const current=directory+'/status.json';let previous:ReturnType<typeof evaluateOperationalHealth>|undefined;
 try{const before=await regularFile(current,true);if(before.size>16384)throw new Error();const f=await open(current,constants.O_RDONLY|constants.O_NOFOLLOW);try{const now=await f.stat();if(now.ino!==before.ino||now.dev!==before.dev||now.size!==before.size)throw new Error();const bytes=Buffer.alloc(before.size+1),read=await f.read(bytes,0,bytes.length,0);if(read.bytesRead!==before.size)throw new Error();const value=JSON.parse(bytes.subarray(0,read.bytesRead).toString());previous=evaluateOperationalHealth(healthObservation.parse({observedAt:value.observedAt,ready:value.ready,freeBackupDiskBytes:value.freeBackupDiskBytes,web:value.web,backup:value.backup,configuration:value.configuration,backupTimerActive:value.backupTimerActive,configurationTimerActive:value.configurationTimerActive}));}finally{await f.close();}}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw new Error('INVALID_PREVIOUS_HEALTH_STATE');}
 const units=['kavosh-one.service','kavosh-one-backup.service','kavosh-one-config-backup.service','kavosh-one-backup.timer','kavosh-one-config-backup.timer'],properties=new Map<string,Record<string,string>>();let output='';
 let managerFailure:string|null=null;
 try{output=(await run('/usr/bin/systemctl',['show',...units,'-p','Id','-p','ActiveState','-p','Result','-p','ExecMainStatus','-p','ExecMainExitTimestamp'],{env:{PATH:'/usr/bin:/bin',NODE_ENV:'production',LANG:'C',TZ:'UTC'},timeout:5000,maxBuffer:32768})).stdout;}catch(error){managerFailure=(error as {killed?:boolean}).killed?'MANAGER_QUERY_TIMEOUT':'MANAGER_QUERY_UNAVAILABLE';}
 for(const block of output.trim()?output.trim().split(/\n\n+/):[]){const props=Object.fromEntries(block.split('\n').map(line=>{const i=line.indexOf('=');return[line.slice(0,i),line.slice(i+1)];}));if(!units.includes(props.Id)||properties.has(props.Id))throw new Error('INVALID_MANAGER_RESPONSE');properties.set(props.Id,props);}
 const service=(name:string,prior?:NonNullable<typeof previous>['backup'])=>{const props=properties.get(name)??{},exitStatus=props.ExecMainStatus===undefined?null:Number(props.ExecMainStatus),successful=props.ActiveState==='inactive'&&props.Result==='success'&&exitStatus===0;return healthObservation.shape.backup.parse({active:props.ActiveState??'unknown',result:props.Result||'unknown',exitStatus,lastSuccessfulExitAt:successful?(systemdExitTime(props.ExecMainExitTimestamp)??prior?.lastSuccessfulExitAt??null):prior?.lastSuccessfulExitAt??null});};
 const web=service('kavosh-one.service'),backup=service('kavosh-one-backup.service',previous?.backup),configuration=service('kavosh-one-config-backup.service',previous?.configuration);
 let ready=false;try{const response=await fetch('https://one.kavosh.ai/api/ready',{redirect:'error',signal:AbortSignal.timeout(5000),headers:{Accept:'application/json'}});if(response.status===200&&response.body){let bytes=0,text='';for await(const chunk of response.body){bytes+=chunk.length;if(bytes>1024){await response.body.cancel().catch(()=>{});throw new Error();}text+=Buffer.from(chunk).toString('utf8');}const value=JSON.parse(text);ready=value?.ready===true&&Object.keys(value).length===1;}else await response.body?.cancel();}catch{ready=false;}
 const timer=(name:string)=>{const active=properties.get(name)?.ActiveState;return active&&active!=='unknown'?active==='active':null;};
 const disk=await statfs('/var/lib/kavosh-one-backups',{bigint:true}),result=evaluateOperationalHealth({observedAt:new Date().toISOString(),ready,freeBackupDiskBytes:String(disk.bavail*disk.bsize),web,backup,configuration,backupTimerActive:timer('kavosh-one-backup.timer'),configurationTimerActive:timer('kavosh-one-config-backup.timer')});
 temporary=current+'.'+randomUUID()+'.next';const out=await open(temporary,'wx',0o600);try{await out.writeFile(JSON.stringify(result)+'\n');await out.sync();}finally{await out.close();}await rename(temporary,current);temporary=undefined;
 console.log(JSON.stringify({observedAt:result.observedAt,status:result.status,issues:result.issues,managerFailure,readinessVerified:ready,independentUptimeVerified:false,externalMessagesSent:0}));
 if(result.status==='critical')process.exitCode=1;
}catch{console.error('KAVOSH_ONE_HEALTH_MONITOR_FAILED: inspect private status; no credentials or diagnostic bodies were logged.');process.exitCode=1;}
finally{if(temporary)await unlink(temporary).catch(()=>{});}
