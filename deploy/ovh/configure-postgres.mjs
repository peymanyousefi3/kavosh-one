import { readFileSync, writeFileSync } from 'node:fs';
if (process.getuid() !== 0) throw new Error('ROOT_REQUIRED');
const path = '/etc/postgresql/18/main/postgresql.conf';
let config = readFileSync(path, 'utf8');
// Explicit SQL configuration literals avoid guessing pg_conftool's automatic
// string/numeric quoting heuristics (an IPv4 address can be misclassified).
for (const [key, value] of Object.entries({
 listen_addresses: "'127.0.0.1'", ssl: 'on',
 ssl_cert_file: "'/etc/kavosh-one-tls/server.crt'",
 ssl_key_file: "'/etc/kavosh-one-tls/server.key'", ssl_min_protocol_version: "'TLSv1.2'",
 max_connections: '40', shared_buffers: '256MB', work_mem: '4MB', maintenance_work_mem: '64MB'
})) {
 const pattern = new RegExp('^\\s*#?\\s*' + key + '\\s*=.*$', 'gm');
 if (!pattern.test(config)) throw new Error('EXPECTED_PARAMETER_MISSING');
 config = config.replace(pattern, key + ' = ' + value);
}
writeFileSync(path, config);
console.log('Dedicated PostgreSQL settings written; certificate validation remains required.');
