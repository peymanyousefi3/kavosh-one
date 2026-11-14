import {z} from 'zod';
import type {ApiContext} from '../core/api.ts';
import {permissionScope} from '../core/approvals.ts';
import {ApiError,scopeNonempty,type Capability} from '../core/policy.ts';
import {accountingDate} from './finance-periods.ts';

const uuid=z.string().uuid(),day=accountingDate;
export const counterpartyReportCapabilities:Capability[]=['counterparty-balances.view','financial-reports.view','journals.view','ledger.view','accounts.view','payees.view','collectors.view','remittances.view','expenses.view','expense-payments.view'];
export function counterpartyReportScopes(ctx:ApiContext){const s=Object.fromEntries(counterpartyReportCapabilities.map(c=>[c,permissionScope(ctx,c)]));if(['counterparty-balances.view','financial-reports.view','payees.view'].some(c=>!scopeNonempty(s[c])))throw new ApiError(403,'FORBIDDEN');return s;}
export const counterpartyReportAuthorization=z.object({kind:z.literal('counterparty_statement'),frame:z.object({payeeId:uuid,from:day,through:day,currencyIds:z.array(uuid).min(1).max(200).refine(a=>new Set(a).size===a.length).optional()}).strict().refine(f=>f.from<=f.through&&Date.parse(f.through)-Date.parse(f.from)<=3660*86400000),sourceFingerprint:z.string().regex(/^[a-f0-9]{64}$/),sourceManifest:z.array(z.tuple([z.enum(['manual_balance','custody','payable']),uuid,z.number().int().min(0).max(200)])).max(10000).refine(a=>new Set(a.map(v=>JSON.stringify(v))).size===a.length)}).strict();
// The fixed dated frame includes opening history. Immutable source membership
// must survive,and current rights cover the WHOLE original/current statement.
// Do not apply every feature's capability to an unrelated family's hub.
export async function requireCounterpartyReportResultAccess(ctx:ApiContext,raw:unknown){
 const p=counterpartyReportAuthorization.parse(raw),s=counterpartyReportScopes(ctx),f=p.frame;
 const ok=(await ctx.db.query<{ok:boolean}>(`SELECT coalesce(v.denied=0 AND v.unknown=0 AND v."sourceFingerprint" IS NOT NULL AND v."sourceCount"<=10000 AND $5::jsonb <@ v."sourceManifest",false) ok FROM public.counterparty_statement_export_snapshot_read($1,$2,$3,$4::jsonb,NULL,NULL,NULL,NULL,1,$6::uuid[],true) v`,[f.payeeId,f.from,f.through,JSON.stringify(s),JSON.stringify(p.sourceManifest),f.currencyIds??null])).rows[0]?.ok;
 if(!ok)throw new ApiError(403,'REPORT_SOURCE_ACCESS_CHANGED');
}
