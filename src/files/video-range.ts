import { ApiError } from '../core/policy.ts';
import { z } from 'zod';

export type VideoRange={status:200|206|416;start:number;end:number;length:number;total:number;etag:string};
export const videoRangeSchema=z.object({status:z.union([z.literal(200),z.literal(206),z.literal(416)]),start:z.number().int().nonnegative(),end:z.number().int().nonnegative(),length:z.number().int().nonnegative(),total:z.number().int().min(1).max(134217728),etag:z.string().regex(/^"sha256-[a-f0-9]{64}"$/)}).strict().refine(v=>v.status===416?v.start===0&&v.end===0&&v.length===0:v.start<=v.end&&v.end<v.total&&v.length===v.end-v.start+1&&(v.status!==200||v.start===0&&v.length===v.total));
const id='[0-9a-fA-F-]{36}',number='[1-9][0-9]{0,9}',item='(?:[1-9]|1[0-9]|20)',videoPath=new RegExp('^(?:files/'+id+'|students/'+id+'/(?:published-reports|homework)/'+id+'(?:/solutions/'+id+')?/(?:media/'+id+'|attachments/'+item+')|students/'+id+'/homework/'+id+'/submission/versions/'+number+'/attachments/'+item+'|homework-submissions/'+id+'/versions/'+number+'/attachments/'+item+')/video$');
// Method eligibility ONLY,not authentication,UUID validity or permission.
export const isVideoReadPath=(path:string)=>videoPath.test(path);
// RFC9110 single ranges only. ETag is our measured content hash,not private
// provider metadata. No range guessing,multipart allocation or byte rounding.
export function videoRange(total:number,sha256:string,range:string|null,ifRange:string|null=null,head=false):VideoRange{
 if(!Number.isSafeInteger(total)||total<1||total>134217728||!/^[a-f0-9]{64}$/.test(sha256))throw new ApiError(503,'INVALID_VIDEO_SOURCE');
 const etag='"sha256-'+sha256+'"',full:VideoRange={status:200,start:0,end:total-1,length:total,total,etag};
 if(head||range===null)return full;
 if(typeof range!=='string'||range.length>128||ifRange!==null&&(typeof ifRange!=='string'||ifRange.length>128))throw new ApiError(400,'INVALID_VIDEO_RANGE');
 if(ifRange!==null&&ifRange!==etag)return full;
 const match=/^bytes=([0-9]{1,18})?-([0-9]{1,18})?$/i.exec(range);if(!match||!match[1]&&!match[2])throw new ApiError(400,'INVALID_VIDEO_RANGE');
 const last=BigInt(total-1),unsatisfied:VideoRange={status:416,start:0,end:0,length:0,total,etag};let start:bigint,end:bigint;
 if(!match[1]){const count=BigInt(match[2]);if(count===0n)return unsatisfied;start=count>=BigInt(total)?0n:BigInt(total)-count;end=last;}
 else{start=BigInt(match[1]);end=match[2]?BigInt(match[2]):last;if(start>last||end<start)return unsatisfied;if(end>last)end=last;}
 return{status:206,start:Number(start),end:Number(end),length:Number(end-start+1n),total,etag};
}
