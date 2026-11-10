import { z } from 'zod';
import type { ApiContext } from '../core/api.ts';
import { permissionScope } from '../core/approvals.ts';
import { ApiError,scopeNonempty } from '../core/policy.ts';
import { lockAcademyTopology } from './academy.ts';
import { pollOwnerSQL,type PollDefinition } from './poll-definition.ts';
import { pollRecordSQL } from './poll-responses.ts';

const uuid=z.string().uuid().transform(v=>v.toLowerCase()),version=z.number().int().positive().max(2147483647);
export const pollReportAuthorization=z.object({kind:z.literal('poll_aggregate'),pollId:uuid,formVersion:version,audiencePollVersion:version,contexts:z.array(z.object({studentId:uuid,classId:uuid,hubId:uuid}).strict()).max(10000).refine(a=>new Set(a.map(s=>JSON.stringify([s.studentId,s.classId,s.hubId]))).size===a.length)}).strict();
export function pollReportScopes(ctx:ApiContext){const scopes=(['poll-results.view','polls.view'] as const).map(cap=>permissionScope(ctx,cap));if(scopes.some(s=>!scopeNonempty(s)))throw new ApiError(403,'FORBIDDEN');return scopes;}
type Form={form_version:number;definition:PollDefinition;response_unit:string;respondent_mode:string;state:string;poll_version:number;audience_version:number};
// Same exact-form metadata gate for live reads,enqueue pinning and archives.
// A newer form's recipients cannot grant access to an older question form.
export async function pollReportForm(ctx:ApiContext,id:string,formVersion?:number,audienceVersion?:number){
 await lockAcademyTopology(ctx);const scopes=pollReportScopes(ctx).map(s=>JSON.stringify(s)),recipient=pollRecordSQL("member->'studentId'","member->'classId'","member->'hubId'"),response=pollRecordSQL('r.student_id','r.class_id','r.hub_id');
 const form=(await ctx.db.query<Form>(`SELECT f.form_version,f.definition,f.response_unit,f.respondent_mode,p.state,p.version poll_version,basis.version audience_version
 FROM public.polls p JOIN public.poll_form_revisions f ON f.academy_id=p.academy_id AND f.poll_id=p.id AND f.form_version=coalesce($2::integer,p.form_version)
 JOIN LATERAL(SELECT v.version,v.definition FROM public.poll_revisions v WHERE v.academy_id=p.academy_id AND v.poll_id=p.id AND(v.definition->>'form_version')::integer=f.form_version AND($5::integer IS NULL OR v.version=$5) ORDER BY v.version DESC LIMIT 1) basis ON true WHERE p.id=$1 AND(
 (public.scope_contains($3::jsonb,${pollOwnerSQL}) AND public.scope_contains($4::jsonb,${pollOwnerSQL}))
 OR EXISTS(SELECT 1 FROM jsonb_array_elements(basis.definition#>'{context,source,recipients}') member WHERE public.scope_contains($3::jsonb,${recipient}) AND public.scope_contains($4::jsonb,${recipient}))
 OR EXISTS(SELECT 1 FROM public.poll_responses r WHERE r.academy_id=p.academy_id AND r.poll_id=p.id AND r.form_version=f.form_version AND public.scope_contains($3::jsonb,${response}) AND public.scope_contains($4::jsonb,${response})))`,[id,formVersion??null,...scopes,audienceVersion??null])).rows[0];if(!form)throw new ApiError(404,'NOT_FOUND');return form;
}
export async function requirePollReportResultAccess(ctx:ApiContext,raw:unknown){
 const proof=pollReportAuthorization.parse(raw);await pollReportForm(ctx,proof.pollId,proof.formVersion,proof.audiencePollVersion);const scopes=pollReportScopes(ctx).map(s=>JSON.stringify(s)),target=pollRecordSQL('s."studentId"','s."classId"','s."hubId"');
 const ok=(await ctx.db.query<{ok:boolean}>(`SELECT NOT EXISTS(SELECT 1 FROM jsonb_to_recordset($1::jsonb) s("studentId" uuid,"classId" uuid,"hubId" uuid) WHERE public.scope_contains($2::jsonb,${target}) IS NOT TRUE OR public.scope_contains($3::jsonb,${target}) IS NOT TRUE) ok`,[JSON.stringify(proof.contexts),...scopes])).rows[0]?.ok;if(ok!==true)throw new ApiError(403,'REPORT_SOURCE_ACCESS_CHANGED');
}
