import {createHash} from 'node:crypto';
import {z} from 'zod';
import type {ApiContext,Reply} from '../core/api.ts';
import {ApiError} from '../core/policy.ts';
import type {R2DownloadConnections} from '../integrations/r2-config.ts';
import type {S3ClientConfig} from '@aws-sdk/client-s3';
import {publishedProfiles} from './profile-publications.ts';
import {profileShareId} from '../profiles/share-id.ts';
import {openProfileImageDelivery,privateProfileImageManifestSchema,profileImageIndex,profileImageSelectionSchema} from '../profiles/image-delivery.ts';

export async function publishedProfileImages(ctx:ApiContext,connections?:R2DownloadConnections,handler?:S3ClientConfig['requestHandler']):Promise<Reply|null>{
 const m=/^community\/published-profiles\/([^/]+)\/images(?:\/([^/]+)\/([^/]+))?$/.exec(ctx.path);if(!m)return null;
 if(ctx.request.method!=='GET')throw new ApiError(405,'METHOD_NOT_ALLOWED');if(new URL(ctx.request.url).search)throw new ApiError(400,'INVALID_QUERY');const id=profileShareId.parse(m[1]),selection=m[2]===undefined?null:profileImageSelectionSchema.parse({version:m[2],number:m[3]});
 // Exact existing same-school verified-human membership,scope,explicit denial,
 // consent,visibility,moderation and publication gate. No private-file rights
 // are needed to view an explicitly shared,metadata-free derivative copy.
 const profile=await publishedProfiles({...ctx,path:'community/published-profiles/'+id});if(!profile||profile.status!==200)throw new ApiError(404,'NOT_FOUND');const audience=(profile.body as {readAudience:'public'|'members'}).readAudience;
 const raw=(await ctx.db.query<{data:unknown}>('SELECT public.published_profile_images($1,$2,$3,$4) data',[id,audience,selection?.version??null,selection?.number??null])).rows[0]?.data;if(!raw)throw new ApiError(404,'NOT_FOUND');const parsed=privateProfileImageManifestSchema.safeParse(raw);
 if(!parsed.success||parsed.data.id!==id||selection&&(parsed.data.releaseVersion!==selection.version||parsed.data.images.length!==1||parsed.data.images[0].number!==selection.number))throw new ApiError(503,'PUBLISHED_IMAGE_UNAVAILABLE');const manifest=parsed.data;
 if(!selection)return{status:200,body:{data:profileImageIndex(manifest,'members'),verifiedSchoolMemberOnly:true}};
 const image=manifest.images[0];return{status:200,body:null,image:{profileId:id,version:selection.version,number:selection.number,bytes:image.delivery.bytes,fingerprint:createHash('sha256').update(JSON.stringify(manifest)).digest('hex'),open:reauthorize=>openProfileImageDelivery(image.delivery,connections??(()=>null),reauthorize,{signal:ctx.request.signal},handler)}};
}
export const publishedProfileImagesContract=[
 {path:'/api/v1/community/published-profiles/{id}/images',method:'get',humanOnly:true,pathSchemas:{id:profileShareId},summary:'Verified same-school current published-profiles.view scope and exact purpose-consented,moderation/visibility/profile/academic/asset/source-reviewed derivative index. No original-file permission or cloud URL. Approved captions/dimensions and code-owned versioned relative paths only;no private storage IDs,hashes,leases or source. No queries;no-store.'},
 {path:'/api/v1/community/published-profiles/{id}/images/{version}/{number}',method:'get',humanOnly:true,pathSchemas:{id:profileShareId,version:profileImageSelectionSchema.shape.version,number:profileImageSelectionSchema.shape.number},responseContentType:'image/webp' as const,summary:'Current verified-school member WebP derivative only;never a private original or signed cloud link. Same current scope/denial/consent/visibility/moderation and exact reviewed/source/prepared gate as its index. Conditional ETag/full size/SHA256 verified before response,then the entire human/current-grant API gate runs again. No DB connection or native codec during IO. At most8streams and8MiB total owned buffers/process,each image <=4MiB;held through physical transfer and client consumption/cancellation;10second deadline. No queries/ranges;private no-store.'}
]as const;
