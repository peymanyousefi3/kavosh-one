import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Temporal } from '@js-temporal/polyfill';
import { salaryAllocation } from '../src/core/salary-allocation.ts';
import { validateCompensationRules,type CompensationRule } from '../src/core/work-compensation.ts';
import { payCycle } from '../src/core/pay-calendar.ts';

function salary(patch:Record<string,unknown>={}){return validateCompensationRules([{code:'SALARY',kind:'salary',from:'2026-01-01',amount:'36000.01',frequency:'year',forecastAllocation:{kind:'calendar_pay_dates'},...patch}],2)[0] as Extract<CompensationRule,{kind:'salary'}>;}
test('declared calendar allocation conserves annual cents across both 52- and 53-pay-date years',()=>{
 for(const year of [2026,2027]){const r=salaryAllocation(salary(),payCycle.parse({kind:'weekly',weekday:5}),Temporal.PlainDate.from(year+'-06-01'),2);assert.equal(r.kind,'calendar_pay_dates');assert.equal(r.payments!.size,year===2026?52:53);assert.equal([...r.payments!.values()].reduce((s,v)=>s+v,0n),3600001n);assert.equal(r.referenceBudgetConserved,true);assert.equal(r.proration,'manual');}
});
test('monthly weekly-calendar allocation preserves cents and fixed-divisor rounding is explicit rather than falsely budget-conserving',()=>{
 const calendar=salaryAllocation(salary({amount:'3000.01',frequency:'month'}),payCycle.parse({kind:'weekly',weekday:5}),Temporal.PlainDate.from('2027-01-01'),2);assert.ok(calendar.kind==='calendar_pay_dates');assert.equal(calendar.payments.size,5);assert.equal([...calendar.payments.values()].reduce((s,v)=>s+v,0n),300001n);
 const fixed=salaryAllocation(salary({forecastAllocation:{kind:'fixed_divisor',divisor:26,proration:'none'}}),payCycle.parse({kind:'biweekly',anchorOn:'2027-01-01'}),Temporal.PlainDate.from('2027-01-01'),2);assert.ok(fixed.kind==='fixed_divisor');assert.equal(fixed.perPayment,138462n);assert.equal(fixed.referenceBudgetConserved,false);assert.equal(fixed.proration,'none');
});
test('salary allocation rejects missing/invalid choices and supports the final supported reference year',()=>{
 for(const forecastAllocation of [{kind:'fixed_divisor',divisor:0},{kind:'fixed_divisor',divisor:1.5},{kind:'calendar_pay_dates',proration:'guess'},{kind:'fixed_divisor',divisor:26,rounding:'unknown'}])assert.throws(()=>salary({forecastAllocation}));
 assert.throws(()=>salary({frequency:'pay_period'}));
 const rule=salary({forecastAllocation:undefined});assert.throws(()=>salaryAllocation(rule,payCycle.parse({kind:'monthly',day:31}),Temporal.PlainDate.from('2027-01-01'),2),/SALARY_ALLOCATION_POLICY_REQUIRED/);
 const last=salaryAllocation(salary(),payCycle.parse({kind:'monthly',day:31}),Temporal.PlainDate.from('9999-12-31'),2);assert.ok(last.kind==='calendar_pay_dates');assert.equal(last.payments.size,12);assert.equal([...last.payments.values()].reduce((s,v)=>s+v,0n),3600001n);
});
