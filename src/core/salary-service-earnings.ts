import { Temporal } from '@js-temporal/polyfill';
import { ApiError } from './policy.ts';
import { formatMoneyTotal,parseMoney,roundRatio } from './money.ts';
import { payCalendarDays } from './pay-calendar.ts';
import type { CompensationRule } from './work-compensation.ts';

// Reviewed salary service dates, not forecast payment slots or legal wage
// entitlement. The posting workflow must still own/verify these exact sources.
export function salaryServiceEarnings(rule:Extract<CompensationRule,{kind:'salary'}>,range:{from:string;through:string},scale:number){
 const days=payCalendarDays(range),first=days[0],last=days.at(-1)!,policy=rule.earningBasis;
 if(!policy)throw new ApiError(409,'SALARY_EARNING_POLICY_REQUIRED');
 if(!['calendar_days','whole_reference_period','whole_service_period'].includes(policy)||(rule.frequency==='pay_period')!==(policy==='whole_service_period'))throw new ApiError(400,'INVALID_SALARY_EARNING_POLICY');
 if(range.from<rule.from||rule.through!==null&&range.through>rule.through)throw new ApiError(409,'SALARY_COMPONENT_NOT_EFFECTIVE');
 const amount=parseMoney(rule.amount,scale);if(amount<0n)throw new ApiError(400,'INVALID_MONEY_AMOUNT');
 const value=(minor:bigint)=>({minor:minor.toString(),amount:formatMoneyTotal(minor,scale)});
 const parts:{referenceFrom:string;referenceThrough:string;from:string;through:string;coveredDays:number;referenceDays:number;gross:ReturnType<typeof value>}[]=[];
 if(policy==='whole_service_period')parts.push({referenceFrom:range.from,referenceThrough:range.through,...range,coveredDays:days.length,referenceDays:days.length,gross:value(amount)});
 else{
  let start=first;
  while(Temporal.PlainDate.compare(start,last)<=0){
   const reference=rule.frequency==='year'?start.with({month:1,day:1}):start.with({day:1}),end=rule.frequency==='year'?reference.with({month:12,day:31}):reference.with({day:reference.daysInMonth}),through=Temporal.PlainDate.compare(end,last)<0?end:last;
   if(policy==='whole_reference_period'&&(!start.equals(reference)||!through.equals(end)))throw new ApiError(409,'SALARY_FULL_REFERENCE_PERIOD_REQUIRED');
   const denominator=reference.until(end).days+1,offset=reference.until(start).days,covered=start.until(through).days+1;
   // Difference of cumulative rounded amounts: adjacent slices conserve
   // every cent of the month/year, unlike independently rounded slices.
   const minor=roundRatio(amount*BigInt(offset+covered),BigInt(denominator),'half_away')-roundRatio(amount*BigInt(offset),BigInt(denominator),'half_away');
   parts.push({referenceFrom:reference.toString(),referenceThrough:end.toString(),from:start.toString(),through:through.toString(),coveredDays:covered,referenceDays:denominator,gross:value(minor)});start=through.add({days:1});
  }
 }
 return {frequency:rule.frequency,earningBasis:policy,...range,gross:value(parts.reduce((n,p)=>n+BigInt(p.gross.minor),0n)),parts,rounding:policy==='whole_service_period'?'whole_service_no_proration':'cumulative_reference_half_away_difference',dayBasis:'inclusive_civil_calendar_days',forecastAllocationUsed:false,earnedEntitlementDetermined:false,claimsPersisted:false,wagesAccrued:false,paymentExecuted:false};
}
