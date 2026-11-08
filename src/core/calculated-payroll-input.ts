import { z } from 'zod';
import { canadianContributionsInput } from './canadian-payroll-contributions.ts';

export const calculatedPayrollRequest=z.object({
 periodId:z.string().uuid().transform(v=>v.toLowerCase()),expectedPeriodVersion:z.number().int().positive().max(2147483646),
 pensionableEarnings:canadianContributionsInput.shape.pensionableEarnings,insurableEarnings:canadianContributionsInput.shape.insurableEarnings,
 noQuebecTransfer:z.literal(true),noOtherSameEmployerPayments:z.literal(true),noNonCashOrZeroNetPayments:z.literal(true),
 eligibilityReview:canadianContributionsInput.shape.eligibilityReview,fullyTaxableCashRemuneration:z.literal(true),noBonusesOrOtherTaxAdjustments:z.literal(true)
}).strict();
