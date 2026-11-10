import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { jsonBody,mutation,record,type ApiContext,type Reply } from '../core/api.ts';
import { lockApprovalWrites } from '../core/approvals.ts';
import { ApiError } from '../core/policy.ts';
import { lockAcademyTopology } from './academy.ts';
import { permittedFile } from './files.ts';
import { privateR2 } from '../integrations/r2.ts';
import type { R2DownloadConnections } from '../integrations/r2-config.ts';

const uuid=z.string().uuid().transform(v=>v.toLowerCase()),version=z.number().int().positive().max(2147483647),digest=z.string().regex(/^[a-f0-9]{64}$/);
const input=z.object({expectedMetadataVersion:version,copyId:uuid}).strict();
const sourceSchema=z.object({fileId:uuid,fileVersion:version,copyId:uuid,destinationTargetId:digest,destinationEtag:z.string().min(3).max(202).regex(/^"[\x21\x23-\x7e]+"$/),bytes:z.number().int().min(1).max(33554432),sha256:digest,mime:z.enum(['image/jpeg','image/png','image/webp','image/gif','image/avif','application/pdf','text/plain']),maximumLinkSeconds:z.number().int().min(1).max(60)});
const receipt=z.object({id:uuid,fileId:uuid,fileVersion:version,copyId:uuid,issuedAt:z.iso.datetime(),expiresAt:z.iso.datetime(),sourceFingerprint:digest}).strict();
type DownloadFile=Pick<Awaited<ReturnType<typeof permittedFile>>,'version'|'archived'|'effective_hub_id'>&{receiptId?:string};
export async function fileDownloads(ctx:ApiContext,connections?:R2DownloadConnections):Promise<Reply|null>{
 const m=/^files\/([^/]+)\/download-link$/.exec(ctx.path);if(!m)return null;if(ctx.request.method!=='POST')throw new ApiError(405,'METHOD_NOT_ALLOWED');
 z.object({}).strict().parse(Object.fromEntries(new URL(ctx.request.url).searchParams));const id=uuid.parse(m[1]),i=input.parse(await jsonBody(ctx.request));
 return issueFileDownload(ctx,id,i,permittedFile,connections);
}
// Only server-owned routes supply an authorizer. Each must prove the exact
// file association and current domain-specific authority before AND after locks.
export async function issueFileDownload(ctx:ApiContext,id:string,i:z.infer<typeof input>,authorize:(ctx:ApiContext,id:string)=>Promise<DownloadFile>,connections?:R2DownloadConnections):Promise<Reply>{
 await authorize(ctx,id);await lockApprovalWrites(ctx);await lockAcademyTopology(ctx);
 // Concurrent viewers share the row lock;metadata/archive writers wait only
 // for local signing,never for an actual file transfer or browser download.
 await ctx.db.query('SELECT id FROM public.file_records WHERE id=$1 FOR SHARE',[id]);const f=await authorize(ctx,id);
 if(f.version!==i.expectedMetadataVersion)throw new ApiError(409,'TARGET_CHANGED');if(f.archived)throw new ApiError(409,'FILE_ARCHIVED');
 const copy=(await ctx.db.query('SELECT route_id FROM public.file_copy_requests WHERE id=$1 AND file_id=$2',[i.copyId,id])).rows[0];if(!copy)throw new ApiError(404,'NOT_FOUND');
 await ctx.db.query('SELECT id FROM public.file_storage_routes WHERE id=$1 FOR SHARE',[copy.route_id]);
 const raw=(await ctx.db.query<{source:unknown}>('SELECT public.file_download_source($1,$2,$3) source',[id,f.version,i.copyId])).rows[0].source;
 if(!raw)throw new ApiError(409,'FILE_DOWNLOAD_NOT_READY');const evaluated=sourceSchema.safeParse(raw);if(!evaluated.success)throw new ApiError(503,'FILE_DOWNLOAD_SOURCE_INVALID');const actual=evaluated.data,configuration=connections?.(ctx.credential.academy_id,actual.destinationTargetId);
 if(!configuration)throw new ApiError(503,'R2_DOWNLOAD_NOT_CONFIGURED');const storage=privateR2(configuration,ctx.credential.academy_id);
 try{
  if(storage.storageTargetId!==actual.destinationTargetId)throw new ApiError(503,'R2_DOWNLOAD_NOT_CONFIGURED');if(actual.bytes>storage.maximumUploadBytes)throw new ApiError(409,'FILE_EXCEEDS_DOWNLOAD_LIMIT');
  const reply=await mutation(ctx,i,async()=>{
   const grantId=randomUUID();await record(ctx.db,ctx.credential,ctx.requestId,'file.download.link.issued',grantId,f.effective_hub_id,{fileId:id,copyId:i.copyId,metadataVersion:f.version,...f.receiptId?{receiptId:f.receiptId}:{},privateAttachment:true,externalRequestMade:false,retrievalVerified:false});
   let saved:{id:string;fileId:string;fileVersion:number;copyId:string;issuedAt:Date|string;expiresAt:Date|string;sourceFingerprint:string};
   try{saved=(await ctx.db.query<typeof saved>('INSERT INTO public.file_download_grants(academy_id,id,file_id,file_version,copy_id,created_by,audit_id) SELECT $1,$2,$3,$4,$5,$6,a.id FROM public.audit_events a WHERE a.academy_id=$1 AND a.entity_id=$2 AND a.request_id=$7 AND a.action=\'file.download.link.issued\' AND a.created_at=transaction_timestamp() RETURNING id,file_id AS "fileId",file_version AS "fileVersion",copy_id AS "copyId",issued_at AS "issuedAt",expires_at AS "expiresAt",source_fingerprint AS "sourceFingerprint"',[ctx.credential.academy_id,grantId,id,f.version,i.copyId,ctx.credential.person_id,ctx.requestId])).rows[0];}
   catch(error){if(error&&typeof error==='object'&&'code' in error&&error.code==='23514'&&'message' in error&&error.message==='FILE_DOWNLOAD_NOT_READY')throw new ApiError(409,'FILE_DOWNLOAD_NOT_READY');throw error;}
   if(!saved)throw new ApiError(503,'FILE_DOWNLOAD_GRANT_MISSING');
   // Cache only non-secret intent,never a bearer URL,provider credential or ETag.
   return {status:201,body:{data:{...saved,issuedAt:new Date(saved.issuedAt).toISOString(),expiresAt:new Date(saved.expiresAt).toISOString()}}};
  });
  const parsed=receipt.safeParse((reply.body as {data:unknown}).data);if(!parsed.success)throw new ApiError(503,'FILE_DOWNLOAD_GRANT_MISSING');const saved=parsed.data;
  if(saved.fileId!==id||saved.fileVersion!==f.version||saved.copyId!==i.copyId)throw new ApiError(409,'TARGET_CHANGED');
  const grant=(await ctx.db.query<{current:boolean;source_fingerprint:string}>('SELECT source IS NOT DISTINCT FROM public.file_download_source($1,$2,$3) AS current,source_fingerprint FROM public.file_download_grants WHERE id=$4 AND file_id=$1 AND copy_id=$3 AND created_by=$5',[id,f.version,i.copyId,saved.id,ctx.credential.person_id])).rows[0];
  if(!grant||!grant.current||grant.source_fingerprint!==saved.sourceFingerprint)throw new ApiError(409,'FILE_DOWNLOAD_SOURCE_CHANGED');
  const seconds=(Date.parse(saved.expiresAt)-Date.parse(saved.issuedAt))/1000,download=await storage.cleanDownload(id,seconds,{issuedAt:saved.issuedAt,ifMatch:actual.destinationEtag});
  if(download.expiresAt!==saved.expiresAt)throw new ApiError(503,'FILE_DOWNLOAD_GRANT_MISSING');
  return {status:reply.status,body:{data:{...saved,bytes:actual.bytes,sha256:actual.sha256,mime:actual.mime,download,accessModel:'short_lived_bearer',accessMayRemainValidUntil:saved.expiresAt,retrievalVerified:false,malwareFreeVerified:false}}};
 }finally{storage.close();}
}
export const fileDownloadsContract=[{path:'/api/v1/files/{id}/download-link',method:'post',summary:'Issue an audited,conditional private attachment URL for up to 60 seconds;current file/domain rights,reviewed serving policy and separate reader credentials required. Replays preserve expiry;issued bearer URLs are not instantly revocable. Issuance does not prove retrieval or malware-free content.',schema:input}] as const;
