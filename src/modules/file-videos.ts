import { z } from 'zod';
import type { S3ClientConfig } from '@aws-sdk/client-s3';
import { record,type ApiContext,type Reply } from '../core/api.ts';
import { ApiError } from '../core/policy.ts';
import { fileDeliverySource,issueFileDownload } from './file-downloads.ts';
import { permittedFile } from './files.ts';
import { r2Connection,r2TargetId,type R2DownloadConnections } from '../integrations/r2-config.ts';
import { videoRange } from '../files/video-range.ts';
import { openVideoTransfer } from '../files/video-transfer.ts';

const uuid=z.string().uuid().transform(v=>v.toLowerCase()),input=z.object({expectedMetadataVersion:z.coerce.number().int().positive().max(2147483647),copyId:uuid}).strict();
export async function issueFileVideo(ctx:ApiContext,id:string,i:{expectedMetadataVersion:number;copyId:string},authorize:Parameters<typeof issueFileDownload>[3],connections?:R2DownloadConnections,handler?:S3ClientConfig['requestHandler']):Promise<Reply>{
 if(!['GET','HEAD'].includes(ctx.request.method)||ctx.request.body!==null)throw new ApiError(405,'METHOD_NOT_ALLOWED');
 const site=ctx.request.headers.get('sec-fetch-site'),origin=ctx.request.headers.get('origin');if(site&&!['same-origin','none'].includes(site)||origin&&origin!==new URL(ctx.request.url).origin)throw new ApiError(403,'CROSS_ORIGIN_VIDEO_DENIED');
 const {file,source}=await fileDeliverySource(ctx,id,i,authorize);if(!['video/mp4','video/quicktime','video/webm'].includes(source.mime))throw new ApiError(409,'FILE_IS_NOT_VIDEO');
 const configuration=connections?.(ctx.credential.academy_id,source.destinationTargetId),config=r2Connection.safeParse(configuration);if(!config.success||r2TargetId(config.data)!==source.destinationTargetId)throw new ApiError(503,'R2_DOWNLOAD_NOT_CONFIGURED');if(source.bytes>config.data.maximumUploadBytes)throw new ApiError(409,'FILE_EXCEEDS_DOWNLOAD_LIMIT');
 const head=ctx.request.method==='HEAD',plan=Object.freeze(videoRange(source.bytes,source.sha256,ctx.request.headers.get('range'),ctx.request.headers.get('if-range'),head));
 await record(ctx.db,ctx.credential,ctx.requestId,'file.video.read',id,file.effective_hub_id,{fileId:id,copyId:i.copyId,metadataVersion:file.version,transport:'authenticated_stream',head,rangeStatus:plan.status,from:plan.start,to:plan.end,retrievalVerified:false});
 const transfer={academyId:ctx.credential.academy_id,actorId:ctx.credential.person_id,fileId:id,targetId:source.destinationTargetId,bytes:source.bytes,sha256:source.sha256,etag:source.destinationEtag},signal=ctx.request.signal;
 return{status:plan.status,body:null,video:{mime:source.mime as'video/mp4'|'video/quicktime'|'video/webm',plan,open:()=>openVideoTransfer(config.data,transfer,plan,{head,signal,handler})}};
}
export async function fileVideos(ctx:ApiContext,connections?:R2DownloadConnections,handler?:S3ClientConfig['requestHandler']):Promise<Reply|null>{
 const match=/^files\/([^/]+)\/video$/.exec(ctx.path);if(!match)return null;const p=new URL(ctx.request.url).searchParams;if([...p].length!==new Set(p.keys()).size)throw new ApiError(400,'DUPLICATE_QUERY');
 const i=input.parse(Object.fromEntries(p));return issueFileVideo(ctx,uuid.parse(match[1]),i,permittedFile,connections,handler);
}
export const fileVideosContract=(['get','head']as const).map(method=>({path:'/api/v1/files/{id}/video',method,videoResponse:true as const,summary:'Authenticated private video bytes,not a bearer URL. Current file/domain rights,exact native decoded-video/copy proof,explicit reviewed video-serving policy and separate reader credentials required on EACH range/HEAD. DB transaction is committed and released before storage IO. Single-range206,unsatisfied416,If-Range and HEAD supported;server pins source ETag internally. No-store,strict video MIME,CORP same-origin;32transfers/process and4/actor,bounded backpressure,cancellation and10minute whole-transfer budget. Existing bytes already received cannot be revoked mid-view;next request rechecks rights. No live provider or browser-codec playback certification.',querySchema:input}));
