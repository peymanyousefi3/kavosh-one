import { z } from 'zod';
import { isDeepStrictEqual } from 'node:util';
import { jsonBody,record,type ApiContext,type Reply } from '../core/api.ts';
import { ApiError } from '../core/policy.ts';
import { assertSchemaReady } from '../core/database.ts';
import { lockAcademyTopology } from './academy.ts';
import { submissionMediaSource,type SubmissionReaderTarget } from './homework-submissions.ts';
import { learningFileBinding } from './learning-media.ts';
import { issueFileDownload } from './file-downloads.ts';
import type { R2DownloadConnections } from '../integrations/r2-config.ts';

const uuid=z.string().uuid().transform(v=>v.toLowerCase()),empty=z.object({}).strict(),version=z.string().regex(/^[1-9][0-9]{0,9}$/).transform(Number).pipe(z.number().int().max(2147483647)),attachmentNo=z.string().regex(/^(?:[1-9]|1[0-9]|20)$/).transform(Number);
export async function submissionMedia(ctx:ApiContext,connections?:R2DownloadConnections):Promise<Reply|null>{
 const family=/^students\/([^/]+)\/homework\/([^/]+)\/submission\/versions\/([^/]+)\/attachments(?:\/([^/]+)\/(download-link))?$/.exec(ctx.path),staff=/^homework-submissions\/([^/]+)\/versions\/([^/]+)\/attachments(?:\/([^/]+)\/(download-link))?$/.exec(ctx.path);if(!family&&!staff)return null;
 if(family&&ctx.credential.kind!=='human')throw new ApiError(403,'HUMAN_RECIPIENT_REQUIRED');const params=new URL(ctx.request.url).searchParams;if([...params].length!==new Set(params.keys()).size)throw new ApiError(400,'DUPLICATE_QUERY');empty.parse(Object.fromEntries(params));
 const target:SubmissionReaderTarget=family?{studentId:uuid.parse(family[1]),homeworkId:uuid.parse(family[2])}:{submissionId:uuid.parse(staff![1])},v=version.parse(family?family[3]:staff![2]),number=family?family[4]:staff![3],download=family?family[5]:staff![4];
 if(ctx.request.method!==(download?'POST':'GET'))throw new ApiError(405,'METHOD_NOT_ALLOWED');if(download)empty.parse(await jsonBody(ctx.request));await assertSchemaReady(ctx.db);
 const selected=await submissionMediaSource(ctx,target,v);await lockAcademyTopology(ctx);const owner={studentId:selected.student_id};
 if(download){
  const n=attachmentNo.parse(number),ref=selected.answer.attachments[n-1];if(!ref)throw new ApiError(404,'NOT_FOUND');const file=await learningFileBinding(ctx,owner,ref);if(!file)throw new ApiError(409,'SUBMISSION_ATTACHMENT_NOT_READY');
  const authorize=async(c:ApiContext,id:string)=>{const current=await submissionMediaSource(c,target,v),next=current.answer.attachments[n-1];if(current.id!==selected.id||current.student_id!==owner.studentId||!next||id!==ref.fileId||!isDeepStrictEqual(next,ref))throw new ApiError(404,'NOT_FOUND');const f=await learningFileBinding(c,owner,next,file.copy_id);if(!f)throw new ApiError(409,'SUBMISSION_ATTACHMENT_NOT_READY');return f;};
  await record(ctx.db,ctx.credential,ctx.requestId,'learning.submission-attachment.read',selected.id,selected.hub_id,{submissionVersion:v,attachmentNo:n,kind:'download_request',privateContentRedacted:true});return issueFileDownload(ctx,file.id,{expectedMetadataVersion:file.version,copyId:file.copy_id},authorize,connections);
 }
 const data=[];for(const [n,ref]of selected.answer.attachments.entries()){const f=await learningFileBinding(ctx,owner,ref);data.push({attachmentNo:n+1,caption:ref.caption,name:selected.context.attachments[n]?.name,availability:f?'requestable':'unavailable',...f?{mime:f.mime,bytes:f.bytes,readerConfigured:Boolean(connections?.(ctx.credential.academy_id,f.destination_target)),downloadPath:'/api/v1/'+ctx.path+'/'+(n+1)+'/download-link'}:{},retrievalVerified:false});}
 await record(ctx.db,ctx.credential,ctx.requestId,'learning.submission-attachment.read',selected.id,selected.hub_id,{submissionVersion:v,kind:'directory',rows:data.length,privateContentRedacted:true});return{status:200,body:{data,submissionId:selected.id,submissionVersion:v,state:selected.state,privateOnly:true,publiclyPublished:false,attachmentContentIncluded:false,externalRetrievalVerified:false}};
}
const summary='Exact immutable student-answer revision attachments through the SAME current JSON-reader permission,draft and original-day enrollment gates. Family needs actual current verified self/legal-family authority;staff/bot uses its own current separately scoped homework-submissions.view and explicit drafts permission,never a family impersonation. A later private draft never exposes itself or conceals permitted older submitted work. Only this student-owned student_private content,original pinned file revision and current decoded-image/inspected-PDF or complete UTF-8-text verified serving evidence. No raw file/copy/source IDs in descriptors,no answer text,private context,credentials or bearer URLs. UTF-8 source is a non-executed attachment,not a preview or code-safety claim. Video/other formats remain unavailable,not certified safe.';
const downloadSummary=summary+' Empty body,no file/copy/actor override. Rechecks every retry;shared audited conditional download,metadata rename supported,archive blocks,at most60second fixed bearer expiry not instantly revocable. Read-only allowed,no live retrieval or malware-free claim.';
export const submissionMediaContract=[
 {path:'/api/v1/students/{id}/homework/{homeworkId}/submission/versions/{version}/attachments',method:'get',humanOnly:true,pathSchemas:{version},summary},
 {path:'/api/v1/students/{id}/homework/{homeworkId}/submission/versions/{version}/attachments/{attachmentNo}/download-link',method:'post',humanOnly:true,pathSchemas:{version,attachmentNo},summary:downloadSummary,schema:empty},
 {path:'/api/v1/homework-submissions/{id}/versions/{version}/attachments',method:'get',pathSchemas:{version},summary},
 {path:'/api/v1/homework-submissions/{id}/versions/{version}/attachments/{attachmentNo}/download-link',method:'post',pathSchemas:{version,attachmentNo},summary:downloadSummary,schema:empty}
]as const;
