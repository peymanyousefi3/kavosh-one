import { z } from 'zod';
import { jsonBody,mutation,record,type ApiContext,type Reply } from '../core/api.ts';
import { propose,permissionScope,type ApprovalRegistry,type Proposal } from '../core/approvals.ts';
import { ApiError,requireScope } from '../core/policy.ts';
import { lockAcademyTopology } from './academy.ts';
import { permittedFile } from './files.ts';

const uuid=z.string().uuid().transform(v=>v.toLowerCase()),version=z.number().int().positive().max(2_147_483_647);
const reason=z.string().trim().min(1).max(2000).refine(v=>v.isWellFormed()&&!v.includes('\0'));
const fields={uploadsEnabled:z.boolean(),maximumFileBytes:z.number().int().min(1).max(4_294_967_296),maximumReservedBytes:z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),maximumFiles:z.number().int().min(1).max(1_000_000_000)};
const definition=z.object(fields).strict().refine(v=>v.maximumFileBytes<=v.maximumReservedBytes,'The total reservation budget must fit at least one maximum-size file.');
const createInput=z.object({...fields,uploadsEnabled:fields.uploadsEnabled.default(false),maximumFileBytes:fields.maximumFileBytes.default(67_108_864),maximumReservedBytes:fields.maximumReservedBytes.default(268_435_456),maximumFiles:fields.maximumFiles.default(10),expectedVersion:z.literal(0),reason}).strict();
const updateInput=z.object(fields).partial().extend({expectedVersion:version,reason}).strict().refine(v=>Object.keys(v).some(k=>k!=='expectedVersion'&&k!=='reason'));
const policyInput=z.union([createInput,updateInput]);
const reservationInput=z.object({expectedMetadataVersion:version}).strict();
const historyQuery=z.object({limit:z.coerce.number().int().min(1).max(100).default(50),afterVersion:z.coerce.number().int().min(0).max(2_147_483_647).default(0)}).strict();
interface Policy {academyId:string;uploadsEnabled:boolean;maximumFileBytes:number;maximumReservedBytes:number;maximumFiles:number;reservedBytes:number;reservedFiles:number;version:number}
const policyFields=`academy_id AS "academyId",uploads_enabled AS "uploadsEnabled",maximum_file_bytes::float8 AS "maximumFileBytes",maximum_reserved_bytes::float8 AS "maximumReservedBytes",
 maximum_files AS "maximumFiles",reserved_bytes::float8 AS "reservedBytes",reserved_files AS "reservedFiles",version`;
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
  if(before)await ctx.db.query('UPDATE public.file_storage_policies SET uploads_enabled=$2,maximum_file_bytes=$3,maximum_reserved_bytes=$4,maximum_files=$5,version=version+1,last_approval_id=$6 WHERE academy_id=$1',[ctx.credential.academy_id,body.uploadsEnabled,body.maximumFileBytes,body.maximumReservedBytes,body.maximumFiles,p.id]);
  else await ctx.db.query('INSERT INTO public.file_storage_policies(academy_id,uploads_enabled,maximum_file_bytes,maximum_reserved_bytes,maximum_files,last_approval_id) VALUES($1,$2,$3,$4,$5,$6)',[ctx.credential.academy_id,body.uploadsEnabled,body.maximumFileBytes,body.maximumReservedBytes,body.maximumFiles,p.id]);
  const after=(await policy(ctx))!;
  await ctx.db.query('INSERT INTO public.file_storage_policy_revisions(academy_id,version,definition,changed_by,approval_id,reason) VALUES($1,$2,$3::jsonb,$4,$5,$6)',[ctx.credential.academy_id,after.version,JSON.stringify(body),ctx.credential.person_id,p.id,why]);
  await record(ctx.db,ctx.credential,ctx.requestId,'file.storage.policy.updated',ctx.credential.academy_id,null,{beforeVersion:before?.version??null,afterVersion:after.version,fields:Object.keys(patch),severity:'critical',hasReason:true});
  return {...after,usageBasis:'reserved_claims',physicalStorageVerified:false};
}
export const storageActions:ApprovalRegistry={
  'storage.policy.set':{requestCapability:'storage.edit',privacyCapability:'storage.view',policyChange:true,validate:(ctx,_id,input)=>validate(ctx,input),
    dependencies:async ctx=>{const p=await policy(ctx);return {definition:p?definition.strip().parse(p):null,version:p?.version??0};},apply}
};
const errors:Record<string,[number,string]>={STORAGE_POLICY_NOT_CONFIGURED:[503,'STORAGE_POLICY_NOT_CONFIGURED'],UPLOADS_DISABLED:[409,'UPLOADS_DISABLED'],FILE_NOT_FOUND:[404,'NOT_FOUND'],FILE_ARCHIVED:[409,'FILE_ARCHIVED'],INVALID_RESERVATION_ACTOR:[403,'FORBIDDEN'],FILE_EXCEEDS_STORAGE_LIMIT:[409,'FILE_EXCEEDS_STORAGE_LIMIT'],UPLOAD_RESERVATION_CLOSED:[409,'UPLOAD_RESERVATION_CLOSED'],FILE_CLAIMS_CHANGED:[409,'FILE_CLAIMS_CHANGED'],STORAGE_QUOTA_EXCEEDED:[409,'STORAGE_QUOTA_EXCEEDED'],TARGET_CHANGED:[409,'TARGET_CHANGED']};
export async function storage(ctx:ApiContext,registry:ApprovalRegistry=storageActions):Promise<Reply|null> {
  const isPolicy=ctx.path==='storage-policy',isHistory=ctx.path==='storage-policy/history',reservation=/^files\/([^/]+)\/(upload-reservation|upload-limits)$/.exec(ctx.path);
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
  const id=uuid.parse(reservation![1]);z.object({}).strict().parse(Object.fromEntries(new URL(ctx.request.url).searchParams));
  if(reservation![2]==='upload-limits') {
    if(ctx.request.method!=='GET')throw new ApiError(405,'METHOD_NOT_ALLOWED');await permittedFile(ctx,id,true,false,'files.upload');const p=await policy(ctx);
    return {status:200,body:{configured:Boolean(p),data:p?{uploadsEnabled:p.uploadsEnabled,maximumFileBytes:p.maximumFileBytes}:null}};
  }
  if(ctx.request.method==='GET') {
    await permittedFile(ctx,id);const row=(await ctx.db.query('SELECT file_id AS "fileId",reserved_bytes::float8 AS "reservedBytes",policy_version AS "policyVersion",created_at AS "reservedAt",released_at AS "releasedAt" FROM public.file_upload_reservations WHERE file_id=$1',[id])).rows[0];
    if(!row)throw new ApiError(404,'UPLOAD_RESERVATION_NOT_FOUND');return {status:200,body:{data:{...row,stage:row.releasedAt?'closed':'capacity_reserved',uploadVerified:false,physicalStorageVerified:false}}};
  }
  if(ctx.request.method!=='POST')throw new ApiError(405,'METHOD_NOT_ALLOWED');const input=reservationInput.parse(await jsonBody(ctx.request));
  await permittedFile(ctx,id,true,false,'files.upload');await lockAcademyTopology(ctx);
  return mutation(ctx,input,async()=>{
    const f=await permittedFile(ctx,id,true,false,'files.upload');if(f.version!==input.expectedMetadataVersion)throw new ApiError(409,'TARGET_CHANGED');if(f.archived)throw new ApiError(409,'FILE_ARCHIVED');
    let row:Record<string,unknown>;
    try {row=(await ctx.db.query('SELECT file_id AS "fileId",reserved_bytes::float8 AS "reservedBytes",policy_version AS "policyVersion",created_at AS "reservedAt",newly_reserved AS "newlyReserved" FROM public.reserve_file_upload($1,$2,$3)',[id,ctx.credential.person_id,input.expectedMetadataVersion])).rows[0];}
    catch(error){if(error&&typeof error==='object'&&'code' in error&&error.code==='P0001'&&'message' in error&&Object.hasOwn(errors,String(error.message))){const [status,code]=errors[String(error.message)];throw new ApiError(status,code);}throw error;}
    await record(ctx.db,ctx.credential,ctx.requestId,'file.upload.reserved',id,f.effective_hub_id,{metadataVersion:f.version,newlyReserved:row.newlyReserved});
    return {status:row.newlyReserved?201:200,body:{data:{...row,stage:'capacity_reserved',uploadVerified:false,physicalStorageVerified:false}}};
  });
}
export const storageContract=[
  {path:'/api/v1/storage-policy',method:'get',summary:'School upload limits and reserved-claim budget; not measured cloud storage'},
  {path:'/api/v1/storage-policy',method:'post',summary:'Request school-wide upload policy changes; initial version zero defaults to uploads disabled',schema:policyInput},
  {path:'/api/v1/storage-policy/history',method:'get',summary:'Private immutable upload policy revisions',querySchema:historyQuery},
  {path:'/api/v1/files/{id}/upload-reservation',method:'get',summary:'Read authorized capacity reservation; no signed link or physical upload proof'},
  {path:'/api/v1/files/{id}/upload-reservation',method:'post',summary:'Atomically reserve capacity under current file/domain/upload permissions and school policy; does not transfer bytes',schema:reservationInput},
  {path:'/api/v1/files/{id}/upload-limits',method:'get',summary:'Uploader-safe enabled/per-file limits for an authorized file, without school totals or other files'}
] as const;
