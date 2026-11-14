import {createHash} from 'node:crypto';
import {constants} from 'node:fs';
import {mkdir,open,unlink} from 'node:fs/promises';
import {join} from 'node:path';
import {z} from 'zod';
import {RecoveryError} from './recovery-error.ts';
import {privateDirectory,regularFile} from './recovery-files.ts';
import {recordedMediaReference} from './media-reference-plan.ts';

const sourceSchema=recordedMediaReference.extend({etag:z.string().min(3).max(202).regex(/^"[\x21\x23-\x7e]+"$/),modifiedAt:z.iso.datetime()}),versionSchema=sourceSchema.omit({sha256:true});
const pointerSchema=z.object({format:z.literal('kavosh-media-reuse-pointer-v1'),archiveId:z.string().uuid(),version:z.string().regex(/^[a-f0-9]{64}$/),recipient:z.string().min(1).max(100)}).strict();
const manifestSchema=z.object({format:z.literal('kavosh-media-object-backup-v1'),id:z.string().uuid(),source:sourceSchema,archive:z.object({filename:z.literal('media.bin.age'),ciphertextSha256:z.string().regex(/^[a-f0-9]{64}$/),encryptedBytes:z.number().int().min(22).max(4296146944)}).strict()});
const cacheDirectory=(directory:string)=>join(directory,'media-reuse-index');
function version(source:z.infer<typeof versionSchema>,recipient:string){return createHash('sha256').update(JSON.stringify([source.academyId,source.stage,source.storageTargetId,source.fileId,source.bytes,source.etag,source.modifiedAt,recipient])).digest('hex');}
async function readJson(path:string){
 const before=await regularFile(path,true);if(before.size>4096)throw new RecoveryError('MEDIA_ARCHIVE_REUSE_INVALID');const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW),buffer=Buffer.alloc(4097);
 try{const current=await file.stat();if(current.ino!==before.ino||current.dev!==before.dev||current.size!==before.size||current.nlink!==1)throw new RecoveryError('MEDIA_ARCHIVE_REUSE_INVALID');const {bytesRead}=await file.read(buffer,0,buffer.length,0);if(bytesRead!==before.size)throw new RecoveryError('MEDIA_ARCHIVE_REUSE_INVALID');return JSON.parse(buffer.subarray(0,bytesRead).toString('utf8'));}finally{buffer.fill(0);await file.close();}
}
export async function prepareMediaArchiveReuse(directory:string){
 const cache=cacheDirectory(directory);try{await mkdir(cache,{mode:0o700});}catch(error){if((error as {code?:string}).code!=='EEXIST')throw error;}await privateDirectory(cache);
}
// Direct per-version lookup: no bucket-sized map,directory scan or plaintext
// media index. Existing private object manifests remain the metadata source.
// Strong quoted provider ETag,exact length/date/location and recipient must all
// match. Every reused ciphertext is freshly hashed,not trusted from a pointer.
export async function findReusableMediaArchive(directory:string,raw:unknown,recipient:string,signal:AbortSignal){
 const source=versionSchema.parse(raw),key=version(source,recipient);let pointer;
 try{pointer=await readJson(join(cacheDirectory(directory),key+'.json'));}catch(error){if((error as {code?:string}).code==='ENOENT')return null;throw new RecoveryError('MEDIA_ARCHIVE_REUSE_INVALID');}
 try{
  if(signal.aborted)throw new RecoveryError('RECOVERY_CANCELLED');const parsed=pointerSchema.parse(pointer);if(parsed.version!==key||parsed.recipient!==recipient)throw new RecoveryError('MEDIA_ARCHIVE_REUSE_INVALID');
  const folder=join(directory,'media-'+parsed.archiveId);await privateDirectory(folder);const manifest=manifestSchema.parse(await readJson(join(folder,'manifest.json')));if(manifest.id!==parsed.archiveId||version(manifest.source,recipient)!==key)throw new RecoveryError('MEDIA_ARCHIVE_REUSE_INVALID');
  const archivePath=join(folder,'media.bin.age'),before=await regularFile(archivePath,true);if(before.size!==manifest.archive.encryptedBytes)throw new RecoveryError('MEDIA_ARCHIVE_REUSE_INVALID');
  const file=await open(archivePath,constants.O_RDONLY|constants.O_NOFOLLOW),hash=createHash('sha256');let bytes=0,header=Buffer.alloc(0);
  try{
   const initial=await file.stat();if(initial.ino!==before.ino||initial.dev!==before.dev||initial.size!==before.size||initial.nlink!==1)throw new RecoveryError('MEDIA_ARCHIVE_REUSE_INVALID');
   for await(const chunk of file.createReadStream({autoClose:false})){if(signal.aborted)throw new RecoveryError('RECOVERY_CANCELLED');bytes+=chunk.length;if(bytes>manifest.archive.encryptedBytes)throw new RecoveryError('MEDIA_ARCHIVE_REUSE_INVALID');if(header.length<22)header=Buffer.concat([header,chunk.subarray(0,22-header.length)]);hash.update(chunk);}
   const after=await file.stat();if(after.size!==initial.size||after.mtimeMs!==initial.mtimeMs||after.ctimeMs!==initial.ctimeMs||after.nlink!==1||bytes!==manifest.archive.encryptedBytes||hash.digest('hex')!==manifest.archive.ciphertextSha256||header.toString()!=='age-encryption.org/v1\n')throw new RecoveryError('MEDIA_ARCHIVE_REUSE_INVALID');
  }finally{await file.close();}
  if(signal.aborted)throw new RecoveryError('RECOVERY_CANCELLED');return{id:manifest.id,source:manifest.source,archive:manifest.archive,archivePath};
 }catch(error){if(error instanceof RecoveryError)throw error;throw new RecoveryError('MEDIA_ARCHIVE_REUSE_INVALID');}
}
export async function rememberMediaArchive(directory:string,source:unknown,recipient:string,archiveId:string){
 const value=versionSchema.parse(source),key=version(value,recipient),pointer=pointerSchema.parse({format:'kavosh-media-reuse-pointer-v1',archiveId,version:key,recipient}),cache=cacheDirectory(directory),path=join(cache,key+'.json'),file=await open(path,'wx',0o600);let success=false;
 try{await file.writeFile(JSON.stringify(pointer)+'\n');await file.sync();success=true;}finally{await file.close();if(!success)await unlink(path);}
 const folder=await open(cache,'r');try{await folder.sync();}finally{await folder.close();}
}
