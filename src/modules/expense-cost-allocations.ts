import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { jsonBody,record,type ApiContext,type Reply } from '../core/api.ts';
import { propose,master,lockApprovalWrites,type ApprovalRegistry,type Proposal } from '../core/approvals.ts';
import { ApiError } from '../core/policy.ts';
import { formatMoneyTotal,readMinorUnits } from '../core/money.ts';
import { lockFinanceBook } from '../core/finance-lock.ts';
import { lockAcademyTopology } from './academy.ts';
import { expenseBillRow } from './expenses.ts';
import { financialAttributionTarget,attributionTargetsAuthority } from './financial-attribution-targets.ts';

const uuid=z.string().uuid().transform(v=>v.toLowerCase()),reason=z.string().trim().min(1).max(2000).refine(v=>v.isWellFormed()&&!v.includes('\0'));
const target=financialAttributionTarget;
const selection=z.object({expectedVersion:z.number().int().min(0).max(2147483646),lines:z.array(z.object({lineNumber:z.number().int().min(1).max(50),targets:z.array(target).min(1).max(200).refine(a=>new Set(a.map(t=>JSON.stringify([t.hubId,t.classId,t.studentId]))).size===a.length)}).strict()).max(50).refine(a=>new Set(a.map(l=>l.lineNumber)).size===a.length&&a.reduce((n,l)=>n+l.targets.length,0)<=200),reason}).strict();
const payload=selection.extend({billId:uuid}),empty=z.object({}).strict(),readQuery=z.object({version:z.coerce.number().int().positive().max(2147483647).optional()}).strict(),historyQuery=z.object({afterVersion:z.coerce.number().int().min(0).max(2147483647).default(0),limit:z.coerce.number().int().min(1).max(100).default(25)}).strict();
type Input=z.infer<typeof payload>;
type Target=z.infer<typeof target>;
type Amounts={netMinor:string;taxMinor:string;recoverableMinor:string;nonrecoverableMinor:string;grossMinor:string;expenseMinor:string};
type Source={unavailable?:string;before:{version:number};billId:string;currencyId:string;unitScale:number;allocationPolicy:string;lines:({lineNumber:number;originalHubId:string|null;originalClassId:string|null;originalStudentId:string|null;expenseAccountId:string;expenseAccountVersion:number;targets:(Target&Amounts)[]}&Omit<Amounts,'nonrecoverableMinor'>)[]};
type Revision={version:number;current_version:number;input:Input;source_snapshot:Source;created_at:string};
async function revisions(ctx:ApiContext,id:string){return(await ctx.db.query<Revision>('SELECT r.version,a.version AS current_version,r.input,r.source_snapshot,r.created_at::text FROM public.expense_cost_allocations a JOIN public.expense_cost_allocation_revisions r ON r.academy_id=a.academy_id AND r.bill_id=a.bill_id AND r.version=a.version WHERE a.bill_id=$1',[id])).rows[0];}
async function authority(ctx:ApiContext,id:string,targets:Target[]=[],edit=false){
 await expenseBillRow(ctx,id,edit);const original=(await ctx.db.query<Target>('SELECT hub_id AS "hubId",class_id AS "classId",student_id AS "studentId",1 AS weight FROM public.expense_bill_lines WHERE bill_id=$1',[id])).rows;
 const hubs=await attributionTargetsAuthority(ctx,[...original,...targets],edit?['expenses.view','expenses.edit']:['expenses.view']);
 return hubs.has(null)?{all:true,hubs:[]}:{all:false,hubs:[...hubs].filter((h):h is string=>h!==null).sort()};
}
async function source(ctx:ApiContext,i:Input){const s=(await ctx.db.query<{source:Source|null}>('SELECT public.expense_cost_allocation_source($1::jsonb) source',[JSON.stringify(i)])).rows[0].source;if(!s)throw new ApiError(404,'NOT_FOUND');if(s.unavailable)throw new ApiError(409,s.unavailable);return s;}
async function basis(ctx:ApiContext,id:string,i:Input){if(i.billId!==id)throw new ApiError(404,'NOT_FOUND');const prior=await revisions(ctx,id);await authority(ctx,id,[...i.lines.flatMap(l=>l.targets),...prior?.source_snapshot.lines.flatMap(l=>l.targets)??[]],true);const s=await source(ctx,i);if(s.before.version!==i.expectedVersion)throw new ApiError(409,'EXPENSE_COST_VERSION_CHANGED');return s;}
async function detail(ctx:ApiContext,r:Revision){await authority(ctx,r.input.billId,r.source_snapshot.lines.flatMap(l=>l.targets));const current=(await ctx.db.query<{source:Source|null}>('SELECT public.expense_cost_allocation_source($1::jsonb) source',[JSON.stringify(r.input)])).rows[0].source;const {before:ignored,...saved}=r.source_snapshot,{before:currentVersion,...fresh}=current??{};
 return {version:r.version,currentVersion:r.current_version,isCurrentVersion:r.version===r.current_version,createdAt:r.created_at,sourcesCurrent:current!==null&&isDeepStrictEqual(saved,fresh),...saved,accountingPosted:false,paymentExecuted:false,reportIntegration:'reviewed_cost_basis_available_original_context_default_preserved',lines:saved.lines.map(l=>({...l,targets:l.targets.map(t=>({...t,expense:formatMoneyTotal(readMinorUnits(t.expenseMinor),saved.unitScale)}))}))};
}
async function apply(ctx:ApiContext,p:Proposal){if(ctx.credential.kind!=='human')throw new ApiError(403,'HUMAN_REVIEW_REQUIRED');const i=payload.parse(p.payload),s=await basis(ctx,p.target_id,i);if(!isDeepStrictEqual(s,p.review_context))throw new ApiError(409,'EXPENSE_COST_SOURCES_CHANGED');const v=i.expectedVersion+1;
 if(v===1)await ctx.db.query('INSERT INTO public.expense_cost_allocations(academy_id,bill_id,version,created_by) VALUES($1,$2,1,$3)',[ctx.credential.academy_id,p.target_id,ctx.credential.person_id]);else await ctx.db.query('UPDATE public.expense_cost_allocations SET version=$2 WHERE bill_id=$1',[p.target_id,v]);
 await ctx.db.query('INSERT INTO public.expense_cost_allocation_revisions(academy_id,bill_id,version,input,source_snapshot,changed_by,approval_id) VALUES($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7)',[ctx.credential.academy_id,p.target_id,v,JSON.stringify(i),JSON.stringify(s),ctx.credential.person_id,p.id]);await record(ctx.db,ctx.credential,ctx.requestId,'finance.expense-costs.replaced',p.target_id,null,{severity:'critical',approvalId:p.id,afterVersion:v,accountingPosted:false});
 return detail(ctx,(await revisions(ctx,p.target_id))!);
}
export const expenseCostAllocationActions:ApprovalRegistry={'finance.expense-costs.replace':{requestCapability:'expenses.edit',privacyCapability:'expenses.view',createdStatus:200,
 async validate(ctx,id,raw){const i=payload.parse(raw);await expenseBillRow(ctx,id,true);await lockFinanceBook(ctx);await lockAcademyTopology(ctx);const prior=await revisions(ctx,id);const scope=await authority(ctx,id,[...i.lines.flatMap(l=>l.targets),...prior?.source_snapshot.lines.flatMap(l=>l.targets)??[]],true);await source(ctx,i);return scope;},
 async dependencies(ctx,id,raw,purpose){try{return await basis(ctx,id,payload.parse(raw));}catch(e){if(purpose==='review'&&e instanceof ApiError&&[400,403,404,409].includes(e.status))return {unavailable:e.code};throw e;}},
 async authorizeReviewer(ctx,p){const i=payload.parse(p.payload),prior=await revisions(ctx,p.target_id);await authority(ctx,p.target_id,[...i.lines.flatMap(l=>l.targets),...prior?.source_snapshot.lines.flatMap(l=>l.targets)??[]],true);if(!await master(ctx)&&(await ctx.db.query('SELECT 1 FROM public.expense_bills b JOIN public.financial_payees payee ON payee.academy_id=b.academy_id AND payee.id=b.payee_id WHERE b.id=$1 AND payee.person_id=$2',[p.target_id,ctx.credential.person_id])).rows.length)throw new ApiError(403,'BENEFICIARY_REVIEW_FORBIDDEN');},apply}};
