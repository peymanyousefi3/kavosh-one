// Explicit synthetic-only storage acceptance. No DB,BoldSign,people or actual
// agreements. Retain generated immutable probe artifacts;never delete objects.
import assert from 'node:assert/strict';
import {readFileSync,lstatSync} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
const runtime='/srv/kavosh-one/operations/signature-completion-v1';
let phase='isolated configuration';
try{
 assert.deepEqual(process.argv.slice(2),['--execute']);assert.notEqual(process.getuid?.(),0);
 const directory=lstatSync(runtime);assert.ok(directory.isDirectory()&&!directory.isSymbolicLink()&&directory.uid===0&&(directory.mode&0o022)===0);
 phase='private service credential metadata';
 const credentialDirectory=process.env.CREDENTIALS_DIRECTORY;assert.ok(credentialDirectory?.startsWith('/run/credentials/'));
 // This host exposes systemd credentials as root:root0440 with per-service
 // access controls,not as ordinary files owned by the service group.
 const path=credentialDirectory+'/vault.json',metadata=lstatSync(path),parent=lstatSync(credentialDirectory);
 assert.ok(parent.isDirectory()&&!parent.isSymbolicLink()&&parent.uid===0&&parent.gid===0&&[0o500,0o550].includes(parent.mode&0o777));
 assert.ok(metadata.isFile()&&!metadata.isSymbolicLink()&&metadata.nlink===1&&metadata.uid===0&&metadata.gid===0&&[0o400,0o440].includes(metadata.mode&0o777)&&metadata.size<16384);
 phase='accepted storage modules';
 const {r2Connection,r2TargetId}=await import(runtime+'/src/integrations/r2-config.js'),{retainSignatureEvidence}=await import(runtime+'/src/integrations/signature-evidence-storage.js');
 phase='exact private archive connection';
 const raw=readFileSync(path);let config;try{config=r2Connection.parse(JSON.parse(raw.toString()));}finally{raw.fill(0);}
 assert.equal(config.bucket,'kavosh-one-production-agreements');assert.equal(config.accountId,'e7bedfa4c49de9507c44d118e5b20dc9');assert.equal(config.jurisdiction,'default');assert.equal(config.maximumUploadBytes,10485760);
 const hash=value=>createHash('sha256').update(value).digest('hex'),artifact=text=>{const bytes=Buffer.from(text);return{bytes,sizeBytes:bytes.length,sha256:hash(bytes)};};
 const source={academyId:randomUUID(),startId:randomUUID(),signerId:randomUUID(),documentId:randomUUID(),packageId:randomUUID(),attachmentId:randomUUID(),bindingId:randomUUID(),connectionId:randomUUID(),connectionTargetId:hash('Synthetic target,not a BoldSign connection'),documentSha256:hash('Synthetic source,not an agreement'),sourceFingerprint:hash(randomUUID()),region:'CA',signatureFields:[{id:'SyntheticSignature',pageNumber:1,bounds:{x:20,y:40,width:180,height:35}}]};
 const evidence={document:artifact('Kavosh One synthetic storage probe: not a signed document.\n'),audit:artifact('Kavosh One synthetic audit probe: not a signing certificate.\n'),properties:artifact('{"synthetic":true,"realPeople":false}')},targetId=r2TargetId(config);
 phase='conditional artifact writes and complete read-back';
 const first=await retainSignatureEvidence(config,source,evidence,{targetId,timeoutMs:30000});assert.equal(first.bytesReadBackVerified,true);assert.equal(first.admissionCleared,false);
 for(const kind of ['document','audit','properties']){assert.equal(first.receipt[kind].sha256,evidence[kind].sha256);assert.equal(first.receipt[kind].sizeBytes,evidence[kind].sizeBytes);}
 phase='same-source create-once replay';
 const repeated=await retainSignatureEvidence(config,source,evidence,{targetId,timeoutMs:30000});assert.deepEqual(repeated.receipt,first.receipt);assert.deepEqual(repeated.etags,first.etags);
 phase='other-bucket access denial';
 const {S3Client,HeadObjectCommand}=createRequire(runtime+'/package.json')('@aws-sdk/client-s3'),endpoint=`https://${config.accountId}.r2.cloudflarestorage.com`,client=new S3Client({endpoint,region:'auto',forcePathStyle:true,maxAttempts:1,credentials:{accessKeyId:config.accessKeyId,secretAccessKey:config.secretAccessKey}});
 try{for(const bucket of ['kavosh-one-production-clean','kavosh-one-production-quarantine']){let status;try{await client.send(new HeadObjectCommand({Bucket:bucket,Key:'kavosh-one-agreement-vault-permission-probe'}),{abortSignal:AbortSignal.timeout(10000)});}catch(e){status=e?.$metadata?.httpStatusCode;}assert.equal(status,403);}}finally{client.destroy();}
 phase='anonymous download denial';
 const anonymous=await fetch(`${endpoint}/${config.bucket}/academies/${source.academyId}/signature-evidence/${first.receipt.document.id}`,{redirect:'error',signal:AbortSignal.timeout(10000)});assert.ok([400,403].includes(anonymous.status));await anonymous.body?.cancel();
 console.log(JSON.stringify({storage:'live_cloudflare_r2',storageTargetId:targetId,syntheticAcademyId:source.academyId,receipt:first.receipt,etags:first.etags,completeByteReadBackVerified:true,createOnceReplayVerified:true,otherProductionBucketsDenied:2,anonymousReadDenied:true,syntheticArtifactsRetained:3,existingObjectsChanged:0,providerRequests:0,databaseRequests:0,realPeopleUsed:false,agreementBackupVerified:false,scope:'Storage and actual restricted IAM only;not agreement ingestion,malware inspection,legal validity,backup recovery or full backend completion.'}));
}catch{console.error('SIGNATURE_VAULT_ACCEPTANCE_FAILED: '+phase);process.exitCode=1;}
