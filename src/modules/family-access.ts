import { z } from 'zod';
import { record,type ApiContext,type Reply } from '../core/api.ts';
import { lockApprovalWrites,permissionScope } from '../core/approvals.ts';
import { ApiError,scopeNonempty } from '../core/policy.ts';
import { assertSchemaReady } from '../core/database.ts';
import { lockAcademyTopology } from './academy.ts';

const selection={registrations:{capability:'received-enrollments.view',path:'registrations'},tuition:{capability:'received-tuition.view',path:'tuition-invoices'},calendar:{capability:'received-calendar.view',path:'calendar'}} as const;
const query=z.object({for:z.enum(['registrations','tuition','calendar']).default('registrations'),after:z.string().uuid().transform(v=>v.toLowerCase()).optional(),limit:z.coerce.number().int().min(1).max(50).default(20)}).strict();
export async function receivedStudents(ctx:ApiContext):Promise<Reply|null>{
 if(ctx.path!=='me/students')return null;if(ctx.credential.kind!=='human')throw new ApiError(403,'HUMAN_RECIPIENT_REQUIRED');if(ctx.request.method!=='GET')throw new ApiError(405,'METHOD_NOT_ALLOWED');const params=new URL(ctx.request.url).searchParams;if([...params].length!==new Set(params.keys()).size)throw new ApiError(400,'DUPLICATE_QUERY');const q=query.parse(Object.fromEntries(params)),feature=selection[q.for];await assertSchemaReady(ctx.db);await lockApprovalWrites(ctx);await lockAcademyTopology(ctx);const scope=permissionScope(ctx,feature.capability);if(!scopeNonempty(scope))throw new ApiError(403,'FORBIDDEN');
 // This is a recipient selector,not an attendance/enrollment picker. Retain
 // historical/future registrations for financial/onboarding navigation;each
 // resource still applies its own original-record and joining-date rules.
 const rows=(await ctx.db.query<{studentId:string;displayName:string;isSelf:boolean}>(`WITH candidates AS MATERIALIZED(SELECT $1::uuid id UNION SELECT student_id FROM public.family_relationships WHERE guardian_id=$1)
 SELECT s.person_id "studentId",coalesce(s.preferred_name,s.legal_name) "displayName",s.person_id=$1 "isSelf"
 FROM candidates c JOIN public.student_profiles s ON s.person_id=c.id JOIN public.people p ON p.academy_id=s.academy_id AND p.id=s.person_id
 WHERE public.registration_data_basis(s.person_id,$1) IS NOT NULL AND($2::uuid IS NULL OR s.person_id>$2)
 AND(public.scope_contains($3::jsonb,jsonb_build_object('all',false,'hubs','[]'::jsonb,'people',jsonb_build_array(jsonb_build_object('id',s.person_id,'hubId',p.hub_id))))
 OR EXISTS(SELECT 1 FROM public.class_enrollments e WHERE e.academy_id=s.academy_id AND e.student_id=s.person_id AND public.scope_contains($3::jsonb,jsonb_build_object('all',false,'hubs','[]'::jsonb,'people',jsonb_build_array(jsonb_build_object('id',s.person_id,'hubId',e.hub_id)),'recordContext',jsonb_build_object('hubId',e.hub_id,'classId',e.class_id,'studentId',s.person_id)))))
 ORDER BY s.person_id LIMIT $4`,[ctx.credential.person_id,q.after??null,JSON.stringify(scope),q.limit+1])).rows;
 await record(ctx.db,ctx.credential,ctx.requestId,'family.student-selector.read',ctx.credential.person_id,null,{feature:q.for,rows:Math.min(rows.length,q.limit),privateContentRedacted:true});
 return{status:200,body:{for:q.for,data:rows.slice(0,q.limit).map(r=>({studentId:r.studentId,displayName:r.displayName,isSelf:r.isSelf,resourcePath:'/api/v1/students/'+r.studentId+'/'+feature.path})),nextCursor:rows.length>q.limit?rows[q.limit-1].studentId:null,ownOrCurrentFamilyOnly:true,recordAccessRechecked:true,recordsIncluded:false,administrativeAccessGranted:false}};
}
export const receivedStudentsContract=[{path:'/api/v1/me/students',method:'get',humanOnly:true,summary:'Bounded own/current verified-family student selector for registrations(default),tuition or calendar,under that feature\'s independent current scope before paging. Minimal preferred/legal display label and resource path only;no DOB,guardian contacts,other family identities,finance or learning data. Exact class/original-record hub scopes can locate a child outside the primary hub. Historical/future enrollment navigation is not attendance selection;resource routes still enforce their own joining dates,filters and grants. Master/admin roles cannot impersonate family. No new role or access grant;available read-only.',querySchema:query}] as const;

// Registration authority includes pending children,not disabled children.
// Each feature still requires its own independently configured scope.
export async function receivedStudentScope(ctx:ApiContext,studentId:string,capability:'received-tuition.view'|'received-enrollments.view'|'received-calendar.view'){
 if(ctx.credential.kind!=='human')throw new ApiError(403,'HUMAN_RECIPIENT_REQUIRED');
 await lockApprovalWrites(ctx);const scope=permissionScope(ctx,capability);if(!scopeNonempty(scope))throw new ApiError(403,'FORBIDDEN');
 if(!(await ctx.db.query<{v:boolean}>('SELECT public.registration_data_basis($1,$2) IS NOT NULL v',[studentId,ctx.credential.person_id])).rows[0].v)throw new ApiError(404,'NOT_FOUND');return scope;
}
