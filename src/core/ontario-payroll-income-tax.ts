import { z } from 'zod';
import { canadianContributionsInput } from './canadian-payroll-contributions.ts';
import { formatMoneyTotal,parseMoney,roundRatio } from './money.ts';
import { ApiError } from './policy.ts';

// CRA T4127,122nd edition (2026,revision26/05),option1 regular employment
// income:chapter4 steps1-6,Ontario provisions,and tables8.1/8.2/8.4/8.7.
// July123rd edition explicitly retains Ontario/federal rules. Ontario's2026
// Fall Statement also confirms T4127's554 per qualifying claim (counting a
// disabled child twice when eligible);T4032's575/under18 summary conflicts.
// Follow the explicit payroll formula and current provincial authority:
// https://budget.ontario.ca/2026/fallstatement/provisions.html
// Claims are explicitly recorded TD1 values,not inferred basic personal amounts.
const money=canadianContributionsInput.shape.pensionableEarnings;
export const ontarioRegularIncomeTaxInput=z.object({taxYear:z.literal(2026),currency:z.literal('CAD'),provinceOfEmployment:z.literal('ON'),paymentKind:z.literal('regular_salary_or_wages'),
 payPeriodsPerYear:canadianContributionsInput.shape.payPeriodsPerYear,cppPensionableMonths:canadianContributionsInput.shape.cppPensionableMonths,
 remuneration:money,employeeCpp:money,employeeCpp2:money,employeeEi:money,employeeCppYtd:money,employeeEiYtd:money,
 federalClaimAmount:money,provincialClaimAmount:money,additionalIncomeTaxPerPay:money,ontarioTaxReductionClaimCount:z.number().int().min(0).max(10000),
 noOtherAdjustments:z.literal(true)}).strict();

// Rate ratios must not be rounded. Keep rational minor units throughout the
// formula and round only the final tax deduction;displayed subtotals are not
// fed back into the calculation. No floating-point money or new dependency.
type Q={n:bigint;d:bigint};
function q(n:bigint,d=1n):Q{if(d<=0n)throw new Error('INVALID_TAX_RATIO');let a=n<0n?-n:n,b=d;while(b){const r=a%b;a=b;b=r;}return {n:n/a,d:d/a};}
const add=(a:Q,b:Q)=>q(a.n*b.d+b.n*a.d,a.d*b.d),sub=(a:Q,b:Q)=>q(a.n*b.d-b.n*a.d,a.d*b.d),mul=(a:Q,n:bigint,d=1n)=>q(a.n*n,a.d*d),
 less=(a:Q,b:Q)=>a.n*b.d<b.n*a.d,min=(a:Q,b:Q)=>less(a,b)?a:b,max=(a:Q,b:Q)=>less(a,b)?b:a,
 zero=q(0n),dollars=(n:bigint)=>q(n*100n),positive=(a:Q)=>max(zero,a),display=(a:Q)=>formatMoneyTotal(roundRatio(a.n,a.d,'half_away'),2);
