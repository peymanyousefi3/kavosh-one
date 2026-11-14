import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,realpath,writeFile,readFile,readdir,unlink,rmdir,lstat,chmod,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {Readable} from 'node:stream';
import {recoverMediaObject} from '../src/operations/media-recovery.ts';
import {encryptRecoveryStream,decryptRecoveryStream} from '../src/operations/database-backups.ts';

const run=promisify(execFile),digest=(b:Buffer)=>createHash('sha256').update(b).digest('hex');
test('offline media recovery rejects malformed inputs before reading files',async()=>{
 await assert.rejects(recoverMediaObject({}),{code:'INVALID_MEDIA_RECOVERY_CONFIGURATION'});
 const prefix=process.env.RECOVERY_COMPILED_CLI?[process.env.RECOVERY_COMPILED_CLI]:['--import','tsx','scripts/database-recovery.ts'];
 await assert.rejects(run(process.execPath,[...prefix,'recover-media','/private/absent.age','a'.repeat(64),'42'],{env:{PATH:process.env.PATH,NODE_ENV:'test',MEDIA_RECOVERY_SOURCE_JSON:'PRIVATE_INVALID_CONFIGURATION'},timeout:5000}),error=>{const r=error as Error&{stdout:string;stderr:string};assert.equal(r.stdout,'');assert.equal(r.stderr.trim(),'INVALID_MEDIA_RECOVERY_CONFIGURATION');return true;});
});
test('actual offline media recovery authenticates the entire archive and exact bytes,never modifies source and cleans failures',{
 skip:!process.env.AGE_BIN||!process.env.AGE_KEYGEN_BIN
},async()=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'kavosh-media-recovery-test-'))),identity=join(root,'identity.txt'),wrongIdentity=join(root,'wrong.txt'),archive=join(root,'source.age'),source=Buffer.from('PRIVATE_RECOVERY_MEDIA_'.repeat(100000));
 const recovered:string[]=[];
 try{
  await run(process.env.AGE_KEYGEN_BIN!,['--output',identity]);await run(process.env.AGE_KEYGEN_BIN!,['--output',wrongIdentity]);const recipient=(await run(process.env.AGE_KEYGEN_BIN!,['-y',identity])).stdout.trim();
  const encrypted=await encryptRecoveryStream({age:process.env.AGE_BIN,recipient,file:archive,maximumBytes:source.length+65536},Readable.from([source]),AbortSignal.timeout(10000)),original=await readFile(archive);
  const metadata={academyId:'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa',fileId:'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb',stage:'clean',storageTargetId:'c'.repeat(64),bytes:source.length,sha256:digest(source)},input={age:process.env.AGE_BIN,identityFile:identity,archive,workDirectory:root,source:metadata,expectedSha256:encrypted.ciphertextSha256,expectedBytes:encrypted.encryptedBytes};
  await assert.rejects(recoverMediaObject(input,AbortSignal.abort()),{code:'RECOVERY_CANCELLED'});
  const result=await recoverMediaObject(input);recovered.push(result.file,result.manifest);assert.deepEqual(await readFile(result.file),source);assert.equal(result.authenticatedDecryption,true);assert.equal(result.exactContentVerified,true);assert.equal(result.applicationActivationAllowed,false);assert.equal(result.completeMediaRestore,false);assert.equal((await lstat(result.file)).mode&0o777,0o600);assert.equal((await lstat(dirname(result.file))).mode&0o777,0o700);assert.deepEqual((await readdir(dirname(result.file))).sort(),['manifest.json','media.bin']);assert.doesNotMatch(await readFile(result.manifest,'utf8'),/AGE-SECRET|PRIVATE_RECOVERY_MEDIA/);
  if(process.env.RECOVERY_COMPILED_CLI){const command=await run(process.execPath,[process.env.RECOVERY_COMPILED_CLI,'recover-media',archive,input.expectedSha256,String(input.expectedBytes)],{env:{PATH:process.env.PATH,NODE_ENV:'test',AGE_BIN:process.env.AGE_BIN,RESTORE_AGE_IDENTITY_FILE:identity,RECOVERY_WORK_DIRECTORY:root,MEDIA_RECOVERY_SOURCE_JSON:JSON.stringify(metadata)},timeout:10000});assert.equal(command.stderr,'');const restored=JSON.parse(command.stdout);recovered.push(restored.file,restored.manifest);assert.deepEqual(await readFile(restored.file),source);assert.equal(restored.applicationActivationAllowed,false);assert.equal(restored.sourceOrRemoteObjectsModified,false);assert.doesNotMatch(command.stdout,/AGE-SECRET|PRIVATE_RECOVERY_MEDIA/);}
  const before=await readdir(root);
  for(const patch of [{expectedSha256:'0'.repeat(64)},{expectedBytes:encrypted.encryptedBytes-1},{identityFile:wrongIdentity},{source:{...metadata,bytes:source.length-1}},{source:{...metadata,bytes:source.length+1}},{source:{...metadata,sha256:'0'.repeat(64)}}]){
   await assert.rejects(recoverMediaObject({...input,...patch}));assert.deepEqual(await readdir(root),before);assert.deepEqual(await readFile(archive),original);
  }
  await chmod(identity,0o644);await assert.rejects(recoverMediaObject(input),{code:'UNSAFE_RECOVERY_FILE'});await chmod(identity,0o600);
  const alias=join(root,'alias.age');await symlink(archive,alias);try{await assert.rejects(recoverMediaObject({...input,archive:alias}),{code:'UNSAFE_RECOVERY_FILE'});}finally{await unlink(alias);}
  const invalidKey=join(root,'plugin.txt');await writeFile(invalidKey,'AGE-PLUGIN-SYNTHETIC-1\n',{mode:0o600});try{await assert.rejects(recoverMediaObject({...input,identityFile:invalidKey}),{code:'UNSAFE_RECOVERY_IDENTITY'});}finally{await unlink(invalidKey);}
  const corrupt=join(root,'corrupt.age'),truncated=original.subarray(0,-20);await writeFile(corrupt,truncated,{mode:0o600});try{await assert.rejects(recoverMediaObject({...input,archive:corrupt,expectedBytes:truncated.length,expectedSha256:digest(truncated)}));}finally{await unlink(corrupt);}assert.deepEqual(await readdir(root),before);
  const conflict=join(root,'keep.bin');await writeFile(conflict,'KEEP_EXISTING_FILE',{mode:0o600});try{await assert.rejects(decryptRecoveryStream({age:process.env.AGE_BIN,identityFile:identity,file:conflict,expectedBytes:source.length,expectedSha256:digest(source)},Readable.from([original]),AbortSignal.timeout(10000)));assert.equal(await readFile(conflict,'utf8'),'KEEP_EXISTING_FILE');}finally{await unlink(conflict);}
 }finally{for(const file of recovered)await unlink(file);for(const folder of new Set(recovered.map(dirname)))await rmdir(folder);for(const file of [identity,wrongIdentity,archive])await unlink(file).catch(()=>{});await rmdir(root);}
});
