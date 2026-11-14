import { Temporal } from '@js-temporal/polyfill';
import { allocateMoney,parseMoney,roundRatio } from './money.ts';
import { payCalendarDays,payOccurrencesOn,type PayCycle } from './pay-calendar.ts';
import type { CompensationRule } from './work-compensation.ts';
import { ApiError } from './policy.ts';

export function salaryAllocation(rule:Extract<CompensationRule,{kind:'salary'}>,cycle:PayCycle,on:Temporal.PlainDate,scale:number){
 const policy=rule.forecastAllocation;if(!policy)throw new ApiError(400,'SALARY_ALLOCATION_POLICY_REQUIRED');
 const start=rule.frequency==='year'?on.with({month:1,day:1}):rule.frequency==='month'?on.with({day:1}):on;
 const end=rule.frequency==='year'?on.with({month:12,day:31}):rule.frequency==='month'?on.with({day:on.daysInMonth}):on;
 const amount=parseMoney(rule.amount,scale),base={from:start.toString(),through:end.toString(),proration:policy.proration};
 if(policy.kind==='fixed_divisor')return {...base,kind:policy.kind,perPayment:roundRatio(amount,BigInt(policy.divisor),'half_away'),divisor:policy.divisor,referenceBudgetConserved:false as const};
 if(rule.frequency==='pay_period')throw new ApiError(400,'SALARY_REFERENCE_PERIOD_REQUIRED');
 const slots=payCalendarDays({from:start.toString(),through:end.toString()}).flatMap(d=>payOccurrencesOn(cycle,d));
 if(!slots.length)throw new ApiError(400,'SALARY_REFERENCE_PAY_DATES_REQUIRED');
 const payments=new Map(allocateMoney(amount,slots.map(s=>({key:s.on+':'+s.slot,weight:1n}))).map(p=>[p.key,p.amount]));
 return {...base,kind:policy.kind,payments,referenceBudgetConserved:true as const};
}
