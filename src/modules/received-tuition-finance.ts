import { z } from 'zod';
import type { ApiContext,Reply } from '../core/api.ts';
import { ApiError } from '../core/policy.ts';
import { formatMoney,readMinorUnits } from '../core/money.ts';
import { receivedTuitionScope } from './received-tuition.ts';
import { invoiceBalanceValues,publicBalance } from './receipts.ts';

const uuid=z.string().uuid().transform(v=>v.toLowerCase()),empty=z.object({}).strict();
const paging={limit:z.coerce.number().int().min(1).max(50).default(20),after:uuid.optional()};
const query=z.object({...paging,status:z.enum(['issued','credited']).optional()}).strict(),receiptQuery=z.object({...paging,status:z.enum(['recorded','reversed']).optional()}).strict();
type Invoice={id:string;number:string;issuedAt:string|Date;issuedOn:string;planId:string;planVersion:number;classId:string;hubId:string;gross:string;net:string;tax:string;received:string;credited:boolean;scale:number;currencyCode:string;accountingPosted:boolean;[key:string]:unknown};
export async function receivedTuitionFinance(ctx:ApiContext):Promise<Reply|null>{
 const m=/^students\/([^/]+)\/tuition-invoices(?:\/([^/]+)(?:\/(receipts))?)?$/.exec(ctx.path);if(!m)return null;
 if(ctx.request.method!=='GET')throw new ApiError(405,'METHOD_NOT_ALLOWED');
 const studentId=uuid.parse(m[1]),id=m[2]?uuid.parse(m[2]):null,receipts=Boolean(m[3]),params=new URL(ctx.request.url).searchParams;
 if([...params].length!==new Set(params.keys()).size)throw new ApiError(400,'DUPLICATE_QUERY');
 const q=!id?query.parse(Object.fromEntries(params)):null,rq=receipts?receiptQuery.parse(Object.fromEntries(params)):null;if(id&&!receipts)empty.parse(Object.fromEntries(params));
 const scope=await receivedTuitionScope(ctx,studentId);
 // Immutable invoice terms,credit and active receipts share ONE statement
 // snapshot. Never infer received money from a tuition/installment schedule.
 const rows=(await ctx.db.query<Invoice>(`WITH recipient AS MATERIALIZED(SELECT public.registration_data_basis($1,$2) IS NOT NULL allowed)
 SELECT i.id,d.number,d.issued_at "issuedAt",d.issued_on::text "issuedOn",i.plan_id "planId",i.plan_version "planVersion",i.class_id "classId",i.hub_id "hubId",i.journal_id IS NOT NULL "accountingPosted",
 t.gross_minor::text gross,t.net_minor::text net,t.tax_minor::text tax,p.unit_scale scale,c.code "currencyCode",i.credit_id IS NOT NULL credited,
 coalesce((SELECT sum(r.amount_minor) FROM public.tuition_receipts r WHERE r.academy_id=i.academy_id AND r.invoice_id=i.id AND r.reversal_id IS NULL),0)::text received
 ${id?',v.definition issuer,credit.number "creditNoteNumber"':''}
 FROM public.tuition_invoices i JOIN public.billing_documents d ON d.academy_id=i.academy_id AND d.id=i.id
 JOIN public.tuition_plans p ON p.academy_id=i.academy_id AND p.id=i.plan_id
 JOIN public.tuition_plan_revisions t ON t.academy_id=i.academy_id AND t.plan_id=i.plan_id AND t.version=i.plan_version
 JOIN public.finance_currencies c ON c.academy_id=p.academy_id AND c.id=p.currency_id
 ${id?'JOIN public.invoice_issuer_revisions v ON v.academy_id=d.academy_id AND v.issuer_id=d.issuer_id AND v.version=d.issuer_version LEFT JOIN public.billing_documents credit ON credit.academy_id=i.academy_id AND credit.id=i.credit_id':''} CROSS JOIN recipient
 WHERE i.student_id=$1 AND recipient.allowed AND public.scope_contains($3::jsonb,jsonb_build_object('all',false,'hubs','[]'::jsonb,'people',jsonb_build_array(jsonb_build_object('id',i.student_id,'hubId',i.hub_id)),'recordContext',jsonb_build_object('hubId',i.hub_id,'classId',i.class_id,'studentId',i.student_id)))
 AND($4::uuid IS NULL OR i.id=$4) AND($5::uuid IS NULL OR i.id>$5) AND($6::text IS NULL OR CASE WHEN i.credit_id IS NULL THEN 'issued' ELSE 'credited' END=$6) ORDER BY i.id LIMIT $7`,[studentId,ctx.credential.person_id,JSON.stringify(scope),id,q?.after??null,q?.status??null,id?1:q!.limit+1])).rows;
 const view=(r:Invoice)=>{const {gross,net,tax,received,credited,scale,...safe}=r;return {...safe,unitScale:scale,net:formatMoney(readMinorUnits(net),scale),tax:formatMoney(readMinorUnits(tax),scale),status:credited?'credited':'issued',...publicBalance(invoiceBalanceValues(r)),planningOnly:false,externalSettlementVerified:false};};
 if(!id)return {status:200,body:{studentId,data:rows.slice(0,q!.limit).map(view),nextCursor:rows.length>q!.limit?rows[q!.limit-1].id:null,privateFamilyOnly:true}};
 if(!rows[0])throw new ApiError(404,'NOT_FOUND');if(!receipts)return {status:200,body:{data:view(rows[0]),privateFamilyOnly:true}};
 // Only the original invoice's recorded payments;never expose holding
 // accounts,bank mappings,private review reasons or raw evidence pointers.
 const payments=(await ctx.db.query<{id:string;amountMinor:string;[key:string]:unknown}>(`SELECT r.id,r.received_at "receivedAt",r.received_on::text "receivedOn",r.reference,r.amount_minor::text "amountMinor",r.reversal_id IS NULL active,
 CASE WHEN r.reversal_id IS NULL THEN 'recorded' ELSE 'reversed' END status,m.name "methodName",c.name "collectorName"
 FROM public.tuition_receipts r JOIN public.finance_payment_method_revisions m ON m.academy_id=r.academy_id AND m.method_id=r.method_id AND m.version=r.method_version
 JOIN public.finance_collector_revisions c ON c.academy_id=r.academy_id AND c.collector_id=r.collector_id AND c.version=r.collector_version
 WHERE r.invoice_id=$1 AND($2::uuid IS NULL OR r.id>$2) AND($3::text IS NULL OR CASE WHEN r.reversal_id IS NULL THEN 'recorded' ELSE 'reversed' END=$3) ORDER BY r.id LIMIT $4`,[id,rq!.after??null,rq!.status??null,rq!.limit+1])).rows;
 return {status:200,body:{studentId,invoiceId:id,currencyCode:rows[0].currencyCode,data:payments.slice(0,rq!.limit).map(({amountMinor,...r})=>({...r,amount:formatMoney(readMinorUnits(amountMinor),rows[0].scale),externalSettlementVerified:false})),nextCursor:payments.length>rq!.limit?payments[rq!.limit-1].id:null,privateFamilyOnly:true}};
}
export const receivedTuitionFinanceContract=[
 {path:'/api/v1/students/{id}/tuition-invoices',method:'get',humanOnly:true,summary:'Own/current verified legal family issued/credited tuition invoices under received-tuition.view and exact record scope before bounded paging. Pinned invoice amounts,active recorded receipts and credit share one statement snapshot;never infer cash from a payment plan.',querySchema:query},
 {path:'/api/v1/students/{id}/tuition-invoices/{invoiceId}',method:'get',humanOnly:true,summary:'Current canonical invoice balance,partial/paid/customer-credit status and pinned school issuer. No other guardian identity,private review/account mappings or historical override. Recorded payments are not independently verified bank settlement;credit does not perform a refund.',querySchema:empty},
 {path:'/api/v1/students/{id}/tuition-invoices/{invoiceId}/receipts',method:'get',humanOnly:true,summary:'Bounded original payment history with pinned collector/method labels and explicit reversed status. No bank/holding accounts,staff reasons or evidence links;current family authority and exact invoice scope required.',querySchema:receiptQuery}
] as const;
