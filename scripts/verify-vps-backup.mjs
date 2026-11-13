// Owner-authorized, isolated restore acceptance. No production SQL is restored
// over the source database; the private age key never reaches the VPS.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, chmodSync, openSync, closeSync, readFileSync,writeFileSync, unlinkSync, rmdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
const key = '/Users/peymanyousefi/Documents/Codex/2026-09-03/linkedin-plugin-app-69949aa62bf48191be5e57a01202beca-openai-curated/work/github-handoff-2026-09-11/kavosh-vps-admin';
const known = key.slice(0, key.lastIndexOf('/')) + '/known_hosts';
const ssh = ['-i', key, '-o', 'UserKnownHostsFile=' + known, '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=10', 'ubuntu@148.113.194.110'];
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
const remote = (command, options = {}) => execFileSync('/usr/bin/ssh', [...ssh, command], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000, maxBuffer: 3145728, ...options });
const sql = (database, statement) => remote('sudo -u postgres psql -X -At -v ON_ERROR_STOP=1 -d ' + database + ' -c ' + quote(statement)).toString().trim();
const get = service => execFileSync('/usr/bin/security', ['find-generic-password', '-a', 'kavosh-one', '-s', service, '-w'], { stdio: ['ignore', 'pipe', 'pipe'] });
function restoredSnapshot(database){
 assert.match(database,/^kavosh_recovery_[a-f0-9]{32}$/);
 const code=`import assert from 'node:assert/strict';
import pg from '/srv/kavosh-one/current/node_modules/pg/lib/index.js';
import {databaseVerificationSnapshot} from '/srv/kavosh-one/current/.recovery-tool/src/operations/database-verification.js';
const database=${JSON.stringify(database)},c=new pg.Client({host:'/var/run/postgresql',user:'postgres',database,ssl:false,connectionTimeoutMillis:5000,statement_timeout:30000});
try{await c.connect();await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');const r=await c.query('SELECT current_database() name,datconnlimit FROM pg_database WHERE datname=current_database()');assert.equal(r.rows[0].name,database);assert.equal(r.rows[0].datconnlimit,0);console.log(JSON.stringify(await databaseVerificationSnapshot(c,AbortSignal.timeout(45000))));}finally{await c.query('ROLLBACK').catch(()=>{});await c.end();}`;
 return JSON.parse(remote('sudo -u postgres /usr/bin/node --input-type=module -e '+quote(code)).toString());
}
let stage = 'configuration', directory, encrypted, plaintext, proofEncrypted,proofPlaintext,target, created = false, cleanupFailed = false;
try {
 assert.equal(process.platform, 'darwin');const args=process.argv.slice(2);assert.ok(args.length===1||args.length===2);assert.ok(['--execute','--verify-cluster-baseline'].includes(args[0]));const verifyOnly=args[0]==='--verify-cluster-baseline',selected=args[1];if(verifyOnly)assert.ok(selected);if(selected!==undefined)assert.match(selected,/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);process.umask(0o077);
 stage = 'private backup receipt'; const receipt = JSON.parse(remote('sudo -u kavosh-one-backup cat /var/lib/kavosh-one-backups/'+(selected?'backup-'+selected+'/delivery-status.json':'latest.json')).toString());
 if(selected)assert.equal(receipt.localBackup?.id,selected);
 const backup = receipt.localBackup; assert.match(backup.id, /^[a-f0-9-]{36}$/); assert.match(backup.ciphertextSha256, /^[a-f0-9]{64}$/); assert.equal(receipt.offsiteCopy.independentCopyVerified, true); assert.equal(receipt.offsiteCopy.ciphertextSha256, backup.ciphertextSha256); assert.equal(backup.serverMajor, 18);
 const companion=backup.verificationArchive;
 assert.equal(receipt.snapshotBaselineOffsiteVerified,true);assert.equal(receipt.verificationOffsiteCopy?.independentCopyVerified,true);assert.equal(companion?.filename,'verification.json.age');assert.match(companion.ciphertextSha256,/^[a-f0-9]{64}$/);assert.equal(receipt.verificationOffsiteCopy.ciphertextSha256,companion.ciphertextSha256);
 assert.ok(Number.isSafeInteger(backup.encryptedBytes)&&backup.encryptedBytes>=22&&backup.encryptedBytes<=268435456);assert.ok(Number.isSafeInteger(companion.encryptedBytes)&&companion.encryptedBytes>=22&&companion.encryptedBytes<=4194304);
 stage = 'Keychain connection'; let drive, recovery;
 for (const [service, assign] of [['kavosh-one-drive-backup-connection', v => { drive = v; }], ['kavosh-one-production-backup-recovery', v => { recovery = v; }]]) { const bytes = get(service); try { assign(JSON.parse(bytes.toString())); } finally { bytes.fill(0); } }
 assert.equal(drive.token.scope, 'https://www.googleapis.com/auth/drive.file');
 directory = mkdtempSync('/private/tmp/kavosh-one-restore-'); chmodSync(directory, 0o700); encrypted = join(directory, 'database.dump.age'); plaintext = join(directory, 'database.dump');proofEncrypted=join(directory,'verification.json.age');proofPlaintext=join(directory,'verification.json');
 stage = 'independent Drive download';
 for(const [filename,path,bytes,digest]of [['database.dump.age',encrypted,backup.encryptedBytes,backup.ciphertextSha256],['verification.json.age',proofEncrypted,companion.encryptedBytes,companion.ciphertextSha256]]){
  // rclone refuses size filters with a single-file copyto. Bounded cat is
  // read-only and terminates an oversized object before it can fill the disk.
  const content=execFileSync('/opt/homebrew/bin/rclone', ['cat', 'kavosh_backup:backup-' + backup.id + '/'+filename, '--config', '/dev/null', '--log-level', 'ERROR', '--stats', '0', '--retries', '1', '--low-level-retries', '1'], { env: { PATH: process.env.PATH, RCLONE_CONFIG_KAVOSH_BACKUP_TYPE: 'drive', RCLONE_CONFIG_KAVOSH_BACKUP_SCOPE: 'drive.file', RCLONE_CONFIG_KAVOSH_BACKUP_ROOT_FOLDER_ID: drive.folderId, RCLONE_CONFIG_KAVOSH_BACKUP_CLIENT_ID: drive.clientId, RCLONE_CONFIG_KAVOSH_BACKUP_CLIENT_SECRET: drive.clientSecret, RCLONE_CONFIG_KAVOSH_BACKUP_TOKEN: JSON.stringify(drive.token) }, stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000,maxBuffer:bytes });
  try{assert.equal(content.length,bytes);assert.equal(createHash('sha256').update(content).digest('hex'),digest);writeFileSync(path,content,{flag:'wx',mode:0o600});}finally{content.fill(0);}
 }
 stage = 'complete authenticated age decryption off-server';
 try{for(const [cipher,path]of [[encrypted,plaintext],[proofEncrypted,proofPlaintext]]){const clear=openSync(path,'wx',0o600);try{execFileSync('/opt/homebrew/bin/age',['--decrypt','--identity','-',cipher],{input:recovery.identity,stdio:['pipe',clear,'pipe'],timeout:30000});}finally{closeSync(clear);}}}finally{recovery.identity='';}
 // No restored SQL is executed until the entire age file authenticates.
 stage='authenticated original snapshot baseline';assert.ok(statSync(proofPlaintext).size<=2097152);const verification=JSON.parse(readFileSync(proofPlaintext,'utf8'));assert.equal(verification.archiveSha256,backup.ciphertextSha256);assert.equal(verification.snapshot.schemaRevision,backup.schemaRevision);assert.equal(verification.snapshot.format,'kavosh-database-verification-v1');assert.deepEqual(verification,backup.verification);const source=verification.snapshot;
 if(verifyOnly){
  stage='authenticated cluster baseline';const cluster=verification.cluster;assert.ok(cluster);assert.equal(cluster.databaseAccess?.rows,1);assert.ok(Number.isSafeInteger(cluster.globalRoleProperties?.rows)&&cluster.globalRoleProperties.rows>0);for(const fingerprint of [cluster.databaseAccess,cluster.globalRoleProperties])assert.match(fingerprint.sha256,/^[a-f0-9]{64}$/);
  console.log(JSON.stringify({backupId:backup.id,ciphertextSha256:backup.ciphertextSha256,encryptedBytes:backup.encryptedBytes,sourceSchemaRevision:source.schemaRevision,independentDriveDownloadVerified:true,independentEncryptedCompanionDownloadVerified:true,authenticatedOffServerDecryptionVerified:true,exactSnapshotClusterBaselineAuthenticated:true,databaseAccessBaselineRows:cluster.databaseAccess.rows,globalRoleBaselineRows:cluster.globalRoleProperties.rows,sourceDatabaseRestoreCommandsIssued:0,actualIsolatedPostgresRestoreVerified:false,privateRecoveryKeyTransferredToVps:false,fullServerRebuildVerified:false}));
 }else{
 stage = 'new isolated recovery database'; target = 'kavosh_recovery_' + randomUUID().replaceAll('-', '');
 sql('postgres', 'CREATE DATABASE "' + target + '" CONNECTION LIMIT 0;'); created = true;
 stage = 'native PostgreSQL restore with original ownership and ACLs'; const input = openSync(plaintext, 'r');
 try { const result = spawnSync('/usr/bin/ssh', [...ssh, 'sudo -u postgres pg_restore --single-transaction --exit-on-error --no-password --no-tablespaces --dbname=' + target], { stdio: [input, 'pipe', 'pipe'], timeout: 60000, maxBuffer: 1048576 }); assert.equal(result.status, 0, 'Isolated pg_restore failed; raw diagnostics suppressed.'); } finally { closeSync(input); }
 stage = 'data, functions, permissions and row-policy comparison'; const restored = restoredSnapshot(target);
 if(JSON.stringify(restored)!==JSON.stringify(source))console.error('RESTORE_COMPARISON_MISMATCH');
 assert.deepEqual(restored, source);
 assert.equal(sql('postgres', "SELECT datconnlimit FROM pg_database WHERE datname='" + target + "';"), '0');
 console.log(JSON.stringify({ backupId: backup.id, ciphertextSha256: backup.ciphertextSha256, encryptedBytes: backup.encryptedBytes, sourceSchemaRevision: source.schemaRevision, permanentTablesCompared: source.tables.length, rowsCompared: source.tables.reduce((n,t)=>n+t.fingerprint.rows,0), originalDataPermissionsFunctionsAndPoliciesMatch: true, originalExportedSnapshotMatched:true, independentDriveDownloadVerified: true, independentEncryptedCompanionDownloadVerified:true,actualIsolatedPostgresRestoreVerified: true, sourceDatabaseRestoreCommandsIssued:0,privateRecoveryKeyTransferredToVps: false, recoveredDatabaseOrdinaryConnectionsBlocked: true, globalRoleRecoveryVerified: false,sequenceValuesRecoveryVerified:false, mediaRecoveryVerified: false }));
 }
} catch(error) {
 const diagnostic=String(error?.stderr??''),reason=/invalid_grant|invalid_client|unauthorized|invalid authentication|401/i.test(diagnostic)?'authentication':/not found|directory not found|404/i.test(diagnostic)?'not_found':/permission|forbidden|403/i.test(diagnostic)?'permission':error?.code==='ERR_ASSERTION'?'integrity_or_contract':error?.code==='ENOENT'?'local_tool_missing':'unclassified';
 console.error('VPS_RESTORE_ACCEPTANCE_FAILED: '+stage+' ['+reason+']');process.exitCode=1;
}
finally {
 if (created && target) try { sql('postgres', 'DROP DATABASE "' + target + '";'); } catch { cleanupFailed = true; }
 for (const file of [plaintext, encrypted,proofPlaintext,proofEncrypted]) if (file) try { unlinkSync(file); } catch (error) { if (error.code !== 'ENOENT') cleanupFailed = true; }
 if (directory) try { rmdirSync(directory); } catch { cleanupFailed = true; }
 if (cleanupFailed) { console.error('RESTORE_TEST_CLEANUP_REQUIRED'); process.exitCode = 1; }
}
