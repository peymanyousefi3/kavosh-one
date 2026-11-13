import { z } from 'zod';
import type { ApiContext,Reply } from '../core/api.ts';
import { ApiError } from '../core/policy.ts';
import { lockApprovalWrites } from '../core/approvals.ts';
import { permittedSignatureSend } from './signature-sends.ts';
import { permittedWorkSignatureEvidence } from './work-signature-completions.ts';

const uuid=z.string().uuid().transform(v=>v.toLowerCase());
const paging=z.object({afterAttempt:z.coerce.number().int().min(0).max(2147483647).default(0),limit:z.coerce.number().int().min(1).max(50).default(20)}).strict();
const markers={workerLiveness:'not_observed',providerStatusFreshlyChecked:false,admissionCleared:false,paymentCleared:false,documentAccessGranted:false} as const;
export async function permittedCompletionCheck(ctx:ApiContext,requestId:string,work:boolean){
 await lockApprovalWrites(ctx);
 if(work)await permittedWorkSignatureEvidence(ctx,requestId);else await permittedSignatureSend(ctx,requestId,'signature-completions.view');
 const prefix=work?'work_signature':'signature',purpose=work?'worker_services' as const:'unified_enrollment' as const;
 const start=(await ctx.db.query<{id:string}>(`SELECT s.id FROM public.${prefix}_dispatch_starts s JOIN public.${prefix}_send_attempts a ON a.academy_id=s.academy_id AND a.id=s.attempt_id WHERE a.request_id=$1`,[requestId])).rows[0];
 return {start,purpose};
}
export async function signatureCompletionStatus(ctx:ApiContext):Promise<Reply|null>{
 const path=/^(payroll\/work-signature-send-requests|signature-send-requests)\/([^/]+)\/completion-check$/.exec(ctx.path);if(!path)return null;
 if(ctx.request.method!=='GET')throw new ApiError(405,'METHOD_NOT_ALLOWED');
 const requestId=uuid.parse(path[2]),params=new URL(ctx.request.url).searchParams;
 if([...params].length!==new Set(params.keys()).size)throw new ApiError(400,'DUPLICATE_QUERY');
 const q=paging.parse(Object.fromEntries(params)),work=path[1].startsWith('payroll/');
 // Identical live feature/data scopes as the original evidence workspace.
 // A cached receipt, tenant membership or guessed request ID is insufficient.
 const {start,purpose}=await permittedCompletionCheck(ctx,requestId,work);
 const data=start?(await ctx.db.query(`SELECT retry_version AS "retryVersion",state,created_at AS "createdAt",poll_until AS "checkWindowEndsAt",available_at AS "retryNotBefore",attempt_no AS "attemptCount",failures AS "consecutiveFailures",last_finished_at AS "lastFinishedAt",last_outcome AS "lastOutcome",evidence_id AS "evidenceId" FROM public.signature_completion_jobs WHERE purpose=$1 AND start_id=$2`,[purpose,start.id])).rows[0]??null:null;
 if(!data){if(q.afterAttempt)throw new ApiError(404,'NOT_FOUND');return {status:200,body:{data:null,attempts:[],nextAfterAttempt:null,...markers}};}
 if(q.afterAttempt&&!(await ctx.db.query('SELECT attempt_no FROM public.signature_completion_job_attempts WHERE purpose=$1 AND start_id=$2 AND attempt_no=$3',[purpose,start!.id,q.afterAttempt])).rows.length)throw new ApiError(404,'NOT_FOUND');
 const attempts=(await ctx.db.query<{attemptNo:number}>('SELECT attempt_no AS "attemptNo",started_at AS "startedAt",finished_at AS "finishedAt",outcome,evidence_id AS "evidenceId" FROM public.signature_completion_job_attempts WHERE purpose=$1 AND start_id=$2 AND attempt_no>$3 ORDER BY attempt_no LIMIT $4',[purpose,start!.id,q.afterAttempt,q.limit+1])).rows;
 return {status:200,body:{data,attempts:attempts.slice(0,q.limit),nextAfterAttempt:attempts.length>q.limit?attempts[q.limit-1].attemptNo:null,...markers}};
}
export const signatureCompletionStatusContract=[
 {path:'/api/v1/signature-send-requests/{id}/completion-check',method:'get',summary:'Current enrollment evidence permissions and original source scopes protect completion-check status and bounded retry history. No worker secrets,provider freshness,document access or admission clearance.',querySchema:paging},
 {path:'/api/v1/payroll/work-signature-send-requests/{id}/completion-check',method:'get',summary:'Current worker evidence permissions and exact original work/template/private-file scopes protect completion-check status and bounded retry history. No worker secrets,legal effect or payment clearance.',querySchema:paging}
] as const;
