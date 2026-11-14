import { z } from 'zod';
import { jsonBody,type ApiContext,type Reply } from '../core/api.ts';
import { ApiError } from '../core/policy.ts';
import { receivedStudentScope } from './family-access.ts';
import { issueFileDownload } from './file-downloads.ts';
import type { R2DownloadConnections } from '../integrations/r2-config.ts';

const uuid=z.string().uuid().transform(v=>v.toLowerCase()),empty=z.object({}).strict();
export async function familyReceiptDownload(ctx:ApiContext,connections?:R2DownloadConnections):Promise<Reply|null>{
 const m=/^students\/([^/]+)\/tuition-invoices\/([^/]+)\/receipts\/([^/]+)\/attachment-download-link$/.exec(ctx.path);if(!m)return null;
 if(ctx.request.method!=='POST')throw new ApiError(405,'METHOD_NOT_ALLOWED');empty.parse(Object.fromEntries(new URL(ctx.request.url).searchParams));empty.parse(await jsonBody(ctx.request));
 const studentId=uuid.parse(m[1]),invoiceId=uuid.parse(m[2]),receiptId=uuid.parse(m[3]);
 async function authorized(c:ApiContext,fileId?:string){const scope=await receivedStudentScope(c,studentId,'received-tuition.view');
  // The ORIGINAL applied payment approval must pin this exact evidence. No
  // general student-file grants,caller-selected file,copy,person or role.
  // Metadata names may evolve;the immutable content/owner binding cannot.
  const f=(await c.db.query<{id:string;version:number;archived:boolean;effective_hub_id:string|null}>(`SELECT f.id,f.version,f.archived,f.effective_hub_id
   FROM public.tuition_receipts r JOIN public.approval_requests a ON a.academy_id=r.academy_id AND a.id=r.approval_id AND a.status='applied' AND a.action='finance.receipt.record' AND a.target_id=r.id AND a.reviewer_id=r.created_by AND a.privacy_capability='receipts.edit'
   JOIN public.file_catalogue f ON f.academy_id=r.academy_id AND f.id=r.evidence_file AND f.domain='student_private' AND f.person_id=r.student_id
   JOIN public.file_record_revisions v ON v.academy_id=r.academy_id AND v.file_id=r.evidence_file AND v.version=r.evidence_version
   WHERE r.id=$1 AND r.invoice_id=$2 AND r.student_id=$3 AND($4::uuid IS NULL OR f.id=$4)
   AND a.payload#>>'{evidence,id}'=r.evidence_file::text AND(a.payload#>>'{evidence,version}')::integer=r.evidence_version
   AND v.definition->>'claimed_mime_type'=f.claimed_mime_type AND(v.definition->>'expected_bytes')::bigint=f.expected_bytes AND(v.definition->>'expected_sha256') IS NOT DISTINCT FROM f.expected_sha256
   AND public.registration_data_basis(r.student_id,$5) IS NOT NULL
   AND public.scope_contains($6::jsonb,jsonb_build_object('all',false,'hubs','[]'::jsonb,'people',jsonb_build_array(jsonb_build_object('id',r.student_id,'hubId',r.hub_id)),'recordContext',jsonb_build_object('hubId',r.hub_id,'classId',r.class_id,'studentId',r.student_id)))`,[receiptId,invoiceId,studentId,fileId??null,c.credential.person_id,JSON.stringify(scope)])).rows[0];
  if(!f)throw new ApiError(404,'NOT_FOUND');if(f.archived)throw new ApiError(409,'FILE_ARCHIVED');return {...f,receiptId};
 }
 const f=await authorized(ctx);
 const copy=(await ctx.db.query<{id:string}>(`SELECT c.id FROM public.file_copy_requests c JOIN public.file_copy_jobs j ON j.academy_id=c.academy_id AND j.copy_id=c.id AND j.state='verified' WHERE c.file_id=$1 AND public.file_download_source($1,$2,c.id) IS NOT NULL ORDER BY c.requested_at DESC,c.id DESC LIMIT 1`,[f.id,f.version])).rows[0];
 if(!copy)throw new ApiError(409,'FILE_DOWNLOAD_NOT_READY');
 return issueFileDownload(ctx,f.id,{expectedMetadataVersion:f.version,copyId:copy.id},authorized,connections);
}
export const familyReceiptDownloadContract=[{path:'/api/v1/students/{id}/tuition-invoices/{invoiceId}/receipts/{receiptId}/attachment-download-link',method:'post',humanOnly:true,summary:'Current permitted legal family retrieves only the original upper-approved receipt attachment through the existing audited private attachment service. No general student/file rights,caller file/copy selection or raw upload URL. Exact approved owner/content,unarchived metadata,clean verified copy,active reviewed serving policy and configured reader required;fixed-expiry bearer link is not instantly revocable and does not prove retrieval or malware-free content. Reversed receipts retain original evidence history.',schema:empty}] as const;
