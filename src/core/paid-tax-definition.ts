import { z } from 'zod';
import { formatMoney,parseMoney } from './money.ts';

const text=z.string().trim().min(1).max(2000).refine(v=>v.isWellFormed()&&!/[\u0000-\u001f\u007f]/.test(v));
const money=z.string().max(80).regex(/^\d+(?:\.\d+)?$/).transform((v,c)=>{try{return formatMoney(parseMoney(v,2),2);}catch{c.addIssue({code:'custom',message:'Use exact non-negative CAD cents.'});return z.NEVER;}}),code=z.string().regex(/^[A-Z0-9][A-Z0-9._-]{0,31}$/);
const employeeKind=z.enum(['CPP','CPP2','QPP','QPP2','EI','QPIP','income_tax','other']),employerKind=z.enum(['CPP','CPP2','QPP','QPP2','EI','QPIP','other']);
const lines=(kind:typeof employeeKind|typeof employerKind)=>z.array(z.object({code,kind,amount:money}).strict()).max(100).refine(v=>new Set(v.map(l=>l.code)).size===v.length).transform(v=>v.sort((a,b)=>a.code.localeCompare(b.code)));
export const t4Province=z.enum(['AB','BC','MB','NB','NL','NS','NT','NU','ON','PE','QC','SK','YT','US','ZZ']);
const earnings={taxableEarnings:money,pensionableEarnings:money,insurableEarnings:money};
export const t4PaymentAllocation=z.object({provinceOfEmployment:t4Province,...earnings,employeeDeductions:lines(employeeKind)}).strict();
export const paidTaxDefinition=z.object({timeZone:z.string().min(1).max(100).regex(/^[A-Za-z0-9_+./-]+$/),...earnings,employeeDeductions:lines(employeeKind),employerContributions:lines(employerKind),review:text,
 t4Allocations:z.array(t4PaymentAllocation).min(1).max(15).refine(v=>new Set(v.map(a=>a.provinceOfEmployment)).size===v.length).optional().describe('Explicit reviewed reporting allocations,not residence or a mutable current profile. Earnings and every employee deduction must sum exactly to this payment recognition. Array order is the reviewed within-payment order for shared annual earnings ceilings.'),
 t4Order:z.number().int().min(1).max(1000000).optional().describe('Optional reviewed ordering among separate payments with the exact same attested instant. Requires explicit T4 allocations;not a payment date or payroll amount override.')
}).strict().superRefine((d,c)=>{
 if(c.issues.length)return;
 if(d.t4Order!==undefined&&!d.t4Allocations)c.addIssue({code:'custom',message:'Explicit allocations are required for T4 ordering.'});if(!d.t4Allocations)return;
 for(const field of ['taxableEarnings','pensionableEarnings','insurableEarnings'] as const)if(d.t4Allocations.reduce((n,a)=>n+parseMoney(a[field],2),0n)!==parseMoney(d[field],2))c.addIssue({code:'custom',message:'T4 '+field+' allocations must match the recorded total.'});
 const original=new Map(d.employeeDeductions.map(l=>[l.code,l])),sums=new Map<string,bigint>();
 for(const a of d.t4Allocations)for(const line of a.employeeDeductions){const p=original.get(line.code);if(!p||p.kind!==line.kind)c.addIssue({code:'custom',message:'T4 deduction code and classification must match the payment recognition.'});sums.set(line.code,(sums.get(line.code)??0n)+parseMoney(line.amount,2));}
 for(const line of d.employeeDeductions)if((sums.get(line.code)??0n)!==parseMoney(line.amount,2))c.addIssue({code:'custom',message:'T4 deductions must allocate the complete recorded amount exactly once.'});
});
export type PaidTaxDefinition=z.infer<typeof paidTaxDefinition>;
