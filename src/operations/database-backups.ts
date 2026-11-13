import { spawn,type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash,randomUUID } from 'node:crypto';
import { constants,createReadStream } from 'node:fs';
import { open,mkdir,unlink,rmdir } from 'node:fs/promises';
import { isAbsolute,join,dirname } from 'node:path';
import { Readable,Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import pg from 'pg';
import { z } from 'zod';
import { expectedSchemaRevision } from '../core/database.ts';
import { isDeepStrictEqual } from 'node:util';
import { backupVerification,databaseVerificationSnapshot } from './database-verification.ts';
import {RecoveryError} from './recovery-error.ts';
import {captureMediaReferencePlan} from './media-reference-plan.ts';
import {privateDirectory,regularFile,nativeRecoveryIdentity} from './recovery-files.ts';
export {privateDirectory,regularFile} from './recovery-files.ts';
export {RecoveryError} from './recovery-error.ts';

const path=z.string().min(1).max(4096).refine(v=>isAbsolute(v)&&!v.includes('\0'));
const common=z.object({
 databaseUrl:z.string().min(1).max(8192),sslMode:z.enum(['verify-full','disable']).default('verify-full'),caFile:path.optional(),
 age:path,workDirectory:path,timeoutMs:z.number().int().min(1000).max(3_600_000).default(900_000),
 maximumBytes:z.number().int().min(1_048_576).max(1_099_511_627_776).default(21_474_836_480)
});
const backupInput=common.extend({pgDump:path,recipient:z.string().regex(/^age1[023456789acdefghjklmnpqrstuvwxyz]{58}$/),verificationSnapshot:z.boolean().default(false),mediaReferenceSnapshot:z.boolean().default(false)}).strict();
const restoreInput=common.extend({
 pgRestore:path,archive:path,identityFile:path,expectedSha256:z.string().regex(/^[a-f0-9]{64}$/),
 expectedRevision:z.number().int().min(expectedSchemaRevision).max(2147483647),confirmation:z.string().max(100),expectedVerification:backupVerification.optional()
}).strict();
async function connection(i:z.infer<typeof common>){
 const u=new URL(i.databaseUrl),database=decodeURIComponent(u.pathname.slice(1)),user=decodeURIComponent(u.username),password=decodeURIComponent(u.password);
 if(!['postgres:','postgresql:'].includes(u.protocol)||u.search||u.hash||!u.hostname||!database||!user||[database,user,password].some(v=>/[\0\r\n]/.test(v))||!/^[-A-Za-z0-9_$]{1,63}$/.test(database))throw new RecoveryError('INVALID_RECOVERY_DATABASE');
 const host=u.hostname.replace(/^\[|\]$/g,'');
 if(i.sslMode==='disable'&&(process.env.NODE_ENV==='production'||!['127.0.0.1','localhost','::1'].includes(host)))throw new RecoveryError('RECOVERY_DATABASE_TLS_REQUIRED');
 let ca:string|undefined;
 if(i.sslMode==='verify-full'){
  if(!i.caFile)throw new RecoveryError('RECOVERY_DATABASE_CA_REQUIRED');
  const s=await regularFile(i.caFile);if(s.size>1_048_576||(s.mode&0o022)!==0||![0,process.getuid?.()].includes(s.uid))throw new RecoveryError('UNSAFE_RECOVERY_CA');
  const f=await open(i.caFile,constants.O_RDONLY|constants.O_NOFOLLOW);try{ca=await f.readFile('utf8');}finally{await f.close();}
 }
 const env:NodeJS.ProcessEnv={PATH:process.env.PATH,NODE_ENV:process.env.NODE_ENV??'production',LANG:'C',TZ:'UTC',PGHOST:host,PGPORT:u.port||'5432',PGDATABASE:database,PGUSER:user,PGSSLMODE:i.sslMode,PGGSSENCMODE:'disable',PGCONNECT_TIMEOUT:'5',PGAPPNAME:'kavosh-recovery',...i.caFile?{PGSSLROOTCERT:i.caFile}:{}};
 const client=new pg.Client({host,port:Number(u.port||5432),database,user,password,ssl:i.sslMode==='disable'?false:{rejectUnauthorized:true,ca},application_name:'kavosh-recovery',connectionTimeoutMillis:5000,statement_timeout:10000});
 const passwordEntry=[host,u.port||'5432',database,user,password].map(v=>v.replace(/([:\\])/g,'\\$1')).join(':')+'\n';
 return {client,env,database,passwordEntry};
}
// A dedicated database-scoped read-only/BYPASSRLS login is needed for a full dump.
// A web role or an RLS-filtered partial dump must never be called a backup.
export async function assertBackupRole(c:pg.Client){
 const {rows}=await c.query<{safe:boolean}>(`SELECT r.rolcanlogin AND r.rolbypassrls AND NOT r.rolsuper AND NOT r.rolcreatedb AND NOT r.rolcreaterole AND NOT r.rolreplication
 AND NOT EXISTS(SELECT 1 FROM pg_roles x WHERE x.rolname<>current_user AND pg_has_role(current_user,x.oid,'member'))
 AND NOT EXISTS(SELECT 1 FROM pg_database d WHERE d.datname=current_database() AND pg_has_role(current_user,d.datdba,'member'))
 AND NOT EXISTS(SELECT 1 FROM pg_namespace n WHERE n.nspname!~'^pg_' AND n.nspname<>'information_schema' AND(pg_has_role(current_user,n.nspowner,'member') OR NOT has_schema_privilege(current_user,n.oid,'USAGE')))
 AND NOT EXISTS(SELECT 1 FROM pg_class t JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname!~'^pg_' AND n.nspname<>'information_schema' AND t.relkind IN('r','p','v','m','f') AND(pg_has_role(current_user,t.relowner,'member') OR NOT has_table_privilege(current_user,t.oid,'SELECT') OR has_table_privilege(current_user,t.oid,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN') OR has_any_column_privilege(current_user,t.oid,'INSERT,UPDATE,REFERENCES')))
 AND NOT EXISTS(SELECT 1 FROM pg_class t JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname!~'^pg_' AND n.nspname<>'information_schema' AND t.relkind='S' AND NOT has_sequence_privilege(current_user,t.oid,'SELECT'))
 AND NOT EXISTS(SELECT 1 FROM pg_foreign_table)
 AND NOT EXISTS(SELECT 1 FROM pg_proc f JOIN pg_namespace n ON n.oid=f.pronamespace WHERE n.nspname!~'^pg_' AND n.nspname<>'information_schema' AND f.prosecdef AND has_schema_privilege(current_user,n.oid,'USAGE') AND has_function_privilege(current_user,f.oid,'EXECUTE'))
 safe FROM pg_roles r WHERE r.rolname=current_user`);
 if(rows[0]?.safe!==true)throw new RecoveryError('UNSAFE_BACKUP_ROLE');
}
function completed(p:ChildProcessWithoutNullStreams){
 let warning=false,failed=false;p.stderr.on('data',()=>{warning=true;});p.on('error',()=>{failed=true;});
 return new Promise<void>((yes,no)=>p.once('close',code=>code===0&&!warning&&!failed?yes():no(new RecoveryError('RECOVERY_TOOL_FAILED'))));
}
function counter(max:number,hash?:ReturnType<typeof createHash>,onLimit?:(error:RecoveryError)=>void){
 let size=0;return new Transform({transform(chunk:Buffer,_encoding,done){size+=chunk.length;if(size>max){const error=new RecoveryError('RECOVERY_SIZE_LIMIT');onLimit?.(error);return done(error);}hash?.update(chunk);done(null,chunk);}});
}
async function syncFile(p:string){
 const f=await open(p,constants.O_RDWR|constants.O_NOFOLLOW);try{await f.sync();return await f.stat();}finally{await f.close();}
}
async function syncDirectory(p:string){
 const f=await open(p,constants.O_RDONLY);try{await f.sync();}finally{await f.close();}
}
async function passwordFile(p:string,line:string){
 const f=await open(p,'wx',0o600);let success=false;
 try{await f.writeFile(line);success=true;}finally{await f.close();if(!success)await unlink(p).catch(()=>{});}
}
async function encryptedDump(i:z.infer<typeof backupInput>,env:NodeJS.ProcessEnv,snapshot:string,file:string,signal:AbortSignal){
 const hash=createHash('sha256'),f=await open(file,'wx',0o600),children:ChildProcessWithoutNullStreams[]=[],tasks:Promise<unknown>[]=[];let success=false,sizeError:RecoveryError|undefined;
 try{
  const dump=spawn(i.pgDump,['--format=custom','--compress=6','--no-password','--no-tablespaces','--lock-wait-timeout=5000','--snapshot='+snapshot],{env:{...env,PGAPPNAME:'kavosh-backup-dump'},signal});children.push(dump);
  const age=spawn(i.age,['--encrypt','--recipient',i.recipient],{env:{PATH:process.env.PATH,NODE_ENV:process.env.NODE_ENV??'production',LANG:'C'},signal});children.push(age);
  tasks.push(completed(dump),completed(age),pipeline(dump.stdout,age.stdin,{signal}),pipeline(age.stdout,counter(i.maximumBytes,hash,error=>{sizeError=error;}),f.createWriteStream({autoClose:true}),{signal}));await Promise.all(tasks);
  const result={sha256:hash.digest('hex'),bytes:(await syncFile(file)).size};success=true;return result;
 // SIGPIPE/child-close can win Promise.all's rejection race on Linux. Retain
 // the observed byte-limit cause instead of depending on callback ordering.
 }catch(e){if(sizeError)throw sizeError;if(e instanceof RecoveryError)throw e;throw new RecoveryError('RECOVERY_TOOL_FAILED');}
 finally{
  for(const p of children)if(p.exitCode===null&&p.signalCode===null)p.kill('SIGTERM');
  const kill=setTimeout(()=>{for(const p of children)if(p.exitCode===null&&p.signalCode===null)p.kill('SIGKILL');},1000);kill.unref();
  await Promise.allSettled(tasks);clearTimeout(kill);await f.close().catch(()=>{});if(!success)await unlink(file).catch(()=>{});
 }
}
export async function backupDatabase(raw:unknown,externalSignal?:AbortSignal){
 const parsed=backupInput.safeParse(raw);if(!parsed.success)throw new RecoveryError('INVALID_BACKUP_CONFIGURATION');const i=parsed.data;
 if(externalSignal?.aborted)throw new RecoveryError('RECOVERY_CANCELLED');
 let client:pg.Client|undefined,folder:string|undefined,archive:string|undefined,metadata:string|undefined,passwordPath:string|undefined,proofPath:string|undefined,referencePath:string|undefined,referenceArchivePath:string|undefined,succeeded=false,folderOwned=false,archiveOwned=false,metadataOwned=false,passwordOwned=false,proofOwned=false,referenceOwned=false,referenceArchiveOwned=false;
 try{
  await privateDirectory(i.workDirectory);const c=await connection(i);client=c.client;await client.connect();await assertBackupRole(client);
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  if(!(await client.query<{ok:boolean}>('SELECT pg_try_advisory_xact_lock_shared(742061) ok')).rows[0].ok)throw new RecoveryError('BACKUP_MIGRATION_BUSY');
  const state=(await client.query<{revision:number;snapshot:string;server_major:number}>("SELECT public.schema_revision() revision,pg_export_snapshot() snapshot,(current_setting('server_version_num')::integer/10000)::integer server_major")).rows[0];
  if(!Number.isInteger(state.revision)||state.revision<expectedSchemaRevision)throw new RecoveryError('BACKUP_SCHEMA_NOT_CURRENT');
  const id=randomUUID(),createdAt=new Date().toISOString();folder=join(i.workDirectory,'backup-'+id);await mkdir(folder,{mode:0o700});folderOwned=true;archive=join(folder,'database.dump.age');metadata=join(folder,'manifest.json');
  passwordPath=join(folder,'connection.pgpass');await passwordFile(passwordPath,c.passwordEntry);passwordOwned=true;
  const timeout=AbortSignal.timeout(i.timeoutMs),signal=externalSignal?AbortSignal.any([timeout,externalSignal]):timeout,result=await encryptedDump(i,{...c.env,PGPASSFILE:passwordPath},state.snapshot,archive,signal);
  archiveOwned=true;await unlink(passwordPath);passwordOwned=false;
  const verification=i.verificationSnapshot?{archiveSha256:result.sha256,snapshot:await databaseVerificationSnapshot(client,signal)}:null;
  let mediaReferencePlan=null;
  if(i.mediaReferenceSnapshot){referencePath=join(folder,'media-references.jsonl');const plan=await open(referencePath,'wx',0o600);referenceOwned=true;try{mediaReferencePlan={filename:'media-references.jsonl' as const,...await captureMediaReferencePlan(client,plan,{databaseBackupId:id,archiveSha256:result.sha256,schemaRevision:state.revision},signal)};}finally{await plan.close();}}
  await client.query('COMMIT');
  let verificationArchive=null;
  if(verification){proofPath=join(folder,'verification.json.age');verificationArchive={filename:'verification.json.age' as const,...await encryptVerification(i,verification,proofPath,signal)};proofOwned=true;}
  let mediaReferenceArchive=null;
  if(mediaReferencePlan&&referencePath){referenceArchivePath=join(folder,'media-references.jsonl.age');mediaReferenceArchive={filename:'media-references.jsonl.age' as const,...await encryptRecoveryStream({age:i.age,recipient:i.recipient,file:referenceArchivePath,maximumBytes:mediaReferencePlan.plaintextBytes+Math.ceil(mediaReferencePlan.plaintextBytes/65536)*16+65536},createReadStream(referencePath),signal)};referenceArchiveOwned=true;}
  const manifest={format:'kavosh-database-backup-v1',scope:'database_schema_and_data',id,createdAt,schemaRevision:state.revision,serverMajor:state.server_major,ciphertextSha256:result.sha256,encryptedBytes:result.bytes,completeDatabase:true,databaseConfigurationIncluded:false,rolesIncluded:false,mediaIncluded:false,restoreVerified:false,independentCopyVerified:false,verification,verificationArchive,mediaReferencePlan,mediaReferenceArchive};
  const f=await open(metadata,'wx',0o600);metadataOwned=true;try{await f.writeFile(JSON.stringify(manifest)+'\n');await f.sync();}finally{await f.close();}
  await syncDirectory(folder);await syncDirectory(i.workDirectory);
  succeeded=true;return {...manifest,archivePath:archive};
 }catch(e){if(e instanceof RecoveryError)throw e;throw new RecoveryError('DATABASE_BACKUP_FAILED');}
 finally{
  if(client){await client.query('ROLLBACK').catch(()=>{});await client.end().catch(()=>{});}
  if(passwordOwned&&passwordPath)await unlink(passwordPath).catch(()=>{});
  if(!succeeded){if(archiveOwned&&archive)await unlink(archive).catch(()=>{});if(proofOwned&&proofPath)await unlink(proofPath).catch(()=>{});if(referenceOwned&&referencePath)await unlink(referencePath).catch(()=>{});if(referenceArchiveOwned&&referenceArchivePath)await unlink(referenceArchivePath).catch(()=>{});if(metadataOwned&&metadata)await unlink(metadata).catch(()=>{});if(folderOwned&&folder)await rmdir(folder).catch(()=>{});}
 }
}
// A separate standard age archive keeps the small exact-snapshot proof usable
// after host loss. Its plaintext is never written to disk by the backup job.
async function encryptVerification(i:z.infer<typeof backupInput>,value:z.infer<typeof backupVerification>,file:string,signal:AbortSignal){
 const bytes=Buffer.from(JSON.stringify(value));if(bytes.length>2097152)throw new RecoveryError('VERIFICATION_SIZE_LIMIT');
 try{return await encryptRecoveryStream({age:i.age,recipient:i.recipient,file,maximumBytes:4194304},Readable.from([bytes]),signal);}finally{bytes.fill(0);}
}
// Shared streaming encryption for verification companions and media objects.
// Only ciphertext is written;exclusive creation never replaces an old archive.
export async function encryptRecoveryStream(raw:unknown,source:Readable,signal:AbortSignal){
 const parsed=z.object({age:path,recipient:backupInput.shape.recipient,file:path,maximumBytes:z.number().int().min(22).max(1099511627776)}).strict().safeParse(raw);
 if(!parsed.success||!(source instanceof Readable))throw new RecoveryError('INVALID_STREAM_BACKUP_CONFIGURATION');
 if(signal.aborted)throw new RecoveryError('RECOVERY_CANCELLED');
 const i=parsed.data,file=i.file;await privateDirectory(dirname(file));
 const output=await open(file,'wx',0o600),hash=createHash('sha256'),tasks:Promise<unknown>[]=[];let child:ChildProcessWithoutNullStreams|undefined,success=false,sizeError:RecoveryError|undefined;
 try{
  child=spawn(i.age,['--encrypt','--recipient',i.recipient],{env:{PATH:process.env.PATH,NODE_ENV:process.env.NODE_ENV??'production',LANG:'C'},signal});
  tasks.push(completed(child),pipeline(source,child.stdin,{signal}),pipeline(child.stdout,counter(i.maximumBytes,hash,error=>{sizeError=error;}),output.createWriteStream({autoClose:true}),{signal}));
  await Promise.all(tasks);const result={ciphertextSha256:hash.digest('hex'),encryptedBytes:(await syncFile(file)).size};success=true;return result;
 }catch(error){if(sizeError)throw sizeError;if(error instanceof RecoveryError)throw error;throw new RecoveryError(signal.aborted?'RECOVERY_CANCELLED':'STREAM_BACKUP_FAILED');
 }finally{
  if(child&&child.exitCode===null&&child.signalCode===null)child.kill('SIGTERM');
  const kill=setTimeout(()=>{if(child&&child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');},1000);kill.unref();
  await Promise.allSettled(tasks);clearTimeout(kill);await output.close().catch(()=>{});if(!success)await unlink(file).catch(()=>{});
 }
}
// The caller authenticates ciphertext first. Bounded catalogs need parsing;
// exact object recovery additionally requires its recorded source length/hash.
export async function decryptRecoveryStream(raw:unknown,source:Readable,signal:AbortSignal){
 const base=z.object({age:path,identityFile:path,file:path}),parsed=z.union([base.extend({expectedBytes:z.number().int().positive().max(4294967296),expectedSha256:z.string().regex(/^[a-f0-9]{64}$/)}).strict(),base.extend({maximumBytes:z.number().int().positive().max(1073741824)}).strict()]).safeParse(raw);
 if(!parsed.success||!(source instanceof Readable))throw new RecoveryError('INVALID_STREAM_RECOVERY_CONFIGURATION');if(signal.aborted)throw new RecoveryError('RECOVERY_CANCELLED');
 const i=parsed.data;await privateDirectory(dirname(i.file));await nativeRecoveryIdentity(i.identityFile);
 const output=await open(i.file,'wx',0o600),hash=createHash('sha256'),tasks:Promise<unknown>[]=[];let child:ChildProcessWithoutNullStreams|undefined,success=false,sizeError:RecoveryError|undefined;
 try{
  child=spawn(i.age,['--decrypt','--identity',i.identityFile],{env:{PATH:process.env.PATH,NODE_ENV:process.env.NODE_ENV??'production',LANG:'C'},signal});
  tasks.push(completed(child),pipeline(source,child.stdin,{signal}),pipeline(child.stdout,counter('expectedBytes'in i?i.expectedBytes:i.maximumBytes,hash,error=>{sizeError=error;}),output.createWriteStream({autoClose:true}),{signal}));await Promise.all(tasks);
  const bytes=(await syncFile(i.file)).size,sha256=hash.digest('hex');if('expectedBytes'in i&&(bytes!==i.expectedBytes||sha256!==i.expectedSha256))throw new RecoveryError('RECOVERED_MEDIA_CONTENT_MISMATCH');success=true;return{bytes,sha256};
 }catch(error){if(sizeError)throw sizeError;if(error instanceof RecoveryError)throw error;throw new RecoveryError(signal.aborted?'RECOVERY_CANCELLED':'STREAM_RECOVERY_FAILED');}
 finally{
  if(child&&child.exitCode===null&&child.signalCode===null)child.kill('SIGTERM');const kill=setTimeout(()=>{if(child&&child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');},1000);kill.unref();await Promise.allSettled(tasks);clearTimeout(kill);await output.close().catch(()=>{});if(!success)await unlink(i.file).catch(()=>{});
 }
}
export async function restoreDatabaseBackup(raw:unknown,externalSignal?:AbortSignal){
 const parsed=restoreInput.safeParse(raw);if(!parsed.success)throw new RecoveryError('INVALID_RESTORE_CONFIGURATION');const i=parsed.data;
 if(i.expectedVerification&&(i.expectedVerification.archiveSha256!==i.expectedSha256||i.expectedVerification.snapshot.schemaRevision!==i.expectedRevision))throw new RecoveryError('INVALID_RESTORE_VERIFICATION');
 if(externalSignal?.aborted)throw new RecoveryError('RECOVERY_CANCELLED');
 let client:pg.Client|undefined,folder:string|undefined,ciphertext:string|undefined,plaintext:string|undefined,passwordPath:string|undefined,folderOwned=false,ciphertextOwned=false,plaintextOwned=false,passwordOwned=false;
 try{
  await privateDirectory(i.workDirectory);await regularFile(i.archive);await nativeRecoveryIdentity(i.identityFile);
  const c=await connection(i);client=c.client;
  if(!/^kavosh_recovery_[a-z0-9_]{1,47}$/.test(c.database)||i.confirmation!=='RESTORE:'+c.database)throw new RecoveryError('ISOLATED_RESTORE_TARGET_REQUIRED');
  await client.connect();
  if(!(await client.query<{ok:boolean}>('SELECT rolsuper ok FROM pg_roles WHERE rolname=current_user')).rows[0]?.ok)throw new RecoveryError('OFFLINE_RESTORE_ADMIN_REQUIRED');
  if(!(await client.query<{ok:boolean}>('SELECT pg_try_advisory_lock(742062) ok')).rows[0]?.ok)throw new RecoveryError('RESTORE_TARGET_BUSY');
  const empty=()=>client!.query<{empty:boolean}>(`SELECT NOT EXISTS(SELECT 1 FROM pg_namespace WHERE nspname NOT IN('public','information_schema') AND nspname!~'^pg_') AND NOT EXISTS(SELECT 1 FROM pg_class t JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname='public') AND NOT EXISTS(SELECT 1 FROM pg_proc f JOIN pg_namespace n ON n.oid=f.pronamespace WHERE n.nspname='public') AND NOT EXISTS(SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname='public') AND NOT EXISTS(SELECT 1 FROM pg_extension WHERE extname<>'plpgsql') empty`);
  if(!(await empty()).rows[0].empty)throw new RecoveryError('EMPTY_RESTORE_TARGET_REQUIRED');
  const ordinaryClients=()=>client!.query<{n:number}>("SELECT count(*)::integer n FROM pg_stat_activity a JOIN pg_roles r ON r.rolname=a.usename WHERE a.datname=current_database() AND a.backend_type='client backend' AND NOT r.rolsuper");
  if((await ordinaryClients()).rows[0].n!==0)throw new RecoveryError('RESTORE_TARGET_IN_USE');
  // This explicitly named empty recovery database remains quarantined.
  // Offline administrators may inspect it;ordinary app/worker logins cannot
  // reconnect and replay old jobs before privacy/session/outbox reconciliation.
  await client.query('ALTER DATABASE "'+c.database+'" CONNECTION LIMIT 0');
  if((await ordinaryClients()).rows[0].n!==0)throw new RecoveryError('RESTORE_TARGET_IN_USE');
  folder=join(i.workDirectory,'restore-'+randomUUID());await mkdir(folder,{mode:0o700});folderOwned=true;ciphertext=join(folder,'source.age');plaintext=join(folder,'database.dump');
  // Stage a private immutable-to-other-users ciphertext copy. The trusted
  // digest comes from the operator's independent record,NOT its manifest.
  const input=await open(i.archive,constants.O_RDONLY|constants.O_NOFOLLOW),hash=createHash('sha256');
  try{const encrypted=await open(ciphertext,'wx',0o600);ciphertextOwned=true;try{await pipeline(input.createReadStream({autoClose:true}),counter(i.maximumBytes,hash),encrypted.createWriteStream({autoClose:true}));await syncFile(ciphertext);}finally{await encrypted.close().catch(()=>{});}}finally{await input.close().catch(()=>{});}
  if(hash.digest('hex')!==i.expectedSha256)throw new RecoveryError('BACKUP_DIGEST_MISMATCH');
  const timeout=AbortSignal.timeout(i.timeoutMs),signal=externalSignal?AbortSignal.any([timeout,externalSignal]):timeout,clear=await open(plaintext,'wx',0o600),age=spawn(i.age,['--decrypt','--identity',i.identityFile,ciphertext],{env:{PATH:process.env.PATH,NODE_ENV:process.env.NODE_ENV??'production',LANG:'C'},signal});
  plaintextOwned=true;
  try{await Promise.all([completed(age),pipeline(age.stdout,counter(i.maximumBytes),clear.createWriteStream({autoClose:true}),{signal})]);await syncFile(plaintext);}
  finally{if(age.exitCode===null&&!age.killed)age.kill('SIGTERM');await clear.close().catch(()=>{});}
  // Authenticate the ENTIRE age file before executing any restored SQL.
  // No --clean,--create,--no-owner or --no-acl:never overwrite data or discard
  // source RLS/ownership/grants. Missing global roles fail instead of weakening.
  if(!(await empty()).rows[0].empty)throw new RecoveryError('EMPTY_RESTORE_TARGET_REQUIRED');
  passwordPath=join(folder,'connection.pgpass');await passwordFile(passwordPath,c.passwordEntry);passwordOwned=true;
  const restore=spawn(i.pgRestore,['--single-transaction','--exit-on-error','--no-password','--no-tablespaces','--dbname',c.database,plaintext],{env:{...c.env,PGPASSFILE:passwordPath},signal});
  restore.stdin.end();restore.stdout.resume();try{await completed(restore);}finally{if(restore.exitCode===null&&!restore.killed)restore.kill('SIGTERM');}
  const revision=(await client.query<{revision:number}>('SELECT public.schema_revision() revision')).rows[0]?.revision;
  if(revision!==i.expectedRevision)throw new RecoveryError('RESTORED_SCHEMA_MISMATCH');
  if(i.expectedVerification){
   await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
   const actual=await databaseVerificationSnapshot(client,signal);
   if(!isDeepStrictEqual(actual,i.expectedVerification.snapshot))throw new RecoveryError('RESTORED_SNAPSHOT_MISMATCH');
   await client.query('COMMIT');
  }
  return {restored:true,verifiedSchemaRevision:revision,archiveSha256:i.expectedSha256,backupSnapshotVerified:!!i.expectedVerification,sequenceValuesVerified:false,applicationActivationAllowed:false,ordinaryClientConnectionsBlocked:true,requiresPrivacyAndOutboxReconciliation:true,rolesRestored:false,mediaRestored:false};
 }catch(e){if(e instanceof RecoveryError)throw e;throw new RecoveryError('DATABASE_RESTORE_FAILED');}
 finally{
  await client?.end().catch(()=>{});
  if(passwordOwned&&passwordPath)await unlink(passwordPath).catch(()=>{});
  if(plaintextOwned&&plaintext)await unlink(plaintext).catch(()=>{});if(ciphertextOwned&&ciphertext)await unlink(ciphertext).catch(()=>{});if(folderOwned&&folder)await rmdir(folder).catch(()=>{});
 }
}
