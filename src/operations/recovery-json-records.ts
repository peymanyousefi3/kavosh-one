import {createHash} from 'node:crypto';
import type {FileHandle} from 'node:fs/promises';
import {RecoveryError} from './recovery-error.ts';

// Re-readable bounded metadata passes over the same authenticated private file.
export async function authenticatedRecoveryRecords(file:FileHandle,proof:{bytes:number;sha256:string},maximumBytes:number,signal:AbortSignal){
 const original=await file.stat();
 return async function*(){
  const buffer=Buffer.alloc(65536),hash=createHash('sha256');let pending=Buffer.alloc(0),position=0;
  while(true){if(signal.aborted)throw new RecoveryError('RECOVERY_CANCELLED');const {bytesRead}=await file.read(buffer,0,buffer.length,position);if(!bytesRead)break;position+=bytesRead;if(position>maximumBytes)throw new RecoveryError('MEDIA_CATALOG_SIZE_LIMIT');hash.update(buffer.subarray(0,bytesRead));pending=Buffer.concat([pending,buffer.subarray(0,bytesRead)]);let end:number;while((end=pending.indexOf(10))!==-1){if(!end||end>65536)throw new RecoveryError('INVALID_MEDIA_RECOVERY_CATALOG');yield JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(pending.subarray(0,end)));pending=pending.subarray(end+1);}if(pending.length>65536)throw new RecoveryError('INVALID_MEDIA_RECOVERY_CATALOG');}
  const after=await file.stat();if(pending.length||position!==proof.bytes||hash.digest('hex')!==proof.sha256||after.size!==original.size||after.mtimeMs!==original.mtimeMs||after.ctimeMs!==original.ctimeMs||after.nlink!==1)throw new RecoveryError('MEDIA_RECOVERY_CATALOG_CHANGED');
 };
}
