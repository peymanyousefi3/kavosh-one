import { z } from 'zod';
import { paidTaxDefinition,t4PaymentAllocation } from './paid-tax-definition.ts';
import { readMinorUnits } from './money.ts';
import { exactReportMoney as exact } from './aging.ts';
import { ApiError } from './policy.ts';

const code=z.string().regex(/^[A-Z0-9][A-Z0-9._-]{0,31}$/),money=t4PaymentAllocation.shape.taxableEarnings;
export const t4SupplementalDeclaration=z.object({
 provinceOfEmployment:t4PaymentAllocation.shape.provinceOfEmployment,
 deductionAllocations:z.array(z.object({sourceCode:code,reportingBox:z.enum(['20','44','46']),amount:money}).strict()).max(100).refine(a=>new Set(a.map(v=>v.sourceCode+':'+v.reportingBox)).size===a.length),
 unionReceiptAgreementConfirmed:z.boolean(),pensionAdjustmentDollars:z.string().max(38).regex(/^(0|[1-9][0-9]*)$/),
 planRegistrationNumber:z.string().regex(/^[0-9]{7}$/).nullable(),pensionAdjustmentEligibilityReviewed:z.boolean(),sourceReference:paidTaxDefinition.shape.review
}).strict().superRefine((v,c)=>{
 if(c.issues.length)return;
 if(v.deductionAllocations.some(a=>a.reportingBox==='44'&&readMinorUnits(a.amount.replace('.',''))>0n)&&!v.unionReceiptAgreementConfirmed)c.addIssue({code:'custom',message:'Positive union dues need the reviewed no-separate-receipt agreement.'});
 if(BigInt(v.pensionAdjustmentDollars)>0n&&(!v.planRegistrationNumber||!v.pensionAdjustmentEligibilityReviewed))c.addIssue({code:'custom',message:'A positive pension adjustment needs the selected seven-digit plan and eligibility review.'});
});
export type T4SupplementalDeclaration=z.infer<typeof t4SupplementalDeclaration>;
// This maps reviewed recorded deductions;it never creates cash,an earning or a
// deduction. Pension adjustments are separate reviewed whole-dollar credits.
export function projectT4Supplemental(raw:unknown,source:{code:string;amount:string}[]){
 const d=t4SupplementalDeclaration.parse(raw),minor=(s:string)=>readMinorUnits(s.replace('.','')),available=new Map(source.map(s=>[s.code,minor(s.amount)])),used=new Map<string,bigint>(),byBox={'20':0n,'44':0n,'46':0n};
 if(available.size!==source.length||[...available.values()].some(n=>n<0n))throw new ApiError(409,'T4_OTHER_DEDUCTION_SOURCE_INVALID');
 for(const a of d.deductionAllocations){if(!available.has(a.sourceCode))throw new ApiError(409,'T4_SUPPLEMENTAL_DEDUCTION_SOURCE_MISSING');const n=minor(a.amount),total=(used.get(a.sourceCode)??0n)+n;if(total>available.get(a.sourceCode)!)throw new ApiError(409,'T4_SUPPLEMENTAL_DEDUCTION_OVERALLOCATED');used.set(a.sourceCode,total);byBox[a.reportingBox]+=n;}
 const recorded=[...available.values()].reduce((n,v)=>n+v,0n),allocated=[...used.values()].reduce((n,v)=>n+v,0n),pa=BigInt(d.pensionAdjustmentDollars);
 return {provinceOfEmployment:d.provinceOfEmployment,fields:(['20','44','46'] as const).map(box=>({box,amount:exact(byBox[box],2),printBlank:byBox[box]===0n})),pensionAdjustment:{box:'52',dollars:d.pensionAdjustmentDollars,printBlank:pa===0n},plan:{box:'50',value:pa>0n?d.planRegistrationNumber:null,printBlank:pa===0n},deductionAllocations:d.deductionAllocations,sourceDeductions:source.map(s=>({code:s.code,amount:exact(minor(s.amount),2)})),recordedOtherDeductions:exact(recorded,2),allocatedOtherDeductions:exact(allocated,2),unmappedOtherDeductions:exact(recorded-allocated,2),unionReceiptAgreementConfirmed:d.unionReceiptAgreementConfirmed,pensionAdjustmentEligibilityReviewed:d.pensionAdjustmentEligibilityReviewed,monetarySourceReconciled:true,eligibilityVerified:false,pensionCreditsCalculated:false};
}
