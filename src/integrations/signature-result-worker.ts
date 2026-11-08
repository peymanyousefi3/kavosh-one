import { z } from 'zod';
import { ApiError } from '../core/policy.ts';
import { assertSchemaReady,type Connection,type Database } from '../core/database.ts';
import { boldSignSubmissionOutcomeSchema } from './boldsign.ts';

const uuid=z.string().uuid().transform(v=>v.toLowerCase());
const purposeSchema=z.enum(['unified_enrollment','worker_services']);
const receipt=z.object({academyId:uuid,startId:uuid,workerId:uuid,outcome:boldSignSubmissionOutcomeSchema,purpose:purposeSchema.default('unified_enrollment')}).strict();
export async function assertSignatureResultRole(db:Connection){
 const result=await db.query<{safe:boolean}>(`SELECT NOT r.rolsuper AND NOT r.rolbypassrls AND NOT r.rolcreaterole AND NOT r.rolcreatedb AND NOT r.rolreplication AND left(r.rolname,3)<>'pg_' AND pg_has_role(current_user,'kavosh_signature_result_worker','member')
 AND NOT EXISTS(SELECT 1 FROM pg_roles b WHERE b.rolname<>current_user AND(left(b.rolname,3)='pg_' OR(left(b.rolname,7)='kavosh_' AND b.rolname<>'kavosh_signature_result_worker')) AND pg_has_role(current_user,b.oid,'member'))
 AND NOT has_schema_privilege(current_user,'identity','usage') AND NOT has_schema_privilege(current_user,'auth_private','usage') AND NOT has_schema_privilege(current_user,'public','create')
 AND NOT EXISTS(SELECT 1 FROM pg_namespace n WHERE n.nspname='platform_private' AND has_schema_privilege(current_user,n.oid,'usage'))
 AND NOT EXISTS(SELECT 1 FROM pg_database d WHERE d.datname=current_database() AND pg_has_role(current_user,d.datdba,'member'))
 AND NOT EXISTS(SELECT 1 FROM pg_namespace n WHERE n.nspname IN('public','identity','auth_private') AND pg_has_role(current_user,n.nspowner,'member'))
 AND NOT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN('public','identity','auth_private')
  AND(pg_has_role(current_user,c.relowner,'member') OR has_table_privilege(current_user,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN') OR has_any_column_privilege(current_user,c.oid,'SELECT,INSERT,UPDATE,REFERENCES')))
 AND NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN('public','identity','auth_private') AND p.prosecdef AND has_schema_privilege(current_user,n.oid,'USAGE') AND has_function_privilege(current_user,p.oid,'EXECUTE')
  AND p.oid NOT IN('public.record_signature_transport_receipt(uuid,uuid,uuid,text,uuid)'::regprocedure,'public.signature_transport_target_ready(uuid,uuid,text)'::regprocedure,'public.record_work_signature_transport_receipt(uuid,uuid,uuid,text,uuid)'::regprocedure,'public.work_signature_transport_target_ready(uuid,uuid,text)'::regprocedure))
 AND NOT EXISTS(SELECT 1 FROM pg_roles e WHERE(e.rolsuper OR e.rolbypassrls) AND pg_has_role(current_user,e.oid,'member')) safe FROM pg_roles r WHERE r.rolname=current_user`);
 if(!result.rows[0]?.safe)throw new Error('UNSAFE_SIGNATURE_RESULT_ROLE');
}
// Preflight before a provider attempt. This is not a guarantee against an
// in-flight DB outage/revocation;the durable start still forbids blind resend.
export async function probeSignatureResultSink(database:Database,target?:{academyId:string;startId:string;sourceFingerprint:string},purpose:z.infer<typeof purposeSchema>='unified_enrollment'){
 const prefix=purposeSchema.parse(purpose)==='worker_services'?'work_signature':'signature';
 const selected=target===undefined?undefined:z.object({academyId:uuid,startId:uuid,sourceFingerprint:z.string().regex(/^[a-f0-9]{64}$/)}).strict().parse(target);
 let c:Connection;try{c=await database.connect();}catch{throw new ApiError(503,'SIGNATURE_TRANSPORT_RECEIPT_UNAVAILABLE');}
 try{await assertSignatureResultRole(c);await assertSchemaReady(c);
  const ready=(await c.query<{ready:boolean}>(`SELECT
   has_table_privilege('kavosh_signature_result_policy','public.${prefix}_transport_receipts','SELECT') AND has_table_privilege('kavosh_signature_result_policy','public.${prefix}_transport_receipts','INSERT')
   AND has_table_privilege('kavosh_signature_result_policy','public.${prefix}_transport_conflicts','SELECT') AND has_table_privilege('kavosh_signature_result_policy','public.${prefix}_transport_conflicts','INSERT')
   AND has_table_privilege('kavosh_signature_result_policy','public.outbox_events','INSERT')
   AND NOT EXISTS(SELECT 1 FROM unnest(ARRAY['academy_id','id','original_copy_id','original_source_fingerprint']) col WHERE NOT has_column_privilege('kavosh_signature_result_policy','public.${prefix}_dispatch_starts',col,'SELECT'))
   AND NOT EXISTS(SELECT 1 FROM unnest(ARRAY['academy_id','start_id','state','document_id']) col WHERE NOT has_column_privilege('kavosh_signature_result_policy','public.${prefix}_dispatch_outcomes',col,'SELECT')) ready`)).rows[0]?.ready;
  if(!ready)throw new ApiError(503,'SIGNATURE_TRANSPORT_RECEIPT_UNAVAILABLE');
  if(selected&&!(await c.query<{ready:boolean}>(`SELECT public.${prefix}_transport_target_ready($1,$2,$3) ready`,[selected.academyId,selected.startId,selected.sourceFingerprint])).rows[0]?.ready)throw new ApiError(503,'SIGNATURE_TRANSPORT_RECEIPT_UNAVAILABLE');
 }finally{c.release();}
}
// Record only a completed transport observation,not a signing operation. No
// credentials,provider IO,background activation or requester-session dependency.
// Retrying this write is idempotent;it must NEVER trigger another provider POST.
export async function recordSignatureTransportReceipt(database:Database,raw:unknown){
 const parsed=receipt.safeParse(raw);if(!parsed.success)throw new ApiError(400,'INVALID_SIGNATURE_TRANSPORT_RECEIPT');const i=parsed.data;let c:Connection;
 try{c=await database.connect();}catch{throw new ApiError(503,'SIGNATURE_TRANSPORT_RECEIPT_UNAVAILABLE');}
 try{
  await assertSignatureResultRole(c);await assertSchemaReady(c);
  const prefix=i.purpose==='worker_services'?'work_signature':'signature';
  let status:string;try{status=(await c.query<{status:string}>(`SELECT public.record_${prefix}_transport_receipt($1,$2,$3,$4,$5) status`,[i.academyId,i.startId,i.workerId,i.outcome.state,i.outcome.state==='accepted_for_processing'?i.outcome.documentId:null])).rows[0]?.status;}
  catch{throw new ApiError(503,'SIGNATURE_TRANSPORT_RECEIPT_UNAVAILABLE');}
  if(!['recorded','recorded_conflict','duplicate','duplicate_conflict','conflict','unavailable'].includes(status))throw new ApiError(503,'SIGNATURE_TRANSPORT_RECEIPT_UNAVAILABLE');
  const conflict=['conflict','recorded_conflict','duplicate_conflict'].includes(status);
  return {status,recorded:status!=='unavailable',primary:!['conflict','unavailable'].includes(status),conflict,reconciliationRequired:conflict||status==='unavailable'||i.outcome.reconciliationRequired,providerVerified:false as const,admissionCleared:false as const};
 }finally{c.release();}
}
