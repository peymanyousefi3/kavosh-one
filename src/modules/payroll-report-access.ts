import { z } from 'zod';
import type { ApiContext } from '../core/api.ts';
import { permissionScope } from '../core/approvals.ts';
import { ApiError,scopeNonempty } from '../core/policy.ts';

const uuid=z.string().uuid();
export const payrollReportAuthorization=z.object({kind:z.literal('payroll_gross'),sources:z.array(z.object({kind:z.enum(['hourly','manual_bonus','project','salary','tuition_course','tuition_session','tuition_collection']),sourceId:uuid,personId:uuid,hubId:uuid.nullable()}).strict()).max(10000).refine(v=>new Set(v.map(s=>JSON.stringify(s))).size===v.length)}).strict();
export function payrollReportScopes(ctx:ApiContext){
 const reports=permissionScope(ctx,'financial-reports.view'),gross=permissionScope(ctx,'payroll-accruals.view'),manual=permissionScope(ctx,'payroll-adjustments.view');if(!scopeNonempty(reports)||!scopeNonempty(gross)&&!scopeNonempty(manual))throw new ApiError(403,'FORBIDDEN');return {reports,gross,manual};
}
// Retained results are historical data,not a newly filtered report. Every
// captured person/hub and the whole priced hourly source must still be visible.
export async function requirePayrollReportResultAccess(ctx:ApiContext,raw:unknown){
 const proof=payrollReportAuthorization.parse(raw),s=payrollReportScopes(ctx),ceiling={all:ctx.credential.all_hubs,hubs:ctx.credential.hub_ids};
 const ok=(await ctx.db.query<{ok:boolean}>(`SELECT NOT EXISTS(SELECT 1 FROM jsonb_to_recordset($1::jsonb) p(kind text,"sourceId" uuid,"personId" uuid,"hubId" uuid)
 WHERE public.work_scope_allows($2::jsonb,p."hubId",p."personId") IS NOT TRUE OR public.work_scope_allows(CASE WHEN p.kind='manual_bonus' THEN $4::jsonb ELSE $3::jsonb END,p."hubId",p."personId") IS NOT TRUE
 OR($5::jsonb->>'all'<>'true' AND(p."hubId" IS NULL OR NOT coalesce($5::jsonb->'hubs' ? p."hubId"::text,false)))
 OR(p.kind='hourly' AND NOT EXISTS(SELECT 1 FROM public.payroll_hourly_accruals h WHERE h.id=p."sourceId" AND h.person_id=p."personId" AND public.payroll_preparation_allows(h.source_snapshot->'payroll',jsonb_build_array($2::jsonb,$3::jsonb,$5::jsonb),'[{"all":true,"hubs":[]}]'::jsonb)))) ok`,[JSON.stringify(proof.sources),JSON.stringify(s.reports),JSON.stringify(s.gross),JSON.stringify(s.manual),JSON.stringify(ceiling)])).rows[0].ok;
 if(!ok)throw new ApiError(403,'REPORT_SOURCE_ACCESS_CHANGED');
}