export async function expenseCostAllocations(ctx:ApiContext,registry:ApprovalRegistry=expenseCostAllocationActions):Promise<Reply|null>{
 const path=/^finance\/expense-bills\/([^/]+)\/cost-allocation(?:\/(history))?$/.exec(ctx.path);if(!path)return null;const id=uuid.parse(path[1]),params=new URL(ctx.request.url).searchParams;if([...params].length!==new Set(params.keys()).size)throw new ApiError(400,'DUPLICATE_QUERY');const q=Object.fromEntries(params);
 if(ctx.request.method==='POST'&&!path[2]){empty.parse(q);const i={...selection.parse(await jsonBody(ctx.request,64*1024)),billId:id};return propose(ctx,registry,'finance.expense-costs.replace',id,i.expectedVersion,i);}
 if(ctx.request.method!=='GET')throw new ApiError(405,'METHOD_NOT_ALLOWED');await lockApprovalWrites(ctx);await lockAcademyTopology(ctx);await expenseBillRow(ctx,id);
 if(path[2]){const p=historyQuery.parse(q),rows=(await ctx.db.query<Revision>('SELECT r.version,a.version AS current_version,r.input,r.source_snapshot,r.created_at::text FROM public.expense_cost_allocation_revisions r JOIN public.expense_cost_allocations a ON a.academy_id=r.academy_id AND a.bill_id=r.bill_id WHERE r.bill_id=$1 AND r.version>$2 ORDER BY r.version LIMIT $3',[id,p.afterVersion,p.limit+1])).rows;for(const r of rows)await authority(ctx,id,r.source_snapshot.lines.flatMap(l=>l.targets));return {status:200,body:{data:rows.slice(0,p.limit).map(r=>({version:r.version,createdAt:r.created_at})),nextCursor:rows.length>p.limit?rows[p.limit-1].version:null}};}
 const p=readQuery.parse(q),r=p.version?(await ctx.db.query<Revision>('SELECT r.version,a.version AS current_version,r.input,r.source_snapshot,r.created_at::text FROM public.expense_cost_allocation_revisions r JOIN public.expense_cost_allocations a ON a.academy_id=r.academy_id AND a.bill_id=r.bill_id WHERE r.bill_id=$1 AND r.version=$2',[id,p.version])).rows[0]:await revisions(ctx,id);if(!r)throw new ApiError(404,'NOT_FOUND');return {status:200,body:{data:await detail(ctx,r)}};
}
export const expenseCostAllocationsContract=[
 {path:'/api/v1/finance/expense-bills/{id}/cost-allocation',method:'post',summary:'Request upper-reviewed replacement of analytical cost splits for immutable bill lines. Integer weights conserve original net, recoverable and nonrecoverable tax separately using stable largest remainders. Omitted lines use original contexts;empty lines restores them all. Up to200targets. No new posting/payment;Report costBasis=reviewed consumes retained splits;default original-context meaning preserved.',schema:selection},
 {path:'/api/v1/finance/expense-bills/{id}/cost-allocation',method:'get',summary:'Read retained exact cost allocations with original-bill and every target permission,source freshness and pinned revision. Does not rebook expenses or claim whole-academy profit.',querySchema:readQuery},
 {path:'/api/v1/finance/expense-bills/{id}/cost-allocation/history',method:'get',summary:'Bounded retained cost-allocation version history,authorized against every selected revision target.',querySchema:historyQuery}
] as const;
