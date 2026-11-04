import { Temporal } from '@js-temporal/polyfill';
import { z } from 'zod';
import { jsonBody,record,type ApiContext,type Reply } from '../core/api.ts';
import { propose,permissionScope,master,type ApprovalRegistry,type Proposal } from '../core/approvals.ts';
import { ApiError,scopeNonempty,type Capability } from '../core/policy.ts';
import { parseMoney,readMinorUnits,formatMoney } from '../core/money.ts';
import { lockFinanceBook } from '../core/finance-lock.ts';
import { lockAcademyTopology } from './academy.ts';
import { financialRecordAuthority,tuitionPlan,tuitionDetail } from './tuition.ts';
import { invoiceRow } from './invoices.ts';
import { collectorRow } from './collectors.ts';
import { accountRow } from './finance.ts';
import { paymentMethodRow } from './payment-methods.ts';
import { permittedPerson } from './students.ts';
import { permittedFile } from './files.ts';
import { prepareJournal,journalDependencies,applyJournal } from './finance-journals.ts';
import { accountingDate } from './finance-periods.ts';

const uuid=z.string().uuid().transform(v=>v.toLowerCase()),version=z.number().int().positive().max(2147483647),text=z.string().refine(v=>v.isWellFormed()&&!v.includes('\0')),reason=text.trim().min(1).max(2000);
const ref=z.object({id:uuid,version}).strict();
const recordPayment=z.object({amount:text.max(80),collector:ref,method:ref,holdingAccount:ref,receivedById:uuid.nullable().default(null),receivedAt:z.iso.datetime({offset:true}).max(100),period:ref,
 reference:text.trim().max(200).default(''),evidence:ref.nullable().default(null),missingEvidenceReason:text.trim().max(2000).default(''),taxTreatment:z.literal('settle_invoice'),reason}).strict()
 .refine(v=>v.evidence!==null||v.missingEvidenceReason.length>0,'Attach receipt evidence or state the missing-evidence exception for the reviewer.');
// Parse the route-owned invoice separately: strict input must reject a caller
// choosing a different invoice, but stored approval payloads include it.
function paymentInput(raw:unknown){const {invoiceId,...rest}=z.object({invoiceId:uuid}).passthrough().parse(raw);return {...recordPayment.parse(rest),invoiceId};}
const reverse=z.object({period:ref,postedOn:accountingDate,reason}).strict();
function reversalInput(raw:unknown){const {receiptId,...rest}=z.object({receiptId:uuid}).passthrough().parse(raw);return {...reverse.parse(rest),receiptId};}
const paging={limit:z.coerce.number().int().min(1).max(100).default(50),after:uuid.optional()};
const query=z.object({...paging,hubId:uuid.optional(),studentId:uuid.optional(),invoiceId:uuid.optional(),collectorId:uuid.optional(),from:accountingDate.optional(),through:accountingDate.optional(),status:z.enum(['recorded','reversed']).optional()}).strict().refine(v=>!v.from||!v.through||v.from<=v.through);
type Receipt={id:string;invoice_id:string;student_id:string;class_id:string;hub_id:string;amount_minor:string;collector_id:string;collector_version:number;method_id:string;method_version:number;holding_account:string;holding_version:number;received_by:string|null;received_at:Date|string;received_on:string;reference:string;evidence_file:string|null;evidence_version:number|null;reversal_id:string|null};
function allowed(ctx:ApiContext,cap:Capability){const s=permissionScope(ctx,cap);if(!scopeNonempty(s))throw new ApiError(403,'FORBIDDEN');return s;}
async function receipt(ctx:ApiContext,id:string,edit=false):Promise<Receipt>{
 allowed(ctx,'receipts.view');const r=(await ctx.db.query<Receipt>('SELECT r.*,r.amount_minor::text,r.received_on::text FROM public.tuition_receipts r WHERE id=$1',[id])).rows[0];if(!r)throw new ApiError(404,'NOT_FOUND');financialRecordAuthority(ctx,r,'receipts.view');if(edit)financialRecordAuthority(ctx,r,'receipts.edit');return r;
}
async function balances(ctx:ApiContext,invoiceId:string){
 const row=(await ctx.db.query<{gross:string;received:string;credited:boolean;scale:number;currencyCode:string}>(`SELECT t.gross_minor::text AS gross,coalesce((SELECT sum(r.amount_minor) FROM public.tuition_receipts r WHERE r.academy_id=i.academy_id AND r.invoice_id=i.id AND r.reversal_id IS NULL),0)::text AS received,i.credit_id IS NOT NULL AS credited,p.unit_scale AS scale,c.code AS "currencyCode"
 FROM public.tuition_invoices i JOIN public.tuition_plans p ON p.academy_id=i.academy_id AND p.id=i.plan_id JOIN public.tuition_plan_revisions t ON t.academy_id=i.academy_id AND t.plan_id=i.plan_id AND t.version=i.plan_version JOIN public.finance_currencies c ON c.academy_id=p.academy_id AND c.id=p.currency_id WHERE i.id=$1`,[invoiceId])).rows[0];
 if(!row)throw new ApiError(404,'NOT_FOUND');const gross=readMinorUnits(row.gross),received=readMinorUnits(row.received),credited=row.credited?gross:0n,balance=gross-credited-received;
 return {gross,received,credited,balance,isCredited:row.credited,scale:row.scale,currencyCode:row.currencyCode};
}
function publicBalance(b:Awaited<ReturnType<typeof balances>>){return {invoiced:formatMoney(b.gross,b.scale),received:formatMoney(b.received,b.scale),credited:formatMoney(b.credited,b.scale),balance:formatMoney(b.balance,b.scale),currencyCode:b.currencyCode,
 paymentStatus:b.balance<0n?'customer_credit':b.isCredited?'credited':b.gross===0n?'no_payment_required':b.balance===0n?'paid':b.received>0n?'partially_paid':'unpaid',refundPerformed:false};}
