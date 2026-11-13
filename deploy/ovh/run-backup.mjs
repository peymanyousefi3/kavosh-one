// Offline service only. Native flock serializes the entire local+offsite job.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, renameSync, statfsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
const directory = '/var/lib/kavosh-one-backups', cli = '/srv/kavosh-one/current/.recovery-tool/scripts/database-recovery.js';
let receipt;
function save() {
 const temp = join(directory, 'status-' + randomUUID() + '.json');
 writeFileSync(temp, JSON.stringify(receipt) + '\n', { mode: 0o600, flag: 'wx' });
 renameSync(temp, join(directory, 'latest.json'));
}
function command(args, additional = {}) {
 try { return JSON.parse(execFileSync('/usr/bin/node', [cli, ...args], { env: { ...process.env, ...additional }, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: args[0]==='backup-proof'?3145728:131072, timeout: 900000 }).toString()); }
 catch { throw new Error('BACKUP_OPERATOR_FAILED'); }
}
try {
 const args=process.argv.slice(2),proof=args.length===1&&args[0]==='--snapshot-proof';
 if(args.length&&!proof)throw new Error('INVALID_BACKUP_ARGUMENTS');
 if (process.env.DATABASE_URL || process.env.AUTH_SECRET || process.env.MIGRATION_DATABASE_URL) throw new Error('SHARED_WEB_CREDENTIALS_REFUSED');
 const disk = statfsSync(directory, { bigint: true });
 if (disk.bavail * disk.bsize < 2147483648n) throw new Error('BACKUP_DISK_CAPACITY_LOW');
 const backup = command([proof?'backup-proof':'backup']);
 if (!/^[a-f0-9-]{36}$/.test(backup.id ?? '') || !/^[a-f0-9]{64}$/.test(backup.ciphertextSha256 ?? '') || !Number.isSafeInteger(backup.encryptedBytes) || backup.encryptedBytes < 22 || backup.archivePath !== join(directory, 'backup-' + backup.id, 'database.dump.age') || backup.completeDatabase !== true) throw new Error('INVALID_BACKUP_RECEIPT');
 const companion=backup.verificationArchive;
 if(proof&&(!companion||companion.filename!=='verification.json.age'||!/^[a-f0-9]{64}$/.test(companion.ciphertextSha256??'')||!Number.isSafeInteger(companion.encryptedBytes)||companion.encryptedBytes<22||companion.encryptedBytes>4194304||backup.verification?.archiveSha256!==backup.ciphertextSha256||backup.verification?.snapshot?.schemaRevision!==backup.schemaRevision))throw new Error('INVALID_SNAPSHOT_PROOF');
 receipt = { recordedAt: new Date().toISOString(), localBackup: backup, offsiteCopy: null, verificationOffsiteCopy:null, snapshotBaselineOffsiteVerified:false, offsiteFailure: null, automaticDeletionEnabled: false };
 save(); // A failed network copy must not lose the independently retained dump.
 const credentials = process.env.CREDENTIALS_DIRECTORY;
 if (credentials) {
  const connection = readFileSync(join(credentials, 'drive.json'), 'utf8');
  if (Buffer.byteLength(connection) > 65536) throw new Error('INVALID_DRIVE_CREDENTIAL');
  receipt.offsiteCopy = command(['copy-drive', backup.id, backup.archivePath, backup.ciphertextSha256, String(backup.encryptedBytes)], { BACKUP_DRIVE_CONNECTION_JSON: connection });
  if (receipt.offsiteCopy.independentCopyVerified !== true) throw new Error('OFFSITE_VERIFICATION_REQUIRED');
  save();
  if(proof){
   receipt.verificationOffsiteCopy=command(['copy-verification',backup.id,join(directory,'backup-'+backup.id,companion.filename),companion.ciphertextSha256,String(companion.encryptedBytes)],{BACKUP_DRIVE_CONNECTION_JSON:connection});
   if(receipt.verificationOffsiteCopy.independentCopyVerified!==true)throw new Error('OFFSITE_VERIFICATION_REQUIRED');
   receipt.snapshotBaselineOffsiteVerified=true;save();
  }
 }
 console.log(JSON.stringify({ backupId: backup.id, encryptedBytes: backup.encryptedBytes, schemaRevision: backup.schemaRevision, localVerified: true, offsiteVerified: receipt.offsiteCopy?.independentCopyVerified === true, snapshotBaselineCaptured:proof, snapshotBaselineOffsiteVerified:receipt.snapshotBaselineOffsiteVerified, restoreVerified: false, mediaIncluded: false, automaticDeletionEnabled: false }));
} catch {
 if (receipt) { receipt.offsiteFailure = 'BACKUP_OR_OFFSITE_VERIFICATION_FAILED'; try { save(); } catch { /* Fail the service; never invent a successful receipt. */ } }
 console.error('KAVOSH_ONE_BACKUP_FAILED: inspect private backup status; existing backups were not deleted.'); process.exitCode = 1;
}
