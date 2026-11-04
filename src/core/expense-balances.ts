import type { ApiContext } from './api.ts';
import { ApiError } from './policy.ts';
import { readMinorUnits,formatMoney } from './money.ts';

export async function expenseBalance(ctx:ApiContext,billId:string,through:string|null=null){
 const r=(await ctx.db.query<{gross:string;voided:string;paid:string;balance:string;activity:string}>('SELECT gross::text,voided::text,paid::text,balance::text,activity::text FROM public.expense_bill_balance($1,$2)',[billId,through])).rows[0];if(!r)throw new ApiError(404,'NOT_FOUND');return {gross:readMinorUnits(r.gross),voided:readMinorUnits(r.voided),paid:readMinorUnits(r.paid),balance:readMinorUnits(r.balance),activity:readMinorUnits(r.activity)};
}
export function expenseBalanceOutput(b:Awaited<ReturnType<typeof expenseBalance>>,scale:number,through:string|null){
 return {billed:formatMoney(b.gross,scale),voided:formatMoney(b.voided,scale),paid:formatMoney(b.paid,scale),balance:formatMoney(b.balance,scale),recordedActivityVersion:b.activity.toString(),paymentStatus:b.balance<0n?'supplier_credit':b.voided>0n?'voided':b.gross===0n?'not_posted_yet':b.balance===0n?'paid':b.paid>0n?'partially_paid':'unpaid',through,includesFutureDatedEntries:through===null,source:'retained_posting_events',bankBalanceVerified:false,moneyMovementPerformed:false};
}
