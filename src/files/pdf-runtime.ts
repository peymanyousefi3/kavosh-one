import { lstat,realpath } from 'node:fs/promises';
import { dirname } from 'node:path';
import { assertIsolatedFileRuntime } from './isolated-runtime.ts';

export const pdfServiceSocket='/run/kavosh-pdf/validator.sock',pdfServicePython='/opt/pdf/bin/python3';
export async function assertPrivatePdfSocket(socketPath:string){
 const directory=dirname(socketPath),[parent,socket,canonical]=await Promise.all([lstat(directory),lstat(socketPath),realpath(directory)]);
 if(canonical!==directory||!parent.isDirectory()||parent.isSymbolicLink()||parent.uid!==10002||parent.gid!==10001||(parent.mode&0o777)!==0o750
  ||!socket.isSocket()||socket.isSymbolicLink()||socket.uid!==10002||socket.gid!==10001||(socket.mode&0o777)!==0o660)throw new Error('UNSAFE_PDF_SERVICE_SOCKET');
}
export async function assertIsolatedPdfRuntime(){await assertIsolatedFileRuntime('/run/kavosh-pdf',[pdfServicePython]);}
