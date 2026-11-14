import type { ApiContext } from './api.ts';
import { ApiError } from './policy.ts';
import { readMinorUnits,formatMoney } from './money.ts';

export async function expenseBalance(ctx:ApiContext,billId:string,through:string|null=null){
 // Legacy migration fixtures have no offset columns. This once-per-request
 // probe also reads the settlement relation,holding its ordinary read lock so
 // a concurrent schema upgrade cannot switch a legacy request mid-flight.
 if(ctx.expenseSettlementSnapshot===undefined)ctx.expenseSettlementSnapshot=(await ctx.db.query<{available:boolean}>("SELECT to_regprocedure('public.expense_bill_settlement_snapshot(uuid,date)') IS NOT NULL available,EXISTS(SELECT 1 FROM public.expense_payments LIMIT 1) relation_probe")).rows[0].available;
 const source=ctx.expenseSettlementSnapshot?'expense_bill_settlement_snapshot':'expense_bill_balance',part=ctx.expenseSettlementSnapshot?'offset_settled::text':"'0'::text";
 const r=(await ctx.db.query<{gross:string;voided:string;paid:string;balance:string;activity:string;offset:string}>(`SELECT gross::text,voided::text,paid::text,balance::text,activity::text,${part} AS offset FROM public.${source}($1,$2)`,[billId,through])).rows[0];if(!r)throw new ApiError(404,'NOT_FOUND');return {gross:readMinorUnits(r.gross),voided:readMinorUnits(r.voided),paid:readMinorUnits(r.paid),balance:readMinorUnits(r.balance),activity:readMinorUnits(r.activity),offset:readMinorUnits(r.offset)};
}
export function expenseBalanceOutput(b:Awaited<ReturnType<typeof expenseBalance>>,scale:number,through:string|null){
 return {billed:formatMoney(b.gross,scale),voided:formatMoney(b.voided,scale),paid:formatMoney(b.paid,scale),offsetSettled:formatMoney(b.offset,scale),cashBankCardSettled:formatMoney(b.paid-b.offset,scale),balance:formatMoney(b.balance,scale),settlementBasis:'recorded_cash_bank_card_and_collector_offsets',recordedActivityVersion:b.activity.toString(),paymentStatus:b.balance<0n?'supplier_credit':b.voided>0n?'voided':b.gross===0n?'not_posted_yet':b.balance===0n?'paid':b.paid>0n?'partially_paid':'unpaid',through,includesFutureDatedEntries:through===null,source:'retained_posting_events',bankBalanceVerified:false,moneyMovementPerformed:false};
}
