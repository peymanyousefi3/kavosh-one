import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
const source = readFileSync(new URL('../deploy/ovh/run-backup.mjs', import.meta.url), 'utf8').replace(/^import .*;\n/gm, '');
function run({ failLocal = false, failOffsite = false, lowDisk = false, invalidReceipt = false, sharedWebEnvironment = false } = {}) {
 const directory = '/var/lib/kavosh-one-backups', id = '95da438f-a532-4a86-84af-b9507a1318d3';
 const backup = { id, ciphertextSha256: 'a'.repeat(64), encryptedBytes: 7117143, completeDatabase: true, schemaRevision: 388, archivePath: join(directory, 'backup-' + id, 'database.dump.age') };
 const files = new Map([[join(directory, 'latest.json'), 'original-good-receipt']]), logs = [], calls = [];
 const context = { Buffer, JSON, Date, Number, Error, join, randomUUID: () => 'new-status', process: { env: { NODE_ENV: 'production', CREDENTIALS_DIRECTORY: '/run/credentials/backup', ...(sharedWebEnvironment ? { AUTH_SECRET: 'private-synthetic-auth' } : {}) } },
  console: { log: x => logs.push(x), error: x => logs.push(x) }, statfsSync: () => ({ bavail: lowDisk ? 1n : 3000000000n, bsize: 1n }),
  readFileSync: () => '{"synthetic":"private-test-credential"}',
  writeFileSync: (p, value) => files.set(p, value), renameSync: (a, b) => { files.set(b, files.get(a)); files.delete(a); },
  execFileSync: (_, args, options) => { calls.push({ args, options }); if (args[1] === 'backup') { if (failLocal) throw Error('private diagnostic'); return Buffer.from(JSON.stringify({ ...backup, ...(invalidReceipt ? { archivePath: '/unrelated/file' } : {}) })); } if (failOffsite) throw Error('private-test-credential'); return Buffer.from(JSON.stringify({ independentCopyVerified: true })); }
 };
 runInNewContext(source, context); return { context, files, logs, calls, latest: files.get(join(directory, 'latest.json')) };
}
test('nightly job retains local receipt before verified offsite copy and keeps credentials out of argv/logs', () => {
 const r = run(); assert.equal(r.context.process.exitCode, undefined); const receipt = JSON.parse(r.latest);
 assert.equal(receipt.localBackup.completeDatabase, true); assert.equal(receipt.offsiteCopy.independentCopyVerified, true); assert.equal(receipt.automaticDeletionEnabled, false); assert.equal(r.calls.length, 2);
 assert.ok(r.calls[1].options.env.BACKUP_DRIVE_CONNECTION_JSON); assert.ok(!JSON.stringify(r.calls.map(c => c.args)).includes('private-test-credential')); assert.ok(!r.logs.join('').includes('private-test-credential'));
});
test('failed offsite copy fails the service but preserves the complete new local backup receipt without retry', () => {
 const r = run({ failOffsite: true }); assert.equal(r.context.process.exitCode, 1); const receipt = JSON.parse(r.latest);
 assert.equal(receipt.localBackup.completeDatabase, true); assert.equal(receipt.offsiteCopy, null); assert.equal(receipt.offsiteFailure, 'BACKUP_OR_OFFSITE_VERIFICATION_FAILED'); assert.equal(r.calls.length, 2); assert.ok(!r.logs.join('').includes('private-test-credential'));
});
test('failed local backup preserves the previous good receipt and never attempts offsite copy', () => {
 const r = run({ failLocal: true }); assert.equal(r.context.process.exitCode, 1); assert.equal(r.latest, 'original-good-receipt'); assert.equal(r.calls.length, 1);
});
test('low disk or shared web credentials stop before backup without deleting retained data', () => {
 for (const options of [{ lowDisk: true }, { sharedWebEnvironment: true }]) { const r = run(options); assert.equal(r.context.process.exitCode, 1); assert.equal(r.calls.length, 0); assert.equal(r.latest, 'original-good-receipt'); }
});
test('an unrelated or malformed producer archive path is not handed to offsite transport', () => {
 const r = run({ invalidReceipt: true }); assert.equal(r.context.process.exitCode, 1); assert.equal(r.calls.length, 1); assert.equal(r.latest, 'original-good-receipt');
});
