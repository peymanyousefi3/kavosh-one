import { z } from 'zod';
import type { ApiContext,Reply } from '../core/api.ts';
import { ApiError } from '../core/policy.ts';
import { publishedProfiles } from './profile-publications.ts';
import { profileShareId } from '../profiles/share-id.ts';
import { profileShareOrigin } from '../profiles/qr.ts';

export async function publishedProfileQr(ctx:ApiContext,origin?:string):Promise<Reply|null>{
 const path=/^community\/published-profiles\/([^/]+)\/qr\.png$/.exec(ctx.path);if(!path)return null;if(ctx.request.method!=='GET')throw new ApiError(405,'METHOD_NOT_ALLOWED');z.object({}).strict().parse(Object.fromEntries(new URL(ctx.request.url).searchParams));const id=profileShareId.parse(path[1]);
 // Reuse the entire current verified-human,school,scope,consent,moderation
 // and edition gate. A QR is a link,not a bearer token or a publication grant.
 const result=await publishedProfiles({...ctx,path:'community/published-profiles/'+id});if(!result||result.status!==200)throw new ApiError(404,'NOT_FOUND');return{status:200,body:null,qr:{profileId:id,academyId:ctx.credential.academy_id,origin:profileShareOrigin(origin)}};
}
export const publishedProfileQrContract=[{path:'/api/v1/community/published-profiles/{id}/qr.png',method:'get',humanOnly:true,pathSchemas:{id:profileShareId},responseContentType:'image/png' as const,summary:'Download a standard black/white QR containing only the configured HTTPS origin plus canonical short verified-member profile API link. Same current verified-school/profile scope,consent,visibility,moderation and reviewed edition gate as its JSON read. No credential,private identity or copied profile content. No-store;render only after commit and DB release;bounded payload/image/concurrency. Scanning still requires the current login and permission. Target is the existing JSON API,not an unbuilt visual page;fails closed until PROFILE_SHARE_ORIGIN is configured.'}] as const;
