import {createHmac} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {z} from 'zod';
import {ApiError} from '../core/policy.ts';
import {assertSchemaReady,type Database,type Connection} from '../core/database.ts';
import {verifiedProxyIp} from '../core/trusted-proxy.ts';
import {assertPublicProfileRole} from './public-api.ts';
import {profileShareId} from './share-id.ts';
import {openProfileImageDelivery,privateProfileImageManifestSchema,profileImageIndex,profileImageSelectionSchema} from './image-delivery.ts';
import type {R2DownloadConnections} from '../integrations/r2-config.ts';
import type {S3ClientConfig} from '@aws-sdk/client-s3';

// A restricted current-public reader supplies only reviewed derivatives.
// Neither the manifest's private descriptor nor a cloud URL reaches JSON.
export function createPublicProfileImageApi(database:Database,config:{enabled:boolean;production:boolean;edgeSecret?:string;budgetSecret?:string},connections:R2DownloadConnections,handler?:S3ClientConfig['requestHandler']){
 return async(request:Request,rawId:string,rawSelection?:unknown)=>{
  const headers={'Cache-Control':'no-store','Pragma':'no-cache','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff','Content-Security-Policy':"sandbox; default-src 'none'",'Cross-Origin-Resource-Policy':'same-origin'};let body:ReadableStream<Uint8Array>|undefined;
  try{
   if(!config.enabled)throw new ApiError(404,'NOT_FOUND');if(request.method!=='GET')throw new ApiError(405,'METHOD_NOT_ALLOWED');if(new URL(request.url).search)throw new ApiError(400,'INVALID_QUERY');const id=profileShareId.parse(rawId),selection=rawSelection===undefined?null:profileImageSelectionSchema.parse(rawSelection);
   if(!config.budgetSecret||config.budgetSecret.length<32||config.budgetSecret.length>4096||config.budgetSecret===config.edgeSecret)throw Error('INDEPENDENT_PUBLIC_BUDGET_SECRET_REQUIRED');const budget=createHmac('sha256',config.budgetSecret).update('public-profile-ip:v1:'+verifiedProxyIp(request,config)).digest('hex');
   const read=async()=>{let c:Connection|undefined,transaction=false,destroy=false;try{
    c=await database.connect();await assertPublicProfileRole(c);await assertSchemaReady(c);await c.query('BEGIN');transaction=true;await c.query("SELECT set_config('statement_timeout','5s',true),set_config('lock_timeout','2s',true)");
    const r=(await c.query<{result:{limited:boolean;data?:unknown}}>('SELECT public.read_published_profile_images($1,$2,$3,$4) result',[id,budget,selection?.version??null,selection?.number??null])).rows[0]?.result;
    if(!r||typeof r.limited!=='boolean')throw Error('PUBLIC_IMAGE_RESULT_INVALID');await c.query('COMMIT');transaction=false;if(r.limited)throw new ApiError(429,'RATE_LIMITED');if(!r.data)throw new ApiError(404,'NOT_FOUND');const parsed=privateProfileImageManifestSchema.safeParse(r.data);
    if(!parsed.success||parsed.data.id!==id||selection&&(parsed.data.releaseVersion!==selection.version||parsed.data.images.length!==1||parsed.data.images[0].number!==selection.number))throw Error('PUBLIC_IMAGE_RESULT_INVALID');return parsed.data;
   }catch(e){if(transaction)try{await c!.query('ROLLBACK');}catch{destroy=true;}throw e;}finally{c?.release(destroy);}};
   const manifest=await read();if(!selection)return Response.json({data:profileImageIndex(manifest,'public')},{headers});
   // Both reads use the shared persistent budget. Release the first database
   // connection before any storage IO;reauthorize after every byte is verified.
   body=await openProfileImageDelivery(manifest.images[0].delivery,connections,async()=>isDeepStrictEqual(await read(),manifest),{signal:request.signal},handler);
   return new Response(body,{headers:{...headers,'Content-Type':'image/webp','Content-Length':String(manifest.images[0].delivery.bytes),'Content-Disposition':'inline; filename="kavosh-profile-image.webp"','Accept-Ranges':'none'}});
  }catch(e){await body?.cancel().catch(()=>{});const status=e instanceof ApiError?e.status:e instanceof z.ZodError?400:503,code=e instanceof ApiError?e.code:e instanceof z.ZodError?'INVALID_INPUT':'PUBLIC_IMAGE_UNAVAILABLE';return Response.json({error:{code}},{status,headers:{...headers,...status===429?{'Retry-After':'60'}:{}}});}
 };
}
