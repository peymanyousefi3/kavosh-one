import { z } from 'zod';
import { formatMoneyTotal,parseMoney,roundRatio } from './money.ts';

// CRA T4127,122nd edition,2026:chapters1,6,7 and tables8.4-8.7.
// https://www.canada.ca/en/revenue-agency/services/forms-publications/payroll/t4127-payroll-deductions-formulas/t4127-jan/t4127-jan-payroll-deductions-formulas-computer-programs.html
// Eligibility and same-employer YTD are explicit reviewed inputs,not inferred
// from age,school location,contract labels or another employer's deductions.
const money=z.string().max(80).regex(/^\d+(?:\.\d+)?$/);
export const canadianContributionsInput=z.object({
 taxYear:z.literal(2026),currency:z.literal('CAD'),provinceOfEmployment:z.enum(['AB','BC','MB','NB','NL','NS','NT','NU','ON','PE','SK','YT']),
 paymentKind:z.enum(['regular_salary_or_wages','standalone_non_periodic']),payPeriodsPerYear:z.number().int().min(1).max(2000),
 cppPensionableMonths:z.number().int().min(0).max(12),pensionableEarnings:money,pensionableEarningsYtd:money,
 employeeCppYtd:money,employeeCpp2Ytd:money,insurableEarnings:money,employeeEiYtd:money,
 employerEiPlan:z.literal('standard_1_4'),noQuebecTransfer:z.literal(true),sameEmployerYtdConfirmed:z.literal(true),
 eligibilityReview:z.string().trim().min(1).max(2000).refine(v=>v.isWellFormed()&&!/[\u0000-\u001f\u007f]/.test(v))
}).strict();
const min=(a:bigint,b:bigint)=>a<b?a:b,max=(a:bigint,b:bigint)=>a>b?a:b;
export function calculateCanadianContributions(raw:unknown){
 const input=canadianContributionsInput.parse(raw),m=BigInt(input.cppPensionableMonths),p=BigInt(input.payPeriodsPerYear),
 pi=parseMoney(input.pensionableEarnings,2),piYtd=parseMoney(input.pensionableEarningsYtd,2),d=parseMoney(input.employeeCppYtd,2),d2=parseMoney(input.employeeCpp2Ytd,2),ie=parseMoney(input.insurableEarnings,2),d1=parseMoney(input.employeeEiYtd,2);
 const exemption=input.paymentKind==='regular_salary_or_wages'?350000n/p:0n;
 // Carry prorated caps/thresholds as rational cents;round only the selected
 // final contribution. Basic CPP exemption is instead truncated,per CRA.
 const cpp=roundRatio(max(0n,min((423045n*m-d*12n)*10000n,max(0n,pi-exemption)*595n*12n)),120000n,'half_away');
 const cpp2=roundRatio(max(0n,min((41600n*m-d2*12n)*100n,((piYtd+pi)*12n-max(piYtd*12n,7460000n*m))*4n)),1200n,'half_away');
 const ei=roundRatio(max(0n,min((112307n-d1)*10000n,ie*163n)),10000n,'half_away'),employerEi=roundRatio(ei*14n,10n,'half_away');
 const amounts=(eiAmount:bigint)=>({cpp:formatMoneyTotal(cpp,2),cpp2:formatMoneyTotal(cpp2,2),ei:formatMoneyTotal(eiAmount,2),total:formatMoneyTotal(cpp+cpp2+eiAmount,2)});
 return {calculationVersion:'ca-2026-cpp-ei-salary-v1',taxYear:2026,currency:'CAD',provinceOfEmployment:input.provinceOfEmployment,paymentKind:input.paymentKind,
  employee:amounts(ei),employer:amounts(employerEi),cppBasicExemption:formatMoneyTotal(exemption,2),
  ytdExceedsProratedLimits:{cpp:d*12n>423045n*m,cpp2:d2*12n>41600n*m,ei:d1>112307n},
  contributionFormulasCalculated:true,incomeTaxCalculated:false,fullPayrollCalculated:false,eligibilityVerified:false,yearToDateVerified:false,
  previousEmployerAmountsIncluded:false,quebecTransfersSupported:false,reducedEmployerEiSupported:false,
  sourceUrl:'https://www.canada.ca/en/revenue-agency/services/forms-publications/payroll/t4127-payroll-deductions-formulas/t4127-jan/t4127-jan-payroll-deductions-formulas-computer-programs.html',
  statutoryCertification:false,paymentExecuted:false,additionalLedgerPosting:false};
}
