import {createHmac} from 'node:crypto';
import {z} from 'zod';
import {ApiError} from '../core/policy.ts';
import {assertSchemaReady,type Connection,type Database} from '../core/database.ts';
import {verifiedProxyIp} from '../core/trusted-proxy.ts';
import {assertPublicProfileRole} from './public-api.ts';
import {websitePolicyCode,websitePolicyKind} from '../modules/website-policies.ts';

const uuid=z.string().uuid().transform(v=>v.toLowerCase()),locale=z.enum(['en','fr','zh-CN']);
export const publicWebsitePolicyQuery=z.object({locale:locale.default('en'),after:websitePolicyCode.optional(),limit:z.coerce.number().int().min(1).max(50).default(20)}).strict();
const summary=z.object({code:websitePolicyCode,kind:websitePolicyKind,documentVersion:z.number().int().positive().max(2147483647),publicationVersion:z.number().int().positive().max(2147483647),contentSha256:z.string().regex(/^[a-f0-9]{64}$/),locale,title:z.string().min(1).max(200)}).strict().refine(v=>v.kind!=='incident_response');
export const publishedWebsitePolicyDirectorySchema=z.object({academyId:uuid,data:z.array(summary).max(50),nextCode:websitePolicyCode.nullable()}).strict();
export const publishedWebsitePolicySchema=z.object({academyId:uuid,code:websitePolicyCode,kind:websitePolicyKind,documentVersion:z.number().int().positive().max(2147483647),publicationVersion:z.number().int().positive().max(2147483647),contentSha256:z.string().regex(/^[a-f0-9]{64}$/),publishedAt:z.iso.datetime(),locale,title:z.string().min(1).max(200),body:z.string().min(1).max(20000),contentFormat:z.literal('plain_text'),legalValidityCertified:z.literal(false)}).strict().refine(v=>v.kind!=='incident_response');
export function createPublicWebsitePolicyApi(database:Database,config:{production:boolean;edgeSecret?:string;budgetSecret?:string}){
 return async(request:Request,rawAcademy:string,rawCode?:string)=>{
  const headers={'Cache-Control':'no-store','Pragma':'no-cache','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff','Content-Security-Policy':"sandbox; default-src 'none'"};let db:Connection|undefined,transaction=false,destroy=false;
  try{
   if(request.method!=='GET')throw new ApiError(405,'METHOD_NOT_ALLOWED');const params=new URL(request.url).searchParams;if([...params].length!==new Set(params.keys()).size)throw new ApiError(400,'DUPLICATE_QUERY');
   const school=uuid.parse(rawAcademy),code=rawCode===undefined?null:websitePolicyCode.parse(rawCode),q=publicWebsitePolicyQuery.parse(Object.fromEntries(params));if(code!==null&&(params.has('after')||params.has('limit')))throw new ApiError(400,'INVALID_QUERY');
   if(!config.budgetSecret||config.budgetSecret.length<32||config.budgetSecret.length>4096||config.budgetSecret===config.edgeSecret)throw new Error('INDEPENDENT_PUBLIC_BUDGET_SECRET_REQUIRED');
   // Share the existing public IP ceiling;new routes cannot multiply its budget.
   const ip=verifiedProxyIp(request,config),budget=createHmac('sha256',config.budgetSecret).update('public-profile-ip:v1:'+ip).digest('hex');
   db=await database.connect();await assertPublicProfileRole(db);await assertSchemaReady(db);await db.query('BEGIN ISOLATION LEVEL READ COMMITTED');transaction=true;await db.query("SELECT set_config('statement_timeout','5s',true),set_config('lock_timeout','2s',true)");
   const r=(await db.query<{result:{limited:boolean;data?:unknown;academyId?:unknown;nextCode?:unknown}}>(code===null?'SELECT public.list_published_website_policies($1,$2,$3,$4,$5) result':'SELECT public.read_published_website_policy($1,$2,$3,$4) result',code===null?[school,q.locale,q.after??null,q.limit,budget]:[school,code,q.locale,budget])).rows[0]?.result;if(!r||typeof r.limited!=='boolean')throw Error('INVALID_PUBLIC_POLICY_RESULT');
   await db.query('COMMIT');transaction=false;if(r.limited)throw new ApiError(429,'RATE_LIMITED');
   if(code===null){const parsed=publishedWebsitePolicyDirectorySchema.safeParse({academyId:r.academyId,data:r.data,nextCode:r.nextCode});if(!parsed.success)throw Error('INVALID_PUBLIC_POLICY_DIRECTORY');const out=parsed.data;if(out.academyId!==school||out.data.length>q.limit||out.data.some((v,i)=>(v.locale!==q.locale&&v.locale!=='en')||(q.after!==undefined&&v.code<=q.after)||(i>0&&out.data[i-1].code>=v.code))||(out.nextCode!==null&&(out.data.length!==q.limit||out.nextCode!==out.data.at(-1)?.code)))throw Error('INVALID_PUBLIC_POLICY_DIRECTORY');return Response.json(out,{headers});}
   if(!r.data)throw new ApiError(404,'NOT_FOUND');const parsed=publishedWebsitePolicySchema.safeParse(r.data);if(!parsed.success)throw Error('INVALID_PUBLIC_POLICY_OUTPUT');const data=parsed.data;if(data.academyId!==school||data.code!==code||(data.locale!==q.locale&&data.locale!=='en'))throw Error('PUBLIC_POLICY_IDENTITY_CHANGED');
   return Response.json({data},{headers});
  }catch(error){if(transaction)try{await db!.query('ROLLBACK');}catch{destroy=true;}const status=error instanceof ApiError?error.status:error instanceof z.ZodError?400:503,code=error instanceof ApiError?error.code:error instanceof z.ZodError?'INVALID_INPUT':'PUBLIC_POLICY_UNAVAILABLE';return Response.json({error:{code}},{status,headers:{...headers,...status===429?{'Retry-After':'60'}:{}}});}finally{db?.release(destroy);}
 };
}
