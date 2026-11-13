import {lstat,realpath} from 'node:fs/promises';
import {resolve} from 'node:path';
import {RecoveryError} from './recovery-error.ts';
export async function privateDirectory(p:string){
 const s=await lstat(p);if(!s.isDirectory()||s.isSymbolicLink()||s.uid!==process.getuid?.()||(s.mode&0o077)!==0||await realpath(p)!==resolve(p))throw new RecoveryError('PRIVATE_RECOVERY_DIRECTORY_REQUIRED');
}
export async function regularFile(p:string,privateKey=false){
 const s=await lstat(p);if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1||privateKey&&(s.uid!==process.getuid?.()||(s.mode&0o077)!==0))throw new RecoveryError('UNSAFE_RECOVERY_FILE');return s;
}
