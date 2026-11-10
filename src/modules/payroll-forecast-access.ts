import { z } from 'zod';
import type { ApiContext } from '../core/api.ts';
import { permissionScope,lockApprovalWrites } from '../core/approvals.ts';
import { ApiError,scopeNonempty } from '../core/policy.ts';

const uuid=z.string().uuid().transform(v=>v.toLowerCase());
export const forecastAuthorization=z.object({kind:z.literal('scheduled_payroll'),engagements:z.array(z.object({engagementId:uuid,personId:uuid,hubId:uuid.nullable()}).strict()).max(1000).refine(a=>new Set(a.map(e=>e.engagementId)).size===a.length),classes:z.array(z.object({classId:uuid,hubId:uuid,rosterUsed:z.boolean()}).strict()).max(2000).refine(a=>new Set(a.map(c=>c.classId)).size===a.length)}).strict();
export function forecastReportScopes(ctx:ApiContext){const scopes=(['work-pay.view','financial-reports.view'] as const).map(cap=>permissionScope(ctx,cap));if(scopes.some(s=>!scopeNonempty(s)))throw new ApiError(403,'FORBIDDEN');return scopes;}
export async function requireForecastResultAccess(ctx:ApiContext,raw:unknown){
 await lockApprovalWrites(ctx);const proof=forecastAuthorization.parse(raw),[work,reports]=forecastReportScopes(ctx);
 const ok=(await ctx.db.query<{ok:boolean}>(`SELECT
 NOT EXISTS(SELECT 1 FROM jsonb_to_recordset($1::jsonb) s("engagementId" uuid,"personId" uuid,"hubId" uuid) WHERE NOT EXISTS(SELECT 1 FROM public.work_engagements e WHERE e.id=s."engagementId" AND e.person_id=s."personId" AND e.hub_id IS NOT DISTINCT FROM s."hubId" AND public.work_scope_allows($3::jsonb,e.hub_id,e.person_id) AND public.work_scope_allows($4::jsonb,e.hub_id,e.person_id) AND($5::boolean OR e.hub_id=ANY($6::uuid[]))))
 AND NOT EXISTS(SELECT 1 FROM jsonb_to_recordset($2::jsonb) s("classId" uuid,"hubId" uuid,"rosterUsed" boolean) WHERE NOT EXISTS(SELECT 1 FROM public.classes c WHERE c.id=s."classId" AND c.hub_id=s."hubId" AND($5::boolean OR c.hub_id=ANY($6::uuid[])) AND public.scope_contains($7::jsonb,jsonb_build_object('all',false,'hubs','[]'::jsonb,'classes',jsonb_build_array(jsonb_build_object('id',c.id,'hubId',c.hub_id)))) AND public.scope_contains($8::jsonb,jsonb_build_object('all',false,'hubs','[]'::jsonb,'classes',jsonb_build_array(jsonb_build_object('id',c.id,'hubId',c.hub_id)))) AND(NOT s."rosterUsed" OR public.scope_contains($9::jsonb,jsonb_build_object('all',false,'hubs','[]'::jsonb,'classes',jsonb_build_array(jsonb_build_object('id',c.id,'hubId',c.hub_id))))))) ok`,[JSON.stringify(proof.engagements),JSON.stringify(proof.classes),JSON.stringify(work),JSON.stringify(reports),ctx.credential.all_hubs,ctx.credential.hub_ids,...(['classes.view','staff.view','rosters.view'] as const).map(cap=>JSON.stringify(permissionScope(ctx,cap)))])).rows[0]?.ok;
 if(ok!==true)throw new ApiError(403,'REPORT_SOURCE_ACCESS_CHANGED');
}
