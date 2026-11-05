import { chmod,lstat } from 'node:fs/promises';
import { createPdfValidationServer } from '../src/files/pdf-service.ts';
import { assertIsolatedPdfRuntime,pdfServiceSocket,pdfServicePython } from '../src/files/pdf-runtime.ts';

let server:ReturnType<typeof createPdfValidationServer>|undefined;
try{
 await assertIsolatedPdfRuntime();
 // Do not unlink an occupied path, even a stale socket we did not create.
 try{await lstat(pdfServiceSocket);throw new Error('SOCKET_ALREADY_EXISTS');}catch(error){if(!(error&&typeof error==='object'&&'code' in error&&error.code==='ENOENT'))throw error;}
 process.umask(0o117);server=createPdfValidationServer({pythonPath:pdfServicePython});
 await new Promise<void>((resolve,reject)=>{server!.once('error',reject);server!.listen(pdfServiceSocket,()=>{server!.removeListener('error',reject);resolve();});});
 await chmod(pdfServiceSocket,0o660);
 server.on('error',()=>{console.error('pdf_service_runtime_error');process.exitCode=1;server?.closeAllConnections();server?.close();});
 for(const signal of ['SIGINT','SIGTERM'] as const)process.once(signal,()=>{server?.closeAllConnections();server?.close();});
 console.log('pdf_service_ready');
}catch{console.error('PDF validator refused startup; isolated runtime controls are required.');process.exitCode=1;server?.closeAllConnections();server?.close();}
