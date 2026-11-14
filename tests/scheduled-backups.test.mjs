import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
const source = readFileSync(new URL('../deploy/ovh/run-backup.mjs', import.meta.url), 'utf8').replace(/^import .*;\n/gm, '');
function run({ failLocal = false, failOffsite = false, lowDisk = false, invalidReceipt = false, sharedWebEnvironment = false,proof=false,mediaPlan=false,clusterProof=false,invalidCluster=false,includeMedia=false,failBatch=false,invalidBatch=false,failPlanCopy=false,invalidPlan=false,cli,failProofCopy=false,invalidProof=false,args,failHistoryWrite=false,failLatestWrite=false,signing=false,signingFlag,wrongSigningPlan=false,wrongSigningBatch=false } = {}) {
 const explicitClusterProof=clusterProof;clusterProof=clusterProof||includeMedia;mediaPlan=mediaPlan||includeMedia||clusterProof;
 proof=proof||mediaPlan;
 const directory = '/var/lib/kavosh-one-backups', id = '95da438f-a532-4a86-84af-b9507a1318d3';
 const backup = { id, ciphertextSha256: 'a'.repeat(64), encryptedBytes: 7117143, completeDatabase: true, schemaRevision: 388, archivePath: join(directory, 'backup-' + id, 'database.dump.age'),...(proof?{verification:{archiveSha256:invalidProof?'b'.repeat(64):'a'.repeat(64),snapshot:{schemaRevision:388}},verificationArchive:{filename:'verification.json.age',ciphertextSha256:'c'.repeat(64),encryptedBytes:1234}}:{}),...(mediaPlan?{mediaReferencePlan:{filename:'media-references.jsonl',databaseBackupId:invalidPlan?'wrong':id,archiveSha256:'a'.repeat(64),schemaRevision:388,signedEvidenceIncluded:false,scope:'recorded_ordinary_file_objects'},mediaReferenceArchive:{filename:'media-references.jsonl.age',ciphertextSha256:'d'.repeat(64),encryptedBytes:2345}}:{}) };
 if(clusterProof&&!invalidCluster)backup.verification.cluster={databaseAccess:{rows:1,sha256:'e'.repeat(64)},globalRoleProperties:{rows:30,sha256:'f'.repeat(64)}};
 if(mediaPlan){backup.mediaReferencePlan.signedEvidenceIncluded=wrongSigningPlan?!signing:signing;backup.mediaReferencePlan.scope=backup.mediaReferencePlan.signedEvidenceIncluded?'recorded_ordinary_and_signed_evidence_objects':'recorded_ordinary_file_objects';}
 if(explicitClusterProof)args??=['--cluster-proof'];
 const files = new Map([[join(directory, 'latest.json'), 'original-good-receipt']]), logs = [], calls = [];
 const context = { Buffer, JSON, Date, Number, Error, join, randomUUID: () => 'new-status', process: {argv:['node','script',...args??(includeMedia?['--media-backup']:mediaPlan?['--media-reference-plan']:proof?['--snapshot-proof']:[])], env: { NODE_ENV: 'production', CREDENTIALS_DIRECTORY: '/run/credentials/backup',...(cli?{KAVOSH_BACKUP_OPERATOR_CLI:cli}:{}),...signing||signingFlag!==undefined?{KAVOSH_BACKUP_SIGNED_EVIDENCE_ENABLED:signingFlag??'true'}:{}, ...(sharedWebEnvironment ? { AUTH_SECRET: 'private-synthetic-auth' } : {}) } },
  console: { log: x => logs.push(x), error: x => logs.push(x) }, statfsSync: () => ({ bavail: lowDisk ? 1n : 3000000000n, bsize: 1n }),
  readFileSync: () => '{"synthetic":"private-test-credential"}',
  writeFileSync: (p, value) => {if(failHistoryWrite&&p.includes('/delivery-status.json.')||failLatestWrite&&p.includes('/latest.json.'))throw Error('private write failure');files.set(p, value);}, renameSync: (a, b) => { files.set(b, files.get(a)); files.delete(a); },
  execFileSync: (_, args, options) => { calls.push({ args, options }); if (['backup','backup-proof','backup-media-plan','backup-cluster-proof'].includes(args[1])) { if (failLocal) throw Error('private diagnostic'); return Buffer.from(JSON.stringify({ ...backup, ...(invalidReceipt ? { archivePath: '/unrelated/file' } : {}) })); }if(args[1]==='backup-media-batch'){if(failBatch)throw Error('private media failure');return Buffer.from(JSON.stringify({referenceBinding:{databaseBackupId:id,archiveSha256:'a'.repeat(64)},ordinaryRecordedMediaBackedUp:true,signedEvidenceIncluded:wrongSigningBatch?!signing:signing,offsite:{independentCopyVerified:!invalidBatch,scope:'one_encrypted_media_batch_catalog'}}));} if (failOffsite||failProofCopy&&args[1]==='copy-verification'||failPlanCopy&&args[1]==='copy-media-plan') throw Error('private-test-credential'); return Buffer.from(JSON.stringify({ independentCopyVerified: true })); }
 };
 runInNewContext(source, context); return { context, files, logs, calls, latest: files.get(join(directory, 'latest.json')) };
}
test('explicit cluster proof captures role/access baselines with all three copies and refuses missing proof before delivery',()=>{
 const r=run({clusterProof:true}),receipt=JSON.parse(r.latest);assert.equal(r.context.process.exitCode,undefined);assert.equal(r.calls[0].args[1],'backup-cluster-proof');assert.equal(r.calls[0].options.maxBuffer,3145728);assert.equal(r.calls.length,4);assert.equal(receipt.localBackup.verification.cluster.databaseAccess.rows,1);assert.equal(receipt.snapshotBaselineOffsiteVerified,true);assert.equal(receipt.mediaReferencePlanOffsiteVerified,true);
 const failed=run({clusterProof:true,invalidCluster:true});assert.equal(failed.context.process.exitCode,1);assert.equal(failed.latest,'original-good-receipt');assert.equal(failed.calls.length,1);
});
test('scheduled signing backups require explicit full-media mode and exactly matching snapshot and byte-copy scope',()=>{
 const good=run({includeMedia:true,signing:true}),receipt=JSON.parse(good.latest);assert.equal(good.context.process.exitCode,undefined);assert.equal(good.calls[0].options.env.BACKUP_SIGNED_EVIDENCE_REFERENCES,'true');assert.equal(receipt.signedEvidenceOffsiteVerified,true);assert.equal(JSON.parse(good.logs[0]).signedEvidenceIncluded,true);
 for(const options of [{includeMedia:true,signingFlag:'yes'},{signing:true},{mediaPlan:true,signing:true}]){const r=run(options);assert.equal(r.context.process.exitCode,1);assert.equal(r.calls.length,0);assert.equal(r.latest,'original-good-receipt');}
 for(const options of [{wrongSigningPlan:true},{wrongSigningBatch:true},{failBatch:true}]){const r=run({includeMedia:true,signing:true,...options});assert.equal(r.context.process.exitCode,1);if(options.wrongSigningPlan)assert.equal(r.latest,'original-good-receipt');else assert.equal(JSON.parse(r.latest).signedEvidenceOffsiteVerified,false);assert.ok(!r.logs.some(line=>line.includes('"signedEvidenceIncluded":true')));}
});
test('full-media mode binds the exact database proof,requires verified batch delivery and retains earlier successful archives on failure',()=>{
 const baseline=run({includeMedia:true});assert.equal(baseline.calls[0].args[1],'backup-cluster-proof');assert.equal(JSON.parse(baseline.latest).localBackup.verification.cluster.databaseAccess.rows,1);
 const missing=run({includeMedia:true,invalidCluster:true});assert.equal(missing.context.process.exitCode,1);assert.equal(missing.latest,'original-good-receipt');assert.equal(missing.calls.length,1);
 const good=run({includeMedia:true}),receipt=JSON.parse(good.latest);assert.equal(good.context.process.exitCode,undefined);assert.equal(good.calls.length,5);assert.equal(good.calls[4].args[1],'backup-media-batch');assert.equal(good.calls[4].options.timeout,21600000);const source=JSON.parse(good.calls[4].options.env.MEDIA_REFERENCE_PLAN_JSON);assert.equal(source.databaseBackupId,receipt.localBackup.id);assert.ok(source.file.endsWith('/media-references.jsonl'));assert.equal(receipt.ordinaryMediaOffsiteVerified,true);assert.equal(JSON.parse(good.logs[0]).signedEvidenceIncluded,false);
 for(const options of [{failBatch:true},{invalidBatch:true}]){const failed=run({includeMedia:true,...options}),retained=JSON.parse(failed.latest);assert.equal(failed.context.process.exitCode,1);assert.equal(retained.snapshotBaselineOffsiteVerified,true);assert.equal(retained.mediaReferencePlanOffsiteVerified,true);assert.equal(retained.ordinaryMediaOffsiteVerified,false);assert.equal(retained.mediaBatch,null);assert.equal(retained.offsiteFailure,'BACKUP_OR_OFFSITE_VERIFICATION_FAILED');assert.ok(!failed.logs.join('').includes('private media failure'));}
});
test('on-demand media-reference proof retains all three copy receipts and refuses unbound plans or arbitrary operators',()=>{
 const cli='/srv/kavosh-one/operations/recovery-5e1f607/scripts/database-recovery.js',r=run({mediaPlan:true,cli}),receipt=JSON.parse(r.latest);assert.equal(r.context.process.exitCode,undefined);assert.equal(r.calls.length,4);assert.equal(r.calls[0].args[0],cli);assert.equal(r.calls[0].args[1],'backup-media-plan');assert.equal(r.calls[0].options.maxBuffer,3145728);assert.equal(r.calls[3].args[1],'copy-media-plan');assert.equal(receipt.snapshotBaselineOffsiteVerified,true);assert.equal(receipt.mediaReferencePlanOffsiteVerified,true);assert.equal(receipt.mediaReferenceOffsiteCopy.independentCopyVerified,true);assert.equal(JSON.parse(r.logs[0]).mediaIncluded,false);
 const failed=run({mediaPlan:true,failPlanCopy:true}),retained=JSON.parse(failed.latest);assert.equal(failed.context.process.exitCode,1);assert.equal(retained.snapshotBaselineOffsiteVerified,true);assert.equal(retained.mediaReferencePlanOffsiteVerified,false);assert.equal(retained.mediaReferenceOffsiteCopy,null);assert.equal(retained.offsiteFailure,'BACKUP_OR_OFFSITE_VERIFICATION_FAILED');
 const bad=run({mediaPlan:true,invalidPlan:true});assert.equal(bad.context.process.exitCode,1);assert.equal(bad.latest,'original-good-receipt');assert.equal(bad.calls.length,1);
 for(const cli of ['/tmp/arbitrary.js','/srv/kavosh-one/operations/recovery-abcdefg/scripts/database-recovery.js']){const bad=run({cli});assert.equal(bad.context.process.exitCode,1);assert.equal(bad.calls.length,0);assert.equal(bad.latest,'original-good-receipt');}
});
test('nightly job retains local receipt before verified offsite copy and keeps credentials out of argv/logs', () => {
 const r = run(); assert.equal(r.context.process.exitCode, undefined); const receipt = JSON.parse(r.latest);
 assert.equal(receipt.localBackup.completeDatabase, true); assert.equal(receipt.offsiteCopy.independentCopyVerified, true); assert.equal(receipt.automaticDeletionEnabled, false); assert.equal(r.calls.length, 2);
 assert.ok(r.calls[1].options.env.BACKUP_DRIVE_CONNECTION_JSON); assert.ok(!JSON.stringify(r.calls.map(c => c.args)).includes('private-test-credential')); assert.ok(!r.logs.join('').includes('private-test-credential'));
 assert.equal(r.files.get('/var/lib/kavosh-one-backups/backup-'+receipt.localBackup.id+'/delivery-status.json'),r.latest);
});
test('receipt write failures preserve the old latest record and never start an offsite copy',()=>{
 for(const options of [{failHistoryWrite:true},{failLatestWrite:true}]){const r=run(options);assert.equal(r.context.process.exitCode,1);assert.equal(r.latest,'original-good-receipt');assert.equal(r.calls.length,1);assert.ok(!r.logs.join('').includes('private write failure'));if(options.failLatestWrite){const history=JSON.parse(r.files.get('/var/lib/kavosh-one-backups/backup-95da438f-a532-4a86-84af-b9507a1318d3/delivery-status.json'));assert.equal(history.offsiteFailure,'BACKUP_OR_OFFSITE_VERIFICATION_FAILED');assert.equal(history.offsiteCopy,null);}}
});
test('retained per-backup proof survives a later latest-record replacement and keeps failed-copy status',()=>{
 for(const options of [{proof:true},{proof:true,failProofCopy:true},{failOffsite:true}]){
  const r=run(options),receipt=JSON.parse(r.latest),path='/var/lib/kavosh-one-backups/backup-'+receipt.localBackup.id+'/delivery-status.json',retained=r.files.get(path);
  assert.equal(retained,r.latest);r.files.set('/var/lib/kavosh-one-backups/latest.json','later-unrelated-backup');assert.equal(r.files.get(path),retained);
  assert.equal(JSON.parse(retained).snapshotBaselineOffsiteVerified,options.proof===true&&!options.failProofCopy);assert.equal(JSON.parse(retained).offsiteFailure,options.failProofCopy||options.failOffsite?'BACKUP_OR_OFFSITE_VERIFICATION_FAILED':null);
 }
});
test('explicit snapshot proof keeps both immutable copy receipts and never treats a failed companion copy as verified',()=>{
 const r=run({proof:true}),receipt=JSON.parse(r.latest);assert.equal(r.context.process.exitCode,undefined);assert.equal(r.calls.length,3);assert.equal(r.calls[0].args[1],'backup-proof');assert.equal(r.calls[0].options.maxBuffer,3145728);assert.equal(r.calls[2].args[1],'copy-verification');assert.ok(r.calls[2].args[3].endsWith('/verification.json.age'));assert.equal(receipt.snapshotBaselineOffsiteVerified,true);assert.equal(receipt.verificationOffsiteCopy.independentCopyVerified,true);assert.ok(!r.logs.join('').includes('private-test-credential'));assert.equal(JSON.parse(r.logs[0]).restoreVerified,false);
 const failed=run({proof:true,failProofCopy:true}),retained=JSON.parse(failed.latest);assert.equal(failed.context.process.exitCode,1);assert.equal(retained.offsiteCopy.independentCopyVerified,true);assert.equal(retained.verificationOffsiteCopy,null);assert.equal(retained.snapshotBaselineOffsiteVerified,false);assert.equal(retained.offsiteFailure,'BACKUP_OR_OFFSITE_VERIFICATION_FAILED');assert.equal(failed.calls.length,3);
 for(const options of [{proof:true,invalidProof:true},{args:['--unknown']}]){const bad=run(options);assert.equal(bad.context.process.exitCode,1);assert.equal(bad.latest,'original-good-receipt');assert.ok(bad.calls.length<=1);}
 const ordinary=run();assert.equal(ordinary.calls[0].args[1],'backup');assert.equal(ordinary.calls[0].options.maxBuffer,131072);assert.equal(ordinary.calls.length,2);assert.equal(JSON.parse(ordinary.latest).snapshotBaselineOffsiteVerified,false);
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
