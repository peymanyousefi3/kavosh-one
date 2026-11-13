import {execFile} from 'node:child_process';
import {promisify,isDeepStrictEqual} from 'node:util';
import {mkdir,open,writeFile} from 'node:fs/promises';
import {constants} from 'node:fs';
import {createHash} from 'node:crypto';
import pg from 'pg';
import {z} from 'zod';
import {privateDirectory,regularFile} from './recovery-files.ts';
import {backupVerification,databaseVerificationSnapshot,clusterVerificationSnapshot} from './database-verification.ts';
import {canonicalRoleExport,roleExportForRestore,isolatedClusterRecoveryPlan} from './role-recovery.ts';
import {RecoveryError} from './recovery-error.ts';
import {verifyRecoveryOsIsolation} from './recovery-isolation.ts';

const digest=z.string().regex(/^[a-f0-9]{64}$/),name=z.string().regex(/^[A-Za-z_][A-Za-z0-9_$]{0,62}$/);
const input=z.object({format:z.literal('kavosh-isolated-cluster-input-v1'),backupId:z.uuid(),databaseName:name,sourceBootstrapRole:name,archiveSha256:digest,databaseDumpSha256:digest,databaseDumpBytes:z.number().int().min(1).max(1_099_511_627_776),roleExportSha256:digest,roleExportBytes:z.number().int().min(1).max(4194304)}).strict();

