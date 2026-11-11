import { z } from 'zod';
import { ApiError } from '../core/policy.ts';
import { profileShareId } from './share-id.ts';

// Browser QR scans cannot supply X-Academy-Id. A URL selector is NOT a grant:
// the ordinary cookie,verified identity,membership and current scopes still apply.
export function selectProfileShareRequest(request:Request,academyId:string,id:string,resource:'profile'|'qr'='profile'){
 const academy=z.string().uuid().transform(v=>v.toLowerCase()).safeParse(academyId),profile=profileShareId.safeParse(id),selected=request.headers.get('x-academy-id');
 if(!academy.success||!profile.success||request.method!=='GET'||new URL(request.url).search||!['profile','qr'].includes(resource)||(selected&&selected.toLowerCase()!==academy.data))throw new ApiError(404,'NOT_FOUND');const headers=new Headers(request.headers);headers.set('x-academy-id',academy.data);return {request:new Request(request,{headers}),academyId:academy.data,path:'community/published-profiles/'+profile.data+(resource==='qr'?'/qr.png':'')};
}
