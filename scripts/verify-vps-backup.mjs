// Owner-authorized, isolated restore acceptance. No production SQL is restored
// over the source database; the private age key never reaches the VPS.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, chmodSync, openSync, closeSync, readFileSync, unlinkSync, rmdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
const key = '/Users/peymanyousefi/Documents/Codex/2026-09-03/linkedin-plugin-app-69949aa62bf48191be5e57a01202beca-openai-curated/work/github-handoff-2026-09-11/kavosh-vps-admin';
const known = key.slice(0, key.lastIndexOf('/')) + '/known_hosts';
const ssh = ['-i', key, '-o', 'UserKnownHostsFile=' + known, '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=10', 'ubuntu@148.113.194.110'];
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
const remote = (command, options = {}) => execFileSync('/usr/bin/ssh', [...ssh, command], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000, maxBuffer: 1048576, ...options });
const sql = (database, statement) => remote('sudo -u postgres psql -X -At -v ON_ERROR_STOP=1 -d ' + database + ' -c ' + quote(statement)).toString().trim();
const get = service => execFileSync('/usr/bin/security', ['find-generic-password', '-a', 'kavosh-one', '-s', service, '-w'], { stdio: ['ignore', 'pipe', 'pipe'] });
const snapshotSql = `CREATE TEMP TABLE restore_row_checks(name text,n bigint,h text);
DO $check$ DECLARE r record; BEGIN FOR r IN SELECT s.nspname,c.relname FROM pg_class c JOIN pg_namespace s ON s.oid=c.relnamespace WHERE s.nspname IN('public','identity','auth_private','platform_private') AND c.relkind IN('r','p') ORDER BY s.nspname,c.relname LOOP
EXECUTE format('INSERT INTO pg_temp.restore_row_checks SELECT %L,count(*),md5(coalesce(string_agg(row_to_json(t)::text,chr(10) ORDER BY row_to_json(t)::text),'''')) FROM %I.%I t',r.nspname||'.'||r.relname,r.nspname,r.relname); END LOOP; END $check$;
SELECT jsonb_build_object('revision',public.schema_revision(),
'rows',(SELECT md5(jsonb_agg(to_jsonb(t) ORDER BY name)::text) FROM pg_temp.restore_row_checks t),
'tableCount',(SELECT count(*) FROM pg_temp.restore_row_checks),'rowCount',(SELECT sum(n) FROM pg_temp.restore_row_checks),
'relations',(SELECT md5(jsonb_agg(to_jsonb(t) ORDER BY nspname,relname)::text) FROM (SELECT n.nspname,c.relname,c.relkind,c.relrowsecurity,c.relforcerowsecurity,pg_get_userbyid(c.relowner) owner,c.relacl::text,c.reloptions FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN('public','identity','auth_private','platform_private')) t),
'functions',(SELECT md5(jsonb_agg(to_jsonb(t) ORDER BY nspname,signature)::text) FROM (SELECT n.nspname,p.oid::regprocedure::text signature,pg_get_userbyid(p.proowner) owner,p.prosecdef,p.proacl::text,p.proconfig,pg_get_functiondef(p.oid) definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN('public','identity','auth_private','platform_private') AND p.prokind IN('f','p')) t),
'policies',(SELECT md5(jsonb_agg(to_jsonb(t) ORDER BY schemaname,tablename,policyname)::text) FROM pg_policies t WHERE schemaname IN('public','identity','auth_private','platform_private')));`;
let stage = 'configuration', directory, encrypted, plaintext, target, created = false, cleanupFailed = false;
try {
 assert.equal(process.platform, 'darwin'); assert.deepEqual(process.argv.slice(2), ['--execute']); process.umask(0o077);
 stage = 'private backup receipt'; const receipt = JSON.parse(remote('sudo -u kavosh-one-backup cat /var/lib/kavosh-one-backups/latest.json').toString());
 const backup = receipt.localBackup; assert.match(backup.id, /^[a-f0-9-]{36}$/); assert.match(backup.ciphertextSha256, /^[a-f0-9]{64}$/); assert.equal(receipt.offsiteCopy.independentCopyVerified, true); assert.equal(receipt.offsiteCopy.ciphertextSha256, backup.ciphertextSha256); assert.equal(backup.serverMajor, 18);
 stage = 'Keychain connection'; let drive, recovery;
 for (const [service, assign] of [['kavosh-one-drive-backup-connection', v => { drive = v; }], ['kavosh-one-production-backup-recovery', v => { recovery = v; }]]) { const bytes = get(service); try { assign(JSON.parse(bytes.toString())); } finally { bytes.fill(0); } }
 assert.equal(drive.token.scope, 'https://www.googleapis.com/auth/drive.file');
 directory = mkdtempSync('/private/tmp/kavosh-one-restore-'); chmodSync(directory, 0o700); encrypted = join(directory, 'database.dump.age'); plaintext = join(directory, 'database.dump');
 stage = 'independent Drive download';
 execFileSync('/opt/homebrew/bin/rclone', ['copyto', 'kavosh_backup:backup-' + backup.id + '/database.dump.age', encrypted, '--config', '/dev/null', '--immutable', '--log-level', 'ERROR', '--stats', '0', '--retries', '1', '--low-level-retries', '1'], { env: { PATH: process.env.PATH, RCLONE_CONFIG_KAVOSH_BACKUP_TYPE: 'drive', RCLONE_CONFIG_KAVOSH_BACKUP_SCOPE: 'drive.file', RCLONE_CONFIG_KAVOSH_BACKUP_ROOT_FOLDER_ID: drive.folderId, RCLONE_CONFIG_KAVOSH_BACKUP_CLIENT_ID: drive.clientId, RCLONE_CONFIG_KAVOSH_BACKUP_CLIENT_SECRET: drive.clientSecret, RCLONE_CONFIG_KAVOSH_BACKUP_TOKEN: JSON.stringify(drive.token) }, stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000 });
 assert.equal(statSync(encrypted).size, backup.encryptedBytes); assert.ok(backup.encryptedBytes <= 268435456, 'Bound this explicit proof to 256 MiB; large restores need a streamed operator workflow.');
 assert.equal(createHash('sha256').update(readFileSync(encrypted)).digest('hex'), backup.ciphertextSha256);
 stage = 'complete authenticated age decryption off-server'; const clear = openSync(plaintext, 'wx', 0o600);
 try { execFileSync('/opt/homebrew/bin/age', ['--decrypt', '--identity', '-', encrypted], { input: recovery.identity, stdio: ['pipe', clear, 'pipe'], timeout: 30000 }); } finally { closeSync(clear); recovery.identity = ''; }
 // No restored SQL is executed until the entire age file authenticates.
 stage = 'source state capture'; const source = JSON.parse(sql('kavosh_one', snapshotSql).split('\n').at(-1));
 stage = 'new isolated recovery database'; target = 'kavosh_recovery_' + randomUUID().replaceAll('-', '');
 sql('postgres', 'CREATE DATABASE "' + target + '" CONNECTION LIMIT 0;'); created = true;
 stage = 'native PostgreSQL restore with original ownership and ACLs'; const input = openSync(plaintext, 'r');
 try { const result = spawnSync('/usr/bin/ssh', [...ssh, 'sudo -u postgres pg_restore --single-transaction --exit-on-error --no-password --no-tablespaces --dbname=' + target], { stdio: [input, 'pipe', 'pipe'], timeout: 60000, maxBuffer: 1048576 }); assert.equal(result.status, 0, 'Isolated pg_restore failed; raw diagnostics suppressed.'); } finally { closeSync(input); }
 stage = 'data, functions, permissions and row-policy comparison'; const restored = JSON.parse(sql(target, snapshotSql).split('\n').at(-1)); assert.deepEqual(restored, source);
 assert.equal(sql('postgres', "SELECT datconnlimit FROM pg_database WHERE datname='" + target + "';"), '0');
 stage = 'source unchanged after restore'; assert.deepEqual(JSON.parse(sql('kavosh_one', snapshotSql).split('\n').at(-1)), source);
 console.log(JSON.stringify({ backupId: backup.id, ciphertextSha256: backup.ciphertextSha256, encryptedBytes: backup.encryptedBytes, sourceSchemaRevision: source.revision, permanentTablesCompared: source.tableCount, rowsCompared: source.rowCount, originalDataPermissionsFunctionsAndPoliciesMatch: true, independentDriveDownloadVerified: true, actualIsolatedPostgresRestoreVerified: true, sourceDatabaseUnchanged: true, privateRecoveryKeyTransferredToVps: false, recoveredDatabaseOrdinaryConnectionsBlocked: true, globalRoleRecoveryVerified: false, mediaRecoveryVerified: false }));
} catch { console.error('VPS_RESTORE_ACCEPTANCE_FAILED: ' + stage); process.exitCode = 1; }
finally {
 if (created && target) try { sql('postgres', 'DROP DATABASE "' + target + '";'); } catch { cleanupFailed = true; }
 for (const file of [plaintext, encrypted]) if (file) try { unlinkSync(file); } catch (error) { if (error.code !== 'ENOENT') cleanupFailed = true; }
 if (directory) try { rmdirSync(directory); } catch { cleanupFailed = true; }
 if (cleanupFailed) { console.error('RESTORE_TEST_CLEANUP_REQUIRED'); process.exitCode = 1; }
}