// Native tools execute trusted,authenticated superuser SQL. The caller MUST
// additionally isolate the OS identity,network and live paths. This function
// proves the separate PostgreSQL instance,not that external OS boundary.
export async function restoreIsolatedCluster(directory:string,postgresBin:string,signal?:AbortSignal){
 if(process.getuid?.()===0)throw new RecoveryError('UNPRIVILEGED_RECOVERY_REQUIRED');
 await privateDirectory(directory);
 const osIsolationVerified=process.env.KAVOSH_RESTORE_OS_ISOLATION_REQUIRED==='1'?await verifyRecoveryOsIsolation():false;
 // Validate the path before even reading operator inputs.
 isolatedClusterRecoveryPlan(directory,'postgres',postgresBin);
 const read=async(filename:string,maximum:number)=>{
  const path=directory+'/'+filename,before=await regularFile(path);if(before.uid!==0||(before.mode&0o022)!==0||before.size>maximum)throw new RecoveryError('UNSAFE_CLUSTER_INPUT');
  const handle=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);try{const now=await handle.stat();if(now.ino!==before.ino||now.dev!==before.dev||now.size!==before.size||now.nlink!==1)throw new RecoveryError('UNSAFE_CLUSTER_INPUT');const bytes=Buffer.alloc(before.size+1),result=await handle.read(bytes,0,bytes.length,0);if(result.bytesRead!==before.size)throw new RecoveryError('UNSAFE_CLUSTER_INPUT');return bytes.subarray(0,result.bytesRead);}finally{await handle.close();}
 };
 const metadata=input.parse(JSON.parse((await read('input.json',16384)).toString())),verification=backupVerification.parse(JSON.parse((await read('verification.json',2097152)).toString()));
 if(!verification.cluster||verification.archiveSha256!==metadata.archiveSha256)throw new RecoveryError('CLUSTER_BASELINE_REQUIRED');
 const plan=isolatedClusterRecoveryPlan(directory,metadata.sourceBootstrapRole,postgresBin),roles=await read('roles-export.sql',4194304);
 if(roles.length!==metadata.roleExportBytes||createHash('sha256').update(roles).digest('hex')!==metadata.roleExportSha256)throw new RecoveryError('ROLE_EXPORT_DIGEST_MISMATCH');
 const roleText=roles.toString();roles.fill(0);const prepared=roleExportForRestore(roleText,metadata.sourceBootstrapRole);
 const dump=await regularFile(directory+'/database.dump');if(dump.uid!==0||(dump.mode&0o022)!==0||dump.size!==metadata.databaseDumpBytes)throw new RecoveryError('UNSAFE_CLUSTER_INPUT');
 const file=await open(directory+'/database.dump',constants.O_RDONLY|constants.O_NOFOLLOW),hash=createHash('sha256');let bytes=0;
 try{const now=await file.stat();if(now.ino!==dump.ino||now.dev!==dump.dev||now.nlink!==1||now.size!==dump.size)throw new RecoveryError('UNSAFE_CLUSTER_INPUT');for await(const chunk of file.createReadStream()){if(signal?.aborted)throw new RecoveryError('RECOVERY_CANCELLED');bytes+=chunk.length;if(bytes>metadata.databaseDumpBytes)throw new RecoveryError('BACKUP_DIGEST_MISMATCH');hash.update(chunk);}}finally{await file.close().catch(()=>{});}
 if(bytes!==metadata.databaseDumpBytes||hash.digest('hex')!==metadata.databaseDumpSha256)throw new RecoveryError('BACKUP_DIGEST_MISMATCH');
 const run=promisify(execFile),env={PATH:postgresBin+':/usr/bin:/bin',NODE_ENV:'production' as const,LANG:'C',TZ:'UTC'};
 const command=async(args:string[],stopping=false)=>{try{return await run(args[0],args.slice(1),{env,signal:stopping?undefined:signal,timeout:stopping?10000:120000,maxBuffer:4194304});}catch{throw new RecoveryError(stopping?'CLUSTER_STOP_FAILED':'CLUSTER_TOOL_FAILED');}};
 let startAttempted=false,client:pg.Client|undefined,result;
 try{
  await mkdir(plan.socket,{mode:0o700});await writeFile(directory+'/roles.sql',prepared,{mode:0o600,flag:'wx'});
  await command(plan.initdb);startAttempted=true;await command(plan.start);await command(plan.roles);await command(plan.database);
  client=new pg.Client({host:plan.socket,port:plan.port,user:plan.bootstrapRole,database:metadata.databaseName,connectionTimeoutMillis:5000,statement_timeout:30000,ssl:false});await client.connect();
  const boundary=(await client.query("SELECT current_setting('data_directory') directory,current_setting('unix_socket_directories') socket,current_setting('listen_addresses') listening,inet_server_addr() address")).rows[0];
  if(boundary.directory!==plan.data||boundary.socket!==plan.socket||boundary.listening!==''||boundary.address!==null)throw new RecoveryError('CLUSTER_BOUNDARY_MISMATCH');
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  const snapshot=await databaseVerificationSnapshot(client,signal),cluster=await clusterVerificationSnapshot(client,signal);
  if(!isDeepStrictEqual(snapshot,verification.snapshot)||!isDeepStrictEqual(cluster,verification.cluster))throw new RecoveryError('RESTORED_CLUSTER_MISMATCH');
  await client.query('COMMIT');
  const exported=(await command([postgresBin+'/pg_dumpall','--roles-only','--no-role-passwords','--no-password','--host',plan.socket,'--port',String(plan.port),'--username',plan.bootstrapRole,'--database','postgres'])).stdout;
  if(!isDeepStrictEqual(canonicalRoleExport(exported),canonicalRoleExport(roleText)))throw new RecoveryError('RESTORED_ROLES_MISMATCH');
  result={backupId:metadata.backupId,archiveSha256:metadata.archiveSha256,schemaRevision:snapshot.schemaRevision,tablesCompared:snapshot.tables.length,rowsCompared:snapshot.tables.reduce((n,t)=>n+t.fingerprint.rows,0),rolesAndMembershipsVerified:true,databaseAccessAndSettingsVerified:true,originalExportedSnapshotMatched:true,networkListeningAllowed:false,applicationActivationAllowed:false,passwordsRestored:false,sequenceValuesVerified:false,osIsolationVerified,fullServerRebuildVerified:false};
 }finally{await client?.end().catch(()=>{});if(startAttempted)await command(plan.stop,true);}
 return {...result,isolatedPostgresStopped:true};
}
