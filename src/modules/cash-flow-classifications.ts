import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { jsonBody,record,type ApiContext,type Reply } from '../core/api.ts';
import { propose,permissionScope,lockApprovalWrites,type ApprovalRegistry,type Proposal } from '../core/approvals.ts';
import { ApiError,requireScope } from '../core/policy.ts';
import { lockFinanceBook } from '../core/finance-lock.ts';
import { lockAcademyTopology } from './academy.ts';
import { financeJournalRow } from './finance-journals.ts';
import { formatMoneyTotal,readMinorUnits } from '../core/money.ts';

const uuid=z.string().uuid().transform(v=>v.toLowerCase());
const part=z.object({category:z.enum(['operating','investing','financing']),amountMinor:z.string().regex(/^[1-9][0-9]{0,77}$/)}).strict();
const selection=z.object({expectedVersion:z.number().int().min(0).max(2147483646),lines:z.array(z.object({lineNumber:z.number().int().min(1).max(200),parts:z.array(part).min(1).max(3).refine(a=>new Set(a.map(p=>p.category)).size===a.length)}).strict()).max(200).refine(a=>new Set(a.map(l=>l.lineNumber)).size===a.length),reason:z.string().trim().min(1).max(2000).refine(v=>v.isWellFormed()&&!v.includes('\0'))}).strict();
const payload=selection.extend({journalId:uuid}),empty=z.object({}).strict(),readQuery=z.object({version:z.coerce.number().int().positive().max(2147483647).optional()}).strict(),historyQuery=z.object({afterVersion:z.coerce.number().int().min(0).max(2147483647).default(0),limit:z.coerce.number().int().min(1).max(100).default(25)}).strict();
type Input=z.infer<typeof payload>;
type Source={unavailable?:string;before:{version:number};journalId:string;postedOn:string;classificationBasis:string;reversalPolicy:string;lines:{lineNumber:number;accountId:string;accountVersion:number;hubId:string|null;currencyId:string;unitScale:number;side:string;amountMinor:string;parts:{category:string;amountMinor:string}[]}[]};
type Revision={version:number;current_version:number;source_snapshot:Source;created_at:string;changedById:string;requestedById:string;requesterKind:string;approvalId:string};
async function authority(ctx:ApiContext,id:string,edit=false){
 const j=await financeJournalRow(ctx,id),accounts=(await ctx.db.query<{hubId:string|null}>('SELECT DISTINCT hub_id AS "hubId" FROM public.finance_accounts WHERE id=ANY($1::uuid[])',[j.lines.map(l=>l.accountId)])).rows;
 for(const a of accounts)for(const cap of ['cash-flow.view','accounts.view','journals.view','ledger.view',...edit?['cash-flow.edit'] as const:[]] as const)requireScope(permissionScope(ctx,cap),a.hubId??undefined);
 const hubs=[...new Set(accounts.map(a=>a.hubId))].sort();return hubs.includes(null)?{all:true,hubs:[]}:{all:false,hubs:hubs as string[]};
}
async function source(ctx:ApiContext,i:Input){const s=(await ctx.db.query<{source:Source|null}>('SELECT public.cash_flow_classification_source($1::jsonb) source',[JSON.stringify(i)])).rows[0].source;if(!s)throw new ApiError(404,'NOT_FOUND');if(s.unavailable)throw new ApiError(409,s.unavailable);return s;}
async function basis(ctx:ApiContext,id:string,i:Input){if(i.journalId!==id)throw new ApiError(404,'NOT_FOUND');await authority(ctx,id,true);const s=await source(ctx,i);if(s.before.version!==i.expectedVersion)throw new ApiError(409,'CASH_FLOW_VERSION_CHANGED');return s;}
async function revision(ctx:ApiContext,id:string,version?:number){return(await ctx.db.query<Revision>('SELECT r.version,h.version current_version,r.source_snapshot,r.created_at::text,r.changed_by AS "changedById",r.approval_id AS "approvalId",p.requester_id AS "requestedById",p.requester_kind AS "requesterKind" FROM public.cash_flow_classifications h JOIN public.cash_flow_classification_revisions r ON r.academy_id=h.academy_id AND r.journal_id=h.journal_id AND r.version=coalesce($2::integer,h.version) JOIN public.approval_requests p ON p.academy_id=r.academy_id AND p.id=r.approval_id WHERE h.journal_id=$1',[id,version??null])).rows[0];}
function detail(r:Revision){const {before:ignored,...saved}=r.source_snapshot;return {version:r.version,currentVersion:r.current_version,isCurrentVersion:r.version===r.current_version,createdAt:r.created_at,changedById:r.changedById,requestedById:r.requestedById,requesterKind:r.requesterKind,approvalId:r.approvalId,...saved,accountingPosted:false,paymentExecuted:false,accountingStandardComplianceDetermined:false,reportIntegration:'reviewed_classification_basis_available_not_yet_a_formal_cash_flow_statement',lines:saved.lines.map(l=>({...l,amount:formatMoneyTotal(readMinorUnits(l.amountMinor),l.unitScale),parts:l.parts.map(p=>({...p,amount:formatMoneyTotal(readMinorUnits(p.amountMinor),l.unitScale)}))}))};}
async function apply(ctx:ApiContext,p:Proposal){
 if(ctx.credential.kind!=='human')throw new ApiError(403,'HUMAN_REVIEW_REQUIRED');const i=payload.parse(p.payload),s=await basis(ctx,p.target_id,i);if(!isDeepStrictEqual(s,p.review_context))throw new ApiError(409,'CASH_FLOW_SOURCES_CHANGED');const v=i.expectedVersion+1;
 if(v===1)await ctx.db.query('INSERT INTO public.cash_flow_classifications(academy_id,journal_id,version,created_by) VALUES($1,$2,1,$3)',[ctx.credential.academy_id,p.target_id,ctx.credential.person_id]);else await ctx.db.query('UPDATE public.cash_flow_classifications SET version=$2 WHERE journal_id=$1',[p.target_id,v]);
 await ctx.db.query('INSERT INTO public.cash_flow_classification_revisions(academy_id,journal_id,version,input,source_snapshot,changed_by,approval_id) VALUES($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7)',[ctx.credential.academy_id,p.target_id,v,JSON.stringify(i),JSON.stringify(s),ctx.credential.person_id,p.id]);await record(ctx.db,ctx.credential,ctx.requestId,'finance.cash-flow.replaced',p.target_id,null,{severity:'critical',approvalId:p.id,afterVersion:v,accountingPosted:false});return detail((await revision(ctx,p.target_id))!);
}
export const cashFlowClassificationActions:ApprovalRegistry={'finance.cash-flow.replace':{requestCapability:'cash-flow.edit',privacyCapability:'cash-flow.view',createdStatus:200,
 async validate(ctx,id,raw){const i=payload.parse(raw);await authority(ctx,id,true);await lockFinanceBook(ctx);await lockAcademyTopology(ctx);const scope=await authority(ctx,id,true);await source(ctx,i);return scope;},
 async dependencies(ctx,id,raw,purpose){try{return await basis(ctx,id,payload.parse(raw));}catch(e){if(purpose==='review'&&e instanceof ApiError&&[400,403,404,409].includes(e.status))return {unavailable:e.code};throw e;}},
 async authorizeReviewer(ctx,p){await authority(ctx,p.target_id,true);},apply}};
