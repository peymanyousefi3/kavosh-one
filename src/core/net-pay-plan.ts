import { z } from 'zod';
import { ApiError } from './policy.ts';
import { formatMoneyTotal,parseMoney } from './money.ts';

const text=z.string().trim().min(1).refine(v=>v.isWellFormed()&&!/[\u0000-\u001f\u007f]/.test(v));
const line={code:text.regex(/^[A-Z0-9][A-Z0-9._-]{0,31}$/),label:text.max(150),amount:z.string().max(80).regex(/^\d+(?:\.\d+)?$/)};
const deduction=z.object({...line,authorityKind:z.enum(['statute','court_order','written_authorization']),authorityReference:text.max(1000)}).strict();
const contribution=z.object({...line,obligationReference:text.max(1000)}).strict();
// These are recorded amounts and review attestations, not a tax-rate engine or
// proof that an authorization exists. The separate approval workflow must bind
// this definition to a current gross run before retaining a prepared statement.
export const netPayDefinition=z.object({
 calculationBasis:z.literal('manual_reviewed').default('manual_reviewed'),
 employeeDeductions:z.array(deduction).max(100),
 employerContributions:z.array(contribution).max(100),
 taxReview:text.max(2000)
}).strict().superRefine((v,ctx)=>{
 for(const key of ['employeeDeductions','employerContributions'] as const){
  const codes=new Set<string>();for(let i=0;i<v[key].length;i++){const code=v[key][i].code;if(codes.has(code))ctx.addIssue({code:'custom',path:[key,i,'code'],message:'DUPLICATE_PAYROLL_LINE_CODE'});codes.add(code);}
 }
});
export type NetPayDefinition=z.infer<typeof netPayDefinition>;

export function calculateNetPay(grossMinor:bigint,unitScale:number,raw:unknown){
 // Gross is an aggregate of valid accruals, so it may exceed one posting's
 // bound. Currency precision is still validated even for an empty line list.
 if(typeof grossMinor!=='bigint'||grossMinor<0n)throw new ApiError(400,'INVALID_GROSS_PAY');
 const grossAmount=formatMoneyTotal(grossMinor,unitScale),definition=netPayDefinition.parse(raw);
 let employeeDeductionMinor=0n,employerContributionMinor=0n;
 const employeeDeductions=definition.employeeDeductions.map(v=>{const minor=parseMoney(v.amount,unitScale);employeeDeductionMinor+=minor;return {...v,amount:formatMoneyTotal(minor,unitScale)};});
 const employerContributions=definition.employerContributions.map(v=>{const minor=parseMoney(v.amount,unitScale);employerContributionMinor+=minor;return {...v,amount:formatMoneyTotal(minor,unitScale)};});
 if(employeeDeductionMinor>grossMinor)throw new ApiError(400,'DEDUCTIONS_EXCEED_GROSS_PAY');
 const netMinor=grossMinor-employeeDeductionMinor;
 return {
  definition:{...definition,employeeDeductions,employerContributions},
  grossMinor,employeeDeductionMinor,employerContributionMinor,netMinor,employerCostMinor:grossMinor+employerContributionMinor,
  amounts:{gross:grossAmount,employeeDeductions:formatMoneyTotal(employeeDeductionMinor,unitScale),employerContributions:formatMoneyTotal(employerContributionMinor,unitScale),net:formatMoneyTotal(netMinor,unitScale),employerCost:formatMoneyTotal(grossMinor+employerContributionMinor,unitScale)},
  calculationBasis:'manual_reviewed' as const,exactArithmetic:true as const,
  statutoryRulesCalculated:false as const,authorityDocumentsVerified:false as const,
  approvalDetermined:false as const,additionalLedgerPosting:false as const,isOfficialPaystub:false as const,paymentExecuted:false as const
 };
}
