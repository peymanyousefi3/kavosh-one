import { z } from 'zod';
import type { ApiContext } from '../core/api.ts';
import { permissionScope,privacyScopes } from '../core/approvals.ts';
import { ApiError } from '../core/policy.ts';
import type { profitabilityQuery } from './profitability-report.ts';

const ids=z.array(z.string().uuid().transform(s=>s.toLowerCase())).max(10000).refine(a=>new Set(a).size===a.length);
export const providerCostAuthorization=z.object({postings:ids}).strict();
// Original approval bindings retain every original financial account and
// invoice context. Current class/student rights are additional,not a shortcut
// through a broad financial account or a selected report filter.
const permitted=`p.status='applied' AND p.action IN('finance.provider-dispute.record','finance.provider-dispute.correct')
 AND public.approval_bindings_allow(p.privacy_bindings,$3::jsonb)
 AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements($4::jsonb) scope(value) WHERE public.scope_contains(scope.value,p.scope) IS NOT TRUE)
 AND public.scope_contains($5::jsonb,jsonb_build_object('all',false,'hubs','[]'::jsonb,'classes',jsonb_build_array(jsonb_build_object('id',cl.id,'hubId',cl.hub_id))))
 AND public.scope_contains($6::jsonb,jsonb_build_object('all',false,'hubs','[]'::jsonb,'people',jsonb_build_array(jsonb_build_object('id',person.id,'hubId',person.hub_id))))`;
const joins=`FROM public.provider_cost_events d
 JOIN public.approval_requests p ON p.academy_id=d.academy_id AND p.id=d.approval_id
 JOIN public.provider_collections c ON c.academy_id=d.academy_id AND c.id=d.collection_id
 JOIN public.classes cl ON cl.academy_id=c.academy_id AND cl.id=c.class_id
 JOIN public.people person ON person.academy_id=c.academy_id AND person.id=c.student_id`;
function authority(ctx:ApiContext){return [JSON.stringify(privacyScopes(ctx)),JSON.stringify((['financial-reports.view','ledger.view','expenses.view'] as const).map(c=>permissionScope(ctx,c))),JSON.stringify(permissionScope(ctx,'classes.view')),JSON.stringify(permissionScope(ctx,'students.view'))];}
export async function requireProviderCostResultAccess(ctx:ApiContext,raw:unknown){
 const p=providerCostAuthorization.parse(raw);if(!p.postings.length)return;
 const ok=(await ctx.db.query<{ok:boolean}>(`SELECT $2::boolean AND NOT EXISTS(SELECT 1 FROM unnest($1::uuid[]) wanted(id) WHERE NOT EXISTS(SELECT 1 ${joins} WHERE d.id=wanted.id AND d.fee_minor<>0 AND ${permitted})) ok`,[p.postings,true,...authority(ctx)])).rows[0]?.ok;
 if(!ok)throw new ApiError(403,'REPORT_SOURCE_ACCESS_CHANGED');
}
export function providerCostReportStatement(ctx:ApiContext,q:z.infer<typeof profitabilityQuery>,includeAuthorization=false){
 // ponytail: same10,000event/10,000group cap as other profitability sources;
 // a larger window needs background partitioning,never partial totals.
 return {parameters:[q.from,q.through,...authority(ctx),q.hubIds??null,q.classIds??null,q.studentIds??null,q.currencyIds??null,q.countryIds??null,q.regionIds??null,q.cityIds??null,includeAuthorization],sql:`WITH permitted AS MATERIALIZED(
 SELECT d.id,d.posted_on,c.hub_id,c.class_id,c.student_id,(d.source->>'currencyId')::uuid currency_id,d.source->>'currencyCode' currency_code,(d.source->>'unitScale')::integer unit_scale,d.fee_minor expense
 ${joins} LEFT JOIN public.hubs h ON h.academy_id=c.academy_id AND h.id=c.hub_id LEFT JOIN public.cities ci ON ci.academy_id=h.academy_id AND ci.id=h.city_id LEFT JOIN public.regions r ON r.academy_id=ci.academy_id AND r.id=ci.region_id
 WHERE d.posted_on BETWEEN $1::date AND $2::date AND d.fee_minor<>0 AND ${permitted}
 AND($7::uuid[] IS NULL OR c.hub_id=ANY($7)) AND($8::uuid[] IS NULL OR c.class_id=ANY($8)) AND($9::uuid[] IS NULL OR c.student_id=ANY($9)) AND($10::uuid[] IS NULL OR(d.source->>'currencyId')::uuid=ANY($10)) AND($11::uuid[] IS NULL OR r.country_id=ANY($11)) AND($12::uuid[] IS NULL OR r.id=ANY($12)) AND($13::uuid[] IS NULL OR ci.id=ANY($13)) LIMIT 10001
 ),normalized AS MATERIALIZED(SELECT *,max(unit_scale) OVER(PARTITION BY currency_id) scale FROM permitted WHERE(SELECT count(*) FROM permitted)<=10000),expanded AS(
 SELECT n.*,v.dimension,v.key FROM normalized n CROSS JOIN LATERAL(VALUES('total',NULL::text),('hub',hub_id::text),('class',class_id::text),('student',student_id::text),('month',to_char(posted_on,'YYYY-MM'))) v(dimension,key)
 ),groups AS(SELECT dimension,key,currency_id "currencyId",currency_code "currencyCode",scale "unitScale",trunc(sum(expense*power(10::numeric,scale-unit_scale)))::text expense FROM expanded GROUP BY dimension,key,currency_id,currency_code,scale),ranked AS(SELECT *,row_number() OVER(PARTITION BY dimension ORDER BY "currencyId",key NULLS FIRST) n FROM groups)
 SELECT(SELECT count(*)::integer FROM permitted) events,(SELECT count(*)::integer FROM permitted) lines,
 CASE WHEN $14::boolean THEN jsonb_build_object('postings',coalesce((SELECT jsonb_agg(id ORDER BY id) FROM permitted),'[]'::jsonb)) END "authorizationContext",
 coalesce((SELECT jsonb_object_agg(dimension,items) FROM(SELECT dimension,jsonb_agg(to_jsonb(g)-ARRAY['dimension','n'] ORDER BY "currencyId",key NULLS FIRST) items FROM ranked g WHERE n<=10001 GROUP BY dimension) x),'{}'::jsonb) series`};
}
