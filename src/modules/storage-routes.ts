import { z } from 'zod';
import { jsonBody,record,type ApiContext,type Reply } from '../core/api.ts';
import { propose,permissionScope,lockApprovalWrites,type ApprovalRegistry,type Proposal } from '../core/approvals.ts';
import { ApiError,requireScope } from '../core/policy.ts';

const uuid=z.string().uuid().transform(v=>v.toLowerCase()),version=z.number().int().positive().max(2147483647),text=z.string().refine(v=>v.isWellFormed()&&!v.includes('\0')),
 name=text.trim().min(1).max(200),reason=text.trim().min(1).max(2000),hash=z.string().regex(/^[a-f0-9]{64}$/);
const serving=z.object({signedEvidence:z.boolean().optional(),enabled:z.boolean().default(false),allowedMimeTypes:z.array(z.enum(['image/jpeg','image/png','image/webp','image/gif','image/avif','application/pdf'])).max(6).refine(v=>new Set(v).size===v.length).default(['image/jpeg','image/png','image/webp','image/gif','image/avif','application/pdf']),maximumLinkSeconds:z.number().int().min(1).max(60).default(60)}).strict();
// Optional preserves existing exact approvals;absence ALWAYS means disabled.
const definition=z.object({name,translations:z.object({en:name.optional(),fr:name.optional(),'zh-CN':name.optional()}).strict().default({}),enabled:z.boolean().default(false),sourceTargetId:hash,destinationTargetId:hash,maximumBytes:z.number().int().min(1).max(33554432).default(33554432),serving:serving.optional()}).strict().refine(v=>v.sourceTargetId!==v.destinationTargetId);
const create=z.object({definition,reason}).strict(),change=z.object({expectedVersion:version,definition,reason}).strict(),empty=z.object({}).strict();
const paging=z.object({limit:z.coerce.number().int().min(1).max(100).default(25),after:uuid.optional(),enabled:z.enum(['true','false']).optional(),q:text.trim().min(1).max(100).optional()}).strict();
const history=z.object({limit:z.coerce.number().int().min(1).max(100).default(25),afterVersion:z.coerce.number().int().min(0).max(2147483647).default(0)}).strict();
type Row={id:string;version:number;definition:z.infer<typeof definition>;createdAt:string};
const columns='h.id,h.version,r.definition,h.created_at::text AS "createdAt"';
const from='public.file_storage_routes h JOIN public.file_storage_route_revisions r ON r.academy_id=h.academy_id AND r.route_id=h.id AND r.version=h.version';
function authority(ctx:ApiContext,edit=false){requireScope(permissionScope(ctx,'storage.view'));if(edit)requireScope(permissionScope(ctx,'storage.edit'));}
async function row(ctx:ApiContext,id:string,edit=false,lock=false):Promise<Row>{
 authority(ctx,edit);if(lock)await ctx.db.query('SELECT id FROM public.file_storage_routes WHERE id=$1 FOR UPDATE',[id]);
 const r=(await ctx.db.query<Row>('SELECT '+columns+' FROM '+from+' WHERE h.id=$1',[id])).rows[0];if(!r)throw new ApiError(404,'NOT_FOUND');return r;
}
function output(r:Row){return {...r,configurationOnly:true,credentialsStored:false,physicalStorageVerified:false,transfersEnabled:false,downloadAuthorized:false};}
async function validate(ctx:ApiContext,creating:boolean,id:string,raw:unknown){authority(ctx,true);if(creating)create.parse(raw);else{const i=change.parse(raw),r=await row(ctx,id,true,true);if(r.version!==i.expectedVersion)throw new ApiError(409,'TARGET_CHANGED');}return {all:true,hubs:[]};}
async function basis(ctx:ApiContext,id:string,before:number){return(await ctx.db.query<{source:Record<string,unknown>}>('SELECT public.file_storage_route_basis($1,$2) source',[id,before])).rows[0].source;}
async function apply(ctx:ApiContext,p:Proposal){
 if(ctx.credential.kind!=='human')throw new ApiError(403,'HUMAN_REVIEW_REQUIRED');const creating=p.action==='storage.route.create',i=creating?create.parse(p.payload):change.parse(p.payload);await validate(ctx,creating,p.target_id,i);const before=creating?0:change.parse(i).expectedVersion,source=await basis(ctx,p.target_id,before);
 if(creating)await ctx.db.query('INSERT INTO public.file_storage_routes(academy_id,id) VALUES($1,$2)',[ctx.credential.academy_id,p.target_id]);else await ctx.db.query('UPDATE public.file_storage_routes SET version=$2 WHERE id=$1',[p.target_id,before+1]);
 await ctx.db.query('INSERT INTO public.file_storage_route_revisions(academy_id,route_id,version,definition,source_snapshot,changed_by,approval_id,reason) VALUES($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7,$8)',[ctx.credential.academy_id,p.target_id,before+1,JSON.stringify(i.definition),JSON.stringify(source),ctx.credential.person_id,p.id,i.reason]);
 await record(ctx.db,ctx.credential,ctx.requestId,p.action,p.target_id,null,{beforeVersion:before||null,afterVersion:before+1,approvalId:p.id,severity:'critical',hasReason:true,configurationOnly:true});return output(await row(ctx,p.target_id));
}
export const storageRouteActions:ApprovalRegistry=Object.fromEntries([true,false].map(creating=>[creating?'storage.route.create':'storage.route.change',{
 requestCapability:'storage.edit',privacyCapability:'storage.view',policyChange:true,createdStatus:creating?201:200,
 validate:(ctx:ApiContext,id:string,raw:unknown)=>validate(ctx,creating,id,raw),
 async dependencies(ctx:ApiContext,id:string,raw:unknown){authority(ctx,true);return basis(ctx,id,creating?0:change.parse(raw).expectedVersion);},apply
}])) as ApprovalRegistry;
export async function storageRoutes(ctx:ApiContext,registry:ApprovalRegistry=storageRouteActions):Promise<Reply|null>{
 const match=/^storage\/routes(?:\/([^/]+)(?:\/(change|history))?)?$/.exec(ctx.path);if(!match)return null;
 const params=new URL(ctx.request.url).searchParams;if([...params].length!==new Set(params.keys()).size)throw new ApiError(400,'DUPLICATE_QUERY');const q=Object.fromEntries(params),id=match[1]?uuid.parse(match[1]):null,section=match[2];
 if(ctx.request.method==='POST'){empty.parse(q);if(!id)return propose(ctx,registry,'storage.route.create',null,0,create.parse(await jsonBody(ctx.request)));if(section!=='change')throw new ApiError(405,'METHOD_NOT_ALLOWED');const i=change.parse(await jsonBody(ctx.request));return propose(ctx,registry,'storage.route.change',id,i.expectedVersion,i);}
 if(ctx.request.method!=='GET'||section==='change')throw new ApiError(405,'METHOD_NOT_ALLOWED');await lockApprovalWrites(ctx);authority(ctx);
 if(id){const r=await row(ctx,id,section==='history');if(section==='history'){const i=history.parse(q),rows=(await ctx.db.query<{version:number}>('SELECT version,definition,changed_by AS "changedBy",approval_id AS "approvalId",reason,created_at::text AS "createdAt" FROM public.file_storage_route_revisions WHERE route_id=$1 AND version>$2 ORDER BY version LIMIT $3',[id,i.afterVersion,i.limit+1])).rows;return {status:200,body:{data:rows.slice(0,i.limit),nextVersion:rows.length>i.limit?rows[i.limit-1].version:null}};}empty.parse(q);return {status:200,body:{data:output(r)}};}
 const i=paging.parse(q),rows=(await ctx.db.query<Row>('SELECT '+columns+' FROM '+from+' WHERE ($1::uuid IS NULL OR h.id>$1) AND ($2::boolean IS NULL OR r.definition->\'enabled\'=to_jsonb($2::boolean)) AND ($3::text IS NULL OR position(lower($3) in lower(r.definition->>\'name\'))>0) ORDER BY h.id LIMIT $4',[i.after??null,i.enabled??null,i.q??null,i.limit+1])).rows;
 return {status:200,body:{data:rows.slice(0,i.limit).map(output),nextCursor:rows.length>i.limit?rows[i.limit-1].id:null}};
}
export const storageRoutesContract=[
 {path:'/api/v1/storage/routes',method:'get',summary:'School-wide permitted non-secret storage destination directory;not bucket/IAM certification or live transfer authority',querySchema:paging},
 {path:'/api/v1/storage/routes',method:'post',summary:'Upper-reviewed named source/destination identities and optional explicit private-serving policy,disabled when absent;bounded copy size and1to60second attachment links,no credentials or network operation',schema:create},
 {path:'/api/v1/storage/routes/{id}',method:'get',summary:'Read a permitted current storage destination definition,not download clearance'},
 {path:'/api/v1/storage/routes/{id}/change',method:'post',summary:'Upper-reviewed exact storage destination revision;old definitions remain immutable',schema:change},
 {path:'/api/v1/storage/routes/{id}/history',method:'get',summary:'Storage-editor-only destination revision and private review history',querySchema:history}
] as const;
