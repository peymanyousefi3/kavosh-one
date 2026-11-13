import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';

// Command doubles exercise the verifier, not a real restore or cloud service.
const source = readFileSync(new URL('../scripts/verify-vps-backup.mjs', import.meta.url), 'utf8').replace(/^import .*;\n/gm, '');
function run({ mismatch = false, restoreFails = false,missingProof=false,wrongProofDigest=false,proofDecryptFails=false } = {}) {
 const ciphertext = Buffer.from('synthetic encrypted backup bytes'), id = '90f95990-a8ec-4db3-b763-b8a1f63a78ab';
 const digest=createHash('sha256').update(ciphertext).digest('hex');
 const snapshot = { format:'kavosh-database-verification-v1',schemaRevision:396,tables:[{schema:'public',name:'signature_ingest_limits',fingerprint:{rows:1,sha256:'a'.repeat(64)}}],relations:{rows:1,sha256:'b'.repeat(64)},functions:{rows:1,sha256:'c'.repeat(64)},policies:{rows:1,sha256:'d'.repeat(64)},sequenceValuesCovered:false,globalRolesCovered:false };
 const verification={archiveSha256:digest,snapshot};
 const backup = { id, ciphertextSha256:digest,encryptedBytes:ciphertext.length,serverMajor:18,schemaRevision:396,verification,verificationArchive:{filename:'verification.json.age',ciphertextSha256:wrongProofDigest?'e'.repeat(64):digest,encryptedBytes:ciphertext.length} };
 const commands = [], logs = [], removed = [];
 const context = { assert, Buffer, JSON, join, createHash, randomUUID: () => id, process: { platform: 'darwin', argv: ['node', 'script', '--execute'], env: {}, umask() {} },
  console: { log: value => logs.push(value), error: value => logs.push(value) },
  mkdtempSync: () => '/private/tmp/kavosh-one-restore-synthetic', chmodSync() {}, openSync: () => 7, closeSync() {},
  readFileSync: (_,encoding) => encoding==='utf8'?JSON.stringify(verification):ciphertext,writeFileSync:()=>{}, statSync: path => ({ size: path.endsWith('/verification.json')?JSON.stringify(verification).length:ciphertext.length }), unlinkSync: path => removed.push(path), rmdirSync: path => removed.push(path),
  execFileSync(binary, args) {
   commands.push([binary, args]);
   if (binary === '/usr/bin/security') return Buffer.from(JSON.stringify(args.includes('kavosh-one-production-backup-recovery') ? { identity: 'PRIVATE_RECOVERY_KEY' } : { token: { scope: 'https://www.googleapis.com/auth/drive.file' } }));
   if(binary==='/opt/homebrew/bin/age'&&proofDecryptFails&&args.at(-1).endsWith('/verification.json.age'))throw Error('PRIVATE_DECRYPT_ERROR');
   if(binary==='/opt/homebrew/bin/rclone'){assert.equal(args[0],'cat');assert.ok(!args.includes('--max-size'));return Buffer.from(ciphertext);}
   if (binary !== '/usr/bin/ssh') return Buffer.alloc(0);
   const command = args.at(-1);
   if (command.includes('latest.json')) return Buffer.from(JSON.stringify({ localBackup: backup, offsiteCopy: { independentCopyVerified: true, ciphertextSha256: backup.ciphertextSha256 },snapshotBaselineOffsiteVerified:!missingProof,verificationOffsiteCopy:{independentCopyVerified:true,ciphertextSha256:backup.verificationArchive.ciphertextSha256} }));
   if (command.includes('databaseVerificationSnapshot')) {
    const value = structuredClone(snapshot);
    if (mismatch) value.tables[0].fingerprint.sha256='PRIVATE_NEVER_LOG_HASH';
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
 assert.ok(r.commands.some(([_, args]) => args.at(-1).includes('DROP DATABASE "kavosh_recovery_90f95990a8ec4db3b763b8a1f63a78ab"'))); assert.equal(r.removed.length, 5);
 assert.equal(JSON.parse(r.logs.at(-1)).originalExportedSnapshotMatched,true);assert.ok(!r.commands.some(([_,args])=>args.at(-1).includes('-d kavosh_one ')));assert.equal(r.commands.filter(([binary])=>binary==='/opt/homebrew/bin/rclone').length,2);
});
test('changed restored data remains a failed original-snapshot comparison without leaking hashes or secrets', () => {
 const r = run({ mismatch: true }); assert.equal(r.exitCode, 1); assert.ok(r.logs.includes('RESTORE_COMPARISON_MISMATCH'));
 assert.ok(!r.logs.join('').includes('PRIVATE')); assert.equal(r.removed.length, 5); assert.ok(!r.logs.some(s => s.includes('actualIsolatedPostgresRestoreVerified')));
});
test('native restore failure still cleans up without claiming verification', () => {
 const r = run({ restoreFails: true }); assert.equal(r.exitCode, 1); assert.equal(r.removed.length, 5); assert.ok(r.logs.some(s => s.includes('native PostgreSQL restore')));
});
test('missing,corrupt or unauthenticated proof stops before any recovery database is created',()=>{
 for(const options of [{missingProof:true},{wrongProofDigest:true},{proofDecryptFails:true}]){const r=run(options);assert.equal(r.exitCode,1);assert.ok(!r.commands.some(([_,args])=>args.at(-1).includes('CREATE DATABASE')));assert.ok(!r.logs.join('').includes('PRIVATE'));}
});
