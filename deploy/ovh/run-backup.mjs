// Offline service only. Native flock serializes the entire local+offsite job.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, renameSync, statfsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
const directory = '/var/lib/kavosh-one-backups', cli = process.env.KAVOSH_BACKUP_OPERATOR_CLI??'/srv/kavosh-one/current/.recovery-tool/scripts/database-recovery.js';
let receipt;
function save() {
 // Preserve each backup's delivery evidence before moving the latest pointer.
 // Another successful nightly run must not erase an older proof's history.
 for(const destination of [join(directory,'backup-'+receipt.localBackup.id,'delivery-status.json'),join(directory,'latest.json')]){
  const temp=destination+'.'+randomUUID()+'.next';
  writeFileSync(temp,JSON.stringify(receipt)+'\n',{mode:0o600,flag:'wx'});
  renameSync(temp,destination);
 }
}
function command(args, additional = {}) {
 try { return JSON.parse(execFileSync('/usr/bin/node', [cli, ...args], { env: { ...process.env, ...additional }, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: ['backup-proof','backup-media-plan','backup-cluster-proof'].includes(args[0])?3145728:131072, timeout: args[0]==='backup-media-batch'?21600000:900000 }).toString()); }
 catch { throw new Error('BACKUP_OPERATOR_FAILED'); }
}
try {
 const args=process.argv.slice(2),clusterProof=args.length===1&&args[0]==='--cluster-proof',includeMedia=args.length===1&&args[0]==='--media-backup',mediaPlan=clusterProof||includeMedia||args.length===1&&args[0]==='--media-reference-plan',proof=mediaPlan||args.length===1&&args[0]==='--snapshot-proof';
 if(args.length&&!proof)throw new Error('INVALID_BACKUP_ARGUMENTS');
 if(cli!=='/srv/kavosh-one/current/.recovery-tool/scripts/database-recovery.js'&&!/^\/srv\/kavosh-one\/operations\/recovery-[a-f0-9]{7,40}\/scripts\/database-recovery\.js$/.test(cli))throw new Error('INVALID_BACKUP_OPERATOR');
 if (process.env.DATABASE_URL || process.env.AUTH_SECRET || process.env.MIGRATION_DATABASE_URL) throw new Error('SHARED_WEB_CREDENTIALS_REFUSED');
 let mediaTargets;if(includeMedia){if(!process.env.CREDENTIALS_DIRECTORY)throw new Error('MEDIA_READERS_REQUIRED');mediaTargets=readFileSync(join(process.env.CREDENTIALS_DIRECTORY,'media-readers.json'),'utf8');if(Buffer.byteLength(mediaTargets)>1048576)throw new Error('INVALID_MEDIA_READERS');JSON.parse(mediaTargets);}
 const disk = statfsSync(directory, { bigint: true });
 if (disk.bavail * disk.bsize < 2147483648n) throw new Error('BACKUP_DISK_CAPACITY_LOW');
 const backup = command([clusterProof?'backup-cluster-proof':mediaPlan?'backup-media-plan':proof?'backup-proof':'backup']);
 if (!/^[a-f0-9-]{36}$/.test(backup.id ?? '') || !/^[a-f0-9]{64}$/.test(backup.ciphertextSha256 ?? '') || !Number.isSafeInteger(backup.encryptedBytes) || backup.encryptedBytes < 22 || backup.archivePath !== join(directory, 'backup-' + backup.id, 'database.dump.age') || backup.completeDatabase !== true) throw new Error('INVALID_BACKUP_RECEIPT');
 const companion=backup.verificationArchive;
 if(proof&&(!companion||companion.filename!=='verification.json.age'||!/^[a-f0-9]{64}$/.test(companion.ciphertextSha256??'')||!Number.isSafeInteger(companion.encryptedBytes)||companion.encryptedBytes<22||companion.encryptedBytes>4194304||backup.verification?.archiveSha256!==backup.ciphertextSha256||backup.verification?.snapshot?.schemaRevision!==backup.schemaRevision))throw new Error('INVALID_SNAPSHOT_PROOF');
 if(clusterProof){const cluster=backup.verification?.cluster;if(!cluster||cluster.databaseAccess?.rows!==1||!Number.isSafeInteger(cluster.globalRoleProperties?.rows)||cluster.globalRoleProperties.rows<1||![cluster.databaseAccess.sha256,cluster.globalRoleProperties.sha256].every(hash=>/^[a-f0-9]{64}$/.test(hash??'')))throw new Error('INVALID_CLUSTER_PROOF');}
 const reference=backup.mediaReferenceArchive,plan=backup.mediaReferencePlan;
 if(mediaPlan&&(!reference||reference.filename!=='media-references.jsonl.age'||!/^[a-f0-9]{64}$/.test(reference.ciphertextSha256??'')||!Number.isSafeInteger(reference.encryptedBytes)||reference.encryptedBytes<22||reference.encryptedBytes>4296146944||plan?.filename!=='media-references.jsonl'||plan?.databaseBackupId!==backup.id||plan?.archiveSha256!==backup.ciphertextSha256||plan?.schemaRevision!==backup.schemaRevision||plan?.signedEvidenceIncluded!==false||plan?.scope!=='recorded_ordinary_file_objects'))throw new Error('INVALID_MEDIA_REFERENCE_PLAN');
 receipt = { recordedAt: new Date().toISOString(), localBackup: backup, offsiteCopy: null, verificationOffsiteCopy:null,mediaReferenceOffsiteCopy:null,mediaBatch:null, snapshotBaselineOffsiteVerified:false,mediaReferencePlanOffsiteVerified:false,ordinaryMediaOffsiteVerified:false, offsiteFailure: null, automaticDeletionEnabled: false };
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
  if(mediaPlan){
   receipt.mediaReferenceOffsiteCopy=command(['copy-media-plan',backup.id,join(directory,'backup-'+backup.id,reference.filename),reference.ciphertextSha256,String(reference.encryptedBytes)],{BACKUP_DRIVE_CONNECTION_JSON:connection});
   if(receipt.mediaReferenceOffsiteCopy.independentCopyVerified!==true)throw new Error('OFFSITE_VERIFICATION_REQUIRED');
   receipt.mediaReferencePlanOffsiteVerified=true;save();
  }
  if(includeMedia){
   const media=command(['backup-media-batch'],{MEDIA_BACKUP_TARGETS_JSON:mediaTargets,BACKUP_DRIVE_CONNECTION_JSON:connection,MEDIA_REFERENCE_PLAN_JSON:JSON.stringify({file:join(directory,'backup-'+backup.id,plan.filename),databaseBackupId:backup.id,archiveSha256:backup.ciphertextSha256,schemaRevision:backup.schemaRevision,plaintextSha256:plan.plaintextSha256,plaintextBytes:plan.plaintextBytes})});
   if(media.referenceBinding?.databaseBackupId!==backup.id||media.referenceBinding?.archiveSha256!==backup.ciphertextSha256||media.ordinaryRecordedMediaBackedUp!==true||media.signedEvidenceIncluded!==false||media.offsite?.independentCopyVerified!==true||media.offsite?.scope!=='one_encrypted_media_batch_catalog')throw new Error('MEDIA_BACKUP_NOT_VERIFIED');
   receipt.mediaBatch=media;receipt.ordinaryMediaOffsiteVerified=true;save();
  }
 }
 console.log(JSON.stringify({ backupId: backup.id, encryptedBytes: backup.encryptedBytes, schemaRevision: backup.schemaRevision, localVerified: true, offsiteVerified: receipt.offsiteCopy?.independentCopyVerified === true, snapshotBaselineCaptured:proof, snapshotBaselineOffsiteVerified:receipt.snapshotBaselineOffsiteVerified,mediaReferencePlanCaptured:mediaPlan,mediaReferencePlanOffsiteVerified:receipt.mediaReferencePlanOffsiteVerified,ordinaryMediaOffsiteVerified:receipt.ordinaryMediaOffsiteVerified, restoreVerified: false, mediaIncluded: includeMedia,signedEvidenceIncluded:false, automaticDeletionEnabled: false }));
} catch {
 if (receipt) { receipt.offsiteFailure = 'BACKUP_OR_OFFSITE_VERIFICATION_FAILED'; try { save(); } catch { /* Fail the service; never invent a successful receipt. */ } }
 console.error('KAVOSH_ONE_BACKUP_FAILED: inspect private backup status; existing backups were not deleted.'); process.exitCode = 1;
}
