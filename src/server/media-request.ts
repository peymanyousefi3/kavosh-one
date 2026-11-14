import { z } from 'zod';
import { ApiError } from '../core/policy.ts';
import { isVideoReadPath } from '../files/video-range.ts';

// Native media elements cannot add X-Academy-Id or provider If-Match headers.
// The non-secret URL school selector grants NOTHING;the shared authenticated
// API still checks real membership/scopes and binds the resulting credential.
export function selectMediaRequest(request:Request,academy:string,path:string){
 const parsed=z.string().uuid().transform(v=>v.toLowerCase()).safeParse(academy);
 if(!parsed.success||!['GET','HEAD'].includes(request.method)||!isVideoReadPath(path))throw new ApiError(404,'NOT_FOUND');
 const selected=request.headers.get('x-academy-id');if(selected&&selected.toLowerCase()!==parsed.data)throw new ApiError(404,'NOT_FOUND');
 const headers=new Headers(request.headers);headers.set('x-academy-id',parsed.data);return{request:new Request(request,{headers}),academyId:parsed.data};
}
export function assertMediaAcademy(actual:string,selected:string){if(actual!==selected)throw new ApiError(404,'NOT_FOUND');}
