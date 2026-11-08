import { z } from 'zod';
import { ApiError } from '../core/policy.ts';
import type { ApiContext,Reply } from '../core/api.ts';
import { lockApprovalWrites } from '../core/approvals.ts';
import { permittedSignatureSend } from './signature-sends.ts';

const uuid=z.string().uuid().transform(v=>v.toLowerCase()),empty=z.object({}).strict();
const paging=z.object({limit:z.coerce.number().int().min(1).max(50).default(20),after:uuid.optional(),state:z.enum(['evidence_recorded','review_required']).optional()}).strict();
const markers={admissionCleared:false,providerStatusFreshlyChecked:false,legalValidityCertified:false,malwareFreeVerified:false} as const;
export async function signatureCompletions(ctx:ApiContext):Promise<Reply|null>{
 const path=/^signature-send-requests\/([^/]+)\/completion-evidence(?:\/([^/]+))?$/.exec(ctx.path);if(!path)return null;
 if(ctx.request.method!=='GET')throw new ApiError(405,'METHOD_NOT_ALLOWED');
 const requestId=uuid.parse(path[1]),id=path[2]?uuid.parse(path[2]):null,params=Object.fromEntries(new URL(ctx.request.url).searchParams),q=id?(empty.parse(params),{limit:1,after:undefined,state:undefined}):paging.parse(params);
 // One intention has one original class/student/signer tuple. The dedicated
 // feature AND all original signing/source scopes must authorize it BEFORE
 // any evidence page is read. History is not a public or family-file grant.
 await lockApprovalWrites(ctx);await permittedSignatureSend(ctx,requestId,'signature-completions.view');
 const start=(await ctx.db.query<{id:string}>(`SELECT s.id FROM public.signature_dispatch_starts s JOIN public.signature_send_attempts a ON a.academy_id=s.academy_id AND a.id=s.attempt_id WHERE a.request_id=$1`,[requestId])).rows[0];
 if(!start){if(id||q.after)throw new ApiError(404,'NOT_FOUND');return {status:200,body:{data:[],nextCursor:null,...markers}};}
 if(q.after&&!(await ctx.db.query('SELECT id FROM public.signature_completion_evidence WHERE start_id=$1 AND id=$2 AND($3::text IS NULL OR state=$3)',[start.id,q.after,q.state??null])).rows.length)throw new ApiError(404,'NOT_FOUND');
 const rows=(await ctx.db.query<{id:string}>(`SELECT e.id,e.start_id AS "dispatchId",e.state AS "evidenceState",e.review_reasons AS "reviewReasons",e.recorded_at AS "recordedAt",public.signature_completion_source_current(e.id) AS "sourceCorrespondenceCurrent",
 CASE WHEN r.evidence_id IS NULL THEN NULL ELSE jsonb_build_object('version',r.version,'decision',r.input->'decision') END AS "evidenceReview",
 CASE WHEN r.evidence_id IS NULL OR r.input->>'decision'<>'accepted' THEN true ELSE r.source-'scope' IS DISTINCT FROM public.signature_completion_review_source(e.id,r.requested_by,r.input)-'scope' END AS "reviewPending"
 FROM public.signature_completion_evidence e LEFT JOIN public.signature_completion_reviews r ON r.academy_id=e.academy_id AND r.evidence_id=e.id WHERE e.start_id=$1 AND($2::uuid IS NULL OR e.id=$2) AND($3::text IS NULL OR e.state=$3)
 AND($4::uuid IS NULL OR(e.recorded_at,e.id)<(SELECT c.recorded_at,c.id FROM public.signature_completion_evidence c WHERE c.start_id=$1 AND c.id=$4))
 ORDER BY e.recorded_at DESC,e.id DESC LIMIT $5`,[start.id,id,q.state??null,q.after??null,id?1:q.limit+1])).rows;
 if(id){if(!rows.length)throw new ApiError(404,'NOT_FOUND');return {status:200,body:{data:{...rows[0],...markers}}};}
 return {status:200,body:{data:rows.slice(0,q.limit).map(row=>({...row,...markers})),nextCursor:rows.length>q.limit?rows[q.limit-1].id:null,...markers}};
}
export const signatureCompletionsContract=[
 {path:'/api/v1/signature-send-requests/{id}/completion-evidence',method:'get',summary:'Scoped newest-first metadata of immutable completion observations;not private artifacts,upper approval,current provider status or admission',querySchema:paging},
 {path:'/api/v1/signature-send-requests/{id}/completion-evidence/{evidenceId}',method:'get',summary:'Exact owned signing-evidence metadata with current historical-source correspondence;no archive access,approval or waiver override'}
] as const;
