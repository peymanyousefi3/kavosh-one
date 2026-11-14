import { z } from 'zod';
import { ApiError } from '../core/policy.ts';
import { assertSchemaReady,type Connection,type Database } from '../core/database.ts';
import { signatureCompletionSourceSchema,workSignatureCompletionSourceSchema,type WorkSignaturePartyRole } from './boldsign-completion.ts';

const uuid=z.string().uuid().transform(v=>v.toLowerCase());
const target=z.object({academyId:uuid,startId:uuid}).strict();
const observed=z.object({name:z.string().min(1).max(200),email:z.string().email().max(254),phone:z.string().regex(/^[+][1-9][0-9]{7,14}$/).nullable()}).strict();
export async function assertSignatureCompletionRole(db:Connection){
 const r=await db.query<{safe:boolean}>(`SELECT NOT r.rolsuper AND NOT r.rolbypassrls AND NOT r.rolcreaterole AND NOT r.rolcreatedb AND NOT r.rolreplication AND left(r.rolname,3)<>'pg_' AND pg_has_role(current_user,'kavosh_signature_completion_worker','member')
 AND NOT EXISTS(SELECT 1 FROM pg_roles b WHERE b.rolname<>current_user AND(left(b.rolname,3)='pg_' OR(left(b.rolname,7)='kavosh_' AND b.rolname<>'kavosh_signature_completion_worker')) AND pg_has_role(current_user,b.oid,'member'))
 AND NOT has_schema_privilege(current_user,'identity','usage') AND NOT has_schema_privilege(current_user,'auth_private','usage') AND NOT has_schema_privilege(current_user,'public','create')
 AND NOT EXISTS(SELECT 1 FROM pg_namespace n WHERE n.nspname='platform_private' AND has_schema_privilege(current_user,n.oid,'usage'))
 AND NOT EXISTS(SELECT 1 FROM pg_database d WHERE d.datname=current_database() AND pg_has_role(current_user,d.datdba,'member'))
 AND NOT EXISTS(SELECT 1 FROM pg_namespace n WHERE n.nspname IN('public','identity','auth_private') AND pg_has_role(current_user,n.nspowner,'member'))
 AND NOT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN('public','identity','auth_private')
 AND(pg_has_role(current_user,c.relowner,'member') OR has_table_privilege(current_user,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN') OR has_any_column_privilege(current_user,c.oid,'SELECT,INSERT,UPDATE,REFERENCES')))
 AND NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN('public','identity','auth_private') AND p.prosecdef AND has_schema_privilege(current_user,n.oid,'USAGE') AND has_function_privilege(current_user,p.oid,'EXECUTE')
 AND p.oid NOT IN('public.signature_completion_source(uuid,uuid)'::regprocedure,'public.signature_completion_signer_matches(uuid,uuid,text,text,text,text)'::regprocedure,'public.record_signature_completion_evidence(uuid,uuid,text,text,jsonb)'::regprocedure,'public.work_signature_completion_source(uuid,uuid)'::regprocedure,'public.work_signature_completion_signer_matches(uuid,uuid,text,text,text,text,text)'::regprocedure,'public.record_work_signature_completion_evidence(uuid,uuid,text,text,jsonb)'::regprocedure,'public.claim_signature_completion_job(uuid[],uuid,integer)'::regprocedure,'public.finish_signature_completion_job(uuid,text,uuid,uuid,text,uuid,integer)'::regprocedure))
 AND NOT EXISTS(SELECT 1 FROM pg_roles e WHERE(e.rolsuper OR e.rolbypassrls) AND pg_has_role(current_user,e.oid,'member')) safe FROM pg_roles r WHERE r.rolname=current_user`);
 if(!r.rows[0]?.safe)throw new Error('UNSAFE_SIGNATURE_COMPLETION_ROLE');
}
// Dedicated service connection only,never web/bot credentials. Release it
// before provider/storage IO. No current contact lookup or automatic sending.
async function read<T>(database:Database,run:(c:Connection)=>Promise<T>){
 let c:Connection;try{c=await database.connect();}catch{throw new ApiError(503,'SIGNATURE_COMPLETION_SOURCE_UNAVAILABLE');}
 try{await assertSignatureCompletionRole(c);await assertSchemaReady(c);return await run(c);}
 catch{throw new ApiError(503,'SIGNATURE_COMPLETION_SOURCE_UNAVAILABLE');}finally{c.release();}
}
export async function loadSignatureCompletionSource(database:Database,raw:unknown){
 const p=target.safeParse(raw);if(!p.success)throw new ApiError(400,'INVALID_SIGNATURE_COMPLETION_TARGET');
 return read(database,async c=>{const value=(await c.query<{source:unknown}>('SELECT public.signature_completion_source($1,$2) source',[p.data.academyId,p.data.startId])).rows[0]?.source;
  if(value===null)return null;return signatureCompletionSourceSchema.parse(value);
 });
}
export async function matchSignatureCompletionSigner(database:Database,rawSource:unknown,rawObserved:unknown){
 const s=signatureCompletionSourceSchema.safeParse(rawSource),o=observed.safeParse(rawObserved);if(!s.success||!o.success)throw new ApiError(400,'INVALID_SIGNATURE_COMPLETION_COMPARISON');
 return read(database,async c=>{const result=(await c.query<{name_matches:boolean;email_matches:boolean;phone_matches:boolean}>('SELECT * FROM public.signature_completion_signer_matches($1,$2,$3,$4,$5,$6)',[s.data.academyId,s.data.startId,s.data.sourceFingerprint,o.data.name,o.data.email,o.data.phone])).rows[0];
  return result?{nameMatches:result.name_matches===true,emailMatches:result.email_matches===true,phoneMatches:result.phone_matches===true}:null;
 });
}
export async function loadWorkSignatureCompletionSource(database:Database,raw:unknown){
 const p=target.safeParse(raw);if(!p.success)throw new ApiError(400,'INVALID_SIGNATURE_COMPLETION_TARGET');
 return read(database,async c=>{const value=(await c.query<{source:unknown}>('SELECT public.work_signature_completion_source($1,$2) source',[p.data.academyId,p.data.startId])).rows[0]?.source;
  if(value===null)return null;return workSignatureCompletionSourceSchema.parse(value);
 });
}
export async function matchWorkSignatureCompletionSigner(database:Database,rawSource:unknown,role:WorkSignaturePartyRole,rawObserved:unknown){
 const s=workSignatureCompletionSourceSchema.safeParse(rawSource),o=observed.safeParse(rawObserved);if(!s.success||!o.success||!s.data.parties.some(p=>p.role===role))throw new ApiError(400,'INVALID_SIGNATURE_COMPLETION_COMPARISON');
 return read(database,async c=>{const result=(await c.query<{name_matches:boolean;email_matches:boolean;phone_matches:boolean}>('SELECT * FROM public.work_signature_completion_signer_matches($1,$2,$3,$4,$5,$6,$7)',[s.data.academyId,s.data.startId,s.data.sourceFingerprint,role,o.data.name,o.data.email,o.data.phone])).rows[0];
  return result?{nameMatches:result.name_matches===true,emailMatches:result.email_matches===true,phoneMatches:result.phone_matches===true}:null;
 });
}
const digest=z.string().regex(/^[a-f0-9]{64}$/),etag=z.string().min(3).max(202).regex(/^"[\x21\x23-\x7e]+"$/);
const artifact=z.object({id:uuid,sha256:digest,sizeBytes:z.number().int().min(1).max(10485760)}).strict();
export const signatureEvidenceManifestSchema=z.object({storageTargetId:digest,receipt:z.object({sourceFingerprint:digest,document:artifact,audit:artifact,properties:artifact.extend({sizeBytes:z.number().int().min(1).max(1048576)})}).strict(),etags:z.object({document:etag,audit:etag,properties:etag}).strict()}).strict();
const evidenceInput=target.extend({sourceFingerprint:digest,propertiesJson:z.string().min(1).max(1048576).refine(s=>s.isWellFormed()&&!s.includes('\0')&&Buffer.byteLength(s,'utf8')<=1048576),storage:signatureEvidenceManifestSchema}).strict();
async function recordEvidence(purpose:'unified_enrollment'|'worker_services',database:Database,raw:unknown){
 const p=evidenceInput.safeParse(raw);if(!p.success)throw new ApiError(400,'INVALID_SIGNATURE_COMPLETION_EVIDENCE');const i=p.data;
 try{return await read(database,async c=>{const row=(await c.query<{evidence_id:string;evidence_state:string;inserted:boolean}>(purpose==='worker_services'?'SELECT * FROM public.record_work_signature_completion_evidence($1,$2,$3,$4,$5::jsonb)':'SELECT * FROM public.record_signature_completion_evidence($1,$2,$3,$4,$5::jsonb)',[i.academyId,i.startId,i.sourceFingerprint,i.propertiesJson,JSON.stringify(i.storage)])).rows[0];
  if(!row||!uuid.safeParse(row.evidence_id).success||!['evidence_recorded','review_required'].includes(row.evidence_state)||typeof row.inserted!=='boolean')throw Error();
  return {id:row.evidence_id,state:row.evidence_state,inserted:row.inserted,reviewPending:true as const,admissionCleared:false as const,legalValidityCertified:false as const};
 });}catch{throw new ApiError(503,'SIGNATURE_COMPLETION_EVIDENCE_UNAVAILABLE');}
}
export const recordSignatureCompletionEvidence=(database:Database,raw:unknown)=>recordEvidence('unified_enrollment',database,raw);
export const recordWorkSignatureCompletionEvidence=(database:Database,raw:unknown)=>recordEvidence('worker_services',database,raw);
