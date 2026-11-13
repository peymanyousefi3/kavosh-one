import { z } from 'zod';
import type { ApiContext,Reply } from '../core/api.ts';
import { ApiError } from '../core/policy.ts';
import { reportDateWindow } from '../core/report-window.ts';
import { readMinorUnits } from '../core/money.ts';
import { exactReportMoney } from '../core/aging.ts';
import { csvRow,csvText } from '../core/csv.ts';
import { t4aWorkingPaperData,assertT4aReportBounds,t4aWorkingPaperStatement,projectT4aWorkingPaper,type T4aWorkingPaperRows } from './t4a-working-paper.ts';
import { supplierTaxWorkingPaperData,supplierTaxReportAuthorization,supplierTaxReportConfigurationAccess,requireSupplierTaxReportResultAccess,supplierTaxReportJobAccess,supplierTaxWorkingPaperStatement,requireSupplierTaxWorkingPaperRows,projectSupplierTaxWorkingPaper,type SupplierTaxWorkingPaperRows } from './supplier-tax-working-paper.ts';
import { t4aReportAuthorization,t4aReportJobScope,t4aReportConfigurationAccess,requireT4aReportResultAccess } from './t4a-report-access.ts';
import type { paidTaxYtdCsv } from './paid-tax-ytd.ts';

