import { chmod,lstat } from 'node:fs/promises';
import { createVideoValidationServer } from '../src/files/video-service.ts';
import { assertIsolatedVideoRuntime,videoServiceSocket,videoServicePython,videoServiceFfmpeg,videoServiceFfprobe } from '../src/files/video-runtime.ts';
import { privateParserUmask } from '../src/files/isolated-runtime.ts';

let server:ReturnType<typeof createVideoValidationServer>|undefined;
try{
 await assertIsolatedVideoRuntime();try{await lstat(videoServiceSocket);throw Error('SOCKET_ALREADY_EXISTS');}catch(error){if(!(error&&typeof error==='object'&&'code'in error&&error.code==='ENOENT'))throw error;}
 process.umask(privateParserUmask);server=createVideoValidationServer({pythonPath:videoServicePython,ffmpegPath:videoServiceFfmpeg,ffprobePath:videoServiceFfprobe});
 await new Promise<void>((resolve,reject)=>{server!.once('error',reject);server!.listen(videoServiceSocket,()=>{server!.removeListener('error',reject);resolve();});});await chmod(videoServiceSocket,0o660);
 server.on('error',()=>{console.error('video_service_runtime_error');process.exitCode=1;server?.closeAllConnections();server?.close();});
 for(const signal of ['SIGINT','SIGTERM']as const)process.once(signal,()=>{server?.closeAllConnections();server?.close();});console.log('video_service_ready');
}catch{console.error('Video validator refused startup;isolated runtime controls are required.');process.exitCode=1;server?.closeAllConnections();server?.close();}
