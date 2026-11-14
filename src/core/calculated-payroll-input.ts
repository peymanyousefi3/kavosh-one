import { z } from 'zod';
import { canadianContributionsInput } from './canadian-payroll-contributions.ts';

export const payrollHistoryAttestations={
 noNonCashOrZeroNetPayments:z.literal(true).optional(),
 noOtherNonCashPayments:z.literal(true).optional().describe('Explicitly permits only current reviewed actual zero-net settlements in recorded history;attests no other noncash history. Mutually exclusive with noNonCashOrZeroNetPayments. Missing or stale recognition still blocks calculation.')
};
export const hasSinglePayrollHistoryAttestation=(v:{noNonCashOrZeroNetPayments?:true;noOtherNonCashPayments?:true})=>(v.noNonCashOrZeroNetPayments===true)!==(v.noOtherNonCashPayments===true);
export const calculatedPayrollFields=z.object({
 periodId:z.string().uuid().transform(v=>v.toLowerCase()),expectedPeriodVersion:z.number().int().positive().max(2147483646),
 pensionableEarnings:canadianContributionsInput.shape.pensionableEarnings,insurableEarnings:canadianContributionsInput.shape.insurableEarnings,
 noQuebecTransfer:z.literal(true),noOtherSameEmployerPayments:z.literal(true),...payrollHistoryAttestations,
 eligibilityReview:canadianContributionsInput.shape.eligibilityReview,fullyTaxableCashRemuneration:z.literal(true),noBonusesOrOtherTaxAdjustments:z.literal(true)
}).strict();
export const calculatedPayrollRequest=calculatedPayrollFields.refine(hasSinglePayrollHistoryAttestation,'Choose exactly one payroll-history attestation.');
