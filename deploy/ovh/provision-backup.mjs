import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
if (process.getuid() !== 0) throw new Error('ROOT_REQUIRED');
const recipient = process.env.BACKUP_AGE_RECIPIENT;
if (!/^age1[023456789acdefghjklmnpqrstuvwxyz]{58}$/.test(recipient ?? '')) throw new Error('PUBLIC_RECIPIENT_REQUIRED');
if (existsSync('/etc/kavosh-one/backup.env')) throw new Error('EXISTING_BACKUP_CONFIGURATION_REFUSED');
function sql(statement) {
 try { return execFileSync('/usr/sbin/runuser', ['-u', 'postgres', '--', '/usr/bin/psql', '-X', '-At', '-v', 'ON_ERROR_STOP=1', '-d', 'kavosh_one'], { input: statement, stdio: ['pipe', 'pipe', 'pipe'] }).toString().trim(); }
 catch { throw new Error('BACKUP_ROLE_PROVISION_FAILED'); }
}
if (sql("SELECT count(*) FROM pg_roles WHERE rolname='kavosh_one_backup';") !== '0') throw new Error('EXISTING_BACKUP_ROLE_REFUSED');
const password = randomBytes(48).toString('base64url');
writeFileSync('/etc/kavosh-one/backup.env', [
 'NODE_ENV=production', 'RECOVERY_DATABASE_SSL_MODE=verify-full',
 'RECOVERY_DATABASE_CA_FILE=/etc/kavosh-one-tls/server.crt',
 'RECOVERY_WORK_DIRECTORY=/var/lib/kavosh-one-backups',
 'AGE_BIN=/opt/kavosh-one-tools/age', 'RCLONE_BIN=/opt/kavosh-one-tools/rclone',
 'PG_DUMP_BIN=/usr/bin/pg_dump', `BACKUP_AGE_RECIPIENT=${recipient}`,
 `BACKUP_DATABASE_URL=postgresql://kavosh_one_backup:${password}@127.0.0.1:5432/kavosh_one`, ''
].join('\n'), { mode: 0o600, flag: 'wx' });
sql(`CREATE ROLE kavosh_one_backup LOGIN BYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION CONNECTION LIMIT 3 PASSWORD '${password}';
GRANT CONNECT ON DATABASE kavosh_one TO kavosh_one_backup;
GRANT USAGE ON SCHEMA public,identity,auth_private,platform_private TO kavosh_one_backup;
GRANT SELECT ON ALL TABLES IN SCHEMA public,identity,auth_private,platform_private TO kavosh_one_backup;
GRANT SELECT ON ALL SEQUENCES IN SCHEMA public,identity,auth_private,platform_private TO kavosh_one_backup;
GRANT EXECUTE ON FUNCTION public.schema_revision() TO kavosh_one_backup;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public,identity,auth_private,platform_private GRANT SELECT ON TABLES TO kavosh_one_backup;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public,identity,auth_private,platform_private GRANT SELECT ON SEQUENCES TO kavosh_one_backup;`);
const hbaPath = '/etc/postgresql/18/main/pg_hba.conf', hba = readFileSync(hbaPath, 'utf8');
const marker = 'host all all 0.0.0.0/0 reject';
if (!hba.includes(marker) || hba.includes('kavosh_one_backup')) throw new Error('EXPECTED_HBA_CONFIGURATION_REQUIRED');
writeFileSync(hbaPath, hba.replace(marker, 'hostssl kavosh_one kavosh_one_backup 127.0.0.1/32 scram-sha-256\n' + marker));
execFileSync('/usr/bin/systemctl', ['reload', 'postgresql@18-main'], { stdio: 'pipe' });
console.log('Database-scoped read-only backup login created; web/identity roles and landing page unchanged.');
