import { z } from 'zod';
import type { ApiContext,Reply } from '../core/api.ts';
import { ApiError } from '../core/policy.ts';
import { accountingDate } from './finance-periods.ts';
import { receivedStudentScope } from './family-access.ts';

const uuid=z.string().uuid().transform(v=>v.toLowerCase()),empty=z.object({}).strict();
const paging={limit:z.coerce.number().int().min(1).max(50).default(20),after:uuid.optional()};
const query=z.object({...paging,on:accountingDate.optional(),enabled:z.enum(['true','false']).optional(),hubId:uuid.optional(),classId:uuid.optional()}).strict();
const packagesQuery=z.object({...paging,limit:z.coerce.number().int().min(1).max(20).default(10)}).strict();
export async function receivedEnrollments(ctx:ApiContext):Promise<Reply|null>{
 const m=/^students\/([^/]+)\/registrations(?:\/([^/]+)(?:\/(agreements))?)?$/.exec(ctx.path);if(!m)return null;
 if(ctx.request.method!=='GET')throw new ApiError(405,'METHOD_NOT_ALLOWED');
 const studentId=uuid.parse(m[1]),id=m[2]?uuid.parse(m[2]):null,agreements=Boolean(m[3]),params=new URL(ctx.request.url).searchParams;
 if([...params].length!==new Set(params.keys()).size)throw new ApiError(400,'DUPLICATE_QUERY');
 const q=!id?query.parse(Object.fromEntries(params)):null,pq=agreements?packagesQuery.parse(Object.fromEntries(params)):null;if(id&&!agreements)empty.parse(Object.fromEntries(params));
 const scope=await receivedStudentScope(ctx,studentId,'received-enrollments.view');
 const rows=(await ctx.db.query<{id:string;[key:string]:unknown}>(`WITH recipient AS MATERIALIZED(SELECT public.registration_data_basis($1,$2) IS NOT NULL allowed)
 SELECT e.id,e.version,e.class_id "classId",e.hub_id "hubId",e.joins_on::text "joinsOn",e.leaves_on::text "leavesOn",e.enabled,c.name "className",c.code "classCode",c.time_zone "timeZone",c.mode,c.active "classActive",h.name "hubName",h.active "hubActive",c.course_id "courseId",c.course_version "courseVersion",v.definition->>'name' "courseName"
 ${id&&!agreements?`,(SELECT jsonb_build_object('pastScheduled',count(*) FILTER(WHERE s.status='scheduled' AND s.ends_at<=statement_timestamp()),'inProgressScheduled',count(*) FILTER(WHERE s.status='scheduled' AND s.starts_at<=statement_timestamp() AND s.ends_at>statement_timestamp()),'upcomingScheduled',count(*) FILTER(WHERE s.status='scheduled' AND s.starts_at>statement_timestamp()),'cancelled',count(*) FILTER(WHERE s.status='cancelled')) FROM public.class_sessions s WHERE s.academy_id=e.academy_id AND s.class_id=e.class_id AND(s.starts_at AT TIME ZONE c.time_zone)::date>=e.joins_on AND(e.leaves_on IS NULL OR(s.starts_at AT TIME ZONE c.time_zone)::date<=e.leaves_on)) "currentScheduleCounts"`:''}
 FROM public.class_enrollments e JOIN public.classes c ON c.academy_id=e.academy_id AND c.id=e.class_id JOIN public.hubs h ON h.academy_id=e.academy_id AND h.id=e.hub_id JOIN public.course_revisions v ON v.academy_id=c.academy_id AND v.course_id=c.course_id AND v.version=c.course_version CROSS JOIN recipient
 WHERE e.student_id=$1 AND recipient.allowed AND public.scope_contains($3::jsonb,jsonb_build_object('all',false,'hubs','[]'::jsonb,'people',jsonb_build_array(jsonb_build_object('id',e.student_id,'hubId',e.hub_id)),'recordContext',jsonb_build_object('hubId',e.hub_id,'classId',e.class_id,'studentId',e.student_id)))
 AND($4::uuid IS NULL OR e.id=$4) AND($5::uuid IS NULL OR e.id>$5) AND($6::date IS NULL OR(e.joins_on<=$6 AND(e.leaves_on IS NULL OR e.leaves_on>=$6))) AND($7::boolean IS NULL OR e.enabled=$7) AND($8::uuid IS NULL OR e.hub_id=$8) AND($9::uuid IS NULL OR e.class_id=$9) ORDER BY e.id LIMIT $10`,[studentId,ctx.credential.person_id,JSON.stringify(scope),id,q?.after??null,q?.on??null,q?.enabled===undefined?null:q.enabled==='true',q?.hubId??null,q?.classId??null,id?1:q!.limit+1])).rows;
 const view=(r:typeof rows[number])=>({...r,requiresSignedAgreement:true,admissionClearanceVerified:false,attendanceIncluded:false,scheduledCountsAreAttendance:false});
 if(!id)return {status:200,body:{studentId,data:rows.slice(0,q!.limit).map(view),nextCursor:rows.length>q!.limit?rows[q!.limit-1].id:null,privateFamilyOnly:true}};
 if(!rows[0])throw new ApiError(404,'NOT_FOUND');if(!agreements)return {status:200,body:{data:view(rows[0]),privateFamilyOnly:true}};
 // Preparation metadata only. Never turn a transport receipt/webhook into
 // verified signature completion,admission or permission to view signer PII.
 const packages=(await ctx.db.query<{id:string;[key:string]:unknown}>(`SELECT p.id,p.locale,p.enrollment_version "enrollmentVersion",p.prepared_on::text "preparedOn",p.prepared_at "preparedAt",p.signer_id=$2 "youAreSigner",EXISTS(SELECT 1 FROM public.agreement_package_contents l WHERE l.academy_id=p.academy_id AND l.package_id=p.id) "contentAttached",
 (SELECT count(*)::integer FROM public.signature_send_requests r WHERE r.academy_id=p.academy_id AND r.package_id=p.id) "sendRequestCount"
 FROM public.agreement_packages p JOIN public.approval_requests a ON a.academy_id=p.academy_id AND a.id=p.approval_id AND a.status='applied' AND a.action='agreement.prepare' AND a.target_id=p.id AND a.reviewer_id=p.created_by
 WHERE p.enrollment_id=$1 AND($3::uuid IS NULL OR p.id>$3) ORDER BY p.id LIMIT $4`,[id,ctx.credential.person_id,pq!.after??null,pq!.limit+1])).rows;
 return {status:200,body:{studentId,enrollmentId:id,data:packages.slice(0,pq!.limit).map(p=>({...p,stage:'prepared',signatureCompletionVerified:false,admissionCleared:false,signingLinkIncluded:false})),nextCursor:packages.length>pq!.limit?packages[pq!.limit-1].id:null,privateFamilyOnly:true}};
}
export const receivedEnrollmentsContract=[
 {path:'/api/v1/students/{id}/registrations',method:'get',humanOnly:true,summary:'Own/current verified legal family class registrations under independently configured received-enrollments.view. Native exact student/class/actual-hub scope precedes bounded paging;optional on applies inclusive joining/leaving dates. No peer roster,private profile,finance or admin grant;registration does not mean signed admission.',querySchema:query},
 {path:'/api/v1/students/{id}/registrations/{enrollmentId}',method:'get',humanOnly:true,summary:'Current own/family registration details with class/hub/course labels and membership-date-filtered current schedule counts. Past scheduled sessions are NOT observed/effective attendance or verified agreement clearance;no meeting link or guardian contacts.',querySchema:empty},
 {path:'/api/v1/students/{id}/registrations/{enrollmentId}/agreements',method:'get',humanOnly:true,summary:'Bounded approved unified-agreement preparation receipts and send-request counts only. No other guardian identity,contact/provider IDs,source fingerprints,private notes or signing bearer links. Neither preparation nor sending proves signature completion or admission.',querySchema:packagesQuery}
] as const;
