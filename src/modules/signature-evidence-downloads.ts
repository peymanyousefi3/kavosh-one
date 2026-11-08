import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { jsonBody,mutation,record,type ApiContext,type Reply } from '../core/api.ts';
import { lockApprovalWrites } from '../core/approvals.ts';
import { ApiError } from '../core/policy.ts';
import { lockAcademyTopology } from './academy.ts';
import { permittedSignatureSend } from './signature-sends.ts';
import { signatureEvidenceInspectionTaskSchema } from '../integrations/signature-evidence-inspection.ts';
import { privateR2 } from '../integrations/r2.ts';
import type { R2DownloadConnections } from '../integrations/r2-config.ts';

const uuid=z.string().uuid().transform(v=>v.toLowerCase()),hash=z.string().regex(/^[a-f0-9]{64}$/);
const input=z.object({routeId:uuid}).strict(),empty=z.object({}).strict();
const sourceSchema=signatureEvidenceInspectionTaskSchema.extend({inspectionId:uuid,inspectionFingerprint:hash,routeId:uuid,routeVersion:z.number().int().positive(),routeApprovalId:uuid,maximumLinkSeconds:z.number().int().min(1).max(60)}).strict();
const receipt=z.object({id:uuid,evidenceId:uuid,kind:z.enum(['document','audit']),routeId:uuid,issuedAt:z.iso.datetime(),expiresAt:z.iso.datetime(),sourceFingerprint:hash}).strict();
export async function signatureEvidenceDownloads(ctx:ApiContext,connections?:R2DownloadConnections):Promise<Reply|null>{
 const path=/^signature-send-requests\/([^/]+)\/completion-evidence\/([^/]+)\/(document|audit)\/download-link$/.exec(ctx.path);if(!path)return null;
 if(ctx.request.method!=='POST')throw new ApiError(405,'METHOD_NOT_ALLOWED');
 if(ctx.credential.kind!=='human')throw new ApiError(403,'HUMAN_EVIDENCE_INSPECTION_REQUIRED');
 empty.parse(Object.fromEntries(new URL(ctx.request.url).searchParams));const requestId=uuid.parse(path[1]),evidenceId=uuid.parse(path[2]),kind=z.enum(['document','audit']).parse(path[3]),i=input.parse(await jsonBody(ctx.request));
 await lockApprovalWrites(ctx);await lockAcademyTopology(ctx);
 await permittedSignatureSend(ctx,requestId,'signature-completions.view');const {p}=await permittedSignatureSend(ctx,requestId,'signature-completions.inspect');
 if(!(await ctx.db.query(`SELECT e.id FROM public.signature_completion_evidence e JOIN public.signature_dispatch_starts s ON s.academy_id=e.academy_id AND s.id=e.start_id JOIN public.signature_send_attempts a ON a.academy_id=s.academy_id AND a.id=s.attempt_id WHERE a.request_id=$1 AND e.id=$2`,[requestId,evidenceId])).rows.length)throw new ApiError(404,'NOT_FOUND');
 await ctx.db.query('SELECT id FROM public.file_storage_routes WHERE id=$1 FOR SHARE',[i.routeId]);
 const raw=(await ctx.db.query<{source:unknown}>('SELECT public.signature_evidence_download_source($1,$2,$3) source',[evidenceId,kind,i.routeId])).rows[0]?.source;
 if(!raw)throw new ApiError(409,'SIGNATURE_EVIDENCE_DOWNLOAD_NOT_READY');const parsed=sourceSchema.safeParse(raw);if(!parsed.success)throw new ApiError(503,'SIGNATURE_EVIDENCE_SOURCE_INVALID');const source=parsed.data;
 let configuration;try{configuration=connections?.(ctx.credential.academy_id,source.storageTargetId);}catch{throw new ApiError(503,'R2_DOWNLOAD_NOT_CONFIGURED');}if(!configuration)throw new ApiError(503,'R2_DOWNLOAD_NOT_CONFIGURED');
 const storage=privateR2(configuration,ctx.credential.academy_id);
 try{
  if(storage.storageTargetId!==source.storageTargetId)throw new ApiError(503,'R2_DOWNLOAD_NOT_CONFIGURED');if(source.bytes>storage.maximumUploadBytes)throw new ApiError(409,'FILE_EXCEEDS_DOWNLOAD_LIMIT');
  const reply=await mutation(ctx,i,async()=>{
   const grantId=randomUUID();await record(ctx.db,ctx.credential,ctx.requestId,'signature.evidence.download.issued',grantId,p.hub_id,{requestId,evidenceId,kind,privateAttachment:true,externalRequestMade:false,retrievalVerified:false,admissionCleared:false});
   const saved=(await ctx.db.query<Omit<z.infer<typeof receipt>,'issuedAt'|'expiresAt'>&{issuedAt:Date|string;expiresAt:Date|string}>(`INSERT INTO public.signature_evidence_download_grants(academy_id,id,evidence_id,kind,route_id,created_by,audit_id)
    SELECT $1,$2,$3,$4,$5,$6,a.id FROM public.audit_events a WHERE a.academy_id=$1 AND a.entity_id=$2 AND a.request_id=$7 AND a.action='signature.evidence.download.issued' AND a.created_at=transaction_timestamp()
    RETURNING id,evidence_id AS "evidenceId",kind,route_id AS "routeId",issued_at AS "issuedAt",expires_at AS "expiresAt",source_fingerprint AS "sourceFingerprint"`,[ctx.credential.academy_id,grantId,evidenceId,kind,i.routeId,ctx.credential.person_id,ctx.requestId])).rows[0];
   if(!saved)throw new ApiError(503,'SIGNATURE_EVIDENCE_GRANT_MISSING');return {status:201,body:{data:{...saved,issuedAt:new Date(saved.issuedAt).toISOString(),expiresAt:new Date(saved.expiresAt).toISOString()}}};
  });
  const parsedReceipt=receipt.safeParse((reply.body as {data:unknown}).data);if(!parsedReceipt.success)throw new ApiError(503,'SIGNATURE_EVIDENCE_GRANT_MISSING');const saved=parsedReceipt.data;
  if(saved.evidenceId!==evidenceId||saved.kind!==kind||saved.routeId!==i.routeId)throw new ApiError(409,'TARGET_CHANGED');
  const current=(await ctx.db.query<{current:boolean}>(`SELECT source IS NOT DISTINCT FROM public.signature_evidence_download_source($1,$2,$3) AS current FROM public.signature_evidence_download_grants WHERE id=$4 AND created_by=$5 AND source_fingerprint=$6`,[evidenceId,kind,i.routeId,saved.id,ctx.credential.person_id,saved.sourceFingerprint])).rows[0];
  if(!current?.current)throw new ApiError(409,'SIGNATURE_EVIDENCE_SOURCE_CHANGED');
  const seconds=(Date.parse(saved.expiresAt)-Date.parse(saved.issuedAt))/1000,download=await storage.signatureEvidenceDownload(source.artifactId,seconds,{issuedAt:saved.issuedAt,ifMatch:source.etag});
  if(download.expiresAt!==saved.expiresAt)throw new ApiError(503,'SIGNATURE_EVIDENCE_GRANT_MISSING');
  return {status:reply.status,body:{data:{...saved,bytes:source.bytes,sha256:source.sha256,mime:'application/pdf',download,accessModel:'short_lived_bearer',accessMayRemainValidUntil:saved.expiresAt,retrievalVerified:false,malwareFreeVerified:false,cryptographicValidityVerified:false,providerStatusFreshlyChecked:false,admissionCleared:false}}};
 }finally{storage.close();}
}
export const signatureEvidenceDownloadsContract=(['document','audit'] as const).map(kind=>({path:`/api/v1/signature-send-requests/{id}/completion-evidence/{evidenceId}/${kind}/download-link`,method:'post' as const,humanOnly:true,summary:'Human-only audited private '+kind+' PDF attachment;separate inspect and original source rights,recorded structural/scanner evidence and explicitly upper-reviewed signedEvidence serving policy required. Fixed expiry,not admission,legal or crypto verification.',schema:input}));
