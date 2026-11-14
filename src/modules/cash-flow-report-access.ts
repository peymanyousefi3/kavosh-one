import { z } from 'zod';
import type { ApiContext } from '../core/api.ts';
import { financialReportAccess } from './financial-reports.ts';
import { ApiError } from '../core/policy.ts';

const uuid=z.string().uuid().transform(v=>v.toLowerCase());
export const cashFlowAuthorization=z.object({kind:z.literal('classified_cash'),hubIds:z.array(uuid).max(10000).refine(a=>new Set(a).size===a.length),includesGlobal:z.boolean()}).strict();
export const cashFlowReportScopes=(ctx:ApiContext)=>financialReportAccess(ctx,['cash-flow.view','financial-reports.view','ledger.view','accounts.view']);
export function requireCashFlowResultAccess(ctx:ApiContext,raw:unknown){const proof=cashFlowAuthorization.parse(raw),access=cashFlowReportScopes(ctx);if((proof.includesGlobal&&!access.global)||proof.hubIds.some(h=>!(access.all||access.hubs.includes(h))||access.excluded.includes(h)))throw new ApiError(403,'REPORT_SOURCE_ACCESS_CHANGED');}
