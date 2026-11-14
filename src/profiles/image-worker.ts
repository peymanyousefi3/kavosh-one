import {z} from 'zod';
import {assertSchemaReady,type Connection,type Database} from '../core/database.ts';
import {ApiError} from '../core/policy.ts';
import type {R2Connection,R2DownloadConnections} from '../integrations/r2-config.ts';
import {r2TargetId} from '../integrations/r2-config.ts';
import {prepareProfileImage} from './image-preparation.ts';
import {retainProfileImage,reviewedImageSourceSchema} from './image-retention.ts';

const uuid=z.string().uuid().transform(v=>v.toLowerCase()),digest=z.string().regex(/^[a-f0-9]{64}$/);
const receipt=z.object({objectId:uuid,storageTargetId:digest,etag:z.string().min(3).max(202).regex(/^"[\x21\x23-\x7e]+"$/),bytes:z.number().int().positive().max(4194304),sha256:digest,mime:z.literal('image/webp'),width:z.number().int().min(1).max(2048),height:z.number().int().min(1).max(2048),purpose:z.enum(['avatar','achievement']),releaseVersion:z.number().int().positive().max(2147483647),releaseFingerprint:digest,imageNo:z.number().int().min(1).max(100),bytesReadBackVerified:z.literal(true),published:z.literal(false),originalModified:z.literal(false)}).strict().refine(v=>v.purpose!=='avatar'||v.bytes<=1048576&&v.width<=512&&v.height<=512);
const result=z.discriminatedUnion('outcome',[z.object({outcome:z.literal('retained'),receipt}).strict(),z.object({outcome:z.enum(['unavailable','rejected','stored_bytes_mismatch','outcome_unknown'])}).strict()]);
export type ProfileImageResult=z.infer<typeof result>;
type Source=z.infer<typeof reviewedImageSourceSchema>;
type Claimed={source:unknown;lease_token:string;attempt_no:number};
export async function assertProfileImageWorkerRole(db:Connection){
 const r=await db.query<{safe:boolean}>(`SELECT NOT r.rolsuper AND NOT r.rolbypassrls AND NOT r.rolcreatedb AND NOT r.rolcreaterole AND NOT r.rolreplication AND left(r.rolname,3)<>'pg_'
 AND pg_has_role(current_user,'kavosh_profile_image_worker','member')
 AND NOT EXISTS(SELECT 1 FROM pg_roles other WHERE other.rolname LIKE 'kavosh\\_%' ESCAPE '\\' AND other.rolname NOT IN(current_user,'kavosh_profile_image_worker') AND pg_has_role(current_user,other.oid,'member'))
 AND NOT EXISTS(SELECT 1 FROM pg_roles other WHERE left(other.rolname,3)='pg_' AND pg_has_role(current_user,other.oid,'member'))
 AND NOT EXISTS(SELECT 1 FROM pg_namespace n WHERE n.nspname IN('auth_private','identity','platform_private') AND has_schema_privilege(current_user,n.oid,'usage'))
 AND NOT has_schema_privilege(current_user,'public','create')
 AND NOT EXISTS(SELECT 1 FROM pg_roles elevated WHERE(elevated.rolsuper OR elevated.rolbypassrls OR elevated.rolcreatedb OR elevated.rolcreaterole OR elevated.rolreplication) AND pg_has_role(current_user,elevated.oid,'member'))
 AND NOT EXISTS(SELECT 1 FROM pg_database d WHERE d.datname=current_database() AND pg_has_role(current_user,d.datdba,'member'))
 AND NOT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind IN('r','p','v','m','f') AND n.nspname IN('public','auth_private','identity','platform_private') AND(has_any_column_privilege(current_user,c.oid,'SELECT,INSERT,UPDATE,REFERENCES') OR has_table_privilege(current_user,c.oid,'DELETE,TRUNCATE,TRIGGER,MAINTAIN') OR pg_has_role(current_user,c.relowner,'member')))
 AND NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN('public','auth_private','identity','platform_private') AND p.prosecdef AND has_function_privilege(current_user,p.oid,'execute') AND p.oid NOT IN('public.claim_profile_image_job(uuid[],uuid,integer)'::regprocedure,'public.finish_profile_image_job(uuid,uuid,integer,integer,uuid,jsonb)'::regprocedure)) safe FROM pg_roles r WHERE r.rolname=current_user`);
 if(!r.rows[0]?.safe)throw Error('UNSAFE_PROFILE_IMAGE_WORKER_ROLE');
}
// Provider/codec IO occurs with no open database connection or transaction.
// Operator injects exact readers and a private derivative writer;no web URL,
// env credential fallback,automatic activation or public serving capability.
export async function generateStoredProfileImage(source:Source,readers:R2DownloadConnections,destination:(academyId:string)=>R2Connection|null,socketPath:string,signal:AbortSignal):Promise<ProfileImageResult>{
 try{const s=reviewedImageSourceSchema.parse(source),configuration=destination(s.academyId);if(!configuration)return{outcome:'unavailable'};
  const {releaseVersion:_,releaseFingerprint:__,imageNo:___,...original}=s,prepared=await prepareProfileImage(original,readers,{socketPath,signal});
  return{outcome:'retained',receipt:await retainProfileImage(configuration,s,prepared.validation,{targetId:r2TargetId(configuration),signal})};
 }catch(e){if(e instanceof ApiError){if(['PROFILE_IMAGE_REJECTED','PROFILE_IMAGE_SOURCE_MISMATCH'].includes(e.code))return{outcome:'rejected'};if(e.code==='PROFILE_IMAGE_STORED_BYTES_MISMATCH')return{outcome:'stored_bytes_mismatch'};if(e.code==='PROFILE_IMAGE_RETENTION_OUTCOME_UNKNOWN')return{outcome:'outcome_unknown'};}return{outcome:'unavailable'};}
}
export async function processOneProfileImage(database:Database,academies:string[],workerId:string,process:(source:Source,signal:AbortSignal)=>Promise<ProfileImageResult>,options:{timeoutMs?:number;signal?:AbortSignal}={}){
 const schools=z.array(uuid).min(1).max(1000).refine(v=>new Set(v).size===v.length).parse(academies),worker=uuid.parse(workerId),timeout=z.number().int().min(1).max(300000).parse(options.timeoutMs??65000);
 if(options.signal?.aborted)return{claimed:false,recorded:false};
 const claim=await database.connect();let row:Claimed|undefined;
 try{await assertProfileImageWorkerRole(claim);await assertSchemaReady(claim);row=(await claim.query<Claimed>('SELECT * FROM public.claim_profile_image_job($1,$2,$3)',[schools,worker,Math.max(60,Math.ceil(timeout/1000)+30)])).rows[0];}finally{claim.release();}
 if(!row)return{claimed:false,recorded:false};const source=reviewedImageSourceSchema.parse(row.source),lease=uuid.parse(row.lease_token),abort=new AbortController();let stop!:()=>void;
 const stopped=new Promise<ProfileImageResult>(yes=>{stop=()=>{abort.abort();yes({outcome:'outcome_unknown'});};});options.signal?.addEventListener('abort',stop,{once:true});const timer=setTimeout(stop,timeout);if(options.signal?.aborted)stop();let output:ProfileImageResult;
 try{output=result.parse(await Promise.race([Promise.resolve().then(()=>abort.signal.aborted?{outcome:'outcome_unknown' as const}:process(source,abort.signal)),stopped]));if(output.outcome==='retained'&&(output.receipt.releaseVersion!==source.releaseVersion||output.receipt.releaseFingerprint!==source.releaseFingerprint||output.receipt.imageNo!==source.imageNo||output.receipt.purpose!==source.purpose))output={outcome:'outcome_unknown'};}catch{output={outcome:'outcome_unknown'};}finally{clearTimeout(timer);options.signal?.removeEventListener('abort',stop);abort.abort();}
 const finish=await database.connect();try{await assertProfileImageWorkerRole(finish);await assertSchemaReady(finish);return{claimed:true,recorded:(await finish.query<{recorded:boolean}>('SELECT public.finish_profile_image_job($1,$2,$3,$4,$5,$6::jsonb) recorded',[source.academyId,source.profileId,source.releaseVersion,source.imageNo,lease,JSON.stringify(output)])).rows[0]?.recorded===true};}finally{finish.release();}
}
