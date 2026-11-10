import { ApiError } from '../core/policy.ts';

export type VideoRange={status:200|206|416;start:number;end:number;length:number;total:number;etag:string};
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
