import { z } from 'zod';
import { ApiError } from '../core/policy.ts';
import { profileShareId,profileShareAlias,profileBrowserPath } from './share-id.ts';

export const profileQrReplySchema=z.object({profileId:z.string().uuid().transform(v=>v.toLowerCase()),academyId:z.string().uuid().transform(v=>v.toLowerCase()),origin:z.string().max(300)}).strict();
export function profileShareOrigin(raw:unknown){
 if(typeof raw!=='string'||raw.length>300||/[\u0000-\u0020\u007f]/.test(raw))throw new ApiError(503,'PROFILE_SHARE_ORIGIN_REQUIRED');
 let url:URL;try{url=new URL(raw);}catch{throw new ApiError(503,'PROFILE_SHARE_ORIGIN_REQUIRED');}
 if(url.protocol!=='https:'||url.username||url.password||!url.hostname||url.hostname.length>253||(raw!==url.origin&&raw!==url.origin+'/'))throw new ApiError(503,'PROFILE_SHARE_ORIGIN_REQUIRED');return url.origin;
}
export function profileQrTarget(origin:unknown,id:string,audience:'public'|'members',academyId?:string){
 const target=profileShareOrigin(origin)+profileBrowserPath(id,audience,academyId);
 if(Buffer.byteLength(target)>512)throw new ApiError(503,'PROFILE_QR_TARGET_TOO_LONG');return target;
}
export function profileQrFilename(id:string){return 'profile-'+profileShareAlias(profileShareId.parse(id))+'.png';}
// ponytail: two bounded encodes/process,without a queue or retained DB slot.
// Move to an isolated worker only if measured QR CPU cost warrants it.
let active=0;
export async function renderProfileQr(origin:unknown,id:string,audience:'public'|'members',signal?:AbortSignal,academyId?:string){
 const target=profileQrTarget(origin,id,audience,academyId);if(signal?.aborted)throw new ApiError(408,'PROFILE_QR_ABORTED');if(active>=2)throw new ApiError(503,'PROFILE_QR_BUSY');active++;
 try{const QRCode=(await import('qrcode')).default,bytes=await QRCode.toBuffer(target,{type:'png',errorCorrectionLevel:'M',margin:4,scale:4,rendererOpts:{deflateLevel:6,deflateStrategy:3}});if(signal?.aborted)throw new ApiError(408,'PROFILE_QR_ABORTED');if(bytes.length>65536||bytes.length<24||!bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))throw new ApiError(503,'PROFILE_QR_UNAVAILABLE');if(bytes.readUInt32BE(16)<1||bytes.readUInt32BE(16)>512||bytes.readUInt32BE(16)!==bytes.readUInt32BE(20))throw new ApiError(503,'PROFILE_QR_UNAVAILABLE');return new Uint8Array(bytes);}finally{active--;}
}
