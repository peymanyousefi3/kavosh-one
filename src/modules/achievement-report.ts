import { z } from 'zod';
import type { ApiContext,Reply } from '../core/api.ts';
import { permissionScope,lockApprovalWrites } from '../core/approvals.ts';
import { ApiError,scopeNonempty } from '../core/policy.ts';

const uuid=z.string().uuid().transform(v=>v.toLowerCase()),date=z.iso.date().refine(v=>v>='1900-01-01');
export const achievementReportQuery=z.object({from:date,through:date,hubId:uuid.optional(),classId:uuid.optional(),studentId:uuid.optional(),typeId:uuid.optional(),status:z.enum(['awarded','revoked','all']).default('all'),release:z.enum(['current','stale','withdrawn','none','all']).default('all')}).strict().refine(q=>q.from<=q.through);
// ponytail: synchronous chart aggregation is bounded at10,000 source records
// and1,000 groups per dimension; larger reports need a separate queued path.
export const achievementReportSourceLimit=10000,achievementReportGroupLimit=1000;
export function checkAchievementReportBudget(sourceCount:number,groupCounts:number[]){if(sourceCount>achievementReportSourceLimit||groupCounts.some(n=>n>achievementReportGroupLimit))throw new ApiError(409,'ACHIEVEMENT_REPORT_REQUIRES_BACKGROUND_JOB');}
const dimensions=['hub','class','type','week','status','release'] as const;
type Summary={awards:number;students:number;awarded:number;revoked:number;awardedPoints:string;currentFamilyReleases:number};
type Chart=Summary&{key:string|null;typeVersion?:number;labels?:Record<string,string>};
type Report={sourceCount:number;summary:Summary;charts:Record<typeof dimensions[number],Chart[]>;snapshotAt:string};
const sql=`WITH permitted AS NOT MATERIALIZED(
 SELECT a.id,a.student_id,a.hub_id,a.class_id,a.type_id,a.type_version,a.earned_on,a.status,(a.context#>>'{type,definition,points}')::numeric points,a.context#>'{type,definition,labels}' labels,CASE WHEN f.id IS NULL THEN 'none' WHEN f.state='withdrawn' THEN 'withdrawn'
 WHEN f.award_version=a.version AND a.status='awarded' AND f.source=public.achievement_family_source(a.id) THEN 'current' ELSE 'stale' END release
 FROM public.achievement_awards a LEFT JOIN public.achievement_family_publications f ON f.academy_id=a.academy_id AND f.award_id=a.id
 WHERE a.earned_on BETWEEN $1::date AND $2::date AND($3::uuid IS NULL OR a.hub_id=$3) AND($4::uuid IS NULL OR a.class_id=$4) AND($5::uuid IS NULL OR a.student_id=$5) AND($6::uuid IS NULL OR a.type_id=$6) AND($7='all' OR a.status=$7)
 AND public.scope_contains($8::jsonb,public.achievement_award_scope(a.student_id,a.hub_id,a.class_id)) AND public.scope_contains($9::jsonb,public.achievement_award_scope(a.student_id,a.hub_id,a.class_id))
),selected AS MATERIALIZED(SELECT * FROM permitted WHERE $10='all' OR release=$10 LIMIT $11),
totals AS(SELECT count(*)::integer awards,count(DISTINCT student_id)::integer students,count(*) FILTER(WHERE status='awarded')::integer awarded,count(*) FILTER(WHERE status='revoked')::integer revoked,coalesce(sum(points) FILTER(WHERE status='awarded'),0)::text "awardedPoints",count(*) FILTER(WHERE release='current')::integer "currentFamilyReleases" FROM selected),
expanded AS(SELECT a.*,d.dimension,d.key FROM selected a CROSS JOIN LATERAL(VALUES('hub',a.hub_id::text),('class',a.class_id::text),('type',a.type_id::text||':'||a.type_version::text),('week',date_trunc('week',a.earned_on::timestamp)::date::text),('status',a.status),('release',a.release)) d(dimension,key)),
groups AS(SELECT dimension,key,count(*)::integer awards,count(DISTINCT student_id)::integer students,count(*) FILTER(WHERE status='awarded')::integer awarded,count(*) FILTER(WHERE status='revoked')::integer revoked,coalesce(sum(points) FILTER(WHERE status='awarded'),0)::text "awardedPoints",count(*) FILTER(WHERE release='current')::integer "currentFamilyReleases",CASE WHEN dimension='type' THEN min(type_version) END "typeVersion",CASE WHEN dimension='type' THEN (jsonb_agg(labels ORDER BY id)->0) END labels FROM expanded GROUP BY dimension,key),
charts AS(SELECT dimension,jsonb_agg(jsonb_strip_nulls(to_jsonb(g)-'dimension')||jsonb_build_object('key',g.key) ORDER BY key NULLS FIRST) items FROM groups g GROUP BY dimension)
SELECT (SELECT count(*)::integer FROM selected) "sourceCount",to_jsonb(totals) summary,coalesce((SELECT jsonb_object_agg(dimension,items) FROM charts),'{}'::jsonb) charts,to_char(statement_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') "snapshotAt" FROM totals`;
export async function achievementReport(ctx:ApiContext):Promise<Reply|null>{
 if(ctx.path!=='reports/community/achievements')return null;if(ctx.request.method!=='GET')throw new ApiError(405,'METHOD_NOT_ALLOWED');const p=new URL(ctx.request.url).searchParams;if([...p].length!==new Set(p.keys()).size)throw new ApiError(400,'DUPLICATE_QUERY');const q=achievementReportQuery.parse(Object.fromEntries(p));await lockApprovalWrites(ctx);
 const scopes=['achievement-reports.view','achievements.view'].map(c=>permissionScope(ctx,c as 'achievement-reports.view'|'achievements.view'));if(scopes.some(s=>!scopeNonempty(s)))throw new ApiError(403,'FORBIDDEN');
 const r=(await ctx.db.query<Report>(sql,[q.from,q.through,q.hubId??null,q.classId??null,q.studentId??null,q.typeId??null,q.status,JSON.stringify(scopes[0]),JSON.stringify(scopes[1]),q.release,achievementReportSourceLimit+1])).rows[0];checkAchievementReportBudget(r.sourceCount,dimensions.map(d=>r.charts[d]?.length??0));
 return {status:200,body:{data:{report:'school_achievements',snapshotAt:r.snapshotAt,filters:q,summary:r.summary,charts:Object.fromEntries(dimensions.map(d=>[d,r.charts[d]??[]])),coverage:'complete_current_permitted_records_within_limits',chartCoverage:'same_complete_filtered_source_as_totals',pointBasis:'pinned_school_definition_awarded_records_only_not_an_accreditation_or_ranking',weekBasis:'ISO_civil_earned_date_Monday',releaseBasis:'current_exact_award_source_only_not_recipient_eligibility_or_delivery',countBasis:'current_status_not_as_of_history',sourceAccessRechecked:true,privateBodiesIncluded:false,leaderboardUpdated:false,publiclyPublished:false,externalRequestMade:false}}};
}
export const achievementReportContract=[{path:'/api/v1/reports/community/achievements',method:'get',summary:'Complete scoped achievement totals and hub/class/pinned-type/week/status/private-release chart data; intersect report and source rights before all filters,counts and charts; exact awarded-only points,no captions,student names or private context; bounded full aggregation refuses oversized reports,not a public leaderboard',querySchema:achievementReportQuery}] as const;
