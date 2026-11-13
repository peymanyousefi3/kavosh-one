import { z } from 'zod';
import { t4aServiceAllocation } from './t4a-service-allocation.ts';
import { paidTaxDefinition } from './paid-tax-definition.ts';
import { parseMoney } from './money.ts';

export const t4aRecordDefinition=z.object({
 timeZone:paidTaxDefinition.shape.timeZone,
 reportingAccount:z.object({id:z.string().uuid().transform(v=>v.toLowerCase()),version:z.number().int().positive().max(2147483646)}).strict(),
 allocation:t4aServiceAllocation,
 incomeTaxSources:z.array(z.object({code:z.string().regex(/^[A-Z0-9][A-Z0-9._-]{0,31}$/).refine(v=>v.trim()===v),amount:paidTaxDefinition.shape.taxableEarnings}).strict()).max(100).refine(v=>new Set(v.map(l=>l.code)).size===v.length),
 nonTaxDeductionSources:z.array(z.object({code:z.string().regex(/^[A-Z0-9][A-Z0-9._-]{0,31}$/).refine(v=>v.trim()===v),amount:paidTaxDefinition.shape.taxableEarnings,sourceReference:paidTaxDefinition.shape.review}).strict()).max(100).refine(v=>new Set(v.map(l=>l.code)).size===v.length).optional()
}).strict().superRefine((d,c)=>{if(!c.issues.length&&d.incomeTaxSources.reduce((n,l)=>n+parseMoney(l.amount,2),0n)!==parseMoney(d.allocation.incomeTaxDeducted,2))c.addIssue({code:'custom',message:'Source-coded income tax must equal the reviewed amount deducted.'});});
