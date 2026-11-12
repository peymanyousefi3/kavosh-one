// One tiny valid/corrupt synthetic PNG pair. No academy file/attendance/person
// records or media publication. Root uploads/removes only this private receipt's
// successfully created objects; the actual unprivileged worker only reads them.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync,lstatSync,chownSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {randomUUID,createHash} from 'node:crypto';
import {z} from 'zod';
import {S3Client,DeleteObjectCommand,HeadObjectCommand} from '@aws-sdk/client-s3';
import {privateR2} from '../../src/integrations/r2.ts';
import {r2Connection,r2TargetId} from '../../src/integrations/r2-config.ts';
import {inspectStoredFile} from '../../src/files/inspection-worker.ts';
const uuid=z.string().uuid(),digest=z.string().regex(/^[a-f0-9]{64}$/),manifest=z.object({kind:z.literal('kavosh-one-synthetic-inspection-v1'),academyId:uuid,storageTargetId:digest,files:z.array(z.object({fileId:uuid,bytes:z.number().int().min(1).max(8192),sha256:digest,uploaded:z.boolean()}).strict()).length(2)}).strict();
const directory='/var/lib/kavosh-one-file-acceptance',path=directory+'/probes.json';
let phase='arguments',client:S3Client|undefined,adapter:ReturnType<typeof privateR2>|undefined;
try{
 const action=process.argv[2];assert.equal(process.argv.length,3);assert.ok(['--prepare','--inspect','--cleanup'].includes(action));assert.notEqual(process.env.NODE_TLS_REJECT_UNAUTHORIZED,'0');
 if(action==='--prepare'){
  assert.equal(process.getuid?.(),0);phase='new private synthetic receipt';mkdirSync(directory,{mode:0o750});
  const group=execFileSync('/usr/bin/getent',['group','kavosh-one-inspection'],{encoding:'utf8'}).trim().split(':');assert.equal(group[0],'kavosh-one-inspection');const gid=Number(group[2]);assert.ok(Number.isSafeInteger(gid)&&gid>0);chownSync(directory,0,gid);
  const academy=JSON.parse(readFileSync('/etc/kavosh-one/initial-academy.json','utf8')),configuration=r2Connection.parse(JSON.parse(readFileSync('/etc/kavosh-one/r2-upload.json','utf8')));assert.equal(configuration.bucket,'kavosh-one-production-quarantine');
  const encoded=execFileSync('/usr/bin/podman',['exec','kavosh-one-parser-image','/usr/bin/env','-i','NODE_ENV=production','TZ=UTC','PATH=/usr/bin:/bin','/usr/bin/node','--input-type=module','-e',"import sharp from 'sharp';const b=await sharp({create:{width:8,height:4,channels:3,background:'red'}}).png().toBuffer();process.stdout.write(b.toString('base64'));"],{encoding:'utf8',timeout:5000,maxBuffer:8192});
  const good=Buffer.from(encoded,'base64'),bad=Buffer.from(good),at=bad.indexOf('IDAT')+8;assert.ok(at>=8&&at<bad.length);bad[at]^=255;
  const bodies=[good,bad],record=manifest.parse({kind:'kavosh-one-synthetic-inspection-v1',academyId:academy.academyId,storageTargetId:r2TargetId(configuration),files:bodies.map(b=>({fileId:randomUUID(),bytes:b.length,sha256:createHash('sha256').update(b).digest('hex'),uploaded:false}))});
  writeFileSync(path,JSON.stringify(record)+'\n',{mode:0o640,flag:'wx',flush:true});chownSync(path,0,gid);adapter=privateR2(configuration,record.academyId);
  phase='conditional synthetic uploads';for(let i=0;i<2;i++){const f=record.files[i];const grant:{url:string;headers:Record<string,string>;expiresAt:string}=await adapter.quarantineUpload(f.fileId,{contentType:'image/png',bytes:f.bytes},90);const r:Response=await fetch(grant.url,{method:'PUT',headers:grant.headers,body:bodies[i],redirect:'error',signal:AbortSignal.timeout(10000)});assert.equal(r.status,200);await r.body?.cancel();f.uploaded=true;writeFileSync(path,JSON.stringify(record)+'\n',{mode:0o640,flush:true});}
  console.log(JSON.stringify({syntheticObjectsUploaded:2,totalBytes:bodies.reduce((n,b)=>n+b.length,0),realAcademyRecordsChanged:0}));
 }else{
  const s=lstatSync(path);assert.ok(s.isFile()&&!s.isSymbolicLink());assert.equal(s.uid,0);assert.equal(s.mode&0o777,0o640);assert.equal(s.nlink,1);const record=manifest.parse(JSON.parse(readFileSync(path,'utf8')));
  if(action==='--inspect'){
   assert.notEqual(process.getuid?.(),0);phase='combined private storage scanner and image validation';
   const configs=z.array(z.object({academyId:uuid,configuration:r2Connection}).strict()).length(1).parse(JSON.parse(process.env.FILE_INSPECTION_R2_CONNECTIONS!));assert.equal(configs[0].academyId,record.academyId);assert.equal(r2TargetId(configs[0].configuration),record.storageTargetId);assert.ok(record.files.every(f=>f.uploaded));
   const results=[];for(const f of record.files){results.push(await inspectStoredFile({academyId:record.academyId,inspectionId:randomUUID(),fileId:f.fileId,storageTargetId:record.storageTargetId,leaseToken:randomUUID(),attemptNo:1,expectedBytes:f.bytes,expectedSha256:f.sha256,claimedMimeType:'image/png'},id=>id===record.academyId?configs[0].configuration:null,{socketPath:process.env.CLAMD_SOCKET_PATH!,maximumBytes:Number(process.env.FILE_INSPECTION_MAXIMUM_BYTES),timeoutMs:10000},new AbortController().signal,15000,undefined,{socketPath:process.env.FILE_IMAGE_VALIDATION_SOCKET_PATH!},{timeZone:process.env.CLAMD_TIME_ZONE!,maximumAgeSeconds:172800},{socketPath:process.env.FILE_PDF_VALIDATION_SOCKET_PATH!},{socketPath:process.env.FILE_VIDEO_VALIDATION_SOCKET_PATH!}));}
   const good=results[0],bad=results[1];assert.equal(good.outcome,'no_detection');assert.ok(good.outcome==='no_detection'&&good.imageValidation?.outcome==='decoded'&&good.signature?.mime==='image/png'&&good.databaseObservation);
   assert.ok(bad.outcome==='detected'||bad.outcome==='no_detection'&&bad.imageValidation?.outcome==='rejected');
   console.log(JSON.stringify({combinedR2ScannerImagePipelineVerified:true,validSyntheticPngDecoded:true,corruptSyntheticPngRefused:true,objectsInspected:2,filesPublished:0,durableQueueMutationPerformed:false,executedAsUnprivilegedWorker:true}));
  }else{
   assert.equal(process.getuid?.(),0);phase='remove only successfully created synthetic objects';const c=r2Connection.parse(JSON.parse(readFileSync('/etc/kavosh-one/r2-upload.json','utf8')));assert.equal(c.bucket,'kavosh-one-production-quarantine');assert.equal(c.jurisdiction,'default');assert.equal(r2TargetId(c),record.storageTargetId);
   client=new S3Client({endpoint:'https://'+c.accountId+'.r2.cloudflarestorage.com',region:'auto',forcePathStyle:true,followRegionRedirects:false,maxAttempts:1,credentials:{accessKeyId:c.accessKeyId,secretAccessKey:c.secretAccessKey}});
   let removed=0;for(const f of record.files){if(!f.uploaded)continue;await client.send(new DeleteObjectCommand({Bucket:c.bucket,Key:`academies/${record.academyId}/quarantine/${f.fileId}`}),{abortSignal:AbortSignal.timeout(10000)});f.uploaded=false;removed++;writeFileSync(path,JSON.stringify(record)+'\n',{mode:0o640,flush:true});}
   for(const f of record.files){let absent=false;try{await client.send(new HeadObjectCommand({Bucket:c.bucket,Key:`academies/${record.academyId}/quarantine/${f.fileId}`} ),{abortSignal:AbortSignal.timeout(10000)});}catch(e){absent=(e as {$metadata?:{httpStatusCode?:number}}).$metadata?.httpStatusCode===404;}assert.equal(absent,true);}
   console.log(JSON.stringify({ownedSyntheticObjectsRemoved:removed,syntheticObjectsIndependentlyVerifiedAbsent:2,otherObjectsModifiedOrDeleted:0}));
  }
 }
}catch{console.error('FILE_INSPECTION_PROBE_FAILED: '+phase);process.exitCode=1;}
finally{client?.destroy();adapter?.close();}
