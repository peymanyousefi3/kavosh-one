import { z } from 'zod';
import { createHmac } from 'node:crypto';
import { jsonBody } from '../core/api.ts';
import { assertSchemaReady,type Connection,type Database } from '../core/database.ts';
import { ApiError } from '../core/policy.ts';

const id=z.string().uuid().transform(v=>v.toLowerCase()),name=z.string().trim().min(1).max(200),reason=z.string().trim().min(1).max(2000);
const provision=z.object({name,masterName:name,masterEmail:z.string().email().max(254).transform(v=>v.toLowerCase()),reason}).strict();
const change=z.object({expectedVersion:z.number().int().positive().max(2147483647),name:name.optional(),status:z.enum(['provisioning','active','read_only','suspended']).optional(),reason}).strict().refine(v=>v.name!==undefined||v.status!==undefined);
const paging=z.object({limit:z.coerce.number().int().min(1).max(100).optional(),after:id.optional()}).strict();
const invitation=z.object({expectedVersion:z.number().int().positive().max(2147483647),reason}).strict();
const revokeInvitation=invitation.extend({invitationRequestKey:id}).strict();
function invitationToken(secret:string,userId:string,academyId:string,key:string){return 'kvi_'+createHmac('sha256',secret).update(JSON.stringify(['platform-master-invitation:v1',userId,academyId,key])).digest('base64url');}
export type PlatformSession={userId:string;sessionId:string};
export const platformContract=[
 {path:'/api/platform/v1/academies',method:'get',summary:'Audited platform-owner school directory',querySchema:paging},
 {path:'/api/platform/v1/academies',method:'post',summary:'Provision a school with one pending master; does not bypass verified invitation onboarding',schema:provision},
 {path:'/api/platform/v1/academies/{id}',method:'get',summary:'Audited platform-owner school and master directory details'},
 {path:'/api/platform/v1/academies/{id}/change',method:'post',summary:'Version-checked school name or operational status change; master cannot be transferred',schema:change},
 {path:'/api/platform/v1/academies/{id}/master-invitation',method:'post',summary:'Issue a private 48-hour invitation for the school’s existing pending master; never activate or send',schema:invitation},
 {path:'/api/platform/v1/academies/{id}/master-invitation/revoke',method:'post',summary:'Cancel one exact unused initial-master invitation under current platform-owner MFA; never cancel a replacement or change accounts; pre-tracking invitations require reissue',schema:revokeInvitation},
 {path:'/api/platform/v1/audit',method:'get',summary:'Read immutable platform access and change history',querySchema:paging}
] as const;

export async function assertPlatformRole(db:Connection){
 const result=await db.query<{safe:boolean}>(`SELECT NOT r.rolsuper AND NOT r.rolbypassrls AND NOT r.rolcreaterole AND NOT r.rolcreatedb AND NOT r.rolreplication
 AND pg_has_role(current_user,'kavosh_platform_service','member')
 AND NOT has_schema_privilege(current_user,'public','create')
 AND NOT EXISTS(SELECT 1 FROM pg_namespace n WHERE n.nspname IN('identity','auth_private') AND has_schema_privilege(current_user,n.oid,'usage'))
 AND NOT EXISTS(SELECT 1 FROM pg_roles e WHERE(e.rolsuper OR e.rolbypassrls OR e.rolname IN('kavosh_platform_policy','kavosh_runtime','kavosh_file_worker','kavosh_file_policy','kavosh_identity','kavosh_delivery','kavosh_identity_policy','kavosh_signature_ingest','kavosh_signature_policy','kavosh_signature_result_worker','kavosh_signature_result_policy','kavosh_automation_worker','kavosh_automation_policy','kavosh_event_policy')) AND pg_has_role(current_user,e.oid,'member'))
 AND NOT EXISTS(SELECT 1 FROM pg_database d WHERE d.datname=current_database() AND pg_has_role(current_user,d.datdba,'member'))
 AND NOT EXISTS(SELECT 1 FROM pg_namespace n WHERE n.nspname IN('public','identity','auth_private','platform_private') AND pg_has_role(current_user,n.nspowner,'member'))
 AND NOT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN('public','identity','auth_private','platform_private') AND c.relkind IN('r','p','v','m','f') AND (pg_has_role(current_user,c.relowner,'member') OR has_table_privilege(current_user,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR has_any_column_privilege(current_user,c.oid,'SELECT,INSERT,UPDATE,REFERENCES')))
 AND NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN('public','identity','auth_private','platform_private') AND p.prosecdef AND has_schema_privilege(current_user,n.oid,'usage') AND has_function_privilege(current_user,p.oid,'execute') AND p.oid NOT IN('platform_private.consume_request_budget(uuid,uuid)'::regprocedure,'platform_private.request(uuid,uuid,text,uuid,jsonb)'::regprocedure,'platform_private.issue_master_invitation(uuid,uuid,uuid,uuid,integer,text,text)'::regprocedure,'platform_private.revoke_master_invitation(uuid,uuid,uuid,uuid,integer,uuid,text,text)'::regprocedure)) AS safe FROM pg_roles r WHERE r.rolname=current_user`);
 if(result.rows[0]?.safe!==true)throw new Error('UNSAFE_PLATFORM_DATABASE_ROLE');
}

