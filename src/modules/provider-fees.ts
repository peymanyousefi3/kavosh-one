import { z } from 'zod';
import type { ApiContext } from '../core/api.ts';
import { ApiError } from '../core/policy.ts';
import { lockFinanceBook } from '../core/finance-lock.ts';
import { lockAcademyTopology } from './academy.ts';
import { permittedCheckoutRequest } from './payment-checkouts.ts';

export const providerFeeReference=z.object({inspectionId:z.string().uuid().transform(v=>v.toLowerCase())}).strict();
type Source={inspectionId:string;requestId:string;invoiceId:string;accountId:string;livemode:boolean;balanceTransactionId:string;chargeId:string;currencyCode:string;providerUnitScale:number;feeMinor:string;hubId:string;classId:string;studentId:string;sourceStamp:string};
export async function providerFeeAuthority(ctx:ApiContext,id:string,lock=false){
 const r=(await ctx.db.query<{request_id:string;account_id:string}>(`SELECT a.request_id,a.draft->>'accountId' account_id FROM public.checkout_fee_inspections f JOIN public.payment_checkout_dispatch_starts s ON s.academy_id=f.academy_id AND s.id=f.start_id JOIN public.payment_checkout_attempts a ON a.academy_id=s.academy_id AND a.id=s.attempt_id WHERE f.id=$1`,[id])).rows[0];if(!r)throw new ApiError(404,'NOT_FOUND');
 await permittedCheckoutRequest(ctx,r.request_id);
 if(lock){await lockFinanceBook(ctx);await lockAcademyTopology(ctx);await ctx.db.query("SELECT pg_advisory_xact_lock(hashtextextended($1::text||':checkout-provider:'||$2,0))",[ctx.credential.academy_id,r.account_id]);}
 return r;
}
export async function providerFeeSource(ctx:ApiContext,ref:z.infer<typeof providerFeeReference>,bill:{currencyCode:string;unitScale:number;grossMinor:string;postedOn:string;contexts:{hub_id:string|null;class_id:string|null;student_id:string|null}[]},lock=false){
 await providerFeeAuthority(ctx,ref.inspectionId,lock);const s=(await ctx.db.query<{source:Source|null}>('SELECT public.provider_fee_source($1,$2) source',[ref.inspectionId,bill.postedOn])).rows[0].source;
 if(!s)throw new ApiError(409,'PROVIDER_FEE_SOURCE_UNAVAILABLE');
 if(s.currencyCode!==bill.currencyCode||BigInt(s.feeMinor)*10n**BigInt(bill.unitScale)!==BigInt(bill.grossMinor)*10n**BigInt(s.providerUnitScale))throw new ApiError(409,'PROVIDER_FEE_AMOUNT_OR_CURRENCY_MISMATCH');
 if(bill.contexts.some(l=>l.hub_id!==s.hubId||l.class_id!==s.classId||l.student_id!==s.studentId))throw new ApiError(400,'PROVIDER_FEE_CONTEXT_MISMATCH');return s;
}
export async function providerFeeLink(ctx:ApiContext,billId:string,lock=false){
 // Preserve actual older-schema expense fixtures: an ordinary bill has no
 // dependency on provider tables added after it was recorded.
 if(!(await ctx.db.query("SELECT 1 FROM public.expense_bills b JOIN public.approval_requests p ON p.academy_id=b.academy_id AND p.id=b.approval_id WHERE b.id=$1 AND p.payload ? 'providerFee'",[billId])).rows.length)return null;
 const link=(await ctx.db.query<{inspection_id:string;source_snapshot:Source}>('SELECT inspection_id,source_snapshot FROM public.provider_fee_bills WHERE bill_id=$1',[billId])).rows[0];if(link)await providerFeeAuthority(ctx,link.inspection_id,lock);return link??null;
}
export async function providerFeeDetail(ctx:ApiContext,billId:string){
 try{const link=await providerFeeLink(ctx,billId);return link?{inspectionId:link.inspection_id,balanceTransactionId:link.source_snapshot.balanceTransactionId,sourceStamp:link.source_snapshot.sourceStamp,providerTaxVerified:false,providerFundsSettled:false}:null;}
 catch(error){if(error instanceof ApiError&&[403,404].includes(error.status))return null;throw error;}
}
