import { z } from 'zod';
import type { ApiContext,Reply } from '../core/api.ts';
import { lockApprovalWrites,permissionScope,privacyScopes } from '../core/approvals.ts';
import { ApiError,scopeNonempty,scopeContains,type Capability } from '../core/policy.ts';
import { workEngagementHeader } from './work-engagements.ts';

const uuid=z.string().uuid().transform(v=>v.toLowerCase()),version=z.coerce.number().int().min(1).max(2147483647);
const query=z.object({entryVersion:version,termsVersion:version,limit:z.coerce.number().int().min(1).max(20).default(10),after:uuid.optional()}).strict();
const workCaps=['work-signatures.view','work-signature-completions.view','work-signature-completions.inspect'] as const;
function scope(ctx:ApiContext,cap:Capability){const s=permissionScope(ctx,cap);if(!scopeNonempty(s))throw new ApiError(403,'FORBIDDEN');return s;}
export async function workActivityAgreements(ctx:ApiContext):Promise<Reply|null>{
 const path=/^payroll\/engagements\/([^/]+)\/recorded-time\/([^/]+)\/agreement-context$/.exec(ctx.path);if(!path)return null;
 if(ctx.request.method!=='GET')throw new ApiError(405,'METHOD_NOT_ALLOWED');const engagementId=uuid.parse(path[1]),entryId=uuid.parse(path[2]),params=new URL(ctx.request.url).searchParams;
 if([...params].length!==new Set(params.keys()).size)throw new ApiError(400,'DUPLICATE_QUERY');const q=query.parse(Object.fromEntries(params));
 await lockApprovalWrites(ctx);const work=scope(ctx,'work-pay.view'),time=scope(ctx,'session-time.view');for(const cap of [...workCaps,'agreements.view','work-files.view']as const)scope(ctx,cap);
 const engagement=await workEngagementHeader(ctx,engagementId);
 for(const cap of workCaps)if(!(await ctx.db.query<{ok:boolean}>('SELECT public.work_scope_allows($1::jsonb,$2,$3) ok',[JSON.stringify(permissionScope(ctx,cap)),engagement.hub_id,engagement.person_id])).rows[0].ok)throw new ApiError(404,'NOT_FOUND');
 const entry=(await ctx.db.query<{id:string;version:number;person_id:string;hub_id:string;class_id:string;session_id:string;starts_at:string;ends_at:string;assignment_id:string;assignment_version:number}>('SELECT id,version,person_id,hub_id,class_id,session_id,starts_at::text,ends_at::text,assignment_id,assignment_version FROM public.session_time_entries WHERE id=$1 AND person_id=$2 AND hub_id IS NOT DISTINCT FROM $3::uuid AND public.work_scope_allows($4::jsonb,hub_id,person_id)',[entryId,engagement.person_id,engagement.hub_id,JSON.stringify(work)])).rows[0];
 if(!entry||!scopeContains(time,{all:false,hubs:[],classes:[{id:entry.class_id,hubId:entry.hub_id}]}))throw new ApiError(404,'NOT_FOUND');if(entry.version!==q.entryVersion)throw new ApiError(409,'ACTIVITY_CHANGED');
 if(!(await ctx.db.query('SELECT version FROM public.work_engagement_revisions WHERE engagement_id=$1 AND version=$2',[engagementId,q.termsVersion])).rows.length)throw new ApiError(404,'WORK_TERMS_NOT_FOUND');
 const scopes=JSON.stringify(privacyScopes(ctx));
 // Source privacy BEFORE cursor,limit or context computation. An empty page
 // means no currently visible matching observations,not no school-wide contract.
 const eligible=`FROM public.work_signature_completion_evidence e JOIN public.work_signature_dispatch_starts s ON s.academy_id=e.academy_id AND s.id=e.start_id JOIN public.work_signature_send_attempts a ON a.academy_id=s.academy_id AND a.id=s.attempt_id JOIN public.work_signature_send_requests r ON r.academy_id=a.academy_id AND r.id=a.request_id JOIN public.work_agreement_preparations w ON w.academy_id=r.academy_id AND w.id=r.preparation_id WHERE w.engagement_id=$1 AND w.engagement_version=$2 AND public.work_signature_evidence_notice_allows(s.id,e.id,$3::jsonb)`;
 if(q.after&&!(await ctx.db.query('SELECT e.id '+eligible+' AND e.id=$4',[engagementId,q.termsVersion,scopes,q.after])).rows.length)throw new ApiError(404,'NOT_FOUND');
 const rows=(await ctx.db.query<{id:string;request_id:string;context:Record<string,unknown>|null}>('WITH visible AS MATERIALIZED(SELECT e.id,e.recorded_at,a.request_id '+eligible+' AND($4::uuid IS NULL OR(e.recorded_at,e.id)<(SELECT c.recorded_at,c.id FROM public.work_signature_completion_evidence c WHERE c.id=$4)) ORDER BY e.recorded_at DESC,e.id DESC LIMIT $5) SELECT id,request_id,public.work_activity_agreement_context(id,$6,$7) context FROM visible ORDER BY recorded_at DESC,id DESC',[engagementId,q.termsVersion,scopes,q.after??null,q.limit+1,entryId,q.entryVersion])).rows;
 if(rows.some(r=>r.context===null))throw new ApiError(409,'ACTIVITY_OR_AGREEMENT_SOURCE_CHANGED');
 return {status:200,body:{data:{engagementId,entryId,entryVersion:entry.version,termsVersion:q.termsVersion,personId:entry.person_id,hubId:entry.hub_id,classId:entry.class_id,sessionId:entry.session_id,assignmentId:entry.assignment_id,assignmentVersion:entry.assignment_version,recordedStartsAt:entry.starts_at,recordedEndsAt:entry.ends_at,workTermsPath:'/api/v1/payroll/engagements/'+engagementId+'?version='+q.termsVersion,
  observations:rows.slice(0,q.limit).map(r=>({...r.context,recordPath:'/api/v1/payroll/work-signature-send-requests/'+r.request_id+'/completion-evidence/'+r.id})),nextCursor:rows.length>q.limit?rows[q.limit-1].id:null,
  coverage:'currently_visible_evidence_for_requested_prepared_terms',completeVisiblePage:rows.length<=q.limit,activityRecorded:true,termsApplicabilityIndependentlyVerified:false,signatureRequiredToRetainRecordedWork:false,earnedEntitlementDetermined:false,retroactiveLegalCoverageCertified:false,payrollApproved:false,paymentCleared:false,providerStatusFreshlyChecked:false}}};
}
export const workActivityAgreementsContract=[{path:'/api/v1/payroll/engagements/{id}/recorded-time/{entryId}/agreement-context',method:'get',summary:'Current-authorized actual recorded teaching activity alongside bounded visible contract evidence for explicitly pinned prepared terms. Both human-attested signing times compared to real saved work,never an arbitrary client date. Current view/inspect/work/template/file/class-time rights before paging. Not terms applicability,retroactive legal coverage,payroll approval,payment or a signature gate for earned work.',querySchema:query}]as const;
