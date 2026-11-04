import { ApiError } from './policy.ts';
import { parseMoney,taxAmounts,roundRatio,maximumMinorUnits } from './money.ts';

export type ExpenseLineInput={amount:string;pricing:'tax_exclusive'|'tax_inclusive'|'not_applicable';classification:'taxable'|'zero_rated'|'exempt'|'out_of_scope';ratePercent:string;recoverablePercent:string};
// A configured charged tax and a user's declared recoverable portion are
// different facts. This arithmetic never decides legal input-credit eligibility.
export function expenseBillAmounts(unitScale:number,input:ExpenseLineInput[]){
 if(!Number.isInteger(unitScale)||unitScale<0||unitScale>18||!Array.isArray(input)||input.length<1||input.length>50)throw new ApiError(400,'INVALID_EXPENSE_BILL');
 const lines=input.map(l=>{
  const amount=parseMoney(l.amount,unitScale),rate=parseMoney(l.ratePercent,4),recoverableRate=parseMoney(l.recoverablePercent,4);
  if(amount<=0n||rate<0n||rate>1000000n||recoverableRate<0n||recoverableRate>1000000n||!['taxable','zero_rated','exempt','out_of_scope'].includes(l.classification)||(l.classification==='taxable')!==(rate>0n)||(['exempt','out_of_scope'].includes(l.classification))!==(l.pricing==='not_applicable'))throw new ApiError(400,'INVALID_EXPENSE_TAX_TREATMENT');
  const {net,tax,gross}=taxAmounts(amount,rate,l.pricing),recoverable=roundRatio(tax*recoverableRate,1000000n,'half_away'),expense=net+tax-recoverable;
  return {net,tax,gross,recoverable,nonrecoverable:tax-recoverable,expense,rateMillionths:rate,recoverableMillionths:recoverableRate};
 });
 const totals={net:0n,tax:0n,gross:0n,recoverable:0n,nonrecoverable:0n,expense:0n};
 for(const l of lines)for(const key of Object.keys(totals) as (keyof typeof totals)[]){totals[key]+=l[key];if(totals[key]>maximumMinorUnits)throw new ApiError(400,'EXPENSE_BILL_TOO_LARGE');}
 return {lines,totals};
}
