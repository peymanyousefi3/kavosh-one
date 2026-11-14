import { chmod,lstat } from 'node:fs/promises';
import { createImageValidationServer } from '../src/files/image-service.ts';
import { assertIsolatedImageRuntime,imageServiceSocket } from '../src/files/image-runtime.ts';
import { privateParserUmask } from '../src/files/isolated-runtime.ts';

let server:ReturnType<typeof createImageValidationServer>|undefined;
try {
 await assertIsolatedImageRuntime();
 // Never unlink a path we did not create, including stale or occupied sockets.
 try{await lstat(imageServiceSocket);throw new Error('SOCKET_ALREADY_EXISTS');}catch(error){if(!(error&&typeof error==='object'&&'code' in error&&error.code==='ENOENT'))throw error;}
 process.umask(privateParserUmask);server=createImageValidationServer();
 await new Promise<void>((resolve,reject)=>{server!.once('error',reject);server!.listen(imageServiceSocket,()=>{server!.removeListener('error',reject);resolve();});});
 await chmod(imageServiceSocket,0o660);
 server.on('error',()=>{console.error('image_service_runtime_error');process.exitCode=1;server?.closeAllConnections();server?.close();});
 for(const signal of ['SIGINT','SIGTERM'] as const)process.once(signal,()=>{server?.closeAllConnections();server?.close();});
 console.log('image_service_ready');
}catch{console.error('Image validator refused startup; isolated runtime controls are required.');process.exitCode=1;server?.closeAllConnections();server?.close();}