export function createPlatformApi(database:Database,resolve:(request:Request)=>Promise<PlatformSession|null>,enabled=false,options:{invitationSecret?:string}={}){
 return async(request:Request,path:string)=>{
  const headers={'Cache-Control':'no-store','Pragma':'no-cache','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff'};
  let db:Connection|undefined,transaction=false,destroy=false;
  try{
   if(!enabled)throw new ApiError(404,'NOT_FOUND');
   if(request.headers.has('authorization'))throw new ApiError(401,'HUMAN_SESSION_REQUIRED');
   const session=await resolve(request);if(!session)throw new ApiError(401,'HUMAN_SESSION_REQUIRED');
   id.parse(session.userId);id.parse(session.sessionId);
   const target=/^academies\/([a-f0-9-]{36})(\/(?:change|master-invitation(?:\/revoke)?))?$/.exec(path);
   let operation:string,input:unknown,key:string|null=null,privateInvitation:string|undefined,inviteInput:{academyId:string;expectedVersion:number;reason:string;tokenHash:string}|undefined,revokeInput:{academyId:string;expectedVersion:number;invitationRequestKey:string;reason:string;tokenHash:string}|undefined;
   const url=new URL(request.url);
   if(request.method==='GET'&&(path==='academies'||path==='audit')){
    const pairs=[...url.searchParams];if(new Set(pairs.map(([k])=>k)).size!==pairs.length)throw new ApiError(400,'INVALID_QUERY');
    input=paging.parse(Object.fromEntries(pairs));operation=path==='audit'?'audit.list':'academies.list';
   }else if(request.method==='GET'&&target&&!target[2]){
    if(url.search)throw new ApiError(400,'INVALID_QUERY');input={academyId:id.parse(target[1])};operation='academies.get';
   }else if(request.method==='POST'&&(path==='academies'||target?.[2])){
    if(url.search)throw new ApiError(400,'INVALID_QUERY');
    key=id.parse(request.headers.get('idempotency-key'));
    const body=await jsonBody(request);
    if(target?.[2]==='/master-invitation'||target?.[2]==='/master-invitation/revoke'){
     const revoking=target[2].endsWith('/revoke'),parsed=revoking?revokeInvitation.parse(body):invitation.parse(body),academyId=id.parse(target[1]);
     if(!options.invitationSecret||options.invitationSecret.length<32)throw new Error('INVITATION_SECRET_NOT_CONFIGURED');
     // PRF-derived secret permits exact retries without storing a plaintext token.
     const token=invitationToken(options.invitationSecret,session.userId,academyId,revoking?(parsed as z.infer<typeof revokeInvitation>).invitationRequestKey:key),tokenHash=createHmac('sha256',options.invitationSecret).update(token).digest('hex');
     if(revoking){revokeInput={...parsed as z.infer<typeof revokeInvitation>,academyId,tokenHash};input=revokeInput;operation='academies.master-invitation.revoke';}
     else{privateInvitation=token;inviteInput={...parsed,academyId,tokenHash};input=inviteInput;operation='academies.master-invitation';}
    }else{input=path==='academies'?provision.parse(body):{...change.parse(body),academyId:id.parse(target![1])};operation=path==='academies'?'academies.provision':'academies.change';}
   }else throw new ApiError(path==='academies'||path==='audit'||target?405:404,path==='academies'||path==='audit'||target?'METHOD_NOT_ALLOWED':'NOT_FOUND');
   db=await database.connect();await assertSchemaReady(db);await assertPlatformRole(db);
   if((await db.query<{allowed:boolean}>('SELECT platform_private.consume_request_budget($1,$2) AS allowed',[session.userId,session.sessionId])).rows[0]?.allowed!==true)throw new ApiError(429,'RATE_LIMITED');
   await db.query('BEGIN');transaction=true;
   await db.query("SELECT set_config('statement_timeout','5s',true),set_config('lock_timeout','2s',true)");
   const result=revokeInput?(await db.query<{result:unknown}>('SELECT platform_private.revoke_master_invitation($1,$2,$3,$4,$5,$6,$7,$8) AS result',[session.userId,session.sessionId,key,revokeInput.academyId,revokeInput.expectedVersion,revokeInput.invitationRequestKey,revokeInput.tokenHash,revokeInput.reason])).rows[0]?.result:inviteInput?(await db.query<{result:unknown}>('SELECT platform_private.issue_master_invitation($1,$2,$3,$4,$5,$6,$7) AS result',[session.userId,session.sessionId,key,inviteInput.academyId,inviteInput.expectedVersion,inviteInput.reason,inviteInput.tokenHash])).rows[0]?.result:(await db.query<{result:unknown}>('SELECT platform_private.request($1,$2,$3,$4,$5::jsonb) AS result',[session.userId,session.sessionId,operation,key,JSON.stringify(input)])).rows[0]?.result;
   const parsed=z.object({status:z.union([z.literal(200),z.literal(201)]),body:z.unknown()}).strict().safeParse(result);
   if(!parsed.success)throw new Error('INVALID_PLATFORM_RESULT');const value=parsed.data;
   let responseBody=value.body;
   if(privateInvitation){
    const body=z.object({data:z.object({academyId:id,masterPersonId:id,email:z.string().email(),expiresAt:z.string(),externalDeliveryPerformed:z.literal(false),activationPerformed:z.literal(false),invitationRequestKey:id.optional(),issuedAcademyVersion:z.number().int().positive().optional()}).strict()}).strict().safeParse(value.body);
    if(!body.success||body.data.data.academyId!==inviteInput!.academyId||(body.data.data.invitationRequestKey!==undefined&&body.data.data.invitationRequestKey!==key))throw new Error('INVALID_PLATFORM_RESULT');
    responseBody={data:{...body.data.data,privateInvitation}};
   }
   await db.query('COMMIT');transaction=false;
   return Response.json(responseBody,{status:value.status,headers});
  }catch(error){
   if(transaction)try{await db!.query('ROLLBACK');}catch{destroy=true;}
   let status=503,code='PLATFORM_UNAVAILABLE';
   if(error instanceof ApiError){status=error.status;code=error.code;}
   else if(error instanceof z.ZodError){status=400;code='INVALID_INPUT';}
   else if(error&&typeof error==='object'&&'message' in error){
    const message=String(error.message);
    if(message==='PLATFORM_OWNER_REQUIRED'){status=403;code=message;}
    else if(message==='PLATFORM_ACADEMY_NOT_FOUND'){status=404;code=message;}
    else if(['PLATFORM_IDEMPOTENCY_CONFLICT','PLATFORM_ACADEMY_VERSION_CHANGED','PLATFORM_MASTER_VERIFICATION_REQUIRED','PLATFORM_PROVISIONING_REENTRY_FORBIDDEN','PLATFORM_MASTER_INVITATION_UNAVAILABLE','PLATFORM_INVITATION_NO_LONGER_CURRENT','PLATFORM_INVITATION_REISSUE_REQUIRED'].includes(message)){status=409;code=message;}
    else if(message==='INVALID_PLATFORM_INPUT'){status=400;code=message;}
   }
   return Response.json({error:{code}},{status,headers:{...headers,...(status===429?{'Retry-After':'60'}:{})}});
  }finally{db?.release(destroy);}
 };
}
