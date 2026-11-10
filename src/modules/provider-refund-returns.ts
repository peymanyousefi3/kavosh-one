import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { jsonBody,record,type ApiContext,type Reply } from '../core/api.ts';
import { propose,lockApprovalWrites,type ApprovalRegistry } from '../core/approvals.ts';
import { ApiError } from '../core/policy.ts';
import { formatMoney,readMinorUnits } from '../core/money.ts';
import { lockFinanceBook } from '../core/finance-lock.ts';
import { lockCollectorFunds } from '../core/collector-funds.ts';
import { lockAcademyTopology } from './academy.ts';
import { accountingDate } from './finance-periods.ts';
import { providerCollectionAuthority,providerRefundActions } from './provider-refunds.ts';
import { prepareJournal,journalDependencies,applyJournal } from './finance-journals.ts';

const uuid=z.string().uuid().transform(v=>v.toLowerCase()),selection=z.object({returnInspectionId:uuid,postedOn:accountingDate}).strict(),input=selection.extend({period:z.object({id:uuid,version:z.number().int().positive().max(2147483647)}).strict(),reason:z.string().trim().min(1).max(2000).refine(v=>v.isWellFormed()&&!v.includes('\0'))}).strict(),payload=input.extend({refundPostingId:uuid,collectionId:uuid}),paging=z.object({limit:z.coerce.number().int().min(1).max(100).default(25),after:uuid.optional()}).strict();
type Source={refundPostingId:string;collectionId:string;amountMinor:string;currencyCode:string;unitScale:number;postedOn:string;alreadyReturned:boolean};
async function authority(ctx:ApiContext,id:string,edit=false){const p=(await ctx.db.query<{collection_id:string}>('SELECT collection_id FROM public.provider_refund_postings WHERE id=$1',[id])).rows[0];if(!p)throw new ApiError(404,'NOT_FOUND');return providerCollectionAuthority(ctx,p.collection_id,edit);}
async function source(ctx:ApiContext,id:string,i:z.infer<typeof selection>){const s=(await ctx.db.query<{source:Source|null}>('SELECT public.provider_refund_return_source($1,$2,$3::date) source',[id,i.returnInspectionId,i.postedOn])).rows[0]?.source;if(!s)throw new ApiError(409,'PROVIDER_REFUND_RETURN_SOURCE_UNAVAILABLE');return s;}
async function basis(ctx:ApiContext,i:z.infer<typeof payload>,lock=false){
 const a=await authority(ctx,i.refundPostingId,true);if(a.c.id!==i.collectionId)throw new ApiError(404,'NOT_FOUND');
 if(lock){await lockFinanceBook(ctx);await lockAcademyTopology(ctx);await ctx.db.query('SELECT public.lock_customer_credit($1)',[a.c.id]);await lockCollectorFunds(ctx,a.c.collector_id,a.c.holding_account);await ctx.db.query('SELECT id FROM public.tuition_invoices WHERE id=$1 FOR UPDATE',[a.c.invoice_id]);await ctx.db.query("SELECT pg_advisory_xact_lock(hashtextextended($1::text||':checkout-provider:'||$2,0))",[ctx.credential.academy_id,a.c.account_id]);}
 const s=await source(ctx,i.refundPostingId,i);if(s.alreadyReturned)throw new ApiError(409,'PROVIDER_REFUND_ALREADY_RETURNED');const journal={periodId:i.period.id,periodVersion:i.period.version,postedOn:i.postedOn,description:'Recorded failed provider refund return',reference:'',reversesId:i.refundPostingId,reason:i.reason};await prepareJournal(ctx,true,journal,lock);return {source:s,journal,auth:a.auth};
}
async function reviewState(ctx:ApiContext,b:Awaited<ReturnType<typeof basis>>){return JSON.parse(JSON.stringify({source:b.source,posting:await journalDependencies(ctx,true,b.journal,'review')}));}
async function detail(ctx:ApiContext,id:string){
 const r=(await ctx.db.query<{id:string;refund_posting_id:string;collection_id:string;return_inspection_id:string;posted_on:string;amount_minor:string;source:Source}>('SELECT id,refund_posting_id,collection_id,return_inspection_id,posted_on::text,amount_minor::text,source FROM public.provider_refund_returns WHERE id=$1',[id])).rows[0];if(!r)throw new ApiError(404,'NOT_FOUND');await authority(ctx,r.refund_posting_id);return {id,refundPostingId:r.refund_posting_id,collectionId:r.collection_id,returnInspectionId:r.return_inspection_id,postedOn:r.posted_on,amount:formatMoney(readMinorUnits(r.amount_minor),r.source.unitScale),currencyCode:r.source.currencyCode,originalBookingRetained:true,accountingRecorded:true,providerOperationPerformed:false,bankSettlementVerified:false,invoiceReceiptChanged:false};
}
export const providerRefundReturnActions:ApprovalRegistry={'finance.provider-refund.return':{
 requestCapability:'receipts.edit',privacyCapability:'receipts.edit',createdStatus:201,
 validate:async(ctx,_id,raw)=>(await authority(ctx,payload.parse(raw).refundPostingId,true)).auth,
 dependencies:async(ctx,_id,raw,purpose)=>{try{return await reviewState(ctx,await basis(ctx,payload.parse(raw)));}catch(e){if(purpose==='review'&&e instanceof ApiError&&[400,403,404,409].includes(e.status))return {unavailable:e.code};throw e;}},
 authorizeReviewer:providerRefundActions['finance.provider-refund.record'].authorizeReviewer,
 apply:async(ctx,p)=>{if(ctx.credential.kind!=='human')throw new ApiError(403,'HUMAN_REVIEW_REQUIRED');const i=payload.parse(p.payload),b=await basis(ctx,i,true);if(!isDeepStrictEqual(await reviewState(ctx,b),p.review_context))throw new ApiError(409,'PROVIDER_REFUND_RETURN_SOURCE_CHANGED');
  try{await ctx.db.query('INSERT INTO public.provider_refund_returns(academy_id,id,refund_posting_id,collection_id,return_inspection_id,posted_on,amount_minor,source,approval_id,created_by,reason) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11)',[ctx.credential.academy_id,p.target_id,i.refundPostingId,i.collectionId,i.returnInspectionId,i.postedOn,b.source.amountMinor,JSON.stringify(b.source),p.id,ctx.credential.person_id,i.reason]);}catch(e){if(e&&typeof e==='object'&&'code'in e&&e.code==='23505')throw new ApiError(409,'PROVIDER_REFUND_ALREADY_RETURNED');throw e;}
  await applyJournal(ctx,{...p,payload:{...b.journal,reference:'provider-refund-return:'+p.target_id}},true);await record(ctx.db,ctx.credential,ctx.requestId,'finance.provider-refund.returned',p.target_id,b.auth.recordContext?.hubId??null,{approvalId:p.id,collectionId:i.collectionId,refundPostingId:i.refundPostingId,severity:'critical',providerOperationPerformed:false,bankSettled:false});return detail(ctx,p.target_id);
 }
}};
export async function providerRefundReturns(ctx:ApiContext,registry:ApprovalRegistry=providerRefundReturnActions):Promise<Reply|null>{
 const path=/^finance\/provider-refunds\/([^/]+)\/(returns|return-source)$/.exec(ctx.path),read=/^finance\/provider-refund-returns\/([^/]+)$/.exec(ctx.path);if(!path&&!read)return null;const params=new URL(ctx.request.url).searchParams;if(new Set(params.keys()).size!==[...params].length)throw new ApiError(400,'DUPLICATE_QUERY');const q=Object.fromEntries(params);if(ctx.request.method==='GET')await lockApprovalWrites(ctx);
 if(read){if(ctx.request.method!=='GET')throw new ApiError(405,'METHOD_NOT_ALLOWED');z.object({}).strict().parse(q);return {status:200,body:{data:await detail(ctx,uuid.parse(read[1]))}};}
 const id=uuid.parse(path![1]),a=await authority(ctx,id,ctx.request.method==='POST');
 if(path![2]==='return-source'){if(ctx.request.method!=='GET')throw new ApiError(405,'METHOD_NOT_ALLOWED');const i=selection.parse(q),s=await source(ctx,id,i);return {status:200,body:{data:{refundPostingId:id,collectionId:a.c.id,alreadyReturned:s.alreadyReturned,amount:formatMoney(readMinorUnits(s.amountMinor),s.unitScale),currencyCode:s.currencyCode,postedOn:s.postedOn,previewOnly:true,bankSettlementVerified:false,providerOperationPerformed:false}}};}
 if(ctx.request.method==='POST'){z.object({}).strict().parse(q);return propose(ctx,registry,'finance.provider-refund.return',null,0,{...input.parse(await jsonBody(ctx.request)),refundPostingId:id,collectionId:a.c.id});}
 if(ctx.request.method!=='GET')throw new ApiError(405,'METHOD_NOT_ALLOWED');
 const query=paging.parse(q),rows=(await ctx.db.query<{id:string}>('SELECT id,posted_on "postedOn" FROM public.provider_refund_returns WHERE refund_posting_id=$1 AND($2::uuid IS NULL OR id>$2) ORDER BY id LIMIT $3',[id,query.after??null,query.limit+1])).rows;
 return {status:200,body:{data:rows.slice(0,query.limit),nextCursor:rows.length>query.limit?rows[query.limit-1].id:null}};
}
export const providerRefundReturnsContract=[
 {path:'/api/v1/finance/provider-refunds/{id}/return-source',method:'get',summary:'Read-only preview of an exact recorded refund and independently observed matching failed-refund return balance. No supplied money or restoration authority.',querySchema:selection},
 {path:'/api/v1/finance/provider-refunds/{id}/returns',method:'post',summary:'Upper-human-reviewed exact inverse of a previously booked refund with matching retained return evidence. Restores dated processor receivable/customer credit,not an invoice receipt,new deposit,provider payment or bank settlement. Full original refund reconciliation is still required before credit reuse.',schema:input},
 {path:'/api/v1/finance/provider-refunds/{id}/returns',method:'get',summary:'Bounded original-rights retained refund return accounting history',querySchema:paging},
 {path:'/api/v1/finance/provider-refund-returns/{id}',method:'get',summary:'One retained exact refund inverse under current original financial rights,not current provider or bank state'}
] as const;
