import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';

// Command doubles exercise the verifier, not a real restore or cloud service.
const source = readFileSync(new URL('../scripts/verify-vps-backup.mjs', import.meta.url), 'utf8').replace(/^import .*;\n/gm, '');
function run({ mismatch = false, restoreFails = false,clusterProof=false,missingProof=false,wrongProofDigest=false,proofDecryptFails=false,args=['--execute'] } = {}) {
 const ciphertext = Buffer.from('synthetic encrypted backup bytes'), id = '90f95990-a8ec-4db3-b763-b8a1f63a78ab';
 const digest=createHash('sha256').update(ciphertext).digest('hex');
 const snapshot = { format:'kavosh-database-verification-v1',schemaRevision:396,tables:[{schema:'public',name:'signature_ingest_limits',fingerprint:{rows:1,sha256:'a'.repeat(64)}}],relations:{rows:1,sha256:'b'.repeat(64)},functions:{rows:1,sha256:'c'.repeat(64)},policies:{rows:1,sha256:'d'.repeat(64)},sequenceValuesCovered:false,globalRolesCovered:false };
 const verification={archiveSha256:digest,snapshot,...clusterProof?{cluster:{databaseAccess:{rows:1,sha256:'e'.repeat(64)},globalRoleProperties:{rows:30,sha256:'f'.repeat(64)}}}:{}};
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
   if (command.includes('latest.json')||command.includes('delivery-status.json')) return Buffer.from(JSON.stringify({ localBackup: backup, offsiteCopy: { independentCopyVerified: true, ciphertextSha256: backup.ciphertextSha256 },snapshotBaselineOffsiteVerified:!missingProof,verificationOffsiteCopy:{independentCopyVerified:true,ciphertextSha256:backup.verificationArchive.ciphertextSha256} }));
   if (command.includes('databaseVerificationSnapshot')) {
    const value = structuredClone(snapshot);
    if (mismatch) value.tables[0].fingerprint.sha256='PRIVATE_NEVER_LOG_HASH';
    return Buffer.from(JSON.stringify(value));
   }
   return Buffer.from(command.includes('datconnlimit') ? '0' : '');
  }, spawnSync: () => ({ status: restoreFails ? 1 : 0 })
 };
 runInNewContext('process.argv='+JSON.stringify(['node','script',...args])+';\n'+source, context);
 return { logs, commands, removed, exitCode: context.process.exitCode };
}
test('cluster baseline verification authenticates both independent archives without issuing any SQL or restore command',()=>{
 const args=['--verify-cluster-baseline','90f95990-a8ec-4db3-b763-b8a1f63a78ab'],r=run({clusterProof:true,args});assert.equal(r.exitCode,undefined,JSON.stringify(r.logs));const receipt=JSON.parse(r.logs.at(-1));assert.equal(receipt.exactSnapshotClusterBaselineAuthenticated,true);assert.equal(receipt.actualIsolatedPostgresRestoreVerified,false);assert.equal(r.commands.filter(([bin])=>bin==='/usr/bin/ssh').length,1);assert.equal(r.commands.filter(([bin])=>bin==='/opt/homebrew/bin/rclone').length,2);assert.equal(r.removed.length,5);
 for(const options of [{args},{clusterProof:true,args:['--verify-cluster-baseline']},{clusterProof:true,args,proofDecryptFails:true}]){const bad=run(options);assert.equal(bad.exitCode,1);assert.ok(!bad.commands.some(([_,a])=>/CREATE DATABASE|pg_restore|psql/.test(a.at(-1))));assert.ok(!bad.logs.some(line=>line.includes('exactSnapshotClusterBaselineAuthenticated')));}
});
test('restore verifier accepts only complete equality and removes its isolated target and temporary files', () => {
 const r = run(); assert.equal(r.exitCode, undefined, JSON.stringify(r.logs)); assert.equal(JSON.parse(r.logs.at(-1)).actualIsolatedPostgresRestoreVerified, true);
 assert.ok(r.commands.some(([_, args]) => args.at(-1).includes('DROP DATABASE "kavosh_recovery_90f95990a8ec4db3b763b8a1f63a78ab"'))); assert.equal(r.removed.length, 5);
 assert.equal(JSON.parse(r.logs.at(-1)).originalExportedSnapshotMatched,true);assert.ok(!r.commands.some(([_,args])=>args.at(-1).includes('-d kavosh_one ')));assert.equal(r.commands.filter(([binary])=>binary==='/opt/homebrew/bin/rclone').length,2);
});
test('explicit recovery selection uses only a validated backup-owned receipt and rejects path or identity substitution',()=>{
 const id='90f95990-a8ec-4db3-b763-b8a1f63a78ab',r=run({args:['--execute',id]});assert.equal(r.exitCode,undefined);assert.ok(r.commands[0][1].at(-1).endsWith('/backup-'+id+'/delivery-status.json'));
 for(const args of [['--execute','../../private'],['--execute',id,'extra'],['--execute','90f95990-a8ec-4db3-b763-b8a1f63a78ac']]){const bad=run({args});assert.equal(bad.exitCode,1);assert.ok(!bad.commands.some(([_,a])=>a.at(-1).includes('CREATE DATABASE')));if(args[1]==='../../private'||args.length>2)assert.equal(bad.commands.length,0);}
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
test('synthetic media cloud verifier binds catalog scope,ciphertext and exact bytes without exposing keys or changing remote files',()=>{
 const script=readFileSync(new URL('../scripts/verify-media-storage-probe.mjs',import.meta.url),'utf8').replace(/^import .*;\n/gm,'');
 function check(mode='normal'){
  const id='90f95990-a8ec-4db3-b763-b8a1f63a78ab',otherId='aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa',cipher=Buffer.from('age-encryption.org/v1\nSYNTHETIC_PROBE_CIPHERTEXT'),sha=createHash('sha256').update(cipher).digest('hex'),expected=Buffer.from('Kavosh One production storage verification. Synthetic bytes only;no personal or financial data.\n'.repeat(8));
  const header={type:'header',format:'kavosh-media-catalog-v1',id,academyId:otherId,targets:[{stage:'quarantine',storageTargetId:'a'.repeat(64)},{stage:'clean',storageTargetId:'b'.repeat(64)}]},entries=header.targets.map((t,index)=>({type:'object',id:index?otherId:id,source:{academyId:otherId,fileId:id,stage:t.stage,storageTargetId:mode==='scope'?'c'.repeat(64):t.storageTargetId,bytes:expected.length,sha256:createHash('sha256').update(expected).digest('hex')},archive:{filename:'media.bin.age',ciphertextSha256:sha,encryptedBytes:cipher.length},offsite:{independentCopyVerified:true}}));
  const lines=[header,...entries,{type:'complete',objects:2,sourceBytes:expected.length*2,matchingFinalInventory:true,atomicStorageSnapshot:false}],files=new Map(),fds=new Map(),logs=[],commands=[],removed=[];let nextFd=10;
  const context={assert:{...assert,deepEqual:(a,b)=>assert.deepEqual(structuredClone(a),structuredClone(b))},Buffer,JSON,createHash,join,process:{platform:'darwin',argv:[],env:{},umask(){}},console:{log:v=>logs.push(v),error:v=>logs.push(v)},mkdtempSync:()=>'/private/tmp/synthetic-media-proof',openSync:(file,flag,permissions)=>{assert.equal(flag,'wx');assert.equal(permissions,0o600);assert.ok(!files.has(file));files.set(file,Buffer.alloc(0));fds.set(nextFd,file);return nextFd++;},closeSync:()=>{},writeFileSync:(fd,bytes)=>files.set(fds.get(fd),Buffer.from(bytes)),readFileSync:(file,encoding)=>encoding?files.get(file).toString():files.get(file),unlinkSync:file=>{removed.push(file);files.delete(file);},rmdirSync:file=>removed.push(file),execFileSync:(binary,args,options={})=>{
   commands.push([binary,args]);if(binary==='/usr/bin/security')return Buffer.from(JSON.stringify(args.includes('kavosh-one-production-backup-recovery')?{identity:'PRIVATE_PROBE_KEY'}:{token:{scope:'https://www.googleapis.com/auth/drive.file'}}));
   if(binary==='/opt/homebrew/bin/rclone'){assert.equal(args[0],'cat');assert.equal(options.maxBuffer,cipher.length);return Buffer.from(cipher);}
   assert.equal(binary,'/opt/homebrew/bin/age');assert.equal(options.input,'PRIVATE_PROBE_KEY');const output=options.stdio[1];files.set(fds.get(output),args.at(-1).includes('catalog.age')?Buffer.from((mode==='catalog'?lines.slice(0,3):lines).map(line=>JSON.stringify(line)).join('\n')+'\n'):Buffer.from(mode==='media'?'WRONG_SYNTHETIC_MEDIA':expected));return Buffer.alloc(0);
  }};
  const args=mode==='path'?['--execute','../../private',sha,String(cipher.length)]:['--execute',id,mode==='hash'?'0'.repeat(64):sha,String(cipher.length)];runInNewContext('process.argv='+JSON.stringify(['node','script',...args])+';\n'+script,context);
  assert.doesNotMatch(logs.join(''),/PRIVATE_PROBE_KEY|WRONG_SYNTHETIC_MEDIA/);assert.ok(!JSON.stringify(commands).includes('PRIVATE_PROBE_KEY'));assert.equal(files.size,0);return{logs,commands,removed,exitCode:context.process.exitCode};
 }
 const good=check();assert.equal(good.exitCode,undefined,JSON.stringify(good.logs));assert.equal(JSON.parse(good.logs[0]).syntheticObjectsVerified,2);assert.equal(good.removed.length,7);
 for(const mode of ['path','hash','catalog','scope','media']){const bad=check(mode);assert.equal(bad.exitCode,1,mode);assert.ok(!bad.logs.some(line=>line.includes('authenticatedCatalogAndMediaDecryption')));if(mode==='path')assert.equal(bad.commands.length,0);}
});