// Use the published constants,not a reconstructed marginal-band integral:
// CRA rounds K/KP to whole dollars,which changes the answer at some brackets.
const federal=[[0n,1400n,0n],[58523n,2050n,3804n],[117045n,2600n,10241n],[181440n,2900n,15685n],[258482n,3300n,26024n]] as const;
const ontario=[[0n,505n,0n],[53891n,915n,2210n],[107785n,1116n,4376n],[150000n,1216n,5876n],[220000n,1316n,8076n]] as const;
function bracket(a:Q,rows:readonly (readonly[bigint,bigint,bigint])[]){let row=rows[0];for(const candidate of rows)if(less(dollars(candidate[0]),a))row=candidate;return sub(mul(a,row[1],10000n),dollars(row[2]));}
function healthPremium(a:Q){
 if(!less(dollars(20000n),a))return zero;
 if(!less(dollars(36000n),a))return min(dollars(300n),mul(sub(a,dollars(20000n)),6n,100n));
 if(!less(dollars(48000n),a))return min(dollars(450n),add(dollars(300n),mul(sub(a,dollars(36000n)),6n,100n)));
 if(!less(dollars(72000n),a))return min(dollars(600n),add(dollars(450n),mul(sub(a,dollars(48000n)),25n,100n)));
 if(!less(dollars(200000n),a))return min(dollars(750n),add(dollars(600n),mul(sub(a,dollars(72000n)),25n,100n)));
 return min(dollars(900n),add(dollars(750n),mul(sub(a,dollars(200000n)),25n,100n)));
}
export function calculateOntarioRegularIncomeTax(raw:unknown){
 const i=ontarioRegularIncomeTaxInput.parse(raw),p=BigInt(i.payPeriodsPerYear),m=BigInt(i.cppPensionableMonths),amount=(s:string)=>q(parseMoney(s,2)),gross=amount(i.remuneration),cpp=amount(i.employeeCpp),cpp2=amount(i.employeeCpp2),ei=amount(i.employeeEi),d=amount(i.employeeCppYtd),d1=amount(i.employeeEiYtd),tc=amount(i.federalClaimAmount),tcp=amount(i.provincialClaimAmount),extra=amount(i.additionalIncomeTaxPerPay);
 if(less(gross,add(add(cpp,cpp2),ei))||cpp.n>roundRatio(423045n*m,12n,'half_away')||cpp2.n>roundRatio(41600n*m,12n,'half_away')||ei.n>112307n||(m===0n&&(cpp.n!==0n||cpp2.n!==0n)))throw new ApiError(400,'INCOME_TAX_CONTRIBUTIONS_INCONSISTENT');
 const f5=add(mul(cpp,20n,119n),cpp2),annualGross=mul(gross,p),annual=positive(mul(sub(gross,f5),p)),baseCap=mul(q(351945n),m,12n),cppCap=mul(q(423045n),m,12n),reachedCpp=add(d,cpp).n>=roundRatio(cppCap.n,cppCap.d,'half_away'),reachedEi=add(d1,ei).n>=112307n;
 // CRA chapter4 K2 recommendation: preserve the annual credit after the
 // maximum is reached and otherwise do not fall below already-paid history.
 const annualCppCreditBasis=reachedCpp?baseCap:min(baseCap,max(mul(cpp,p*99n,119n),mul(d,99n,119n))),annualEiCreditBasis=reachedEi?q(112307n):min(q(112307n),max(mul(ei,p),d1)),contributionCreditBasis=add(annualCppCreditBasis,annualEiCreditBasis);
 const annualFederal=positive(sub(sub(sub(bracket(annual,federal),mul(tc,14n,100n)),mul(contributionCreditBasis,14n,100n)),mul(min(annualGross,dollars(1501n)),14n,100n)));
 const basicOntario=positive(sub(sub(bracket(annual,ontario),mul(tcp,505n,10000n)),mul(contributionCreditBasis,505n,10000n)));
 const surtax=add(mul(positive(sub(basicOntario,dollars(5818n))),20n,100n),mul(positive(sub(basicOntario,dollars(7446n))),36n,100n));
 const beforeReduction=add(basicOntario,surtax),reduction=positive(min(beforeReduction,sub(mul(dollars(300n+554n*BigInt(i.ontarioTaxReductionClaimCount)),2n),beforeReduction)));
 const health=healthPremium(annual),annualOntario=add(sub(beforeReduction,reduction),health),combined=mul(add(annualFederal,annualOntario),1n,p),total=add(combined,extra);
 return {calculationVersion:'ca-on-2026-option1-regular-v1',taxYear:2026,currency:'CAD',provinceOfEmployment:'ON',paymentKind:i.paymentKind,
  enhancedCppDeductionPerPay:display(f5),annualTaxableIncome:display(annual),annualContributionCreditBasis:{cpp:display(annualCppCreditBasis),ei:display(annualEiCreditBasis)},annualFederal:display(annualFederal),annualOntarioBasic:display(basicOntario),annualOntarioSurtax:display(surtax),annualOntarioReduction:display(reduction),annualOntarioHealthPremium:display(health),annualOntario:display(annualOntario),combinedPerPayBeforeAdditional:display(combined),additionalPerPay:display(extra),incomeTax:display(total),incomeTaxMinor:roundRatio(total.n,total.d,'half_away').toString(),
  roundingBasis:'exact_rational_intermediates_final_cent_half_away',contributionCreditBasis:'CRA_option1_annualized_with_paid_history_floor_and_reached_maximum_preservation',incomeTaxCalculated:true,fullPayrollCalculated:false,claimsVerified:false,eligibilityVerified:false,statutoryCertification:false,netStatementPrepared:false,paymentExecuted:false,
  sourceUrl:'https://www.canada.ca/en/revenue-agency/services/forms-publications/payroll/t4127-payroll-deductions-formulas/t4127-jan/t4127-jan-payroll-deductions-formulas-computer-programs.html'};
}
