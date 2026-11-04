import { z } from 'zod';
import { jsonBody,mutation,record,type ApiContext,type Reply } from '../core/api.ts';
import { propose,permissionScope,type ApprovalRegistry,type Proposal } from '../core/approvals.ts';
import { ApiError,requireScope } from '../core/policy.ts';
import { lockAcademyTopology } from './academy.ts';
import { permittedFile } from './files.ts';
import { r2Connection,type R2UploadConnections } from '../integrations/r2-config.ts';

const uuid=z.string().uuid().transform(v=>v.toLowerCase()),version=z.number().int().positive().max(2_147_483_647);
const reason=z.string().trim().min(1).max(2000).refine(v=>v.isWellFormed()&&!v.includes('\0'));
export const defaultUploadMimeTypes=['image/jpeg','image/png','image/webp','image/gif','image/avif','image/heic','image/heif','video/mp4','video/quicktime','video/webm','audio/mpeg','audio/mp4','audio/wav','application/pdf','application/zip','text/plain','text/csv','application/json'];
const mime=z.string().regex(/^[a-z0-9][a-z0-9.+-]{0,99}\/[a-z0-9][a-z0-9.+-]{0,99}$/);
const fields={uploadsEnabled:z.boolean(),maximumFileBytes:z.number().int().min(1).max(4_294_967_296),maximumReservedBytes:z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),maximumFiles:z.number().int().min(1).max(1_000_000_000),allowedMimeTypes:z.array(mime).max(64).refine(v=>new Set(v).size===v.length)};
const definition=z.object(fields).strict().refine(v=>v.maximumFileBytes<=v.maximumReservedBytes,'The total reservation budget must fit at least one maximum-size file.');
const createInput=z.object({...fields,uploadsEnabled:fields.uploadsEnabled.default(false),maximumFileBytes:fields.maximumFileBytes.default(67_108_864),maximumReservedBytes:fields.maximumReservedBytes.default(268_435_456),maximumFiles:fields.maximumFiles.default(10),allowedMimeTypes:fields.allowedMimeTypes.default(()=>[...defaultUploadMimeTypes]),expectedVersion:z.literal(0),reason}).strict();
const updateInput=z.object(fields).partial().extend({expectedVersion:version,reason}).strict().refine(v=>Object.keys(v).some(k=>k!=='expectedVersion'&&k!=='reason'));
const policyInput=z.union([createInput,updateInput]);
const reservationInput=z.object({expectedMetadataVersion:version}).strict();
const inspectionInput=reservationInput.extend({grantId:uuid});
const grantReceipt=z.object({id:uuid,fileId:uuid,metadataVersion:version,storageTargetId:z.string().regex(/^[a-f0-9]{64}$/),issuedAt:z.iso.datetime(),expiresAt:z.iso.datetime(),formatPolicyVersion:version.nullable().default(null)}).strict();
const historyQuery=z.object({limit:z.coerce.number().int().min(1).max(100).default(50),afterVersion:z.coerce.number().int().min(0).max(2_147_483_647).default(0)}).strict();
const grantHistoryQuery=z.object({limit:z.coerce.number().int().min(1).max(100).default(50),afterIssuedAt:z.iso.datetime().optional(),afterId:uuid.optional()}).strict().refine(v=>Boolean(v.afterIssuedAt)===Boolean(v.afterId),'Use both cursor fields together.');
interface Policy {academyId:string;uploadsEnabled:boolean;maximumFileBytes:number;maximumReservedBytes:number;maximumFiles:number;allowedMimeTypes:string[];reservedBytes:number;reservedFiles:number;version:number}
const policyFields=`academy_id AS "academyId",uploads_enabled AS "uploadsEnabled",maximum_file_bytes::float8 AS "maximumFileBytes",maximum_reserved_bytes::float8 AS "maximumReservedBytes",
 maximum_files AS "maximumFiles",allowed_mime_types AS "allowedMimeTypes",reserved_bytes::float8 AS "reservedBytes",reserved_files AS "reservedFiles",version`;
