import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { jsonBody,record,type ApiContext,type Reply } from '../core/api.ts';
import { permissionScope,propose,type ApprovalRegistry,type Proposal } from '../core/approvals.ts';
import { ApiError,requireScope,scopeNonempty } from '../core/policy.ts';
import { lockClosingBook } from '../core/finance-lock.ts';
import { readMinorUnits } from '../core/money.ts';
import { accountRow } from './finance.ts';
import { accountingDate } from './finance-periods.ts';
import { lockAcademyTopology } from './academy.ts';
import { reconciliationReportData,reconciliationExportRowLimit } from './bank-reconciliation-report.ts';

const uuid=z.string().uuid().transform(v=>v.toLowerCase()),text=z.string().refine(v=>v.isWellFormed()&&!v.includes('\0')),version=z.number().int().positive().max(2147483647);
const item=z.object({journalId:uuid,lineNumber:z.number().int().min(1).max(200),kind:z.enum(['deposit_in_transit','outstanding_payment','card_payment_in_transit','card_charge_pending']),reason:text.trim().min(1).max(1000)}).strict();
const base={accountId:uuid,accountVersion:version,from:accountingDate,through:accountingDate,supersedesId:uuid.nullable().default(null),reference:text.trim().max(200).default(''),reason:text.trim().min(1).max(2000)};
const input=z.discriminatedUnion('state',[
 z.object({...base,state:z.literal('finalized'),snapshot:z.string().regex(/^[a-f0-9]{64}$/),openingObservationId:uuid,closingObservationId:uuid,coverageAttestation:text.trim().min(1).max(2000),outstanding:z.array(item).max(1000).default([]).refine(v=>new Set(v.map(r=>r.journalId+':'+r.lineNumber)).size===v.length).transform(v=>v.sort((a,b)=>(a.journalId+':'+a.lineNumber)<(b.journalId+':'+b.lineNumber)?-1:(a.journalId+':'+a.lineNumber)>(b.journalId+':'+b.lineNumber)?1:0))}).strict(),
 z.object({...base,state:z.literal('void'),supersedesId:uuid}).strict()
]).refine(v=>v.from<=v.through);
const query=z.object({limit:z.coerce.number().int().min(1).max(100).default(50),after:uuid.optional(),from:accountingDate.optional(),through:accountingDate.optional(),includeHistory:z.enum(['true','false']).transform(v=>v==='true').default(false)}).strict().refine(v=>!v.from||!v.through||v.from<=v.through);
const readCaps=['bank-reconciliations.view','financial-reports.view','ledger.view','bank-statements.view','bank-matches.view','bank-balances.view'] as const;
type Entry={id:string;account_id:string;account_version:number;currency_id:string;unit_scale:number;starts_on:string;through:string;state:'finalized'|'void';supersedes_id:string|null;source_snapshot:string|null;reference:string;approval_id:string;created_at:string|Date;superseded_by:string|null};
const columns='r.id,r.account_id,r.account_version,r.currency_id,r.unit_scale,r.starts_on::text,r.through::text,r.state,r.supersedes_id,r.source_snapshot,r.reference,r.approval_id,r.created_at,(SELECT c.id FROM public.finance_reconciliations c WHERE c.supersedes_id=r.id) AS superseded_by';
async function account(ctx:ApiContext,id:string,edit=false){const a=await accountRow(ctx,id);for(const cap of [...readCaps,...edit?['bank-reconciliations.edit' as const]:[]])requireScope(permissionScope(ctx,cap),a.hubId??undefined);return a;}
async function row(ctx:ApiContext,id:string){if(!scopeNonempty(permissionScope(ctx,'bank-reconciliations.view')))throw new ApiError(403,'FORBIDDEN');const r=(await ctx.db.query<Entry>('SELECT '+columns+' FROM public.finance_reconciliations r WHERE r.id=$1',[id])).rows[0];if(!r)throw new ApiError(404,'NOT_FOUND');try{return {r,a:await account(ctx,r.account_id)};}catch(error){if(error instanceof ApiError&&[403,404].includes(error.status))throw new ApiError(404,'NOT_FOUND');throw error;}}
function view(r:Entry){return {id:r.id,accountId:r.account_id,accountVersion:r.account_version,currencyId:r.currency_id,unitScale:r.unit_scale,from:r.starts_on,through:r.through,state:r.state,supersedesId:r.supersedes_id,supersededBy:r.superseded_by,active:r.state==='finalized'&&r.superseded_by===null,sourceSnapshot:r.source_snapshot,reference:r.reference,approvalId:r.approval_id,capturedAt:r.created_at,hasReason:true,sourceBasis:'reviewed_recorded_sources_and_operator_coverage_attestation',externallyVerified:false,currentSourceValidated:false,ledgerAdjusted:false,moneyMovementPerformed:false};}
async function basis(ctx:ApiContext,raw:unknown){
 const v=input.parse(raw);await account(ctx,v.accountId,true);
 // Existing exclusive policy/book gates freeze every finance source writer,
 // including direct DML, before a source read or account row lock. Never
 // upgrade a shared finance gate after locking a source row.
 await lockClosingBook(ctx);await lockAcademyTopology(ctx);const a=await account(ctx,v.accountId,true);
 if(a.version!==v.accountVersion)throw new ApiError(409,'ACCOUNT_CHANGED');
 const prior=v.supersedesId?(await ctx.db.query<Entry>('SELECT '+columns+' FROM public.finance_reconciliations r WHERE r.id=$1',[v.supersedesId])).rows[0]??null:null;
 if(v.supersedesId&&(!prior||prior.account_id!==a.id||prior.through!==v.through||prior.superseded_by))throw new ApiError(409,'RECONCILIATION_PRIOR_CHANGED');
 if(!v.supersedesId&&(await ctx.db.query('SELECT id FROM public.finance_reconciliations WHERE account_id=$1 AND through=$2::date AND supersedes_id IS NULL',[a.id,v.through])).rows.length)throw new ApiError(409,'RECONCILIATION_PRIOR_REQUIRED');
 const accounts=[{id:a.id,version:a.version,hubId:a.hubId,currencyId:a.currencyId,unitScale:a.unitScale,active:a.active,operationalRole:a.operationalRole}];
 if(v.state==='void'){if(prior?.state!=='finalized'||prior.starts_on!==v.from)throw new ApiError(409,'RECONCILIATION_VOID_PRIOR_INVALID');return {a,accounts,prior,report:null};}
 if(!a.active||!['cash','bank','credit_card'].includes(a.operationalRole))throw new ApiError(409,'ACTIVE_TREASURY_ACCOUNT_REQUIRED');
 if(!(await ctx.db.query<{valid:boolean}>("SELECT $1::date<=(clock_timestamp() AT TIME ZONE 'UTC'+interval '14 hours')::date AS valid",[v.through])).rows[0].valid)throw new ApiError(400,'FUTURE_RECONCILIATION_FORBIDDEN');
 const d=await reconciliationReportData(ctx,{accountId:a.id,from:v.from,through:v.through,snapshot:v.snapshot,openingObservationId:v.openingObservationId,closingObservationId:v.closingObservationId,status:'all',periodOnly:false,limit:reconciliationExportRowLimit});
 if(d.nextStatementCursor||d.nextLedgerCursor)throw new ApiError(409,'RECONCILIATION_REQUIRES_BACKGROUND_JOB');
 if(!d.openingObservation?.usable||!d.closingObservation?.usable)throw new ApiError(409,'RECONCILIATION_OBSERVATIONS_INVALID');
 if(d.statement.unmatchedCount||d.statement.cutoffPendingCount||d.review.nonActivityMatchedLines||d.review.legacyPurposeReviewRequired)throw new ApiError(409,'RECONCILIATION_SOURCE_BLOCKED');
 if(d.comparison.provisionalResidual?.minor!=='0'||d.comparison.statementPeriodMovementDifference?.minor!=='0')throw new ApiError(409,'RECONCILIATION_DIFFERENCE_REMAINS');
 const unresolved=d.ledgerItems.filter(r=>r.status==='unmatched'||r.status==='cutoff_pending'),notes=new Map(v.outstanding.map(r=>[r.journalId+':'+r.lineNumber,r]));
 if(unresolved.length!==notes.size||unresolved.some(r=>notes.get(r.journalId+':'+r.lineNumber)?.kind!==(a.operationalRole==='credit_card'?(readMinorUnits(r.debitNet.minor)>0n?'card_payment_in_transit':'card_charge_pending'):(readMinorUnits(r.debitNet.minor)>0n?'deposit_in_transit':'outstanding_payment'))))throw new ApiError(409,'RECONCILIATION_OUTSTANDING_REVIEW_REQUIRED');
 // Exclude the changing read-clock from dependency hashing. The immutable
 // record has its actual capture timestamp, not a fabricated historical clock.
 const {snapshotAt,...snapshot}=d,report={...snapshot,report:'reviewed_recorded_bank_reconciliation',review:{...d.review,finalized:true,reconciled:true,statementCoverageAttested:true,coverageBasis:'reviewed_operator_attestation'}};
 // ponytail: bounded synchronous snapshot, same complete 1,000-row side limit
 // as CSV plus 4 MiB report JSON; larger archival jobs remain queued work.
 if(Buffer.byteLength(JSON.stringify(report),'utf8')>4_194_304)throw new ApiError(409,'RECONCILIATION_REQUIRES_BACKGROUND_JOB');
 return {a,accounts,prior,report};
}
function dependenciesOf(b:Awaited<ReturnType<typeof basis>>){return JSON.parse(JSON.stringify({accounts:b.accounts,prior:b.prior,report:b.report}));}
export const reconciliationActions:ApprovalRegistry={'finance.reconciliation.record':{
 requestCapability:'bank-reconciliations.edit',privacyCapability:'bank-reconciliations.edit',policyChange:true,createdStatus:201,
 async validate(ctx,_id,raw){const b=await basis(ctx,raw);return b.a.hubId?{all:false,hubs:[b.a.hubId]}:{all:true,hubs:[]};},
 async dependencies(ctx,_id,raw,purpose){try{return dependenciesOf(await basis(ctx,raw));}catch(error){if(purpose==='review'&&error instanceof ApiError&&[400,403,404,409].includes(error.status))return {unavailable:error.code};throw error;}},
 async apply(ctx,p:Proposal){
  if(ctx.credential.kind!=='human')throw new ApiError(403,'HUMAN_REVIEW_REQUIRED');const v=input.parse(p.payload),b=await basis(ctx,v);if(!isDeepStrictEqual(dependenciesOf(b),p.review_context))throw new ApiError(409,'RECONCILIATION_SOURCE_CHANGED');
  await ctx.db.query(`INSERT INTO public.finance_reconciliations(academy_id,id,account_id,account_version,currency_id,unit_scale,starts_on,through,state,supersedes_id,source_snapshot,report,coverage_attestation,outstanding,reference,approval_id,created_by)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,$14::jsonb,$15,$16,$17)`,[ctx.credential.academy_id,p.target_id,b.a.id,b.a.version,b.a.currencyId,b.a.unitScale,v.from,v.through,v.state,v.supersedesId,v.state==='finalized'?v.snapshot:null,b.report?JSON.stringify(b.report):null,v.state==='finalized'?v.coverageAttestation:null,JSON.stringify(v.state==='finalized'?v.outstanding:[]),v.reference,p.id,ctx.credential.person_id]);
  await record(ctx.db,ctx.credential,ctx.requestId,'finance.reconciliation.recorded',p.target_id,b.a.hubId,{approvalId:p.id,state:v.state,hasReason:true,severity:'critical',ledgerAdjusted:false});return view((await row(ctx,p.target_id)).r);
 }
}};
export async function reconciliations(ctx:ApiContext,registry:ApprovalRegistry=reconciliationActions):Promise<Reply|null>{
 const list=/^finance\/accounts\/([^/]+)\/reconciliations$/.exec(ctx.path),entry=/^finance\/reconciliations\/([^/]+)(?:\/(current-state))?$/.exec(ctx.path),create=ctx.path==='finance/reconciliations';if(!list&&!entry&&!create)return null;
 if(create){if(ctx.request.method!=='POST')throw new ApiError(405,'METHOD_NOT_ALLOWED');z.object({}).strict().parse(Object.fromEntries(new URL(ctx.request.url).searchParams));const v=input.parse(await jsonBody(ctx.request,2_097_152));await account(ctx,v.accountId,true);return propose(ctx,registry,'finance.reconciliation.record',null,0,v);}
 if(ctx.request.method!=='GET')throw new ApiError(405,'METHOD_NOT_ALLOWED');
 if(list){const id=uuid.parse(list[1]);await account(ctx,id);const q=query.parse(Object.fromEntries(new URL(ctx.request.url).searchParams)),rows=(await ctx.db.query<Entry>(`SELECT ${columns} FROM public.finance_reconciliations r WHERE r.account_id=$1 AND($2::uuid IS NULL OR r.id>$2) AND($3::date IS NULL OR r.through>=$3) AND($4::date IS NULL OR r.through<=$4) AND($5::boolean OR NOT EXISTS(SELECT 1 FROM public.finance_reconciliations c WHERE c.supersedes_id=r.id)) ORDER BY r.id LIMIT $6`,[id,q.after??null,q.from??null,q.through??null,q.includeHistory,q.limit+1])).rows;return {status:200,body:{accountId:id,data:rows.slice(0,q.limit).map(view),nextCursor:rows.length>q.limit?rows[q.limit-1].id:null}};}
 z.object({}).strict().parse(Object.fromEntries(new URL(ctx.request.url).searchParams));const {r}=await row(ctx,uuid.parse(entry![1]));
 if(entry![2]){const current=(await ctx.db.query<Entry&{matches:boolean|null}>(`SELECT ${columns},CASE WHEN r.state='finalized' THEN(r.report->'sourceStamp'=public.reconciliation_source_stamp(r.account_id) AND r.report->'observationSourceStamp'=public.reconciliation_observation_stamp(r.account_id,(r.report->'openingObservation'->>'id')::uuid,(r.report->'closingObservation'->>'id')::uuid)) ELSE NULL END AS matches FROM public.finance_reconciliations r WHERE r.id=$1`,[r.id])).rows[0];return {status:200,body:{data:{...view(current),currentSourceValidated:true,currentSourceMatches:current.matches,requiresReview:current.state==='finalized'&&current.superseded_by===null&&current.matches!==true}}};}
 const content=(await ctx.db.query('SELECT report,coverage_attestation AS "coverageAttestation",outstanding FROM public.finance_reconciliations WHERE id=$1',[r.id])).rows[0];return {status:200,body:{data:{...view(r),...content}}};
}
export const reconciliationsContract=[
 {path:'/api/v1/finance/reconciliations',method:'post',summary:'Request a retained reviewed recorded-data reconciliation, immutable replacement or void; exact zero residual, current explicit observations, bank items resolved and every outstanding book item reviewed; not external bank verification or an automatic adjustment',schema:input},
 {path:'/api/v1/finance/accounts/{id}/reconciliations',method:'get',summary:'Current reconciliation heads or retained replacement/void history, separate report/source/balance rights intersected',querySchema:query},
 {path:'/api/v1/finance/reconciliations/{id}',method:'get',summary:'Read the immutable captured report and reviewed outstanding items with current source rights; never silently refresh the historical snapshot'},
 {path:'/api/v1/finance/reconciliations/{id}/current-state',method:'get',summary:'Compare archived monotonic source/observation stamps with current same-snapshot data; no freeze, rewrite or external verification'}
] as const;
