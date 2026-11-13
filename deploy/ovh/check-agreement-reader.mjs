// Explicit synthetic-only IAM acceptance;no DB,real agreements or deletion.
import assert from 'node:assert/strict';
import {readFileSync,lstatSync} from 'node:fs';
import {userInfo} from 'node:os';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
const runtime='/srv/kavosh-one/operations/signature-completion-v1';let phase='explicit isolated execution';
try{
 assert.deepEqual(process.argv.slice(2),['--execute']);assert.equal(userInfo().username,'kavosh-one-backup');assert.notEqual(process.getuid(),0);
 const directory=process.env.CREDENTIALS_DIRECTORY;assert.ok(directory?.startsWith('/run/credentials/'));const path=directory+'/reader.json',s=lstatSync(path);assert.ok(s.isFile()&&!s.isSymbolicLink()&&s.uid===0&&s.gid===0&&s.nlink===1&&[0o400,0o440].includes(s.mode&0o777)&&s.size<16384);
 const {r2Connection,r2TargetId}=await import(runtime+'/src/integrations/r2-config.js'),{privateR2}=await import(runtime+'/src/integrations/r2.js');const bytes=readFileSync(path);let c;try{c=r2Connection.parse(JSON.parse(bytes));}finally{bytes.fill(0);}
 assert.equal(c.accountId,'e7bedfa4c49de9507c44d118e5b20dc9');assert.equal(c.bucket,'kavosh-one-production-agreements');assert.equal(c.jurisdiction,'default');assert.equal(r2TargetId(c),'c7f8e858b624bebc7b8ccf70e6f44b066a3de9fe0aa0037f1c768ecdfbaab61a');
 const academy='22ecdcaf-d64d-4b75-a476-d15f7c037f02',objects=[['95d50dd2-2fcd-8e48-be97-ebb8ffcfdc85',59,'849d12062b500260a81fe4eb8e29545a297440ecf31084ddf5b4a174be1ced14'],['fd472721-1a79-8e04-ac45-e4ae0ac803de',61,'016a627adac677fe8e9ac9bb618f3443033c7b876d0ddcc3753d1b085a7530f0'],['1860fe9f-af6e-8390-ab8b-d73f4611c992',37,'1fa997122f62057aef96a5a29fa040aaf31ec85d72504ec258f508ecf4f13544']],store=privateR2(c,academy);
 phase='complete retained synthetic byte reads';try{for(const [id,bytes,sha256]of objects){const r=await store.inspectSignatureEvidence(id,{bytes,sha256},async source=>{for await(const chunk of source)assert.ok(chunk.length>0);return true;},15000);assert.equal(r.bytes,bytes);assert.equal(r.sha256,sha256);}}finally{store.close();}
 const {S3Client,HeadObjectCommand,PutObjectCommand}=createRequire(runtime+'/package.json')('@aws-sdk/client-s3'),client=new S3Client({endpoint:`https://${c.accountId}.r2.cloudflarestorage.com`,region:'auto',forcePathStyle:true,maxAttempts:1,credentials:{accessKeyId:c.accessKeyId,secretAccessKey:c.secretAccessKey}});
 try{
  phase='other production bucket denial';for(const Bucket of ['kavosh-one-production-clean','kavosh-one-production-quarantine']){let status;try{await client.send(new HeadObjectCommand({Bucket,Key:'synthetic-reader-permission-probe'}),{abortSignal:AbortSignal.timeout(10000)});}catch(e){status=e?.$metadata?.httpStatusCode;}assert.equal(status,403);}
  phase='create-only synthetic write denial';let status;try{await client.send(new PutObjectCommand({Bucket:c.bucket,Key:`academies/${academy}/signature-evidence/${randomUUID()}`,Body:Buffer.from('Synthetic IAM denial probe;not an agreement.'),IfNoneMatch:'*'}),{abortSignal:AbortSignal.timeout(10000)});}catch(e){status=e?.$metadata?.httpStatusCode;}assert.equal(status,403);
 }finally{client.destroy();}
 console.log(JSON.stringify({storage:'live_cloudflare_r2',syntheticArtifactsReadAndHashVerified:3,sourceBytesVerified:157,otherProductionBucketsDenied:2,createOnlyWriteDenied:true,deleteRequests:0,realAgreementsAccessed:0,databaseRequests:0,providerRequests:0,activeBackupConfigurationChanged:false,agreementByteBackupVerified:false}));
}catch{console.error('AGREEMENT_READER_ACCEPTANCE_FAILED: '+phase);process.exitCode=1;}
