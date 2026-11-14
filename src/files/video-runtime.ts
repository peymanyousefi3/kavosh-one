import { lstat,realpath } from 'node:fs/promises';
import { dirname } from 'node:path';
import { assertIsolatedFileRuntime } from './isolated-runtime.ts';

export const videoServiceSocket='/run/kavosh-video/validator.sock',videoServicePython='/usr/bin/python3',videoServiceFfmpeg='/opt/video/ffmpeg',videoServiceFfprobe='/opt/video/ffprobe';
export async function assertPrivateVideoSocket(socketPath:string){const directory=dirname(socketPath),[parent,socket,canonical]=await Promise.all([lstat(directory),lstat(socketPath),realpath(directory)]);if(canonical!==directory||!parent.isDirectory()||parent.isSymbolicLink()||parent.uid!==10003||parent.gid!==10001||(parent.mode&0o777)!==0o750||!socket.isSocket()||socket.isSymbolicLink()||socket.uid!==10003||socket.gid!==10001||(socket.mode&0o777)!==0o660)throw Error('UNSAFE_VIDEO_SERVICE_SOCKET');}
export async function assertIsolatedVideoRuntime(){await assertIsolatedFileRuntime('/run/kavosh-video',[videoServicePython,videoServiceFfmpeg,videoServiceFfprobe]);}
