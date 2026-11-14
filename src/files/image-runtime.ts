import { lstat,realpath } from 'node:fs/promises';
import { dirname } from 'node:path';
import { assertIsolatedFileRuntime } from './isolated-runtime.ts';

export const imageServiceSocket='/run/kavosh-image/validator.sock';
export async function assertPrivateImageSocket(socketPath:string) {
 const directory=dirname(socketPath),[parent,socket,canonical]=await Promise.all([lstat(directory),lstat(socketPath),realpath(directory)]);
 if(canonical!==directory||!parent.isDirectory()||parent.isSymbolicLink()||parent.uid!==10002||parent.gid!==10001||(parent.mode&0o777)!==0o750
  ||!socket.isSocket()||socket.isSymbolicLink()||socket.uid!==10002||socket.gid!==10001||(socket.mode&0o777)!==0o660)throw new Error('UNSAFE_IMAGE_SERVICE_SOCKET');
}
export async function assertIsolatedImageRuntime(){await assertIsolatedFileRuntime('/run/kavosh-image');}