function authority(ctx:ApiContext,edit=false) {requireScope(permissionScope(ctx,'storage.view'));if(edit)requireScope(permissionScope(ctx,'storage.edit'));}
async function policy(ctx:ApiContext,lock=false) {return (await ctx.db.query<Policy>('SELECT '+policyFields+' FROM public.file_storage_policies WHERE academy_id=$1'+(lock?' FOR UPDATE':''),[ctx.credential.academy_id])).rows[0]??null;}
async function validate(ctx:ApiContext,raw:unknown) {
  authority(ctx,true);const input=policyInput.parse(raw),before=await policy(ctx,true);
  if((before?.version??0)!==input.expectedVersion)throw new ApiError(409,'TARGET_CHANGED');
  const {expectedVersion:ignoredVersion,reason:ignoredReason,...patch}=input;
  definition.parse({...before?definition.strip().parse(before):{},...patch});return {all:true,hubs:[]};
}
async function apply(ctx:ApiContext,p:Proposal) {
  if(ctx.credential.kind!=='human')throw new ApiError(403,'HUMAN_REVIEW_REQUIRED');
  const input=policyInput.parse(p.payload),before=await policy(ctx,true);
  if((before?.version??0)!==input.expectedVersion||p.target_version!==input.expectedVersion)throw new ApiError(409,'TARGET_CHANGED');
  const {expectedVersion:ignoredVersion,reason:why,...patch}=input,body=definition.parse({...before?definition.strip().parse(before):{},...patch});
  if(before)await ctx.db.query('UPDATE public.file_storage_policies SET uploads_enabled=$2,maximum_file_bytes=$3,maximum_reserved_bytes=$4,maximum_files=$5,version=version+1,last_approval_id=$6,allowed_mime_types=$7 WHERE academy_id=$1',[ctx.credential.academy_id,body.uploadsEnabled,body.maximumFileBytes,body.maximumReservedBytes,body.maximumFiles,p.id,body.allowedMimeTypes]);
  else await ctx.db.query('INSERT INTO public.file_storage_policies(academy_id,uploads_enabled,maximum_file_bytes,maximum_reserved_bytes,maximum_files,last_approval_id,allowed_mime_types) VALUES($1,$2,$3,$4,$5,$6,$7)',[ctx.credential.academy_id,body.uploadsEnabled,body.maximumFileBytes,body.maximumReservedBytes,body.maximumFiles,p.id,body.allowedMimeTypes]);
  const after=(await policy(ctx))!;
  await ctx.db.query('INSERT INTO public.file_storage_policy_revisions(academy_id,version,definition,changed_by,approval_id,reason) VALUES($1,$2,$3::jsonb,$4,$5,$6)',[ctx.credential.academy_id,after.version,JSON.stringify(body),ctx.credential.person_id,p.id,why]);
  await record(ctx.db,ctx.credential,ctx.requestId,'file.storage.policy.updated',ctx.credential.academy_id,null,{beforeVersion:before?.version??null,afterVersion:after.version,fields:Object.keys(patch),severity:'critical',hasReason:true});
  return {...after,usageBasis:'reserved_claims',physicalStorageVerified:false};
}
export const storageActions:ApprovalRegistry={
  'storage.policy.set':{requestCapability:'storage.edit',privacyCapability:'storage.view',policyChange:true,validate:(ctx,_id,input)=>validate(ctx,input),
    dependencies:async ctx=>{const p=await policy(ctx);return {definition:p?definition.strip().parse(p):null,version:p?.version??0};},apply}
};
const errors:Record<string,[number,string]>={STORAGE_POLICY_NOT_CONFIGURED:[503,'STORAGE_POLICY_NOT_CONFIGURED'],UPLOADS_DISABLED:[409,'UPLOADS_DISABLED'],FILE_NOT_FOUND:[404,'NOT_FOUND'],FILE_ARCHIVED:[409,'FILE_ARCHIVED'],INVALID_RESERVATION_ACTOR:[403,'FORBIDDEN'],FILE_EXCEEDS_STORAGE_LIMIT:[409,'FILE_EXCEEDS_STORAGE_LIMIT'],UPLOAD_RESERVATION_CLOSED:[409,'UPLOAD_RESERVATION_CLOSED'],FILE_CLAIMS_CHANGED:[409,'FILE_CLAIMS_CHANGED'],STORAGE_QUOTA_EXCEEDED:[409,'STORAGE_QUOTA_EXCEEDED'],TARGET_CHANGED:[409,'TARGET_CHANGED'],STORAGE_TARGET_CHANGED:[409,'STORAGE_TARGET_CHANGED'],INVALID_STORAGE_TARGET:[503,'R2_NOT_CONFIGURED'],UPLOAD_GRANT_NOT_FOUND:[404,'UPLOAD_GRANT_NOT_FOUND'],UPLOAD_CLOSED_FOR_INSPECTION:[409,'UPLOAD_CLOSED_FOR_INSPECTION']};
function storageFailure(error:unknown):never {
  if(error&&typeof error==='object'&&'code' in error&&error.code==='P0001'&&'message' in error&&error.message==='FILE_TYPE_NOT_ALLOWED')throw new ApiError(409,'FILE_TYPE_NOT_ALLOWED');
  if(error&&typeof error==='object'&&'code' in error&&error.code==='P0001'&&'message' in error&&Object.hasOwn(errors,String(error.message))){const [status,code]=errors[String(error.message)];throw new ApiError(status,code);}throw error;
}
async function lockUploadFile(ctx:ApiContext,id:string,expectedVersion:number,allowDisabled=false) {
  await lockAcademyTopology(ctx);const p=await policy(ctx,true);
  if(!p)throw new ApiError(503,'STORAGE_POLICY_NOT_CONFIGURED');if(!allowDisabled&&!p.uploadsEnabled)throw new ApiError(409,'UPLOADS_DISABLED');
  const f=await permittedFile(ctx,id,true,true,'files.upload');
  if(f.version!==expectedVersion)throw new ApiError(409,'TARGET_CHANGED');if(f.archived)throw new ApiError(409,'FILE_ARCHIVED');
  if(!allowDisabled&&!p.allowedMimeTypes.includes(f.claimed_mime_type))throw new ApiError(409,'FILE_TYPE_NOT_ALLOWED');return {p,f};
}
const inspectionFields='id,file_id AS "fileId",grant_id AS "grantId",metadata_version AS "metadataVersionAtRequest",requested_by AS "requestedBy",requested_at AS "requestedAt"';
function inspectionReply(data:Record<string,unknown>) {return {...data,stage:'inspection_requested',uploadVerified:false,physicalStorageVerified:false,safeToServe:false};}
async function grantHistory(ctx:ApiContext,id:string):Promise<Reply> {
  if(ctx.request.method!=='GET')throw new ApiError(405,'METHOD_NOT_ALLOWED');
  await permittedFile(ctx,id,true,false,'files.upload');const q=grantHistoryQuery.parse(Object.fromEntries(new URL(ctx.request.url).searchParams));
  const rows=(await ctx.db.query<{id:string;issuedAt:Date|string}>(`SELECT id,file_id AS "fileId",metadata_version AS "metadataVersion",created_by AS "createdBy",issued_at AS "issuedAt",expires_at AS "expiresAt",format_policy_version AS "formatPolicyVersion",format_policy_snapshot AS "formatPolicy",(format_policy_version IS NOT NULL) AS "formatPolicyRecorded"
    FROM public.file_upload_grants WHERE file_id=$1 AND ($2::timestamptz IS NULL OR (issued_at,id)>($2::timestamptz,$3::uuid)) ORDER BY issued_at,id LIMIT $4`,[id,q.afterIssuedAt??null,q.afterId??null,q.limit+1])).rows;
  const tail=rows[q.limit-1];return {status:200,body:{data:rows.slice(0,q.limit),nextCursor:rows.length>q.limit?{issuedAt:new Date(tail.issuedAt).toISOString(),id:tail.id}:null}};
}
async function inspection(ctx:ApiContext,id:string):Promise<Reply> {
  if(ctx.request.method==='GET') {
    await permittedFile(ctx,id);const row=(await ctx.db.query('SELECT '+inspectionFields+' FROM public.file_inspection_requests WHERE file_id=$1',[id])).rows[0];
    if(!row)throw new ApiError(404,'FILE_INSPECTION_NOT_REQUESTED');
    const processing=(await ctx.db.query('SELECT state,attempt_no AS "attemptCount",last_outcome AS "lastOutcome",last_reason AS "lastReason",CASE WHEN state=\'queued\' THEN available_at ELSE NULL END AS "nextAttemptAt" FROM public.file_inspection_jobs WHERE inspection_id=$1',[row.id])).rows[0]??null;
    const attempts=(await ctx.db.query(`SELECT a.attempt_no AS "attempt",a.worker_id AS "workerId",a.started_at AS "startedAt",a.finished_at AS "finishedAt",a.outcome,a.reason_code AS "reason",a.measured_bytes::float8 AS "measuredBytes",a.sha256,a.provider_content_type AS "providerContentType",
      CASE WHEN s.inspection_id IS NULL THEN NULL ELSE jsonb_build_object('detector',s.detector,'sampleBytes',s.sample_bytes,'sampleSha256',s.sample_sha256,'mime',s.mime,'extension',s.extension) END AS "contentSignature"
      FROM public.file_inspection_attempts a LEFT JOIN public.file_content_signatures s ON s.academy_id=a.academy_id AND s.inspection_id=a.inspection_id AND s.attempt_no=a.attempt_no WHERE a.inspection_id=$1 ORDER BY a.attempt_no LIMIT 5`,[row.id])).rows;
    return {status:200,body:{data:inspectionReply({...row,processing,attempts})}};
  }
  if(ctx.request.method!=='POST')throw new ApiError(405,'METHOD_NOT_ALLOWED');const input=inspectionInput.parse(await jsonBody(ctx.request));
  await permittedFile(ctx,id,true,false,'files.upload');
  if(!(await ctx.db.query('SELECT 1 FROM public.file_upload_grants WHERE file_id=$1 AND id=$2',[id,input.grantId])).rows.length)throw new ApiError(404,'UPLOAD_GRANT_NOT_FOUND');
  const {f}=await lockUploadFile(ctx,id,input.expectedMetadataVersion,true);
  return mutation(ctx,input,async()=>{
    let row:Record<string,unknown>;try{row=(await ctx.db.query('SELECT '+inspectionFields+',newly_requested AS "newlyRequested" FROM public.request_file_inspection($1,$2,$3,$4)',[id,input.grantId,ctx.credential.person_id,input.expectedMetadataVersion])).rows[0];}catch(error){storageFailure(error);}
    if(row.newlyRequested)await record(ctx.db,ctx.credential,ctx.requestId,'file.inspection.requested',id,f.effective_hub_id,{inspectionId:row.id,metadataVersionAtRequest:row.metadataVersionAtRequest});
    return {status:row.newlyRequested?202:200,body:{data:inspectionReply(row)}};
  });
}
async function uploadLink(ctx:ApiContext,id:string,input:z.infer<typeof reservationInput>,connections?:R2UploadConnections):Promise<Reply> {
  await permittedFile(ctx,id,true,false,'files.upload');const config=connections?.(ctx.credential.academy_id);
  if(!config)throw new ApiError(503,'R2_NOT_CONFIGURED');const {privateR2}=await import('../integrations/r2.ts'),service=privateR2(config,ctx.credential.academy_id);
  try {
    // Policy -> file, including idempotent replays, matches the native helper.
    // Hold both until commit so archival/disable cannot race a new bearer grant.
    const {p,f}=await lockUploadFile(ctx,id,input.expectedMetadataVersion);
    if((await ctx.db.query('SELECT 1 FROM public.file_inspection_requests WHERE file_id=$1',[id])).rows.length)throw new ApiError(409,'UPLOAD_CLOSED_FOR_INSPECTION');
    if(f.expected_bytes>Math.min(p.maximumFileBytes,service.maximumUploadBytes))throw new ApiError(409,'FILE_EXCEEDS_STORAGE_LIMIT');
    const reply=await mutation(ctx,input,async()=>{
      let row:{id:string;fileId:string;metadataVersion:number;storageTargetId:string;issuedAt:Date|string;expiresAt:Date|string;formatPolicyVersion:number};
      try {row=(await ctx.db.query<typeof row>('SELECT id,file_id AS "fileId",metadata_version AS "metadataVersion",storage_target_id AS "storageTargetId",issued_at AS "issuedAt",expires_at AS "expiresAt",format_policy_version AS "formatPolicyVersion" FROM public.issue_file_upload_grant($1,$2,$3,$4)',[id,ctx.credential.person_id,input.expectedMetadataVersion,service.storageTargetId])).rows[0];}
      catch(error){storageFailure(error);}
      const data={...row,issuedAt:new Date(row.issuedAt).toISOString(),expiresAt:new Date(row.expiresAt).toISOString()};
      await record(ctx.db,ctx.credential,ctx.requestId,'file.upload.link.issued',id,f.effective_hub_id,{grantId:data.id,metadataVersion:data.metadataVersion,expiresAt:data.expiresAt,formatPolicyVersion:data.formatPolicyVersion});
      // Only non-secret grant intent is cached; never a URL or provider key.
      return {status:201,body:{data}};
    });
    const saved=grantReceipt.safeParse((reply.body as {data:unknown}).data);if(!saved.success)throw new ApiError(503,'FILE_GRANT_UNAVAILABLE');
    const {storageTargetId,...data}=saved.data;
    if(data.fileId!==id||data.metadataVersion!==f.version)throw new ApiError(409,'TARGET_CHANGED');
    if(storageTargetId!==service.storageTargetId)throw new ApiError(409,'STORAGE_TARGET_CHANGED');
    const upload=await service.quarantineUpload(id,{bytes:f.expected_bytes,contentType:f.claimed_mime_type},300,data.issuedAt);
    if(upload.expiresAt!==data.expiresAt)throw new ApiError(503,'FILE_GRANT_UNAVAILABLE');
    return {status:reply.status,body:{data:{...data,formatPolicyRecorded:data.formatPolicyVersion!==null,stage:'awaiting_upload',uploadVerified:false,physicalStorageVerified:false,upload}}};
  }finally{service.close();}
}
export async function storage(ctx:ApiContext,registry:ApprovalRegistry=storageActions,connections?:R2UploadConnections):Promise<Reply|null> {
  const isPolicy=ctx.path==='storage-policy',isHistory=ctx.path==='storage-policy/history',reservation=/^files\/([^/]+)\/(upload-reservation|upload-limits|upload-link|upload-grants|inspection)$/.exec(ctx.path);
  if(!isPolicy&&!isHistory&&!reservation)return null;
  if(isPolicy||isHistory) {
    authority(ctx,ctx.request.method==='POST');
    if(isPolicy&&ctx.request.method==='POST') {
      z.object({}).strict().parse(Object.fromEntries(new URL(ctx.request.url).searchParams));const input=policyInput.parse(await jsonBody(ctx.request));
      return propose(ctx,registry,'storage.policy.set',ctx.credential.academy_id,input.expectedVersion,input);
    }
    if(ctx.request.method!=='GET')throw new ApiError(405,'METHOD_NOT_ALLOWED');
    if(isHistory){const q=historyQuery.parse(Object.fromEntries(new URL(ctx.request.url).searchParams));const rows=(await ctx.db.query<{version:number}>('SELECT version,definition,changed_by,approval_id,reason,created_at FROM public.file_storage_policy_revisions WHERE version>$1 ORDER BY version LIMIT $2',[q.afterVersion,q.limit+1])).rows;return {status:200,body:{data:rows.slice(0,q.limit),nextVersion:rows.length>q.limit?rows[q.limit-1].version:null}};}
    z.object({}).strict().parse(Object.fromEntries(new URL(ctx.request.url).searchParams));const p=await policy(ctx);return {status:200,body:{configured:Boolean(p),data:p?{...p,usageBasis:'reserved_claims',physicalStorageVerified:false}:null}};
  }
  const id=uuid.parse(reservation![1]);if(reservation![2]==='upload-grants')return grantHistory(ctx,id);
  z.object({}).strict().parse(Object.fromEntries(new URL(ctx.request.url).searchParams));
  if(reservation![2]==='inspection')return inspection(ctx,id);
  if(reservation![2]==='upload-link') {
    if(ctx.request.method!=='POST')throw new ApiError(405,'METHOD_NOT_ALLOWED');return uploadLink(ctx,id,reservationInput.parse(await jsonBody(ctx.request)),connections);
  }
  if(reservation![2]==='upload-limits') {
    if(ctx.request.method!=='GET')throw new ApiError(405,'METHOD_NOT_ALLOWED');await permittedFile(ctx,id,true,false,'files.upload');const p=await policy(ctx);
    const config=connections?.(ctx.credential.academy_id),parsed=config?r2Connection.safeParse(config):null;
    if(parsed&&!parsed.success)throw new ApiError(503,'R2_NOT_CONFIGURED');
    const uploadClosed=(await ctx.db.query('SELECT 1 FROM public.file_inspection_requests WHERE file_id=$1',[id])).rows.length>0;
    return {status:200,body:{configured:Boolean(p),serviceConfigured:Boolean(parsed?.success),uploadClosed,data:p?{uploadsEnabled:p.uploadsEnabled,maximumFileBytes:p.maximumFileBytes,allowedMimeTypes:p.allowedMimeTypes,effectiveMaximumFileBytes:parsed?.success?Math.min(p.maximumFileBytes,parsed.data.maximumUploadBytes):null}:null}};
  }
  if(ctx.request.method==='GET') {
    await permittedFile(ctx,id);const row=(await ctx.db.query('SELECT file_id AS "fileId",reserved_bytes::float8 AS "reservedBytes",policy_version AS "policyVersion",created_at AS "reservedAt",released_at AS "releasedAt" FROM public.file_upload_reservations WHERE file_id=$1',[id])).rows[0];
    if(!row)throw new ApiError(404,'UPLOAD_RESERVATION_NOT_FOUND');return {status:200,body:{data:{...row,stage:row.releasedAt?'closed':'capacity_reserved',uploadVerified:false,physicalStorageVerified:false}}};
  }
  if(ctx.request.method!=='POST')throw new ApiError(405,'METHOD_NOT_ALLOWED');const input=reservationInput.parse(await jsonBody(ctx.request));
  await permittedFile(ctx,id,true,false,'files.upload');await lockUploadFile(ctx,id,input.expectedMetadataVersion);
  return mutation(ctx,input,async()=>{
    const f=await permittedFile(ctx,id,true,false,'files.upload');if(f.version!==input.expectedMetadataVersion)throw new ApiError(409,'TARGET_CHANGED');if(f.archived)throw new ApiError(409,'FILE_ARCHIVED');
    let row:Record<string,unknown>;
    try {row=(await ctx.db.query('SELECT file_id AS "fileId",reserved_bytes::float8 AS "reservedBytes",policy_version AS "policyVersion",created_at AS "reservedAt",newly_reserved AS "newlyReserved" FROM public.reserve_file_upload($1,$2,$3)',[id,ctx.credential.person_id,input.expectedMetadataVersion])).rows[0];}
    catch(error){storageFailure(error);}
    await record(ctx.db,ctx.credential,ctx.requestId,'file.upload.reserved',id,f.effective_hub_id,{metadataVersion:f.version,newlyReserved:row.newlyReserved});
    return {status:row.newlyReserved?201:200,body:{data:{...row,stage:'capacity_reserved',uploadVerified:false,physicalStorageVerified:false}}};
  });
}
export const storageContract=[
  {path:'/api/v1/storage-policy',method:'get',summary:'School upload limits and reserved-claim budget; not measured cloud storage'},
  {path:'/api/v1/storage-policy',method:'post',summary:'Request school-wide upload limits and exact claimed-MIME allowlist changes; empty list blocks new issuance, initial version zero defaults uploads disabled, not content validation',schema:policyInput},
  {path:'/api/v1/storage-policy/history',method:'get',summary:'Private immutable upload policy revisions',querySchema:historyQuery},
  {path:'/api/v1/files/{id}/upload-reservation',method:'get',summary:'Read authorized capacity reservation; no signed link or physical upload proof'},
  {path:'/api/v1/files/{id}/upload-reservation',method:'post',summary:'Atomically reserve capacity under current file/domain/upload permissions and school policy; does not transfer bytes',schema:reservationInput},
  {path:'/api/v1/files/{id}/upload-link',method:'post',summary:'Issue a five-minute conditional quarantine PUT with immutable format-policy provenance; replays retain original policy version/expiry but recheck current access/settings, legacy receipts stay explicitly unknown',schema:reservationInput},
  {path:'/api/v1/files/{id}/upload-grants',method:'get',summary:'Uploader/editor-scoped grant history with exact original allowed-format snapshots; no URLs, storage keys, school budgets or content-safety clearance',querySchema:grantHistoryQuery},
  {path:'/api/v1/files/{id}/inspection',method:'get',summary:'Read authorized request, worker progress and immutable attempts including bounded content-signature hints; not format validity, uploaded or safe content clearance'},
  {path:'/api/v1/files/{id}/inspection',method:'post',summary:'Request inspection for an existing upload grant and close new link issuance atomically; no browser claim establishes file safety',schema:inspectionInput,acceptedDescription:'Inspection request recorded; content is not verified or available'},
  {path:'/api/v1/files/{id}/upload-limits',method:'get',summary:'Uploader-safe enabled/per-file limits and declared-format choices for an authorized file, without school totals or other files'}
] as const;
