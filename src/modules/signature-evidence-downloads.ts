import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { jsonBody,mutation,record,type ApiContext,type Reply } from '../core/api.ts';
import { lockApprovalWrites } from '../core/approvals.ts';
import { ApiError } from '../core/policy.ts';
import { lockAcademyTopology } from './academy.ts';
import { permittedSignatureSend } from './signature-sends.ts';
import { permittedWorkSignatureEvidence } from './work-signature-completions.ts';
import { signatureEvidenceInspectionTaskSchema } from '../integrations/signature-evidence-inspection.ts';
import { privateR2 } from '../integrations/r2.ts';
import type { R2DownloadConnections } from '../integrations/r2-config.ts';

const uuid=z.string().uuid().transform(v=>v.toLowerCase()),hash=z.string().regex(/^[a-f0-9]{64}$/);
const input=z.object({routeId:uuid}).strict(),empty=z.object({}).strict();
const sourceSchema=signatureEvidenceInspectionTaskSchema.extend({inspectionId:uuid,inspectionFingerprint:hash,routeId:uuid,routeVersion:z.number().int().positive(),routeApprovalId:uuid,maximumLinkSeconds:z.number().int().min(1).max(60)}).strict();
const workSourceSchema=sourceSchema.extend({purpose:z.literal('worker_services')}).strict();
const receipt=z.object({id:uuid,evidenceId:uuid,kind:z.enum(['document','audit']),routeId:uuid,issuedAt:z.iso.datetime(),expiresAt:z.iso.datetime(),sourceFingerprint:hash}).strict();
async function evidenceDownloads(purpose:'unified_enrollment'|'worker_services',ctx:ApiContext,connections?:R2DownloadConnections):Promise<Reply|null>{
 const work=purpose==='worker_services',path=(work?/^payroll\/work-signature-send-requests\/([^/]+)\/completion-evidence\/([^/]+)\/(document|audit)\/download-link$/:/^signature-send-requests\/([^/]+)\/completion-evidence\/([^/]+)\/(document|audit)\/download-link$/).exec(ctx.path);if(!path)return null;
 if(ctx.request.method!=='POST')throw new ApiError(405,'METHOD_NOT_ALLOWED');
 if(ctx.credential.kind!=='human')throw new ApiError(403,'HUMAN_EVIDENCE_INSPECTION_REQUIRED');
 empty.parse(Object.fromEntries(new URL(ctx.request.url).searchParams));const requestId=uuid.parse(path[1]),evidenceId=uuid.parse(path[2]),kind=z.enum(['document','audit']).parse(path[3]),i=input.parse(await jsonBody(ctx.request));
 await lockApprovalWrites(ctx);await lockAcademyTopology(ctx);
 let hubId:string|null;if(work){hubId=(await permittedWorkSignatureEvidence(ctx,requestId,true)).w.hub_id;}else{await permittedSignatureSend(ctx,requestId,'signature-completions.view');hubId=(await permittedSignatureSend(ctx,requestId,'signature-completions.inspect')).p.hub_id;}
 // Every identifier below is one of TWO internal constants. No body,query,
 // template,URL or operator-provided SQL identifiers enter these statements.
 const evidenceTable=work?'public.work_signature_completion_evidence':'public.signature_completion_evidence',startTable=work?'public.work_signature_dispatch_starts':'public.signature_dispatch_starts',attemptTable=work?'public.work_signature_send_attempts':'public.signature_send_attempts',grantTable=work?'public.work_signature_evidence_download_grants':'public.signature_evidence_download_grants',sourceFunction=work?'public.work_signature_evidence_download_source':'public.signature_evidence_download_source',action=work?'work.signature.evidence.download.issued':'signature.evidence.download.issued';
 if(!(await ctx.db.query(`SELECT e.id FROM ${evidenceTable} e JOIN ${startTable} s ON s.academy_id=e.academy_id AND s.id=e.start_id JOIN ${attemptTable} a ON a.academy_id=s.academy_id AND a.id=s.attempt_id WHERE a.request_id=$1 AND e.id=$2`,[requestId,evidenceId])).rows.length)throw new ApiError(404,'NOT_FOUND');
 await ctx.db.query('SELECT id FROM public.file_storage_routes WHERE id=$1 FOR SHARE',[i.routeId]);
 const raw=(await ctx.db.query<{source:unknown}>(`SELECT ${sourceFunction}($1,$2,$3) source`,[evidenceId,kind,i.routeId])).rows[0]?.source;
 if(!raw)throw new ApiError(409,'SIGNATURE_EVIDENCE_DOWNLOAD_NOT_READY');const parsed=(work?workSourceSchema:sourceSchema).safeParse(raw);if(!parsed.success)throw new ApiError(503,'SIGNATURE_EVIDENCE_SOURCE_INVALID');const source=parsed.data;
 let configuration;try{configuration=connections?.(ctx.credential.academy_id,source.storageTargetId);}catch{throw new ApiError(503,'R2_DOWNLOAD_NOT_CONFIGURED');}if(!configuration)throw new ApiError(503,'R2_DOWNLOAD_NOT_CONFIGURED');
 const storage=privateR2(configuration,ctx.credential.academy_id);
 try{
  if(storage.storageTargetId!==source.storageTargetId)throw new ApiError(503,'R2_DOWNLOAD_NOT_CONFIGURED');if(source.bytes>storage.maximumUploadBytes)throw new ApiError(409,'FILE_EXCEEDS_DOWNLOAD_LIMIT');
  const reply=await mutation(ctx,i,async()=>{
   const grantId=randomUUID();await record(ctx.db,ctx.credential,ctx.requestId,action,grantId,hubId,{requestId,evidenceId,kind,privateAttachment:true,externalRequestMade:false,retrievalVerified:false,admissionCleared:false});
   const saved=(await ctx.db.query<Omit<z.infer<typeof receipt>,'issuedAt'|'expiresAt'>&{issuedAt:Date|string;expiresAt:Date|string}>(`INSERT INTO ${grantTable}(academy_id,id,evidence_id,kind,route_id,created_by,audit_id)
    SELECT $1,$2,$3,$4,$5,$6,a.id FROM public.audit_events a WHERE a.academy_id=$1 AND a.entity_id=$2 AND a.request_id=$7 AND a.action=$8 AND a.created_at=transaction_timestamp()
    RETURNING id,evidence_id AS "evidenceId",kind,route_id AS "routeId",issued_at AS "issuedAt",expires_at AS "expiresAt",source_fingerprint AS "sourceFingerprint"`,[ctx.credential.academy_id,grantId,evidenceId,kind,i.routeId,ctx.credential.person_id,ctx.requestId,action])).rows[0];
   if(!saved)throw new ApiError(503,'SIGNATURE_EVIDENCE_GRANT_MISSING');return {status:201,body:{data:{...saved,issuedAt:new Date(saved.issuedAt).toISOString(),expiresAt:new Date(saved.expiresAt).toISOString()}}};
  });
  const parsedReceipt=receipt.safeParse((reply.body as {data:unknown}).data);if(!parsedReceipt.success)throw new ApiError(503,'SIGNATURE_EVIDENCE_GRANT_MISSING');const saved=parsedReceipt.data;
  if(saved.evidenceId!==evidenceId||saved.kind!==kind||saved.routeId!==i.routeId)throw new ApiError(409,'TARGET_CHANGED');
  const current=(await ctx.db.query<{current:boolean}>(`SELECT source IS NOT DISTINCT FROM ${sourceFunction}($1,$2,$3) AS current FROM ${grantTable} WHERE id=$4 AND created_by=$5 AND source_fingerprint=$6`,[evidenceId,kind,i.routeId,saved.id,ctx.credential.person_id,saved.sourceFingerprint])).rows[0];
  if(!current?.current)throw new ApiError(409,'SIGNATURE_EVIDENCE_SOURCE_CHANGED');
  const seconds=(Date.parse(saved.expiresAt)-Date.parse(saved.issuedAt))/1000,download=await storage.signatureEvidenceDownload(source.artifactId,seconds,{issuedAt:saved.issuedAt,ifMatch:source.etag});
  if(download.expiresAt!==saved.expiresAt)throw new ApiError(503,'SIGNATURE_EVIDENCE_GRANT_MISSING');
  return {status:reply.status,body:{data:{...saved,bytes:source.bytes,sha256:source.sha256,mime:'application/pdf',download,accessModel:'short_lived_bearer',accessMayRemainValidUntil:saved.expiresAt,retrievalVerified:false,malwareFreeVerified:false,cryptographicValidityVerified:false,providerStatusFreshlyChecked:false,admissionCleared:false,...work?{purpose:'worker_services',signedByBothPartiesVerified:false,legallyEffective:false,paymentCleared:false}:{}}}};
 }finally{storage.close();}
}
export const signatureEvidenceDownloads=(ctx:ApiContext,connections?:R2DownloadConnections)=>evidenceDownloads('unified_enrollment',ctx,connections);
export const workSignatureEvidenceDownloads=(ctx:ApiContext,connections?:R2DownloadConnections)=>evidenceDownloads('worker_services',ctx,connections);
export const signatureEvidenceDownloadsContract=(['document','audit'] as const).map(kind=>({path:`/api/v1/signature-send-requests/{id}/completion-evidence/{evidenceId}/${kind}/download-link`,method:'post' as const,humanOnly:true,summary:'Human-only audited private '+kind+' PDF attachment;separate inspect and original source rights,recorded structural/scanner evidence and explicitly upper-reviewed signedEvidence serving policy required. Fixed expiry,not admission,legal or crypto verification.',schema:input}));
export const workSignatureEvidenceDownloadsContract=(['document','audit']as const).map(kind=>({path:`/api/v1/payroll/work-signature-send-requests/{id}/completion-evidence/{evidenceId}/${kind}/download-link`,method:'post' as const,humanOnly:true,summary:'Human-only audited private worker '+kind+' attachment in the original work-signing workspace. Independent view/inspect plus current work/template/file rights,exact recorded screening and explicitly upper-reviewed workSignedEvidence policy. Enrollment signedEvidence alone never authorizes this. Fixed short expiry,not retrieval,signature approval,legal or payment verification.',schema:input}));
