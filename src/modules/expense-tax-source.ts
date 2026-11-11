import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { ApiContext,Reply } from '../core/api.ts';
import { permissionScope,lockApprovalWrites } from '../core/approvals.ts';
import { ApiError,scopeContains } from '../core/policy.ts';
import { lockAcademyTopology } from './academy.ts';
import { authorizedExpensePayment } from './expense-payments.ts';
import { expenseBillRow } from './expenses.ts';
import { financeJournalRow } from './finance-journals.ts';
import { accountSelection } from './finance.ts';
import { payeeSelection } from './payees.ts';
import { paymentMethodRow } from './payment-methods.ts';
import { requirePayrollEmployerView } from './payroll-employers.ts';
import { reportDateWindow } from '../core/report-window.ts';
import { exactReportMoney as exact } from '../core/aging.ts';

const uuid=z.string().uuid().transform(v=>v.toLowerCase()),query=z.object({timeZone:reportDateWindow.shape.timeZone}).strict();
// Financial source inspection,not a classification or a second payment. A
// later reviewed recognition must pin these original facts and select a payer.
export async function expenseTaxSource(ctx:ApiContext):Promise<Reply|null>{
 const match=/^finance\/expense-payments\/([^/]+)\/tax-source$/.exec(ctx.path);if(!match)return null;
 if(ctx.request.method!=='GET')throw new ApiError(405,'METHOD_NOT_ALLOWED');const id=uuid.parse(match[1]),params=new URL(ctx.request.url).searchParams;if([...params].length!==new Set(params.keys()).size)throw new ApiError(400,'DUPLICATE_QUERY');const q=query.parse(Object.fromEntries(params));
 requirePayrollEmployerView(ctx);if(!scopeContains(permissionScope(ctx,'payroll-tax.view'),{all:true,hubs:[]}))throw new ApiError(403,'FORBIDDEN');
 await lockApprovalWrites(ctx);let payment=await authorizedExpensePayment(ctx,id);await lockAcademyTopology(ctx);
 // Same order as expense reversal:bill then payment. Re-read after waiting so
 // a concurrent correction cannot combine old flags with new source amounts.
 await ctx.db.query('SELECT id FROM public.expense_bills WHERE id=$1 FOR SHARE',[payment.bill_id]);await ctx.db.query('SELECT id FROM public.expense_payments WHERE id=$1 FOR SHARE',[id]);payment=await authorizedExpensePayment(ctx,id);
 const bill=await expenseBillRow(ctx,payment.bill_id),[recipient]=await payeeSelection(ctx,[{id:bill.payee_id,version:bill.payee_version}]);if(!recipient)throw new ApiError(404,'NOT_FOUND');
 const billJournal=await financeJournalRow(ctx,bill.id),paymentJournal=await financeJournalRow(ctx,id);if(payment.method_id)await paymentMethodRow(ctx,payment.method_id);
 const accountIds=[...new Set([...billJournal.lines,...paymentJournal.lines].map(l=>l.accountId))];if((await accountSelection(ctx,accountIds)).length!==accountIds.length)throw new ApiError(404,'NOT_FOUND');
 const dated=(await ctx.db.query<{paidAt:string|null;paidOn:string|null;taxYear:number|null;observedAt:string;currencyCode:string;methodName:string|null}>(`SELECT to_char(p.paid_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') "paidAt",(p.paid_at AT TIME ZONE $2)::date::text "paidOn",extract(year FROM p.paid_at AT TIME ZONE $2)::integer "taxYear",statement_timestamp()::text "observedAt",c.code "currencyCode",m.name "methodName" FROM public.expense_payments p JOIN public.expense_bills b ON b.academy_id=p.academy_id AND b.id=p.bill_id JOIN public.finance_currencies c ON c.academy_id=b.academy_id AND c.id=b.currency_id LEFT JOIN public.finance_payment_method_revisions m ON m.academy_id=p.academy_id AND m.method_id=p.method_id AND m.version=p.method_version WHERE p.id=$1`,[id,q.timeZone])).rows[0];if(!dated)throw new ApiError(404,'NOT_FOUND');
 const refs=(j:typeof billJournal)=>j.lines.map(l=>({id:l.accountId,version:l.accountVersion})).sort((a,b)=>a.id.localeCompare(b.id)||a.version-b.version),facts={sourceKind:'expense_payment',paymentId:id,billId:bill.id,timeZone:q.timeZone,currencyId:bill.currency_id,currencyVersion:bill.currency_version,currencyCode:dated.currencyCode,unitScale:bill.unit_scale,settlementKind:payment.settlement_kind??'cash',settlementAmount:exact(payment.amount_minor,bill.unit_scale),paidAt:dated.paidAt,paidOn:dated.paidOn,taxYear:dated.taxYear,postedOn:payment.posted_on,paymentReversalId:payment.reversal_id,billVoidId:bill.void_id,
 recipient:{id:recipient.id,version:recipient.version,kind:recipient.kind,personId:recipient.person_id,name:recipient.name,legalName:recipient.legalName},bill:{documentNumber:bill.document_number,issuedOn:bill.issued_on,net:exact(bill.net_minor,bill.unit_scale),tax:exact(bill.tax_minor,bill.unit_scale),gross:exact(bill.gross_minor,bill.unit_scale)},method:payment.method_id?{id:payment.method_id,version:payment.method_version,name:dated.methodName}:null,originalAccounts:{bill:refs(billJournal),payment:refs(paymentJournal)}};
 const warnings=[...facts.currencyCode!=='CAD'||facts.unitScale!==2?['CAD_REPORTING_CONVERSION_REVIEW_REQUIRED']:[],...facts.settlementKind!=='cash'||!facts.paidOn?['NONCASH_PAID_DATE_REVIEW_REQUIRED']:[],...facts.paymentReversalId||facts.billVoidId?['REVERSED_FINANCIAL_SOURCE_REVIEW_REQUIRED']:[],...!['person','organization'].includes(recipient.kind)?['SERVICE_RECIPIENT_CLASSIFICATION_REVIEW_REQUIRED']:[]];
 return {status:200,body:{data:{...facts,sourceSha256:createHash('sha256').update(JSON.stringify(facts)).digest('hex'),sourceHashBasis:'explicit_original_financial_projection_json_utf8',observedAt:dated.observedAt,warnings,payerAssigned:false,serviceEligibilityVerified:false,grossForTaxDetermined:false,withholdingDetermined:false,taxAllocationRecorded:false,isOfficialT4A:false,readyToIssue:false,craFilingPerformed:false,additionalLedgerPosting:false,paymentExecuted:false}}};
}
export const expenseTaxSourceContract=[{path:'/api/v1/finance/expense-payments/{id}/tax-source',method:'get',querySchema:query,summary:'Private original expense-payment source for reviewed Canadian income reporting. Requires school-wide tax/private-employer rights plus current original bill,payment,payee,both-journal/account and method rights. Pins original recipient/currency/method editions,exact settlement and bill amounts and actual paid instant/year in explicit IANA timezone;noncash/reversal/FX issues stay warnings. Locks bill before payment and rereads after waits. No guessed payer,employment/residency decision,gross/withholding inference,tax allocation,second payment or official form.'}] as const;
