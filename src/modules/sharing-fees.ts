import { z } from 'zod';
import type { ApiContext,Reply } from '../core/api.ts';
import { ApiError,requireScope } from '../core/policy.ts';
import { permissionScope } from '../core/approvals.ts';
import { readMinorUnits,formatMoneyTotal } from '../core/money.ts';
import { lockFinanceBook } from '../core/finance-lock.ts';
import { lockAcademyTopology } from './academy.ts';
import { accountingDate } from './finance-periods.ts';
import { invoiceRow } from './invoices.ts';
import { financialRecordAuthority } from './tuition.ts';

export const sharingFeeReference=z.object({invoiceId:z.string().uuid().transform(v=>v.toLowerCase()),policyVersion:z.number().int().positive().max(2147483647),asOf:accountingDate}).strict();
type Reference=z.infer<typeof sharingFeeReference>;
type Source={entitlement:{sharingPlanId:string;currentPolicyVersion:number;policyActive:boolean;currencyId:string;currencyCode:string;unitScale:number};payee:{payeeVersion:number};alreadyBilledNetMinor:string;availableNetMinor:string;sourceStamp:string};
const capacityQuery=sharingFeeReference.omit({invoiceId:true}).extend({policyVersion:z.coerce.number().int().positive().max(2147483647),payeeId:z.string().uuid().transform(v=>v.toLowerCase()),postedOn:accountingDate});
export async function sharingFeeAuthority(ctx:ApiContext,invoiceId:string){
 const i=await invoiceRow(ctx,invoiceId);financialRecordAuthority(ctx,i,'share-rules.view');financialRecordAuthority(ctx,i,'receipts.view');return i;
}
export async function sharingFeeSource(ctx:ApiContext,ref:Reference,fee:{payeeId:string;payeeVersion:number;currencyId:string;unitScale:number;netMinor:string;postedOn:string;contexts:{hub_id:string|null;class_id:string|null;student_id:string|null}[]},lock=false){
 let i=await sharingFeeAuthority(ctx,ref.invoiceId);
 if(ref.asOf>fee.postedOn)throw new ApiError(400,'SHARING_FEE_DATE_INVALID');
 if(lock){await lockFinanceBook(ctx);await lockAcademyTopology(ctx);await ctx.db.query('SELECT id FROM public.tuition_plans WHERE id=$1 FOR UPDATE',[i.plan_id]);await ctx.db.query('SELECT id FROM public.tuition_invoices WHERE id=$1 FOR UPDATE',[i.id]);i=await sharingFeeAuthority(ctx,i.id);}
 if(fee.contexts.some(l=>l.hub_id!==i.hub_id||l.class_id!==i.class_id||l.student_id!==i.student_id))throw new ApiError(400,'SHARING_FEE_CONTEXT_MISMATCH');
 const s=(await ctx.db.query<{source:Source|null}>('SELECT public.sharing_fee_capacity($1,$2,$3,$4,$5) source',[i.id,ref.policyVersion,fee.payeeId,ref.asOf,fee.postedOn])).rows[0].source;
 if(!s)throw new ApiError(409,'SHARING_FEE_SOURCE_UNAVAILABLE');
 if(s.entitlement.currentPolicyVersion!==ref.policyVersion||!s.entitlement.policyActive||s.payee.payeeVersion!==fee.payeeVersion||s.entitlement.currencyId!==fee.currencyId||s.entitlement.unitScale!==fee.unitScale)throw new ApiError(409,'SHARING_FEE_SOURCE_CHANGED');
 const net=readMinorUnits(fee.netMinor),available=BigInt(s.availableNetMinor);if(net<=0n||net>available)throw new ApiError(409,'SHARING_FEE_EXCEEDS_RELEASED_CAPACITY');return s;
}
export async function sharingFeeLink(ctx:ApiContext,billId:string){
 // Only an explicitly linked proposal can have a fee origin. Ordinary legacy
 // bills do not gain an origin or depend on a later sharing schema/table.
 if(!(await ctx.db.query("SELECT 1 FROM public.expense_bills b JOIN public.approval_requests p ON p.academy_id=b.academy_id AND p.id=b.approval_id WHERE b.id=$1 AND p.payload ? 'sharing'",[billId])).rows.length)return null;
 const link=(await ctx.db.query<{invoice_id:string;policy_version:number;as_of:string;source_snapshot:Source}>('SELECT invoice_id,policy_version,as_of::text,source_snapshot FROM public.sharing_fee_bills WHERE bill_id=$1',[billId])).rows[0];
 if(link)await sharingFeeAuthority(ctx,link.invoice_id);return link??null;
}
export async function sharingFeeDetail(ctx:ApiContext,billId:string){
 try{const link=await sharingFeeLink(ctx,billId);return link?{invoiceId:link.invoice_id,policyVersion:link.policy_version,asOf:link.as_of,sourceStamp:link.source_snapshot.sourceStamp,amountsPinnedAtApproval:true,currentEntitlementMayDiffer:true,feeTaxInferred:false}:null;}
 catch(error){if(error instanceof ApiError&&[403,404].includes(error.status))return null;throw error;}
}
export async function sharingFeeCapacity(ctx:ApiContext):Promise<Reply|null>{
 const match=/^finance\/invoices\/([^/]+)\/sharing-fee-capacity$/.exec(ctx.path);if(!match)return null;
 if(ctx.request.method!=='GET')throw new ApiError(405,'METHOD_NOT_ALLOWED');
 const id=z.string().uuid().parse(match[1]),q=capacityQuery.parse(Object.fromEntries(new URL(ctx.request.url).searchParams)),i=await sharingFeeAuthority(ctx,id);requireScope(permissionScope(ctx,'expenses.view'),i.hub_id);
 if(q.asOf>q.postedOn)throw new ApiError(400,'SHARING_FEE_DATE_INVALID');
 const source=(await ctx.db.query<{source:Source|null}>('SELECT public.sharing_fee_capacity($1,$2,$3,$4,$5) source',[i.id,q.policyVersion,q.payeeId,q.asOf,q.postedOn])).rows[0].source;
 if(!source)throw new ApiError(404,'SHARING_FEE_SOURCE_UNAVAILABLE');const money=(v:string)=>formatMoneyTotal(BigInt(v),source.entitlement.unitScale);
 return {status:200,body:{data:{invoiceId:i.id,payeeId:q.payeeId,policyVersion:q.policyVersion,currentPolicyVersion:source.entitlement.currentPolicyVersion,policyActive:source.entitlement.policyActive,asOf:q.asOf,postedOn:q.postedOn,currencyCode:source.entitlement.currencyCode,alreadyBilledNet:money(source.alreadyBilledNetMinor),availableNet:money(source.availableNetMinor),sourceStamp:source.sourceStamp,feeTaxInferred:false,accountingPosted:false,moneyMovementPerformed:false}}};
}
export const sharingFeeCapacityContract=[{path:'/api/v1/finance/invoices/{id}/sharing-fee-capacity',method:'get',summary:'Read dated net fee capacity under original invoice/share/receipt AND expense permissions. Reserves all previously linked bills across policy editions,including future bills;future voids do not free earlier capacity. Negative capacity requires source review,not automatic liability deletion. No fee tax inference,posting or payment.',querySchema:capacityQuery}] as const;