export async function cashFlowClassifications(ctx:ApiContext,registry:ApprovalRegistry=cashFlowClassificationActions):Promise<Reply|null>{
 const path=/^finance\/journals\/([^/]+)\/cash-flow-classification(?:\/(history))?$/.exec(ctx.path);if(!path)return null;const id=uuid.parse(path[1]),params=new URL(ctx.request.url).searchParams;if([...params].length!==new Set(params.keys()).size)throw new ApiError(400,'DUPLICATE_QUERY');const q=Object.fromEntries(params);
 if(ctx.request.method==='POST'&&!path[2]){empty.parse(q);const i={...selection.parse(await jsonBody(ctx.request,65536)),journalId:id};return propose(ctx,registry,'finance.cash-flow.replace',id,i.expectedVersion,i);}
 if(ctx.request.method!=='GET')throw new ApiError(405,'METHOD_NOT_ALLOWED');await lockApprovalWrites(ctx);await lockAcademyTopology(ctx);await authority(ctx,id);
 if(path[2]){const p=historyQuery.parse(q),rows=(await ctx.db.query<{version:number;createdAt:string;changedById:string;requestedById:string;requesterKind:string;approvalId:string}>('SELECT r.version,r.created_at::text AS "createdAt",r.changed_by AS "changedById",r.approval_id AS "approvalId",p.requester_id AS "requestedById",p.requester_kind AS "requesterKind" FROM public.cash_flow_classification_revisions r JOIN public.approval_requests p ON p.academy_id=r.academy_id AND p.id=r.approval_id WHERE r.journal_id=$1 AND r.version>$2 ORDER BY r.version LIMIT $3',[id,p.afterVersion,p.limit+1])).rows;return {status:200,body:{data:rows.slice(0,p.limit),nextCursor:rows.length>p.limit?rows[p.limit-1].version:null}};}
 const r=await revision(ctx,id,readQuery.parse(q).version);if(!r)throw new ApiError(404,'NOT_FOUND');return {status:200,body:{data:detail(r)}};
}
export const cashFlowClassificationsContract=[
 {path:'/api/v1/finance/journals/{id}/cash-flow-classification',method:'post',summary:'Request upper-human reviewed operating/investing/financing splits of original as-posted cash/bank lines. Exact positive minor-unit strings must fully conserve each supplied line;omitted lines remain explicitly unclassified,empty lines resets classifications with history. No journal rewrite,tax change,payment or claim of accounting-standard compliance. Reversals must use their original journal classification.',schema:selection},
 {path:'/api/v1/finance/journals/{id}/cash-flow-classification',method:'get',summary:'Current or pinned retained cash-flow classification with original whole-journal and account rights. No formal cash-flow statement is claimed.',querySchema:readQuery},
 {path:'/api/v1/finance/journals/{id}/cash-flow-classification/history',method:'get',summary:'Bounded immutable classification revision history under current whole-source permissions.',querySchema:historyQuery}
] as const;
