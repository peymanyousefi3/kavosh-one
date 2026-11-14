import {z} from 'zod';
import {isDeepStrictEqual} from 'node:util';
import {jsonBody,record,type ApiContext,type Reply} from '../core/api.ts';
import {propose,master,permissionScope,lockApprovalWrites,type ApprovalRegistry,type Proposal} from '../core/approvals.ts';
import {ApiError,scopeNonempty} from '../core/policy.ts';
import {lockFinanceBook} from '../core/finance-lock.ts';
import {lockAcademyTopology} from './academy.ts';
import {paidTaxDefinition} from '../core/paid-tax-definition.ts';
import {authorizedPayrollTaxProfile,payrollTaxScope} from './payroll-tax-profiles.ts';
import {authorizedNetPosting} from './payrun-postings.ts';
import {requirePayrollEmployerView} from './payroll-employers.ts';

const uuid=z.string().uuid().transform(v=>v.toLowerCase()),text=z.string().trim().min(1).max(2000).refine(v=>v.isWellFormed()&&!/[\u0000-\u001f\u007f]/.test(v)),empty=z.object({}).strict();
const change=z.object({expectedVersion:z.number().int().min(0).max(2147483646),settlementVersion:z.number().int().positive().max(2147483647),definition:paidTaxDefinition.nullable(),reason:text}).strict().refine(v=>v.expectedVersion>0||v.definition!==null),input=change.safeExtend({profileId:uuid,postingId:uuid});
const history=z.object({afterVersion:z.coerce.number().int().min(0).max(2147483647).default(0),limit:z.coerce.number().int().min(1).max(10).default(5)}).strict();
async function authority(ctx:ApiContext,profileId:string,postingId:string,edit=false){
 const h=await authorizedPayrollTaxProfile(ctx,profileId,edit),p=await authorizedNetPosting(ctx,postingId);if(p.plan.source.personId!==h.person_id)throw new ApiError(404,'NOT_FOUND');
 const s=permissionScope(ctx,'payrun-payments.view');if(!scopeNonempty(s))throw new ApiError(403,'FORBIDDEN');if(!(await ctx.db.query<{ok:boolean}>('SELECT public.scope_contains($1::jsonb,$2::jsonb) ok',[JSON.stringify(s),JSON.stringify(p.plan.source.scope)])).rows[0].ok)throw new ApiError(404,'NOT_FOUND');return h;
}
async function plan(ctx:ApiContext,raw:unknown){
 const i=input.parse(raw);await authority(ctx,i.profileId,i.postingId,true);const h=(await ctx.db.query<{version:number;profile_id:string}>('SELECT version,profile_id FROM public.zero_net_tax_records WHERE posting_id=$1',[i.postingId])).rows[0];
 if(h&&h.profile_id!==i.profileId)await authorizedPayrollTaxProfile(ctx,h.profile_id,true);if((h?.version??0)!==i.expectedVersion)throw new ApiError(409,'ZERO_NET_TAX_VERSION_CHANGED');if(i.definition?.reportingAccount)requirePayrollEmployerView(ctx);
 const b=(await ctx.db.query<{plan:Record<string,unknown>&{unavailable:string|null}}>('SELECT public.zero_net_tax_plan($1,$2,$3,$4,$5::jsonb) plan',[i.profileId,i.postingId,i.expectedVersion,i.settlementVersion,JSON.stringify(i.definition)])).rows[0].plan;if(!b)throw new ApiError(404,'NOT_FOUND');if(b.unavailable)throw new ApiError(409,b.unavailable);return b;
}
async function detail(ctx:ApiContext,profileId:string,postingId:string){
 await authority(ctx,profileId,postingId);const r=(await ctx.db.query<{version:number;settlementVersion:number;currentSettlementVersion:number;currentSettlementState:string;state:string;definition:unknown;source_snapshot:{source:{recognizedOn:string};grossMinor:string|null};recordedAt:string;postingReversed:boolean}>(`SELECT r.version,r.settlement_version AS "settlementVersion",s.version AS "currentSettlementVersion",sr.state AS "currentSettlementState",r.state,r.definition,r.source_snapshot,r.created_at::text AS "recordedAt",p.reversal_id IS NOT NULL AS "postingReversed" FROM public.zero_net_tax_records h JOIN public.zero_net_tax_revisions r ON r.academy_id=h.academy_id AND r.posting_id=h.posting_id AND r.version=h.version JOIN public.zero_net_settlements s ON s.academy_id=h.academy_id AND s.posting_id=h.posting_id JOIN public.zero_net_settlement_revisions sr ON sr.academy_id=s.academy_id AND sr.posting_id=s.posting_id AND sr.version=s.version JOIN public.payrun_net_postings p ON p.academy_id=h.academy_id AND p.id=h.posting_id WHERE h.profile_id=$1 AND h.posting_id=$2`,[profileId,postingId])).rows[0];if(!r)throw new ApiError(404,'NOT_FOUND');
 let sourceUsable=false;if(r.state==='recorded')sourceUsable=(await ctx.db.query<{ok:boolean}>('SELECT plan IS NOT NULL AND plan->>\'unavailable\' IS NULL ok FROM(SELECT public.zero_net_tax_plan($1,$2,$3,$4,$5::jsonb) plan) selected',[profileId,postingId,r.version,r.settlementVersion,JSON.stringify(r.definition)])).rows[0].ok;
 return {profileId,postingId,sourceKind:'zero_net_settlement',version:r.version,state:r.state,settlementVersion:r.settlementVersion,currentSettlementVersion:r.currentSettlementVersion,currentSettlementState:r.currentSettlementState,currentPostingReversed:r.postingReversed,definition:r.definition,recognizedOn:r.source_snapshot.source.recognizedOn,grossMinor:r.source_snapshot.grossMinor,netMinor:'0',recordedAt:r.recordedAt,recordedSourceUsable:sourceUsable,taxRecognitionPerformed:r.state==='recorded',bankVerified:false,statutoryRulesCalculated:false,eligibilityVerified:false,paymentExecuted:false,additionalLedgerPosting:false};
}
async function apply(ctx:ApiContext,p:Proposal){
 if(ctx.credential.kind!=='human')throw new ApiError(403,'HUMAN_REVIEW_REQUIRED');const i=input.parse(p.payload),b=await plan(ctx,i);if(!isDeepStrictEqual(b,p.review_context))throw new ApiError(409,'ZERO_NET_TAX_SOURCE_CHANGED');
 if(i.expectedVersion===0)await ctx.db.query('INSERT INTO public.zero_net_tax_records(academy_id,posting_id,profile_id) VALUES($1,$2,$3)',[ctx.credential.academy_id,i.postingId,i.profileId]);else await ctx.db.query('UPDATE public.zero_net_tax_records SET version=version+1,profile_id=$2 WHERE posting_id=$1',[i.postingId,i.profileId]);
 await ctx.db.query('INSERT INTO public.zero_net_tax_revisions(academy_id,posting_id,version,settlement_version,definition,source_snapshot,changed_by,approval_id,reason) VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8,$9)',[ctx.credential.academy_id,i.postingId,i.expectedVersion+1,i.settlementVersion,JSON.stringify(i.definition),JSON.stringify(b),ctx.credential.person_id,p.id,i.reason]);
 await record(ctx.db,ctx.credential,ctx.requestId,p.action,i.postingId,null,{version:i.expectedVersion+1,approvalId:p.id,severity:'critical',privateContentRedacted:true,paymentExecuted:false,additionalLedgerPosting:false});return detail(ctx,i.profileId,i.postingId);
}
export const zeroNetTaxActions:ApprovalRegistry={'work.zero-net-tax.change':{requestCapability:'payroll-tax.edit',privacyCapability:'payroll-tax.view',
 async validate(ctx,id,raw){const i=input.parse(raw);await lockFinanceBook(ctx);await lockAcademyTopology(ctx);const h=await authority(ctx,i.profileId,i.postingId,true);await ctx.db.query('SELECT public.lock_hourly_worker($1)',[h.person_id]);return payrollTaxScope(h.person_id);},
 async dependencies(ctx,id,raw,purpose){try{return await plan(ctx,raw);}catch(error){if(purpose==='review'&&error instanceof ApiError&&[400,403,404,409,422].includes(error.status))return {unavailable:error.code};throw error;}},
 async authorizeReviewer(ctx,p){const i=input.parse(p.payload),h=await authority(ctx,i.profileId,i.postingId,true);if(h.person_id===ctx.credential.person_id&&!await master(ctx))throw new ApiError(403,'BENEFICIARY_REVIEW_FORBIDDEN');},apply
}};
export async function zeroNetTaxRecords(ctx:ApiContext,registry:ApprovalRegistry=zeroNetTaxActions):Promise<Reply|null>{
 const m=/^payroll\/tax-profiles\/([^/]+)\/zero-net-postings\/([^/]+)(\/history)?$/.exec(ctx.path);if(!m)return null;const profileId=uuid.parse(m[1]),postingId=uuid.parse(m[2]),params=new URL(ctx.request.url).searchParams;if([...params].length!==new Set(params.keys()).size)throw new ApiError(400,'DUPLICATE_QUERY');const q=Object.fromEntries(params);
 if(ctx.request.method==='POST'&&!m[3]){empty.parse(q);const i=change.parse(await jsonBody(ctx.request,65536));return propose(ctx,registry,'work.zero-net-tax.change',postingId,i.expectedVersion,{...i,profileId,postingId});}
 if(ctx.request.method!=='GET')throw new ApiError(405,'METHOD_NOT_ALLOWED');await lockApprovalWrites(ctx);await lockFinanceBook(ctx);await lockAcademyTopology(ctx);const h=await authority(ctx,profileId,postingId,Boolean(m[3]));await ctx.db.query('SELECT public.lock_hourly_worker($1)',[h.person_id]);
 if(m[3]){const i=history.parse(q),header=(await ctx.db.query<{profile_id:string}>('SELECT profile_id FROM public.zero_net_tax_records WHERE posting_id=$1',[postingId])).rows[0];if(header?.profile_id!==profileId)throw new ApiError(404,'NOT_FOUND');const rows=(await ctx.db.query<{version:number}>(`SELECT version,settlement_version AS "settlementVersion",state,definition,source_snapshot#>>'{source,recognizedOn}' AS "recognizedOn",changed_by AS "changedBy",approval_id AS "approvalId",reason,created_at::text AS "recordedAt" FROM public.zero_net_tax_revisions WHERE posting_id=$1 AND version>$2 ORDER BY version LIMIT $3`,[postingId,i.afterVersion,i.limit+1])).rows;return {status:200,body:{data:rows.slice(0,i.limit),nextVersion:rows.length>i.limit?rows[i.limit-1].version:null,paymentExecuted:false}};}
 empty.parse(q);return {status:200,body:{data:await detail(ctx,profileId,postingId)}};
}
export const zeroNetTaxRecordsContract=[
 {path:'/api/v1/payroll/tax-profiles/{profileId}/zero-net-postings/{postingId}',method:'post',schema:change,summary:'Human-reviewed tax recognition of an existing current actual zero-net payroll settlement. Exact retained settlement edition,original whole posting/accounts and private tax-profile rights required. Full posted deduction/contribution conservation and explicit classifications,year/timezone and optional RP edition;no fake cash payment,bank movement,journal,automatic statutory clearance or CRA filing. Corrections and null withdrawal retain immutable original history.'},
 {path:'/api/v1/payroll/tax-profiles/{profileId}/zero-net-postings/{postingId}',method:'get',summary:'Current private zero-net tax recognition and independently current settlement/reversal/source-usability flags. No cash payment or identity fields.'},
 {path:'/api/v1/payroll/tax-profiles/{profileId}/zero-net-postings/{postingId}/history',method:'get',querySchema:history,summary:'Editor-only immutable zero-net tax editions and original approvals/reasons,ascending bounded cursor at most10rows. No payment or journal creation.'}
] as const;
