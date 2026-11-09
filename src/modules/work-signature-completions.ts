import { z } from 'zod';
import type { ApiContext,Reply } from '../core/api.ts';
import { ApiError,scopeNonempty } from '../core/policy.ts';
import { lockApprovalWrites,permissionScope } from '../core/approvals.ts';
import { permittedWorkSignatureSend } from './work-signature-sends.ts';

const uuid=z.string().uuid().transform(v=>v.toLowerCase()),empty=z.object({}).strict();
const paging=z.object({limit:z.coerce.number().int().min(1).max(50).default(20),after:uuid.optional(),state:z.enum(['evidence_recorded','review_required']).optional()}).strict();
const markers={reviewPending:true,documentAccessGranted:false,providerStatusFreshlyChecked:false,signedByBothPartiesVerified:false,legallyEffective:false,paymentCleared:false,legalValidityCertified:false,malwareFreeVerified:false} as const;
export async function workSignatureCompletions(ctx:ApiContext):Promise<Reply|null>{
 const path=/^payroll\/work-signature-send-requests\/([^/]+)\/completion-evidence(?:\/([^/]+))?$/.exec(ctx.path);if(!path)return null;
 if(ctx.request.method!=='GET')throw new ApiError(405,'METHOD_NOT_ALLOWED');
 const requestId=uuid.parse(path[1]),id=path[2]?uuid.parse(path[2]):null,params=new URL(ctx.request.url).searchParams;
 if([...params].length!==new Set(params.keys()).size)throw new ApiError(400,'DUPLICATE_QUERY');
 const raw=Object.fromEntries(params),q=id?(empty.parse(raw),{limit:1,after:undefined,state:undefined}):paging.parse(raw);
 await lockApprovalWrites(ctx);const scope=permissionScope(ctx,'work-signature-completions.view');if(!scopeNonempty(scope))throw new ApiError(403,'FORBIDDEN');
 // Independent feature and all actual work/template/private-file scopes are
 // checked BEFORE reading any page. Primary person hub is not work scope.
 const {w}=await permittedWorkSignatureSend(ctx,requestId);
 if(!(await ctx.db.query<{ok:boolean}>('SELECT public.work_scope_allows($1::jsonb,$2,$3) ok',[JSON.stringify(scope),w.hub_id,w.worker_id])).rows[0].ok)throw new ApiError(404,'NOT_FOUND');
 const start=(await ctx.db.query<{id:string}>('SELECT s.id FROM public.work_signature_dispatch_starts s JOIN public.work_signature_send_attempts a ON a.academy_id=s.academy_id AND a.id=s.attempt_id WHERE a.request_id=$1',[requestId])).rows[0];
 if(!start){if(id||q.after)throw new ApiError(404,'NOT_FOUND');return {status:200,body:{data:[],nextCursor:null,...markers}};}
 if(q.after&&!(await ctx.db.query('SELECT id FROM public.work_signature_completion_evidence WHERE start_id=$1 AND id=$2 AND($3::text IS NULL OR state=$3)',[start.id,q.after,q.state??null])).rows.length)throw new ApiError(404,'NOT_FOUND');
 const rows=(await ctx.db.query<{id:string}>('SELECT e.id,e.start_id AS "dispatchId",e.state AS "evidenceState",e.review_reasons AS "reviewReasons",e.recorded_at AS "recordedAt",public.work_signature_completion_source_current(e.id) AS "sourceCorrespondenceCurrent" FROM public.work_signature_completion_evidence e WHERE e.start_id=$1 AND($2::uuid IS NULL OR e.id=$2) AND($3::text IS NULL OR e.state=$3) AND($4::uuid IS NULL OR(e.recorded_at,e.id)<(SELECT c.recorded_at,c.id FROM public.work_signature_completion_evidence c WHERE c.start_id=$1 AND c.id=$4)) ORDER BY e.recorded_at DESC,e.id DESC LIMIT $5',[start.id,id,q.state??null,q.after??null,id?1:q.limit+1])).rows;
 if(id){if(!rows.length)throw new ApiError(404,'NOT_FOUND');return {status:200,body:{data:{...rows[0],...markers}}};}
 return {status:200,body:{data:rows.slice(0,q.limit).map(row=>({...row,...markers})),nextCursor:rows.length>q.limit?rows[q.limit-1].id:null,...markers}};
}
export const workSignatureCompletionsContract=[
 {path:'/api/v1/payroll/work-signature-send-requests/{id}/completion-evidence',method:'get',summary:'Bounded newest-first worker signing evidence metadata in the original work-signing workspace. Independent feature plus current actual work,template and private-file rights before pagination. Not private artifacts,human approval,current provider status,legal effect or payment clearance.',querySchema:paging},
 {path:'/api/v1/payroll/work-signature-send-requests/{id}/completion-evidence/{evidenceId}',method:'get',summary:'Read exact owned immutable worker evidence metadata with fresh historical-source correspondence. No archive location,provider signer identity,download,review or payment override.'}
] as const;
