import { ApiError } from './policy.ts';
import { parseMoney,formatMoneyTotal } from './money.ts';
import type { PaidTaxDefinition } from './paid-tax-definition.ts';
import { t4PaymentAllocation,paidTaxDefinition } from './paid-tax-definition.ts';

export const t4AnnualLimits2026={insurable:6890000n,pensionable:8500000n} as const;
export type T4PaymentSource={paymentId:string;paidAt:string;reportingAccount?:NonNullable<PaidTaxDefinition['reportingAccount']>;order?:number;allocations:NonNullable<PaidTaxDefinition['t4Allocations']>};
// Input dates are canonical UTC instants with six fractional digits from SQL,
// retaining microseconds instead of collapsing their order through Date/Number.
// Same-instant cross-account/province cap choices require explicit reviewed ordering.
export function allocateT4AnnualEarnings2026(payments:T4PaymentSource[]){
 if(payments.length>500)throw new ApiError(422,'PAID_TAX_YTD_REQUIRES_BACKGROUND_JOB');const groups=new Map<string,{reportingAccountId:string|null;reportingAccountVersions:Set<number>;provinceOfEmployment:string;taxable:bigint;pensionable:bigint;insurable:bigint;reportablePensionable:bigint;reportableInsurable:bigint;cpp:bigint;cpp2:bigint;ei:bigint;incomeTax:bigint;other:bigint;otherByCode:Map<string,bigint>}>(),byInstant=new Map<string,T4PaymentSource[]>();
 if(new Set(payments.map(p=>p.paymentId)).size!==payments.length)throw new Error('T4_PAYMENT_DUPLICATE');
 for(const p of payments){if(!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/.test(p.paidAt))throw new Error('T4_PAYMENT_INSTANT_INVALID');if(!p.allocations.length||p.allocations.length>15||p.order!==undefined&&(!Number.isInteger(p.order)||p.order<1||p.order>1000000))throw new Error('T4_PAYMENT_ALLOCATION_INVALID');const rows=byInstant.get(p.paidAt)??[];rows.push({...p,reportingAccount:p.reportingAccount!==undefined?paidTaxDefinition.shape.reportingAccount.parse(p.reportingAccount):undefined,allocations:p.allocations.map(a=>t4PaymentAllocation.parse(a))});byInstant.set(p.paidAt,rows);}
 let remainingIE=t4AnnualLimits2026.insurable as bigint,remainingPI=t4AnnualLimits2026.pensionable as bigint;const min=(a:bigint,b:bigint)=>a<b?a:b;
 for(const [,rows]of [...byInstant].sort(([a],[b])=>a.localeCompare(b))){
  const declared=rows.filter(p=>p.order!==undefined);if(new Set(declared.map(p=>p.order)).size!==declared.length)throw new ApiError(409,'T4_REPORTING_ORDER_CONFLICT');
  const allocations=rows.flatMap(p=>p.allocations),ie=allocations.reduce((n,a)=>n+parseMoney(a.insurableEarnings,2),0n),pi=allocations.reduce((n,a)=>n+parseMoney(a.pensionableEarnings,2),0n),activeSlips=(field:'insurableEarnings'|'pensionableEarnings')=>new Set(rows.flatMap(p=>p.allocations.filter(a=>parseMoney(a[field],2)>0n).map(a=>(p.reportingAccount?.id??'unassigned')+':'+a.provinceOfEmployment))).size,activePayments=(field:'insurableEarnings'|'pensionableEarnings')=>rows.filter(p=>p.allocations.some(a=>parseMoney(a[field],2)>0n)).length;
  const crosses=(ie>remainingIE&&remainingIE>0n&&activeSlips('insurableEarnings')>1&&activePayments('insurableEarnings')>1)||(pi>remainingPI&&remainingPI>0n&&activeSlips('pensionableEarnings')>1&&activePayments('pensionableEarnings')>1);
  if(crosses&&declared.length!==rows.length)throw new ApiError(409,'T4_SIMULTANEOUS_CAP_ORDER_REVIEW_REQUIRED');
  // UUID order is display-deterministic only when it cannot change a slip's
  // capped total;it must never decide an ambiguous account/province allocation.
  rows.sort(declared.length===rows.length?(a,b)=>a.order!-b.order!:(a,b)=>a.paymentId.localeCompare(b.paymentId));
  for(const p of rows)for(const a of p.allocations){
   if(a.provinceOfEmployment==='QC')throw new ApiError(409,'T4_QUEBEC_HISTORY_REVIEW_REQUIRED');
   const key=(p.reportingAccount?.id??'unassigned')+':'+a.provinceOfEmployment,g=groups.get(key)??{reportingAccountId:p.reportingAccount?.id??null,reportingAccountVersions:new Set<number>(),provinceOfEmployment:a.provinceOfEmployment,taxable:0n,pensionable:0n,insurable:0n,reportablePensionable:0n,reportableInsurable:0n,cpp:0n,cpp2:0n,ei:0n,incomeTax:0n,other:0n,otherByCode:new Map<string,bigint>()},pensionable=parseMoney(a.pensionableEarnings,2),insurable=parseMoney(a.insurableEarnings,2),rp=min(pensionable,remainingPI),ri=min(insurable,remainingIE);remainingPI-=rp;remainingIE-=ri;g.taxable+=parseMoney(a.taxableEarnings,2);g.pensionable+=pensionable;g.insurable+=insurable;g.reportablePensionable+=rp;g.reportableInsurable+=ri;
   for(const l of a.employeeDeductions){const amount=parseMoney(l.amount,2);if(['QPP','QPP2','QPIP'].includes(l.kind)&&amount!==0n)throw new ApiError(409,'T4_QUEBEC_HISTORY_REVIEW_REQUIRED');if(l.kind==='CPP')g.cpp+=amount;else if(l.kind==='CPP2')g.cpp2+=amount;else if(l.kind==='EI')g.ei+=amount;else if(l.kind==='income_tax')g.incomeTax+=amount;else if(l.kind==='other'){g.other+=amount;g.otherByCode.set(l.code,(g.otherByCode.get(l.code)??0n)+amount);}}
   if(p.reportingAccount)g.reportingAccountVersions.add(p.reportingAccount.version);groups.set(key,g);
  }
 }
 return [...groups].sort(([a],[b])=>a.localeCompare(b)).map(([,g])=>({reportingAccountId:g.reportingAccountId,reportingAccountVersions:[...g.reportingAccountVersions].sort((a,b)=>a-b),provinceOfEmployment:g.provinceOfEmployment,taxableEarnings:formatMoneyTotal(g.taxable,2),pensionableEarnings:formatMoneyTotal(g.pensionable,2),insurableEarnings:formatMoneyTotal(g.insurable,2),reportablePensionableEarnings:formatMoneyTotal(g.reportablePensionable,2),reportableInsurableEarnings:formatMoneyTotal(g.reportableInsurable,2),cpp:formatMoneyTotal(g.cpp,2),cpp2:formatMoneyTotal(g.cpp2,2),ei:formatMoneyTotal(g.ei,2),incomeTax:formatMoneyTotal(g.incomeTax,2),otherEmployeeDeductions:formatMoneyTotal(g.other,2),otherDeductions:[...g.otherByCode].sort(([a],[b])=>a.localeCompare(b)).map(([code,amount])=>({code,amount:formatMoneyTotal(amount,2)}))}));
}
