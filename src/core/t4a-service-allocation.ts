import { z } from 'zod';
import { paidTaxDefinition } from './paid-tax-definition.ts';
import { exactReportMoney as exact } from './aging.ts';
import { parseMoney,readMinorUnits } from './money.ts';
import { ApiError } from './policy.ts';

// CRA payer instructions: boxes020/048 exclude GST/HST/PST;022 is actual
// income tax deducted. This is an allocation check,not a residency/status
// determination,annual completeness check,official slip or filing service.
export const t4aServiceGuidance='https://www.canada.ca/en/revenue-agency/services/tax/businesses/topics/payroll/completing-filing-information-returns/t4a-information-payers/t4a-slip.html';
const money=paidTaxDefinition.shape.taxableEarnings,reference=paidTaxDefinition.shape.review;
export const t4aServiceAllocation=z.object({
 income:z.array(z.object({box:z.enum(['020','048']),amount:money}).strict()).min(1).max(2).refine(a=>new Set(a.map(v=>v.box)).size===a.length),
 gstHst:money,pst:money,incomeTaxDeducted:money,
 otherExcluded:z.array(z.object({code:z.string().regex(/^[A-Z0-9][A-Z0-9._-]{0,31}$/).refine(v=>v.trim()===v),amount:money,sourceReference:reference}).strict()).max(100).refine(a=>new Set(a.map(v=>v.code)).size===a.length),
 eligibilityReview:z.object({canadianRecipient:z.literal(true).describe('Explicit reviewed Canadian tax residency for this payment reporting;not citizenship,address,workplace or government verification.'),nonEmployment:z.literal(true),serviceReportingReviewed:z.literal(true),sourceReference:reference}).strict(),
 review:reference
}).strict().superRefine((d,c)=>{if(!c.issues.length&&d.income.every(v=>parseMoney(v.amount,2)===0n))c.addIssue({code:'custom',message:'At least one positive reviewed service or commission amount is required.'});});
const storedMinor=z.string().max(80).regex(/^\d+(?:\.0+)?$/).refine(v=>v.trim()===v);
const sourceSchema=z.object({currencyCode:z.literal('CAD'),unitScale:z.literal(2),grossMinor:storedMinor,netMinor:storedMinor,incomeTaxDeductedMinor:storedMinor,nonTaxDeductedMinor:storedMinor.optional()}).strict();

// The caller must supply retained,authorized payment facts,not client claims.
// Never infer gross from net or proportional tax from a partial payment.
export function projectT4aServicePayment(raw:unknown,source:unknown){
 const d=t4aServiceAllocation.parse(raw),s=sourceSchema.safeParse(source);if(!s.success)throw new ApiError(409,'T4A_SERVICE_PAYMENT_SOURCE_INVALID');
 const gross=readMinorUnits(s.data.grossMinor),net=readMinorUnits(s.data.netMinor),withheld=readMinorUnits(s.data.incomeTaxDeductedMinor),nonTax=readMinorUnits(s.data.nonTaxDeductedMinor??'0');
 if(gross!==net+withheld+nonTax||net<=0n)throw new ApiError(409,'T4A_SERVICE_PAYMENT_SOURCE_UNRECONCILED');
 if(parseMoney(d.incomeTaxDeducted,2)!==withheld)throw new ApiError(409,'T4A_SERVICE_WITHHOLDING_SOURCE_MISMATCH');
 const byBox={'020':0n,'048':0n,'022':withheld};for(const line of d.income)byBox[line.box]+=parseMoney(line.amount,2);
 const gstHst=parseMoney(d.gstHst,2),pst=parseMoney(d.pst,2),excluded=d.otherExcluded.reduce((n,l)=>n+parseMoney(l.amount,2),0n),reportable=byBox['020']+byBox['048'];
 if(reportable+gstHst+pst+excluded!==gross)throw new ApiError(409,'T4A_SERVICE_ALLOCATION_UNRECONCILED');
 return {fields:(['020','048','022'] as const).map(box=>({box,amount:exact(byBox[box],2),printBlank:byBox[box]===0n})),gross:exact(gross,2),net:exact(net,2),nonTaxDeductions:exact(nonTax,2),reportableIncome:exact(reportable,2),excludedGstHst:exact(gstHst,2),excludedPst:exact(pst,2),otherExcluded:exact(excluded,2),monetarySourceReconciled:true,eligibilityVerified:false,yearToDateComplete:false,isOfficialT4A:false,readyToIssue:false,craFilingPerformed:false,additionalLedgerPosting:false,paymentExecuted:false};
}
