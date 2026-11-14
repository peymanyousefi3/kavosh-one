import {z} from 'zod';
import {isDeepStrictEqual} from 'node:util';
import {jsonBody,record,type ApiContext,type Reply} from '../core/api.ts';
import {permissionScope,propose,master,lockApprovalWrites,type ApprovalRegistry,type Proposal} from '../core/approvals.ts';
import {lockFinanceBook} from '../core/finance-lock.ts';
import {ApiError,scopeNonempty,type Capability} from '../core/policy.ts';
import {authorizedNetPosting} from './payrun-postings.ts';

const uuid=z.string().uuid().transform(v=>v.toLowerCase()),text=z.string().trim().min(1).refine(v=>v.isWellFormed()&&!/[\u0000-\u001f\u007f]/.test(v));
const definition=z.object({settledAt:z.iso.datetime({offset:true}).max(40).refine(v=>v.slice(0,10)>='1900-01-01'&&!/[.]\d{7}/.test(v)),timeZone:z.string().min(1).max(100).regex(/^[A-Za-z0-9_+./-]+$/),reference:text.max(200),review:text.max(2000)}).strict();
const change=z.object({expectedVersion:z.number().int().min(0).max(2147483646),definition:definition.nullable(),reason:text.max(2000)}).strict().refine(v=>v.expectedVersion>0||v.definition!==null),input=change.safeExtend({postingId:uuid}),empty=z.object({}).strict();
const history=z.object({afterVersion:z.coerce.number().int().min(0).max(2147483647).default(0),limit:z.coerce.number().int().min(1).max(10).default(5)}).strict();
async function authority(ctx:ApiContext,id:string,edit=false){
 const p=await authorizedNetPosting(ctx,id);for(const cap of ['payrun-payments.view',...edit?['payrun-payments.edit']:[]] as Capability[]){const scope=permissionScope(ctx,cap);if(!scopeNonempty(scope))throw new ApiError(403,'FORBIDDEN');if(!(await ctx.db.query<{ok:boolean}>('SELECT public.scope_contains($1::jsonb,$2::jsonb) ok',[JSON.stringify(scope),JSON.stringify(p.plan.source.scope)])).rows[0].ok)throw new ApiError(404,'NOT_FOUND');}return p;
}
export {authority as authorizedZeroNetPosting};
async function plan(ctx:ApiContext,raw:unknown){
 const i=input.parse(raw);await authority(ctx,i.postingId,true);
 const h=(await ctx.db.query<{version:number}>('SELECT version FROM public.zero_net_settlements WHERE posting_id=$1',[i.postingId])).rows[0];if((h?.version??0)!==i.expectedVersion)throw new ApiError(409,'ZERO_NET_SETTLEMENT_VERSION_CHANGED');
 const b=(await ctx.db.query<{plan:Record<string,unknown>&{unavailable:string|null}}>('SELECT public.zero_net_settlement_plan($1,$2,$3::jsonb) plan',[i.postingId,i.expectedVersion,JSON.stringify(i.definition)])).rows[0].plan;
 if(!b)throw new ApiError(404,'NOT_FOUND');if(b.unavailable)throw new ApiError(409,b.unavailable);return b;
}
async function detail(ctx:ApiContext,id:string){
 const p=await authority(ctx,id),r=(await ctx.db.query<{version:number;state:string;definition:unknown;settled_on:string|null;changed_by:string;approval_id:string;created_at:string}>(`SELECT r.version,r.state,r.definition,r.source_snapshot->>'settledOn' settled_on,r.changed_by,r.approval_id,r.created_at::text FROM public.zero_net_settlements h JOIN public.zero_net_settlement_revisions r ON r.academy_id=h.academy_id AND r.posting_id=h.posting_id AND r.version=h.version WHERE h.posting_id=$1`,[id])).rows[0];if(!r)throw new ApiError(404,'NOT_FOUND');
 return {postingId:id,version:r.version,state:r.state,definition:r.definition,settledOn:r.settled_on,recordedAt:r.created_at,changedBy:r.changed_by,approvalId:r.approval_id,currentPostingReversed:p.reversal_id!==null,attestationWithdrawn:r.state==='withdrawn',basis:'explicit_reviewed_zero_net_no_cash_settlement',bankVerified:false,paymentExecuted:false,additionalLedgerPosting:false,taxYearAssigned:false,taxRecognitionPerformed:false,deductionRemittancesVerified:false};
}
async function apply(ctx:ApiContext,p:Proposal){
 if(ctx.credential.kind!=='human')throw new ApiError(403,'HUMAN_REVIEW_REQUIRED');const i=input.parse(p.payload),b=await plan(ctx,i);if(!isDeepStrictEqual(b,p.review_context))throw new ApiError(409,'ZERO_NET_SETTLEMENT_SOURCE_CHANGED');
 if(i.expectedVersion===0)await ctx.db.query('INSERT INTO public.zero_net_settlements(academy_id,posting_id) VALUES($1,$2)',[ctx.credential.academy_id,i.postingId]);else await ctx.db.query('UPDATE public.zero_net_settlements SET version=version+1 WHERE posting_id=$1',[i.postingId]);
 await ctx.db.query('INSERT INTO public.zero_net_settlement_revisions(academy_id,posting_id,version,definition,source_snapshot,changed_by,approval_id,reason) VALUES($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7,$8)',[ctx.credential.academy_id,i.postingId,i.expectedVersion+1,JSON.stringify(i.definition),JSON.stringify(b),ctx.credential.person_id,p.id,i.reason]);
 await record(ctx.db,ctx.credential,ctx.requestId,p.action,i.postingId,null,{version:i.expectedVersion+1,approvalId:p.id,severity:'critical',privateContentRedacted:true,paymentExecuted:false,additionalLedgerPosting:false});return detail(ctx,i.postingId);
}
export const zeroNetSettlementActions:ApprovalRegistry={'work.zero-net-settlement.change':{requestCapability:'payrun-payments.edit',privacyCapability:'payrun-payments.view',
 async validate(ctx,id,raw){const i=input.parse(raw);await lockFinanceBook(ctx);const p=await authority(ctx,i.postingId,true);await ctx.db.query('SELECT public.lock_hourly_worker($1)',[p.plan.source.personId]);return p.plan.source.scope;},
 async dependencies(ctx,id,raw,purpose){try{return await plan(ctx,raw);}catch(e){if(purpose==='review'&&e instanceof ApiError&&[400,403,404,409,422].includes(e.status))return {unavailable:e.code};throw e;}},
 async authorizeReviewer(ctx,p){const i=input.parse(p.payload),source=await authority(ctx,i.postingId,true);if(source.plan.source.personId===ctx.credential.person_id&&!await master(ctx))throw new ApiError(403,'BENEFICIARY_REVIEW_FORBIDDEN');},apply
}};
export async function zeroNetSettlements(ctx:ApiContext,registry:ApprovalRegistry=zeroNetSettlementActions):Promise<Reply|null>{
 const m=/^payroll\/net-postings\/([^/]+)\/zero-net-settlement(\/history)?$/.exec(ctx.path);if(!m)return null;const id=uuid.parse(m[1]),params=new URL(ctx.request.url).searchParams;if([...params].length!==new Set(params.keys()).size)throw new ApiError(400,'DUPLICATE_QUERY');const q=Object.fromEntries(params);
 if(ctx.request.method==='POST'&&!m[2]){empty.parse(q);const i=change.parse(await jsonBody(ctx.request,16384));return propose(ctx,registry,'work.zero-net-settlement.change',id,i.expectedVersion,{...i,postingId:id});}
 if(ctx.request.method!=='GET')throw new ApiError(405,'METHOD_NOT_ALLOWED');await lockApprovalWrites(ctx);await lockFinanceBook(ctx);const p=await authority(ctx,id,Boolean(m[2]));await ctx.db.query('SELECT public.lock_hourly_worker($1)',[p.plan.source.personId]);
 if(m[2]){const i=history.parse(q),rows=(await ctx.db.query<{version:number}>(`SELECT version,state,definition,source_snapshot->>'settledOn' AS "settledOn",reason,changed_by AS "changedBy",approval_id AS "approvalId",created_at::text AS "recordedAt" FROM public.zero_net_settlement_revisions WHERE posting_id=$1 AND version>$2 ORDER BY version LIMIT $3`,[id,i.afterVersion,i.limit+1])).rows;return {status:200,body:{data:rows.slice(0,i.limit),nextVersion:rows.length>i.limit?rows[i.limit-1].version:null,paymentExecuted:false,taxRecognitionPerformed:false}};}
 empty.parse(q);return {status:200,body:{data:await detail(ctx,id)}};
}
export const zeroNetSettlementsContract=[
 {path:'/api/v1/payroll/net-postings/{id}/zero-net-settlement',method:'post',schema:change,summary:'Upper-human-reviewed explicit date/timezone/reference for a current positive-gross fully offset zero-net payroll posting. No caller amount,bank account,method,cash payment,journal or guessed planned-pay date. Future actual-settlement assertions refused. Versioned corrections and explicit null withdrawal retain original history;source/account permissions and worker locking apply. This is an attestation,not deduction remittance,statutory classification or tax-year recognition.'},
 {path:'/api/v1/payroll/net-postings/{id}/zero-net-settlement',method:'get',summary:'Private original reviewed zero-net no-cash settlement attestation and independently current posting-reversal flag. No bank or tax certification;all original payroll source/account and payment-view permissions required.'},
 {path:'/api/v1/payroll/net-postings/{id}/zero-net-settlement/history',method:'get',querySchema:history,summary:'Editor-only immutable settlement-date editions,private reasons,approvals and withdrawals,ascending cursor at most10rows. No fabricated payments,ledger changes or year-end tax recognition.'}
] as const;
