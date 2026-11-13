import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';

// Command doubles exercise the verifier, not a real restore or cloud service.
const source = readFileSync(new URL('../scripts/verify-vps-backup.mjs', import.meta.url), 'utf8').replace(/^import .*;\n/gm, '');
function run({ mismatch = false, restoreFails = false } = {}) {
 const ciphertext = Buffer.from('synthetic encrypted backup bytes'), id = '90f95990-a8ec-4db3-b763-b8a1f63a78ab';
 const backup = { id, ciphertextSha256: createHash('sha256').update(ciphertext).digest('hex'), encryptedBytes: ciphertext.length, serverMajor: 18 };
 const snapshot = { revision: 390, rows: 'source-hash', tableCount: 1, rowCount: 1, relations: 'same', functions: 'same', policies: 'same', tableChecks: [{ name: 'public.signature_ingest_limits', n: 1, h: 'source-row-hash' }] };
 const commands = [], logs = [], removed = [];
 const context = { assert, Buffer, JSON, join, createHash, randomUUID: () => id, process: { platform: 'darwin', argv: ['node', 'script', '--execute'], env: {}, umask() {} },
  console: { log: value => logs.push(value), error: value => logs.push(value) },
  mkdtempSync: () => '/private/tmp/kavosh-one-restore-synthetic', chmodSync() {}, openSync: () => 7, closeSync() {},
  readFileSync: () => ciphertext, statSync: () => ({ size: ciphertext.length }), unlinkSync: path => removed.push(path), rmdirSync: path => removed.push(path),
  execFileSync(binary, args) {
   commands.push([binary, args]);
   if (binary === '/usr/bin/security') return Buffer.from(JSON.stringify(args.includes('kavosh-one-production-backup-recovery') ? { identity: 'PRIVATE_RECOVERY_KEY' } : { token: { scope: 'https://www.googleapis.com/auth/drive.file' } }));
   if (binary !== '/usr/bin/ssh') return Buffer.alloc(0);
   const command = args.at(-1);
   if (command.includes('latest.json')) return Buffer.from(JSON.stringify({ localBackup: backup, offsiteCopy: { independentCopyVerified: true, ciphertextSha256: backup.ciphertextSha256 } }));
   if (command.includes('restore_row_checks')) {
    const value = structuredClone(snapshot);
    if (mismatch && !command.includes('-d kavosh_one ')) { value.rows = 'different'; value.tableChecks[0].h = 'PRIVATE_NEVER_LOG_HASH'; }
    return Buffer.from(JSON.stringify(value));
   }
   return Buffer.from(command.includes('datconnlimit') ? '0' : '');
  }, spawnSync: () => ({ status: restoreFails ? 1 : 0 })
 };
 runInNewContext("process.argv=['node','script','--execute'];\n" + source, context);
 return { logs, commands, removed, exitCode: context.process.exitCode };
}
test('restore verifier accepts only complete equality and removes its isolated target and temporary files', () => {
 const r = run(); assert.equal(r.exitCode, undefined, JSON.stringify(r.logs)); assert.equal(JSON.parse(r.logs.at(-1)).actualIsolatedPostgresRestoreVerified, true);
 assert.ok(r.commands.some(([_, args]) => args.at(-1).includes('DROP DATABASE "kavosh_recovery_90f95990a8ec4db3b763b8a1f63a78ab"'))); assert.equal(r.removed.length, 3);
});
test('changed live counters remain a failed comparison; diagnostics reveal names, never values or secrets', () => {
 const r = run({ mismatch: true }); assert.equal(r.exitCode, 1); assert.ok(r.logs.includes('RESTORE_COMPARISON_MISMATCH: rows')); assert.ok(r.logs.includes('RESTORE_TABLE_MISMATCH: public.signature_ingest_limits'));
 assert.ok(!r.logs.join('').includes('PRIVATE')); assert.equal(r.removed.length, 3); assert.ok(!r.logs.some(s => s.includes('actualIsolatedPostgresRestoreVerified')));
});
test('native restore failure still cleans up without claiming verification', () => {
 const r = run({ restoreFails: true }); assert.equal(r.exitCode, 1); assert.equal(r.removed.length, 3); assert.ok(r.logs.some(s => s.includes('native PostgreSQL restore')));
});
