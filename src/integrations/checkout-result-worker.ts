import { z } from 'zod';
import { ApiError } from '../core/policy.ts';
import { assertSchemaReady,type Connection,type Database } from '../core/database.ts';
import { stripeCheckoutInspection,stripeCheckoutFeeInspection,stripeCheckoutRefundInspection,stripeCheckoutRefundReturnInspection,stripeCheckoutDisputeInspection } from './stripe-checkout.ts';

const uuid=z.string().uuid().transform(v=>v.toLowerCase()),hash=z.string().regex(/^[a-f0-9]{64}$/),target=z.object({academyId:uuid,startId:uuid,requestSha256:hash}).strict();
const base=target.extend({workerId:uuid}),receipt=z.discriminatedUnion('state',[
 base.extend({state:z.enum(['not_attempted','rejected','outcome_unknown'])}).strict(),
 base.extend({state:z.literal('accepted'),sessionId:z.string().regex(/^cs_(test|live)_[A-Za-z0-9]{1,200}$/),checkoutUrl:z.string().max(8192).nullable()}).strict()
]);
const unavailable=()=>new ApiError(503,'CHECKOUT_TRANSPORT_RECEIPT_UNAVAILABLE');
export async function assertCheckoutResultRole(db:Connection){
 const r=await db.query<{safe:boolean}>(`SELECT NOT r.rolsuper AND NOT r.rolbypassrls AND NOT r.rolcreaterole AND NOT r.rolcreatedb AND NOT r.rolreplication
 AND pg_has_role(current_user,'kavosh_checkout_result_worker','member')
 AND NOT EXISTS(SELECT 1 FROM pg_roles b WHERE b.rolname<>current_user AND(left(b.rolname,3)='pg_' OR left(b.rolname,7)='kavosh_' AND b.rolname<>'kavosh_checkout_result_worker') AND pg_has_role(current_user,b.oid,'member'))
 AND NOT has_schema_privilege(current_user,'identity','usage') AND NOT has_schema_privilege(current_user,'auth_private','usage') AND NOT has_schema_privilege(current_user,'public','create')
 AND NOT EXISTS(SELECT 1 FROM pg_namespace n WHERE n.nspname='platform_private' AND has_schema_privilege(current_user,n.oid,'usage'))
 AND NOT EXISTS(SELECT 1 FROM pg_database d WHERE d.datname=current_database() AND pg_has_role(current_user,d.datdba,'member'))
 AND NOT EXISTS(SELECT 1 FROM pg_namespace n WHERE n.nspname IN('public','identity','auth_private') AND pg_has_role(current_user,n.nspowner,'member'))
 AND NOT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN('public','identity','auth_private') AND c.relkind IN('r','p','v','m','f') AND(pg_has_role(current_user,c.relowner,'member') OR has_table_privilege(current_user,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN') OR has_any_column_privilege(current_user,c.oid,'SELECT,INSERT,UPDATE,REFERENCES')))
 AND NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN('public','identity','auth_private') AND p.prosecdef AND has_schema_privilege(current_user,n.oid,'USAGE') AND has_function_privilege(current_user,p.oid,'EXECUTE') AND p.oid NOT IN('public.checkout_transport_target_ready(uuid,uuid,text)'::regprocedure,'public.record_checkout_transport_receipt(uuid,uuid,uuid,text,text,text,text)'::regprocedure,'public.record_checkout_provider_inspection(uuid,uuid,uuid,uuid,text,jsonb)'::regprocedure,'public.record_checkout_fee_inspection(uuid,uuid,uuid,uuid,uuid,text,jsonb)'::regprocedure,'public.record_checkout_refund_inspection(uuid,uuid,uuid,uuid,uuid,text,jsonb)'::regprocedure) AND p.oid IS DISTINCT FROM to_regprocedure('public.record_checkout_refund_return_inspection(uuid,uuid,uuid,uuid,uuid,text,jsonb)') AND p.oid IS DISTINCT FROM to_regprocedure('public.record_checkout_dispute_inspection(uuid,uuid,uuid,uuid,uuid,text,jsonb)'))
 AND NOT EXISTS(SELECT 1 FROM pg_roles e WHERE(e.rolsuper OR e.rolbypassrls OR e.rolcreaterole OR e.rolcreatedb OR e.rolreplication) AND pg_has_role(current_user,e.oid,'member')) safe FROM pg_roles r WHERE r.rolname=current_user`);
 if(!r.rows[0]?.safe)throw new Error('UNSAFE_CHECKOUT_RESULT_ROLE');
}
export async function probeCheckoutResultSink(database:Database,raw?:unknown){
 const selected=raw===undefined?null:target.parse(raw);let c:Connection|undefined;
 try{c=await database.connect();await assertCheckoutResultRole(c);await assertSchemaReady(c);
  const ready=(await c.query<{ready:boolean}>(`SELECT has_table_privilege('kavosh_checkout_result_policy','public.checkout_transport_receipts','SELECT') AND has_table_privilege('kavosh_checkout_result_policy','public.checkout_transport_receipts','INSERT') AND has_table_privilege('kavosh_checkout_result_policy','public.checkout_transport_conflicts','SELECT') AND has_table_privilege('kavosh_checkout_result_policy','public.checkout_transport_conflicts','INSERT') AND has_table_privilege('kavosh_checkout_result_policy','public.outbox_events','INSERT') ready`)).rows[0]?.ready;
  if(!ready||selected&&!(await c.query<{ready:boolean}>('SELECT public.checkout_transport_target_ready($1,$2,$3) ready',[selected.academyId,selected.startId,selected.requestSha256])).rows[0]?.ready)throw unavailable();
 }catch{throw unavailable();}finally{c?.release();}
}
// Retry-safe WRITE only. This never charges,retries dispatch,posts money or
// treats a service observation as independent provider reconciliation.
export async function recordCheckoutTransportReceipt(database:Database,raw:unknown){
 const parsed=receipt.safeParse(raw);if(!parsed.success)throw new ApiError(400,'INVALID_CHECKOUT_TRANSPORT_RECEIPT');const i=parsed.data;let c:Connection|undefined;
 try{c=await database.connect();await assertCheckoutResultRole(c);await assertSchemaReady(c);
  const status=(await c.query<{status:string}>('SELECT public.record_checkout_transport_receipt($1,$2,$3,$4,$5,$6,$7) status',[i.academyId,i.startId,i.workerId,i.requestSha256,i.state,i.state==='accepted'?i.sessionId:null,i.state==='accepted'?i.checkoutUrl:null])).rows[0]?.status;
  if(!['recorded','recorded_conflict','duplicate','duplicate_conflict','conflict','unavailable'].includes(status))throw unavailable();
  return {status,recorded:status!=='unavailable',conflict:status.includes('conflict'),providerVerified:false as const,paymentVerified:false as const,ledgerAdjusted:false as const,reconciliationRequired:true as const,automaticRetryAllowed:false as const};
 }catch{throw unavailable();}finally{c?.release();}
}
const providerObservation=target.extend({id:uuid,workerId:uuid,inspection:stripeCheckoutInspection}).strict();
export async function recordCheckoutProviderInspection(database:Database,raw:unknown){
 const parsed=providerObservation.safeParse(raw);if(!parsed.success)throw new ApiError(400,'INVALID_CHECKOUT_PROVIDER_INSPECTION');const i=parsed.data;let c:Connection|undefined;
 try{c=await database.connect();await assertCheckoutResultRole(c);await assertSchemaReady(c);
  const status=(await c.query<{status:string}>('SELECT public.record_checkout_provider_inspection($1,$2,$3,$4,$5,$6::jsonb) status',[i.academyId,i.id,i.startId,i.workerId,i.requestSha256,JSON.stringify(i.inspection)])).rows[0]?.status;
  if(!['recorded','recorded_conflict','duplicate','duplicate_conflict','unavailable'].includes(status))throw new Error();
  return {id:i.id,status,recorded:status!=='unavailable',objectConflict:status.includes('conflict'),providerReportedCaptured:i.inspection.state==='captured',liveStateCurrent:false as const,bankSettled:false as const,ledgerAdjusted:false as const,automaticRetryAllowed:false as const};
 }catch{throw new ApiError(503,'CHECKOUT_PROVIDER_INSPECTION_UNAVAILABLE');}finally{c?.release();}
}
const feeObservation=target.extend({id:uuid,principalInspectionId:uuid,workerId:uuid,fees:stripeCheckoutFeeInspection}).strict();
const refundObservation=target.extend({id:uuid,principalInspectionId:uuid,workerId:uuid,page:stripeCheckoutRefundInspection}).strict();
const refundReturnObservation=target.extend({id:uuid,refundInspectionId:uuid,workerId:uuid,evidence:stripeCheckoutRefundReturnInspection}).strict();
const disputeObservation=target.extend({id:uuid,principalInspectionId:uuid,workerId:uuid,page:stripeCheckoutDisputeInspection}).strict();
export async function recordCheckoutDisputeInspection(database:Database,raw:unknown){
 const parsed=disputeObservation.safeParse(raw);if(!parsed.success)throw new ApiError(400,'INVALID_CHECKOUT_DISPUTE_INSPECTION');const i=parsed.data;let c:Connection|undefined;
 try{c=await database.connect();await assertCheckoutResultRole(c);await assertSchemaReady(c);const status=(await c.query<{status:string}>('SELECT public.record_checkout_dispute_inspection($1,$2,$3,$4,$5,$6,$7::jsonb) status',[i.academyId,i.id,i.startId,i.principalInspectionId,i.workerId,i.requestSha256,JSON.stringify(i.page)])).rows[0]?.status;if(!['recorded','recorded_conflict','duplicate','duplicate_conflict','unavailable'].includes(status))throw new Error();return {id:i.id,status,recorded:status!=='unavailable',objectConflict:status.includes('conflict'),creditRestored:false as const,fundsReturnVerified:false as const,bankSettled:false as const,ledgerAdjusted:false as const};
 }catch{throw new ApiError(503,'CHECKOUT_DISPUTE_INSPECTION_UNAVAILABLE');}finally{c?.release();}
}
export async function recordCheckoutRefundReturnInspection(database:Database,raw:unknown){
 const parsed=refundReturnObservation.safeParse(raw);if(!parsed.success)throw new ApiError(400,'INVALID_CHECKOUT_REFUND_RETURN_INSPECTION');const i=parsed.data;let c:Connection|undefined;
 try{c=await database.connect();await assertCheckoutResultRole(c);await assertSchemaReady(c);const status=(await c.query<{status:string}>('SELECT public.record_checkout_refund_return_inspection($1,$2,$3,$4,$5,$6,$7::jsonb) status',[i.academyId,i.id,i.startId,i.refundInspectionId,i.workerId,i.requestSha256,JSON.stringify(i.evidence)])).rows[0]?.status;if(!['recorded','recorded_conflict','duplicate','duplicate_conflict','unavailable'].includes(status))throw new Error();return {id:i.id,status,recorded:status!=='unavailable',objectConflict:status.includes('conflict'),creditRestored:false as const,bankSettled:false as const,ledgerAdjusted:false as const};
 }catch{throw new ApiError(503,'CHECKOUT_REFUND_RETURN_INSPECTION_UNAVAILABLE');}finally{c?.release();}
}
export async function recordCheckoutRefundInspection(database:Database,raw:unknown){
 const parsed=refundObservation.safeParse(raw);if(!parsed.success)throw new ApiError(400,'INVALID_CHECKOUT_REFUND_INSPECTION');const i=parsed.data;let c:Connection|undefined;
 try{c=await database.connect();await assertCheckoutResultRole(c);await assertSchemaReady(c);
  const status=(await c.query<{status:string}>('SELECT public.record_checkout_refund_inspection($1,$2,$3,$4,$5,$6,$7::jsonb) status',[i.academyId,i.id,i.startId,i.principalInspectionId,i.workerId,i.requestSha256,JSON.stringify(i.page)])).rows[0]?.status;
  if(!['recorded','recorded_conflict','duplicate','duplicate_conflict','unavailable'].includes(status))throw new Error();
  return {id:i.id,status,recorded:status!=='unavailable',objectConflict:status.includes('conflict'),refundExecuted:false as const,refundAccountingPosted:false as const,bankSettled:false as const,ledgerAdjusted:false as const};
 }catch{throw new ApiError(503,'CHECKOUT_REFUND_INSPECTION_UNAVAILABLE');}finally{c?.release();}
}
export async function recordCheckoutFeeInspection(database:Database,raw:unknown){
 const parsed=feeObservation.safeParse(raw);if(!parsed.success)throw new ApiError(400,'INVALID_CHECKOUT_FEE_INSPECTION');const i=parsed.data;let c:Connection|undefined;
 try{c=await database.connect();await assertCheckoutResultRole(c);await assertSchemaReady(c);
  const status=(await c.query<{status:string}>('SELECT public.record_checkout_fee_inspection($1,$2,$3,$4,$5,$6,$7::jsonb) status',[i.academyId,i.id,i.startId,i.principalInspectionId,i.workerId,i.requestSha256,JSON.stringify(i.fees)])).rows[0]?.status;
  if(!['recorded','recorded_conflict','duplicate','duplicate_conflict','unavailable'].includes(status))throw new Error();
  return {id:i.id,status,recorded:status!=='unavailable',objectConflict:status.includes('conflict'),feePosted:false as const,taxVerified:false as const,bankSettled:false as const,ledgerAdjusted:false as const};
 }catch{throw new ApiError(503,'CHECKOUT_FEE_INSPECTION_UNAVAILABLE');}finally{c?.release();}
}
