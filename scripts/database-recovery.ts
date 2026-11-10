import { backupDatabase,restoreDatabaseBackup,RecoveryError } from '../src/operations/database-backups.ts';

// Deliberately offline operator tooling,not a web/admin/bot endpoint.
// Database credentials and the private decryption key never enter arguments.
const controller=new AbortController();
const cancel=()=>controller.abort();process.once('SIGTERM',cancel);process.once('SIGINT',cancel);
try{
 const [action,...args]=process.argv.slice(2);
 if(action==='--help'){
  console.log('backup: BACKUP_DATABASE_URL,BACKUP_AGE_RECIPIENT,RECOVERY_WORK_DIRECTORY,AGE_BIN,PG_DUMP_BIN');
  console.log('restore ARCHIVE TRUSTED_SHA256 EXPECTED_REVISION RESTORE:kavosh_recovery_NAME: RESTORE_DATABASE_URL,RESTORE_AGE_IDENTITY_FILE,RECOVERY_WORK_DIRECTORY,AGE_BIN,PG_RESTORE_BIN');
  console.log('TLS defaults to verify-full with RECOVERY_DATABASE_CA_FILE. Disable is allowed only for non-production loopback tests.');
  console.log('Backup login: direct database-scoped schema USAGE/table+sequence SELECT,BYPASSRLS and EXECUTE on public.schema_revision();no ownership,writes,role memberships or privileged-function access. Limit this login to the source database in server authentication rules.');
  console.log('Restore accepts only an empty isolated kavosh_recovery_ database. Preserve the trusted digest independently. Global role provisioning,media recovery,privacy/deletion and job/outbox reconciliation remain required before activation.');
  console.log('Restore requires an offline database superuser,refuses active ordinary clients,and leaves CONNECTION LIMIT 0 in place. It never reopens app or worker access.');
 }else{
  const common={age:process.env.AGE_BIN,workDirectory:process.env.RECOVERY_WORK_DIRECTORY,sslMode:process.env.RECOVERY_DATABASE_SSL_MODE??'verify-full',caFile:process.env.RECOVERY_DATABASE_CA_FILE};
  if(action==='backup'&&args.length===0)console.log(JSON.stringify(await backupDatabase({...common,databaseUrl:process.env.BACKUP_DATABASE_URL,pgDump:process.env.PG_DUMP_BIN,recipient:process.env.BACKUP_AGE_RECIPIENT},controller.signal)));
  else if(action==='restore'&&args.length===4)console.log(JSON.stringify(await restoreDatabaseBackup({...common,databaseUrl:process.env.RESTORE_DATABASE_URL,pgRestore:process.env.PG_RESTORE_BIN,identityFile:process.env.RESTORE_AGE_IDENTITY_FILE,archive:args[0],expectedSha256:args[1],expectedRevision:Number(args[2]),confirmation:args[3]},controller.signal)));
  else throw new RecoveryError('INVALID_RECOVERY_COMMAND');
 }
}catch(e){console.error(e instanceof RecoveryError?e.code:'DATABASE_RECOVERY_FAILED');process.exitCode=1;}
finally{process.off('SIGTERM',cancel);process.off('SIGINT',cancel);}
