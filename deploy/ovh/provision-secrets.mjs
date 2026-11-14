// Fresh, isolated installation only. Run as root, never inside the web process.
// Secrets are generated on the VPS and passed to psql through stdin, not argv.
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';

if (process.getuid() !== 0) throw new Error('ROOT_REQUIRED');
const directory = '/etc/kavosh-one';
if (existsSync(directory)) throw new Error('EXISTING_CONFIGURATION_REFUSED');
const query = sql => {
 try { return execFileSync('/usr/sbin/runuser', ['-u', 'postgres', '--', '/usr/bin/psql', '-X', '-v', 'ON_ERROR_STOP=1', '-At', '-d', 'postgres'], { input: sql, stdio: ['pipe', 'pipe', 'pipe'] }).toString().trim(); }
 catch { throw new Error('PROVISION_DATABASE_COMMAND_FAILED'); }
};
if (query("SELECT count(*) FROM pg_database WHERE datname='kavosh_one';") !== '0' || query("SELECT count(*) FROM pg_roles WHERE rolname IN ('kavosh_one_web','kavosh_one_identity');") !== '0') throw new Error('EXISTING_DATABASE_REFUSED');
const secret = () => randomBytes(48).toString('base64url');
const web = secret(), identity = secret(), auth = secret(), edge = secret();
mkdirSync(directory, { mode: 0o700 });
// Persist recovery material before touching database roles; reruns refuse rather
// than rotating credentials or overwriting an existing installation implicitly.
writeFileSync(directory + '/web.env', [
 'NODE_ENV=production', 'NEXT_TELEMETRY_DISABLED=1', 'HOSTNAME=127.0.0.1', 'PORT=3100',
 'APP_ORIGIN=https://one.kavosh.ai', 'DATABASE_SSL_MODE=require',
 'NODE_EXTRA_CA_CERTS=/etc/kavosh-one-tls/server.crt',
 `DATABASE_URL=postgresql://kavosh_one_web:${web}@127.0.0.1:5432/kavosh_one`,
 `IDENTITY_DATABASE_URL=postgresql://kavosh_one_identity:${identity}@127.0.0.1:5432/kavosh_one`,
 `AUTH_SECRET=${auth}`, `EDGE_AUTH_SECRET=${edge}`, ''
].join('\n'), { mode: 0o600, flag: 'wx' });
query(`CREATE ROLE kavosh_one_web LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 16 PASSWORD '${web}';
CREATE ROLE kavosh_one_identity LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 12 PASSWORD '${identity}';
CREATE DATABASE kavosh_one;
REVOKE ALL ON DATABASE kavosh_one FROM PUBLIC;
GRANT CONNECT ON DATABASE kavosh_one TO kavosh_one_web,kavosh_one_identity;`);
console.log('Isolated database and root-only web configuration created; no school or account activated.');