async function basis(ctx:ApiContext,input:ReturnType<typeof paymentInput>,lock=false,checkState=true){
 const i=await invoiceRow(ctx,input.invoiceId),auth=financialRecordAuthority(ctx,i,'receipts.edit');financialRecordAuthority(ctx,i,'receipts.view');
 if(lock){await lockFinanceBook(ctx);await lockAcademyTopology(ctx);await ctx.db.query('SELECT id FROM public.tuition_invoices WHERE id=$1 FOR UPDATE',[i.id]);}
 const plan=await tuitionPlan(ctx,i.plan_id),terms=await tuitionDetail(ctx,plan,i.plan_version),amount=parseMoney(input.amount,plan.unit_scale);if(amount<=0n)throw new ApiError(400,'POSITIVE_RECEIPT_REQUIRED');
 const c=await collectorRow(ctx,input.collector.id),m=await paymentMethodRow(ctx,input.method.id),holding=await accountRow(ctx,input.holdingAccount.id),ar=await accountRow(ctx,(await ctx.db.query<{receivable_account:string}>('SELECT receivable_account FROM public.tuition_invoices WHERE id=$1',[i.id])).rows[0].receivable_account);
 if(c.version!==input.collector.version||!c.active)throw new ApiError(409,'COLLECTOR_CHANGED');if(m.version!==input.method.version||!m.active)throw new ApiError(409,'PAYMENT_METHOD_CHANGED');
 if((c.hub_id!==null&&c.hub_id!==i.hub_id)||(m.hubId!==null&&m.hubId!==i.hub_id)||holding.currencyId!==plan.currency_id||holding.unitScale!==plan.unit_scale||ar.unitScale!==plan.unit_scale||ar.operationalRole!=='receivable'||holding.id===ar.id
  ||(holding.hubId!==null&&holding.hubId!==i.hub_id)||holding.version!==input.holdingAccount.version||!holding.active
  ||(c.custody==='academy_funds'?!['cash','bank'].includes(holding.operationalRole):holding.operationalRole!=='collector_receivable')
  ||!c.accounts.some(a=>a.id===holding.id&&a.version===holding.version&&a.currencyId===plan.currency_id))throw new ApiError(400,'RECEIPT_MAPPING_INVALID');
 const receiver=input.receivedById?await permittedPerson(ctx,input.receivedById,'people.view'):null;if(receiver&&(await ctx.db.query('SELECT 1 FROM public.people WHERE id=$1 AND status=\'active\'',[receiver.id])).rows.length!==1)throw new ApiError(409,'ACTIVE_RECEIVER_REQUIRED');
 const evidence=input.evidence?await permittedFile(ctx,input.evidence.id):null;if(evidence&&(evidence.version!==input.evidence!.version||evidence.archived||evidence.person_id!==i.student_id||evidence.domain!=='student_private'))throw new ApiError(409,'RECEIPT_EVIDENCE_INVALID');
 const zone=(await ctx.db.query<{time_zone:string}>('SELECT time_zone FROM public.classes WHERE id=$1',[i.class_id])).rows[0].time_zone,on=Temporal.Instant.from(input.receivedAt).toZonedDateTimeISO(zone).toPlainDate().toString(),b=await balances(ctx,i.id);
 if(checkState){if(i.credit_id)throw new ApiError(409,'CREDITED_INVOICE_RECEIPT_FORBIDDEN');if(Temporal.Instant.compare(input.receivedAt,i.issued_at instanceof Date?i.issued_at.toISOString():i.issued_at)<0)throw new ApiError(409,'PRE_INVOICE_RECEIPT_WORKFLOW_REQUIRED');if(amount>b.balance)throw new ApiError(409,'RECEIPT_EXCEEDS_OUTSTANDING');}
 const journal={periodId:input.period.id,periodVersion:input.period.version,postedOn:on,description:'Recorded tuition payment',reference:input.reference,purpose:'activity' as const,reason:input.reason,lines:[{accountId:holding.id,accountVersion:holding.version,side:'debit' as const,amount:formatMoney(amount,plan.unit_scale)},{accountId:ar.id,accountVersion:ar.version,side:'credit' as const,amount:formatMoney(amount,plan.unit_scale)}]};
 await prepareJournal(ctx,false,journal,lock,checkState);
 return {auth,invoice:i,collector:c,method:m,holding:{id:holding.id,version:holding.version},receiver:receiver?{id:receiver.id}:null,evidence:evidence?{id:evidence.id,version:evidence.version}:null,amount:amount.toString(),on,balance:publicBalance(b),journal,tax:{classification:terms.classification,rateMillionths:terms.rateMillionths,taxTreatment:'settle_invoice',additionalTaxPosting:false}};
}
async function reversalBasis(ctx:ApiContext,input:ReturnType<typeof reversalInput>,lock=false,checkState=true){
 const r=await receipt(ctx,input.receiptId,true);if(lock){await lockFinanceBook(ctx);await lockAcademyTopology(ctx);await ctx.db.query('SELECT id FROM public.tuition_invoices WHERE id=$1 FOR UPDATE',[r.invoice_id]);await ctx.db.query('SELECT id FROM public.tuition_receipts WHERE id=$1 FOR UPDATE',[r.id]);}
 if(checkState&&r.reversal_id)throw new ApiError(409,'RECEIPT_ALREADY_REVERSED');if(input.postedOn<r.received_on)throw new ApiError(400,'CORRECTION_PRECEDES_RECEIPT');
 const journal={periodId:input.period.id,periodVersion:input.period.version,postedOn:input.postedOn,description:'Correction of recorded tuition payment',reference:r.reference,reason:input.reason,reversesId:r.id};await prepareJournal(ctx,true,journal,lock,checkState);return {receipt:r,journal};
}
async function detail(ctx:ApiContext,r:Receipt){
 const labels=(await ctx.db.query<{collectorName:string;methodName:string;methodCategory:string}>('SELECT c.name AS "collectorName",m.name AS "methodName",h.category AS "methodCategory" FROM public.finance_collector_revisions c JOIN public.finance_payment_method_revisions m ON m.academy_id=c.academy_id JOIN public.finance_payment_methods h ON h.academy_id=m.academy_id AND h.id=m.method_id WHERE c.collector_id=$1 AND c.version=$2 AND m.method_id=$3 AND m.version=$4',[r.collector_id,r.collector_version,r.method_id,r.method_version])).rows[0];
 const b=await balances(ctx,r.invoice_id);let evidence:null|{id:string;version:number;storedContentVerified:false}=null;
 if(r.evidence_file){try{await permittedFile(ctx,r.evidence_file);evidence={id:r.evidence_file,version:r.evidence_version!,storedContentVerified:false};}catch(error){if(!(error instanceof ApiError)||![403,404].includes(error.status))throw error;}}
 return {id:r.id,invoiceId:r.invoice_id,studentId:r.student_id,classId:r.class_id,hubId:r.hub_id,amount:formatMoney(readMinorUnits(r.amount_minor),b.scale),currencyCode:b.currencyCode,collectorId:r.collector_id,collectorVersion:r.collector_version,...labels,methodId:r.method_id,methodVersion:r.method_version,receivedById:r.received_by,receivedAt:r.received_at,receivedOn:r.received_on,reference:r.reference,status:r.reversal_id?'reversed':'recorded',reversalId:r.reversal_id,evidence,hasEvidenceReference:r.evidence_file!==null,missingEvidenceException:r.evidence_file===null,taxTreatment:'settle_invoice',additionalTaxPosting:false,externallyVerified:false,invoiceBalance:publicBalance(b)};
}
async function validate(ctx:ApiContext,reversing:boolean,raw:unknown){if(reversing){const b=await reversalBasis(ctx,reversalInput(raw),true,false);return financialRecordAuthority(ctx,b.receipt,'receipts.edit');}return(await basis(ctx,paymentInput(raw),true,false)).auth;}
async function dependencies(ctx:ApiContext,reversing:boolean,raw:unknown,purpose:'request'|'review'){
 try{const b=reversing?await reversalBasis(ctx,reversalInput(raw)):await basis(ctx,paymentInput(raw));return JSON.parse(JSON.stringify({...b,posting:await journalDependencies(ctx,reversing,b.journal,'review')}));}
 catch(error){if(purpose==='review'&&error instanceof ApiError&&[400,403,404,409].includes(error.status))return {unavailable:error.code};throw error;}
}
async function apply(ctx:ApiContext,p:Proposal){
 if(ctx.credential.kind!=='human')throw new ApiError(403,'HUMAN_REVIEW_REQUIRED');let result:Receipt;
 if(p.action==='finance.receipt.reverse'){const input=reversalInput(p.payload),b=await reversalBasis(ctx,input,true);await ctx.db.query('INSERT INTO public.tuition_receipt_reversals(academy_id,id,receipt_id,approval_id,reason) VALUES($1,$2,$3,$4,$5)',[ctx.credential.academy_id,p.target_id,b.receipt.id,p.id,input.reason]);await applyJournal(ctx,{...p,payload:b.journal},true);await ctx.db.query('UPDATE public.tuition_receipts SET reversal_id=$2 WHERE id=$1',[b.receipt.id,p.target_id]);result=await receipt(ctx,b.receipt.id);
 }else{const input=paymentInput(p.payload),b=await basis(ctx,input,true);try{await ctx.db.query(`INSERT INTO public.tuition_receipts(academy_id,id,invoice_id,student_id,class_id,hub_id,amount_minor,collector_id,collector_version,method_id,method_version,holding_account,holding_version,received_by,received_at,received_on,reference,evidence_file,evidence_version,missing_evidence_reason,tax_treatment,reason,approval_id,created_by)
  VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24)`,[ctx.credential.academy_id,p.target_id,b.invoice.id,b.invoice.student_id,b.invoice.class_id,b.invoice.hub_id,b.amount,input.collector.id,input.collector.version,input.method.id,input.method.version,input.holdingAccount.id,input.holdingAccount.version,input.receivedById,input.receivedAt,b.on,input.reference,input.evidence?.id??null,input.evidence?.version??null,input.missingEvidenceReason,input.taxTreatment,input.reason,p.id,ctx.credential.person_id]);
  }catch(error){if(error&&typeof error==='object'&&'code' in error&&error.code==='23505')throw new ApiError(409,'RECEIPT_REFERENCE_EXISTS');throw error;}
  await applyJournal(ctx,{...p,payload:b.journal},false);result=await receipt(ctx,p.target_id);
 }
 await record(ctx.db,ctx.credential,ctx.requestId,p.action==='finance.receipt.reverse'?'finance.receipt.reversed':'finance.receipt.recorded',result.id,result.hub_id,{approvalId:p.id,severity:'critical',missingEvidence:result.evidence_file===null,hasReason:true});return detail(ctx,result);
}
async function reviewer(ctx:ApiContext,p:Proposal){
 if(await master(ctx))return;const r=p.action==='finance.receipt.reverse'?await receipt(ctx,reversalInput(p.payload).receiptId):null,input=r?null:paymentInput(p.payload),i=await invoiceRow(ctx,r?r.invoice_id:input!.invoiceId),collectorId=r?r.collector_id:input!.collector.id;
 const person=(await ctx.db.query<{person_id:string|null}>('SELECT person_id FROM public.finance_collectors WHERE id=$1',[collectorId])).rows[0]?.person_id;
 if(person===ctx.credential.person_id||ctx.credential.person_id===i.student_id||input?.receivedById===ctx.credential.person_id||r?.received_by===ctx.credential.person_id||(await ctx.db.query('SELECT 1 FROM public.family_relationships WHERE student_id=$1 AND guardian_id=$2 LIMIT 1',[i.student_id,ctx.credential.person_id])).rows.length)throw new ApiError(403,'BENEFICIARY_REVIEW_FORBIDDEN');
}
export const receiptActions:ApprovalRegistry={
 'finance.receipt.record':{requestCapability:'receipts.edit',privacyCapability:'receipts.edit',createdStatus:201,validate:(c,id,i)=>validate(c,false,i),dependencies:(c,id,i,p)=>dependencies(c,false,i,p),authorizeReviewer:reviewer,apply},
 'finance.receipt.reverse':{requestCapability:'receipts.edit',privacyCapability:'receipts.edit',createdStatus:201,validate:(c,id,i)=>validate(c,true,i),dependencies:(c,id,i,p)=>dependencies(c,true,i,p),authorizeReviewer:reviewer,apply}
};
export async function receipts(ctx:ApiContext,registry:ApprovalRegistry=receiptActions):Promise<Reply|null>{
 const payment=/^finance\/invoices\/([^/]+)\/(receipts|payment-status)$/.exec(ctx.path),match=/^finance\/receipts(?:\/([^/]+)(?:\/(reverse))?)?$/.exec(ctx.path);if(!payment&&!match)return null;
 if(payment){const i=await invoiceRow(ctx,uuid.parse(payment[1]));financialRecordAuthority(ctx,i,'receipts.view');if(payment[2]==='payment-status'&&ctx.request.method==='GET'){z.object({}).strict().parse(Object.fromEntries(new URL(ctx.request.url).searchParams));return {status:200,body:{data:{invoiceId:i.id,...publicBalance(await balances(ctx,i.id))}}};}
  if(payment[2]!=='receipts'||ctx.request.method!=='POST')throw new ApiError(405,'METHOD_NOT_ALLOWED');z.object({}).strict().parse(Object.fromEntries(new URL(ctx.request.url).searchParams));financialRecordAuthority(ctx,i,'receipts.edit');const input={...recordPayment.parse(await jsonBody(ctx.request)),invoiceId:i.id};return propose(ctx,registry,'finance.receipt.record',null,0,input);
 }
 const id=match![1]?uuid.parse(match![1]):null,section=match![2];if(id){if(ctx.request.method==='POST'&&section==='reverse'){z.object({}).strict().parse(Object.fromEntries(new URL(ctx.request.url).searchParams));await receipt(ctx,id,true);const input={...reverse.parse(await jsonBody(ctx.request)),receiptId:id};return propose(ctx,registry,'finance.receipt.reverse',null,0,input);}if(ctx.request.method!=='GET'||section)throw new ApiError(405,'METHOD_NOT_ALLOWED');z.object({}).strict().parse(Object.fromEntries(new URL(ctx.request.url).searchParams));return {status:200,body:{data:await detail(ctx,await receipt(ctx,id))}};}
 if(ctx.request.method!=='GET')throw new ApiError(405,'METHOD_NOT_ALLOWED');const q=query.parse(Object.fromEntries(new URL(ctx.request.url).searchParams)),s=allowed(ctx,'receipts.view'),rows=(await ctx.db.query<{id:string;amountMinor:string;unitScale:number}>(`SELECT r.id,r.invoice_id AS "invoiceId",r.student_id AS "studentId",r.class_id AS "classId",r.hub_id AS "hubId",r.collector_id AS "collectorId",r.amount_minor::text AS "amountMinor",r.received_on::text AS "receivedOn",p.currency_id AS "currencyId",p.unit_scale AS "unitScale",c.code AS "currencyCode",CASE WHEN r.reversal_id IS NULL THEN 'recorded' ELSE 'reversed' END AS status FROM public.tuition_receipts r JOIN public.tuition_invoices i ON i.academy_id=r.academy_id AND i.id=r.invoice_id JOIN public.tuition_plans p ON p.academy_id=i.academy_id AND p.id=i.plan_id JOIN public.finance_currencies c ON c.academy_id=p.academy_id AND c.id=p.currency_id
 WHERE ($1::boolean OR r.hub_id=ANY($2::uuid[]) OR r.class_id=ANY($3::uuid[]) OR r.student_id=ANY($4::uuid[])) AND NOT r.hub_id=ANY($5::uuid[]) AND NOT r.class_id=ANY($6::uuid[]) AND NOT r.student_id=ANY($7::uuid[]) AND ($8::boolean OR r.hub_id=ANY($9::uuid[])) AND ($10::uuid IS NULL OR r.id>$10) AND ($11::uuid IS NULL OR r.hub_id=$11) AND ($12::uuid IS NULL OR r.student_id=$12) AND ($13::uuid IS NULL OR r.invoice_id=$13) AND ($14::uuid IS NULL OR r.collector_id=$14) AND ($15::date IS NULL OR r.received_on>=$15) AND ($16::date IS NULL OR r.received_on<=$16) AND ($17::text IS NULL OR(r.reversal_id IS NULL)=($17='recorded')) ORDER BY r.id LIMIT $18`,[s.all,s.hubs,(s.classes??[]).map(r=>r.id),(s.people??[]).map(r=>r.id),s.excludedHubs??[],(s.excludedClasses??[]).map(r=>r.id),(s.excludedPeople??[]).map(r=>r.id),ctx.credential.all_hubs,ctx.credential.hub_ids,q.after??null,q.hubId??null,q.studentId??null,q.invoiceId??null,q.collectorId??null,q.from??null,q.through??null,q.status??null,q.limit+1])).rows;return {status:200,body:{data:rows.slice(0,q.limit),nextCursor:rows.length>q.limit?rows[q.limit-1].id:null}};
}
export const receiptsContract=[
 {path:'/api/v1/finance/invoices/{id}/receipts',method:'post',summary:'Request an exact partial/full manually attested tuition receipt with named collector, versioned method/account and evidence or explicit missing-evidence exception. Settles previously invoiced tax, never creates a tax exemption or invokes a gateway.',schema:recordPayment},
 {path:'/api/v1/finance/invoices/{id}/payment-status',method:'get',summary:'Exact invoice/credit/active-receipt reconciliation. Negative balance is customer credit, not a performed refund.'},
 {path:'/api/v1/finance/receipts',method:'get',summary:'Permission-filtered receipt directory; reversed receipts remain visible and no uploaded-content safety or external settlement is implied',querySchema:query},
 {path:'/api/v1/finance/receipts/{id}',method:'get',summary:'Read a permitted immutable receipt and pinned collector/method labels; evidence references require current file permissions'},
 {path:'/api/v1/finance/receipts/{id}/reverse',method:'post',summary:'Request a reviewed exact journal correction without deleting the original or performing a cash refund',schema:reverse}
] as const;
