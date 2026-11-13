import {lstat,realpath,open} from 'node:fs/promises';
import {constants} from 'node:fs';
import {resolve} from 'node:path';
import {RecoveryError} from './recovery-error.ts';
export async function privateDirectory(p:string){
 const s=await lstat(p);if(!s.isDirectory()||s.isSymbolicLink()||s.uid!==process.getuid?.()||(s.mode&0o077)!==0||await realpath(p)!==resolve(p))throw new RecoveryError('PRIVATE_RECOVERY_DIRECTORY_REQUIRED');
}
export async function regularFile(p:string,privateKey=false){
 const s=await lstat(p);if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1||privateKey&&(s.uid!==process.getuid?.()||(s.mode&0o077)!==0))throw new RecoveryError('UNSAFE_RECOVERY_FILE');return s;
}
export async function nativeRecoveryIdentity(path:string){
 const before=await regularFile(path,true);if(before.size>65536)throw new RecoveryError('UNSAFE_RECOVERY_IDENTITY');
 const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);let bytes:Buffer|undefined;
 try{const actual=await file.stat();if(actual.ino!==before.ino||actual.dev!==before.dev||actual.size!==before.size)throw new RecoveryError('UNSAFE_RECOVERY_IDENTITY');bytes=Buffer.alloc(65537);const {bytesRead}=await file.read(bytes,0,bytes.length,0);if(bytesRead!==before.size)throw new RecoveryError('UNSAFE_RECOVERY_IDENTITY');const lines=bytes.subarray(0,bytesRead).toString('utf8').split(/\r?\n/).filter(line=>line.trim()&&!line.startsWith('#'));if(!lines.length||lines.some(line=>!/^AGE-SECRET-KEY-1[0-9A-Z]+$/.test(line)))throw new RecoveryError('UNSAFE_RECOVERY_IDENTITY');}
 finally{bytes?.fill(0);await file.close();}
}
