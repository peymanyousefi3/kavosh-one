import { z } from 'zod';
import { isDeepStrictEqual } from 'node:util';
import { jsonBody,record,type ApiContext,type Reply } from '../core/api.ts';
import { ApiError } from '../core/policy.ts';
import { assertSchemaReady } from '../core/database.ts';
import { lockAcademyTopology } from './academy.ts';
import { authorizeLearningRecipient,receivedLearningSelection } from './learning-recipients.ts';
import { sessionReportDocument } from './session-reports.ts';
import { issueFileDownload } from './file-downloads.ts';
import type { R2DownloadConnections } from '../integrations/r2-config.ts';

const uuid=z.string().uuid().transform(v=>v.toLowerCase()),version=z.number().int().positive().max(2147483647),empty=z.object({}).strict();
const attachmentNo=z.string().regex(/^(?:[1-9]|1[0-9]|20)$/).transform(Number),attachment=z.object({fileId:uuid,fileVersion:version,caption:z.string().max(2000)}).strict();
type Kind='report'|'homework'|'solution';
type Target={student:string;id:string;homework:string|null;kind:Kind;base:string};
const source=z.object({id:uuid,revision:version,classId:uuid,hubId:uuid,document:sessionReportDocument,attachments:z.array(attachment).max(20)}).strict();
type Source=z.infer<typeof source>;type Ref={fileId:string;fileVersion:number;mediaKind?:'image'|'video'};
const specs={
 report:{cap:'received-reports.view',document:"p.context#>'{report,document}'",revision:'p.report_version',joins:'',where:'public.report_publication_active(p.id)'},
 homework:{cap:'received-homework.view',document:'p.document',revision:'p.version',joins:'JOIN public.approval_requests a ON a.academy_id=p.academy_id AND a.id=p.approval_id',where:"p.state='published' AND p.recipient_ids @> ARRAY[$1::uuid] AND a.status='applied' AND a.reviewer_id=p.changed_by AND a.target_id=p.id AND a.action IN('homework.record','homework.edit')"},
 solution:{cap:'received-solutions.view',document:'p.document',revision:'p.version',joins:'JOIN public.homeworks h ON h.academy_id=p.academy_id AND h.id=p.homework_id JOIN public.approval_requests a ON a.academy_id=p.academy_id AND a.id=p.approval_id',where:"p.homework_id=$7 AND p.state='published' AND p.recipient_ids @> ARRAY[$1::uuid] AND h.state='published' AND h.recipient_ids @> ARRAY[$1::uuid] AND a.status='applied' AND a.reviewer_id=p.changed_by AND a.target_id=p.id AND a.action IN('homework-solution.record','homework-solution.edit')"}
} as const;
async function targetSource(ctx:ApiContext,t:Target){
 await assertSchemaReady(ctx.db);const spec=specs[t.kind],{s}=await authorizeLearningRecipient(ctx,t.student,spec.cap);await lockAcademyTopology(ctx);
 // Table/column fragments are code-owned. Every request value is bound,and
 // the SAME full-record,recipient and original local-day gate precedes data.
 const table=({report:'report_publications',homework:'homeworks',solution:'homework_solutions'}as const)[t.kind];
 const raw=(await ctx.db.query<{s:unknown}>(`SELECT jsonb_build_object('id',p.id,'revision',${spec.revision},'classId',p.class_id,'hubId',p.hub_id,'document',${spec.document},'attachments',${t.kind==='solution'?'p.attachments':"'[]'::jsonb"}) s FROM public.${table} p ${spec.joins} WHERE ${spec.where} AND ${receivedLearningSelection} LIMIT 1`,[t.student,ctx.credential.person_id,t.id,JSON.stringify(s),null,null,...t.kind==='solution'?[t.homework]:[]])).rows[0]?.s;
 if(!raw)throw new ApiError(404,'NOT_FOUND');const parsed=source.safeParse(raw);if(!parsed.success)throw new ApiError(503,'LEARNING_MEDIA_SOURCE_INVALID');return parsed.data;
}
type Binding={id:string;version:number;archived:boolean;effective_hub_id:string|null;copy_id:string;mime:string;bytes:number;destination_target:string};
export async function learningFileBinding(ctx:ApiContext,owner:{classId:string}|{studentId:string},ref:Ref,copy?:string){
 const personal='studentId'in owner,column=personal?'person_id':'class_id',anchor=personal?'person':'class',domain=personal?'student_private':'general',ownerId=personal?owner.studentId:owner.classId;
 // A metadata rename must not break an original frozen report. Compare the
 // immutable pinned content/owner revision,then serve its CURRENT metadata.
 // Never let a report turn a person/medical/financial/other-class file public.
 return(await ctx.db.query<Binding>(`SELECT f.id,f.version,f.archived,f.effective_hub_id,c.id copy_id,d.value->>'mime' mime,(d.value->>'bytes')::integer bytes,d.value->>'destinationTargetId' destination_target
 FROM public.file_catalogue f JOIN public.file_record_revisions r ON r.academy_id=f.academy_id AND r.file_id=f.id AND r.version=$2
 JOIN public.file_copy_requests c ON c.academy_id=f.academy_id AND c.file_id=f.id JOIN public.file_copy_jobs j ON j.academy_id=c.academy_id AND j.copy_id=c.id AND j.state='verified'
 CROSS JOIN LATERAL(SELECT public.file_download_source(f.id,f.version,c.id) value) d
 WHERE f.id=$1 AND f.anchor_kind='${anchor}' AND f.${column}=$3 AND f.domain='${domain}' AND NOT f.archived AND r.definition->>'domain'='${domain}' AND r.definition->>'anchor_kind'='${anchor}' AND r.definition->>'${column}'=f.${column}::text
 AND r.definition->>'claimed_mime_type'=f.claimed_mime_type AND(r.definition->>'expected_bytes')::bigint=f.expected_bytes AND(r.definition->>'expected_sha256') IS NOT DISTINCT FROM f.expected_sha256
 AND d.value IS NOT NULL AND($4::uuid IS NULL OR c.id=$4) AND($5::text IS NULL OR split_part(d.value->>'mime','/',1)=$5)
 ORDER BY c.requested_at DESC,c.id DESC LIMIT 1`,[ref.fileId,ref.fileVersion,ownerId,copy??null,ref.mediaKind??null])).rows[0]??null;
}
function items(s:Source){return[...s.document.blocks.flatMap(b=>b.kind==='media'?[{kind:'media' as const,key:b.id,caption:b.caption,ref:{fileId:b.fileId,fileVersion:b.fileVersion,mediaKind:b.mediaKind}}]:[]),...s.attachments.map((a,n)=>({kind:'attachments' as const,key:String(n+1),caption:a.caption,ref:{fileId:a.fileId,fileVersion:a.fileVersion}}))];}
export async function learningMedia(ctx:ApiContext,connections?:R2DownloadConnections):Promise<Reply|null>{
 const m=/^students\/([^/]+)\/(published-reports|homework)\/([^/]+)(?:\/solutions\/([^/]+))?\/(media|attachments)(?:\/([^/]+)\/(download-link))?$/.exec(ctx.path);if(!m)return null;
 if(m[2]==='published-reports'&&m[4]||m[5]==='attachments'&&!m[4])throw new ApiError(404,'NOT_FOUND');
 if(ctx.credential.kind!=='human')throw new ApiError(403,'HUMAN_RECIPIENT_REQUIRED');const p=new URL(ctx.request.url).searchParams;if([...p].length!==new Set(p.keys()).size)throw new ApiError(400,'DUPLICATE_QUERY');empty.parse(Object.fromEntries(p));
 const student=uuid.parse(m[1]),parent=uuid.parse(m[3]),solution=m[4]?uuid.parse(m[4]):null,t:Target={student,id:solution??parent,homework:solution?parent:null,kind:solution?'solution':m[2]==='homework'?'homework':'report',base:'students/'+student+'/'+m[2]+'/'+parent+(solution?'/solutions/'+solution:'')};
 if(ctx.request.method==='POST'&&m[7]){
  empty.parse(await jsonBody(ctx.request));const key=m[5]==='media'?uuid.parse(m[6]):String(attachmentNo.parse(m[6])),s=await targetSource(ctx,t),item=items(s).find(i=>i.kind===m[5]&&i.key===key);if(!item)throw new ApiError(404,'NOT_FOUND');const f=await learningFileBinding(ctx,s,item.ref);if(!f)throw new ApiError(409,'LEARNING_MEDIA_NOT_READY');
  const authorize=async(c:ApiContext,id:string)=>{const current=await targetSource(c,t),next=items(current).find(i=>i.kind===m[5]&&i.key===key);if(current.revision!==s.revision||!next||!isDeepStrictEqual(next.ref,item.ref)||id!==item.ref.fileId)throw new ApiError(404,'NOT_FOUND');const actual=await learningFileBinding(c,current,next.ref,f.copy_id);if(!actual)throw new ApiError(409,'LEARNING_MEDIA_NOT_READY');return actual;};
  await record(ctx.db,ctx.credential,ctx.requestId,'learning.media.read',t.id,s.hubId,{studentId:student,sourceKind:t.kind,kind:'download_request',itemKind:item.kind,itemKey:key,privateContentRedacted:true});return issueFileDownload(ctx,f.id,{expectedMetadataVersion:f.version,copyId:f.copy_id},authorize,connections);
 }
 if(ctx.request.method!=='GET'||m[7]||m[5]!=='media')throw new ApiError(405,'METHOD_NOT_ALLOWED');const s=await targetSource(ctx,t),data=[];
 for(const item of items(s)){const f=await learningFileBinding(ctx,s,item.ref);data.push({kind:item.kind,key:item.key,caption:item.caption,availability:f?'requestable':'unavailable',...f?{mime:f.mime,bytes:f.bytes,readerConfigured:Boolean(connections?.(ctx.credential.academy_id,f.destination_target)),downloadPath:'/api/v1/'+t.base+'/'+item.kind+'/'+item.key+'/download-link'}:{},retrievalVerified:false});}
 await record(ctx.db,ctx.credential,ctx.requestId,'learning.media.read',t.id,s.hubId,{studentId:student,sourceKind:t.kind,kind:'directory',rows:data.length,privateContentRedacted:true});return{status:200,body:{data,privateFamilyOnly:true,publiclyPublished:false,mediaContentIncluded:false,videoServingVerified:false,externalRetrievalVerified:false}};
}
const readSummary='Current verified self/legal family descriptors for an exact released learning record under existing feature,class/student/hub and original joining-day gates. Captions and opaque item keys only;no raw file/copy IDs,private notes,storage source or bearer URLs. Requestable means existing decoded-image/inspected-PDF or complete UTF-8-text copy/policy evidence;source text is never executed or rendered,not live retrieval or malware-free certification. Video remains unavailable until its inspection/serving pipeline is implemented.';
const downloadSummary='Current self/legal family retrieves only this exact released learning item through the shared audited,conditional private attachment service. Empty body;no caller file/copy/version/actor selection. Current publication,recipient,scope,dated membership,original class-owned general content and verified serving policy rechecked on every retry. Metadata-only renames preserve content identity. At most60second bearer expiry is not instantly revocable;read-only allowed. No retrieval,malware-free or video certification.';
export const learningMediaContract=[
 {path:'/api/v1/students/{id}/published-reports/{publicationId}/media',method:'get',humanOnly:true,summary:readSummary},
 {path:'/api/v1/students/{id}/published-reports/{publicationId}/media/{blockId}/download-link',method:'post',humanOnly:true,summary:downloadSummary,schema:empty},
 {path:'/api/v1/students/{id}/homework/{homeworkId}/media',method:'get',humanOnly:true,summary:readSummary},
 {path:'/api/v1/students/{id}/homework/{homeworkId}/media/{blockId}/download-link',method:'post',humanOnly:true,summary:downloadSummary,schema:empty},
 {path:'/api/v1/students/{id}/homework/{homeworkId}/solutions/{solutionId}/media',method:'get',humanOnly:true,summary:readSummary},
 {path:'/api/v1/students/{id}/homework/{homeworkId}/solutions/{solutionId}/media/{blockId}/download-link',method:'post',humanOnly:true,summary:downloadSummary,schema:empty},
 {path:'/api/v1/students/{id}/homework/{homeworkId}/solutions/{solutionId}/attachments/{attachmentNo}/download-link',method:'post',humanOnly:true,pathSchemas:{attachmentNo},summary:downloadSummary,schema:empty}
] as const;
