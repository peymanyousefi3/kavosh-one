import { z } from 'zod';
import type { ApiContext,Reply } from '../core/api.ts';
import { lockApprovalWrites } from '../core/approvals.ts';
import { ApiError } from '../core/policy.ts';
import { classRow,sessionRow,sessionLocalDate } from './classes.ts';

const uuid=z.string().uuid().transform(v=>v.toLowerCase()),empty=z.object({}).strict();
export type StaffNote={text:string;audience:'session_teaching_team';createdAt:string};
export async function sessionStaffNotes(ctx:ApiContext,id:string,versions:number[]){
 if(!versions.length)return new Map<number,StaffNote>();const rows=(await ctx.db.query<{review_version:number;body:string;audience:'session_teaching_team';created_at:string}>('SELECT review_version,body,audience,created_at::text FROM public.session_evidence_staff_notes WHERE session_id=$1 AND review_version=ANY($2::integer[])',[id,versions])).rows;
 return new Map(rows.map(r=>[r.review_version,{text:r.body,audience:r.audience,createdAt:r.created_at}]));
}
export async function sessionStaffFeedback(ctx:ApiContext):Promise<Reply|null>{
 const match=/^sessions\/([^/]+)\/my-evidence-feedback$/.exec(ctx.path);if(!match)return null;if(ctx.request.method!=='GET')throw new ApiError(405,'METHOD_NOT_ALLOWED');if(ctx.credential.kind!=='human')throw new ApiError(403,'HUMAN_STAFF_REQUIRED');
 empty.parse(Object.fromEntries(new URL(ctx.request.url).searchParams));const id=uuid.parse(match[1]);await lockApprovalWrites(ctx);const s=await sessionRow(ctx,id,'session-staff-feedback.view'),c=await classRow(ctx,s.class_id,'session-staff-feedback.view');let on:string|null;
 try{on=sessionLocalDate(s,c.time_zone);}catch(error){if(error instanceof ApiError&&error.status===409)on=null;else throw error;}
 // Current dated staffing, retained own delivered time or the current review's
 // frozen staffing snapshot establishes a relationship. A grant alone does not.
 // Only current feedback is exposed, so do not scan all historical revisions.
 const person=ctx.credential.person_id,eligible=(await ctx.db.query<{eligible:boolean}>(`SELECT EXISTS(SELECT 1 FROM public.class_staff WHERE class_id=$1 AND person_id=$2 AND active AND $3::date IS NOT NULL AND starts_on<=$3::date AND(ends_on IS NULL OR ends_on>=$3::date))
 OR EXISTS(SELECT 1 FROM public.session_time_entries WHERE session_id=$4 AND person_id=$2)
 OR EXISTS(SELECT 1 FROM public.session_evidence_reviews WHERE session_id=$4 AND public.session_staff_note_recipient(source,$2)) eligible`,[s.class_id,person,on,id])).rows[0].eligible;if(!eligible)throw new ApiError(404,'NOT_FOUND');
 // Only the CURRENT explicitly shared note is staff-readable. Private reasons,
 // prior note text, peer time and source snapshots stay in the admin history.
 // Frozen recipients are filtered before projection; later assignments cannot
 // silently inherit an older teaching team's message.
 const row=(await ctx.db.query<{review_version:number;decision:string;body:string;audience:string;created_at:string}>(`SELECT r.version review_version,r.decision,n.body,n.audience,n.created_at::text FROM public.session_evidence_reviews r JOIN public.session_evidence_staff_notes n ON n.academy_id=r.academy_id AND n.session_id=r.session_id AND n.review_version=r.version
 WHERE r.session_id=$1 AND public.session_staff_note_recipient(r.source,$2)`,[id,person])).rows[0];
 return {status:200,body:{data:row?{sessionId:id,reviewVersion:row.review_version,decisionAtReview:row.decision,staffNote:{text:row.body,audience:row.audience,createdAt:row.created_at},privateAdminReasonIncluded:false,peerTimeIncluded:false,payInformationIncluded:false}:null,visibility:'current_explicit_shared_note_for_frozen_teaching_team'}};
}
export const sessionStaffFeedbackContract=[{path:'/api/v1/sessions/{id}/my-evidence-feedback',method:'get',summary:'Verified human own-session current explicitly shared teaching-team feedback; dedicated class grant plus actual own staffing/time/reviewed relationship and frozen recipients; no private reason, peer hours, financial data or historical note-text endpoint; bots cannot impersonate staff'}] as const;
