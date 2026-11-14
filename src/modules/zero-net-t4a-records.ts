import {z} from 'zod';
import {isDeepStrictEqual} from 'node:util';
import {jsonBody,record,type ApiContext,type Reply} from '../core/api.ts';
import {propose,master,lockApprovalWrites,type ApprovalRegistry,type Proposal} from '../core/approvals.ts';
import {ApiError} from '../core/policy.ts';
import {lockFinanceBook} from '../core/finance-lock.ts';
import {lockAcademyTopology} from './academy.ts';
import {authorizedZeroNetPosting} from './zero-net-settlements.ts';
import {requireT4aWorkerAccess} from './t4a-payment-records.ts';
import {t4aRecordDefinition} from '../core/t4a-record-definition.ts';
import {paidTaxDefinition} from '../core/paid-tax-definition.ts';
import {projectT4aZeroNetSettlement} from '../core/t4a-service-allocation.ts';
import {parseMoney} from '../core/money.ts';

const uuid=z.string().uuid().transform(v=>v.toLowerCase()),empty=z.object({}).strict();
const change=z.object({expectedVersion:z.number().int().min(0).max(2147483646),settlementVersion:z.number().int().positive().max(2147483647),definition:t4aRecordDefinition.nullable(),reason:paidTaxDefinition.shape.review}).strict().refine(v=>v.expectedVersion>0||v.definition!==null),input=change.safeExtend({postingId:uuid});
const history=z.object({afterVersion:z.coerce.number().int().min(0).max(2147483647).default(0),limit:z.coerce.number().int().min(1).max(10).default(5)}).strict();
type Plan={source:{personId:string;employerId:string;runId:string;scope:Record<string,unknown>;taxYear:number;recognizedOn:string;reportingAccount:Record<string,unknown>};unavailable:string|null;grossMinor:string|null;netMinor:string;nonTaxDeductedMinor:string|null};
async function authority(ctx:ApiContext,id:string,edit=false){const p=await authorizedZeroNetPosting(ctx,id);await requireT4aWorkerAccess(ctx,p.plan.source.personId,edit);return p.plan.source.personId;}
async function plan(ctx:ApiContext,raw:unknown){
 const i=input.parse(raw);await authority(ctx,i.postingId,true);const h=(await ctx.db.query<{version:number}>('SELECT version FROM public.zero_net_t4a_records WHERE posting_id=$1',[i.postingId])).rows[0];
 if((h?.version??0)!==i.expectedVersion)throw new ApiError(409,'ZERO_NET_T4A_VERSION_CHANGED');
 const p=(await ctx.db.query<{plan:Plan}>('SELECT public.zero_net_t4a_plan($1,$2,$3,$4::jsonb) plan',[i.postingId,i.expectedVersion,i.settlementVersion,JSON.stringify(i.definition)])).rows[0].plan;
 if(!p)throw new ApiError(404,'NOT_FOUND');if(p.unavailable)throw new ApiError(409,p.unavailable);
 if(i.definition)projectT4aZeroNetSettlement(i.definition.allocation,{currencyCode:'CAD',unitScale:2,grossMinor:p.grossMinor,netMinor:p.netMinor,incomeTaxDeductedMinor:parseMoney(i.definition.allocation.incomeTaxDeducted,2).toString(),nonTaxDeductedMinor:p.nonTaxDeductedMinor});
 return p;
}
async function detail(ctx:ApiContext,id:string){
 await authority(ctx,id);const r=(await ctx.db.query<{version:number;settlementVersion:number;currentSettlementVersion:number;currentSettlementState:string;state:string;definition:z.infer<typeof t4aRecordDefinition>|null;source_snapshot:Plan;recordedAt:string;postingReversed:boolean}>(`SELECT r.version,r.settlement_version AS "settlementVersion",s.version AS "currentSettlementVersion",sr.state AS "currentSettlementState",r.state,r.definition,r.source_snapshot,r.created_at::text AS "recordedAt",p.reversal_id IS NOT NULL AS "postingReversed" FROM public.zero_net_t4a_records h JOIN public.zero_net_t4a_revisions r ON r.academy_id=h.academy_id AND r.posting_id=h.posting_id AND r.version=h.version JOIN public.zero_net_settlements s ON s.academy_id=h.academy_id AND s.posting_id=h.posting_id JOIN public.zero_net_settlement_revisions sr ON sr.academy_id=s.academy_id AND sr.posting_id=s.posting_id AND sr.version=s.version JOIN public.payrun_net_postings p ON p.academy_id=h.academy_id AND p.id=h.posting_id WHERE h.posting_id=$1`,[id])).rows[0];if(!r)throw new ApiError(404,'NOT_FOUND');
 let usable=false;if(r.state==='recorded')usable=(await ctx.db.query<{ok:boolean}>('SELECT plan IS NOT NULL AND plan->>\'unavailable\' IS NULL ok FROM(SELECT public.zero_net_t4a_plan($1,$2,$3,$4::jsonb) plan) chosen',[id,r.version,r.settlementVersion,JSON.stringify(r.definition)])).rows[0].ok;
 return {postingId:id,sourceKind:'zero_net_settlement',personId:r.source_snapshot.source.personId,employerId:r.source_snapshot.source.employerId,version:r.version,state:r.state,settlementVersion:r.settlementVersion,currentSettlementVersion:r.currentSettlementVersion,currentSettlementState:r.currentSettlementState,definition:r.definition,recognizedOn:r.source_snapshot.source.recognizedOn,taxYear:r.source_snapshot.source.taxYear,reportingAccount:r.source_snapshot.source.reportingAccount,grossMinor:r.source_snapshot.grossMinor,netMinor:'0',nonTaxDeductedMinor:r.source_snapshot.nonTaxDeductedMinor,recordedAt:r.recordedAt,currentPostingReversed:r.postingReversed,recordedSourceUsable:usable,bankVerified:false,eligibilityVerified:false,yearToDateComplete:false,isOfficialT4A:false,readyToIssue:false,craFilingPerformed:false,paymentExecuted:false,additionalLedgerPosting:false};
}
async function apply(ctx:ApiContext,p:Proposal){
 if(ctx.credential.kind!=='human')throw new ApiError(403,'HUMAN_REVIEW_REQUIRED');const i=input.parse(p.payload),b=await plan(ctx,i);if(!isDeepStrictEqual(b,p.review_context))throw new ApiError(409,'ZERO_NET_T4A_SOURCE_CHANGED');
 if(i.expectedVersion===0)await ctx.db.query('INSERT INTO public.zero_net_t4a_records(academy_id,posting_id) VALUES($1,$2)',[ctx.credential.academy_id,i.postingId]);else await ctx.db.query('UPDATE public.zero_net_t4a_records SET version=version+1 WHERE posting_id=$1',[i.postingId]);
 await ctx.db.query('INSERT INTO public.zero_net_t4a_revisions(academy_id,posting_id,version,settlement_version,definition,source_snapshot,changed_by,approval_id,reason) VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8,$9)',[ctx.credential.academy_id,i.postingId,i.expectedVersion+1,i.settlementVersion,JSON.stringify(i.definition),JSON.stringify(b),ctx.credential.person_id,p.id,i.reason]);
 await record(ctx.db,ctx.credential,ctx.requestId,p.action,i.postingId,null,{version:i.expectedVersion+1,approvalId:p.id,severity:'critical',privateContentRedacted:true,paymentExecuted:false,additionalLedgerPosting:false});return detail(ctx,i.postingId);
}
const scope=(personId:string)=>({all:false,hubs:[],people:[{id:personId,hubId:null}],workContext:{personId,hubId:null}});
export const zeroNetT4aActions:ApprovalRegistry={'work.zero-net-t4a.change':{requestCapability:'payroll-tax.edit',privacyCapability:'payroll-tax.view',
 async validate(ctx,id,raw){const i=input.parse(raw);await lockFinanceBook(ctx);await lockAcademyTopology(ctx);const person=await authority(ctx,i.postingId,true);await ctx.db.query('SELECT public.lock_hourly_worker($1)',[person]);return scope(person);},
 async dependencies(ctx,id,raw,purpose){try{return await plan(ctx,raw);}catch(error){if(purpose==='review'&&error instanceof ApiError&&[400,403,404,409,422].includes(error.status))return {unavailable:error.code};throw error;}},
 async authorizeReviewer(ctx,p){const person=await authority(ctx,input.parse(p.payload).postingId,true);if(person===ctx.credential.person_id&&!await master(ctx))throw new ApiError(403,'BENEFICIARY_REVIEW_FORBIDDEN');},apply
}};
export async function zeroNetT4aRecords(ctx:ApiContext,registry:ApprovalRegistry=zeroNetT4aActions):Promise<Reply|null>{
 const m=/^payroll\/net-postings\/([^/]+)\/t4a-recognition(\/history)?$/.exec(ctx.path);if(!m)return null;const id=uuid.parse(m[1]),params=new URL(ctx.request.url).searchParams;if([...params].length!==new Set(params.keys()).size)throw new ApiError(400,'DUPLICATE_QUERY');const q=Object.fromEntries(params);
 if(ctx.request.method==='POST'&&!m[2]){empty.parse(q);const i=change.parse(await jsonBody(ctx.request,65536));return propose(ctx,registry,'work.zero-net-t4a.change',id,i.expectedVersion,{...i,postingId:id});}
 if(ctx.request.method!=='GET')throw new ApiError(405,'METHOD_NOT_ALLOWED');await lockApprovalWrites(ctx);await lockFinanceBook(ctx);await lockAcademyTopology(ctx);const person=await authority(ctx,id,Boolean(m[2]));await ctx.db.query('SELECT public.lock_hourly_worker($1)',[person]);
 if(m[2]){const i=history.parse(q),rows=(await ctx.db.query<{version:number}>(`SELECT version,settlement_version AS "settlementVersion",state,definition,source_snapshot->'source' source,changed_by AS "changedBy",approval_id AS "approvalId",reason,created_at::text AS "recordedAt" FROM public.zero_net_t4a_revisions WHERE posting_id=$1 AND version>$2 ORDER BY version LIMIT $3`,[id,i.afterVersion,i.limit+1])).rows;return {status:200,body:{data:rows.slice(0,i.limit),nextVersion:rows.length>i.limit?rows[i.limit-1].version:null,paymentExecuted:false}};}
 empty.parse(q);return {status:200,body:{data:await detail(ctx,id)}};
}
export const zeroNetT4aContract=[
 {path:'/api/v1/payroll/net-postings/{id}/t4a-recognition',method:'post',schema:change,summary:'Upper-human-reviewed explicit CAD contractor T4A recognition of a current actual zero-net settlement. Reuses exact source-coded deduction classification and gross/service/sales-tax allocation checks,requires all posted deductions exactly once and the original retained settlement/RP editions. Full original posting/accounts,payment-view,private worker-tax and employer authority. Immutable corrections/withdrawals;no invented cash,bank movement,journal,automatic eligibility,official slip or CRA filing.'},
 {path:'/api/v1/payroll/net-postings/{id}/t4a-recognition',method:'get',summary:'Private reviewed zero-net contractor recognition and live settlement,posting reversal and exact-source usability flags. No cash payment or legal recipient identity.'},
 {path:'/api/v1/payroll/net-postings/{id}/t4a-recognition/history',method:'get',querySchema:history,summary:'Editor-only immutable contractor settlement tax editions,original approvals/reasons and bounded ascending cursor at most10rows. Never rewrites financial postings.'}
] as const;
