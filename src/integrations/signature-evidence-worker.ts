import { z } from 'zod';
import { ApiError } from '../core/policy.ts';
import { assertSchemaReady,type Connection,type Database } from '../core/database.ts';
import { signatureEvidenceInspectionTaskSchema,signatureEvidenceInspectionResultSchema,inspectSignatureEvidence } from './signature-evidence-inspection.ts';
import type { R2DownloadConnections } from './r2-config.ts';
import type { ClamdConfiguration } from './clamav.ts';
import type { ClamdDatabasePolicy } from './clamav-database.ts';
import type { S3ClientConfig } from '@aws-sdk/client-s3';

const uuid=z.string().uuid().transform(v=>v.toLowerCase()),selection=z.object({academyId:uuid,evidenceId:uuid,kind:z.enum(['document','audit'])}).strict();
export async function assertSignatureEvidenceRole(c:Connection){
 const r=await c.query<{safe:boolean}>(`SELECT NOT r.rolsuper AND NOT r.rolbypassrls AND NOT r.rolcreaterole AND NOT r.rolcreatedb AND NOT r.rolreplication AND left(r.rolname,3)<>'pg_' AND pg_has_role(current_user,'kavosh_signature_evidence_worker','member')
 AND NOT EXISTS(SELECT 1 FROM pg_roles b WHERE b.rolname<>current_user AND(left(b.rolname,3)='pg_' OR(left(b.rolname,7)='kavosh_' AND b.rolname<>'kavosh_signature_evidence_worker')) AND pg_has_role(current_user,b.oid,'member'))
 AND NOT has_schema_privilege(current_user,'identity','usage') AND NOT has_schema_privilege(current_user,'auth_private','usage') AND NOT has_schema_privilege(current_user,'public','create')
 AND NOT EXISTS(SELECT 1 FROM pg_namespace n WHERE n.nspname='platform_private' AND has_schema_privilege(current_user,n.oid,'usage'))
 AND NOT EXISTS(SELECT 1 FROM pg_database d WHERE d.datname=current_database() AND pg_has_role(current_user,d.datdba,'member'))
 AND NOT EXISTS(SELECT 1 FROM pg_namespace n WHERE n.nspname IN('public','identity','auth_private') AND pg_has_role(current_user,n.nspowner,'member'))
 AND NOT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN('public','identity','auth_private') AND(pg_has_role(current_user,c.relowner,'member') OR has_table_privilege(current_user,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN') OR has_any_column_privilege(current_user,c.oid,'SELECT,INSERT,UPDATE,REFERENCES')))
 AND NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN('public','identity','auth_private') AND p.prosecdef AND has_schema_privilege(current_user,n.oid,'USAGE') AND has_function_privilege(current_user,p.oid,'EXECUTE')
 AND p.oid NOT IN('public.signature_evidence_inspection_source(uuid,uuid,text)'::regprocedure,'public.record_signature_evidence_inspection(uuid,uuid,uuid,text,text,jsonb)'::regprocedure,'public.signature_evidence_inspection_recorded(uuid,uuid,uuid,text)'::regprocedure))
 AND NOT EXISTS(SELECT 1 FROM pg_roles e WHERE(e.rolsuper OR e.rolbypassrls) AND pg_has_role(current_user,e.oid,'member')) safe FROM pg_roles r WHERE r.rolname=current_user`);
 if(!r.rows[0]?.safe)throw Error('UNSAFE_SIGNATURE_EVIDENCE_ROLE');
}
async function held<T>(database:Database,run:(c:Connection)=>Promise<T>){let c:Connection;try{c=await database.connect();}catch{throw new ApiError(503,'SIGNATURE_EVIDENCE_DATABASE_UNAVAILABLE');}try{await assertSignatureEvidenceRole(c);await assertSchemaReady(c);return await run(c);}catch{throw new ApiError(503,'SIGNATURE_EVIDENCE_DATABASE_UNAVAILABLE');}finally{c.release();}}
export async function loadSignatureEvidenceInspectionTask(database:Database,raw:unknown){
 const parsed=selection.safeParse(raw);if(!parsed.success)throw new ApiError(400,'INVALID_SIGNATURE_EVIDENCE_TARGET');const i=parsed.data;
 return held(database,async c=>{const source=(await c.query<{source:unknown}>('SELECT public.signature_evidence_inspection_source($1,$2,$3) source',[i.academyId,i.evidenceId,i.kind])).rows[0]?.source;return source===null?null:signatureEvidenceInspectionTaskSchema.parse(source);});
}
const recording=selection.extend({operationId:uuid,sourceFingerprint:z.string().regex(/^[a-f0-9]{64}$/),result:signatureEvidenceInspectionResultSchema}).strict();
const operation=selection.extend({operationId:uuid}).strict();
async function recorded(database:Database,i:z.infer<typeof operation>){return held(database,async c=>{const value=(await c.query<{recorded:boolean}>('SELECT public.signature_evidence_inspection_recorded($1,$2,$3,$4) recorded',[i.academyId,i.operationId,i.evidenceId,i.kind])).rows[0]?.recorded;if(typeof value!=='boolean')throw Error();return value;});}
export async function recordSignatureEvidenceInspection(database:Database,raw:unknown){
 const parsed=recording.safeParse(raw);if(!parsed.success)throw new ApiError(400,'INVALID_SIGNATURE_EVIDENCE_RESULT');const i=parsed.data;
 return held(database,async c=>{const inserted=(await c.query<{inserted:boolean}>('SELECT public.record_signature_evidence_inspection($1,$2,$3,$4,$5,$6::jsonb) inserted',[i.academyId,i.operationId,i.evidenceId,i.kind,i.sourceFingerprint,JSON.stringify(i.result)])).rows[0]?.inserted;if(typeof inserted!=='boolean')throw Error();return {inserted,admissionCleared:false as const,safeToServe:false as const};});
}
// Explicit operator-only work. This role has no provider,identity,web or normal
// upload authority. Release DB connections BEFORE private storage/scan/parser IO.
export async function processSignatureEvidenceInspection(raw:unknown,services:{database:Database;readers:R2DownloadConnections;scanner:ClamdConfiguration;databasePolicy:ClamdDatabasePolicy;pdfService:{socketPath:string};storageHandler?:S3ClientConfig['requestHandler']},options:{enabled?:boolean;signal?:AbortSignal}={}){
 const parsed=operation.safeParse(raw);if(!parsed.success)throw new ApiError(400,'INVALID_SIGNATURE_EVIDENCE_TARGET');const i=parsed.data;
 if(options.enabled!==true||options.signal?.aborted)return {recorded:false,admissionCleared:false,safeToServe:false};
 const existing={recorded:true,inserted:false,alreadyRecorded:true,freshObservationCreated:false,admissionCleared:false,safeToServe:false,cryptographicValidityVerified:false};
 if(await recorded(services.database,i))return existing;
 const target={academyId:i.academyId,evidenceId:i.evidenceId,kind:i.kind},task=await loadSignatureEvidenceInspectionTask(services.database,target);if(!task)return {recorded:false,admissionCleared:false,safeToServe:false};
 let configuration;try{configuration=services.readers(task.academyId,task.storageTargetId);}catch{throw new ApiError(503,'SIGNATURE_EVIDENCE_NOT_CONFIGURED');}if(!configuration)throw new ApiError(503,'SIGNATURE_EVIDENCE_NOT_CONFIGURED');
 const result=await inspectSignatureEvidence(configuration,task,services.scanner,services.databasePolicy,services.pdfService,{signal:options.signal},services.storageHandler);
 let receipt;try{receipt=await recordSignatureEvidenceInspection(services.database,{...target,operationId:i.operationId,sourceFingerprint:task.sourceFingerprint,result});}catch(error){if(await recorded(services.database,i))return existing;throw error;}
 return {recorded:true,inserted:receipt.inserted,outcome:result.outcome,admissionCleared:false,safeToServe:false,cryptographicValidityVerified:false};
}