const uuid=z.string().uuid().transform(v=>v.toLowerCase());
const query=z.object({personId:uuid,employerId:uuid,taxYear:z.coerce.number().int().min(1900).max(9999),timeZone:reportDateWindow.shape.timeZone}).strict();
export const consolidatedT4aAuthorization=z.object({kind:z.literal('consolidated_t4a_tax_year'),payroll:t4aReportAuthorization,supplier:supplierTaxReportAuthorization.nullable()}).strict().refine(p=>!p.supplier||(['employerId','taxYear','timeZone'] as const).every(k=>p.supplier![k]===p.payroll[k]));
export function consolidatedT4aJobAccess(ctx:ApiContext){t4aReportJobScope(ctx);supplierTaxReportJobAccess(ctx);}
export async function consolidatedT4aConfigurationAccess(ctx:ApiContext,parameters:Record<string,string>){
 const q=query.parse(parameters);await t4aReportConfigurationAccess(ctx,parameters);const payees=(await ctx.db.query<{id:string}>("SELECT id FROM public.financial_payees WHERE kind='person' AND person_id=$1 ORDER BY id LIMIT 2",[q.personId])).rows;
 if(payees.length>1)throw new ApiError(409,'T4A_PERSON_PAYEE_IDENTITY_AMBIGUOUS');if(payees.length)await supplierTaxReportConfigurationAccess(ctx,{payeeId:payees[0].id,employerId:q.employerId,taxYear:String(q.taxYear),timeZone:q.timeZone});
}
export async function requireConsolidatedT4aResultAccess(ctx:ApiContext,raw:unknown){
 const p=consolidatedT4aAuthorization.parse(raw);await requireT4aReportResultAccess(ctx,p.payroll);if(p.supplier){if(!(await ctx.db.query("SELECT 1 FROM public.financial_payees WHERE id=$1 AND kind='person' AND person_id=$2",[p.supplier.payeeId,p.payroll.personId])).rows.length)throw new ApiError(404,'NOT_FOUND');await requireSupplierTaxReportResultAccess(ctx,p.supplier);}
}
type Payroll=Awaited<ReturnType<typeof t4aWorkingPaperData>>;
type Supplier=Awaited<ReturnType<typeof supplierTaxWorkingPaperData>>;
type Allocation=Payroll['totals'];
const amountKeys=['gross','net','reportableIncome','excludedGstHst','excludedPst','otherExcluded'] as const;
function sum(rows:Allocation[]):Allocation {
 return {paymentCount:rows.reduce((n,r)=>n+r.paymentCount,0),...Object.fromEntries(amountKeys.map(k=>[k,exactReportMoney(rows.reduce((n,r)=>n+readMinorUnits(r[k].minor),0n),2)])) as Pick<Allocation,typeof amountKeys[number]>,fields:(['020','048','022'] as const).map(box=>{const amount=exactReportMoney(rows.reduce((n,r)=>n+readMinorUnits(r.fields.find(f=>f.box===box)!.amount.minor),0n),2);return {box,amount,printBlank:amount.minor==='0'};})};
}
export function consolidateT4aSources(payroll:Payroll,supplier:Supplier|null,atomicSnapshot=false){
 if(supplier&&(supplier.employerId!==payroll.employerId||supplier.taxYear!==payroll.taxYear||supplier.timeZone!==payroll.timeZone||supplier.recipientKind!=='person'))throw new ApiError(409,'T4A_CONSOLIDATION_SOURCE_MISMATCH');
 const sources=[...payroll.paymentSources.map(p=>({...p,sourceKind:'payroll' as const})),...(supplier?.paymentSources??[]).map(p=>({...p,sourceKind:'expense' as const}))];
 const keys=sources.map(p=>p.sourceKind+':'+p.paymentId);if(new Set(keys).size!==keys.length)throw new ApiError(409,'T4A_CONSOLIDATION_DUPLICATE_SOURCE');
 const paymentCount=payroll.paymentCount+(supplier?.paymentCount??0);assertT4aReportBounds(paymentCount,0,0);
 const accounts=new Map<string,typeof sources>(),months=new Map<string,typeof sources>();
 for(const p of sources)for(const [map,key]of [[accounts,p.reportingAccount.id],[months,p.paidOn!.slice(0,7)]] as const){const list=map.get(key)??[];list.push(p);map.set(key,list);}
 const unresolvedPayments=[...payroll.unresolvedPayments.map(p=>({...p,sourceKind:'payroll' as const})),...(supplier?.unresolvedPayments??[]).map(p=>({...p,sourceKind:'expense' as const}))];
 const data={report:'consolidated_reviewed_t4a_working_paper',personId:payroll.personId,employerId:payroll.employerId,taxYear:payroll.taxYear,timeZone:payroll.timeZone,currency:'CAD',linkedSupplierPayeeId:supplier?.payeeId??null,paymentCount,recognizedPaymentCount:sources.length,correctedPaymentCount:payroll.correctedPaymentCount+(supplier?.correctedPaymentCount??0),unresolvedPaymentCount:unresolvedPayments.length,
  totals:sum(sources),slips:[...accounts].sort(([a],[b])=>a.localeCompare(b)).map(([reportingAccountId,rows])=>({reportingAccountId,reportingAccountVersions:[...new Set(rows.map(p=>p.reportingAccount.version))].sort((a,b)=>a-b),...sum(rows)})),chartData:[...months].sort(([a],[b])=>a.localeCompare(b)).map(([month,rows])=>({month,...sum(rows)})),paymentSources:sources,unresolvedPayments,otherReviewedPayerPaymentIds:supplier?.otherReviewedPayerPaymentIds??[],
  sourceSnapshots:{payroll:payroll.snapshotAt,supplier:supplier?.snapshotAt??null},sourceConsistency:atomicSnapshot?'single_statement_payroll_supplier_and_person_link_snapshot':'sequential_authorized_source_snapshots_not_a_single_atomic_snapshot',identityBasis:'immutable_financial_payee_person_id_not_name_or_email_matching',deduplicationBasis:'unique_source_kind_and_payment_id;independently_recorded_economic_duplicates_require_review',completeWithinSelectedRecordedPayments:unresolvedPayments.length===0,coverage:{payroll:true,linkedPersonExpensePayee:supplier!==null,unlinkedAliases:false,externalPayments:false,foreignCurrencyRecognition:false,zeroNetAndNonCashRecognition:false},yearToDateComplete:false,isOfficialT4A:false,pdfGenerated:false,readyToIssue:false,craFilingPerformed:false,additionalLedgerPosting:false,paymentExecuted:false};
 assertT4aReportBounds(paymentCount,0,Buffer.byteLength(JSON.stringify(data)));return data;
}
export async function consolidatedT4aWorkingPaperData(ctx:ApiContext,captureAuthorization=false){
 if(ctx.request.method!=='GET')throw new ApiError(405,'METHOD_NOT_ALLOWED');const params=new URL(ctx.request.url).searchParams;if([...params].length!==new Set(params.keys()).size)throw new ApiError(400,'DUPLICATE_QUERY');const q=query.parse(Object.fromEntries(params)),payrollStatement=await t4aWorkingPaperStatement(ctx,q);
 const payees=(await ctx.db.query<{id:string}>("SELECT id FROM public.financial_payees WHERE kind='person' AND person_id=$1 ORDER BY id LIMIT 2",[q.personId])).rows;
 if(payees.length>1)throw new ApiError(409,'T4A_PERSON_PAYEE_IDENTITY_AMBIGUOUS');
 const supplierQuery=payees.length?{payeeId:payees[0].id,employerId:q.employerId,taxYear:q.taxYear,timeZone:q.timeZone}:null;
 const recipient=supplierQuery?await supplierTaxReportConfigurationAccess(ctx,{...supplierQuery,taxYear:String(q.taxYear)}):null;
 // Reuse each dedicated report's bound statement and projection. One MVCC
 // statement captures both money sources AND the person link;no global
 // financial writer lock or weaker authorization is introduced.
 const parameters:unknown[]=[],ctes:string[]=[];
 const add=(name:string,s:{sql:string;parameters:unknown[]})=>{const offset=parameters.length;parameters.push(...s.parameters);ctes.push(`${name} AS MATERIALIZED(${s.sql.replace(/\$(\d+)\b/g,(_m,n:string)=>'$'+(Number(n)+offset))})`);return `(SELECT to_jsonb(${name}) FROM ${name})`;};
 const payrollSQL=add('payroll_source',payrollStatement),supplierSQL=supplierQuery?add('supplier_source',supplierTaxWorkingPaperStatement(supplierQuery)):'NULL::jsonb';
 parameters.push(q.personId);
 const r=(await ctx.db.query<{payroll:T4aWorkingPaperRows;supplier:SupplierTaxWorkingPaperRows|null;payees:string[]}>(`WITH ${ctes.join(',')} SELECT ${payrollSQL} payroll,${supplierSQL} supplier,ARRAY(SELECT id::text FROM public.financial_payees WHERE kind='person' AND person_id=$${parameters.length} ORDER BY id LIMIT 2) payees`,parameters)).rows[0];
 // A newly created link during configuration must not silently omit supplier
 // payments. Refuse and allow a fresh authorized request instead.
 if(r.payees.length>1)throw new ApiError(409,'T4A_PERSON_PAYEE_IDENTITY_AMBIGUOUS');
 if(JSON.stringify(r.payees)!==JSON.stringify(payees.map(p=>p.id)))throw new ApiError(409,'T4A_PERSON_PAYEE_IDENTITY_CHANGED');
 if(supplierQuery&&!r.supplier)throw new Error('T4A_SUPPLIER_SNAPSHOT_MISSING');
 const payroll=projectT4aWorkingPaper(q,r.payroll,captureAuthorization);
 assertT4aReportBounds(r.payroll.candidates+(r.supplier?.count??0),r.payroll.lines+(r.supplier?.lines??0),2*(Number(r.payroll.bytes)+Number(r.supplier?.bytes??0)));
 const supplier=supplierQuery&&recipient&&r.supplier?projectSupplierTaxWorkingPaper(supplierQuery,recipient,await requireSupplierTaxWorkingPaperRows(ctx,r.supplier),captureAuthorization):null;
 return {...consolidateT4aSources(payroll,supplier,true),...(captureAuthorization?{authorizationContext:consolidatedT4aAuthorization.parse({kind:'consolidated_t4a_tax_year',payroll:payroll.authorizationContext,supplier:supplier?.authorizationContext??null})}:{})};
}
export function consolidatedT4aCsv(d:Awaited<ReturnType<typeof consolidatedT4aWorkingPaperData>>,provenance?:Parameters<typeof paidTaxYtdCsv>[1]):Reply{
 const rows:(string|number|boolean|null|undefined)[][]=[['section','field','value','source_kind','payment_id','posting_or_bill_id','recognition_version','paid_on','reporting_account_id','box','minor','amount']],meta=(k:string,v:unknown)=>rows.push(['metadata',k,csvText(typeof v==='string'?v:JSON.stringify(v))]);
 for(const k of ['report','personId','employerId','taxYear','timeZone','currency','linkedSupplierPayeeId','paymentCount','recognizedPaymentCount','correctedPaymentCount','unresolvedPaymentCount','otherReviewedPayerPaymentIds','sourceSnapshots','sourceConsistency','identityBasis','deduplicationBasis','completeWithinSelectedRecordedPayments','coverage','yearToDateComplete','isOfficialT4A','pdfGenerated','readyToIssue','craFilingPerformed','additionalLedgerPosting','paymentExecuted'] as const)meta(k,d[k]);
 meta('numericPrecisionPolicy','Exact decimal text;import monetary fields as text.');if(provenance)for(const k of ['id','version','retryOfJobId','scheduledOccurrence','dateWindow'] as const)if(provenance[k]!==undefined)meta('provenance.'+k,provenance[k]);
 const emit=(section:string,t:Allocation,account='',on='',p?:typeof d.paymentSources[number])=>{const refs=[p?.sourceKind,p?.paymentId,p&&('postingId'in p?p.postingId:p.billId),p?.recognitionVersion,on,account];for(const k of amountKeys)rows.push([section,k,'',...refs,'',t[k].minor,t[k].amount]);for(const f of t.fields)rows.push([section,'reporting_box','',...refs,f.box,f.amount.minor,f.amount.amount]);};
 emit('annual_total',d.totals);for(const s of d.slips){meta('rp_editions.'+s.reportingAccountId,s.reportingAccountVersions);emit('rp_working_slip',s,s.reportingAccountId);}for(const m of d.chartData)emit('monthly_chart',m,'',m.month);for(const p of d.paymentSources)emit('payment_allocation',p,p.reportingAccount.id,p.paidOn??'',p);for(const p of d.unresolvedPayments)rows.push(['unresolved_payment','warning',p.code,p.sourceKind,p.paymentId,'postingId'in p?p.postingId:p.billId]);
 const body='\uFEFF'+rows.map(r=>csvRow(Array.from({length:12},(_,i)=>r[i]))).join('\r\n')+'\r\n';assertT4aReportBounds(d.paymentCount,0,Buffer.byteLength(body));return {status:200,body,csv:{filename:`consolidated-t4a-working-paper-${d.taxYear}.csv`}};
}
export async function completeConsolidatedT4aExport(ctx:ApiContext,provenance?:Parameters<typeof paidTaxYtdCsv>[1]){return consolidatedT4aCsv(await consolidatedT4aWorkingPaperData(ctx),provenance);}
export async function consolidatedT4aWorkingPaper(ctx:ApiContext):Promise<Reply|null>{if(!['reports/payroll/t4a-consolidated-working-paper','reports/payroll/t4a-consolidated-working-paper/export'].includes(ctx.path))return null;return ctx.path.endsWith('/export')?completeConsolidatedT4aExport(ctx):{status:200,body:{data:await consolidatedT4aWorkingPaperData(ctx)}};}
export const consolidatedT4aContract=[{path:'/api/v1/reports/payroll/t4a-consolidated-working-paper',method:'get',querySchema:query,summary:'One-person/payer/year reviewed payroll plus immutably linked person supplier-payment working paper. Current whole-source authorization for both domains;exact CAD annual/RP/monthly totals and namespaced payment references,unresolved warnings. Payroll,supplier money/recognition and person link share one database statement snapshot;concurrently changed configuration links require retry. Not a year-end certificate;economic duplicates,aliases,external,FX and zero-net/noncash require further review. No official form or CRA filing. Combined500payment/4MiB bound refuses truncation.'}] as const;
export const consolidatedT4aExportContract=[{path:'/api/v1/reports/payroll/t4a-consolidated-working-paper/export',method:'get',querySchema:query,responseContentType:'text/csv' as const,summary:'Same-source private consolidated payroll/supplier annual CSV,exact decimals,RP editions,monthly charts and unresolved warning references;no private notes,legal recipient identity,RP account numbers or official form.'}] as const;
