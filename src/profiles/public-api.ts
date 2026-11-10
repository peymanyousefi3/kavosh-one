import { createHmac } from 'node:crypto';
import { z } from 'zod';
import { ApiError } from '../core/policy.ts';
import { assertSchemaReady,type Connection,type Database } from '../core/database.ts';
import { verifiedProxyIp } from '../core/trusted-proxy.ts';
import { profileShareId } from './share-id.ts';

const uuid=z.string().uuid().transform(v=>v.toLowerCase());
const content=z.object({displayName:z.string().min(1).max(150),headline:z.string().max(200),bio:z.string().max(4000)}).strict();
export const publishedProfileSchema=z.object({id:uuid,kind:z.enum(['academy','hub','person']),profileVersion:z.number().int().positive().max(2147483647),publicationVersion:z.number().int().positive().max(2147483647),content:z.object({en:content,fr:content.optional(),'zh-CN':content.optional()}).strict(),links:z.object({github:z.string().url().max(500).startsWith('https://github.com/').nullable(),linkedin:z.string().url().max(500).startsWith('https://www.linkedin.com/in/').nullable()}).strict(),contentFormat:z.literal('plain_text'),mediaIncluded:z.literal(false)}).strict();
export async function assertPublicProfileRole(db:Connection){
 const r=await db.query<{safe:boolean}>(`SELECT NOT r.rolsuper AND NOT r.rolbypassrls AND NOT r.rolcreaterole AND NOT r.rolcreatedb AND NOT r.rolreplication AND pg_has_role(current_user,'kavosh_public_profile_service','member')
 AND NOT EXISTS(SELECT 1 FROM pg_roles x WHERE(x.rolname IN('kavosh_runtime','kavosh_public_profile_policy') OR left(x.rolname,3)='pg_' OR x.rolsuper OR x.rolbypassrls OR x.rolcreaterole OR x.rolcreatedb OR x.rolreplication) AND pg_has_role(current_user,x.oid,'member'))
 AND NOT EXISTS(SELECT 1 FROM pg_namespace n WHERE n.nspname IN('identity','auth_private','platform_private') AND has_schema_privilege(current_user,n.oid,'usage'))
 AND NOT EXISTS(SELECT 1 FROM pg_namespace n WHERE n.nspname IN('public','identity','auth_private','platform_private') AND has_schema_privilege(current_user,n.oid,'create'))
 AND NOT EXISTS(SELECT 1 FROM pg_database d WHERE d.datname=current_database() AND pg_has_role(current_user,d.datdba,'member'))
 AND NOT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN('public','identity','auth_private','platform_private') AND c.relkind IN('r','p','v','m','f') AND(has_table_privilege(current_user,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR has_any_column_privilege(current_user,c.oid,'SELECT,INSERT,UPDATE,REFERENCES')))
 AND NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.prosecdef AND p.oid<>'public.read_published_organization_profile(uuid,text)'::regprocedure AND has_function_privilege(current_user,p.oid,'EXECUTE')) AS safe FROM pg_roles r WHERE r.rolname=current_user`);
 if(r.rows[0]?.safe!==true)throw new Error('UNSAFE_PUBLIC_PROFILE_ROLE');
}
export function createPublicProfileApi(database:Database,config:{enabled:boolean;production:boolean;edgeSecret?:string;budgetSecret?:string}){
 return async(request:Request,rawId:string)=>{
  const headers={'Cache-Control':'no-store','Pragma':'no-cache','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff','Content-Security-Policy':"sandbox; default-src 'none'"};let db:Connection|undefined,transaction=false,destroy=false;
  try{
   if(!config.enabled)throw new ApiError(404,'NOT_FOUND');if(request.method!=='GET')throw new ApiError(405,'METHOD_NOT_ALLOWED');if(new URL(request.url).search)throw new ApiError(400,'INVALID_QUERY');const id=profileShareId.parse(rawId);
   if(!config.budgetSecret||config.budgetSecret.length<32||config.budgetSecret.length>4096||config.budgetSecret===config.edgeSecret)throw new Error('INDEPENDENT_PUBLIC_BUDGET_SECRET_REQUIRED');const ip=verifiedProxyIp(request,config),budget=createHmac('sha256',config.budgetSecret).update('public-profile-ip:v1:'+ip).digest('hex');
   db=await database.connect();await assertPublicProfileRole(db);await assertSchemaReady(db);await db.query('BEGIN');transaction=true;await db.query("SELECT set_config('statement_timeout','5s',true),set_config('lock_timeout','2s',true)");
   const r=(await db.query<{result:{limited:boolean;data?:unknown}}>('SELECT public.read_published_organization_profile($1,$2) result',[id,budget])).rows[0]?.result;
   if(!r||typeof r.limited!=='boolean')throw new Error('PUBLIC_PROFILE_RESULT_INVALID');await db.query('COMMIT');transaction=false;
   if(r.limited)throw new ApiError(429,'RATE_LIMITED');if(!r.data)throw new ApiError(404,'NOT_FOUND');const output=publishedProfileSchema.safeParse(r.data);if(!output.success)throw new Error('PUBLIC_PROFILE_OUTPUT_INVALID');return Response.json({data:output.data},{headers});
  }catch(error){if(transaction)try{await db!.query('ROLLBACK');}catch{destroy=true;}const status=error instanceof ApiError?error.status:error instanceof z.ZodError?400:503,code=error instanceof ApiError?error.code:error instanceof z.ZodError?'INVALID_INPUT':'PUBLIC_PROFILE_UNAVAILABLE';return Response.json({error:{code}},{status,headers:{...headers,...status===429?{'Retry-After':'60'}:{}}});}finally{db?.release(destroy);}
 };
}
