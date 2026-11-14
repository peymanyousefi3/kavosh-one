import { timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import { ApiError } from './policy.ts';

export function verifiedProxyIp(request:Request,config:{production:boolean;edgeSecret?:string}){
 if(!config.production)return '127.0.0.1';
 const a=Buffer.from(config.edgeSecret??''),b=Buffer.from(request.headers.get('x-kavosh-edge-key')??'');
 if(a.length<32||a.length!==b.length||!timingSafeEqual(a,b))throw new ApiError(403,'UNTRUSTED_PROXY');
 const ip=request.headers.get('x-kavosh-client-ip')??'';if(!isIP(ip))throw new ApiError(403,'UNTRUSTED_PROXY');return ip;
}
