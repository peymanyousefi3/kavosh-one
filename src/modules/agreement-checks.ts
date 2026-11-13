import { z } from 'zod';
import type { ApiContext,Reply } from '../core/api.ts';
import { ApiError,scopeNonempty } from '../core/policy.ts';
import { approvalReadParameters,permissionScope,lockApprovalWrites } from '../core/approvals.ts';

const uuid=z.string().uuid().transform(v=>v.toLowerCase());
const filter=z.object({purpose:z.enum(['unified_enrollment','worker_services']).optional(),hubId:uuid.optional(),attention:z.enum(['current','historical','all']).default('current')}).strict();
const paging=filter.safeExtend({limit:z.coerce.number().int().min(1).max(50).default(20),afterRecordedAt:z.iso.datetime({offset:true}).optional(),afterId:uuid.optional()}).refine(v=>(v.afterRecordedAt===undefined)===(v.afterId===undefined));
const current="(j.state='blocked' AND j.retry_version=i.retry_version)";
// Include retained pre-alert incidents too. Do not infer provenance or create
// an automation envelope for them merely to make a management queue work.
const from=`FROM public.signature_completion_incidents i JOIN public.signature_completion_jobs j ON j.academy_id=i.academy_id AND j.purpose=i.purpose AND j.start_id=i.start_id
 JOIN LATERAL(
  SELECT a.request_id,p.hub_id FROM public.signature_dispatch_starts s JOIN public.signature_send_attempts a ON a.academy_id=s.academy_id AND a.id=s.attempt_id JOIN public.signature_send_requests r ON r.academy_id=a.academy_id AND r.id=a.request_id JOIN public.agreement_packages p ON p.academy_id=r.academy_id AND p.id=r.package_id WHERE i.purpose='unified_enrollment' AND s.academy_id=i.academy_id AND s.id=i.start_id
  UNION ALL
  SELECT a.request_id,p.hub_id FROM public.work_signature_dispatch_starts s JOIN public.work_signature_send_attempts a ON a.academy_id=s.academy_id AND a.id=s.attempt_id JOIN public.work_signature_send_requests r ON r.academy_id=a.academy_id AND r.id=a.request_id JOIN public.work_agreement_preparations p ON p.academy_id=r.academy_id AND p.id=r.preparation_id WHERE i.purpose='worker_services' AND s.academy_id=i.academy_id AND s.id=i.start_id
 ) parent ON true
 WHERE($1::boolean OR public.signature_check_notice_allows(i.id,$2::jsonb)) AND($3::text IS NULL OR i.purpose=$3) AND($4::uuid IS NULL OR parent.hub_id=$4) AND($5::text='all' OR($5::text='current')=${current})`;
const flags={scope:'current_authorized_original_sources_only',permissionsAppliedBeforeAggregation:true,caseResolvedByReading:false,notificationsMarkedRead:false,providerStatusFreshlyChecked:false,admissionCleared:false,paymentCleared:false,externalRequestMade:false} as const;
type Row={id:string;purpose:'unified_enrollment'|'worker_services';requestId:string;hubId:string|null;recordedAt:string;attentionStillCurrent:boolean};
export async function agreementChecks(ctx:ApiContext):Promise<Reply|null>{
 if(!['agreement-checks','agreement-checks/summary'].includes(ctx.path))return null;
 if(ctx.request.method!=='GET')throw new ApiError(405,'METHOD_NOT_ALLOWED');
 if(!['signature-completions.view','work-signature-completions.view'].some(cap=>scopeNonempty(permissionScope(ctx,cap as 'signature-completions.view'|'work-signature-completions.view'))))throw new ApiError(403,'FORBIDDEN');
 const params=new URL(ctx.request.url).searchParams;if([...params].length!==new Set(params.keys()).size)throw new ApiError(400,'DUPLICATE_QUERY');
 const summary=ctx.path.endsWith('/summary'),q=summary?filter.parse(Object.fromEntries(params)):paging.parse(Object.fromEntries(params));await lockApprovalWrites(ctx);
 const policy=await approvalReadParameters(ctx),values=[policy[0],policy[4],q.purpose??null,q.hubId??null,q.attention];
 if(summary){const rows=(await ctx.db.query(`SELECT i.purpose,i.reason_code AS "reasonCode",${current} AS "attentionStillCurrent",count(*)::text count ${from} GROUP BY i.purpose,i.reason_code,${current} ORDER BY i.purpose,i.reason_code,"attentionStillCurrent"`,values)).rows;return {status:200,body:{data:rows,...flags,countCoverage:'complete_current_authorized_selection'}};}
 const page=q as z.infer<typeof paging>,rows=(await ctx.db.query<Row>(`SELECT i.id,i.purpose,parent.request_id AS "requestId",parent.hub_id AS "hubId",i.retry_version AS "retryVersion",i.attempt_no AS "attemptNo",i.reason_code AS "reasonCode",to_char(i.recorded_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "recordedAt",${current} AS "attentionStillCurrent" ${from} AND($6::timestamptz IS NULL OR(i.recorded_at,i.id)<($6::timestamptz,$7::uuid)) ORDER BY i.recorded_at DESC,i.id DESC LIMIT $8`,[...values,page.afterRecordedAt??null,page.afterId??null,page.limit+1])).rows;
 const tail=rows[page.limit-1];return {status:200,body:{data:rows.slice(0,page.limit).map(row=>({...row,recordPath:'/api/v1/'+(row.purpose==='worker_services'?'payroll/work-signature-send-requests/':'signature-send-requests/')+row.requestId+'/completion-check'})),nextCursor:rows.length>page.limit?{afterRecordedAt:tail.recordedAt,afterId:tail.id}:null,...flags,countCoverage:'current_authorized_page_only'}};
}
export const agreementChecksContract=[
 {path:'/api/v1/agreement-checks',method:'get',querySchema:paging,summary:'One permission-aware enrollment/worker signing attention queue. Current original completion,work/class/student/guardian/template/file scopes filter BEFORE pagination. Retained pre-alert cases remain visible without invented alerts. Reading never resolves a case or marks notifications read;approved rechecks supersede prior editions. No signer contents,provider secrets,automatic signing or clearance.'},
 {path:'/api/v1/agreement-checks/summary',method:'get',querySchema:filter,summary:'Exact chart-ready purpose/reason/currentness counts over the SAME current authorized signing-case selection,not school-wide unless all source rights are held. No private body,identity,provider freshness or external action.'}
] as const;
