import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { jsonBody,mutation,record,type ApiContext,type Reply } from '../core/api.ts';
import { lockApprovalWrites } from '../core/approvals.ts';
import { ApiError } from '../core/policy.ts';
import { lockAcademyTopology } from './academy.ts';
import { permittedFile } from './files.ts';

const uuid=z.string().uuid().transform(v=>v.toLowerCase()),version=z.number().int().positive().max(2147483647),attempt=z.number().int().min(1).max(5),empty=z.object({}).strict();
const input=z.object({fileVersion:version,inspectionId:uuid,attemptNo:attempt,routeId:uuid,routeVersion:version}).strict();
const paging=z.object({limit:z.coerce.number().int().min(1).max(100).default(25),after:uuid.optional()}).strict();
const selection=z.object({fileVersion:z.coerce.number().int().positive().max(2147483647),inspectionId:uuid,attemptNo:z.coerce.number().int().min(1).max(5),...paging.shape}).strict();
const columns='id,file_id AS "fileId",file_version AS "fileVersion",inspection_id AS "inspectionId",inspection_attempt AS "attemptNo",route_id AS "routeId",route_version AS "routeVersion",source_fingerprint AS "sourceFingerprint",requested_by AS "requestedBy",requested_at::text AS "requestedAt",public.file_copy_source(file_id,file_version,inspection_id,inspection_attempt,route_id,route_version) IS NOT DISTINCT FROM source AS "recordedSourcesCurrent",coalesce((SELECT j.state FROM public.file_copy_jobs j WHERE j.academy_id=file_copy_requests.academy_id AND j.copy_id=file_copy_requests.id),\'queued\') AS state,EXISTS(SELECT 1 FROM public.file_copy_attempts a WHERE a.academy_id=file_copy_requests.academy_id AND a.copy_id=file_copy_requests.id AND a.outcome IN(\'written_verified\',\'existing_verified\')) AS "physicalCopyVerified"';
function output(r:Record<string,unknown>){return {...r,downloadAuthorized:false,signatureReady:false};}
async function source(ctx:ApiContext,id:string,i:z.infer<typeof input>){return(await ctx.db.query<{source:Record<string,unknown>|null}>('SELECT public.file_copy_source($1,$2,$3,$4,$5,$6) source',[id,i.fileVersion,i.inspectionId,i.attemptNo,i.routeId,i.routeVersion])).rows[0].source;}
export async function fileCopies(ctx:ApiContext):Promise<Reply|null>{
 const m=/^files\/([^/]+)\/(copies|copy-destinations)$/.exec(ctx.path);if(!m)return null;const id=uuid.parse(m[1]),section=m[2],params=new URL(ctx.request.url).searchParams;
 if([...params].length!==new Set(params.keys()).size)throw new ApiError(400,'DUPLICATE_QUERY');
 if(ctx.request.method==='POST'){
  if(section!=='copies')throw new ApiError(405,'METHOD_NOT_ALLOWED');
  empty.parse(Object.fromEntries(params));const i=input.parse(await jsonBody(ctx.request));await permittedFile(ctx,id,true,false,'files.upload');
  await lockApprovalWrites(ctx);await lockAcademyTopology(ctx);const f=await permittedFile(ctx,id,true,true,'files.upload');
  if(f.version!==i.fileVersion)throw new ApiError(409,'TARGET_CHANGED');if(f.archived)throw new ApiError(409,'FILE_ARCHIVED');
  await ctx.db.query('SELECT id FROM public.file_storage_routes WHERE id=$1 FOR SHARE',[i.routeId]);
  const actual=await source(ctx,id,i);if(!actual)throw new ApiError(409,'FILE_COPY_NOT_READY');
  return mutation(ctx,i,async()=>{
   const existing=(await ctx.db.query('SELECT '+columns+' FROM public.file_copy_requests WHERE file_id=$1 AND source_fingerprint=encode(sha256(convert_to($2::jsonb::text,\'UTF8\')),\'hex\')',[id,JSON.stringify(actual)])).rows[0];
   if(existing)return {status:200,body:{data:output(existing)}};
   const requestId=randomUUID();await record(ctx.db,ctx.credential,ctx.requestId,'file.copy.requested',requestId,f.effective_hub_id,{fileId:id,fileVersion:i.fileVersion,routeId:i.routeId,routeVersion:i.routeVersion,externalRequestMade:false});
   let saved:Record<string,unknown>;try{saved=(await ctx.db.query('INSERT INTO public.file_copy_requests(academy_id,id,file_id,file_version,inspection_id,inspection_attempt,route_id,route_version,source,requested_by,audit_id) SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,a.id FROM public.audit_events a WHERE a.academy_id=$1 AND a.entity_id=$2 AND a.request_id=$11 AND a.action=\'file.copy.requested\' AND a.created_at=transaction_timestamp() RETURNING '+columns,[ctx.credential.academy_id,requestId,id,i.fileVersion,i.inspectionId,i.attemptNo,i.routeId,i.routeVersion,JSON.stringify(actual),ctx.credential.person_id,ctx.requestId])).rows[0];}
   catch(error){if(error&&typeof error==='object'&&'code' in error&&error.code==='23514'&&'message' in error&&error.message==='FILE_COPY_SOURCE_CHANGED')throw new ApiError(409,'FILE_COPY_SOURCE_CHANGED');throw error;}
   if(!saved)throw new ApiError(503,'FILE_COPY_AUDIT_MISSING');return {status:202,body:{data:output(saved)}};
  });
 }
 if(ctx.request.method!=='GET')throw new ApiError(405,'METHOD_NOT_ALLOWED');await lockApprovalWrites(ctx);await lockAcademyTopology(ctx);
 if(section==='copy-destinations'){
  const q=selection.parse(Object.fromEntries(params));await permittedFile(ctx,id,true,false,'files.upload');
  const rows=(await ctx.db.query<{routeId:string}>('SELECT h.id AS "routeId",h.version AS "routeVersion",r.definition->>\'name\' AS name,r.definition->\'translations\' AS translations,(r.definition->>\'maximumBytes\')::integer AS "maximumBytes" FROM public.file_storage_routes h JOIN public.file_storage_route_revisions r ON r.academy_id=h.academy_id AND r.route_id=h.id AND r.version=h.version WHERE ($5::uuid IS NULL OR h.id>$5) AND public.file_copy_source($1,$2,$3,$4,h.id,h.version) IS NOT NULL ORDER BY h.id LIMIT $6',[id,q.fileVersion,q.inspectionId,q.attemptNo,q.after??null,q.limit+1])).rows;
  return {status:200,body:{data:rows.slice(0,q.limit),nextCursor:rows.length>q.limit?rows[q.limit-1].routeId:null,defaultRouteId:!q.after&&rows.length===1?rows[0].routeId:null,physicalCopyVerified:false,downloadAuthorized:false}};
 }
 const q=paging.parse(Object.fromEntries(params));await permittedFile(ctx,id);
 const rows=(await ctx.db.query<{id:string}>('SELECT '+columns+' FROM public.file_copy_requests WHERE file_id=$1 AND ($2::uuid IS NULL OR id>$2) ORDER BY id LIMIT $3',[id,q.after??null,q.limit+1])).rows;
 return {status:200,body:{data:rows.slice(0,q.limit).map(output),nextCursor:rows.length>q.limit?rows[q.limit-1].id:null}};
}
export const fileCopiesContract=[
 {path:'/api/v1/files/{id}/copy-destinations',method:'get',summary:'Current upload/domain-permitted compatible destination labels only,not school-wide settings or credentials;default only when exactly one eligible destination exists',querySchema:selection},
 {path:'/api/v1/files/{id}/copies',method:'post',summary:'Request one deduplicated exact-file byte copy under an already reviewed enabled destination and current upload/domain rights;no additional per-file approval;durable background job,not immediate physical transfer or download clearance',schema:input,acceptedDescription:'Durable job queued;no immediate physical transfer or download authority is established'},
 {path:'/api/v1/files/{id}/copies',method:'get',summary:'Current-file/domain-permitted copy history with actual job state and recorded physical receipts,never serving authority',querySchema:paging}
] as const;
