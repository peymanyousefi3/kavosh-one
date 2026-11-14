import { z } from 'zod';
import { ApiError } from '../core/policy.ts';
import { submitBoldSignWireRequest,type BoldSignConnection } from './boldsign.ts';
import { buildBoldSignSendRequest,buildBoldSignWorkSendRequest } from './boldsign-send-request.ts';

const digest=z.string().regex(/^[a-f0-9]{64}$/);
const reservationSchema=z.object({attemptId:z.string().uuid().transform(v=>v.toLowerCase()),requestSha256:digest,requestBytes:z.number().int().min(1).max(16_777_216),documentSha256:digest}).strict();
const inputSchema=z.discriminatedUnion('purpose',[
 z.object({purpose:z.literal('unified_enrollment'),draft:z.unknown()}).strict(),
 z.object({purpose:z.literal('worker_services'),draft:z.unknown()}).strict()
]);

// Private integration component only; no mounted route, daemon, credentials or
// environment auto-enable. The caller MUST obtain the reservation from durable
// authorized state and claim it ONCE across processes/restarts before dispatch.
// Local one-use protects reentry only, NOT crash-safe idempotency or file safety.
// Never rebuild/retry an ambiguous submission; reconcile provider evidence.
export function prepareBoldSignDispatch(config:BoldSignConnection,raw:unknown,inputBytes:Uint8Array,reserved:unknown,send:typeof fetch=fetch) {
 const parsed=inputSchema.safeParse(raw),reservation=reservationSchema.safeParse(reserved);
 if(!parsed.success||!reservation.success)throw new ApiError(400,'INVALID_BOLDSIGN_DISPATCH');
 const selected=parsed.data,manifest=reservation.data;
 const prepared=selected.purpose==='worker_services'?buildBoldSignWorkSendRequest(selected.draft,inputBytes):buildBoldSignSendRequest(selected.draft,inputBytes);
 if(prepared.receipt.requestSha256!==manifest.requestSha256||prepared.receipt.requestBytes!==manifest.requestBytes||prepared.receipt.documentSha256!==manifest.documentSha256)throw new ApiError(409,'BOLDSIGN_RESERVED_MANIFEST_MISMATCH');
 // Copy configuration now, just as the builder copies mutable PDF input. Neither
 // caller mutation nor later database reads can substitute the reviewed bytes.
 const connection=Object.freeze({...config});let consumed=false;
 return {receipt:{...prepared.receipt,attemptId:manifest.attemptId},async dispatch(signal?:AbortSignal){
  if(consumed)throw new ApiError(409,'BOLDSIGN_DISPATCH_ALREADY_USED');consumed=true;
  return submitBoldSignWireRequest(connection,prepared.body,send,signal);
 }};
}
