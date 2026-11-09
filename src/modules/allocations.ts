import { z } from 'zod';
import { isDeepStrictEqual } from 'node:util';
import { jsonBody,record,type ApiContext,type Reply } from '../core/api.ts';
import { propose,type ApprovalRegistry,type Proposal } from '../core/approvals.ts';
import { ApiError } from '../core/policy.ts';
import { parseMoney,readMinorUnits,formatMoney } from '../core/money.ts';
import { lockFinanceBook } from '../core/finance-lock.ts';
import { lockAcademyTopology } from './academy.ts';
import { financialRecordAuthority } from './tuition.ts';
import { invoiceRow } from './invoices.ts';
import { receiptRow,authorizeReceiptReviewer } from './receipts.ts';
import { accountingDate } from './finance-periods.ts';

const uuid=z.string().uuid().transform(v=>v.toLowerCase()),version=z.number().int().min(0).max(2147483646),text=z.string().refine(v=>v.isWellFormed()&&!v.includes('\0')),reason=text.trim().min(1).max(2000);
const line=z.object({installment:z.number().int().min(1).max(1000),amount:text.max(80)}).strict();
const fields={expectedVersion:version,mode:z.enum(['manual','oldest_due']),lines:z.array(line).max(1000).nullable().default(null),amount:text.max(80).nullable().default(null)};
function compatible(v:{mode:string;lines:unknown;amount:unknown}){return v.mode==='manual'?v.lines!==null&&v.amount===null:v.lines===null;}
const selection=z.object(fields).strict().refine(compatible),change=z.object({...fields,reason}).strict().refine(compatible);
function payload(raw:unknown){const {receiptId,...rest}=z.object({receiptId:uuid}).passthrough().parse(raw);return {...change.parse(rest),receiptId};}
const readQuery=z.object({version:z.coerce.number().int().min(1).max(2147483647).optional()}).strict();
const historyQuery=z.object({limit:z.coerce.number().int().min(1).max(100).default(50),afterVersion:z.coerce.number().int().min(0).max(2147483647).default(0)}).strict();
const statusQuery=z.object({overdueOn:accountingDate.optional()}).strict();
type Parent={plan_id:string;plan_version:number;credit_id:string|null;unit_scale:number;currencyCode:string;time_zone:string};
type Installment={ordinal:number;due_on:string;amount_minor:string};
function oldestDue(installments:Installment[],used:Map<number,bigint>,budget:bigint){
 const lines:{installment:number;amountMinor:string}[]=[];let remaining=budget;
 for(const t of installments){const due=readMinorUnits(t.amount_minor)-(used.get(t.ordinal)??0n),amount=due<remaining?due:remaining;if(amount>0n){lines.push({installment:t.ordinal,amountMinor:amount.toString()});remaining-=amount;}if(remaining===0n)break;}return lines;
}
async function parent(ctx:ApiContext,invoiceId:string){const i=(await ctx.db.query<Parent>('SELECT i.plan_id,i.plan_version,i.credit_id,p.unit_scale,c.code AS "currencyCode",cl.time_zone FROM public.tuition_invoices i JOIN public.tuition_plans p ON p.academy_id=i.academy_id AND p.id=i.plan_id JOIN public.finance_currencies c ON c.academy_id=p.academy_id AND c.id=p.currency_id JOIN public.classes cl ON cl.academy_id=i.academy_id AND cl.id=i.class_id WHERE i.id=$1',[invoiceId])).rows[0];if(!i)throw new ApiError(404,'NOT_FOUND');return i;}
async function currentVersion(ctx:ApiContext,receiptId:string){return(await ctx.db.query<{version:number}>('SELECT version FROM public.receipt_allocation_plans WHERE receipt_id=$1',[receiptId])).rows[0]?.version??0;}
async function schedule(ctx:ApiContext,i:Parent){return(await ctx.db.query<Installment>('SELECT ordinal,due_on::text,amount_minor::text FROM public.tuition_installments WHERE plan_id=$1 AND version=$2 ORDER BY due_on,ordinal',[i.plan_id,i.plan_version])).rows;}
async function applied(ctx:ApiContext,invoiceId:string,except:string|null=null){return(await ctx.db.query<{installment:number;amount:string}>(`SELECT l.installment,sum(l.amount_minor)::text AS amount FROM public.receipt_allocation_lines l JOIN public.receipt_allocation_plans h ON h.academy_id=l.academy_id AND h.receipt_id=l.receipt_id AND h.version=l.version JOIN public.tuition_receipts r ON r.academy_id=h.academy_id AND r.id=h.receipt_id WHERE r.invoice_id=$1 AND r.reversal_id IS NULL AND ($2::uuid IS NULL OR r.id<>$2) GROUP BY l.installment ORDER BY l.installment`,[invoiceId,except])).rows;}
async function basis(ctx:ApiContext,receiptId:string,input:z.infer<typeof selection>,lock=false,checkState=true){
 let r=await receiptRow(ctx,receiptId);const auth=financialRecordAuthority(ctx,r,'allocations.edit');financialRecordAuthority(ctx,r,'allocations.view');
 if(lock){await lockFinanceBook(ctx);await lockAcademyTopology(ctx);await ctx.db.query('SELECT id FROM public.tuition_invoices WHERE id=$1 FOR UPDATE',[r.invoice_id]);await ctx.db.query('SELECT id FROM public.tuition_receipts WHERE id=$1 FOR UPDATE',[r.id]);r=await receiptRow(ctx,receiptId);}
 const i=await parent(ctx,r.invoice_id),v=await currentVersion(ctx,r.id),installments=await schedule(ctx,i),other=await applied(ctx,r.invoice_id,r.id),used=new Map(other.map(a=>[a.installment,readMinorUnits(a.amount)])),byOrdinal=new Map(installments.map(t=>[t.ordinal,t]));
 if(checkState){if(r.reversal_id||i.credit_id)throw new ApiError(409,'ACTIVE_RECEIPT_AND_INVOICE_REQUIRED');if(v!==input.expectedVersion)throw new ApiError(409,'ALLOCATION_VERSION_CHANGED');}
 const receiptAmount=readMinorUnits(r.amount_minor),lines:{installment:number;amountMinor:string}[]=[];
 if(input.mode==='manual'){
  if(new Set(input.lines!.map(l=>l.installment)).size!==input.lines!.length)throw new ApiError(400,'DUPLICATE_INSTALLMENT');
  for(const l of input.lines!){if(!byOrdinal.has(l.installment))throw new ApiError(400,'INSTALLMENT_NOT_IN_INVOICE');const minor=parseMoney(l.amount,i.unit_scale);if(minor<=0n)throw new ApiError(400,'POSITIVE_ALLOCATION_REQUIRED');lines.push({installment:l.installment,amountMinor:minor.toString()});}
 }else{
  const budget=input.amount===null?receiptAmount:parseMoney(input.amount,i.unit_scale);if(budget<0n||budget>receiptAmount)throw new ApiError(400,'ALLOCATION_EXCEEDS_RECEIPT');
  lines.push(...oldestDue(installments,used,budget));
 }
 lines.sort((a,b)=>a.installment-b.installment);const total=lines.reduce((s,l)=>s+readMinorUnits(l.amountMinor),0n);
 if(checkState){if(total>receiptAmount)throw new ApiError(400,'ALLOCATION_EXCEEDS_RECEIPT');for(const l of lines)if(readMinorUnits(l.amountMinor)+(used.get(l.installment)??0n)>readMinorUnits(byOrdinal.get(l.installment)!.amount_minor))throw new ApiError(409,'INSTALLMENT_OVERALLOCATED');}
 return {auth,receipt:{id:r.id,invoiceId:r.invoice_id,amountMinor:r.amount_minor,reversalId:r.reversal_id},parent:i,currentVersion:v,installments,other,lines,total:total.toString(),unallocated:(receiptAmount-total).toString()};
}
async function detail(ctx:ApiContext,receiptId:string,selectedVersion?:number){
 const r=await receiptRow(ctx,receiptId);financialRecordAuthority(ctx,r,'allocations.view');
 // A single database snapshot keeps receipt reversal, current revision and
 // immutable line totals consistent without blocking concurrent writers.
 const s=(await ctx.db.query<{currentVersion:number;version:number|null;mode:string|null;total:string|null;amount:string;reversal_id:string|null;credit_id:string|null;scale:number;currencyCode:string;createdAt:Date|string|null;lines:{installment:number;amount:string}[]}>(`SELECT coalesce(h.version,0) AS "currentVersion",v.version,v.mode,v.total_minor::text AS total,r.amount_minor::text AS amount,r.reversal_id,i.credit_id,p.unit_scale AS scale,c.code AS "currencyCode",v.created_at AS "createdAt",
 coalesce((SELECT jsonb_agg(jsonb_build_object('installment',l.installment,'amount',l.amount_minor::text) ORDER BY l.installment) FROM public.receipt_allocation_lines l WHERE l.academy_id=r.academy_id AND l.receipt_id=r.id AND l.version=v.version),'[]'::jsonb) AS lines
 FROM public.tuition_receipts r JOIN public.tuition_invoices i ON i.academy_id=r.academy_id AND i.id=r.invoice_id JOIN public.tuition_plans p ON p.academy_id=i.academy_id AND p.id=i.plan_id JOIN public.finance_currencies c ON c.academy_id=p.academy_id AND c.id=p.currency_id
 LEFT JOIN public.receipt_allocation_plans h ON h.academy_id=r.academy_id AND h.receipt_id=r.id LEFT JOIN public.receipt_allocation_revisions v ON v.academy_id=r.academy_id AND v.receipt_id=r.id AND v.version=coalesce($2::integer,h.version)
 WHERE r.id=$1`,[r.id,selectedVersion??null])).rows[0];
 if(selectedVersion&&!s.version)throw new ApiError(404,'NOT_FOUND');const v=s.version??0,total=readMinorUnits(s.total??'0'),amount=readMinorUnits(s.amount),active=v>0&&!s.reversal_id&&!s.credit_id&&v===s.currentVersion;
 return {receiptId:r.id,invoiceId:r.invoice_id,version:v,currentVersion:s.currentVersion,mode:s.mode,currencyCode:s.currencyCode,receiptAmount:formatMoney(amount,s.scale),allocated:formatMoney(total,s.scale),unallocated:formatMoney(amount-total,s.scale),effectiveAllocated:formatMoney(active?total:0n,s.scale),active,lines:s.lines.map(l=>({...l,amount:formatMoney(readMinorUnits(l.amount),s.scale)})),createdAt:s.createdAt,additionalLedgerPosting:false};
}
async function installmentSnapshot(ctx:ApiContext,invoiceId:string){
 type Snapshot={credit_id:string|null;scale:number;currencyCode:string;today:string;received:string;installments:{installment:number;dueOn:string;planned:string;allocated:string}[]};
 return(await ctx.db.query<{snapshot:Snapshot|null}>('SELECT public.tuition_installment_snapshot($1) snapshot',[invoiceId])).rows[0].snapshot;
}
async function validate(ctx:ApiContext,id:string,raw:unknown){const input=payload(raw);if(input.receiptId!==id)throw new ApiError(400,'INVALID_ALLOCATION_TARGET');return(await basis(ctx,id,input,true,false)).auth;}
function sourceState(b:Awaited<ReturnType<typeof basis>>){const {auth,...source}=b;return source;}
async function dependencies(ctx:ApiContext,id:string,raw:unknown,purpose:'request'|'review'){try{return sourceState(await basis(ctx,id,payload(raw)));}catch(error){if(purpose==='review'&&error instanceof ApiError&&[400,403,404,409].includes(error.status))return {unavailable:error.code};throw error;}}
async function apply(ctx:ApiContext,p:Proposal){
 if(ctx.credential.kind!=='human')throw new ApiError(403,'HUMAN_REVIEW_REQUIRED');const input=payload(p.payload),b=await basis(ctx,p.target_id,input,true);
 if(b.currentVersion!==p.target_version)throw new ApiError(409,'ALLOCATION_VERSION_CHANGED');
 if(!isDeepStrictEqual(sourceState(b),p.review_context))throw new ApiError(409,'ALLOCATION_SOURCE_CHANGED');
 return write(ctx,p,b.parent,b.lines,b.currentVersion,input.mode,input.reason);
}
async function write(ctx:ApiContext,p:Proposal,i:Parent,lines:{installment:number;amountMinor:string}[],before:number,mode:'manual'|'oldest_due',why:string){
 const v=before+1,total=lines.reduce((s,l)=>s+readMinorUnits(l.amountMinor),0n).toString();
 if(before)await ctx.db.query('UPDATE public.receipt_allocation_plans SET version=$2 WHERE receipt_id=$1',[p.target_id,v]);else await ctx.db.query('INSERT INTO public.receipt_allocation_plans(academy_id,receipt_id) VALUES($1,$2)',[ctx.credential.academy_id,p.target_id]);
 await ctx.db.query('INSERT INTO public.receipt_allocation_revisions(academy_id,receipt_id,version,plan_id,plan_version,mode,total_minor,line_count,changed_by,approval_id,reason) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',[ctx.credential.academy_id,p.target_id,v,i.plan_id,i.plan_version,mode,total,lines.length,ctx.credential.person_id,p.id,why]);
 if(lines.length)await ctx.db.query(`INSERT INTO public.receipt_allocation_lines(academy_id,receipt_id,version,plan_id,plan_version,installment,amount_minor) SELECT $1,$2,$3,$4,$5,(l->>'installment')::integer,(l->>'amountMinor')::numeric FROM jsonb_array_elements($6::jsonb) l`,[ctx.credential.academy_id,p.target_id,v,i.plan_id,i.plan_version,JSON.stringify(lines)]);
 const r=await receiptRow(ctx,p.target_id);await record(ctx.db,ctx.credential,ctx.requestId,'finance.receipt.allocated',p.target_id,r.hub_id,{beforeVersion:before,afterVersion:v,mode,lineCount:lines.length,approvalId:p.id,severity:'critical',hasReason:true});
 // Receipt approval includes the deterministic initial allocation. It does not
 // grant discretionary allocation editing or access to private revision notes.
 return p.action==='finance.receipt.record'?{version:v,allocated:formatMoney(readMinorUnits(total),i.unit_scale),additionalLedgerPosting:false}:detail(ctx,p.target_id);
}
export async function automaticAllocationBasis(ctx:ApiContext,invoiceId:string,amountMinor:string){
 const i=await invoiceRow(ctx,invoiceId);financialRecordAuthority(ctx,i,'receipts.edit');const p=await parent(ctx,i.id),installments=await schedule(ctx,p),other=await applied(ctx,i.id),used=new Map(other.map(l=>[l.installment,readMinorUnits(l.amount)])),lines=oldestDue(installments,used,readMinorUnits(amountMinor));
 lines.sort((a,b)=>a.installment-b.installment);return {parent:p,installments,other,lines};
}
export async function allocateApprovedReceipt(ctx:ApiContext,p:Proposal){
 if(ctx.credential.kind!=='human'||p.action!=='finance.receipt.record')throw new ApiError(403,'HUMAN_RECEIPT_APPROVAL_REQUIRED');
 const r=await receiptRow(ctx,p.target_id);financialRecordAuthority(ctx,r,'receipts.edit');if(await currentVersion(ctx,r.id))throw new ApiError(409,'ALLOCATION_ALREADY_EXISTS');const b=await automaticAllocationBasis(ctx,r.invoice_id,r.amount_minor);
 return write(ctx,p,b.parent,b.lines,0,'oldest_due','Allocated oldest-due-first as part of the approved receipt');
}
export const allocationActions:ApprovalRegistry={'finance.receipt.allocate':{requestCapability:'allocations.edit',privacyCapability:'allocations.edit',validate,dependencies,authorizeReviewer:authorizeReceiptReviewer,apply}};
// Data-only canonical projection. Each caller must authorize its own exact
// invoice first;the formatter does not grant finance or family permissions.
export async function invoiceInstallmentStatus(ctx:ApiContext,invoiceId:string,comparisonDate?:string){
 const s=await installmentSnapshot(ctx,invoiceId);if(!s)throw new ApiError(404,'NOT_FOUND');
 const overdueOn=comparisonDate??s.today,paid=readMinorUnits(s.received),allocated=s.credit_id?0n:s.installments.reduce((total,t)=>total+readMinorUnits(t.allocated),0n),unallocated=paid-allocated;
 return {invoiceId,overdueOn,currencyCode:s.currencyCode,credited:s.credit_id!==null,received:formatMoney(paid,s.scale),activeAllocated:formatMoney(allocated,s.scale),unallocatedReceived:formatMoney(unallocated,s.scale),allocationReviewRequired:!s.credit_id&&unallocated>0n,installments:s.installments.map(t=>{const planned=readMinorUnits(t.planned),paid=readMinorUnits(t.allocated),outstanding=s.credit_id?0n:planned-paid;return {installment:t.installment,dueOn:t.dueOn,planned:formatMoney(planned,s.scale),allocated:formatMoney(paid,s.scale),outstanding:formatMoney(outstanding,s.scale),status:s.credit_id?'credited':outstanding===0n?'paid':unallocated>0n?'needs_allocation':t.dueOn<overdueOn?'overdue':paid>0n?'partially_paid':'scheduled'};})};
}
export { statusQuery as tuitionInstallmentQuery };
export async function allocations(ctx:ApiContext,registry:ApprovalRegistry=allocationActions):Promise<Reply|null>{
 const status=/^finance\/invoices\/([^/]+)\/installment-status$/.exec(ctx.path),match=/^finance\/receipts\/([^/]+)\/allocations(?:\/(preview|history))?$/.exec(ctx.path);if(!status&&!match)return null;
 if(status){if(ctx.request.method!=='GET')throw new ApiError(405,'METHOD_NOT_ALLOWED');const i=await invoiceRow(ctx,uuid.parse(status[1]));financialRecordAuthority(ctx,i,'allocations.view');const q=statusQuery.parse(Object.fromEntries(new URL(ctx.request.url).searchParams));
  return {status:200,body:{data:await invoiceInstallmentStatus(ctx,i.id,q.overdueOn)}};
 }
 const id=uuid.parse(match![1]),section=match![2];if(ctx.request.method==='POST'){
  z.object({}).strict().parse(Object.fromEntries(new URL(ctx.request.url).searchParams));if(section==='preview'){const input=selection.parse(await jsonBody(ctx.request,262144)),b=await basis(ctx,id,input);return {status:200,body:{data:{receiptId:id,currentVersion:b.currentVersion,currencyCode:b.parent.currencyCode,allocated:formatMoney(readMinorUnits(b.total),b.parent.unit_scale),unallocated:formatMoney(readMinorUnits(b.unallocated),b.parent.unit_scale),lines:b.lines.map(l=>({installment:l.installment,amount:formatMoney(readMinorUnits(l.amountMinor),b.parent.unit_scale)})),additionalLedgerPosting:false,previewOnly:true}}};}
  if(section)throw new ApiError(405,'METHOD_NOT_ALLOWED');const input={...change.parse(await jsonBody(ctx.request,262144)),receiptId:id};await receiptRow(ctx,id);return propose(ctx,registry,'finance.receipt.allocate',id,input.expectedVersion,input);
 }
 if(ctx.request.method!=='GET'||section==='preview')throw new ApiError(405,'METHOD_NOT_ALLOWED');if(section==='history'){const r=await receiptRow(ctx,id);financialRecordAuthority(ctx,r,'allocations.view');financialRecordAuthority(ctx,r,'allocations.edit');const q=historyQuery.parse(Object.fromEntries(new URL(ctx.request.url).searchParams)),rows=(await ctx.db.query<{version:number}>('SELECT version,mode,line_count AS "lineCount",reason,changed_by AS "changedBy",approval_id AS "approvalId",created_at AS "createdAt" FROM public.receipt_allocation_revisions WHERE receipt_id=$1 AND version>$2 ORDER BY version LIMIT $3',[id,q.afterVersion,q.limit+1])).rows;return {status:200,body:{data:rows.slice(0,q.limit),nextVersion:rows.length>q.limit?rows[q.limit-1].version:null}};}
 const q=readQuery.parse(Object.fromEntries(new URL(ctx.request.url).searchParams));return {status:200,body:{data:await detail(ctx,id,q.version)}};
}
export const allocationsContract=[
 {path:'/api/v1/finance/receipts/{id}/allocations',method:'get',summary:'Read current or pinned historical installment allocation without private review reasons; inactive history never becomes newly paid',querySchema:readQuery},
 {path:'/api/v1/finance/receipts/{id}/allocations',method:'post',summary:'Request a complete reviewed manual or oldest-due-first allocation replacement. Empty manual lines clear allocation, never delete payment or post money again.',schema:change},
 {path:'/api/v1/finance/receipts/{id}/allocations/preview',method:'post',summary:'Preview exact oldest-due/manual distribution with no financial mutation; current allocation-edit rights still required',schema:selection},
 {path:'/api/v1/finance/receipts/{id}/allocations/history',method:'get',summary:'Editor-only bounded immutable allocation revision metadata and private review reasons',querySchema:historyQuery},
 {path:'/api/v1/finance/invoices/{id}/installment-status',method:'get',summary:'Permission-protected current installment balances with optional overdue comparison date, not an historical as-of accounting ledger',querySchema:statusQuery}
] as const;
