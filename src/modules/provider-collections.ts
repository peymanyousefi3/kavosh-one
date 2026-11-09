import { Temporal } from '@js-temporal/polyfill';
import { z } from 'zod';
import { isDeepStrictEqual } from 'node:util';
import { jsonBody,record,type ApiContext,type Reply } from '../core/api.ts';
import { propose,master,type Proposal,type ApprovalRegistry } from '../core/approvals.ts';
import { ApiError } from '../core/policy.ts';
import { formatMoney,readMinorUnits } from '../core/money.ts';
import { lockFinanceBook } from '../core/finance-lock.ts';
import { lockCollectorFunds } from '../core/collector-funds.ts';
import { lockAcademyTopology } from './academy.ts';
import { invoiceRow } from './invoices.ts';
import { financialRecordAuthority } from './tuition.ts';
import { collectorRow } from './collectors.ts';
import { accountRow } from './finance.ts';
import { paymentMethodRow } from './payment-methods.ts';
import { prepareJournal,journalDependencies,applyJournal } from './finance-journals.ts';

const uuid=z.string().uuid().transform(v=>v.toLowerCase()),ref=z.object({id:uuid,version:z.number().int().positive().max(2147483647)}).strict();
const input=z.object({inspectionId:uuid,collector:ref,method:ref,holdingAccount:ref,creditAccount:ref,receivedAt:z.iso.datetime({offset:true}).max(100),period:ref,reason:z.string().trim().min(1).max(2000).refine(v=>v.isWellFormed()&&!v.includes('\0'))}).strict(),payload=input.extend({invoiceId:uuid}),paging=z.object({limit:z.coerce.number().int().min(1).max(100).default(25),after:uuid.optional()}).strict();
type Source={inspectionId:string;startId:string;requestId:string;invoiceId:string;studentId:string;classId:string;hubId:string;accountId:string;livemode:boolean;chargeId:string;amountMinor:string;currencyId:string;currencyCode:string;unitScale:number;inspection:unknown;recordedAt:string;manualReferenceExists:boolean;collectionId:string|null};
async function authority(ctx:ApiContext,id:string,edit=false){const i=await invoiceRow(ctx,id);financialRecordAuthority(ctx,i,'receipts.view');financialRecordAuthority(ctx,i,'checkouts.view');return {i,auth:financialRecordAuthority(ctx,i,edit?'receipts.edit':'receipts.view')};}
async function basis(ctx:ApiContext,i:z.infer<typeof payload>,lock=false){
 const a=await authority(ctx,i.invoiceId,true);
 if(lock){await lockFinanceBook(ctx);await lockAcademyTopology(ctx);await collectorRow(ctx,i.collector.id);await accountRow(ctx,i.holdingAccount.id);await lockCollectorFunds(ctx,i.collector.id,i.holdingAccount.id);await ctx.db.query('SELECT id FROM public.tuition_invoices WHERE id=$1 FOR UPDATE',[i.invoiceId]);}
 let source=(await ctx.db.query<{source:Source|null}>('SELECT public.provider_collection_source($1) source',[i.inspectionId])).rows[0]?.source;
 if(!source||source.invoiceId!==i.invoiceId)throw new ApiError(409,'PROVIDER_CAPTURE_SOURCE_UNAVAILABLE');
 if(lock){await ctx.db.query("SELECT pg_advisory_xact_lock(hashtextextended($1||':checkout-provider:'||$2,0))",[ctx.credential.academy_id,source.accountId]);await ctx.db.query("SELECT pg_advisory_xact_lock(hashtextextended($1||':provider-charge:'||$2,0))",[ctx.credential.academy_id,source.chargeId]);source=(await ctx.db.query<{source:Source|null}>('SELECT public.provider_collection_source($1) source',[i.inspectionId])).rows[0]?.source;}
 if(!source||source.invoiceId!==i.invoiceId)throw new ApiError(409,'PROVIDER_CAPTURE_SOURCE_UNAVAILABLE');if(source.collectionId)throw new ApiError(409,'PROVIDER_CHARGE_ALREADY_RECORDED');if(source.manualReferenceExists)throw new ApiError(409,'PROVIDER_MANUAL_RECEIPT_RECONCILIATION_REQUIRED');
 const collector=await collectorRow(ctx,i.collector.id),method=await paymentMethodRow(ctx,i.method.id),holding=await accountRow(ctx,i.holdingAccount.id),credit=await accountRow(ctx,i.creditAccount.id);
 if(collector.version!==i.collector.version||!collector.active||collector.custody!=='third_party'||collector.hub_id!==null&&collector.hub_id!==a.i.hub_id||method.version!==i.method.version||!method.active||!['credit_card','debit_card'].includes(method.category)||method.hubId!==null&&method.hubId!==a.i.hub_id
 ||holding.version!==i.holdingAccount.version||!holding.active||holding.operationalRole!=='collector_receivable'||holding.currencyId!==source.currencyId||holding.unitScale!==source.unitScale||holding.hubId!==null&&holding.hubId!==a.i.hub_id
 ||credit.version!==i.creditAccount.version||!credit.active||credit.kind!=='liability'||credit.normalBalance!=='credit'||credit.currencyId!==source.currencyId||credit.unitScale!==source.unitScale||credit.hubId!==null&&credit.hubId!==a.i.hub_id
 ||!collector.accounts.some(v=>v.id===holding.id&&v.version===holding.version&&v.currencyId===source!.currencyId))throw new ApiError(409,'PROVIDER_COLLECTION_MAPPING_INVALID');
 const zone=(await ctx.db.query<{time_zone:string}>('SELECT time_zone FROM public.classes WHERE id=$1',[a.i.class_id])).rows[0].time_zone,on=Temporal.Instant.from(i.receivedAt).toZonedDateTimeISO(zone).toPlainDate().toString(),amount=formatMoney(readMinorUnits(source.amountMinor),source.unitScale);
 const journal={periodId:i.period.id,periodVersion:i.period.version,postedOn:on,description:'Provider collection held as customer credit',reference:source.chargeId,purpose:'activity' as const,reason:i.reason,lines:[{accountId:holding.id,accountVersion:holding.version,side:'debit' as const,amount},{accountId:credit.id,accountVersion:credit.version,side:'credit' as const,amount}]};
 await prepareJournal(ctx,false,journal,lock);return {source,on,journal,auth:a.auth};
}
async function reviewState(ctx:ApiContext,b:Awaited<ReturnType<typeof basis>>){return JSON.parse(JSON.stringify({source:b.source,receivedOn:b.on,posting:await journalDependencies(ctx,false,b.journal,'review')}));}
async function detail(ctx:ApiContext,id:string){const r=(await ctx.db.query<{invoice_id:string;amount_minor:string;unit_scale:number;currency_code:string}>(`SELECT c.*,c.amount_minor::text,r.unit_scale,r.currency_code FROM public.provider_collections c JOIN public.payment_checkout_dispatch_starts s ON s.academy_id=c.academy_id AND s.id=c.start_id JOIN public.payment_checkout_attempts a ON a.academy_id=s.academy_id AND a.id=s.attempt_id JOIN public.payment_checkout_requests r ON r.academy_id=a.academy_id AND r.id=a.request_id WHERE c.id=$1`,[id])).rows[0];if(!r)throw new ApiError(404,'NOT_FOUND');await authority(ctx,r.invoice_id);return {id,invoiceId:r.invoice_id,amount:formatMoney(readMinorUnits(r.amount_minor),r.unit_scale),currencyCode:r.currency_code,accountingState:'customer_credit_pending_application',invoiceApplied:false,bankSettled:false,additionalTaxPosting:false,providerPaymentExecuted:false,receivedAtProviderVerified:false};}
export const providerCollectionActions:ApprovalRegistry={'finance.provider-collection.record':{
 requestCapability:'receipts.edit',privacyCapability:'receipts.edit',createdStatus:201,
 validate:async(ctx,_id,raw)=>{const i=payload.parse(raw),a=await authority(ctx,i.invoiceId,true);await collectorRow(ctx,i.collector.id);await paymentMethodRow(ctx,i.method.id);await accountRow(ctx,i.holdingAccount.id);await accountRow(ctx,i.creditAccount.id);return a.auth;},
 dependencies:async(ctx,_id,raw,purpose)=>{try{return await reviewState(ctx,await basis(ctx,payload.parse(raw)));}catch(e){if(purpose==='review'&&e instanceof ApiError&&[400,403,404,409].includes(e.status))return {unavailable:e.code};throw e;}},
 authorizeReviewer:async(ctx,p)=>{if(await master(ctx))return;const i=payload.parse(p.payload),a=await authority(ctx,i.invoiceId),collector=await collectorRow(ctx,i.collector.id);if(collector.person_id===ctx.credential.person_id||a.i.student_id===ctx.credential.person_id||(await ctx.db.query('SELECT 1 FROM public.family_relationships WHERE student_id=$1 AND guardian_id=$2',[a.i.student_id,ctx.credential.person_id])).rows.length)throw new ApiError(403,'BENEFICIARY_REVIEW_FORBIDDEN');},
 apply:async(ctx,p:Proposal)=>{if(ctx.credential.kind!=='human')throw new ApiError(403,'HUMAN_REVIEW_REQUIRED');const i=payload.parse(p.payload),b=await basis(ctx,i,true);if(!isDeepStrictEqual(await reviewState(ctx,b),p.review_context))throw new ApiError(409,'PROVIDER_COLLECTION_SOURCE_CHANGED');
  try{await ctx.db.query(`INSERT INTO public.provider_collections(academy_id,id,invoice_id,student_id,class_id,hub_id,inspection_id,start_id,account_id,livemode,charge_id,amount_minor,collector_id,collector_version,method_id,method_version,holding_account,holding_version,credit_account,credit_version,received_at,received_on,approval_id,created_by,reason) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25)`,[ctx.credential.academy_id,p.target_id,i.invoiceId,b.source.studentId,b.source.classId,b.source.hubId,i.inspectionId,b.source.startId,b.source.accountId,b.source.livemode,b.source.chargeId,b.source.amountMinor,i.collector.id,i.collector.version,i.method.id,i.method.version,i.holdingAccount.id,i.holdingAccount.version,i.creditAccount.id,i.creditAccount.version,i.receivedAt,b.on,p.id,ctx.credential.person_id,i.reason]);}catch(e){if(e&&typeof e==='object'&&'code'in e&&e.code==='23505')throw new ApiError(409,'PROVIDER_CHARGE_ALREADY_RECORDED');throw e;}
  await applyJournal(ctx,{...p,payload:b.journal},false);await record(ctx.db,ctx.credential,ctx.requestId,'finance.provider-collection.recorded',p.target_id,b.source.hubId,{approvalId:p.id,severity:'critical',invoiceApplied:false,bankSettled:false});return detail(ctx,p.target_id);
 }
}};
export async function providerCollections(ctx:ApiContext,registry:ApprovalRegistry=providerCollectionActions):Promise<Reply|null>{
 const p=/^finance\/invoices\/([^/]+)\/provider-collections$/.exec(ctx.path),read=/^finance\/provider-collections\/([^/]+)$/.exec(ctx.path);if(!p&&!read)return null;const params=new URL(ctx.request.url).searchParams;if(new Set(params.keys()).size!==[...params].length)throw new ApiError(400,'DUPLICATE_QUERY');const q=Object.fromEntries(params);
 if(read){if(ctx.request.method!=='GET')throw new ApiError(405,'METHOD_NOT_ALLOWED');z.object({}).strict().parse(q);return {status:200,body:{data:await detail(ctx,uuid.parse(read[1]))}};}
 const invoiceId=uuid.parse(p![1]);await authority(ctx,invoiceId,ctx.request.method==='POST');if(ctx.request.method==='POST'){z.object({}).strict().parse(q);return propose(ctx,registry,'finance.provider-collection.record',null,0,{...input.parse(await jsonBody(ctx.request)),invoiceId});}
 if(ctx.request.method!=='GET')throw new ApiError(405,'METHOD_NOT_ALLOWED');const query=paging.parse(q),rows=(await ctx.db.query<{id:string}>('SELECT id,inspection_id "inspectionId",amount_minor::text "amountMinor",received_on "receivedOn" FROM public.provider_collections WHERE invoice_id=$1 AND($2::uuid IS NULL OR id>$2) ORDER BY id LIMIT $3',[invoiceId,query.after??null,query.limit+1])).rows;return {status:200,body:{data:rows.slice(0,query.limit),nextCursor:rows.length>query.limit?rows[query.limit-1].id:null,invoiceApplied:false,bankSettled:false}};
}
export const providerCollectionsContract=[
 {path:'/api/v1/finance/invoices/{id}/provider-collections',method:'post',summary:'Upper-reviewed exact captured principal into processor receivable/customer-credit liability,including manual-payment/credit races. No caller amount,new tax,tuition receipt,invoice allocation,bank deposit or provider charge. Received date is explicitly reviewer-attested.',schema:input},
 {path:'/api/v1/finance/invoices/{id}/provider-collections',method:'get',summary:'Bounded invoice-scoped provider collection directory;customer credit awaits a separate approved application',querySchema:paging},
 {path:'/api/v1/finance/provider-collections/{id}',method:'get',summary:'Current-rights posted principal record. Neither invoice application,tuition income nor bank settlement is implied.'}
] as const;
