import { z } from 'zod';
import type { ApiContext,Reply } from '../core/api.ts';
import { ApiError } from '../core/policy.ts';
import { permittedCompletionCheck } from './signature-completion-status.ts';

const uuid=z.string().uuid().transform(v=>v.toLowerCase());
const paging=z.object({limit:z.coerce.number().int().min(1).max(50).default(20),after:uuid.optional()}).strict();
const markers={caseResolvedByReading:false,providerStatusFreshlyChecked:false,admissionCleared:false,paymentCleared:false,externalNotificationDeliveryVerified:false} as const;
export async function signatureCompletionIncidents(ctx:ApiContext):Promise<Reply|null>{
 const path=/^(payroll\/work-signature-send-requests|signature-send-requests)\/([^/]+)\/completion-check\/incidents$/.exec(ctx.path);if(!path)return null;
 if(ctx.request.method!=='GET')throw new ApiError(405,'METHOD_NOT_ALLOWED');
 const requestId=uuid.parse(path[2]),params=new URL(ctx.request.url).searchParams;
 if([...params].length!==new Set(params.keys()).size)throw new ApiError(400,'DUPLICATE_QUERY');
 const q=paging.parse(Object.fromEntries(params)),{start,purpose}=await permittedCompletionCheck(ctx,requestId,path[1].startsWith('payroll/'));
 if(!start){if(q.after)throw new ApiError(404,'NOT_FOUND');return {status:200,body:{data:[],nextCursor:null,...markers}};}
 if(q.after&&!(await ctx.db.query('SELECT id FROM public.signature_completion_incidents WHERE purpose=$1 AND start_id=$2 AND id=$3',[purpose,start.id,q.after])).rows.length)throw new ApiError(404,'NOT_FOUND');
 const rows=(await ctx.db.query<{id:string}>('SELECT i.id,i.retry_version AS "retryVersion",i.attempt_no AS "attemptNo",i.reason_code AS "reasonCode",i.recorded_at AS "recordedAt",(j.state=\'blocked\' AND j.retry_version=i.retry_version) AS "attentionStillCurrent" FROM public.signature_completion_incidents i JOIN public.signature_completion_jobs j ON j.academy_id=i.academy_id AND j.purpose=i.purpose AND j.start_id=i.start_id WHERE i.purpose=$1 AND i.start_id=$2 AND($3::uuid IS NULL OR(i.recorded_at,i.id)<(SELECT x.recorded_at,x.id FROM public.signature_completion_incidents x WHERE x.purpose=$1 AND x.start_id=$2 AND x.id=$3)) ORDER BY i.recorded_at DESC,i.id DESC LIMIT $4',[purpose,start.id,q.after??null,q.limit+1])).rows;
 return {status:200,body:{data:rows.slice(0,q.limit),nextCursor:rows.length>q.limit?rows[q.limit-1].id:null,...markers}};
}
export const signatureCompletionIncidentsContract=['signature-send-requests','payroll/work-signature-send-requests'].map(prefix=>({path:'/api/v1/'+prefix+'/{id}/completion-check/incidents',method:'get' as const,summary:'Current original evidence/source scopes protect bounded immutable completion-check failures. Original observations remain after an approved recheck; reading does not resolve a case. No historical-alert reconstruction,private worker/provider details,admission or payment clearance.',querySchema:paging}));
